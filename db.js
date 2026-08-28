/* ==========================================================================
   db.js — LLM Lab v30 · 실제 DB 연동 어댑터 (DB 연결 프로필 · PHP REST 클라이언트)
   ──────────────────────────────────────────────────────────────────────────
   엔진(llmlab.js)·rag-chain.js·app.js가 소비하는 window.LLMLab.db 네임스페이스.
   비 ES모듈(IIFE) — file:// 에서도 로드. 하드코딩 색 없음(순수 로직).

   정본 스키마: _workspace/01_research_db.md §3 (kind:"db-connection")
   PHP REST 계약: 01 §4 (/api/db/*). 백엔드가 PHP여도 프로필 형식·URL·JSON 동일.

   강등 규약(01 §6): 서버/드라이버/DB 부재 시 항상 200 + {ok, provider} 를 흉내내
   provider:'mock'|'error'로 강등. 백엔드가 없으면(정적 배포) 라우트 404/405/501/
   네트워크 실패 → unreachable=true, provider:'mock' 으로 강등(앱 안 죽음).

   노출:
     window.LLMLab.db = {
       TYPES,
       list, get, add, update, remove, duplicate,
       getActive, getActiveId, setActive,
       parse, validate, fromUserJSON, toUserJSON,
       import(=importConnections), importConnections, exportOne, exportAll,
       test, register, unregister, query, vectorSearch, graphQuery,
       save, onChange, offChange, apiBase, setApiBase,
     }
   ========================================================================== */
(function () {
'use strict';

var L = window.LLMLab;
if (!L) { console.error('[db] window.LLMLab 미로드 — DB 어댑터를 붙일 수 없습니다.'); return; }

/* ================================================================== */
/* 0. 상수                                                             */
/* ================================================================== */
var SCHEMA_VERSION = '1';
var LS_CONNS = 'llmlab.dbConnections';
var LS_ACTIVE = 'llmlab.dbActiveId';
var API_BASE = '/api/db';

var DB_TYPES = ['sqlite', 'mysql', 'postgres', 'pgvector', 'neo4j'];

// type별 기본 포트(폼 힌트)
var DEFAULT_PORT = { mysql: 3306, postgres: 5432, pgvector: 5432, neo4j: 7473 };

/* ================================================================== */
/* 1. 유틸                                                             */
/* ================================================================== */
function perfNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function nowISO() { return new Date().toISOString(); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'db';
}
function genId(seed) { return 'db_' + slugify(seed) + '-' + Math.random().toString(36).slice(2, 7); }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

/* ---- 이벤트(경량 버스) ---- */
var _subs = [];
function onChange(cb) { if (typeof cb === 'function') _subs.push(cb); }
function offChange(cb) { var i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); }
function emitChange() {
  var snap = { connections: list(), activeId: _activeId };
  _subs.slice().forEach(function (cb) { try { cb(snap); } catch (e) { console.warn('[db] listener error', e); } });
}

/* ================================================================== */
/* 2. 모델 — 정본 JSON ↔ 내부 구조                                     */
/* ================================================================== */
// 정본(사용자 JSON) → 내부 DBConnection
function fromUserJSON(u, opts) {
  opts = opts || {};
  var raw = clone(u) || {};
  var conn = isObj(raw.connection) ? raw.connection : {};
  var opt = isObj(raw.options) ? raw.options : {};
  var type = DB_TYPES.indexOf(raw.type) >= 0 ? raw.type : 'sqlite';
  return {
    id: opts.id || raw.__id || raw.id || genId(raw.label || type),
    label: raw.label || '(unnamed db)',
    type: type,
    network: raw.network || '',
    connection: {
      host: conn.host || '',
      port: (conn.port != null && conn.port !== '') ? Number(conn.port) : (DEFAULT_PORT[type] || null),
      database: conn.database || '',
      user: conn.user || '',
      password: conn.password || '',
      uri: conn.uri || null,
      db_path: conn.db_path || '',
      tls: isObj(conn.tls) ? conn.tls : { enabled: false },
    },
    options: {
      readonly: opt.readonly !== false,
      connect_timeout_ms: opt.connect_timeout_ms != null ? Number(opt.connect_timeout_ms) : 10000,
      statement_timeout_ms: opt.statement_timeout_ms != null ? Number(opt.statement_timeout_ms) : 15000,
      row_cap: opt.row_cap != null ? Number(opt.row_cap) : 200,
    },
    vector: isObj(raw.vector) ? raw.vector : null,
    graph: isObj(raw.graph) ? raw.graph : null,
    notes: Array.isArray(raw.notes) ? raw.notes.slice() : [],
    schemaVersion: raw.schemaVersion || SCHEMA_VERSION,
    // 런타임 상태(내보내기 미포함)
    status: { state: 'idle', driver: null, available: null, error: null, checkedAt: null, provider: null },
  };
}

// 내부 DBConnection → 정본(사용자 JSON). export 시 password → <REDACTED> (기본)
function toUserJSON(p, opts) {
  opts = opts || {};
  var redact = opts.redactPassword !== false; // 기본 REDACTED (01 §3.3)
  var c = p.connection || {};
  var out = {
    schemaVersion: p.schemaVersion || SCHEMA_VERSION,
    kind: 'db-connection',
    id: p.id,
    label: p.label,
    type: p.type,
    network: p.network || undefined,
    connection: {
      host: c.host || undefined,
      port: (c.port != null) ? c.port : undefined,
      database: c.database || undefined,
      user: c.user || undefined,
      password: c.password ? (redact ? '<REDACTED>' : c.password) : undefined,
      uri: c.uri || undefined,
      db_path: c.db_path || undefined,
      tls: (c.tls && Object.keys(c.tls).length) ? clone(c.tls) : undefined,
    },
    options: clone(p.options),
    vector: p.vector ? clone(p.vector) : (p.type === 'pgvector' ? {} : null),
    graph: p.graph ? clone(p.graph) : (p.type === 'neo4j' ? {} : null),
    notes: (p.notes && p.notes.length) ? p.notes.slice() : undefined,
  };
  return JSON.parse(JSON.stringify(out));
}

/* ---- 검증 (01 §3.4) — {ok, errors[], warnings[]} ---- */
function validate(u) {
  var errors = [], warnings = [];
  if (!isObj(u)) return { ok: false, errors: ['DB 연결이 객체가 아닙니다.'], warnings: warnings };
  if (!u.label || !String(u.label).trim()) errors.push('label(연결 이름)이 필요합니다.');
  var type = u.type;
  if (DB_TYPES.indexOf(type) < 0) { errors.push('type은 ' + DB_TYPES.join('|') + ' 중 하나여야 합니다.'); }
  var c = isObj(u.connection) ? u.connection : {};
  if (type === 'sqlite') {
    if (!c.db_path || !String(c.db_path).trim()) errors.push('sqlite: connection.db_path가 필요합니다.');
  } else if (type === 'neo4j') {
    if (!c.uri && !c.host) errors.push('neo4j: connection.host 또는 uri가 필요합니다.');
  } else { // mysql / postgres / pgvector
    if (!c.host) errors.push(type + ': connection.host가 필요합니다.');
    if (!c.database) warnings.push(type + ': connection.database가 비어 있습니다.');
    if (!c.user) warnings.push(type + ': connection.user가 비어 있습니다.');
  }
  if (type === 'pgvector') {
    var v = isObj(u.vector) ? u.vector : {};
    if (!v.table) errors.push('pgvector: vector.table이 필요합니다.');
    if (!v.embedding_column) errors.push('pgvector: vector.embedding_column이 필요합니다.');
    if (v.dim == null) warnings.push('pgvector: vector.dim이 지정되지 않았습니다(임베딩 차원).');
  }
  if (isObj(u.options) && u.options.readonly === false) {
    warnings.push('readonly=false — 쓰기 허용 상태입니다. 최소권한 계정을 권장합니다.');
  }
  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/* ---- Import 파서: 단일/묶음 자동 감지 (01 §3.3) ---- */
function parse(input) {
  var errors = [], data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); }
    catch (e) { return { kind: 'invalid', connections: [], errors: ['JSON 파싱 실패: ' + (e && e.message)] }; }
  }
  if (Array.isArray(data)) return { kind: 'array', connections: data.filter(isObj), errors: errors };
  if (isObj(data)) {
    // 묶음: type === 'llm-lab-db-connections' && connections[]
    if (Array.isArray(data.connections) && (data.type === 'llm-lab-db-connections' || data.connections.length)) {
      return { kind: 'bundle', connections: data.connections.filter(isObj), errors: errors };
    }
    // 단일: kind:"db-connection" 또는 type + connection
    return { kind: 'single', connections: [data], errors: errors };
  }
  return { kind: 'invalid', connections: [], errors: ['지원하지 않는 형식입니다.'] };
}

/* ================================================================== */
/* 3. 저장소 (localStorage)                                            */
/* ================================================================== */
var _conns = [];       // DBConnection[]
var _activeId = null;

function load() {
  var raw = lsGet(LS_CONNS);
  if (raw) {
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) _conns = arr.map(function (u) { return fromUserJSON(u, { id: u.__id || u.id }); });
    } catch (e) { console.warn('[db] 연결 로드 실패', e); }
  }
  _activeId = lsGet(LS_ACTIVE) || null;
  if (!_conns.some(function (p) { return p.id === _activeId; })) _activeId = null;
}
function save() {
  // 저장 형식: 정본 JSON 배열(비밀 포함 — 로컬 평문) + __id
  var arr = _conns.map(function (p) { var u = toUserJSON(p, { redactPassword: false }); u.__id = p.id; return u; });
  lsSet(LS_CONNS, JSON.stringify(arr));
  lsSet(LS_ACTIVE, _activeId || '');
  emitChange();
}

function list() { return _conns.slice(); }
function get(id) { return _conns.find(function (p) { return p.id === id; }) || null; }
function getActiveId() { return _activeId; }
function getActive() { return get(_activeId); }
function setActive(id) {
  if (id && !get(id)) return null;
  _activeId = id || null;
  lsSet(LS_ACTIVE, _activeId || '');
  emitChange();
  return getActive();
}

function uniqueLabel(base) {
  var label = base, n = 2;
  var has = function (l) { return _conns.some(function (p) { return p.label === l; }); };
  while (has(label)) { label = base.replace(/\s\(\d+\)$/, '') + ' (' + n + ')'; n++; }
  return label;
}

function add(userConn, opts) {
  opts = opts || {};
  var p = fromUserJSON(userConn);
  _conns.push(p);
  if (opts.activate) _activeId = p.id;
  save();
  return p;
}

function update(id, patch) {
  var p = get(id);
  if (!p) return null;
  if (patch.label != null) p.label = patch.label;
  if (patch.type != null && DB_TYPES.indexOf(patch.type) >= 0) p.type = patch.type;
  if (patch.network != null) p.network = patch.network;
  if (isObj(patch.connection)) p.connection = Object.assign({}, p.connection, patch.connection);
  if (isObj(patch.options)) p.options = Object.assign({}, p.options, patch.options);
  if (patch.vector !== undefined) p.vector = patch.vector ? clone(patch.vector) : null;
  if (patch.graph !== undefined) p.graph = patch.graph ? clone(patch.graph) : null;
  if (patch.notes != null) p.notes = patch.notes.slice();
  save();
  return p;
}

function remove(id) {
  var i = _conns.findIndex(function (p) { return p.id === id; });
  if (i < 0) return false;
  _conns.splice(i, 1);
  if (_activeId === id) _activeId = null;
  save();
  return true;
}

function duplicate(id) {
  var p = get(id);
  if (!p) return null;
  var u = toUserJSON(p, { redactPassword: false });
  u.label = uniqueLabel(u.label + ' (사본)');
  delete u.id; delete u.__id;
  var np = fromUserJSON(u);
  _conns.push(np);
  save();
  return np;
}

// Import (단일/묶음 자동 감지 · 중복처리 · 검증)
function importConnections(input, opts) {
  opts = opts || {};
  var onDuplicate = typeof opts.onDuplicate === 'function' ? opts.onDuplicate : function () { return 'add'; };
  var parsed = parse(input);
  var result = { kind: parsed.kind, added: [], updated: [], skipped: [], errors: [], warnings: [] };
  if (parsed.errors.length) result.errors.push({ label: null, errors: parsed.errors });
  if (!parsed.connections.length) return result;

  parsed.connections.forEach(function (u) {
    var v = validate(u);
    if (v.warnings.length) result.warnings.push({ label: u.label, warnings: v.warnings });
    if (!v.ok) { result.errors.push({ label: u.label || '(unnamed)', errors: v.errors }); return; }
    var existing = _conns.find(function (p) { return p.label === u.label; });
    if (existing) {
      var choice = onDuplicate(u, existing);
      if (choice === 'skip') { result.skipped.push(u.label); return; }
      if (choice === 'overwrite') {
        var np = fromUserJSON(u, { id: existing.id });
        var idx = _conns.findIndex(function (p) { return p.id === existing.id; });
        _conns[idx] = np; result.updated.push(np); return;
      }
      u = clone(u); u.label = uniqueLabel(u.label + ' (2)'); delete u.id; delete u.__id;
    }
    var added = fromUserJSON(u);
    _conns.push(added); result.added.push(added);
  });
  save();
  return result;
}

function exportOne(id, opts) {
  var p = get(id);
  if (!p) return null;
  return JSON.stringify(toUserJSON(p, opts), null, 2);
}
function exportAll(opts) {
  opts = opts || {};
  var ids = Array.isArray(opts.ids) ? opts.ids : _conns.map(function (p) { return p.id; });
  var bundle = {
    schemaVersion: SCHEMA_VERSION,
    type: 'llm-lab-db-connections',
    exportedAt: nowISO(),
    connections: ids.map(function (id) { return get(id); }).filter(Boolean).map(function (p) { return toUserJSON(p, opts); }),
  };
  return JSON.stringify(bundle, null, 2);
}

/* ================================================================== */
/* 4. PHP REST 클라이언트 (/api/db/*) — 우아한 강등                    */
/* ================================================================== */
// 항상 객체를 resolve (throw 안 함). 백엔드 부재/네트워크 실패 → provider:'mock', unreachable:true
async function postDb(op, payload, signal) {
  var url = API_BASE + '/' + op;
  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: signal,
    });
  } catch (e) {
    if (signal && signal.aborted) return { ok: false, provider: 'error', aborted: true, error: '중단됨' };
    // 네트워크/CORS/파일프로토콜 → 백엔드 미도달
    return { ok: false, provider: 'mock', unreachable: true, error: '백엔드 미도달(네트워크): ' + (e && e.message ? e.message : e) };
  }
  // 정적 배포(PHP 없음) → 라우트 없음
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { ok: false, provider: 'mock', unreachable: true, status: res.status, error: '/api/db 백엔드가 배포되지 않았습니다(PHP 미탑재).' };
  }
  var data = null;
  try { data = await res.json(); } catch (e) { /* */ }
  if (!isObj(data)) return { ok: false, provider: 'error', status: res.status, error: '응답 파싱 실패(HTTP ' + res.status + ')' };
  if (data.provider == null) data.provider = res.ok ? 'server' : 'error';
  return data;
}

// 연결 테스트 — connId 또는 1회성 profile(정본 JSON)
async function test(arg, opts) {
  opts = opts || {};
  var payload = {};
  if (typeof arg === 'string') {
    payload.connId = arg;
    var p = get(arg);
    if (p) payload.profile = toUserJSON(p, { redactPassword: false }); // 미등록 대비 인라인
  } else if (isObj(arg)) {
    // 내부 DBConnection 또는 정본 JSON 모두 허용
    payload.profile = arg.kind === 'db-connection' ? clone(arg) : toUserJSON(fromUserJSON(arg), { redactPassword: false });
  }
  var t0 = perfNow();
  var r = await postDb('test', payload, opts.signal);
  if (r.ms == null) r.ms = Math.round(perfNow() - t0);
  if (r.unreachable && !r.hint) r.hint = '정적/샌드박스 환경에서는 /api/db 가 없어 mock으로 강등됩니다. PHP 백엔드 배포 후 실제 드라이버 상태가 표시됩니다.';
  // 로컬 상태 반영
  if (typeof arg === 'string') {
    var conn = get(arg);
    if (conn) {
      conn.status = {
        state: r.ok ? 'ok' : (r.unreachable ? 'idle' : 'err'),
        driver: r.driver || (r.checks && r.checks.extension) || null,
        available: r.driver ? true : (r.checks ? !!r.checks.extension : null),
        error: r.ok ? null : (r.error || null),
        checkedAt: Date.now(),
        provider: r.provider,
      };
      emitChange();
    }
  }
  return r;
}

// 등록(비밀을 서버에 저장, connId 발급) — 백엔드 있을 때만 의미
async function register(arg, opts) {
  opts = opts || {};
  var profile;
  if (typeof arg === 'string') { var p = get(arg); profile = p ? toUserJSON(p, { redactPassword: false }) : null; }
  else if (isObj(arg)) { profile = arg.kind === 'db-connection' ? clone(arg) : toUserJSON(fromUserJSON(arg), { redactPassword: false }); }
  if (!profile) return { ok: false, provider: 'error', error: '등록할 프로필이 없습니다.' };
  return postDb('register', { profile: profile }, opts.signal);
}
async function unregister(connId, opts) {
  opts = opts || {};
  return postDb('unregister', { connId: connId }, opts.signal);
}

// RDB SQL 실행 (readonly 기본) — 01 §4.3
async function query(opts) {
  opts = opts || {};
  var payload = {
    connId: opts.connId,
    sql: opts.sql,
    params: opts.params || {},
    readonly: opts.readonly !== false,
    row_cap: opts.row_cap || 200,
  };
  if (!opts.connId && opts.profile) payload.profile = opts.profile;
  var t0 = perfNow();
  var r = await postDb('query', payload, opts.signal);
  if (r.ms == null) r.ms = Math.round(perfNow() - t0);
  return r;
}

// pgvector 유사도 검색 — 01 §4.4. 반환 results[]=기존 Retriever 스키마
async function vectorSearch(opts) {
  opts = opts || {};
  var payload = {
    connId: opts.connId,
    top_k: opts.top_k || 5,
    metric: opts.metric || 'cosine',
    filter: opts.filter || null,
    min_score: opts.min_score != null ? opts.min_score : 0,
  };
  if (opts.embedding) payload.embedding = opts.embedding;
  if (opts.text != null) payload.text = opts.text; // 서버가 임베딩 생성(옵션)
  if (!opts.connId && opts.profile) payload.profile = opts.profile;
  var t0 = perfNow();
  var r = await postDb('vector/search', payload, opts.signal);
  if (r.ms == null) r.ms = Math.round(perfNow() - t0);
  return r;
}

// Neo4j Cypher — 01 §4.5. 반환 {nodes,edges,communities}
async function graphQuery(opts) {
  opts = opts || {};
  var payload = {
    connId: opts.connId,
    mode: opts.mode || 'global',
    readonly: opts.readonly !== false,
    params: opts.params || {},
  };
  if (opts.cypher) payload.cypher = opts.cypher;
  if (!opts.connId && opts.profile) payload.profile = opts.profile;
  var t0 = perfNow();
  var r = await postDb('graph/query', payload, opts.signal);
  if (r.ms == null) r.ms = Math.round(perfNow() - t0);
  return r;
}

/* ================================================================== */
/* 5. 초기화 · 노출                                                    */
/* ================================================================== */
load();

L.db = {
  TYPES: DB_TYPES.slice(),
  DEFAULT_PORT: Object.assign({}, DEFAULT_PORT),
  list: list, get: get, add: add, update: update, remove: remove, duplicate: duplicate,
  getActive: getActive, getActiveId: getActiveId, setActive: setActive,
  parse: parse, validate: validate, fromUserJSON: fromUserJSON, toUserJSON: toUserJSON,
  import: importConnections, importConnections: importConnections, exportOne: exportOne, exportAll: exportAll,
  test: test, register: register, unregister: unregister,
  query: query, vectorSearch: vectorSearch, graphQuery: graphQuery,
  save: save, onChange: onChange, offChange: offChange,
  apiBase: function () { return API_BASE; },
  setApiBase: function (b) { API_BASE = b || '/api/db'; },
};

if (typeof window !== 'undefined') window.LLMLab = L;

})();
