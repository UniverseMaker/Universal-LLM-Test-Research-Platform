// llmlab.js — LLM Lab v24 엔진 계층 (단계 1: 프로필 · 공용 커널 · 헬스체크 · View code · 실행로그)
// 정본 형식: _workspace/00_profile_format_guide.md (사용자 지정 프로필 JSON)
// 통합 명세: _workspace/03_design_spec.md (§3 프로필 · §4 인스펙터 · §5 파라미터 · §8 계약)
//
// 비 ES모듈(IIFE) — window.LLMLab.* 로 노출. file:// 에서도 동작.
// 기존 api.js(v23 스트리밍/파일컨텍스트/웹검색/GraphRAG)와 공존하며, ChatAPI.sendMessage는
// 이 커널 위에서 동작하도록 api.js에서 위임한다(호환 유지).
//
// ─────────────────────────────────────────────────────────────────────────────
//  프런트(frontend-engineer)가 소비하는 계약(요약):
//  window.LLMLab = {
//    version, schemaVersion, DEFAULT_PARAMS, DEFAULT,
//    profiles: { list,get,getActive,getActiveId,setActive,add,update,remove,duplicate,save,
//                seedIfEmpty, parse, import(=importProfiles), validate,
//                exportOne, exportAll, toUserJSON, fromUserJSON },
//    kernel:   { run(req)->Promise<RunResult>, buildBody, buildHeaders, buildTargetURL },
//    healthCheck(profileOrId,opts)->Promise<HealthResult>,
//    listModels(profileOrId,opts), diagnose(profileOrId,opts),
//    viewCode: { curl(req), python(req), fetch(req), all(req) },
//    runLog:   { add,list,get,clear,exportJSON,exportCSV,getLast },
//    proxyPath, setProxyPath, on(evt,cb), off(evt,cb)
//  }
// ─────────────────────────────────────────────────────────────────────────────

(function () {
'use strict';

/* ================================================================== */
/* 0. 상수 · 기본값                                                     */
/* ================================================================== */

const SCHEMA_VERSION = '1';
const APP_VERSION = '24';
const LS_PROFILES = 'llmlab.profiles';
const LS_ACTIVE = 'llmlab.activeProfileId';
let PROXY_PATH = '/api/proxy'; // server.py 범용 릴레이 라우트
const RUNLOG_MAX = 500;
const RAW_CHUNK_MAX = 800;      // 인스펙터 원시 SSE 청크 보존 상한(개수)
const RAW_BYTES_MAX = 512 * 1024; // 원시 SSE 보존 상한(바이트)

// §3.4 / 00 §3 정본 params 기본값
const DEFAULT_PARAMS = {
  context_window: null,
  max_tokens: 1024,
  temperature: 0.7,
  top_p: 1.0,
  top_k: 0,
  min_p: 0.0,
  repetition_penalty: 1.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  stop: [],
  seed: null,
  stream: true,
  timeout_ms: 120000,
  extra_body: {},
};

// 공개 배포: 내장 기본 시드 프로필 없음.
// 신규 배포는 연결 프로필 0개(빈 목록)로 시작하며, 사용자가 직접 연결을 추가한다.
// 활성 프로필이 없을 때 참조하는 안전 폴백(모든 실값이 빈 문자열).
const BLANK_USER = {
  schemaVersion: '1',
  service: '(none)',
  base_url: '',
  model: '',
  auth: { type: 'bearer', api_key: '' },
  params: {},
};

/* ================================================================== */
/* 1. 유틸                                                             */
/* ================================================================== */

function perfNow() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}
function nowISO() { return new Date().toISOString(); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } }

function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'profile';
}
function genId(seed) {
  return slugify(seed) + '-' + Math.random().toString(36).slice(2, 8);
}

// API 키 마스킹: 앞뒤 일부만 노출 (예: sk-••••1234)
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k === '<REDACTED>') return k;
  if (k.length <= 8) return k.slice(0, 2) + '••••';
  return k.slice(0, 3) + '••••' + k.slice(-4);
}

// URL의 baseURL에서 host/port 유도
function deriveHostPort(baseURL) {
  try {
    const u = new URL(baseURL);
    return { host: u.hostname, port: u.port ? Number(u.port) : null };
  } catch { return { host: '', port: null }; }
}

// baseURL 기준 엔드포인트 유도 (§3.3)
function deriveEndpoints(baseURL) {
  const b = String(baseURL || '').replace(/\/+$/, '');
  return {
    chat: b + '/chat/completions',
    completions: b + '/completions',
    models: b + '/models',
    embeddings: b + '/embeddings',
  };
}

function meaningful(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (isObj(v) && Object.keys(v).length === 0) return false;
  return true;
}

/* ================================================================== */
/* 2. 이벤트 버스                                                       */
/* ================================================================== */
const _listeners = Object.create(null);
function on(evt, cb) { (_listeners[evt] = _listeners[evt] || []).push(cb); }
function off(evt, cb) {
  const a = _listeners[evt]; if (!a) return;
  const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1);
}
function emit(evt, payload) {
  const a = _listeners[evt]; if (!a) return;
  a.slice().forEach((cb) => { try { cb(payload); } catch (e) { console.warn('[llmlab] listener error', e); } });
}

/* ================================================================== */
/* 3. 프로필 모델 — 정본 JSON ↔ 내부 구조 (§3.5 매핑)                   */
/* ================================================================== */

// 정본(사용자 JSON) → 내부 Profile
function fromUserJSON(u, opts) {
  opts = opts || {};
  const raw = clone(u) || {};
  const baseURL = String(raw.base_url || '').trim();
  const hp = deriveHostPort(baseURL);
  const dep = deriveEndpoints(baseURL);
  const eps = isObj(raw.endpoints) ? raw.endpoints : {};
  const auth = isObj(raw.auth) ? raw.auth : { type: 'none' };

  const params = { ...DEFAULT_PARAMS, ...(isObj(raw.params) ? raw.params : {}) };
  params.extra_body = isObj(params.extra_body) ? params.extra_body : {};

  return {
    id: opts.id || raw.__id || genId(raw.service || baseURL),
    label: raw.service || baseURL || '(unnamed)',
    baseURL,
    host: raw.host || hp.host,
    port: (raw.port != null ? raw.port : hp.port),
    model: raw.model || '',
    modelNote: raw.model_note || '',
    auth: {
      scheme: auth.type || 'bearer',
      key: auth.api_key || '',
      headerSpec: auth.header || '',
    },
    ep: {
      chat: eps.chat_completions || dep.chat,
      completions: eps.completions || dep.completions,
      models: eps.models || dep.models,
      embeddings: eps.embeddings || dep.embeddings,
    },
    server: isObj(raw.server) ? raw.server : {},
    network: raw.network || '',
    notes: Array.isArray(raw.notes) ? raw.notes.slice() : [],
    examples: isObj(raw.examples) ? raw.examples : {},
    params,
    schemaVersion: raw.schemaVersion || SCHEMA_VERSION,
    // 런타임 상태(내보내기에 미포함)
    status: { state: 'idle', latencyMs: null, models: [], checkedAt: null, error: null },
    // 원본 보존(server 패널·라운드트립 안정성)
    _raw: raw,
  };
}

// 내부 Profile → 정본(사용자 JSON) (§3.6 export 형식, includeKey 옵션)
function toUserJSON(p, opts) {
  opts = opts || {};
  const includeKey = opts.includeKey !== false; // 기본 포함, 공유 export는 false 권장
  const out = {
    schemaVersion: p.schemaVersion || SCHEMA_VERSION,
    service: p.label,
    network: p.network || undefined,
    base_url: p.baseURL,
    host: p.host || undefined,
    port: (p.port != null ? p.port : undefined),
    model: p.model,
    model_note: p.modelNote || undefined,
    auth: {
      type: p.auth.scheme || 'bearer',
      header: p.auth.headerSpec || undefined,
      api_key: undefined,
    },
    endpoints: {
      chat_completions: p.ep.chat,
      completions: p.ep.completions,
      models: p.ep.models,
      embeddings: p.ep.embeddings || undefined,
    },
    server: (p.server && Object.keys(p.server).length) ? clone(p.server) : undefined,
    notes: (p.notes && p.notes.length) ? p.notes.slice() : undefined,
    examples: (p.examples && Object.keys(p.examples).length) ? clone(p.examples) : undefined,
    params: clone(p.params),
  };
  // 인증 키: 포함 여부
  if (p.auth.scheme === 'none') {
    delete out.auth.api_key;
  } else if (includeKey) {
    out.auth.api_key = p.auth.key || '';
  } else {
    out.auth.api_key = '<REDACTED>';
    // server 메타의 민감 파일 경로도 보수적으로 치환
    if (out.server && out.server.api_key_file) out.server.api_key_file = '<REDACTED>';
  }
  // undefined 정리(깨끗한 JSON)
  return JSON.parse(JSON.stringify(out));
}

// 검증 (§3.7 / 00 §8) — {ok, errors[], warnings[]}
function validate(u) {
  const errors = [];
  const warnings = [];
  if (!isObj(u)) return { ok: false, errors: ['프로필이 객체가 아닙니다.'], warnings };
  if (!u.service || !String(u.service).trim()) errors.push('service(연결 이름)가 필요합니다.');
  const base = String(u.base_url || '').trim();
  if (!base) {
    errors.push('base_url이 필요합니다.');
  } else {
    try { new URL(base); } catch { errors.push('base_url이 유효한 URL이 아닙니다: ' + base); }
    if (!/\/v1\/?$/.test(base)) warnings.push('base_url이 /v1 로 끝나지 않습니다(권장): ' + base);
  }
  if (!u.model || !String(u.model).trim()) errors.push('model이 필요합니다.');
  const auth = isObj(u.auth) ? u.auth : {};
  const type = auth.type || 'bearer';
  if (type === 'bearer') {
    if (!auth.api_key) warnings.push('auth.type=bearer 이지만 api_key가 없습니다(키 필요).');
    else if (auth.api_key === '<REDACTED>') warnings.push('api_key가 <REDACTED> 입니다 — 실제 키 입력 필요.');
  }
  if (!u.network && !(Array.isArray(u.notes) && u.notes.length)) {
    warnings.push('접근 범위(network/notes)가 명시되지 않았습니다(정보성).');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/* ---- Import 파서: 단일/묶음 자동 감지 (§3.6) ---- */
// input: string(JSON) | object | array → {kind, profiles:UserProfile[], errors[]}
function parse(input) {
  const errors = [];
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); }
    catch (e) { return { kind: 'invalid', profiles: [], errors: ['JSON 파싱 실패: ' + (e && e.message)] }; }
  }
  if (Array.isArray(data)) {
    return { kind: 'array', profiles: data.filter(isObj), errors };
  }
  if (isObj(data)) {
    // 묶음: type === 'llm-lab-profiles' && profiles[] (§3.6)
    if (Array.isArray(data.profiles) && (data.type === 'llm-lab-profiles' || data.profiles.length)) {
      return { kind: 'bundle', profiles: data.profiles.filter(isObj), errors };
    }
    // 단일 프로필
    return { kind: 'single', profiles: [data], errors };
  }
  return { kind: 'invalid', profiles: [], errors: ['지원하지 않는 형식입니다.'] };
}

/* ================================================================== */
/* 4. 프로필 저장소 (localStorage)                                     */
/* ================================================================== */

let _profiles = [];       // Profile[]
let _activeId = null;

function _lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

function loadProfiles() {
  const rawList = _lsGet(LS_PROFILES);
  if (rawList) {
    try {
      const arr = JSON.parse(rawList);
      if (Array.isArray(arr)) {
        _profiles = arr.map((u) => fromUserJSON(u, { id: u.__id }));
      }
    } catch (e) { console.warn('[llmlab] 프로필 로드 실패', e); }
  }
  _activeId = _lsGet(LS_ACTIVE) || null;
  seedIfEmpty();
  // active 유효성
  if (!_profiles.some((p) => p.id === _activeId)) {
    _activeId = _profiles.length ? _profiles[0].id : null;
  }
}

function saveProfiles() {
  // 저장 형식: 정본 사용자 JSON 배열 + 내부 id(__id) 부착(키 포함 — 로컬 평문)
  const arr = _profiles.map((p) => {
    const u = toUserJSON(p, { includeKey: true });
    u.__id = p.id;
    return u;
  });
  _lsSet(LS_PROFILES, JSON.stringify(arr));
  _lsSet(LS_ACTIVE, _activeId || '');
  emit('profiles:change', { profiles: _profiles.slice(), activeId: _activeId });
}

function seedIfEmpty() {
  // 공개 배포: 기본 시드 없음(no-op). 빈 프로필 목록으로 시작한다.
  // 사용자가 새 연결 또는 Import로 직접 프로필을 추가한다.
}

function list() { return _profiles.slice(); }
function get(id) { return _profiles.find((p) => p.id === id) || null; }
function getActiveId() { return _activeId; }
function getActive() { return get(_activeId); }
function setActive(id) {
  if (!get(id)) return null;
  _activeId = id;
  _lsSet(LS_ACTIVE, id);
  emit('active:change', { activeId: id, profile: getActive() });
  return getActive();
}

// 정본 사용자 JSON 하나를 추가(검증 후). 반환 Profile
function add(userProfile, opts) {
  opts = opts || {};
  const p = fromUserJSON(userProfile);
  _profiles.push(p);
  if (opts.activate || _profiles.length === 1) _activeId = p.id;
  saveProfiles();
  return p;
}

function update(id, patch) {
  const p = get(id);
  if (!p) return null;
  // patch는 내부 Profile 부분 필드 (label/baseURL/model/auth/ep/params/…)
  if (patch.label != null) p.label = patch.label;
  if (patch.baseURL != null) {
    p.baseURL = patch.baseURL;
    const hp = deriveHostPort(patch.baseURL);
    if (patch.host == null) p.host = hp.host;
    if (patch.port == null) p.port = hp.port;
    // baseURL 변경 시 미지정 엔드포인트 자동 갱신
    const dep = deriveEndpoints(patch.baseURL);
    if (patch.ep == null) p.ep = { ...dep, embeddings: dep.embeddings };
  }
  if (patch.host != null) p.host = patch.host;
  if (patch.port != null) p.port = patch.port;
  if (patch.model != null) p.model = patch.model;
  if (patch.modelNote != null) p.modelNote = patch.modelNote;
  if (patch.network != null) p.network = patch.network;
  if (patch.notes != null) p.notes = patch.notes.slice();
  if (patch.examples != null) p.examples = clone(patch.examples);
  if (patch.server != null) p.server = clone(patch.server);
  if (isObj(patch.auth)) p.auth = { ...p.auth, ...patch.auth };
  if (isObj(patch.ep)) p.ep = { ...p.ep, ...patch.ep };
  if (isObj(patch.params)) {
    p.params = { ...p.params, ...patch.params };
    p.params.extra_body = isObj(p.params.extra_body) ? p.params.extra_body : {};
  }
  saveProfiles();
  return p;
}

function remove(id) {
  const i = _profiles.findIndex((p) => p.id === id);
  if (i < 0) return false;
  _profiles.splice(i, 1);
  if (_activeId === id) _activeId = _profiles.length ? _profiles[0].id : null;
  saveProfiles();
  return true;
}

function duplicate(id) {
  const p = get(id);
  if (!p) return null;
  const u = toUserJSON(p, { includeKey: true });
  u.service = uniqueLabel(u.service + ' (사본)');
  const np = fromUserJSON(u);
  _profiles.push(np);
  saveProfiles();
  return np;
}

function uniqueLabel(base) {
  let label = base, n = 2;
  const has = (l) => _profiles.some((p) => p.label === l);
  while (has(label)) { label = base.replace(/\s\(\d+\)$/, '') + ' (' + n + ')'; n++; }
  return label;
}

// Import (단일/묶음 자동감지 · 중복처리 · 검증) — §3.6
// onDuplicate: (userProfile, existing) => 'overwrite'|'add'|'skip' (기본 'add')
// 반환: { added:Profile[], updated:Profile[], skipped:[], errors:[{profile,errors}], warnings:[] }
function importProfiles(input, opts) {
  opts = opts || {};
  const onDuplicate = typeof opts.onDuplicate === 'function' ? opts.onDuplicate : () => 'add';
  const parsed = parse(input);
  const result = { kind: parsed.kind, added: [], updated: [], skipped: [], errors: [], warnings: [] };
  if (parsed.errors.length) result.errors.push({ profile: null, errors: parsed.errors });
  if (!parsed.profiles.length) return result;

  parsed.profiles.forEach((u) => {
    const v = validate(u);
    if (v.warnings.length) result.warnings.push({ service: u.service, warnings: v.warnings });
    if (!v.ok) { result.errors.push({ service: u.service || '(unnamed)', errors: v.errors }); return; }

    const existing = _profiles.find((p) => p.label === u.service);
    if (existing) {
      const choice = onDuplicate(u, toUserJSON(existing, { includeKey: false }));
      if (choice === 'skip') { result.skipped.push(u.service); return; }
      if (choice === 'overwrite') {
        const np = fromUserJSON(u, { id: existing.id });
        const idx = _profiles.findIndex((p) => p.id === existing.id);
        _profiles[idx] = np;
        result.updated.push(np);
        return;
      }
      // 'add' → 라벨 뒤 (2)
      u = clone(u); u.service = uniqueLabel(u.service + ' (2)');
    }
    const np = fromUserJSON(u);
    _profiles.push(np);
    result.added.push(np);
  });

  if (_profiles.length && !get(_activeId)) _activeId = _profiles[0].id;
  saveProfiles();
  return result;
}

// Export — 개별(단일 객체) / 전체(묶음) — §3.6
function exportOne(id, opts) {
  const p = get(id);
  if (!p) return null;
  return JSON.stringify(toUserJSON(p, opts), null, 2);
}
function exportAll(opts) {
  opts = opts || {};
  const ids = Array.isArray(opts.ids) ? opts.ids : _profiles.map((p) => p.id);
  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    type: 'llm-lab-profiles',
    exportedAt: nowISO(),
    profiles: ids.map((id) => get(id)).filter(Boolean).map((p) => toUserJSON(p, opts)),
  };
  return JSON.stringify(bundle, null, 2);
}

/* ================================================================== */
/* 5. 요청 조립 — 헤더 · URL · body (§3.2/3.3 · §5 파라미터 · extra_body) */
/* ================================================================== */

// 인증 · 커스텀 헤더 조립 → { headers(실전송), masked(인스펙터 표시) }
function buildHeaders(profile, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  const masked = { 'Content-Type': 'application/json' };
  const auth = profile && profile.auth ? profile.auth : { scheme: 'none' };

  if (auth.scheme === 'bearer') {
    const key = auth.key || '';
    headers['Authorization'] = 'Bearer ' + key;
    masked['Authorization'] = 'Bearer ' + maskKey(key);
  } else if (auth.scheme === 'custom') {
    // headerSpec: "X-API-Key: <api_key>" 또는 실제 헤더명 "X-API-Key"
    const spec = String(auth.headerSpec || '').trim();
    const key = auth.key || '';
    if (spec.includes(':')) {
      const idx = spec.indexOf(':');
      const name = spec.slice(0, idx).trim();
      const valTmpl = spec.slice(idx + 1).trim();
      const val = valTmpl.replace(/<api_key>/g, key);
      const maskedVal = valTmpl.replace(/<api_key>/g, maskKey(key));
      if (name) { headers[name] = val; masked[name] = maskedVal; }
    } else if (spec) {
      headers[spec] = key;
      masked[spec] = maskKey(key);
    }
  } // 'none' → 인증 헤더 미전송

  // 커스텀 헤더(그룹 B) — {name,value,enabled}[] 또는 {name:value}
  const extra = opts.extraHeaders;
  if (Array.isArray(extra)) {
    extra.forEach((h) => {
      if (!h || h.enabled === false || !h.name) return;
      headers[h.name] = h.value; masked[h.name] = h.value;
    });
  } else if (isObj(extra)) {
    Object.keys(extra).forEach((k) => { headers[k] = extra[k]; masked[k] = extra[k]; });
  }
  return { headers, masked };
}

// 엔드포인트 URL — endpoint: 'chat'|'completions'|'models'|'embeddings'
function buildTargetURL(profile, endpoint) {
  const ep = (profile && profile.ep) || deriveEndpoints(profile && profile.baseURL);
  switch (endpoint) {
    case 'completions': return ep.completions;
    case 'models': return ep.models;
    case 'embeddings': return ep.embeddings;
    case 'chat':
    default: return ep.chat;
  }
}

// 표준 body 파라미터 화이트리스트 (§5 C~F)
const STD_PARAM_KEYS = [
  'max_tokens', 'max_completion_tokens', 'min_tokens',
  'temperature', 'top_p', 'top_k', 'min_p', 'typical_p', 'tfs', 'tfs_z',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty',
  'repeat_last_n', 'no_repeat_ngram_size', 'length_penalty',
  'stop', 'stop_token_ids', 'seed', 'n', 'best_of',
  'logit_bias', 'logprobs', 'top_logprobs', 'prompt_logprobs', 'echo',
  'tools', 'tool_choice', 'parallel_tool_calls', 'user',
];

// 파라미터 병합: DEFAULT → profile.params → override
function mergeParams(profile, override) {
  const base = { ...DEFAULT_PARAMS, ...((profile && profile.params) || {}) };
  const ov = isObj(override) ? override : {};
  const merged = { ...base, ...ov };
  merged.extra_body = {
    ...(isObj(base.extra_body) ? base.extra_body : {}),
    ...(isObj(ov.extra_body) ? ov.extra_body : {}),
  };
  return merged;
}

// 요청 body 조립 (extra_body 격리 → 전송 시 병합, §5.7)
// req 필드: messages | prompt, model, params(=merged), stream, endpoint, reasoningEnabled
function buildBody(profile, req) {
  req = req || {};
  const params = req.params || mergeParams(profile, null);
  const stream = req.stream != null ? req.stream : (params.stream !== false);
  const endpoint = req.endpoint || 'chat';
  const model = req.model || (profile && profile.model) || '';

  const body = { model, stream };

  if (endpoint === 'completions') {
    body.prompt = req.prompt != null ? req.prompt : '';
  } else {
    body.messages = Array.isArray(req.messages) ? req.messages : [];
  }

  // 표준 파라미터 주입
  STD_PARAM_KEYS.forEach((k) => {
    let v = params[k];
    if (!meaningful(v)) return;
    // stop: 문자열 → 배열 정규화
    if (k === 'stop' && typeof v === 'string') v = v.split('\n').map((s) => s).filter((s) => s.length);
    if (k === 'stop_token_ids' && typeof v === 'string') {
      v = v.split(',').map((s) => Number(s.trim())).filter((x) => !Number.isNaN(x));
      if (!v.length) return;
    }
    body[k] = v;
  });

  // response_format: 'text' 기본은 생략, json_object/json_schema만 전송
  const rf = params.response_format;
  if (isObj(rf) && rf.type && rf.type !== 'text') body.response_format = rf;
  else if (typeof rf === 'string' && rf !== 'text' && rf.trim()) body.response_format = { type: rf };

  // 스트리밍 usage (§4 Usage) — include_usage 기본 on
  if (stream) {
    const so = isObj(params.stream_options) ? params.stream_options : null;
    body.stream_options = so || { include_usage: true };
  }

  // reasoning off 편의 훅(일부 모델) — extra_body에 없을 때만
  const eb = isObj(params.extra_body) ? params.extra_body : {};
  if (req.reasoningEnabled === false && !eb.chat_template_kwargs) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  }

  // extra_body 격리 컨테이너 → 최상위 병합(OpenAI 클라이언트 extra_body 시맨틱; vLLM이 top-level로 소비)
  Object.keys(eb).forEach((k) => {
    const v = eb[k];
    if (v === undefined) return;
    if (k === 'chat_template_kwargs' && isObj(body.chat_template_kwargs) && isObj(v)) {
      body.chat_template_kwargs = { ...body.chat_template_kwargs, ...v };
    } else {
      body[k] = v;
    }
  });

  return body;
}

/* ================================================================== */
/* 6. 프록시/직접 fetch 래퍼                                           */
/* ================================================================== */

function defaultUseProxy() {
  // file:// 에서는 /api/proxy 미도달 → 직접. http(s)면 프록시 기본(인스펙터 status/headers 확보).
  try { return typeof location !== 'undefined' && location.protocol !== 'file:'; }
  catch { return false; }
}

// 정적 배포(server.py 없음) 등으로 /api/proxy 부재가 확인되면 이후 직접 호출로 강등.
let PROXY_AVAILABLE = null; // null=미확인, true/false=감지됨

// https 페이지에서 http 대상은 혼합콘텐츠로 차단되므로 https로 승격(직접 호출 시).
function httpsUpgrade(url) {
  try {
    if (typeof location !== 'undefined' && location.protocol === 'https:'
        && typeof url === 'string' && url.slice(0, 5) === 'http:') {
      return 'https:' + url.slice(5);
    }
  } catch { /* */ }
  return url;
}

async function directFetch(target, method, headers, bodyText, signal) {
  const durl = httpsUpgrade(target); // 혼합콘텐츠 가드
  const res = await fetch(durl, { method, headers, body: bodyText, signal });
  const h = {};
  try { res.headers.forEach((v, k) => { h[k] = v; }); } catch { /* CORS 제한 */ }
  return { res, status: res.status, statusText: res.statusText, headers: h, viaProxy: false, proxyError: false, url: durl };
}

// 대상 요청을 프록시(POST /api/proxy) 또는 직접 수행.
// 프록시 라우트가 없으면(정적 배포) 자동으로 직접 호출로 폴백한다.
// 반환: { res, status, statusText, headers(obj), viaProxy, proxyError }
async function relayFetch(target, o) {
  o = o || {};
  const method = o.method || 'GET';
  const headers = o.headers || {};
  const bodyText = o.bodyText != null ? o.bodyText : null;
  const signal = o.signal;
  let useProxy = o.useProxy;

  if (useProxy && PROXY_AVAILABLE === false) useProxy = false; // 이미 부재 확인됨 → 직접

  if (useProxy) {
    let res;
    try {
      res = await fetch(PROXY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, url: target, headers, body: bodyText }),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      PROXY_AVAILABLE = false;                 // 프록시 도달 불가 → 직접 폴백
      return directFetch(target, method, headers, bodyText, signal);
    }
    const hasUpstream = res.headers.get('X-Upstream-Status') != null;
    const proxyError = res.headers.get('X-Proxy-Error') === '1';
    // 정적 서버가 POST /api/proxy 를 404/405/501 로 반환(우리 릴레이 헤더 없음) → 프록시 부재로 판단, 직접 폴백
    if (!hasUpstream && !proxyError && (res.status === 404 || res.status === 405 || res.status === 501)) {
      PROXY_AVAILABLE = false;
      return directFetch(target, method, headers, bodyText, signal);
    }
    PROXY_AVAILABLE = true;
    let status = Number(res.headers.get('X-Upstream-Status'));
    if (!status) status = res.status;
    let upstreamHeaders = {};
    try { upstreamHeaders = JSON.parse(res.headers.get('X-Upstream-Headers') || '{}'); } catch { /* */ }
    return {
      res,
      status: proxyError ? 502 : status,
      statusText: res.headers.get('X-Upstream-Status-Text') || res.statusText,
      headers: upstreamHeaders,
      viaProxy: true,
      proxyError,
    };
  }

  return directFetch(target, method, headers, bodyText, signal);
}

/* ================================================================== */
/* 7. 에러 분류 (§4.1 Error — 원인 힌트)                                */
/* ================================================================== */
function classifyHTTP(status, bodyText, proxyError) {
  const detail = (bodyText || '').slice(0, 400);
  if (proxyError) {
    return { type: 'proxy', status, message: '프록시(server.py)가 대상 서버에 연결하지 못했습니다.', hint: 'server.py 실행/대상 baseURL·방화벽·인트라넷 접근을 확인하세요.', body: detail };
  }
  if (status === 401 || status === 403) {
    return { type: 'auth', status, message: 'API 인증 실패 (HTTP ' + status + ').', hint: 'auth.api_key(키)를 확인하세요.', body: detail };
  }
  if (status === 404) {
    return { type: 'not_found', status, message: '엔드포인트/모델을 찾을 수 없습니다 (404).', hint: 'base_url·endpoints·model id를 /v1/models 목록과 대조하세요.', body: detail };
  }
  if (status === 400) {
    return { type: 'bad_request', status, message: '잘못된 요청 (400).', hint: '미지원 파라미터일 수 있습니다 — extra_body/샘플러 지원 여부를 확인하세요.', body: detail };
  }
  if (status === 422) {
    return { type: 'bad_request', status, message: '요청 검증 실패 (422).', hint: '파라미터 타입/범위를 확인하세요.', body: detail };
  }
  if (status === 429) {
    return { type: 'rate_limit', status, message: '요청이 너무 많습니다 (429).', hint: '잠시 후 재시도하세요.', body: detail };
  }
  if (status >= 500) {
    return { type: 'server', status, message: '서버 오류 (HTTP ' + status + ').', hint: '모델 서버 로그/자원(VRAM)을 확인하세요.', body: detail };
  }
  return { type: 'http', status, message: '요청 실패 (HTTP ' + status + ').', hint: '', body: detail };
}

/* ================================================================== */
/* 8. <think> 스플리터 (api.js 재사용, 없으면 로컬 폴백)               */
/* ================================================================== */
function localCreateThinkSplitter(emitReasoning, emitToken) {
  const OPEN = '<think>', CLOSE = '</think>';
  let inThink = false, carry = '';
  function emit(str) { if (!str) return; if (inThink) emitReasoning(str); else emitToken(str); }
  function process(flush) {
    while (true) {
      const tag = inThink ? CLOSE : OPEN;
      const idx = carry.indexOf(tag);
      if (idx !== -1) { emit(carry.slice(0, idx)); carry = carry.slice(idx + tag.length); inThink = !inThink; continue; }
      if (!flush) {
        let hold = 0; const maxLen = Math.min(tag.length - 1, carry.length);
        for (let k = maxLen; k > 0; k--) { if (carry.slice(carry.length - k) === tag.slice(0, k)) { hold = k; break; } }
        if (hold > 0) { emit(carry.slice(0, carry.length - hold)); carry = carry.slice(carry.length - hold); }
        else { emit(carry); carry = ''; }
      } else { emit(carry); carry = ''; }
      break;
    }
  }
  return { feed(t) { carry += t; process(false); }, end() { process(true); } };
}
function mkSplitter(emitReasoning, emitToken) {
  const fn = (typeof window !== 'undefined' && window.ChatAPI && window.ChatAPI._createThinkSplitter)
    ? window.ChatAPI._createThinkSplitter : localCreateThinkSplitter;
  return fn(emitReasoning, emitToken);
}

/* ================================================================== */
/* 9. 공용 실행 커널 — window.LLMLab.kernel.run(req)                    */
/* ================================================================== */
//
// req = {
//   op?, module?,                          // 로그 분류용 라벨(예: 'chat','rag','eval')
//   profile? | profileId? | connection?,   // 연결 결정(우선순위: profile > profileId > connection > active)
//   model?, params?,                       // 오버라이드
//   endpoint?='chat', messages? | prompt?,
//   stream?, useProxy?, extraHeaders?, reasoningEnabled?,
//   captureRaw?=true,                      // 인스펙터 원시 SSE 보존
//   onRequest(requestMeta), onToken(delta), onReasoning(delta),
//   onToolCall(toolCallsSnapshot), onDone(RunResult), onError(errorObj), signal
// }
//
// → Promise<RunResult> (에러 시에도 resolve; onError xor onDone 규약)

function resolveProfile(req) {
  if (req.profile && isObj(req.profile) && req.profile.ep) return req.profile;      // 내부 Profile
  if (req.profile && isObj(req.profile)) return fromUserJSON(req.profile);          // 정본 JSON
  if (req.profileId) { const p = get(req.profileId); if (p) return p; }
  if (isObj(req.connection)) return adHocProfile(req.connection);                   // ChatAPI 호환 경로
  return getActive() || fromUserJSON(BLANK_USER, { id: 'blank' });
}

// ChatAPI/설정 오버라이드 → 임시 Profile
function adHocProfile(conn) {
  const baseURL = conn.baseURL || '';
  const u = {
    service: conn.label || 'ad-hoc',
    base_url: baseURL,
    model: conn.model || '',
    auth: conn.auth || { type: 'bearer', api_key: conn.apiKey || '' },
    endpoints: conn.endpoints,
    params: conn.params || {},
  };
  return fromUserJSON(u, { id: 'adhoc' });
}

async function run(req) {
  req = req || {};
  const profile = resolveProfile(req);
  const useProxy = req.useProxy != null ? req.useProxy : defaultUseProxy();
  const endpoint = req.endpoint || 'chat';
  const model = req.model || profile.model || '';
  const params = mergeParams(profile, req.params);
  const stream = req.stream != null ? req.stream : (params.stream !== false);
  const captureRaw = req.captureRaw !== false;

  const _onReq = typeof req.onRequest === 'function' ? req.onRequest : () => {};
  const _onToken = typeof req.onToken === 'function' ? req.onToken : () => {};
  const _onReasoning = typeof req.onReasoning === 'function' ? req.onReasoning : () => {};
  const _onToolCall = typeof req.onToolCall === 'function' ? req.onToolCall : () => {};
  const _onDone = typeof req.onDone === 'function' ? req.onDone : () => {};
  const _onError = typeof req.onError === 'function' ? req.onError : () => {};

  const target = buildTargetURL(profile, endpoint);
  const built = buildHeaders(profile, { extraHeaders: req.extraHeaders });
  const body = buildBody(profile, {
    messages: req.messages, prompt: req.prompt, model, params, stream, endpoint,
    reasoningEnabled: req.reasoningEnabled,
  });
  const bodyText = JSON.stringify(body);

  const requestMeta = {
    url: target, method: 'POST', endpoint,
    headers: built.masked,           // 인스펙터: 마스킹 헤더
    body,                            // 조립된 객체
    bodyText,                        // 원시 문자열
    provider: 'server', useProxy,
    profileId: profile.id, profileLabel: profile.label, model,
  };
  _onReq(requestMeta);
  emit('run:start', { module: req.module || req.op || 'chat', requestMeta });

  // 누적 상태
  let fullContent = '', fullReasoning = '';
  let usage = null, finishReason = null;
  const toolCalls = [];           // 누적 tool_calls (index별)
  const rawChunks = [];           // 인스펙터 원시 SSE
  let rawBytes = 0;
  let tSend = 0, tFirst = 0, tDone = 0;

  const pickUsage = (u) => {
    if (!isObj(u)) return;
    usage = {
      prompt_tokens: Number(u.prompt_tokens) || 0,
      completion_tokens: Number(u.completion_tokens) || 0,
      total_tokens: Number(u.total_tokens) || ((Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0)),
    };
  };
  const markFirst = () => { if (!tFirst) tFirst = perfNow(); };
  const emitToken = (d) => { if (!d) return; markFirst(); fullContent += d; _onToken(d); };
  const emitReasoning = (d) => { if (!d) return; markFirst(); fullReasoning += d; _onReasoning(d); };
  const splitter = mkSplitter(emitReasoning, emitToken);

  const accumulateToolCalls = (tcs) => {
    if (!Array.isArray(tcs)) return;
    markFirst();
    tcs.forEach((tc) => {
      const i = tc.index != null ? tc.index : toolCalls.length;
      if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
      const slot = toolCalls[i];
      if (tc.id) slot.id = tc.id;
      if (tc.type) slot.type = tc.type;
      if (tc.function) {
        if (tc.function.name) slot.function.name = tc.function.name;
        if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
      }
    });
    _onToolCall(toolCalls.slice());
  };

  // 취소/타임아웃 통합
  const ctl = new AbortController();
  let timedOut = false, aborted = false;
  const onExtAbort = () => { aborted = true; ctl.abort(); };
  if (req.signal) { if (req.signal.aborted) { aborted = true; ctl.abort(); } else req.signal.addEventListener('abort', onExtAbort); }
  let timer = null;
  const timeoutMs = Number(params.timeout_ms) || 0;
  if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const cleanup = () => { if (timer) clearTimeout(timer); if (req.signal) req.signal.removeEventListener('abort', onExtAbort); };

  // RunResult 조립기
  const buildResult = (extra) => {
    tDone = tDone || perfNow();
    const totalMs = tSend ? (tDone - tSend) : null;
    const ttftMs = (tSend && tFirst) ? (tFirst - tSend) : null;
    let tokPerSec = null, approx = false;
    const genSec = (tFirst && tDone) ? (tDone - tFirst) / 1000 : 0;
    if (usage && usage.completion_tokens && genSec > 0) {
      tokPerSec = usage.completion_tokens / genSec;
    } else if (fullContent && genSec > 0) {
      tokPerSec = (fullContent.length / 4) / genSec; approx = true; // 근사 토큰(문자/4)
    }
    const result = {
      ok: !extra.error,
      provider: 'server',
      content: fullContent,
      reasoning: fullReasoning,
      toolCalls: toolCalls.filter(Boolean),
      finishReason,
      usage,
      timing: {
        ttftMs: ttftMs != null ? Math.round(ttftMs) : null,
        tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 100) / 100 : null,
        totalMs: totalMs != null ? Math.round(totalMs) : null,
        tokPerSecApprox: approx,
      },
      request: requestMeta,
      response: {
        status: extra.status != null ? extra.status : null,
        statusText: extra.statusText || '',
        headers: extra.headers || {},
        viaProxy: !!extra.viaProxy,
        rawChunks: captureRaw ? rawChunks : undefined,
        stream,
      },
      error: extra.error || null,
      aborted, timedOut,
      module: req.module || req.op || 'chat',
      profileId: profile.id, profileLabel: profile.label, model,
      ts: Date.now(),
    };
    return result;
  };

  const finishError = (errObj, httpMeta) => {
    cleanup();
    const result = buildResult({ error: errObj, ...(httpMeta || {}) });
    logRun(result);
    emit('run:error', result);
    _onError(errObj);
    return result;
  };
  const finishDone = (httpMeta) => {
    cleanup();
    const result = buildResult(httpMeta || {});
    logRun(result);
    emit('run:done', result);
    _onDone(result);
    return result;
  };

  try {
    tSend = perfNow();
    let relay;
    try {
      relay = await relayFetch(target, { method: 'POST', headers: built.headers, bodyText, useProxy, signal: ctl.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return finishError(timedOut
          ? { type: 'timeout', message: '응답 시간이 초과되었습니다.', hint: 'timeout_ms를 늘리거나 서버 상태를 확인하세요.' }
          : { type: 'abort', message: '요청이 중단되었습니다.' });
      }
      return finishError({
        type: 'network',
        message: useProxy ? '프록시(/api/proxy)에 연결할 수 없습니다.' : '서버에 연결할 수 없습니다(네트워크/CORS).',
        hint: useProxy ? 'server.py 실행 여부를 확인하세요.' : 'useProxy 활성화 또는 baseURL/CORS를 확인하세요.',
      });
    }

    const { res, status, statusText, headers, viaProxy, proxyError } = relay;
    const httpMeta = { status, statusText, headers, viaProxy };

    if (proxyError || status < 200 || status >= 300) {
      let bodyTextResp = '';
      try { bodyTextResp = await res.text(); } catch { /* */ }
      return finishError(classifyHTTP(status, bodyTextResp, proxyError), httpMeta);
    }

    // ── 논스트리밍 ──
    if (!stream) {
      let data = null, txt = '';
      try { txt = await res.text(); data = JSON.parse(txt); }
      catch { return finishError({ type: 'parse', message: '응답 JSON 파싱 실패.', body: txt.slice(0, 400) }, httpMeta); }
      if (captureRaw && txt) { rawChunks.push(txt.slice(0, RAW_BYTES_MAX)); }
      const choice = data && data.choices && data.choices[0];
      const msg = choice && choice.message;
      if (msg) {
        if (msg.reasoning_content) emitReasoning(msg.reasoning_content);
        if (msg.content) splitter.feed(msg.content);
        if (msg.tool_calls) accumulateToolCalls(msg.tool_calls);
      }
      splitter.end();
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      if (data && data.usage) pickUsage(data.usage);
      tDone = perfNow();
      return finishDone(httpMeta);
    }

    // ── 스트리밍(SSE) ──
    if (!res.body || typeof res.body.getReader !== 'function') {
      return finishError({ type: 'network', message: '스트리밍 응답을 읽을 수 없습니다.', hint: '프록시/서버 설정을 확인하세요.' }, httpMeta);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') {
          splitter.end();
          tDone = perfNow();
          return finishDone(httpMeta);
        }
        if (captureRaw && rawChunks.length < RAW_CHUNK_MAX && rawBytes < RAW_BYTES_MAX) {
          rawChunks.push(dataStr); rawBytes += dataStr.length;
        }
        let json;
        try { json = JSON.parse(dataStr); } catch { continue; }
        if (json.usage) pickUsage(json.usage);
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.reasoning_content) emitReasoning(delta.reasoning_content);
        if (delta.content) splitter.feed(delta.content);
        if (delta.tool_calls) accumulateToolCalls(delta.tool_calls);
      }
    }
    // [DONE] 없이 종료
    splitter.end();
    tDone = perfNow();
    return finishDone(httpMeta);

  } catch (err) {
    if (err && err.name === 'AbortError') {
      return finishError(timedOut
        ? { type: 'timeout', message: '응답 시간이 초과되었습니다.' }
        : { type: 'abort', message: '요청이 중단되었습니다.' });
    }
    return finishError({ type: 'network', message: '응답 처리 중 오류: ' + (err && err.message ? err.message : err) });
  }
}

/* ================================================================== */
/* 10. 헬스체크 · 모델 목록 · 서버 진단 (§3.8)                          */
/* ================================================================== */

function _profArg(profileOrId) {
  if (isObj(profileOrId) && profileOrId.ep) return profileOrId;
  if (isObj(profileOrId)) return fromUserJSON(profileOrId);
  if (typeof profileOrId === 'string') return get(profileOrId);
  return getActive();
}

// GET {endpoints.models} → { ok, status, latencyMs, models[], error, provider }
async function healthCheck(profileOrId, opts) {
  opts = opts || {};
  const profile = _profArg(profileOrId);
  if (!profile) return { ok: false, status: 0, latencyMs: null, models: [], error: '프로필을 찾을 수 없습니다.', provider: 'server' };
  const useProxy = opts.useProxy != null ? opts.useProxy : defaultUseProxy();
  const target = buildTargetURL(profile, 'models');
  const built = buildHeaders(profile, { extraHeaders: opts.extraHeaders });
  const t0 = perfNow();
  let relay;
  try {
    relay = await relayFetch(target, { method: 'GET', headers: built.headers, useProxy, signal: opts.signal });
  } catch (err) {
    const latencyMs = Math.round(perfNow() - t0);
    if (err && err.name === 'AbortError') return { ok: false, status: 0, latencyMs, models: [], error: '중단됨', provider: 'server' };
    return { ok: false, status: 0, latencyMs, models: [], error: useProxy ? '프록시 연결 실패(server.py 확인)' : '네트워크/CORS 오류', provider: 'server' };
  }
  const latencyMs = Math.round(perfNow() - t0);
  const { res, status, proxyError } = relay;
  if (proxyError || status < 200 || status >= 300) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* */ }
    const cls = classifyHTTP(status, bodyText, proxyError);
    // 상태 램프 매핑 힌트 포함
    return { ok: false, status, latencyMs, models: [], error: cls.message + (cls.hint ? ' — ' + cls.hint : ''), errorType: cls.type, provider: 'server' };
  }
  let models = [];
  try {
    const data = await res.json();
    if (data && Array.isArray(data.data)) models = data.data.map((m) => (m && m.id) ? m.id : m).filter(Boolean);
    else if (Array.isArray(data)) models = data.map((m) => (m && m.id) ? m.id : m).filter(Boolean);
  } catch { /* */ }
  // 프로필 상태 갱신(런타임)
  if (profile.status) { profile.status = { state: 'ok', latencyMs, models, checkedAt: Date.now(), error: null }; }
  return { ok: true, status, latencyMs, models, error: null, provider: 'server' };
}

function listModels(profileOrId, opts) { return healthCheck(profileOrId, opts); }

// 원클릭 서버 진단 (§3.8) — models → 짧은 chat 1회, 단계별 리포트
async function diagnose(profileOrId, opts) {
  opts = opts || {};
  const profile = _profArg(profileOrId);
  const steps = [];
  if (!profile) return { ok: false, steps: [{ name: 'profile', ok: false, error: '프로필 없음' }] };

  // 1) models
  const h = await healthCheck(profile, opts);
  steps.push({ name: 'models', ok: h.ok, status: h.status, ms: h.latencyMs, summary: h.ok ? (h.models.length + '개 모델') : h.error, models: h.models });

  // 2) 짧은 chat 1회
  let chatOk = false, chatMs = null, chatErr = null;
  await run({
    profile, module: 'diagnose', stream: false, useProxy: opts.useProxy,
    messages: [{ role: 'user', content: 'ping' }],
    params: { max_tokens: 1, temperature: 0, stream: false },
    onDone: (r) => { chatOk = r.ok; chatMs = r.timing.totalMs; },
    onError: (e) => { chatErr = e.message; },
    signal: opts.signal,
  });
  steps.push({ name: 'chat', ok: chatOk, ms: chatMs, summary: chatOk ? '응답 정상' : chatErr });

  return { ok: steps.every((s) => s.ok), steps, profileId: profile.id };
}

/* ================================================================== */
/* 11. View code 생성기 (curl · python · fetch) — §4.6                 */
/* ================================================================== */

function _resolveForView(req) {
  const profile = resolveProfile(req || {});
  const endpoint = (req && req.endpoint) || 'chat';
  const model = (req && req.model) || profile.model || '';
  const params = mergeParams(profile, req && req.params);
  const stream = (req && req.stream != null) ? req.stream : (params.stream !== false);
  const built = buildHeaders(profile, { extraHeaders: req && req.extraHeaders });
  const body = buildBody(profile, {
    messages: req && req.messages, prompt: req && req.prompt, model, params, stream, endpoint,
    reasoningEnabled: req && req.reasoningEnabled,
  });
  const url = buildTargetURL(profile, endpoint);
  return { profile, url, headers: built.headers, body, params, stream };
}

function viewCurl(req) {
  const r = _resolveForView(req);
  const lines = ['curl ' + shq(r.url) + ' \\'];
  Object.keys(r.headers).forEach((k) => { lines.push('  -H ' + shq(k + ': ' + r.headers[k]) + ' \\'); });
  lines.push('  -d ' + shq(JSON.stringify(r.body)));
  return lines.join('\n');
}
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function viewPython(req) {
  const r = _resolveForView(req);
  const auth = r.profile.auth;
  const key = auth.scheme === 'none' ? 'EMPTY' : (auth.key || '');
  // extra_body 분리, 표준은 kwargs
  const body = clone(r.body);
  const messages = body.messages; delete body.messages;
  const model = body.model; delete body.model; delete body.stream;
  const eb = {};
  const KNOWN = new Set(STD_PARAM_KEYS.concat(['response_format', 'stream_options']));
  Object.keys(body).forEach((k) => { if (!KNOWN.has(k)) { eb[k] = body[k]; delete body[k]; } });
  const kwargs = Object.keys(body).map((k) => k + '=' + pyVal(body[k]));
  const lines = [
    'from openai import OpenAI',
    'client = OpenAI(base_url=' + pyStr(r.profile.baseURL) + ', api_key=' + pyStr(key) + ')',
    'resp = client.chat.completions.create(',
    '    model=' + pyStr(model) + ',',
    '    messages=' + pyVal(messages) + ',',
  ];
  kwargs.forEach((kw) => lines.push('    ' + kw + ','));
  if (r.stream) lines.push('    stream=True,');
  if (Object.keys(eb).length) lines.push('    extra_body=' + pyVal(eb) + ',');
  lines.push(')');
  lines.push(r.stream
    ? "for chunk in resp:\n    print(chunk.choices[0].delta.content or '', end='')"
    : 'print(resp.choices[0].message.content)');
  return lines.join('\n');
}
function pyStr(s) { return JSON.stringify(String(s == null ? '' : s)); }
function pyVal(v) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number' || typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v); // dict/list — JSON 표기(파이썬 호환)
}

function viewFetch(req) {
  const r = _resolveForView(req);
  return [
    "const res = await fetch(" + JSON.stringify(r.url) + ", {",
    "  method: 'POST',",
    '  headers: ' + JSON.stringify(r.headers, null, 2).replace(/\n/g, '\n  ') + ',',
    '  body: JSON.stringify(' + JSON.stringify(r.body, null, 2).replace(/\n/g, '\n  ') + '),',
    '});',
    r.stream
      ? "const reader = res.body.getReader();\nconst decoder = new TextDecoder();\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  console.log(decoder.decode(value));\n}"
      : 'const data = await res.json();\nconsole.log(data.choices[0].message.content);',
  ].join('\n');
}

function viewAll(req) { return { curl: viewCurl(req), python: viewPython(req), fetch: viewFetch(req) }; }

/* ================================================================== */
/* 12. 실행 로그 — IndexedDB 링버퍼(§4.3), 폴백 in-memory              */
/* ================================================================== */

const IDB_NAME = 'llmlab';
const IDB_STORE = 'runlog';
let _idb = null, _idbTried = false;
let _memLog = [];        // 폴백/캐시
let _lastEntry = null;

function openIDB() {
  return new Promise((resolve) => {
    if (_idbTried) return resolve(_idb);
    _idbTried = true;
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      rq.onsuccess = () => { _idb = rq.result; resolve(_idb); };
      rq.onerror = () => { console.warn('[llmlab] IndexedDB 사용 불가 — in-memory 로그 사용'); resolve(null); };
    } catch (e) { resolve(null); }
  });
}

// RunResult → 로그 엔트리(경량화; 원시 SSE는 저장 제외로 용량 절약)
function toLogEntry(r) {
  return {
    ts: r.ts || Date.now(),
    module: r.module,
    profileId: r.profileId, profileLabel: r.profileLabel, model: r.model,
    provider: r.provider,
    ok: r.ok,
    status: r.response ? r.response.status : null,
    finishReason: r.finishReason,
    timing: r.timing,
    usage: r.usage,
    requestBody: r.request ? r.request.body : null,
    responseMeta: r.response ? { status: r.response.status, headers: r.response.headers, viaProxy: r.response.viaProxy } : null,
    contentPreview: (r.content || '').slice(0, 500),
    error: r.error ? { type: r.error.type, message: r.error.message, status: r.error.status } : null,
  };
}

async function logRun(runResult) {
  const entry = toLogEntry(runResult);
  _lastEntry = entry;
  const db = await openIDB();
  if (!db) {
    _memLog.push(entry);
    if (_memLog.length > RUNLOG_MAX) _memLog = _memLog.slice(-RUNLOG_MAX);
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const addRq = store.add(entry);
      addRq.onsuccess = () => {
        // 링버퍼 트림
        const countRq = store.count();
        countRq.onsuccess = () => {
          const over = countRq.result - RUNLOG_MAX;
          if (over > 0) {
            let removed = 0;
            const cur = store.openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (c && removed < over) { store.delete(c.primaryKey); removed++; c.continue(); }
            };
          }
        };
        resolve(addRq.result);
      };
      addRq.onerror = () => resolve(null);
    } catch (e) { _memLog.push(entry); resolve(null); }
  });
}

async function logList(opts) {
  opts = opts || {};
  const limit = opts.limit || RUNLOG_MAX;
  const db = await openIDB();
  if (!db) return _memLog.slice(-limit).reverse();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const out = [];
      const cur = store.openCursor(null, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (c && out.length < limit) { out.push({ id: c.primaryKey, ...c.value }); c.continue(); }
        else resolve(out);
      };
      cur.onerror = () => resolve([]);
    } catch (e) { resolve(_memLog.slice(-limit).reverse()); }
  });
}

async function logGet(id) {
  const db = await openIDB();
  if (!db) return _memLog.find((e, i) => i === id) || null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(id);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function logClear() {
  _memLog = []; _lastEntry = null;
  const db = await openIDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

async function logExportJSON() {
  const list = await logList({ limit: RUNLOG_MAX });
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, type: 'llm-lab-runlog', exportedAt: nowISO(), entries: list }, null, 2);
}
async function logExportCSV() {
  const list = await logList({ limit: RUNLOG_MAX });
  const cols = ['ts', 'module', 'profileLabel', 'model', 'provider', 'ok', 'status', 'finishReason', 'ttftMs', 'tokPerSec', 'totalMs', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'error'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [cols.join(',')];
  list.forEach((e) => {
    const t = e.timing || {}, u = e.usage || {};
    rows.push([
      new Date(e.ts).toISOString(), e.module, e.profileLabel, e.model, e.provider, e.ok, e.status, e.finishReason,
      t.ttftMs, t.tokPerSec, t.totalMs, u.prompt_tokens, u.completion_tokens, u.total_tokens,
      e.error ? e.error.message : '',
    ].map(esc).join(','));
  });
  return rows.join('\n');
}

/* ================================================================== */
/* 13. 초기화 · 노출                                                    */
/* ================================================================== */

loadProfiles();

// DEFAULT: 활성/시드 프로필 기반 (ChatAPI 호환 · 폼 기본값)
function buildDEFAULT() {
  const p = getActive() || fromUserJSON(BLANK_USER, { id: 'blank' });
  return {
    baseURL: p.baseURL,
    model: p.model,
    apiKey: p.auth.key,
    temperature: p.params.temperature,
    max_tokens: p.params.max_tokens,
    top_p: p.params.top_p,
    timeout: p.params.timeout_ms,
  };
}

const LLMLab = {
  version: APP_VERSION,
  schemaVersion: SCHEMA_VERSION,
  DEFAULT_PARAMS: clone(DEFAULT_PARAMS),
  get DEFAULT() { return buildDEFAULT(); },

  profiles: {
    list, get, getActive, getActiveId, setActive,
    add, update, remove, duplicate,
    save: saveProfiles, seedIfEmpty,
    parse, validate,
    import: importProfiles, importProfiles,
    exportOne, exportAll,
    toUserJSON, fromUserJSON,
    uniqueLabel,
  },

  kernel: { run, buildBody, buildHeaders, buildTargetURL, mergeParams, resolveProfile, adHocProfile },

  healthCheck, listModels, diagnose,

  viewCode: { curl: viewCurl, python: viewPython, fetch: viewFetch, all: viewAll },

  runLog: {
    add: logRun, list: logList, get: logGet, clear: logClear,
    exportJSON: logExportJSON, exportCSV: logExportCSV,
    getLast: () => _lastEntry,
  },

  // 프록시 경로 설정
  get proxyPath() { return PROXY_PATH; },
  setProxyPath(p) { PROXY_PATH = p || '/api/proxy'; },

  // 저수준 유틸(재사용)
  util: { maskKey, deriveEndpoints, deriveHostPort, relayFetch, classifyHTTP, mergeParams },

  on, off,
};

if (typeof window !== 'undefined') {
  window.LLMLab = Object.assign(window.LLMLab || {}, LLMLab);
}

})();
