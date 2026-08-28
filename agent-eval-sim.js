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
   노출 (window.LLMLab.agent / .eval / .sim)
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
};
L.sim = {
  runSimulation: runSimulation,
  buildMessages: buildSimMessages,
  metrics: simMetrics,
};

if (typeof window !== 'undefined') window.LLMLab = L;

})();
