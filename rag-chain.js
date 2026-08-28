/* ==========================================================================
   rag-chain.js — LLM Lab v24 · 단계 2 능력 어댑터 (RAG Lab · Chain/Workflow)
   ──────────────────────────────────────────────────────────────────────────
   엔진(llmlab.js/api.js/server.py)은 수정하지 않고 소비만 한다. 이 파일은
   window.LLMLab.rag / window.LLMLab.chain 네임스페이스를 "추가"로 노출한다.
   비 ES모듈(IIFE) — file:// 에서도 동작. 하드코딩 색 없음(순수 로직).

   구현 계약(03_design_spec §8 / 02_research §8):
     8.1 Retriever  {op:'retrieve', query, mode, params, ...} → {results,stages,lists,provider}
     8.2 Embedder   {op:'embed', input[]} → {vectors, dim, provider:'server|browser|approx'}
     8.3 Chunker    {op:'chunk', text, method, size, overlap} → {chunks[]}
     8.4 Graph      {nodes,edges,communities} (graph-view.js가 소비)
     8.5 Chain      {id,name,nodes:[{type,prompt?,expr?,then?,else?,params?}]}
   모든 능력 응답에 provider 필드 → UI 배지.
   ========================================================================== */
(function () {
'use strict';

var L = window.LLMLab;
if (!L) { console.error('[rag-chain] window.LLMLab 미로드 — 어댑터를 붙일 수 없습니다.'); return; }

/* ============================================================
   0. 유틸
   ============================================================ */
function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
function uid(p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 8); }

// 한국어/영문 토크나이저 근사: 유니코드 단어 조각 + 소문자
function tokenize(text) {
  var s = String(text || '').toLowerCase();
  var m = s.match(/[a-z0-9]+|[가-힣]+/g) || [];
  var out = [];
  m.forEach(function (tok) {
    if (/^[가-힣]+$/.test(tok) && tok.length > 2) {
      // 한글 어절은 2-gram으로도 분해(부분일치 강화)
      out.push(tok);
      for (var i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
    } else {
      out.push(tok);
    }
  });
  return out;
}

/* ============================================================
   1. Chunker (§8.3) — fixed / sentence / recursive  [browser · 실동작]
   ============================================================ */
function chunkText(text, method, size, overlap) {
  text = String(text == null ? '' : text);
  size = Math.max(20, Number(size) || 512);
  overlap = Math.max(0, Math.min(size - 1, Number(overlap) || 0));
  var out = [];
  var push = function (t, start) {
    var trimmed = t.replace(/^\s+|\s+$/g, '');
    if (trimmed) out.push({ text: t, start: start, end: start + t.length });
  };

  if (method === 'sentence') {
    // 문장 경계(., !, ?, 。, 줄바꿈)로 분할 후 size까지 병합
    var re = /[^.!?。\n]+[.!?。]?\s*|\n+/g, mm, buf = '', bufStart = 0, idx = 0;
    var sents = [];
    while ((mm = re.exec(text)) !== null) { sents.push({ t: mm[0], at: mm.index }); }
    sents.forEach(function (s) {
      if (!buf) bufStart = s.at;
      if ((buf + s.t).length > size && buf) { push(buf, bufStart); buf = s.t; bufStart = s.at; }
      else buf += s.t;
    });
    if (buf) push(buf, bufStart);
    void idx;
  } else if (method === 'recursive') {
    // 재귀 분할: 문단 → 문장 → 고정. 큰 블록만 더 잘게.
    var blocks = [], pos = 0;
    text.split(/\n{2,}/).forEach(function (para) {
      var start = text.indexOf(para, pos); if (start < 0) start = pos; pos = start + para.length;
      if (para.length <= size) { blocks.push({ t: para, at: start }); }
      else {
        // 문장 단위로 재분할
        var inner = para.match(/[^.!?。\n]+[.!?。]?\s*/g) || [para];
        var b = '', bStart = start, off = start;
        inner.forEach(function (sn) {
          if ((b + sn).length > size && b) { blocks.push({ t: b, at: bStart }); b = sn; bStart = off; }
          else b += sn;
          off += sn.length;
        });
        if (b) blocks.push({ t: b, at: bStart });
      }
    });
    blocks.forEach(function (b) {
      if (b.t.length <= size) push(b.t, b.at);
      else { for (var i = 0; i < b.t.length; i += (size - overlap)) push(b.t.slice(i, i + size), b.at + i); }
    });
  } else {
    // fixed: 문자 고정 길이 + overlap
    for (var i = 0; i < text.length; i += (size - overlap)) {
      push(text.slice(i, i + size), i);
      if (i + size >= text.length) break;
    }
    if (!out.length && text) push(text, 0);
  }
  return out;
}

// docs: [{id,title,text}] | {text} | string
function chunk(opts) {
  opts = opts || {};
  var t0 = now();
  var method = opts.method || 'recursive';
  var size = opts.size, overlap = opts.overlap;
  var docs = opts.docs;
  if (!docs) docs = [{ id: 'doc1', title: opts.title || 'doc', text: opts.text || '' }];
  if (typeof docs === 'string') docs = [{ id: 'doc1', title: 'doc', text: docs }];
  var chunks = [];
  docs.forEach(function (d, di) {
    var docId = d.id || ('doc' + (di + 1));
    var title = d.title || docId;
    var pieces = chunkText(d.text || '', method, size, overlap);
    pieces.forEach(function (p, pi) {
      chunks.push({
        id: uid('c'), docId: docId, docTitle: title, idx: pi,
        text: p.text, start: p.start, end: p.end,
        loc: 'L' + p.start + '-' + p.end,
      });
    });
  });
  return { op: 'chunk', chunks: chunks, count: chunks.length, method: method, provider: 'browser', ms: Math.round(now() - t0) };
}

/* ============================================================
   2. Embedder (§8.2) — server(/v1/embeddings) → approx 폴백
   ============================================================ */
// 키워드 해시 근사 임베딩(approx): 토큰 → 고정차원 해시 버킷 tf 벡터(정규화)
function approxEmbed(text, dim) {
  dim = dim || 256;
  var v = new Array(dim).fill(0);
  var toks = tokenize(text);
  toks.forEach(function (tok) {
    var h = 2166136261;
    for (var i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = (h * 16777619) >>> 0; }
    v[h % dim] += 1;
  });
  // L2 정규화
  var norm = Math.sqrt(v.reduce(function (a, x) { return a + x * x; }, 0)) || 1;
  for (var j = 0; j < dim; j++) v[j] /= norm;
  return v;
}

async function serverEmbed(inputs, profile, useProxy, signal) {
  var util = L.util;
  if (!profile || !profile.ep || !profile.ep.embeddings) return null;
  var target = profile.ep.embeddings;
  var built = L.kernel.buildHeaders(profile, {});
  var bodyText = JSON.stringify({ model: (profile.params && profile.params.embedding_model) || 'text-embedding', input: inputs });
  var up = (useProxy != null) ? useProxy : (typeof location !== 'undefined' && location.protocol !== 'file:');
  var relay;
  try {
    relay = await util.relayFetch(target, { method: 'POST', headers: built.headers, bodyText: bodyText, useProxy: up, signal: signal });
  } catch (e) { return null; }
  var st = relay.status;
  if (relay.proxyError || st < 200 || st >= 300) return null;
  var data;
  try { data = await relay.res.json(); } catch (e) { return null; }
  if (!data || !Array.isArray(data.data)) return null;
  var vecs = data.data.map(function (d) { return d && d.embedding; }).filter(Boolean);
  if (vecs.length !== inputs.length) return null;
  return { vectors: vecs, dim: vecs[0] ? vecs[0].length : 0 };
}

// {input:[..], profile, useProxy, signal, dim?} → {vectors, dim, provider}
async function embed(opts) {
  opts = opts || {};
  var t0 = now();
  var inputs = Array.isArray(opts.input) ? opts.input : (opts.chunks ? opts.chunks.map(function (c) { return c.text; }) : []);
  if (!inputs.length) return { op: 'embed', vectors: [], dim: 0, provider: 'approx', ms: 0 };

  // 경로1: 서버 /v1/embeddings
  if (opts.allowServer !== false) {
    var s = null;
    try { s = await serverEmbed(inputs, opts.profile, opts.useProxy, opts.signal); } catch (e) { s = null; }
    if (s && s.vectors && s.vectors.length) {
      return { op: 'embed', vectors: s.vectors, dim: s.dim, provider: 'server', ms: Math.round(now() - t0) };
    }
  }
  // 경로3: 키워드 근사(approx) — transformers.js(브라우저)는 오프라인/CSP 고려로 기본 미탑재
  var dim = opts.dim || 256;
  var vectors = inputs.map(function (t) { return approxEmbed(t, dim); });
  return { op: 'embed', vectors: vectors, dim: dim, provider: 'approx', ms: Math.round(now() - t0) };
}

/* ============================================================
   3. 검색 프리미티브 — BM25 · 코사인 · RRF  [browser · 실동작]
   ============================================================ */
function cosine(a, b) {
  if (!a || !b) return 0;
  var n = Math.min(a.length, b.length), dot = 0, na = 0, nb = 0;
  for (var i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  var d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
// 벡터 배열의 성분별 평균(쿼리 벡터 합성)
function meanVec(vecs, dim) {
  var d = dim || (vecs[0] ? vecs[0].length : 0);
  var out = new Array(d).fill(0);
  (vecs || []).forEach(function (v) { for (var i = 0; i < d; i++) out[i] += (v[i] || 0); });
  var n = (vecs && vecs.length) || 1;
  for (var j = 0; j < d; j++) out[j] /= n;
  return out;
}

// BM25 인덱스 구축
function buildBM25(chunks) {
  var N = chunks.length;
  var df = Object.create(null);
  var docTokens = chunks.map(function (c) {
    var toks = tokenize(c.text);
    var tf = Object.create(null), seen = Object.create(null);
    toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    Object.keys(tf).forEach(function (t) { if (!seen[t]) { df[t] = (df[t] || 0) + 1; seen[t] = 1; } });
    return { tf: tf, len: toks.length };
  });
  var avgdl = docTokens.reduce(function (a, d) { return a + d.len; }, 0) / (N || 1);
  return { N: N, df: df, docTokens: docTokens, avgdl: avgdl };
}
function bm25Scores(idx, query, k1, b) {
  k1 = k1 == null ? 1.5 : k1; b = b == null ? 0.75 : b;
  var qToks = tokenize(query);
  var scores = new Array(idx.N).fill(0);
  var uniq = {}; qToks.forEach(function (t) { uniq[t] = 1; });
  Object.keys(uniq).forEach(function (t) {
    var n = idx.df[t] || 0; if (!n) return;
    var idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
    for (var i = 0; i < idx.N; i++) {
      var d = idx.docTokens[i]; var f = d.tf[t] || 0; if (!f) continue;
      var denom = f + k1 * (1 - b + b * (d.len / (idx.avgdl || 1)));
      scores[i] += idf * (f * (k1 + 1)) / denom;
    }
  });
  return scores;
}
// 점수 배열 → 순위 목록 [{chunkId, i, score, rank}]
function toRanked(chunks, scores) {
  var arr = chunks.map(function (c, i) { return { chunkId: c.id, i: i, score: scores[i] || 0 }; });
  arr.sort(function (a, b) { return b.score - a.score; });
  arr.forEach(function (r, k) { r.rank = k + 1; });
  return arr;
}
// RRF 융합 — score = Σ weight/(k + rank)
function rrfFuse(lists, weights, k) {
  k = k || 60;
  var acc = Object.create(null);
  lists.forEach(function (list, li) {
    var w = (weights && weights[li] != null) ? weights[li] : 1;
    list.forEach(function (r) {
      acc[r.chunkId] = (acc[r.chunkId] || 0) + w * (1 / (k + r.rank));
    });
  });
  var fused = Object.keys(acc).map(function (id) { return { chunkId: id, score: acc[id] }; });
  fused.sort(function (a, b) { return b.score - a.score; });
  fused.forEach(function (r, i) { r.rank = i + 1; });
  return fused;
}

/* ============================================================
   4. 쿼리 변환(HyDE · Multi-Query) · LLM 재랭킹  [server · 실동작]
   ============================================================ */
function kernelText(req) {
  return new Promise(function (resolve) {
    var out = '';
    L.kernel.run(Object.assign({}, req, {
      stream: false,
      onToken: function (d) { out += d; },
      onDone: function (r) { resolve({ ok: true, text: (r.content || out || '').trim(), result: r }); },
      onError: function (e) { resolve({ ok: false, text: '', error: e }); },
    }));
  });
}

async function hydeDoc(query, ctx) {
  var r = await kernelText({
    module: 'rag', profile: ctx.profile, profileId: ctx.profileId, model: ctx.model,
    useProxy: ctx.useProxy, params: { max_tokens: 220, temperature: 0.3, stream: false },
    messages: [{ role: 'user', content: '다음 질문에 대한 가상의 이상적인 답변 문단을 1개만 작성하라(설명·머리말 없이 본문만).\n질문: ' + query }],
    signal: ctx.signal, reasoningEnabled: false,
  });
  return r.ok ? r.text : '';
}
async function multiQuery(query, ctx) {
  var r = await kernelText({
    module: 'rag', profile: ctx.profile, profileId: ctx.profileId, model: ctx.model,
    useProxy: ctx.useProxy, params: { max_tokens: 200, temperature: 0.5, stream: false },
    messages: [{ role: 'user', content: '아래 질문을 검색에 유리하도록 서로 다른 표현의 변형 질의 3개로만 다시 써라. 각 줄에 하나씩, 번호·설명 없이.\n질문: ' + query }],
    signal: ctx.signal, reasoningEnabled: false,
  });
  if (!r.ok) return [];
  return r.text.split('\n').map(function (s) { return s.replace(/^\s*[-*\d.)]+\s*/, '').trim(); }).filter(Boolean).slice(0, 4);
}
// LLM 재랭킹: 후보 청크를 배치로 0~10 채점(pointwise)
async function llmRerank(query, candidates, ctx) {
  if (!candidates.length) return null;
  var listing = candidates.map(function (c, i) { return '[' + i + '] ' + c.text.replace(/\s+/g, ' ').slice(0, 300); }).join('\n');
  var r = await kernelText({
    module: 'rag', profile: ctx.profile, profileId: ctx.profileId, model: ctx.model,
    useProxy: ctx.useProxy, params: { max_tokens: 300, temperature: 0, stream: false },
    messages: [{ role: 'user', content:
      '질문에 대한 각 청크의 관련도를 0~10 정수로 채점하라. JSON 배열만 출력: [{"i":0,"score":8}, ...]\n\n질문: ' + query + '\n\n청크:\n' + listing }],
    signal: ctx.signal, reasoningEnabled: false,
  });
  if (!r.ok) return null;
  var scores = null;
  try {
    var m = r.text.match(/\[[\s\S]*\]/); if (m) scores = JSON.parse(m[0]);
  } catch (e) { scores = null; }
  if (!Array.isArray(scores)) return null;
  var map = {}; scores.forEach(function (s) { if (s && s.i != null) map[s.i] = Number(s.score) || 0; });
  return map;
}

/* ============================================================
   5. Retriever (§8.1) — vector/bm25/hybrid, 쿼리변환·재랭킹 포함
   index: { chunks:[...], vectors:[[...]], dim, embedProvider }
   ============================================================ */
async function retrieve(opts) {
  opts = opts || {};
  var chunks = opts.chunks || (opts.index && opts.index.chunks) || [];
  var vectors = opts.vectors || (opts.index && opts.index.vectors) || null;
  var dim = opts.dim || (opts.index && opts.index.dim) || 256;
  var embedProvider = opts.embedProvider || (opts.index && opts.index.embedProvider) || 'approx';
  var mode = opts.mode || 'hybrid';
  var params = opts.params || {};
  var top_k = Math.max(1, Number(params.top_k) || 5);
  var threshold = Number(params.threshold) || 0;
  var hybrid = params.hybrid || {};
  var alpha = hybrid.alpha != null ? hybrid.alpha : 0.5;   // dense 가중
  var rrf_k = hybrid.rrf_k != null ? hybrid.rrf_k : 60;
  var ctx = { profile: opts.profile, profileId: opts.profileId, model: opts.model, useProxy: opts.useProxy, signal: opts.signal };
  var stages = [];
  var out = { op: 'retrieve', mode: mode, query: opts.query, provider: 'browser', embedProvider: embedProvider,
    transformedQueries: [], hydeDoc: null, lists: {}, results: [], stages: stages };

  // ── DB 라우팅 판정: 활성 백엔드가 pgvector면 Dense/Hybrid의 dense를 /api/db/vector/search로 ──
  var dbConn = (opts.dbConnId && L.db && typeof L.db.get === 'function') ? L.db.get(opts.dbConnId) : null;
  var pgActive = !!(dbConn && dbConn.type === 'pgvector' && (mode === 'vector' || mode === 'hybrid'));
  var serverChunks = {};   // 서버(pgvector) 결과 청크: chunkId -> {docTitle,loc,docId,text,denseScore}
  if (dbConn) { out.dbBackend = dbConn.type; out.dbConnLabel = dbConn.label; }

  // 로컬 코퍼스가 없어도 pgvector 백엔드면 서버 검색으로 진행 가능
  if (!chunks.length && !pgActive) { out.error = '코퍼스가 비어 있습니다. 먼저 인덱스를 구축하세요.'; return out; }

  // 브라우저 코사인 dense (강등/기본 경로 공용)
  async function browserDense() {
    var qInputs = queries.slice(); if (hydeText) qInputs.push(hydeText);
    var qe = await embed({ input: qInputs, profile: ctx.profile, useProxy: ctx.useProxy, signal: ctx.signal, dim: dim, allowServer: embedProvider === 'server' });
    var qv = meanVec(qe.vectors, qe.dim || dim);
    var dscores = chunks.map(function (c, i) { return (vectors && vectors[i]) ? cosine(qv, vectors[i]) : 0; });
    return { list: toRanked(chunks, dscores), provider: qe.provider };
  }

  // ── 쿼리 변환 ──
  var queries = [opts.query];
  var hydeText = null;
  if (params.hyde) {
    var ts = now();
    hydeText = await hydeDoc(opts.query, ctx);
    if (hydeText) { out.hydeDoc = hydeText; out.provider = 'server'; }
    stages.push({ name: 'hyde', ms: Math.round(now() - ts), count: hydeText ? 1 : 0, provider: 'server' });
  }
  if (params.multiQuery) {
    var tm = now();
    var mq = await multiQuery(opts.query, ctx);
    if (mq.length) { queries = queries.concat(mq); out.provider = 'server'; }
    out.transformedQueries = mq;
    stages.push({ name: 'multi_query', ms: Math.round(now() - tm), count: mq.length, provider: 'server' });
  }

  var wantDense = (mode === 'vector' || mode === 'hybrid');
  var wantSparse = (mode === 'bm25' || mode === 'hybrid');

  // ── BM25 ──
  var bm25List = [];
  if (wantSparse) {
    var tb = now();
    var idx = buildBM25(chunks);
    var acc = new Array(chunks.length).fill(0);
    queries.forEach(function (q) { var sc = bm25Scores(idx, q); for (var i = 0; i < sc.length; i++) acc[i] = Math.max(acc[i], sc[i]); });
    bm25List = toRanked(chunks, acc);
    out.lists.bm25 = bm25List.slice(0, 20);
    stages.push({ name: 'bm25', ms: Math.round(now() - tb), count: chunks.length, provider: 'browser' });
  }

  // ── Dense(코사인 · 브라우저 / pgvector · 서버) ──
  var denseList = [];
  if (wantDense) {
    var td = now();
    if (pgActive) {
      // 쿼리 임베딩(HyDE 포함) 생성 후 DB 벡터검색으로 dense 목록 획득
      var qInputs = queries.slice(); if (hydeText) qInputs.push(hydeText);
      var qeP = await embed({ input: qInputs, profile: ctx.profile, useProxy: ctx.useProxy, signal: ctx.signal, dim: (dbConn.vector && dbConn.vector.dim) || dim, allowServer: true });
      var qvP = meanVec(qeP.vectors, qeP.dim || dim);
      var vr = await L.db.vectorSearch({
        connId: dbConn.id, embedding: qvP, top_k: Math.max(top_k, 20),
        metric: (dbConn.vector && dbConn.vector.metric) || 'cosine',
        filter: params.filter || null, min_score: params.min_score || 0, signal: ctx.signal,
      });
      if (vr && vr.ok && vr.provider === 'server' && Array.isArray(vr.results) && vr.results.length) {
        denseList = vr.results.map(function (r, i) {
          var sc = (r.score != null) ? r.score : ((r.signals && r.signals.dense) || 0);
          return { chunkId: r.chunkId, i: -1, score: sc, rank: i + 1 };
        });
        vr.results.forEach(function (r) {
          serverChunks[r.chunkId] = {
            docTitle: (r.source && r.source.title) || r.docId, loc: (r.source && r.source.loc) || '',
            docId: r.docId, text: r.text,
            denseScore: (r.signals && r.signals.dense != null) ? r.signals.dense : r.score,
          };
        });
        out.lists.dense = denseList.slice(0, 20);
        out.embedProvider = qeP.provider; out.provider = 'server'; out.dbProvider = 'server';
        stages.push({ name: 'dense(pgvector·server)', ms: Math.round(now() - td), count: denseList.length, provider: 'server' });
      } else {
        // 강등 → 브라우저 코사인
        pgActive = false; out.dbProvider = 'mock';
        var dnote = (vr && vr.unreachable) ? 'DB 백엔드 미도달 — 브라우저 강등' : (vr && vr.error ? ('강등: ' + vr.error) : '브라우저 강등');
        var bdF = await browserDense();
        denseList = bdF.list; out.lists.dense = denseList.slice(0, 20); out.embedProvider = bdF.provider;
        stages.push({ name: 'dense(browser·강등)', ms: Math.round(now() - td), count: chunks.length, provider: bdF.provider, note: dnote });
      }
    } else {
      var bd = await browserDense();
      denseList = bd.list; out.lists.dense = denseList.slice(0, 20); out.embedProvider = bd.provider;
      stages.push({ name: 'dense(' + bd.provider + ')', ms: Math.round(now() - td), count: chunks.length, provider: bd.provider });
    }
  }

  // ── 융합 ──
  var finalRanked;
  if (mode === 'hybrid') {
    var tf = now();
    // alpha: dense 가중, (1-alpha): bm25 가중
    var fused = rrfFuse([denseList, bm25List], [alpha, 1 - alpha], rrf_k);
    out.lists.fused = fused.slice(0, 20);
    finalRanked = fused;
    stages.push({ name: 'rrf', ms: Math.round(now() - tf), count: fused.length, provider: 'browser' });
  } else if (mode === 'vector') {
    finalRanked = denseList;
  } else {
    finalRanked = bm25List;
  }

  // 상위 후보 선정(재랭킹 전 top_n)
  var top_n = params.rerank && params.rerank.enabled ? Math.max(top_k, Number(params.rerank.top_n) || 10) : top_k;
  var chunkById = {}; chunks.forEach(function (c) { chunkById[c.id] = c; });
  var bmById = {}; bm25List.forEach(function (r) { bmById[r.chunkId] = r.score; });
  var dnById = {}; denseList.forEach(function (r) { dnById[r.chunkId] = r.score; });
  var rrfById = {}; (out.lists.fused || []).forEach(function (r) { rrfById[r.chunkId] = r.score; });

  var candidates = finalRanked.slice(0, top_n).map(function (r) {
    var c = chunkById[r.chunkId];
    if (c) {
      return {
        chunkId: c.id, docId: c.docId, text: c.text, score: r.score,
        source: { title: c.docTitle, loc: c.loc, docId: c.docId },
        signals: { bm25: bmById[c.id] || 0, dense: dnById[c.id] || 0, rrf: rrfById[c.id] || 0, rerank: null },
      };
    }
    // 서버(pgvector) 청크 — 로컬 인덱스에 없음
    var sc = serverChunks[r.chunkId];
    if (!sc) return null;
    return {
      chunkId: r.chunkId, docId: sc.docId, text: sc.text, score: r.score,
      source: { title: sc.docTitle, loc: sc.loc, docId: sc.docId },
      signals: { bm25: bmById[r.chunkId] || 0, dense: dnById[r.chunkId] != null ? dnById[r.chunkId] : (sc.denseScore || 0), rrf: rrfById[r.chunkId] || 0, rerank: null },
    };
  }).filter(Boolean);

  // ── 재랭킹(LLM) ──
  if (params.rerank && params.rerank.enabled && candidates.length) {
    var tr = now();
    var map = await llmRerank(opts.query, candidates, ctx);
    if (map) {
      candidates.forEach(function (c, i) { c.signals.rerank = map[i] != null ? map[i] : 0; });
      candidates.sort(function (a, b) { return (b.signals.rerank || 0) - (a.signals.rerank || 0); });
      out.provider = 'server';
      stages.push({ name: 'rerank(llm)', ms: Math.round(now() - tr), count: candidates.length, provider: 'server' });
    } else {
      stages.push({ name: 'rerank(llm)', ms: Math.round(now() - tr), count: 0, provider: 'server', note: '파싱 실패 — 원순위 유지' });
    }
  }

  // 임계값 필터 + top_k
  var results = candidates.filter(function (c) { return c.score >= threshold || (c.signals.rerank != null && c.signals.rerank > 0); }).slice(0, top_k);
  out.results = results.length ? results : candidates.slice(0, top_k);
  // provider: 최종 소스 배지 — server 개입 없으면 browser/approx
  if (out.provider === 'browser' && embedProvider === 'approx' && wantDense && !wantSparse) out.provider = 'approx';
  return out;
}

// 컨텍스트 조립 + 인용 매핑
function buildContext(results, opts) {
  opts = opts || {};
  var maxChars = opts.maxChars || 4000;
  var parts = [], citations = [], used = 0;
  results.forEach(function (r, i) {
    var n = i + 1;
    var block = '[' + n + '] (' + (r.source.title || r.docId) + ' · ' + (r.source.loc || '') + ')\n' + r.text.trim();
    if (used + block.length > maxChars && parts.length) return;
    parts.push(block); used += block.length;
    citations.push({ n: n, chunkId: r.chunkId, title: r.source.title, loc: r.source.loc, docId: r.docId });
  });
  return { contextText: parts.join('\n\n'), citations: citations };
}

/* ============================================================
   6. Graph (§8.4) — 소규모 LLM 추출(실동작) / 대형·실패 시 mock
   ============================================================ */
function louvainish(nodes, edges) {
  // 경량 라벨 전파(커뮤니티 근사) — 순수 JS
  var adj = {}; nodes.forEach(function (n) { adj[n.id] = []; });
  edges.forEach(function (e) { if (adj[e.source] && adj[e.target]) { adj[e.source].push(e.target); adj[e.target].push(e.source); } });
  var label = {}; nodes.forEach(function (n, i) { label[n.id] = i; });
  for (var iter = 0; iter < 6; iter++) {
    var changed = false;
    nodes.forEach(function (n) {
      var cnt = {}; (adj[n.id] || []).forEach(function (nb) { cnt[label[nb]] = (cnt[label[nb]] || 0) + 1; });
      var best = label[n.id], bestC = -1;
      Object.keys(cnt).forEach(function (l) { if (cnt[l] > bestC) { bestC = cnt[l]; best = Number(l); } });
      if (best !== label[n.id]) { label[n.id] = best; changed = true; }
    });
    if (!changed) break;
  }
  // 라벨 → 커뮤니티 id 정규화
  var remap = {}, cc = 0;
  nodes.forEach(function (n) { var l = label[n.id]; if (remap[l] == null) remap[l] = 'c' + (++cc); n.community = remap[l]; });
  var comms = {};
  nodes.forEach(function (n) { (comms[n.community] = comms[n.community] || []).push(n.id); });
  var communities = Object.keys(comms).map(function (cid) {
    var members = comms[cid];
    var title = members.map(function (id) { return (nodes.filter(function (n) { return n.id === id; })[0] || {}).name; }).filter(Boolean).slice(0, 3).join(', ');
    return { id: cid, level: 1, title: title || cid, summary: (members.length + '개 엔티티 커뮤니티'), size: members.length, entityIds: members, members: members };
  });
  return communities;
}

async function buildGraph(opts) {
  opts = opts || {};
  var chunks = opts.chunks || [];
  var maxChunks = opts.maxChunks || 8;
  var ctx = { profile: opts.profile, profileId: opts.profileId, model: opts.model, useProxy: opts.useProxy, signal: opts.signal };

  // ── DB 라우팅: 활성 백엔드가 neo4j면 Graph를 /api/db/graph/query(Cypher)로 ──
  var dbConn = (opts.dbConnId && L.db && typeof L.db.get === 'function') ? L.db.get(opts.dbConnId) : null;
  var graphDbNote = null;
  if (dbConn && dbConn.type === 'neo4j') {
    var gq = await L.db.graphQuery({
      connId: dbConn.id, mode: opts.mode || 'global', readonly: true,
      params: { name: opts.query || '', k: opts.topK || 25 }, signal: opts.signal,
    });
    if (gq && gq.ok && gq.provider === 'server' && Array.isArray(gq.nodes)) {
      return {
        op: 'graph', provider: 'server', dbBackend: 'neo4j', dbConnLabel: dbConn.label,
        nodes: gq.nodes, edges: gq.edges || [], communities: gq.communities || [],
        answer: gq.answer || '', sources: gq.sources || [], records: gq.records, stats: gq.stats,
      };
    }
    graphDbNote = (gq && gq.unreachable) ? 'Neo4j 미도달 — mock 강등' : (gq && gq.error ? ('Neo4j 강등: ' + gq.error) : 'Neo4j 응답 없음 — mock 강등');
  }

  var small = chunks.length > 0 && chunks.length <= (opts.smallLimit || 40);
  // 그래프 DB(neo4j) 백엔드가 선택됐으나 실패 → LLM 추출 대신 mock 그래프로 강등
  if (dbConn && dbConn.type === 'neo4j') small = false;

  // 대형이거나 코퍼스 없음 → mock (api.js 재사용)
  if (!small) {
    var g = (window.ChatAPI && window.ChatAPI.graphRagQuery)
      ? await window.ChatAPI.graphRagQuery(opts.query || '', { mode: opts.mode || 'global', signal: opts.signal })
      : null;
    if (g) {
      return {
        op: 'graph', provider: 'mock', dbBackend: dbConn ? dbConn.type : undefined,
        note: graphDbNote || undefined, degraded: !!graphDbNote,
        nodes: g.entities.map(function (e) { return { id: e.id, name: e.name, type: e.type, degree: e.degree, community: e.community }; }),
        edges: g.relations.map(function (r) { return { source: r.source, target: r.target, relation: r.description, weight: r.weight, id: r.id }; }),
        communities: g.communities,
        answer: g.answer, sources: g.sources, subgraph: g.subgraph, stats: g.stats,
      };
    }
    return { op: 'graph', provider: 'mock', dbBackend: dbConn ? dbConn.type : undefined, note: graphDbNote || undefined, degraded: !!graphDbNote, nodes: [], edges: [], communities: [], answer: '', sources: [] };
  }

  // 소규모 실동작: LLM 엔티티·관계 추출
  var text = chunks.slice(0, maxChunks).map(function (c) { return c.text; }).join('\n').slice(0, 3500);
  var r = await kernelText({
    module: 'rag', profile: ctx.profile, profileId: ctx.profileId, model: ctx.model, useProxy: ctx.useProxy,
    params: { max_tokens: 900, temperature: 0.2, stream: false },
    messages: [{ role: 'user', content:
      '다음 텍스트에서 지식그래프를 추출하라. JSON만 출력:\n' +
      '{"entities":[{"name":"...","type":"PERSON|ORG|CONCEPT|TECH|GEO|OTHER"}],"relations":[{"source":"엔티티명","target":"엔티티명","relation":"관계"}]}\n\n텍스트:\n' + text }],
    signal: ctx.signal, reasoningEnabled: false,
  });
  var parsed = null;
  try { var m = r.text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (e) { parsed = null; }

  if (!parsed || !Array.isArray(parsed.entities) || !parsed.entities.length) {
    // 실패 → mock 강등
    var gg = (window.ChatAPI && window.ChatAPI.graphRagQuery) ? await window.ChatAPI.graphRagQuery(opts.query || '', { mode: opts.mode || 'global', signal: opts.signal }) : null;
    if (gg) return { op: 'graph', provider: 'mock', degraded: true,
      nodes: gg.entities.map(function (e) { return { id: e.id, name: e.name, type: e.type, degree: e.degree, community: e.community }; }),
      edges: gg.relations.map(function (x) { return { source: x.source, target: x.target, relation: x.description, weight: x.weight }; }),
      communities: gg.communities, answer: gg.answer, sources: gg.sources };
    return { op: 'graph', provider: 'mock', nodes: [], edges: [], communities: [] };
  }

  // 엔티티명 → id
  var byName = {}; var nodes = [];
  parsed.entities.forEach(function (e) {
    var name = String(e.name || '').trim(); if (!name || byName[name]) return;
    var id = uid('n'); byName[name] = id;
    nodes.push({ id: id, name: name, type: e.type || 'OTHER', degree: 0, community: null });
  });
  var edges = [];
  (parsed.relations || []).forEach(function (rel) {
    var s = byName[String(rel.source || '').trim()], t = byName[String(rel.target || '').trim()];
    if (!s || !t || s === t) return;
    edges.push({ id: uid('r'), source: s, target: t, relation: rel.relation || '', weight: 1 });
  });
  // degree 계산
  var deg = {}; edges.forEach(function (e) { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1; });
  nodes.forEach(function (n) { n.degree = deg[n.id] || 1; });
  var communities = louvainish(nodes, edges);
  return { op: 'graph', provider: 'browser', nodes: nodes, edges: edges, communities: communities, llmCalls: 1 };
}

/* ============================================================
   7. Chain / Workflow 러너 (§8.5) — 선형(+조건 분기) 실동작
   ============================================================ */
function blankStep(type) {
  var base = { id: uid('s'), type: type, title: '' };
  if (type === 'input') return Object.assign(base, { title: 'Input', vars: [{ name: 'topic', value: '' }] });
  if (type === 'llm' || type === 'prompt') return Object.assign(base, { type: 'llm', title: 'Prompt', prompt: '{{topic}}', model: '', params: {} });
  if (type === 'transform') return Object.assign(base, { title: 'Transform (JS)', code: '// ctx=이전 변수/출력, input=직전 출력\nreturn input.trim().toUpperCase();' });
  if (type === 'condition') return Object.assign(base, { title: 'Condition', expr: 'input.length > 100', then: '', els: '', stopOnFalse: false });
  if (type === 'output') return Object.assign(base, { title: 'Output', source: '' });
  return base;
}

// {{path}} 치환 — ctx 평면 조회(a, a.b)
function interpolate(tmpl, ctx) {
  return String(tmpl == null ? '' : tmpl).replace(/\{\{\s*([\w.$]+)\s*\}\}/g, function (_, path) {
    var parts = path.split('.'), v = ctx;
    for (var i = 0; i < parts.length; i++) { if (v == null) return ''; v = v[parts[i]]; }
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function runTransform(code, ctx, input) {
  /* 사용자 작성 경량 변환(JS) — 옵트인. 브라우저 로컬 실행(신뢰 경계=사용자 자신). */
  var fn = new Function('ctx', 'input', 'vars', code);
  var out = fn(ctx, input, ctx);
  return out == null ? '' : (typeof out === 'string' ? out : JSON.stringify(out));
}
function evalCondition(expr, ctx, input) {
  var fn = new Function('ctx', 'input', 'vars', 'return (' + (expr || 'true') + ');');
  return !!fn(ctx, input, ctx);
}

// chain: {id,name,steps:[...]}  (steps=nodes 별칭)
async function runChain(opts) {
  opts = opts || {};
  var chain = opts.chain || {};
  var steps = chain.steps || chain.nodes || [];
  var ctx = Object.assign({}, opts.vars || {});
  var trace = [];
  var lastOutput = opts.input || '';
  var stepById = {}; steps.forEach(function (s) { stepById[s.id] = s; });
  var indexOfId = function (id) { for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return i; return -1; };
  var skipped = {};
  var onStep = typeof opts.onStep === 'function' ? opts.onStep : function () {};
  var onStepDone = typeof opts.onStepDone === 'function' ? opts.onStepDone : function () {};
  var aborted = false;
  if (opts.signal) { if (opts.signal.aborted) aborted = true; opts.signal.addEventListener('abort', function () { aborted = true; }); }

  var i = 0;
  while (i < steps.length) {
    if (aborted) break;
    var step = steps[i];
    if (skipped[step.id]) { trace.push({ stepId: step.id, type: step.type, title: step.title, status: 'skipped', output: '' }); i++; continue; }
    var t0 = now();
    onStep({ stepId: step.id, index: i, step: step });
    var rec = { stepId: step.id, type: step.type, title: step.title || step.type, status: 'running', output: '', provider: 'browser', ms: 0 };
    trace.push(rec);

    try {
      if (step.type === 'input') {
        (step.vars || []).forEach(function (v) { if (v && v.name) ctx[v.name] = interpolate(v.value, ctx); });
        rec.output = (step.vars || []).map(function (v) { return v.name + '=' + (ctx[v.name] || ''); }).join('\n');
        rec.provider = 'browser';
      } else if (step.type === 'llm' || step.type === 'prompt') {
        var prompt = interpolate(step.prompt, Object.assign({ input: lastOutput }, ctx));
        var r = await kernelText({
          module: 'chain', profile: opts.profile, profileId: opts.profileId,
          model: step.model || opts.model, useProxy: opts.useProxy,
          params: Object.assign({}, opts.params, step.params, { stream: false }),
          messages: [{ role: 'user', content: prompt }],
          signal: opts.signal, reasoningEnabled: false,
        });
        rec.provider = 'server';
        rec.prompt = prompt;
        if (!r.ok) { rec.status = 'error'; rec.error = r.error; rec.ms = Math.round(now() - t0); onStepDone(rec); break; }
        rec.output = r.text;
        if (r.result) { rec.usage = r.result.usage; rec.timing = r.result.timing; }
        ctx[step.id] = { output: r.text }; ctx[step.id + '.output'] = r.text;
        lastOutput = r.text;
      } else if (step.type === 'transform') {
        rec.provider = 'browser';
        rec.output = runTransform(step.code || '', Object.assign({ input: lastOutput }, ctx), lastOutput);
        ctx[step.id] = { output: rec.output }; lastOutput = rec.output;
      } else if (step.type === 'condition') {
        rec.provider = 'browser';
        var res = evalCondition(step.expr, Object.assign({ input: lastOutput }, ctx), lastOutput);
        rec.condition = res; rec.output = String(res);
        ctx[step.id] = { output: String(res) };
        var target = res ? step.then : (step.els || step.else);
        if (!res && step.stopOnFalse) { rec.status = 'done'; rec.ms = Math.round(now() - t0); rec.note = 'false → 체인 중단'; onStepDone(rec); break; }
        if (target && stepById[target]) {
          var ti = indexOfId(target);
          // 사이 스텝을 not-taken으로 스킵
          for (var k = i + 1; k < ti; k++) skipped[steps[k].id] = true;
          rec.status = 'done'; rec.ms = Math.round(now() - t0); rec.note = '분기 → ' + (stepById[target].title || target);
          onStepDone(rec); i = ti; continue;
        }
      } else if (step.type === 'output') {
        rec.provider = 'browser';
        rec.output = step.source ? interpolate('{{' + step.source + '}}', Object.assign({ input: lastOutput }, ctx)) : lastOutput;
      }
      rec.status = 'done';
    } catch (e) {
      rec.status = 'error'; rec.error = { type: 'transform', message: e.message };
    }
    rec.ms = Math.round(now() - t0);
    onStepDone(rec);
    if (rec.status === 'error') break;
    i++;
  }

  var okAll = trace.every(function (t) { return t.status === 'done' || t.status === 'skipped'; }) && !aborted;
  return { op: 'chain', ok: okAll, aborted: aborted, trace: trace, ctx: ctx, output: lastOutput };
}

function validateChain(chain) {
  var errors = [];
  var steps = (chain && (chain.steps || chain.nodes)) || [];
  if (!steps.length) errors.push('스텝이 없습니다.');
  steps.forEach(function (s, i) {
    if (!s.type) errors.push('스텝 ' + (i + 1) + ': type 누락');
    if ((s.type === 'llm' || s.type === 'prompt') && !String(s.prompt || '').trim()) errors.push('스텝 ' + (i + 1) + ': 프롬프트 비어있음');
  });
  return { ok: errors.length === 0, errors: errors };
}

/* ============================================================
   8. 노출 (window.LLMLab.rag / .chain) — 엔진 객체에 "추가"
   ============================================================ */
L.rag = {
  chunk: chunk,
  embed: embed,
  retrieve: retrieve,
  buildContext: buildContext,
  buildGraph: buildGraph,
  // 프리미티브(테스트/재사용)
  _tokenize: tokenize, _cosine: cosine, _bm25: { build: buildBM25, scores: bm25Scores }, _rrf: rrfFuse, _approxEmbed: approxEmbed,
};
L.chain = {
  run: runChain,
  validate: validateChain,
  blankStep: blankStep,
  interpolate: interpolate,
};

if (typeof window !== 'undefined') window.LLMLab = L;

})();
