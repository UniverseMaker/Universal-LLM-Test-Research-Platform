/* ==========================================================================
   LLM Lab — agent-eval-sim.js (v24, 단계 3)
   Agent/Tools · Eval/Bench · Simulate 어댑터 & 오케스트레이션 (순수 로직).
   엔진(window.LLMLab.kernel)은 "소비만" 한다. rag-chain.js 와 동일하게
   window.LLMLab.agent / .eval / .sim 네임스페이스를 "추가"로 노출한다.
   비 ES모듈(IIFE) — file:// 에서도 동작. 하드코딩 색 없음(순수 로직).

   계약 (02 §8):
     8.6 Tool     invokeTool({name,args,provider}) → {content,ms,provider}
     8.7 Eval Run runEval({cases,variants,repeats,judge,autoMetrics}) → results[]
     8.8 Simulate runSimulation({participants,maxTurns,stop,judge}) → {transcript,outcome}

   모든 능력 응답에 provider(browser|server|mock|approx) 필드.
   ========================================================================== */
(function () {
'use strict';

var L = window.LLMLab;
if (!L) { console.error('[agent-eval-sim] window.LLMLab 미로드 — 어댑터를 붙일 수 없습니다.'); return; }

/* ---- 유틸 ---------------------------------------------------------------- */
function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
function uid(p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 8); }
// 실행시점에 커널을 조회(테스트에서 window.LLMLab.kernel.run 스텁 가능)
function K() { return (window.LLMLab && window.LLMLab.kernel) || L.kernel; }
function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function aborted(sig) { return !!(sig && sig.aborted); }
function timing(r) { return (r && r.timing) || {}; }

// 커널을 논스트림으로 호출하고 RunResult 반환(에러여도 resolve)
function kernelRun(req) {
  return Promise.resolve(K().run(Object.assign({}, req, { stream: false })))
    .then(function (r) { return r || { ok: false, content: '', error: { message: 'no result' }, timing: {}, usage: null }; })
    .catch(function (e) { return { ok: false, content: '', error: { type: 'exception', message: String(e && e.message || e) }, timing: {}, usage: null }; });
}

/* ==========================================================================
   A. AGENT / TOOLS  (§8.6)
   ========================================================================== */

// 안전한 산술 평가기 (eval 미사용) — 계산기 내장 툴용
function safeArith(expr) {
  var s = String(expr == null ? '' : expr);
  var i = 0;
  function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
  function parseExpr() { var v = parseTerm(); ws(); while (i < s.length && (s[i] === '+' || s[i] === '-')) { var op = s[i++]; var r = parseTerm(); v = op === '+' ? v + r : v - r; ws(); } return v; }
  function parseTerm() { var v = parsePow(); ws(); while (i < s.length && (s[i] === '*' || s[i] === '/' || s[i] === '%')) { var op = s[i++]; var r = parsePow(); v = op === '*' ? v * r : (op === '/' ? v / r : v % r); ws(); } return v; }
  function parsePow() { var v = parseUnary(); ws(); if (i < s.length && s[i] === '^') { i++; var r = parsePow(); v = Math.pow(v, r); } return v; }
  function parseUnary() { ws(); if (s[i] === '-') { i++; return -parseUnary(); } if (s[i] === '+') { i++; return parseUnary(); } return parsePrimary(); }
  function parsePrimary() {
    ws();
    if (s[i] === '(') { i++; var v = parseExpr(); ws(); if (s[i] === ')') i++; else throw new Error('괄호 불일치'); return v; }
    var m = /^[0-9]*\.?[0-9]+(?:[eE][+\-]?[0-9]+)?/.exec(s.slice(i));
    if (!m) {
      // 상수(pi/e) 허용
      var c = /^(pi|e)\b/i.exec(s.slice(i));
      if (c) { i += c[0].length; return c[1].toLowerCase() === 'pi' ? Math.PI : Math.E; }
      throw new Error('숫자를 기대함: "' + s.slice(i, i + 8) + '"');
    }
    i += m[0].length; return parseFloat(m[0]);
  }
  var val = parseExpr(); ws();
  if (i < s.length) throw new Error('잘못된 문자: "' + s.slice(i) + '"');
  return val;
}

// 내장 JS 툴 (옵트인·화이트리스트). fn(args, ctx) → 값/문자열/Promise
var BUILTINS = {
  calculator: {
    type: 'function',
    function: { name: 'calculator', description: '산술식을 계산한다(+ - * / % ^, 괄호, pi/e).',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: '예: (2+3)*4' } }, required: ['expression'] } },
    fn: function (a) { var v = safeArith(a.expression != null ? a.expression : a.expr); return { expression: a.expression, result: v }; },
  },
  datetime: {
    type: 'function',
    function: { name: 'datetime', description: '현재 날짜/시간을 ISO 및 로케일 문자열로 반환.',
      parameters: { type: 'object', properties: { tz: { type: 'string', description: '표시용(참고)' } } } },
    fn: function () { var d = new Date(); return { iso: d.toISOString(), locale: d.toString(), epoch_ms: d.getTime() }; },
  },
  json_parse: {
    type: 'function',
    function: { name: 'json_parse', description: 'JSON 문자열의 유효성을 검사하고 파싱 결과/키 목록을 반환.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    fn: function (a) { var o = JSON.parse(a.text); return { valid: true, type: Array.isArray(o) ? 'array' : typeof o, keys: isObj(o) ? Object.keys(o) : undefined, value: o }; },
  },
  regex_match: {
    type: 'function',
    function: { name: 'regex_match', description: '정규식으로 텍스트에서 매치를 추출.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, text: { type: 'string' }, flags: { type: 'string' } }, required: ['pattern', 'text'] } },
    fn: function (a) { var re = new RegExp(a.pattern, a.flags || 'g'); var m = String(a.text).match(re) || []; return { count: m.length, matches: m.slice(0, 50) }; },
  },
  http_get: {
    type: 'function',
    function: { name: 'http_get', description: '(옵트인) http(s) URL에 GET 요청. 프록시 경유 가능.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    fn: function (a, ctx) {
      var url = String(a.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('http(s) URL만 허용');
      var useProxy = ctx && ctx.useProxy;
      var target = useProxy ? '/api/proxy' : url;
      var opt = useProxy
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', url: url, headers: {} }) }
        : { method: 'GET' };
      return fetch(target, opt).then(function (res) { return res.text(); }).then(function (t) { return { url: url, status: 'ok', body: t.slice(0, 2000) }; });
    },
  },
};

function builtinTools() { return Object.keys(BUILTINS).map(function (k) { return { type: 'function', function: BUILTINS[k].function }; }); }

// 툴 정의(JSON) 검증 — OpenAI tools 스키마
function validateTool(defOrText) {
  var def = typeof defOrText === 'string' ? safeJSON(defOrText) : defOrText;
  var errors = [];
  if (!def) return { ok: false, errors: ['JSON 파싱 실패'], tool: null };
  if (def.type !== 'function') errors.push('type은 "function"이어야 합니다.');
  var f = def.function;
  if (!isObj(f)) errors.push('function 객체가 필요합니다.');
  else {
    if (!f.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.name)) errors.push('function.name이 유효하지 않습니다(영숫자/_/-, 1~64).');
    if (f.parameters != null) {
      if (!isObj(f.parameters)) errors.push('function.parameters는 JSON Schema 객체여야 합니다.');
      else if (f.parameters.type && f.parameters.type !== 'object') errors.push('parameters.type은 보통 "object"입니다.');
    }
  }
  return { ok: errors.length === 0, errors: errors, tool: def };
}

function blankTool() {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '도시의 현재 날씨를 조회한다.',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '도시 이름' } }, required: ['city'] },
    },
  };
}

// 툴 실행기 (§8.6) — provider: mock | js | server
function invokeTool(o) {
  o = o || {};
  var t0 = now();
  var provider = o.provider || 'mock';
  if (provider === 'js') {
    var b = BUILTINS[o.name];
    if (!b) return Promise.resolve({ content: JSON.stringify({ error: 'unknown builtin: ' + o.name }), provider: 'js', ms: 0, error: 'unknown_tool' });
    return Promise.resolve().then(function () { return b.fn(o.args || {}, o.ctx || {}); })
      .then(function (out) { return { content: typeof out === 'string' ? out : JSON.stringify(out), provider: 'js', ms: Math.round(now() - t0) }; })
      .catch(function (e) { return { content: JSON.stringify({ error: e.message }), provider: 'js', ms: Math.round(now() - t0), error: e.message }; });
  }
  if (provider === 'server') {
    // 계약만 — 실제 라우트 미연결. 형태만 고정하고 mock 페이로드 반환.
    return Promise.resolve({ content: JSON.stringify({ note: 'server tool not connected (contract only)', name: o.name, args: o.args || {} }), provider: 'server', ms: 0, error: 'not_connected' });
  }
  // mock: 호출자가 mockResult 제공(사용자 손입력)
  return Promise.resolve({ content: o.mockResult != null ? String(o.mockResult) : '', provider: 'mock', ms: Math.round(now() - t0) });
}

// ReAct 멀티스텝 루프 (think → act → observe 반복)
// opts: { messages, tools[], toolMode:'mock|js|server', toolChoice, parallelToolCalls, maxSteps,
//         profile|profileId, model, useProxy, params, reasoningEnabled, signal,
//         invoke(toolCall, ctx)->Promise<{content,provider,ms,error}>  // 미지정 시 invokeTool 사용
//         onStep(record), ctx }
function runReAct(opts) {
  opts = opts || {};
  var maxSteps = opts.maxSteps || 6;
  var toolDefs = (opts.tools || []).slice();
  var messages = (opts.messages || []).slice();
  var onStep = typeof opts.onStep === 'function' ? opts.onStep : function () {};
  var ctx = opts.ctx || { useProxy: opts.useProxy };
  var invoke = typeof opts.invoke === 'function'
    ? opts.invoke
    : function (tc) { return invokeTool({ name: tc.name, args: tc.args, provider: opts.toolMode || 'mock', ctx: ctx }); };

  var trace = [];
  var push = function (rec) { rec.ts = Date.now(); trace.push(rec); onStep(rec); return rec; };

  return (function loop(step) {
    if (aborted(opts.signal)) return Promise.resolve(finish('aborted', '', step));
    if (step > maxSteps) return Promise.resolve(finish('max_steps', '', step));

    var callParams = Object.assign({}, opts.params, { stream: false });
    if (toolDefs.length) callParams.tools = toolDefs;
    if (opts.toolChoice) callParams.tool_choice = opts.toolChoice;
    if (opts.parallelToolCalls != null) callParams.parallel_tool_calls = opts.parallelToolCalls;

    return kernelRun({
      module: 'agent', profile: opts.profile, profileId: opts.profileId, model: opts.model,
      useProxy: opts.useProxy, params: callParams, messages: messages,
      reasoningEnabled: opts.reasoningEnabled, signal: opts.signal,
    }).then(function (res) {
      if (aborted(opts.signal)) return finish('aborted', '', step);
      if (!res.ok) { push({ step: step, type: 'error', error: res.error, provider: 'server' }); return finish('error', '', step); }

      var tcs = (res.toolCalls || []).filter(Boolean);
      // 사고/응답 기록
      if (res.reasoning || res.content || tcs.length) {
        push({ step: step, type: 'think', thought: res.reasoning || '', content: res.content || '',
          hasToolCalls: tcs.length > 0, ms: timing(res).totalMs, usage: res.usage, provider: 'server' });
      }

      // assistant 턴을 대화에 반영
      var asst = { role: 'assistant', content: res.content || '' };
      if (tcs.length) {
        asst.tool_calls = tcs.map(function (tc, k) {
          return { id: tc.id || ('call_' + step + '_' + k), type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments || '{}' } };
        });
      }
      messages.push(asst);

      if (!tcs.length) {
        push({ step: step, type: 'final', content: res.content || '', finishReason: res.finishReason, provider: 'server' });
        return finish('final', res.content || '', step);
      }

      // 각 tool_call 실행 → observation 재주입 (parallel_tool_calls면 여러 개)
      var idx = 0;
      return (function next() {
        if (idx >= asst.tool_calls.length) return loop(step + 1);
        if (aborted(opts.signal)) return finish('aborted', '', step);
        var tc = asst.tool_calls[idx];
        var args = safeJSON(tc.function.arguments) || {};
        push({ step: step, type: 'tool_call', id: tc.id, name: tc.function.name, args: args, argsRaw: tc.function.arguments, provider: 'server' });
        return Promise.resolve(invoke({ id: tc.id, name: tc.function.name, args: args, raw: tc.function.arguments }, ctx))
          .then(function (obs) {
            obs = obs || { content: '', provider: opts.toolMode || 'mock' };
            push({ step: step, type: 'observation', id: tc.id, name: tc.function.name,
              content: obs.content, provider: obs.provider || (opts.toolMode || 'mock'), ms: obs.ms, error: obs.error });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof obs.content === 'string' ? obs.content : JSON.stringify(obs.content) });
            idx++; return next();
          });
      })();
    });
  })(1);

  function finish(reason, content, step) {
    return { ok: reason === 'final', op: 'agent', stopReason: reason, finalContent: content,
      trace: trace, messages: messages, steps: step, provider: 'server' };
  }
}

/* ==========================================================================
   B. EVAL / BENCH  (§8.7)
   ========================================================================== */

function splitWords(s) { return String(s == null ? '' : s).split(/(\s+)/).filter(function (x) { return x.length; }); }

// LCS 기반 diff — 토큰 배열 → [{type:'eq|add|del', text}]
function lcsDiff(a, b) {
  var n = a.length, m = b.length;
  var dp = []; for (var x = 0; x <= n; x++) { dp[x] = new Array(m + 1).fill(0); }
  for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  var out = [], ii = 0, jj = 0;
  while (ii < n && jj < m) {
    if (a[ii] === b[jj]) { out.push({ type: 'eq', text: a[ii] }); ii++; jj++; }
    else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) { out.push({ type: 'del', text: a[ii] }); ii++; }
    else { out.push({ type: 'add', text: b[jj] }); jj++; }
  }
  while (ii < n) out.push({ type: 'del', text: a[ii++] });
  while (jj < m) out.push({ type: 'add', text: b[jj++] });
  return out;
}
function diffWords(a, b) { return lcsDiff(splitWords(a), splitWords(b)); }
function diffLines(a, b) { return lcsDiff(String(a == null ? '' : a).split('\n'), String(b == null ? '' : b).split('\n')); }

// 자동 지표
function autoMetric(name, output, expected) {
  output = output == null ? '' : String(output);
  var exp = expected == null ? '' : String(expected);
  switch (name) {
    case 'exact_match': { var p = output.trim() === exp.trim(); return { name: name, pass: p, value: p }; }
    case 'contains': { var p2 = exp ? output.indexOf(exp) >= 0 : false; return { name: name, pass: p2, value: p2 }; }
    case 'regex': try { var re = new RegExp(exp); var p3 = re.test(output); return { name: name, pass: p3, value: p3 }; } catch (e) { return { name: name, pass: false, error: e.message }; }
    case 'json_valid': try { JSON.parse(output); return { name: name, pass: true, value: true }; } catch (e2) { return { name: name, pass: false, value: false }; }
    case 'length': return { name: name, pass: true, value: output.length };
    default: return { name: name, pass: null, value: null, error: 'unknown metric' };
  }
}

// 분포 통계
function stats(nums) {
  var a = (nums || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }).slice().sort(function (x, y) { return x - y; });
  var n = a.length;
  if (!n) return { n: 0, min: null, max: null, median: null, mean: null, stdev: null, p90: null };
  var sum = a.reduce(function (s, x) { return s + x; }, 0);
  var mean = sum / n;
  var med = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  var variance = a.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / n;
  var p90 = a[Math.min(n - 1, Math.floor(0.9 * (n - 1)))];
  return { n: n, min: a[0], max: a[n - 1], median: med, mean: mean, stdev: Math.sqrt(variance), p90: p90 };
}
function histogram(nums, bins) {
  var a = (nums || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  bins = bins || 8;
  if (!a.length) return { bins: [], max: 0 };
  var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a);
  if (lo === hi) return { bins: [{ lo: lo, hi: hi, count: a.length }], max: a.length };
  var w = (hi - lo) / bins, out = [];
  for (var i = 0; i < bins; i++) out.push({ lo: lo + i * w, hi: lo + (i + 1) * w, count: 0 });
  a.forEach(function (x) { var k = Math.min(bins - 1, Math.floor((x - lo) / w)); out[k].count++; });
  var mx = out.reduce(function (m, b) { return Math.max(m, b.count); }, 0);
  return { bins: out, max: mx };
}

// 데이터셋 파서 (CSV/JSON) → cases[{id,input,expected}]
function parseDataset(text, filename) {
  text = String(text || '').trim();
  if (!text) return [];
  var isJson = /\.json$/i.test(filename || '') || text[0] === '[' || text[0] === '{';
  if (isJson) {
    var o = safeJSON(text); if (!o) return [];
    var arr = Array.isArray(o) ? o : (Array.isArray(o.cases) ? o.cases : []);
    return arr.map(function (r, i) {
      if (typeof r === 'string') return { id: String(i + 1), input: r, expected: '' };
      return { id: String(r.id != null ? r.id : i + 1), input: r.input != null ? r.input : (r.prompt || ''), expected: r.expected != null ? r.expected : (r.output || '') };
    }).filter(function (c) { return c.input; });
  }
  // CSV (input,expected) — 첫 줄 헤더 자동 감지
  var rows = parseCSV(text);
  if (!rows.length) return [];
  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var hasHeader = header.indexOf('input') >= 0 || header.indexOf('prompt') >= 0;
  var inIdx = 0, expIdx = 1;
  if (hasHeader) {
    inIdx = header.indexOf('input') >= 0 ? header.indexOf('input') : header.indexOf('prompt');
    expIdx = header.indexOf('expected') >= 0 ? header.indexOf('expected') : header.indexOf('output');
    rows = rows.slice(1);
  }
  return rows.map(function (r, i) { return { id: String(i + 1), input: (r[inIdx] || '').trim(), expected: expIdx >= 0 ? (r[expIdx] || '').trim() : '' }; })
    .filter(function (c) { return c.input; });
}
function parseCSV(text) {
  var rows = [], row = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (f) { return String(f).trim().length; }); });
}

function buildEvalMessages(variant, caseItem) {
  var msgs = [];
  var sys = variant.system || variant.systemPrompt;
  if (sys && String(sys).trim()) msgs.push({ role: 'system', content: sys });
  var tpl = variant.promptTemplate;
  var content = tpl && tpl.indexOf('{{input}}') >= 0 ? tpl.replace(/\{\{input\}\}/g, caseItem.input) : caseItem.input;
  msgs.push({ role: 'user', content: content });
  return msgs;
}

// Eval Run 엔진 (§8.7): variant × case × repeat
function runEval(opts) {
  opts = opts || {};
  var cases = opts.cases || [];
  var variants = opts.variants || [];
  var repeats = Math.max(1, opts.repeats || 1);
  var autoMetrics = opts.autoMetrics || [];
  var onResult = typeof opts.onResult === 'function' ? opts.onResult : function () {};
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  var results = [];
  var total = variants.length * cases.length * repeats;
  var done = 0;

  // 순차 실행(속도 제한). 각 태스크를 평탄화.
  var tasks = [];
  variants.forEach(function (v) { cases.forEach(function (c) { for (var r = 0; r < repeats; r++) tasks.push({ v: v, c: c, r: r }); }); });

  return tasks.reduce(function (chain, t) {
    return chain.then(function () {
      if (aborted(opts.signal)) return;
      return kernelRun({
        module: 'eval', profile: t.v.profile, profileId: t.v.profileId, model: t.v.model,
        useProxy: opts.useProxy, params: Object.assign({}, t.v.params, { stream: false }),
        messages: buildEvalMessages(t.v, t.c), signal: opts.signal,
      }).then(function (res) {
        var rec = {
          variantId: t.v.id, caseId: t.c.id, repeat: t.r,
          output: res.content || '', ok: res.ok, error: res.error || null,
          latencyMs: timing(res).totalMs != null ? timing(res).totalMs : null,
          ttftMs: timing(res).ttftMs != null ? timing(res).ttftMs : null,
          tokPerSec: timing(res).tokPerSec != null ? timing(res).tokPerSec : null,
          usage: res.usage || null,
          metricResults: autoMetrics.map(function (mn) { return autoMetric(mn, res.content || '', t.c.expected); }),
          provider: 'server',
        };
        results.push(rec); done++;
        onResult(rec); onProgress({ done: done, total: total });
      });
    });
  }, Promise.resolve()).then(function () {
    // Judge (옵션) — 상위 2개 variant 쌍대 비교
    if (opts.judge && opts.judge.enabled && variants.length >= 2 && !aborted(opts.signal)) {
      return runJudgeBatch(cases, variants[0], variants[1], results, opts).then(function (jr) {
        return { op: 'evalRun', results: results, judge: jr, provider: 'server' };
      });
    }
    return { op: 'evalRun', results: results, judge: null, provider: 'server' };
  });
}

function firstOutput(results, variantId, caseId) {
  for (var i = 0; i < results.length; i++) if (results[i].variantId === variantId && results[i].caseId === caseId) return results[i].output;
  return '';
}

// LLM-as-judge — 편향 보정: 순서 무작위화 + 양방향 평균 + 이진 루브릭. 항상 referenceOnly.
function runJudgeBatch(cases, vA, vB, results, opts) {
  var j = opts.judge || {};
  var mode = j.mode || 'pairwise';
  var out = { mode: mode, referenceOnly: true, perCase: [], summary: {}, provider: 'server' };
  var winsA = 0, winsB = 0, ties = 0;

  return cases.reduce(function (chain, c) {
    return chain.then(function () {
      if (aborted(opts.signal)) return;
      var ansA = firstOutput(results, vA.id, c.id);
      var ansB = firstOutput(results, vB.id, c.id);
      if (mode === 'rubric') {
        return judgeRubric(c.input, ansA, j, opts).then(function (sa) {
          return judgeRubric(c.input, ansB, j, opts).then(function (sb) {
            var rec = { caseId: c.id, rubricA: sa, rubricB: sb };
            if (sa.total > sb.total) winsA++; else if (sb.total > sa.total) winsB++; else ties++;
            out.perCase.push(rec);
          });
        });
      }
      return judgePairBiasCorrected(c.input, ansA, ansB, j, opts).then(function (rec) {
        rec.caseId = c.id; out.perCase.push(rec);
        if (rec.winner === 'A') winsA++; else if (rec.winner === 'B') winsB++; else ties++;
      });
    });
  }, Promise.resolve()).then(function () {
    out.summary = { winsA: winsA, winsB: winsB, ties: ties, variantA: vA.id, variantB: vB.id };
    return out;
  });
}

// 쌍대 판정 (편향 보정): 양방향(A우선/B우선) + 각 방향 순서 무작위화, 결과 평균
function judgePairBiasCorrected(question, ansA, ansB, j, opts) {
  var passes = [];
  // 방향1: (A,B), 방향2: (B,A)  — bidirectional 기본 on
  var dirs = j.bidirectional !== false ? [['A', 'B'], ['B', 'A']] : [['A', 'B']];
  return dirs.reduce(function (chain, d) {
    return chain.then(function () {
      if (aborted(opts.signal)) return;
      // 순서 무작위화: 슬롯1/슬롯2 위치를 무작위(로그로 추적)
      var swap = j.randomizeOrder !== false ? Math.random() < 0.5 : false;
      var slot1 = swap ? d[1] : d[0];
      var slot2 = swap ? d[0] : d[1];
      var text1 = slot1 === 'A' ? ansA : ansB;
      var text2 = slot2 === 'A' ? ansA : ansB;
      return judgeAskWhich(question, text1, text2, j, opts).then(function (winnerSlot) {
        // winnerSlot: 1 | 2 | 'tie' → 원래 라벨로 환산
        var winner = winnerSlot === 'tie' ? 'tie' : (winnerSlot === 1 ? slot1 : slot2);
        passes.push({ direction: d.join('>'), swap: swap, winner: winner });
      });
    });
  }, Promise.resolve()).then(function () {
    var a = passes.filter(function (p) { return p.winner === 'A'; }).length;
    var b = passes.filter(function (p) { return p.winner === 'B'; }).length;
    var winner = a > b ? 'A' : (b > a ? 'B' : 'tie');
    return { winner: winner, passes: passes, referenceOnly: true };
  });
}

function judgeAskWhich(question, ans1, ans2, j, opts) {
  var sys = '너는 공정한 평가자다. 두 응답 중 어느 것이 더 나은지 하나만 고른다. 반드시 "1" 또는 "2" 또는 "tie" 한 단어만 출력한다.';
  var user = '[질문]\n' + question + '\n\n[응답 1]\n' + (ans1 || '(빈 응답)') + '\n\n[응답 2]\n' + (ans2 || '(빈 응답)') + '\n\n더 나은 응답은? (1/2/tie)';
  return kernelRun({
    module: 'eval', profile: j.profile, profileId: j.profileId, model: j.model, useProxy: opts.useProxy,
    params: { temperature: 0, max_tokens: 8, stream: false }, reasoningEnabled: false,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], signal: opts.signal,
  }).then(function (res) {
    var t = String(res.content || '').toLowerCase();
    if (/\btie\b/.test(t) || /무승부|비김/.test(t)) return 'tie';
    if (/1/.test(t) && !/2/.test(t)) return 1;
    if (/2/.test(t) && !/1/.test(t)) return 2;
    var m = t.match(/[12]/); return m ? Number(m[0]) : 'tie';
  });
}

// 루브릭 채점(이진 기본) — 기준별 0/1 (또는 척도) 합산
function judgeRubric(question, answer, j, opts) {
  var rubric = j.rubric && j.rubric.length ? j.rubric : [{ name: 'accuracy', binary: true, weight: 1 }, { name: 'helpfulness', binary: true, weight: 1 }];
  var critList = rubric.map(function (r) { return '- ' + r.name + (r.binary === false ? ' (0~' + (r.scale || 5) + ')' : ' (0 또는 1)'); }).join('\n');
  var sys = '너는 공정한 평가자다. 각 기준을 채점하고 JSON만 출력한다. 형식: {"' + rubric.map(function (r) { return r.name; }).join('":n,"') + '":n}';
  var user = '[질문]\n' + question + '\n\n[응답]\n' + (answer || '(빈 응답)') + '\n\n[기준]\n' + critList + '\n\nJSON만:';
  return kernelRun({
    module: 'eval', profile: j.profile, profileId: j.profileId, model: j.model, useProxy: opts.useProxy,
    params: { temperature: 0, max_tokens: 120, stream: false }, reasoningEnabled: false,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], signal: opts.signal,
  }).then(function (res) {
    var scores = {}, total = 0;
    var m = String(res.content || '').match(/\{[\s\S]*\}/);
    var parsed = m ? safeJSON(m[0]) : null;
    rubric.forEach(function (r) {
      var v = parsed && parsed[r.name] != null ? Number(parsed[r.name]) : 0;
      if (r.binary !== false) v = v >= 1 ? 1 : 0;
      scores[r.name] = v; total += v * (r.weight || 1);
    });
    return { scores: scores, total: total, referenceOnly: true };
  });
}

/* ==========================================================================
   B2. RETRIEVAL EVAL — 검색 평가 지표 (nDCG · MRR · Recall · Precision · MAP)
   순수·결정적. 라벨 포맷: [docId,...] (이진, rel=1) 또는 {docId:grade} (등급).
   지표 정의(정확성 최우선):
     Precision@k = (top-k 중 관련)/k          Recall@k = (top-k 중 관련)/(전체 관련 수)
     MRR         = 1/rank_of_first_relevant   (없으면 0)
     AP          = Σ_{관련문서 위치 r} P@r / (전체 관련 수)     ; MAP = mean(AP)
     DCG@k       = Σ_{i=1..k} rel_i/log2(i+1) ; nDCG@k = DCG@k/IDCG@k (IDCG=0→0)
   ========================================================================== */

// 관련도 집합 정규화 → {id:true} (grade>0 인 문서만 "관련")
function toRelSet(x) {
  var set = {};
  if (!x) return set;
  if (typeof Set !== 'undefined' && x instanceof Set) { x.forEach(function (id) { set[String(id)] = true; }); return set; }
  if (Array.isArray(x)) { x.forEach(function (id) { if (id != null) set[String(id)] = true; }); return set; }
  if (typeof x === 'object') {
    Object.keys(x).forEach(function (id) {
      var v = x[id];
      if (v === true) set[id] = true;
      else if (typeof v === 'number') { if (v > 0) set[id] = true; }
      else if (v != null && v !== false && v !== 0) set[id] = true;
    });
  }
  return set;
}
function relCount(set) { return Object.keys(set).length; }

// 라벨(배열=이진 / 객체=등급) → {gradeMap, relevantSet, relevantCount, graded}
function normalizeLabels(labels) {
  var gradeMap = {}, graded = false;
  if (Array.isArray(labels)) {
    labels.forEach(function (id) { if (id != null) gradeMap[String(id)] = 1; });
  } else if (labels && typeof labels === 'object') {
    graded = true;
    Object.keys(labels).forEach(function (id) { var g = Number(labels[id]); gradeMap[String(id)] = isNaN(g) ? 0 : g; });
  }
  var relevantSet = toRelSet(gradeMap);
  return { gradeMap: gradeMap, relevantSet: relevantSet, relevantCount: relCount(relevantSet), graded: graded };
}

// Precision@k = (top-k 중 관련)/k  (분모는 고정 k)
function precisionAtK(ranked, relevantSet, k) {
  ranked = ranked || []; var set = toRelSet(relevantSet);
  if (k == null) k = ranked.length;
  if (k <= 0) return 0;
  var kk = Math.min(k, ranked.length), hit = 0;
  for (var i = 0; i < kk; i++) if (set[String(ranked[i])]) hit++;
  return hit / k;
}

// Recall@k = (top-k 중 관련)/(전체 관련 수)
function recallAtK(ranked, relevantSet, k) {
  ranked = ranked || []; var set = toRelSet(relevantSet); var total = relCount(set);
  if (!total) return 0;
  if (k == null) k = ranked.length;
  var kk = Math.min(k, ranked.length), hit = 0;
  for (var i = 0; i < kk; i++) if (set[String(ranked[i])]) hit++;
  return hit / total;
}

// MRR(단일 질의) = 1/(첫 관련문서 순위) ; 없으면 0
function mrr(ranked, relevantSet) {
  ranked = ranked || []; var set = toRelSet(relevantSet);
  for (var i = 0; i < ranked.length; i++) if (set[String(ranked[i])]) return 1 / (i + 1);
  return 0;
}

// AP(단일 질의) = Σ_{관련문서 위치 r} P@r / (전체 관련 수)
function averagePrecision(ranked, relevantSet) {
  ranked = ranked || []; var set = toRelSet(relevantSet); var total = relCount(set);
  if (!total) return 0;
  var hit = 0, sum = 0;
  for (var i = 0; i < ranked.length; i++) {
    if (set[String(ranked[i])]) { hit++; sum += hit / (i + 1); }   // P@(i+1) at each relevant hit
  }
  return sum / total;
}

// DCG@k = Σ_{i=1..k} rel_i/log2(i+1)  (rels: 위치별 등급 배열)
function dcg(rels, k) {
  rels = rels || [];
  var lim = (k == null) ? rels.length : Math.min(k, rels.length), s = 0;
  for (var i = 0; i < lim; i++) {
    var g = Number(rels[i]) || 0;
    s += g / (Math.log(i + 2) / Math.LN2);   // 0-based i → 위치 p=i+1 → log2(p+1)=log2(i+2)
  }
  return s;
}

// nDCG@k = DCG@k/IDCG@k  (relevanceMap: 배열=이진 또는 {docId:grade}); IDCG=0→0
function ndcg(ranked, relevanceMap, k) {
  ranked = ranked || [];
  var gm = {};
  if (Array.isArray(relevanceMap)) relevanceMap.forEach(function (id) { gm[String(id)] = 1; });
  else if (relevanceMap && typeof relevanceMap === 'object') Object.keys(relevanceMap).forEach(function (id) { var g = Number(relevanceMap[id]); gm[String(id)] = isNaN(g) ? 0 : g; });
  var rels = ranked.map(function (id) { return gm[String(id)] || 0; });
  var d = dcg(rels, k);
  var ideal = Object.keys(gm).map(function (id) { return gm[id]; }).filter(function (g) { return g > 0; }).sort(function (a, b) { return b - a; });
  var idcg = dcg(ideal, k);
  return idcg > 0 ? d / idcg : 0;
}

// 단일 질의 지표 묶음 → {'ndcg@k','recall@k','precision@k', ... ,'mrr','map','ap'}
function retrievalMetrics(rankedIds, labels, ks) {
  ks = (ks && ks.length) ? ks : [5, 10];
  var norm = normalizeLabels(labels);
  var out = {};
  ks.forEach(function (k) {
    out['ndcg@' + k] = ndcg(rankedIds, norm.gradeMap, k);
    out['recall@' + k] = recallAtK(rankedIds, norm.relevantSet, k);
    out['precision@' + k] = precisionAtK(rankedIds, norm.relevantSet, k);
  });
  out['mrr'] = mrr(rankedIds, norm.relevantSet);
  out['map'] = averagePrecision(rankedIds, norm.relevantSet);
  out['ap'] = out['map'];   // 단일 질의에서는 AP == MAP(집계 전)
  return out;
}

// 검색 평가 오케스트레이션
// opts: { dataset:[{query,relevant}], methods:[...], ks:[5,10], corpus, retrieveFn(query,method,corpus,item)->Promise<docId[]>, onProgress, signal }
// 반환: { perQuery:[{qi,query,method,ranked,relevant,metrics}], byMethod:{m:{avg,queries,n}}, methods, ks }
function runRetrievalEval(opts) {
  opts = opts || {};
  var dataset = opts.dataset || [];
  var methods = (opts.methods && opts.methods.length) ? opts.methods : ['hybrid'];
  var ks = (opts.ks && opts.ks.length) ? opts.ks : [5, 10];
  var retrieveFn = opts.retrieveFn;
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  if (typeof retrieveFn !== 'function') {
    return Promise.resolve({ op: 'retrievalEval', error: 'retrieveFn 필요', perQuery: [], byMethod: {}, methods: methods, ks: ks });
  }
  var perQuery = [];
  var total = dataset.length * methods.length, done = 0;
  var tasks = [];
  dataset.forEach(function (q, qi) { methods.forEach(function (m) { tasks.push({ q: q, qi: qi, m: m }); }); });

  return tasks.reduce(function (chain, t) {
    return chain.then(function () {
      if (aborted(opts.signal)) return;
      return Promise.resolve(retrieveFn(t.q.query, t.m, opts.corpus, t.q)).then(function (rankedIds) {
        rankedIds = (rankedIds || []).map(function (x) { return String(x); });
        var metrics = retrievalMetrics(rankedIds, t.q.relevant, ks);
        perQuery.push({ qi: t.qi, query: t.q.query, method: t.m, ranked: rankedIds, relevant: t.q.relevant, metrics: metrics });
        done++; onProgress({ done: done, total: total });
      });
    });
  }, Promise.resolve()).then(function () {
    var byMethod = {};
    methods.forEach(function (m) {
      var rows = perQuery.filter(function (r) { return r.method === m; });
      var avg = {};
      if (rows.length) {
        Object.keys(rows[0].metrics).forEach(function (key) {
          var s = 0; rows.forEach(function (r) { s += (r.metrics[key] || 0); });
          avg[key] = s / rows.length;
        });
      }
      byMethod[m] = { method: m, n: rows.length, avg: avg, queries: rows };
    });
    return { op: 'retrievalEval', methods: methods, ks: ks, perQuery: perQuery, byMethod: byMethod, provider: 'browser' };
  });
}

/* ==========================================================================
   C. SIMULATE  (§8.8)
   ========================================================================== */

// 참가자 관점에서 메시지 조립: 자기 발화=assistant, 상대=user
function buildSimMessages(speaker, transcript, opts) {
  var msgs = [];
  var persona = speaker.persona || '';
  var sys = persona;
  if (speaker.goal) sys += (sys ? '\n\n' : '') + '너의 목표: ' + speaker.goal;
  if (opts.scenario) sys += (sys ? '\n\n' : '') + '상황: ' + opts.scenario;
  if (speaker.role === 'user_sim') sys += (sys ? '\n\n' : '') + '너는 "사용자" 역할로 대화를 이어간다. 한 번에 한 발화만 자연스럽게 말하라.';
  if (sys.trim()) msgs.push({ role: 'system', content: sys });
  if (opts.seedMessage && transcript.length === 0) {
    // 오프너가 아닌 참가자가 첫 발화를 받는 경우의 시드
    msgs.push({ role: 'user', content: opts.seedMessage });
  }
  transcript.forEach(function (t) {
    msgs.push({ role: t.speakerId === speaker.id ? 'assistant' : 'user', content: t.content });
  });
  // 상대가 마지막에 말했어야 assistant가 응답 — transcript 마지막이 자신이면 continue 필요없음(교대 보장)
  if (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
    msgs.push({ role: 'user', content: '(계속)' });
  }
  return msgs;
}

function simMetrics(transcript) {
  var turns = transcript.length;
  var totalTok = 0, totalMs = 0;
  transcript.forEach(function (t) { if (t.usage) totalTok += (t.usage.total_tokens || 0); if (t.ms) totalMs += t.ms; });
  return { turns: turns, totalTokens: totalTok, totalMs: Math.round(totalMs) };
}

// 모델 vs 모델 / user-simulator 오케스트레이션 루프
// opts: { participants:[{id,name,role,persona,goal,profile|profileId,model,params,color}],
//         maxTurns, stop:{onStopString,goalString,onGoalMet}, scenario, seedMessage,
//         firstSpeaker(index), useProxy, signal, onTurn(t), judge, mode }
function runSimulation(opts) {
  opts = opts || {};
  var parts = opts.participants || [];
  if (parts.length < 1) return Promise.resolve({ op: 'simulate', transcript: [], outcome: 'error', error: 'no participants', provider: 'server' });
  var maxTurns = Math.max(1, opts.maxTurns || 8);
  var stop = opts.stop || {};
  var onTurn = typeof opts.onTurn === 'function' ? opts.onTurn : function () {};
  var transcript = [];
  var first = opts.firstSpeaker || 0;

  return (function step(turn, speakerIdx) {
    if (aborted(opts.signal)) return Promise.resolve(done('stopped'));
    if (turn >= maxTurns) return Promise.resolve(done('max_turns'));
    var speaker = parts[speakerIdx % parts.length];
    return kernelRun({
      module: 'sim', profile: speaker.profile, profileId: speaker.profileId, model: speaker.model,
      useProxy: opts.useProxy, params: Object.assign({}, speaker.params, { stream: false }),
      messages: buildSimMessages(speaker, transcript, opts), signal: opts.signal,
    }).then(function (res) {
      if (aborted(opts.signal)) return done('stopped');
      if (!res.ok) {
        var er = { turn: turn, speakerId: speaker.id, name: speaker.name, role: speaker.role, content: '', error: res.error, provider: 'server' };
        transcript.push(er); onTurn(er); return done('error');
      }
      var content = res.content || '';
      var rec = { turn: turn, speakerId: speaker.id, name: speaker.name, role: speaker.role, content: content,
        ms: timing(res).totalMs, usage: res.usage, provider: 'server' };
      transcript.push(rec); onTurn(rec);
      // 종료 조건
      if (stop.onStopString && content.indexOf(stop.onStopString) >= 0) return done('stop_string');
      if (stop.onGoalMet && stop.goalString && content.indexOf(stop.goalString) >= 0) return done('goal_met');
      return step(turn + 1, speakerIdx + 1);
    });
  })(0, first);

  function done(outcome) {
    return { op: 'simulate', transcript: transcript, outcome: outcome, metrics: simMetrics(transcript),
      redteam: opts.mode === 'redteam', provider: 'server' };
  }
}

/* ==========================================================================
   D. BATCH RUNNER  — 데이터셋 배치 실행 (additive · 순수 로직)
   프롬프트(또는 체인)를 데이터셋의 각 행에 일괄 실행하고 결과를 수집한다.
   - parseBatchDataset : CSV/JSONL 자동 감지 → {rows,columns,format}
   - batchInterpolate  : {{column}} → 행 값 치환(없는 키 = 빈 문자열)
   - runBatch          : 동시성 제한 풀 + 진행 콜백 + 중단 + 행별 에러 격리
   - batchToCSV/JSONL  : 결과 내보내기 문자열
   ========================================================================== */

// 배열(객체 목록) → {rows,columns,format}
function rowsFromObjects(arr, fmt) {
  var cols = [], seen = {};
  var rows = (arr || []).map(function (o) {
    var row = (o && typeof o === 'object' && !Array.isArray(o)) ? o : { value: o };
    Object.keys(row).forEach(function (k) { if (!seen[k]) { seen[k] = true; cols.push(k); } });
    return row;
  });
  return { rows: rows, columns: cols, format: fmt || 'jsonl' };
}

// CSV 텍스트 → {rows,columns,format:'csv'}  (첫 줄 헤더, 빈/중복 헤더 보정)
function rowsFromCSV(text) {
  var grid = parseCSV(text);
  if (!grid.length) return { rows: [], columns: [], format: 'csv' };
  var raw = grid[0].map(function (h, i) { var s = String(h == null ? '' : h).trim(); return s || ('col' + (i + 1)); });
  var seen = {}, cols = raw.map(function (h) { var base = h, k = h, n = 2; while (seen[k]) { k = base + '_' + n; n++; } seen[k] = true; return k; });
  var rows = [];
  for (var r = 1; r < grid.length; r++) {
    var obj = {};
    for (var c = 0; c < cols.length; c++) obj[cols[c]] = grid[r][c] != null ? grid[r][c] : '';
    rows.push(obj);
  }
  return { rows: rows, columns: cols, format: 'csv' };
}

// CSV/JSONL 자동 감지 파싱
function parseBatchDataset(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, '').trim();
  if (!text) return { rows: [], columns: [], format: 'empty' };
  // 단일 JSON 배열
  if (text[0] === '[') {
    var arr = safeJSON(text);
    if (Array.isArray(arr)) return rowsFromObjects(arr, 'json');
  }
  // JSONL: 모든 비어있지 않은 줄이 { 또는 [ 로 시작 + JSON 파싱 성공
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
  var looksJsonl = lines.length > 0 && lines.every(function (l) { var t = l.trim(); return t[0] === '{' || t[0] === '['; });
  if (looksJsonl) {
    var objs = [], allOk = true;
    for (var i = 0; i < lines.length; i++) { var o = safeJSON(lines[i].trim()); if (o && typeof o === 'object') objs.push(o); else { allOk = false; break; } }
    if (allOk && objs.length) return rowsFromObjects(objs, 'jsonl');
  }
  // 기본: CSV
  return rowsFromCSV(text);
}

// {{column}} 치환 — 없는 키는 빈 문자열
function batchInterpolate(template, row) {
  return String(template == null ? '' : template).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (_, key) {
    var v = row ? row[key] : '';
    if (v == null) return '';
    return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
}

// 체인 결과에서 사용량/에러 추출
function chainUsage(r) {
  if (!r || !r.trace) return null;
  var total = 0, has = false;
  r.trace.forEach(function (t) { if (t.usage && t.usage.total_tokens != null) { total += Number(t.usage.total_tokens) || 0; has = true; } });
  return has ? { total_tokens: total } : null;
}
function findChainError(r) {
  if (!r || !r.trace) return null;
  for (var i = 0; i < r.trace.length; i++) if (r.trace[i].status === 'error') return r.trace[i].error || { type: 'chain', message: 'step error' };
  return null;
}

// 배치 실행 — 동시성 제한, 진행 콜백, 중단(AbortController), 행별 에러 격리
// opts: { rows, template, systemPrompt?, mode:'prompt'|'chain', chain?,
//         profile|profileId, model, params, concurrency, useProxy, onProgress, signal }
function runBatch(opts) {
  opts = opts || {};
  var rows = opts.rows || [];
  var template = opts.template != null ? opts.template : '{{input}}';
  var systemPrompt = opts.systemPrompt || '';
  var mode = opts.mode === 'chain' ? 'chain' : 'prompt';
  var chain = opts.chain || null;
  var concurrency = Math.max(1, Math.min(20, Math.floor(opts.concurrency || 3)));
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  var signal = opts.signal;
  var total = rows.length;
  var results = new Array(total);
  var t0all = now();
  var done = 0, ok = 0, failed = 0;

  function runOne(index) {
    var row = rows[index] || {};
    var prompt = batchInterpolate(template, row);
    var s0 = now();
    if (aborted(signal)) {
      return Promise.resolve({ index: index, vars: row, prompt: prompt, output: '', error: { type: 'aborted', message: 'aborted' }, usage: null, ms: 0 });
    }
    if (mode === 'chain') {
      var chainRunner = (window.LLMLab && window.LLMLab.chain && window.LLMLab.chain.run) || (L.chain && L.chain.run);
      if (typeof chainRunner !== 'function') {
        return Promise.resolve({ index: index, vars: row, prompt: prompt, output: '', error: { type: 'no_chain', message: 'chain 러너 미로드' }, usage: null, ms: 0 });
      }
      return Promise.resolve(chainRunner({
        chain: chain, vars: row, input: prompt,
        profile: opts.profile, profileId: opts.profileId, model: opts.model,
        params: opts.params, useProxy: opts.useProxy, signal: signal,
      })).then(function (r) {
        r = r || {};
        var err = r.ok ? null : (findChainError(r) || { type: 'chain', message: r.aborted ? 'aborted' : 'chain 실패' });
        return { index: index, vars: row, prompt: prompt, output: r.output != null ? r.output : '', error: err, usage: chainUsage(r), ms: Math.round(now() - s0) };
      }).catch(function (e) {
        return { index: index, vars: row, prompt: prompt, output: '', error: { type: 'exception', message: String(e && e.message || e) }, usage: null, ms: Math.round(now() - s0) };
      });
    }
    // prompt 모드
    var msgs = [];
    if (systemPrompt && String(systemPrompt).trim()) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: prompt });
    return kernelRun({
      module: 'batch', profile: opts.profile, profileId: opts.profileId, model: opts.model,
      useProxy: opts.useProxy, params: Object.assign({}, opts.params, { stream: false }),
      messages: msgs, reasoningEnabled: false, signal: signal,
    }).then(function (res) {
      var ms = timing(res).totalMs != null ? Math.round(timing(res).totalMs) : Math.round(now() - s0);
      return { index: index, vars: row, prompt: prompt, output: res.content || '', error: res.ok ? null : (res.error || { message: 'error' }), usage: res.usage || null, ms: ms };
    }).catch(function (e) {
      return { index: index, vars: row, prompt: prompt, output: '', error: { type: 'exception', message: String(e && e.message || e) }, usage: null, ms: Math.round(now() - s0) };
    });
  }

  return new Promise(function (resolve) {
    if (total === 0) { resolve({ rows: [], stats: { count: 0, ok: 0, failed: 0, totalMs: 0, avgMs: 0 } }); return; }
    var next = 0, active = 0, completed = 0;
    function build() {
      for (var i = 0; i < total; i++) { if (!results[i]) results[i] = { index: i, vars: rows[i], prompt: '', output: '', error: { type: 'skipped', message: 'not run' }, usage: null, ms: 0 }; }
      var totalMs = Math.round(now() - t0all);
      return { rows: results, stats: { count: total, ok: ok, failed: failed, totalMs: totalMs, avgMs: total ? Math.round(totalMs / total) : 0 } };
    }
    function onComplete(idx, rec) {
      results[idx] = rec; active--; completed++; done++;
      if (rec.error) failed++; else ok++;
      onProgress({ done: done, total: total, index: idx, ok: ok, failed: failed });
      if (completed >= total) { resolve(build()); return; }
      launch();
    }
    function launch() {
      while (active < concurrency && next < total) {
        var idx = next++; active++;
        runOne(idx).then((function (i) { return function (rec) { onComplete(i, rec); }; })(idx));
      }
    }
    launch();
  });
}

// 결과 CSV 내보내기 — 입력 컬럼 + output + status + error + ms
function csvCell2(v) {
  if (v == null) v = '';
  else if (typeof v === 'object') v = JSON.stringify(v);
  else v = String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function batchResultRows(results) { return (results && results.rows) ? results.rows : (Array.isArray(results) ? results : []); }
function batchToCSV(results) {
  var rows = batchResultRows(results);
  var cols = [], seen = {};
  rows.forEach(function (r) { var v = r.vars || {}; Object.keys(v).forEach(function (k) { if (!seen[k]) { seen[k] = true; cols.push(k); } }); });
  var header = cols.concat(['output', 'status', 'error', 'ms']);
  var lines = [header.map(csvCell2).join(',')];
  rows.forEach(function (r) {
    var v = r.vars || {};
    var line = cols.map(function (k) { return csvCell2(v[k]); });
    line.push(csvCell2(r.output));
    line.push(csvCell2(r.error ? 'error' : 'ok'));
    line.push(csvCell2(r.error ? (r.error.message || String(r.error)) : ''));
    line.push(csvCell2(r.ms));
    lines.push(line.join(','));
  });
  return lines.join('\n');
}
function batchToJSONL(results) {
  var rows = batchResultRows(results);
  return rows.map(function (r) {
    var v = r.vars || {}, o = {};
    Object.keys(v).forEach(function (k) { o[k] = v[k]; });
    o.output = r.output != null ? r.output : '';
    o.status = r.error ? 'error' : 'ok';
    if (r.error) o.error = r.error.message || String(r.error);
    o.ms = r.ms;
    return JSON.stringify(o);
  }).join('\n');
}

/* ==========================================================================
   E. PARAMETER SWEEP / GRID SEARCH — 파라미터 스윕 (additive · 순수 로직)
   같은 프롬프트를 여러 샘플링 파라미터 조합(데카르트 곱)으로 실행해 비교한다.
   - expandGrid(axes) : 축 정의 → 조합 배열(데카르트 곱). 값 문자열→숫자 파싱.
   - runSweep(opts)   : 조합 × repeats 실행. 동시성 풀(runBatch와 동형) 재사용,
                        진행 콜백·중단·에러 격리. 조합별 자동지표(모델 불필요) 집계.
   자동지표: outLenAvg(출력길이 평균), distinctRatio(고유출력수/샘플수 — 낮을수록
             결정적/일관), tokPerSecAvg. judge 옵션 시 조합 대표출력 LLM 채점.
   ========================================================================== */

// 값 파싱 — 숫자형 문자열은 숫자로("0.7"→0.7), true/false는 불리언, 그 외 원본
function coerceValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v == null) return v;
  var s = String(v).trim();
  if (s === '') return s;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) { var n = Number(s); if (!isNaN(n)) return n; }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

// 축 정의 → 데카르트 곱. axes:{temperature:[0,0.5,1], top_p:[0.9,1]} → 6개 조합.
// 값이 배열 아니면 단일값으로 감쌈. 빈 배열/누락 축은 제외. 축 0개 → [{}](빈 1조합).
function expandGrid(axes) {
  axes = axes || {};
  var keys = Object.keys(axes).filter(function (k) {
    var v = axes[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
  var combos = [{}];
  keys.forEach(function (k) {
    var raw = axes[k];
    var vals = Array.isArray(raw) ? raw : [raw];
    var next = [];
    combos.forEach(function (base) {
      vals.forEach(function (v) {
        var c = Object.assign({}, base);
        c[k] = coerceValue(v);
        next.push(c);
      });
    });
    combos = next;
  });
  return combos;
}

// 자기일관성 근사: 고유 출력수 / 샘플수 (1=전부 상이, 낮을수록 결정적/일관)
function distinctRatio(outputs) {
  var valid = (outputs || []).filter(function (o) { return o != null; });
  if (!valid.length) return 0;
  var seen = {};
  valid.forEach(function (o) { seen[String(o)] = true; });
  return Object.keys(seen).length / valid.length;
}

// 조합의 run들 → 자동 집계 지표 (모델 불필요·결정적)
function aggregateRuns(runs) {
  runs = runs || [];
  var okRuns = runs.filter(function (r) { return r && !r.error; });
  var outs = okRuns.map(function (r) { return r.output || ''; });
  var lens = outs.map(function (o) { return o.length; });
  var outLenAvg = lens.length ? lens.reduce(function (s, x) { return s + x; }, 0) / lens.length : 0;
  var tps = okRuns.map(function (r) { return r.tokPerSec; }).filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  var tokPerSecAvg = tps.length ? tps.reduce(function (s, x) { return s + x; }, 0) / tps.length : null;
  var msArr = okRuns.map(function (r) { return r.ms; }).filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  var msAvg = msArr.length ? msArr.reduce(function (s, x) { return s + x; }, 0) / msArr.length : null;
  return {
    outLenAvg: outLenAvg, distinctRatio: distinctRatio(outs), tokPerSecAvg: tokPerSecAvg,
    msAvg: msAvg, n: runs.length, okCount: okRuns.length, errCount: runs.length - okRuns.length,
  };
}

function sweepFirstOk(combo) {
  for (var i = 0; i < combo.runs.length; i++) if (combo.runs[i] && !combo.runs[i].error) return combo.runs[i].output || '';
  return combo.runs[0] ? (combo.runs[0].output || '') : '';
}

// judge(옵션) — 조합 대표출력을 루브릭 채점 (참고치). judgeRubric 재사용.
function runSweepJudge(prompt, combos, opts) {
  var out = { mode: 'rubric', referenceOnly: true, perCombo: [], provider: 'server' };
  return combos.reduce(function (chain, c, ci) {
    return chain.then(function () {
      if (aborted(opts.signal)) return;
      return judgeRubric(prompt, sweepFirstOk(c), opts.judge || {}, opts).then(function (score) {
        out.perCombo.push({ comboIndex: ci, params: c.params, total: score.total, scores: score.scores });
      });
    });
  }, Promise.resolve()).then(function () { return out; });
}

// 파라미터 스윕 실행 — 각 조합 × repeats회, 동시성 풀·중단·에러 격리
// opts: { prompt, systemPrompt?, axes, baseParams?, repeats?, profile|profileId, model,
//         concurrency, useProxy, reasoningEnabled?, onProgress, signal, judge? }
// 반환: { op:'sweep', combos:[{params,combo,runs:[{output,usage,ms,tokPerSec,error}],agg}], axes, axisKeys, stats, judge? }
function runSweep(opts) {
  opts = opts || {};
  var prompt = opts.prompt != null ? String(opts.prompt) : '';
  var systemPrompt = opts.systemPrompt || '';
  var axes = opts.axes || {};
  var baseParams = opts.baseParams || {};
  var repeats = Math.max(1, Math.floor(opts.repeats || 1));
  var concurrency = Math.max(1, Math.min(20, Math.floor(opts.concurrency || 3)));
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  var signal = opts.signal;

  var comboParams = expandGrid(axes);
  var combos = comboParams.map(function (cp) {
    return { params: Object.assign({}, baseParams, cp), combo: cp, runs: [], agg: null };
  });

  var tasks = [];
  combos.forEach(function (c, ci) { for (var r = 0; r < repeats; r++) tasks.push({ ci: ci, r: r }); });
  var total = tasks.length, done = 0;

  function runOne(t) {
    var combo = combos[t.ci];
    var s0 = now();
    if (aborted(signal)) {
      return Promise.resolve({ output: '', usage: null, ms: 0, tokPerSec: null, error: { type: 'aborted', message: 'aborted' } });
    }
    var msgs = [];
    if (systemPrompt && String(systemPrompt).trim()) msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: prompt });
    return kernelRun({
      module: 'sweep', profile: opts.profile, profileId: opts.profileId, model: opts.model,
      useProxy: opts.useProxy, params: Object.assign({}, combo.params, { stream: false }),
      messages: msgs, reasoningEnabled: opts.reasoningEnabled === true, signal: signal,
    }).then(function (res) {
      var ms = timing(res).totalMs != null ? Math.round(timing(res).totalMs) : Math.round(now() - s0);
      return {
        output: res.content || '', usage: res.usage || null, ms: ms,
        tokPerSec: timing(res).tokPerSec != null ? timing(res).tokPerSec : null,
        error: res.ok ? null : (res.error || { message: 'error' }),
      };
    }).catch(function (e) {
      return { output: '', usage: null, ms: Math.round(now() - s0), tokPerSec: null, error: { type: 'exception', message: String(e && e.message || e) } };
    });
  }

  return new Promise(function (resolve) {
    if (total === 0) { resolve(finish()); return; }
    var next = 0, active = 0, completed = 0;
    function onDone(t, rec) {
      combos[t.ci].runs[t.r] = rec;
      active--; completed++; done++;
      onProgress({ done: done, total: total, comboIndex: t.ci, repeat: t.r });
      if (completed >= total) { resolve(finish()); return; }
      launch();
    }
    function launch() {
      while (active < concurrency && next < total) {
        var t = tasks[next++]; active++;
        runOne(t).then((function (tt) { return function (rec) { onDone(tt, rec); }; })(t));
      }
    }
    launch();
  });

  function finish() {
    combos.forEach(function (c) {
      for (var i = 0; i < repeats; i++) if (!c.runs[i]) c.runs[i] = { output: '', usage: null, ms: 0, tokPerSec: null, error: { type: 'skipped', message: 'not run' } };
      c.agg = aggregateRuns(c.runs);
    });
    var stats = {
      comboCount: combos.length, repeats: repeats, totalRuns: total,
      okRuns: combos.reduce(function (s, c) { return s + c.agg.okCount; }, 0),
      errRuns: combos.reduce(function (s, c) { return s + c.agg.errCount; }, 0),
      aborted: aborted(signal),
    };
    var result = { op: 'sweep', combos: combos, axes: axes, axisKeys: Object.keys(axes), stats: stats, provider: 'server' };
    if (opts.judge && opts.judge.enabled && combos.length >= 1 && !aborted(signal)) {
      return runSweepJudge(prompt, combos, opts).then(function (jr) { result.judge = jr; return result; });
    }
    return result;
  }
}

/* ==========================================================================
   F. BENCHMARK — 엔드포인트 부하/지연 벤치마킹 (additive · 순수 로직)
   "이 모델 서버가 얼마나 잘 도나"의 정답지: 고정 프롬프트를 다수 요청·동시성으로
   발사해 지연 분포(TTFT·총지연 p50/p90/p95/p99)·처리량(req/s, tok/s)·에러율 측정.
   동시성 스윕으로 처리량-지연 곡선. 커널(스트리밍)로 TTFT 계측, 벽시계로 처리량.

   지표 정의(정확성 최우선):
     percentile(sorted,p) : nearest-rank — idx = ceil(p/100 * n) - 1 (0-base, clamp)
     throughput req/s     = 완료요청수 / 측정구간 벽시계경과초
     tokens/s(집계)       = Σ completion_tokens(성공) / 측정구간 벽시계경과초
     error rate           = 실패요청 / 총(측정)요청
   워밍업은 별도 사전 구간에서 실행되어 통계·throughput 벽시계에서 완전 제외된다.
   percentile/총지연 요약은 성공 요청만 대상(실패는 errorRate로 집계).
   ========================================================================== */

// nearest-rank 백분위수 — sorted: 오름차순 정렬된 숫자 배열, p: 0~100
function percentile(sorted, p) {
  sorted = sorted || [];
  var n = sorted.length;
  if (!n) return null;
  var idx = Math.ceil((p / 100) * n) - 1;
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  return sorted[idx];
}

// 지연 배열 → 요약 통계 {count,min,p50,p90,p95,p99,max,mean}
function summarize(latencies) {
  var a = (latencies || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }).slice().sort(function (x, y) { return x - y; });
  var n = a.length;
  if (!n) return { count: 0, min: null, p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  var sum = a.reduce(function (s, x) { return s + x; }, 0);
  return {
    count: n, min: a[0], max: a[n - 1], mean: sum / n,
    p50: percentile(a, 50), p90: percentile(a, 90), p95: percentile(a, 95), p99: percentile(a, 99),
  };
}

// 단일 요청 계측 — 스트리밍 호출로 TTFT 확보, 벽시계 폴백. 실패해도 resolve.
// 반환: { ttftMs, totalMs, ok, error, completionTokens }
function benchOneRequest(reqOpts, signal) {
  var reqStart = now();
  var firstAt = 0;
  if (aborted(signal)) {
    return Promise.resolve({ ttftMs: null, totalMs: 0, ok: false, error: { type: 'aborted', message: 'aborted' }, completionTokens: 0 });
  }
  return Promise.resolve(K().run({
    module: 'bench', profile: reqOpts.profile, profileId: reqOpts.profileId, model: reqOpts.model,
    useProxy: reqOpts.useProxy, stream: true,
    params: Object.assign({}, reqOpts.params, { max_tokens: reqOpts.maxTokens, stream: true }),
    messages: [{ role: 'user', content: reqOpts.prompt }],
    reasoningEnabled: false, signal: signal,
    onToken: function () { if (!firstAt) firstAt = now(); },
  })).then(function (res) {
    res = res || { ok: false, content: '', error: { message: 'no result' }, timing: {}, usage: null };
    var reqEnd = now();
    var t = res.timing || {};
    var ttft = (t.ttftMs != null) ? t.ttftMs : (firstAt ? Math.round(firstAt - reqStart) : null);
    var totalMs = (t.totalMs != null) ? t.totalMs : Math.round(reqEnd - reqStart);
    var ct = res.usage ? (Number(res.usage.completion_tokens) || 0) : 0;
    return { ttftMs: ttft, totalMs: totalMs, ok: !!res.ok, error: res.ok ? null : (res.error || { message: 'error' }), completionTokens: ct };
  }).catch(function (e) {
    var reqEnd = now();
    return { ttftMs: firstAt ? Math.round(firstAt - reqStart) : null, totalMs: Math.round(reqEnd - reqStart), ok: false, error: { type: 'exception', message: String(e && e.message || e) }, completionTokens: 0 };
  });
}

// 동시성 풀 — count개 작업을 최대 concurrency 동시 실행. peak 동시성 추적.
// runTask(i)->Promise<rec>. onEach(rec,i) 진행 콜백. 반환 {recs, peak}.
function benchPool(count, concurrency, runTask, onEach) {
  return new Promise(function (resolve) {
    if (count <= 0) { resolve({ recs: [], peak: 0 }); return; }
    var recs = new Array(count);
    var next = 0, active = 0, completed = 0, peak = 0;
    function launch() {
      while (active < concurrency && next < count) {
        var i = next++; active++;
        if (active > peak) peak = active;
        runTask(i).then((function (k) {
          return function (rec) {
            recs[k] = rec; active--; completed++;
            if (onEach) onEach(rec, k);
            if (completed >= count) { resolve({ recs: recs, peak: peak }); return; }
            launch();
          };
        })(i));
      }
    }
    launch();
  });
}

// 완료된 요청 계측 → 최종 벤치 요약 조립
function finalizeBench(perRequest, wallMs, concurrency, requests, warmup, peakActive, signal) {
  var okRecs = perRequest.filter(function (r) { return r && r.ok; });
  var failed = perRequest.length - okRecs.length;
  var ttftVals = okRecs.map(function (r) { return r.ttftMs; }).filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  var totalVals = okRecs.map(function (r) { return r.totalMs; }).filter(function (x) { return typeof x === 'number' && !isNaN(x); });
  var wallSec = wallMs / 1000;
  var completed = perRequest.length;
  var totalTokens = okRecs.reduce(function (s, r) { return s + (Number(r.completionTokens) || 0); }, 0);
  var reqPerSec = wallSec > 0 ? completed / wallSec : 0;
  var tokPerSec = wallSec > 0 ? totalTokens / wallSec : 0;
  return {
    op: 'bench',
    perRequest: perRequest,
    ttft: summarize(ttftVals),
    total: summarize(totalVals),
    throughput: { reqPerSec: reqPerSec, tokPerSec: tokPerSec, totalTokens: totalTokens },
    errorRate: perRequest.length ? failed / perRequest.length : 0,
    concurrency: concurrency, requests: requests, warmup: warmup,
    wallMs: wallMs, peakConcurrency: peakActive,
    okCount: okRecs.length, failCount: failed,
    aborted: aborted(signal),
    provider: 'server',
  };
}

// 벤치마크 실행 — 고정 프롬프트를 requests회, 동시성 concurrency로 발사.
// opts: { prompt, requests, concurrency, warmup?, maxTokens?, profile|profileId, model,
//         params?, useProxy, onProgress, signal }
// 반환: { op:'bench', perRequest:[{ttftMs,totalMs,ok,error,completionTokens}], ttft:summary,
//         total:summary, throughput:{reqPerSec,tokPerSec}, errorRate, concurrency, requests, wallMs, ... }
function runBenchmark(opts) {
  opts = opts || {};
  var prompt = opts.prompt != null ? String(opts.prompt) : 'ping';
  var requests = Math.max(1, Math.floor(opts.requests || 20));
  var concurrency = Math.max(1, Math.min(64, Math.floor(opts.concurrency || 1)));
  var warmup = Math.max(0, Math.floor(opts.warmup || 0));
  var maxTokens = Math.max(1, Math.floor(opts.maxTokens || 64));
  var signal = opts.signal;
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  var reqOpts = {
    prompt: prompt, profile: opts.profile, profileId: opts.profileId, model: opts.model,
    useProxy: opts.useProxy, params: opts.params || {}, maxTokens: maxTokens,
  };

  var totalToRun = warmup + requests;
  var doneAll = 0, peakActive = 0;

  // 1) 워밍업 구간 — 통계/throughput 벽시계에서 제외
  return benchPool(warmup, concurrency,
    function () { return benchOneRequest(reqOpts, signal); },
    function () { doneAll++; onProgress({ phase: 'warmup', done: doneAll, total: totalToRun }); }
  ).then(function (warmRes) {
    if (warmRes.peak > peakActive) peakActive = warmRes.peak;
    // 2) 측정 구간 — 벽시계 시작
    var wallStart = now();
    return benchPool(requests, concurrency,
      function () { return benchOneRequest(reqOpts, signal); },
      function () { doneAll++; onProgress({ phase: 'measure', done: doneAll, total: totalToRun }); }
    ).then(function (measRes) {
      var wallMs = Math.round(now() - wallStart);
      if (measRes.peak > peakActive) peakActive = measRes.peak;
      return finalizeBench(measRes.recs, wallMs, concurrency, requests, warmup, peakActive, signal);
    });
  });
}

// 동시성 스윕 — 각 동시성 레벨에서 runBenchmark 실행(레벨 간 순차) → 처리량-지연 곡선.
// opts: runBenchmark 옵션 + { concurrencyLevels:[1,2,4,8] }
// 반환: { op:'concurrencySweep', levels:[{concurrency,reqPerSec,tokPerSec,ttftP95,totalP95,errorRate,...,bench}], concurrencyLevels }
function runConcurrencySweep(opts) {
  opts = opts || {};
  var levelsIn = (opts.concurrencyLevels && opts.concurrencyLevels.length) ? opts.concurrencyLevels : [1, 2, 4, 8];
  var signal = opts.signal;
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  var results = [];

  return levelsIn.reduce(function (chain, lvl, idx) {
    return chain.then(function () {
      if (aborted(signal)) return;
      var conc = Math.max(1, Math.floor(lvl));
      return runBenchmark(Object.assign({}, opts, {
        concurrency: conc,
        onProgress: function (pr) { onProgress(Object.assign({ level: conc, levelIndex: idx, levelCount: levelsIn.length }, pr)); },
      })).then(function (bench) {
        results.push({
          concurrency: conc,
          reqPerSec: bench.throughput.reqPerSec,
          tokPerSec: bench.throughput.tokPerSec,
          ttftP50: bench.ttft.p50, ttftP95: bench.ttft.p95,
          totalP50: bench.total.p50, totalP95: bench.total.p95,
          errorRate: bench.errorRate, wallMs: bench.wallMs,
          okCount: bench.okCount, failCount: bench.failCount,
          peakConcurrency: bench.peakConcurrency,
          bench: bench,
        });
      });
    });
  }, Promise.resolve()).then(function () {
    return {
      op: 'concurrencySweep', levels: results, concurrencyLevels: levelsIn,
      requests: Math.max(1, Math.floor(opts.requests || 20)),
      aborted: aborted(signal), provider: 'server',
    };
  });
}

/* ==========================================================================
   노출 (window.LLMLab.agent / .eval / .sim / .batch / .sweep / .bench)
   ========================================================================== */
L.agent = {
  runReAct: runReAct,
  invokeTool: invokeTool,
  validateTool: validateTool,
  blankTool: blankTool,
  builtinTools: builtinTools,
  BUILTINS: BUILTINS,
  _safeArith: safeArith,
};
L.eval = {
  runEval: runEval,
  judgePair: judgePairBiasCorrected,
  judgeRubric: judgeRubric,
  diffWords: diffWords,
  diffLines: diffLines,
  autoMetric: autoMetric,
  stats: stats,
  histogram: histogram,
  parseDataset: parseDataset,
  _parseCSV: parseCSV,
  _lcsDiff: lcsDiff,
  // ── 검색 평가(Retrieval Eval) — additive ──
  dcg: dcg,
  ndcg: ndcg,
  mrr: mrr,
  recallAtK: recallAtK,
  precisionAtK: precisionAtK,
  averagePrecision: averagePrecision,
  retrievalMetrics: retrievalMetrics,
  runRetrievalEval: runRetrievalEval,
  normalizeLabels: normalizeLabels,
  _toRelSet: toRelSet,
};
L.sim = {
  runSimulation: runSimulation,
  buildMessages: buildSimMessages,
  metrics: simMetrics,
};
L.batch = {
  parseDataset: parseBatchDataset,
  interpolate: batchInterpolate,
  runBatch: runBatch,
  toCSV: batchToCSV,
  toJSONL: batchToJSONL,
  _rowsFromCSV: rowsFromCSV,
  _rowsFromObjects: rowsFromObjects,
};
L.sweep = {
  expandGrid: expandGrid,
  runSweep: runSweep,
  aggregateRuns: aggregateRuns,
  distinctRatio: distinctRatio,
  _coerceValue: coerceValue,
};
L.bench = {
  percentile: percentile,
  summarize: summarize,
  histogram: histogram,
  runBenchmark: runBenchmark,
  runConcurrencySweep: runConcurrencySweep,
  _benchOneRequest: benchOneRequest,
  _benchPool: benchPool,
};

if (typeof window !== 'undefined') window.LLMLab = L;

})();
