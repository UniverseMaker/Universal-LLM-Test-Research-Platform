/* ==========================================================================
   LLM Lab — app.js (v24, 단계 1)
   4-존 셸 · 연결 프로필 UI · 상세 파라미터 폼 · 인스펙터 · Chat 워크벤치 · 탭 프레임워크
   엔진(window.LLMLab)·렌더 라이브러리(marked/DOMPurify/hljs/KaTeX)는 소비만.
   비 ES모듈(IIFE) — file:// 동작.
   ========================================================================== */
(function () {
'use strict';

var L = window.LLMLab;
if (!L) { console.error('[LLM Lab] llmlab.js(window.LLMLab) 미로드 — 엔진 없이 시작할 수 없습니다.'); return; }

/* ============================================================
   0. 유틸
   ============================================================ */
var $  = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

function el(tag, attrs, children) {
  var n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'text') n.textContent = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k === 'dataset') Object.keys(attrs[k]).forEach(function (d) { n.dataset[d] = attrs[k][d]; });
    else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) { if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  try {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  } catch (e) { /* noop */ }
}
function downloadFile(filename, text, mime) {
  try {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  } catch (e) { toast('다운로드 실패: ' + e.message, 'err'); }
}
function fmtMs(ms) { if (ms == null) return '—'; return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's'; }
function fmtNum(n) { if (n == null) return '—'; return String(n); }
function timeAgo(ts) {
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + '초 전'; if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전'; return Math.floor(s / 86400) + '일 전';
}

/* ============================================================
   1. 상태 · localStorage
   ============================================================ */
var LS = { ui: 'llmlab.ui', chat: 'llmlab.session.chat', sessions: 'llmlab.sessions', activeSession: 'llmlab.activeSessionId' };
function lsGet(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

var state = {
  ui: Object.assign({
    theme: 'dark', activeTab: 'chat', inspectorOpen: false, sidebarOpen: false,
    useProxy: null, // null=엔진 기본
  }, lsGet(LS.ui, {})),
  activeModel: null,          // 세션 선택 모델(null=프로필 model)
  sessionParams: {},          // 세션 스코프 파라미터 오버라이드
  extraHeaders: [],           // 커스텀 헤더 [{name,value,enabled}]
  lastModels: [],             // 최근 헬스체크 모델 목록
  lastResult: null,           // 인스펙터용 최근 RunResult
  inspectorTab: 'request',
  vcTab: 'curl',
  chat: [],                   // 활성 세션 messages 배열 참조 (initSessions에서 설정)
  sessions: [],               // [{id,title,messages,createdAt,updatedAt}]
  activeSessionId: null,
  streaming: false,
  abortCtl: null,
  historyFilter: '',
};
function saveUI() { lsSet(LS.ui, state.ui); }

/* ---- 다중 대화 세션 (ChatGPT류) ---- */
function genSessionId() { return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function newSessionObj() { var t = Date.now(); return { id: genSessionId(), title: '새 대화', messages: [], createdAt: t, updatedAt: t }; }
function activeSession() {
  for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === state.activeSessionId) return state.sessions[i];
  return null;
}
function deriveTitle(messages) {
  var first = null;
  for (var i = 0; i < messages.length; i++) { if (messages[i].role === 'user' && messages[i].content) { first = messages[i].content; break; } }
  if (!first) return '새 대화';
  var t = String(first).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}
// 세션 직렬화(pending 제거 · runResult는 이미 경량 저장분 유지)
function serializeSession(s) {
  return {
    id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
    messages: s.messages.filter(function (m) { return !m.pending; }),
  };
}
function persistSessions() {
  try { lsSet(LS.sessions, state.sessions.map(serializeSession)); lsSet(LS.activeSession, state.activeSessionId); } catch (e) { /* noop */ }
}
// 최초 로드: 세션 목록 복원 또는 단일 chat에서 마이그레이션
function initSessions() {
  var stored = lsGet(LS.sessions, null);
  if (stored && Array.isArray(stored) && stored.length) {
    state.sessions = stored.map(function (s) {
      return { id: s.id || genSessionId(), title: s.title || '새 대화', messages: Array.isArray(s.messages) ? s.messages : [],
        createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now() };
    });
    var savedActive = lsGet(LS.activeSession, null);
    state.activeSessionId = state.sessions.some(function (s) { return s.id === savedActive; }) ? savedActive : state.sessions[0].id;
  } else {
    // 구버전 단일 chat 마이그레이션 (데이터 유실 없이)
    var old = lsGet(LS.chat, []);
    var s0 = newSessionObj();
    if (Array.isArray(old) && old.length) { s0.messages = old; s0.title = deriveTitle(old); }
    state.sessions = [s0];
    state.activeSessionId = s0.id;
    persistSessions();
  }
  state.chat = activeSession().messages;
}
// 활성 세션 메타 갱신 + 저장 (state.chat === activeSession().messages 참조 유지)
function saveChat() {
  var s = activeSession();
  if (s) {
    s.updatedAt = Date.now();
    if ((!s.title || s.title === '새 대화') && s.messages.some(function (m) { return !m.pending; })) s.title = deriveTitle(s.messages);
  }
  persistSessions();
  renderSessions();
}

/* ============================================================
   2. 렌더 라이브러리 가드 + 마크다운 파이프라인 (v23 재사용)
   ============================================================ */
var libs = {
  get marked() { return window.marked; },
  get DOMPurify() { return window.DOMPurify; },
  get hljs() { return window.hljs; },
  get renderMathInElement() { return window.renderMathInElement; },
};
function fallbackMarkdown(src) {
  var parts = String(src).split(/```/), html = '';
  parts.forEach(function (chunk, i) {
    if (i % 2 === 1) {
      var nl = chunk.indexOf('\n');
      var code = nl > -1 ? chunk.slice(nl + 1) : chunk;
      html += '<pre><code>' + escapeHtml(code) + '</code></pre>';
    } else {
      chunk.split(/\n{2,}/).forEach(function (p) { if (p.trim()) html += '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>'; });
    }
  });
  return html;
}
function renderMarkdownInto(container, raw) {
  var html;
  if (libs.marked) { try { libs.marked.setOptions({ breaks: true, gfm: true }); html = libs.marked.parse(raw); } catch (e) { html = fallbackMarkdown(raw); } }
  else html = fallbackMarkdown(raw);
  if (libs.DOMPurify) html = libs.DOMPurify.sanitize(html, { ADD_TAGS: ['span'], ADD_ATTR: ['class'] });
  else { container.textContent = raw; return; }
  container.innerHTML = html;
  $$('table', container).forEach(function (t) {
    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
    var wrap = el('div', { class: 'table-wrap' }); t.replaceWith(wrap); wrap.appendChild(t);
  });
  $$('pre', container).forEach(function (pre) {
    var code = pre.querySelector('code'); if (!code) return;
    var lang = ''; var m = (code.className || '').match(/language-([\w+-]+)/); if (m) lang = m[1];
    if (libs.hljs) { try { libs.hljs.highlightElement(code); } catch (e) { /* */ } }
    if (lang) pre.appendChild(el('span', { class: 'code-lang', text: lang }));
    var btn = el('button', { type: 'button', class: 'code-copy', text: '복사' });
    btn.addEventListener('click', function () { copyText(code.innerText); btn.textContent = '복사됨!'; setTimeout(function () { btn.textContent = '복사'; }, 1500); });
    pre.appendChild(btn);
  });
  if (libs.renderMathInElement) {
    try {
      libs.renderMathInElement(container, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'], throwOnError: false,
      });
    } catch (e) { /* */ }
  }
}
// JSON 구문 강조(인스펙터)
function jsonHighlight(obj) {
  var json = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  json = escapeHtml(json);
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    function (match) {
      var cls = 'jnum';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'jkey' : 'jstr';
      else if (/true|false/.test(match)) cls = 'jbool';
      else if (/null/.test(match)) cls = 'jnull';
      return '<span class="' + cls + '">' + match + '</span>';
    });
}

/* ============================================================
   3. Toast · Confirm
   ============================================================ */
function toast(msg, kind) {
  var region = $('#toastRegion');
  var t = el('div', { class: 'toast toast--' + (kind || 'ok'), text: msg });
  region.appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 200); }, 2600);
}
var _confirmCb = null;
function confirmDialog(msg, onOk, opts) {
  opts = opts || {};
  $('#confirmMsg').textContent = msg;
  $('#confirmTitle').textContent = opts.title || '확인';
  var okBtn = $('#confirmOk'); okBtn.textContent = opts.okText || '확인';
  okBtn.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
  _confirmCb = onOk;
  openOverlay('#confirmOverlay');
}

/* ============================================================
   4. Overlay helpers (focus 관리)
   ============================================================ */
var _lastFocus = null;
function openOverlay(sel) {
  _lastFocus = document.activeElement;
  var o = $(sel); o.hidden = false;
  var focusable = o.querySelector('input,textarea,button,select,[tabindex]');
  if (focusable) setTimeout(function () { try { focusable.focus(); } catch (e) {} }, 30);
}
function closeOverlay(sel) {
  $(sel).hidden = true;
  if (_lastFocus && _lastFocus.focus) { try { _lastFocus.focus(); } catch (e) {} }
}
function anyOverlayOpen() { return $$('.overlay').some(function (o) { return !o.hidden; }); }

/* ============================================================
   5. 테마
   ============================================================ */
function applyTheme() {
  var t = state.ui.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  if (window.mermaid && _mermaidReady) { try { window.mermaid.initialize({ startOnLoad: false, theme: t === 'dark' ? 'dark' : 'default' }); } catch (e) {} }
  if (typeof RAG !== 'undefined' && RAG.onTheme) RAG.onTheme(t === 'dark');
}
function toggleTheme() { state.ui.theme = state.ui.theme === 'light' ? 'dark' : 'light'; saveUI(); applyTheme(); }
var _mermaidReady = false;
function initMermaid() { if (!window.mermaid) return; try { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: state.ui.theme === 'dark' ? 'dark' : 'default' }); _mermaidReady = true; } catch (e) {} }

/* ============================================================
   6. 워크벤치 탭 정의
   ============================================================ */
var TABS = [
  { id: 'chat',  label: 'Chat',        icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', ready: true },
  { id: 'rag',   label: 'RAG Lab',     icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z', ready: true },
  { id: 'chain', label: 'Chain',       icon: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1', ready: true },
  { id: 'agent', label: 'Agent/Tools', icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', tag: '3단계' },
  { id: 'eval',  label: 'Eval/Bench',  icon: 'M3 3v18h18M18 17V9M13 17V5M8 17v-3', tag: '3단계' },
  { id: 'batch', label: 'Batch',       icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', tag: 'NEW' },
  { id: 'sim',   label: 'Simulate',    icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', tag: '3단계' },
];
var PLACEHOLDER_INFO = {
  rag:   { title: 'RAG Lab', sub: '코퍼스 업로드 · 청킹 → 임베딩 → 검색(Vector/BM25/Hybrid) → 재랭킹 → 컨텍스트 → 생성 파이프라인을 카드로 시각화하고, 3열 랭킹 비교와 근거 패널을 제공합니다.', items: ['청킹(fixed/sentence/recursive)', 'Naive/Vector · Hybrid(BM25+RRF)', '쿼리변환 · LLM 재랭킹', 'GraphRAG(local/global)'] },
  chain: { title: 'Chain / Workflow', sub: '스텝 카드 세로 흐름으로 노드(Prompt/Transform/Condition/RAG/Tool/Merge)를 연결해 선형 체인을 실행합니다. 중간 산출물 열람·부분 재실행 지원.', items: ['선형 체인 러너', 'Transform(JS) · Condition', '패턴 프리셋(CoT/Reflexion)', '체인 정의 JSON export/import'] },
  agent: { title: 'Agent / Tools', sub: 'tool 정의 에디터(JSON Schema)와 tool_call 파싱, mock 응답 재주입, ReAct 멀티스텝 루프, 실행 트레이스 타임라인을 제공합니다.', items: ['tools/tool_choice 전송', 'ReAct 루프(스텝 가드)', '내장 JS 툴(옵트인·샌드박스)', '실행 트레이스'] },
  eval:  { title: 'Eval / Bench', sub: 'A/B 병렬 비교, N회 반복 분포, 출력 diff, LLM-as-judge(편향 보정), 데이터셋 배치, 자동지표를 제공합니다.', items: ['A/B 병렬 · N회 분포', 'word/line diff', 'LLM judge(순서 무작위·양방향)', '자동지표 · export'] },
  sim:   { title: 'Simulate', sub: '멀티턴 시나리오에서 모델 vs 모델 자동 대화, 페르소나 프리셋, user-simulator, 종료조건과 가드(최대턴/중단)를 제공합니다.', items: ['모델 vs 모델 오케스트레이션', '페르소나 · 목표 · 종료조건', '턴별 지표', '시나리오 저장'] },
};

/* ============================================================
   7. 파라미터 폼 스펙 (§5)
   ============================================================ */
var PARAM_GROUPS = [
  { id: 'context', title: 'Context & Length', hint: 'C', controls: [
    { key: 'max_tokens', type: 'number', min: 1, step: 1, def: 1024, tip: '생성 최대 토큰', support: 'O V T L Ol' },
    { key: 'min_tokens', type: 'number', min: 0, step: 1, def: 0, tip: '최소 생성 토큰', support: 'V' },
    { key: 'context_window', type: 'number', min: 0, step: 1024, def: null, tip: '컨텍스트 창(게이지 분모)', support: 'V L Ol' },
  ]},
  { id: 'sampling', title: 'Sampling', hint: 'D', controls: [
    { key: 'temperature', type: 'range', min: 0, max: 2, step: 0.05, def: 0.7, tip: '무작위성', support: 'O V T L Ol OR' },
    { key: 'top_p', type: 'range', min: 0, max: 1, step: 0.01, def: 1, tip: 'nucleus 확률질량', support: 'O V T L Ol OR' },
    { key: 'top_k', type: 'number', min: -1, step: 1, def: 0, tip: '상위 k 토큰(0=off)', support: 'V T L Ol' },
    { key: 'min_p', type: 'range', min: 0, max: 1, step: 0.01, def: 0, tip: '최소 확률 컷', support: 'V L Ol' },
    { key: 'typical_p', type: 'range', min: 0, max: 1, step: 0.01, def: 1, tip: 'typical sampling', support: 'L Ol' },
  ]},
  { id: 'repetition', title: 'Repetition', hint: 'E', controls: [
    { key: 'frequency_penalty', type: 'range', min: -2, max: 2, step: 0.05, def: 0, tip: '빈도 페널티', support: 'O V T L Ol OR' },
    { key: 'presence_penalty', type: 'range', min: -2, max: 2, step: 0.05, def: 0, tip: '존재 페널티', support: 'O V T L Ol OR' },
    { key: 'repetition_penalty', type: 'range', min: 0, max: 2, step: 0.01, def: 1, tip: '반복 억제(1=off)', support: 'V T L Ol OR' },
    { key: 'repeat_last_n', type: 'number', min: 0, step: 1, def: null, tip: '반복 검사 범위', support: 'L Ol' },
    { key: 'no_repeat_ngram_size', type: 'number', min: 0, step: 1, def: null, tip: 'n-gram 반복 금지', support: 'T' },
  ]},
];

/* ============================================================
   8. 프로필 관련 도우미
   ============================================================ */
function activeProfile() { return L.profiles.getActive(); }
function profileModel(p) { return state.activeModel || (p && p.model) || ''; }
// URL/base_url에서 호스트(도메인)만 추출
function hostFromURL(u) {
  if (!u) return '';
  try { return new URL(u).host; }
  catch (e) { var s = String(u).replace(/^[a-z]+:\/\//i, '').split(/[\/?#]/)[0]; return s || ''; }
}
// RunResult 경량 복사 (인스펙터 재현용 · 원시 SSE 청크 등 대용량 제외)
function trimRunResult(r) {
  if (!r) return null;
  var req = r.request || {}, resp = r.response || {};
  return {
    module: r.module, model: r.model, provider: r.provider,
    profileId: r.profileId, profileLabel: r.profileLabel,
    finishReason: r.finishReason, usage: r.usage, timing: r.timing,
    content: r.content, error: r.error || null, ts: r.ts,
    request: { url: req.url, method: req.method, endpoint: req.endpoint, useProxy: req.useProxy, headers: req.headers, body: req.body },
    response: { status: resp.status, statusText: resp.statusText, headers: resp.headers, viaProxy: resp.viaProxy, stream: resp.stream },
  };
}
// RunResult → View code 재현 요청 스냅샷
function viewReqFromRun(r) {
  return {
    profileId: r.profileId, model: r.model,
    endpoint: (r.request && r.request.endpoint) || 'chat',
    messages: (r.request && r.request.body && r.request.body.messages) || undefined,
    params: state.sessionParams, extraHeaders: state.extraHeaders,
    stream: r.response && r.response.stream,
  };
}
function mergedParams() {
  var p = activeProfile();
  return L.kernel.mergeParams(p, state.sessionParams);
}

/* ============================================================
   9. TOPBAR — 연결 스위처 · 모델 스위처 · 상태 램프
   ============================================================ */
function renderConnSwitcher() {
  var p = activeProfile();
  $('#connSwitchLabel').textContent = p ? p.label : '연결 없음';
  var lamp = $('#connSwitchLamp');
  lamp.dataset.state = p && p.status ? (p.status.state === 'ok' ? 'ok' : p.status.error ? 'err' : 'idle') : 'idle';
}
function buildConnMenu() {
  var menu = $('#connSwitchMenu'); menu.innerHTML = '';
  var profiles = L.profiles.list();
  var activeId = L.profiles.getActiveId();
  if (!profiles.length) { menu.appendChild(el('div', { class: 'list-empty', text: '연결이 없습니다.' })); }
  profiles.forEach(function (p) {
    var st = p.status && p.status.state === 'ok' ? 'ok' : (p.status && p.status.error ? 'err' : 'idle');
    var btn = el('button', { type: 'button', role: 'menuitem', class: p.id === activeId ? 'is-active' : '' }, [
      el('span', { class: 'lamp', dataset: { state: st } }),
      el('span', { class: 'menu__row' }, [
        el('span', { class: 'menu__row-main' }, [el('span', { text: p.label })]),
        el('span', { class: 'menu__sub', text: (p.model || '(모델 없음)') }),
      ]),
    ]);
    btn.addEventListener('click', function () { L.profiles.setActive(p.id); closeMenus(); });
    menu.appendChild(btn);
  });
  menu.appendChild(el('div', { class: 'menu__sep' }));
  var addBtn = el('button', { type: 'button', role: 'menuitem', html: '<span class="menu__row"><span class="menu__row-main">+ 새 연결</span></span>' });
  addBtn.addEventListener('click', function () { closeMenus(); openProfileEditor(null); });
  menu.appendChild(addBtn);
}
function renderModelSwitcher() {
  var p = activeProfile();
  var m = profileModel(p);
  $('#modelSwitchLabel').textContent = m ? ('모델 ' + m) : '모델 —';
}
function buildModelMenu() {
  var menu = $('#modelSwitchMenu'); menu.innerHTML = '';
  var p = activeProfile();
  var models = state.lastModels && state.lastModels.length ? state.lastModels : (p && p.status && p.status.models) || [];
  var current = profileModel(p);
  // 프로필 기본 모델도 항상 포함
  var all = [];
  if (p && p.model && models.indexOf(p.model) < 0) all.push(p.model);
  all = all.concat(models);
  if (!all.length) {
    menu.appendChild(el('div', { class: 'list-empty', text: '모델 목록이 없습니다.' }));
  }
  all.forEach(function (mid) {
    var btn = el('button', { type: 'button', role: 'menuitem', class: mid === current ? 'is-active' : '' }, [
      el('span', { class: 'menu__row' }, [el('span', { class: 'menu__row-main mono', text: mid })]),
    ]);
    btn.addEventListener('click', function () { state.activeModel = mid; renderModelSwitcher(); closeMenus(); toast('모델: ' + mid); });
    menu.appendChild(btn);
  });
  menu.appendChild(el('div', { class: 'menu__sep' }));
  var refresh = el('button', { type: 'button', role: 'menuitem', html: '<span class="menu__row"><span class="menu__row-main">↻ 헬스체크로 목록 새로고침</span></span>' });
  refresh.addEventListener('click', function () { closeMenus(); runHealthCheck(); });
  menu.appendChild(refresh);
}
function setStatus(stateName, text, latency) {
  $('#statusLamp').dataset.state = stateName;
  $('#connSwitchLamp').dataset.state = stateName === 'loading' ? 'warn' : stateName;
  $('#statusText').textContent = text;
  $('#statusLatency').textContent = latency != null ? (latency + 'ms') : '';
}
function runHealthCheck() {
  var p = activeProfile();
  if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
  setStatus('loading', '확인 중…', null);
  L.healthCheck(p.id).then(function (r) {
    if (r.ok) {
      state.lastModels = r.models || [];
      setStatus('ok', '정상 200', r.latencyMs);
      toast('연결 정상 · 모델 ' + (r.models ? r.models.length : 0) + '개', 'ok');
      if (r.models && r.models.length && (!state.activeModel && !p.model)) state.activeModel = r.models[0];
      renderModelSwitcher();
    } else {
      var lamp = (r.status === 401 || r.status === 403) ? 'err' : (r.status >= 500 || r.status === 0 ? 'err' : 'warn');
      setStatus(lamp, (r.status ? ('HTTP ' + r.status) : '오류'), r.latencyMs);
      toast('헬스체크 실패: ' + (r.error || r.status), 'err');
    }
    renderConnSwitcher(); renderConnList();
  });
}

/* ============================================================
   10. SIDEBAR — 연결 목록 / 워크벤치 네비 / 히스토리
   ============================================================ */
function renderConnList() {
  var list = $('#connList'); list.innerHTML = '';
  var profiles = L.profiles.list();
  var activeId = L.profiles.getActiveId();
  $('#connCount').textContent = profiles.length;
  if (!profiles.length) { list.appendChild(el('div', { class: 'conn-empty', text: '연결이 없습니다. "새 연결" 또는 Import로 추가하세요.' })); return; }
  profiles.forEach(function (p) {
    var st = p.status && p.status.state === 'ok' ? 'ok' : (p.status && p.status.error ? 'err' : 'idle');
    var card = el('div', { class: 'conn-card' + (p.id === activeId ? ' is-active' : ''), role: 'listitem' }, [
      el('div', { class: 'conn-card__top' }, [
        el('span', { class: 'lamp', dataset: { state: st } }),
        el('span', { class: 'conn-card__name', text: p.label, title: p.label }),
        (function () {
          var b = el('button', { class: 'btn-icon conn-card__menu', type: 'button', 'aria-label': '연결 메뉴' }, []);
          b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
          b.addEventListener('click', function (e) { e.stopPropagation(); openConnCardMenu(p, b); });
          return b;
        })(),
      ]),
      el('div', { class: 'conn-card__meta' }, [
        el('span', { class: 'conn-card__model', text: p.model || '(모델 없음)' }),
        p.network ? el('span', { class: 'badge-net', text: p.network }) : null,
      ]),
    ]);
    card.addEventListener('click', function () { L.profiles.setActive(p.id); });
    list.appendChild(card);
  });
}
function openConnCardMenu(p, anchor) {
  closeMenus();
  var menu = el('div', { class: 'menu', role: 'menu' });
  var items = [
    { label: '편집', fn: function () { openProfileEditor(p.id); } },
    { label: '헬스체크', fn: function () { L.profiles.setActive(p.id); runHealthCheck(); } },
    { label: '복제', fn: function () { L.profiles.duplicate(p.id); toast('복제됨'); } },
    { label: 'Export', fn: function () { openExport('llm', p.id); } },
    { label: '삭제', danger: true, fn: function () { confirmDialog('연결 "' + p.label + '"을(를) 삭제할까요?', function () { L.profiles.remove(p.id); toast('삭제됨'); }); } },
  ];
  items.forEach(function (it) {
    var b = el('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', text: it.label });
    b.addEventListener('click', function () { closeMenus(); it.fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  var r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed'; menu.style.top = (r.bottom + 4) + 'px'; menu.style.left = Math.max(8, r.right - 180) + 'px'; menu.style.zIndex = 70;
  menu.dataset.floating = '1';
  _floatingMenu = menu;
}
var _floatingMenu = null;

function renderWbNav() {
  var nav = $('#wbNav'); nav.innerHTML = '';
  TABS.forEach(function (t) {
    var item = el('button', { type: 'button', class: 'wb-nav__item' + (t.id === state.ui.activeTab ? ' is-active' : '') }, []);
    item.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="' + t.icon + '"/></svg><span>' + escapeHtml(t.label) + '</span>' + (t.tag ? '<span class="wb-nav__tag">' + t.tag + '</span>' : '');
    item.addEventListener('click', function () { switchTab(t.id); });
    nav.appendChild(item);
  });
}
function renderTabbar() {
  var bar = $('#tabbar'); bar.innerHTML = '';
  TABS.forEach(function (t) {
    var tab = el('button', { type: 'button', role: 'tab', class: 'tab' + (t.id === state.ui.activeTab ? ' is-active' : ''), 'aria-selected': t.id === state.ui.activeTab });
    tab.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="' + t.icon + '"/></svg><span>' + escapeHtml(t.label) + '</span>' + (t.tag ? '<span class="tab__tag">' + t.tag + '</span>' : '');
    tab.addEventListener('click', function () { switchTab(t.id); });
    bar.appendChild(tab);
  });
}
function switchTab(id) {
  state.ui.activeTab = id; saveUI();
  TABS.forEach(function (t) { var panel = $('#panel-' + t.id); if (panel) panel.hidden = (t.id !== id); });
  renderTabbar(); renderWbNav();
  var panel = $('#panel-' + id);
  if (panel && !panel.dataset.built) {
    if (id === 'rag') RAG.build(panel);
    else if (id === 'chain') CHAIN.build(panel);
    else if (id === 'agent') AGENT.build(panel);
    else if (id === 'eval') EVAL.build(panel);
    else if (id === 'batch') BATCH.build(panel);
    else if (id === 'sim') SIM.build(panel);
    else if (id !== 'chat') buildPlaceholder(id);
  }
  if (id === 'rag' && RAG.onShow) RAG.onShow();
  if (id === 'chain' && CHAIN.onShow) CHAIN.onShow();
  if (window.innerWidth <= 899) closeSidebar();
  if (id === 'chat') $('#chatInput').focus();
}
function buildPlaceholder(id) {
  var info = PLACEHOLDER_INFO[id]; if (!info) return;
  var panel = $('#panel-' + id); panel.dataset.built = '1';
  var tab = TABS.filter(function (t) { return t.id === id; })[0];
  panel.appendChild(el('div', { class: 'placeholder' }, [
    (function () { var g = el('div', { class: 'placeholder__glyph' }); g.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="' + tab.icon + '"/></svg>'; return g; })(),
    el('div', { class: 'placeholder__title', text: info.title }),
    el('div', { class: 'placeholder__pill', text: '다음 단계에서 제공 · ' + (tab.tag || '') }),
    el('div', { class: 'placeholder__sub', text: info.sub }),
    (function () { var ul = el('ul', { class: 'placeholder__list' }); info.items.forEach(function (i) { ul.appendChild(el('li', { text: i })); }); return ul; })(),
  ]));
}

/* ---- 사이드바 섹션 접기 ---- */
function initSideSections() {
  $$('.side-sec__head').forEach(function (head) {
    head.addEventListener('click', function () {
      var sec = document.getElementById(head.dataset.toggle);
      var open = sec.dataset.open === 'true';
      sec.dataset.open = open ? 'false' : 'true';
      head.setAttribute('aria-expanded', String(!open));
    });
  });
}
function openSidebar() { state.ui.sidebarOpen = true; $('#app').classList.add('sidebar-open'); $('#sidebarBackdrop').hidden = false; }
function closeSidebar() { state.ui.sidebarOpen = false; $('#app').classList.remove('sidebar-open'); $('#sidebarBackdrop').hidden = true; }

/* ============================================================
   11. 연결 프로필 편집기
   ============================================================ */
var _editingId = null;
var _profilePasteExtras = null; // 붙여넣기로 감지된 params/server/notes/examples (새 연결 저장 시 보존)

/* ============================================================
   11-b. JSON 붙여넣기 → 자동 분석·채우기 (공용, 순수 파싱 · AI 불필요)
   ============================================================ */
var LLM_KNOWN_KEYS = ['schemaVersion', 'service', 'network', 'base_url', 'host', 'port', 'model', 'model_note', 'auth', 'endpoints', 'params', 'server', 'notes', 'examples', '__id', 'id', 'type', 'profiles', 'exportedAt'];
var DB_KNOWN_KEYS = ['schemaVersion', 'kind', 'id', '__id', 'label', 'type', 'network', 'connection', 'options', 'vector', 'graph', 'notes', 'connections', 'exportedAt'];
function _isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

// 모듈 레벨 아코디언 빌더(폼 내부 acc()와 동일 스타일)
function makeAcc(title, hint, open, inner, attrs) {
  attrs = attrs || {};
  var wrap = el('div', { class: attrs.class || 'acc', id: attrs.id, dataset: { open: open ? 'true' : 'false' } });
  var head = el('button', { type: 'button', class: 'acc__head' });
  head.innerHTML = '<svg class="ic acc__chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="acc__title">' + escapeHtml(title) + '</span>' + (hint ? '<span class="acc__hint">' + escapeHtml(hint) + '</span>' : '');
  head.addEventListener('click', function () { var o = wrap.dataset.open === 'true'; wrap.dataset.open = o ? 'false' : 'true'; });
  wrap.appendChild(head);
  wrap.appendChild(el('div', { class: 'acc__body' }, inner));
  return wrap;
}

function buildJsonPasteSection(kind) {
  var isDb = kind === 'db';
  var ta = el('textarea', { class: 'field field-mono', rows: 6, placeholder: isDb
    ? '{ "kind":"db-connection", "label":"연구 코퍼스", "type":"pgvector", "connection":{ "host":"db.example.com", "port":5432, "database":"ragdb", "user":"rag_ro" }, "vector":{ "table":"chunks", "embedding_column":"embedding", "dim":384 } }'
    : '{ "service":"My vLLM", "base_url":"https://host/v1", "model":"모델id", "auth":{ "type":"bearer", "api_key":"..." } }' });
  var report = el('div', { class: 'paste-report', hidden: 'hidden' });
  var analyzeBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '분석하여 채우기' });
  analyzeBtn.addEventListener('click', function () { runPasteAnalyze(kind, ta, report); });
  var clearBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '지우기' });
  clearBtn.addEventListener('click', function () { ta.value = ''; report.hidden = true; report.innerHTML = ''; });
  var hint = el('p', { class: 'modal__hint', html:
    'JSON을 붙여넣고 <b>분석하여 채우기</b>를 누르면 아래 폼이 자동으로 채워집니다(로컬 파싱, AI 호출 없음). '
    + '단일 객체 · 배열 · 묶음(' + (isDb ? '<code>type:"llm-lab-db-connections"</code>' : '<code>type:"llm-lab-profiles"</code>') + ') 모두 인식합니다. '
    + '값은 채워진 뒤에도 직접 수정할 수 있고, <b>저장</b> 전까지 등록되지 않습니다. 형식 정본: <code>docs/API_프로필_형식_가이드.md</code>' });
  return makeAcc('JSON 붙여넣기 → 자동 채우기', 'AI 불필요 · 로컬 파싱', false,
    [hint, el('div', { class: 'field-col' }, [ta]), el('div', { class: 'side-actions' }, [analyzeBtn, clearBtn]), report],
    { class: 'acc json-paste' });
}

function _pasteDetect(data, kind) {
  if (Array.isArray(data)) return { list: data.filter(_isObj), form: 'array' };
  if (_isObj(data)) {
    if (kind !== 'db' && Array.isArray(data.profiles)) return { list: data.profiles.filter(_isObj), form: 'bundle' };
    if (kind === 'db' && Array.isArray(data.connections)) return { list: data.connections.filter(_isObj), form: 'bundle' };
    return { list: [data], form: 'single' };
  }
  return { list: [], form: 'invalid' };
}

function _jsonErrHint(text, e) {
  var msg = (e && e.message) ? e.message : String(e);
  var m = /position\s+(\d+)/i.exec(msg);
  if (m) {
    var pos = Number(m[1]);
    var before = text.slice(0, pos);
    var line = before.split('\n').length;
    var col = pos - before.lastIndexOf('\n');
    return msg + ' (약 ' + line + '행 ' + col + '열 부근)';
  }
  return msg;
}

function pasteReportError(reportEl, msg) {
  reportEl.hidden = false; reportEl.innerHTML = '';
  reportEl.appendChild(el('div', { class: 'err', text: '✕ ' + msg }));
  reportEl.appendChild(el('div', { class: 'field-note', text: '폼은 변경되지 않았습니다.' }));
}

function runPasteAnalyze(kind, ta, reportEl) {
  var text = (ta.value || '').trim();
  if (!text) { pasteReportError(reportEl, 'JSON을 먼저 붙여넣어 주세요.'); return; }
  var data;
  try { data = JSON.parse(text); }
  catch (e) { pasteReportError(reportEl, 'JSON 파싱 실패 — ' + _jsonErrHint(text, e)); return; }
  var det = _pasteDetect(data, kind);
  if (!det.list.length) { pasteReportError(reportEl, '유효한 ' + (kind === 'db' ? 'DB 연결' : '프로필') + ' 객체를 찾지 못했습니다.'); return; }
  var raw0 = det.list[0];
  var np;
  try { np = (kind === 'db') ? L.db.fromUserJSON(raw0, {}) : L.profiles.fromUserJSON(raw0, {}); }
  catch (e) { pasteReportError(reportEl, '정규화 실패 — ' + ((e && e.message) || e)); return; }
  if (kind === 'db') fillDbFormFromNormalized(np);
  else fillProfileFormFromNormalized(np, raw0);
  renderPasteReport(reportEl, kind, raw0, np, det);
}

function renderPasteReport(reportEl, kind, raw0, np, det) {
  reportEl.hidden = false; reportEl.innerHTML = '';
  reportEl.appendChild(el('div', { class: 'paste-report__title', text: '분석 완료 — 아래 폼을 채웠습니다' }));
  var chips = el('div', { class: 'paste-chips' });
  function chip(t, warn) { chips.appendChild(el('span', { class: 'paste-chip', dataset: warn ? { kind: 'warn' } : {}, text: t })); }
  var warns = [];
  if (kind === 'db') {
    chip('type=' + np.type);
    if (np.connection.host) chip('host=' + np.connection.host + (np.connection.port ? (':' + np.connection.port) : ''));
    if (np.connection.uri) chip('uri=' + np.connection.uri);
    if (np.connection.db_path) chip('db_path=' + np.connection.db_path);
    if (np.connection.database) chip('database=' + np.connection.database);
    if (np.vector) chip('vector: ' + (np.vector.table || '?'));
    if (np.graph) chip('graph: ' + (np.graph.entity_label || 'Entity'));
    chip('readonly=' + (np.options.readonly ? 'on' : 'off'));
    if (np.type !== 'sqlite' && !np.connection.host && !np.connection.uri) warns.push('host(또는 uri)가 없습니다.');
    if (np.type === 'sqlite' && !np.connection.db_path) warns.push('db_path가 없습니다 — 필수 항목입니다.');
    if (np.type === 'pgvector' && !np.vector) warns.push('type=pgvector인데 vector 설정이 없습니다.');
    if (np.type === 'neo4j' && !np.graph) warns.push('type=neo4j인데 graph 설정이 없습니다.');
  } else {
    chip('base_url=' + (np.baseURL || '(없음)'), !np.baseURL);
    chip('model=' + (np.model || '(없음)'), !np.model);
    chip('auth=' + (np.auth.scheme || 'none'), np.auth.scheme === 'bearer' && !np.auth.key);
    var pc = _isObj(raw0.params) ? Object.keys(raw0.params).length : 0;
    if (pc) chip('params ' + pc + '개');
    if (np.host) chip('host=' + np.host + (np.port ? (':' + np.port) : ''));
    if (!np.baseURL) warns.push('base_url이 없습니다 — 필수 항목입니다.');
    if (!np.model) warns.push('model이 없습니다 — 필수 항목입니다.');
    if (np.auth.scheme === 'bearer' && !np.auth.key) warns.push('auth=bearer인데 api_key가 비어 있습니다.');
    if (np.auth.scheme === 'custom' && !np.auth.headerSpec) warns.push('auth=custom인데 header 사양이 없습니다.');
  }
  reportEl.appendChild(chips);
  if (det.form === 'bundle' || det.form === 'array') {
    reportEl.appendChild(el('div', { class: 'warn', text: '⚠ 묶음 감지: ' + det.list.length + '개 중 1개를 폼에 채웠습니다. 나머지는 상단 [Import]로 한 번에 추가하세요.' }));
  }
  var known = kind === 'db' ? DB_KNOWN_KEYS : LLM_KNOWN_KEYS;
  var unknown = Object.keys(raw0 || {}).filter(function (k) { return known.indexOf(k) < 0; });
  if (unknown.length) warns.push('알 수 없는 필드(무시됨): ' + unknown.join(', '));
  warns.forEach(function (w) { reportEl.appendChild(el('div', { class: 'warn', text: '⚠ ' + w })); });
  reportEl.appendChild(el('div', { class: 'ok', text: '값을 검토·수정한 뒤 [저장]으로 등록하세요.' }));
}

function fillProfileFormFromNormalized(np, raw0) {
  function setVal(id, v) { var e = $('#' + id); if (e) e.value = (v == null ? '' : v); }
  setVal('pf_label', (np.label && np.label !== '(unnamed)') ? np.label : '');
  setVal('pf_baseURL', np.baseURL);
  setVal('pf_host', np.host);
  setVal('pf_port', np.port);
  setVal('pf_model', np.model);
  setVal('pf_modelNote', np.modelNote);
  setVal('pf_network', np.network);
  var authSel = $('#pf_authType'); if (authSel && np.auth) authSel.value = np.auth.scheme || 'bearer';
  setVal('pf_apiKey', np.auth ? np.auth.key : '');
  setVal('pf_headerSpec', np.auth ? np.auth.headerSpec : '');
  if (np.ep) { setVal('pf_ep_chat', np.ep.chat); setVal('pf_ep_completions', np.ep.completions); setVal('pf_ep_models', np.ep.models); setVal('pf_ep_embeddings', np.ep.embeddings); }
  // 채워진 값이 보이도록 아코디언 펼침
  $$('#profileBody .acc').forEach(function (a) { a.dataset.open = 'true'; });
  // 새 연결 저장 시 폼에 없는 메타(params/server/notes/examples) 보존
  _profilePasteExtras = {};
  if (_isObj(raw0.params) && np.params) _profilePasteExtras.params = np.params;
  if (np.server && Object.keys(np.server).length) _profilePasteExtras.server = np.server;
  if (np.notes && np.notes.length) _profilePasteExtras.notes = np.notes.slice();
  if (np.examples && Object.keys(np.examples).length) _profilePasteExtras.examples = np.examples;
}

function fillDbFormFromNormalized(np) {
  function setVal(id, v) { var e = $('#' + id); if (e) e.value = (v == null ? '' : v); }
  function setSel(id, v) { var e = $('#' + id); if (e && v != null) e.value = v; }
  function setSwitch(id, on) { var e = $('#' + id); if (e) e.setAttribute('aria-checked', String(!!on)); }
  var c = np.connection || {}, o = np.options || {}, v = np.vector || null, g = np.graph || null;
  setVal('dbf_label', (np.label && np.label !== '(unnamed db)') ? np.label : '');
  setSel('dbf_type', np.type);
  if (typeof updateDbTypeUI === 'function') updateDbTypeUI();
  setVal('dbf_network', np.network);
  setVal('dbf_db_path', c.db_path);
  setVal('dbf_host', c.host);
  setVal('dbf_port', c.port);
  setVal('dbf_database', c.database);
  setVal('dbf_user', c.user);
  setVal('dbf_password', c.password);
  setVal('dbf_uri', c.uri);
  setSwitch('dbf_tls', c.tls && c.tls.enabled);
  setSwitch('dbf_readonly', o.readonly !== false);
  setVal('dbf_ct', o.connect_timeout_ms);
  setVal('dbf_st', o.statement_timeout_ms);
  setVal('dbf_rowcap', o.row_cap);
  if (v) {
    setVal('dbf_v_table', v.table); setVal('dbf_v_emb', v.embedding_column);
    setVal('dbf_v_id', v.id_column || 'id'); setVal('dbf_v_text', v.text_column || 'text');
    setVal('dbf_v_meta', (v.metadata_columns || []).join(',')); setVal('dbf_v_dim', v.dim != null ? v.dim : 384);
    setSel('dbf_metric', v.metric || 'cosine'); setSel('dbf_index', v.index || 'hnsw');
  }
  if (g) {
    setVal('dbf_g_db', g.database || 'neo4j'); setVal('dbf_g_entity', g.entity_label || 'Entity');
    setVal('dbf_g_comm', g.community_label || 'Community'); setVal('dbf_g_rels', (g.rel_types || []).join(','));
    setVal('dbf_g_name', g.name_property || 'name'); setVal('dbf_g_summary', g.summary_property || 'summary');
  }
  setVal('dbf_notes', (np.notes || []).join('\n'));
  $$('#dbBody .acc').forEach(function (a) { a.dataset.open = 'true'; });
}

function openProfileEditor(id) {
  _editingId = id;
  _profilePasteExtras = null;
  var p = id ? L.profiles.get(id) : null;
  $('#profileTitle').textContent = p ? '연결 편집' : '새 연결';
  $('#profileDelete').style.display = p ? '' : 'none';
  $('#profileDup').style.display = p ? '' : 'none';
  $('#profileExportOne').style.display = p ? '' : 'none';
  buildProfileForm(p);
  openOverlay('#profileOverlay');
}
function buildProfileForm(p) {
  var body = $('#profileBody'); body.innerHTML = '';
  var d = p || { label: '', baseURL: '', host: '', port: '', model: '', modelNote: '', network: '',
    auth: { scheme: 'bearer', key: '', headerSpec: '' }, ep: {}, server: {}, notes: [], examples: {} };

  function acc(title, hint, open, inner) {
    var wrap = el('div', { class: 'acc', dataset: { open: open ? 'true' : 'false' } });
    var head = el('button', { type: 'button', class: 'acc__head' }, []);
    head.innerHTML = '<svg class="ic acc__chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="acc__title">' + escapeHtml(title) + '</span>' + (hint ? '<span class="acc__hint">' + escapeHtml(hint) + '</span>' : '');
    var bodyEl = el('div', { class: 'acc__body' }, inner);
    head.addEventListener('click', function () { var o = wrap.dataset.open === 'true'; wrap.dataset.open = o ? 'false' : 'true'; });
    wrap.appendChild(head); wrap.appendChild(bodyEl); return wrap;
  }
  function fcol(labelText, input) { return el('div', { class: 'field-col' }, [el('label', { text: labelText }), input]); }
  function inp(id, val, ph) { return el('input', { type: 'text', class: 'field', id: id, value: val == null ? '' : val, placeholder: ph || '' }); }

  // JSON 붙여넣기 → 자동 채우기 (최상단)
  body.appendChild(buildJsonPasteSection('llm'));

  // Connection
  body.appendChild(acc('Connection', 'service · base_url · model', true, [
    fcol('연결 이름 (service) *', inp('pf_label', d.label, '예: My vLLM')),
    fcol('base_url *', inp('pf_baseURL', d.baseURL, 'http://host:port/v1')),
    el('div', { class: 'param-grid' }, [
      fcol('host', inp('pf_host', d.host)),
      fcol('port', inp('pf_port', d.port)),
    ]),
    fcol('model *', inp('pf_model', d.model, '모델 id')),
    fcol('model_note', inp('pf_modelNote', d.modelNote)),
    fcol('network (접근 범위)', inp('pf_network', d.network, 'intranet-only / public / localhost')),
  ]));

  // Auth
  var authSel = el('select', { class: 'field', id: 'pf_authType' });
  ['bearer', 'none', 'custom'].forEach(function (s) { var o = el('option', { value: s, text: s }); if (d.auth.scheme === s) o.selected = true; authSel.appendChild(o); });
  var keyInput = el('input', { type: 'password', class: 'field', id: 'pf_apiKey', value: d.auth.key || '', placeholder: 'API 키' });
  var showKey = el('label', { class: 'reason-toggle' }, [(function () { var c = el('input', { type: 'checkbox' }); c.addEventListener('change', function () { keyInput.type = c.checked ? 'text' : 'password'; }); return c; })(), el('span', { text: '키 표시' })]);
  body.appendChild(acc('Auth', d.auth.key ? L.util.maskKey(d.auth.key) : 'type', false, [
    fcol('type', authSel),
    fcol('api_key', el('div', { class: 'field-col' }, [keyInput, showKey])),
    fcol('header (custom용, 예: X-API-Key: <api_key>)', inp('pf_headerSpec', d.auth.headerSpec)),
  ]));

  // Endpoints
  var dep = L.util.deriveEndpoints(d.baseURL);
  body.appendChild(acc('Endpoints', 'base_url서 자동 유도', false, [
    fcol('chat_completions', inp('pf_ep_chat', (d.ep && d.ep.chat) || dep.chat)),
    fcol('completions', inp('pf_ep_completions', (d.ep && d.ep.completions) || dep.completions)),
    fcol('models', inp('pf_ep_models', (d.ep && d.ep.models) || dep.models)),
    fcol('embeddings', inp('pf_ep_embeddings', (d.ep && d.ep.embeddings) || dep.embeddings)),
    (function () { var b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'base_url에서 자동 채움' }); b.addEventListener('click', function () { var base = $('#pf_baseURL').value; var e = L.util.deriveEndpoints(base); $('#pf_ep_chat').value = e.chat; $('#pf_ep_completions').value = e.completions; $('#pf_ep_models').value = e.models; $('#pf_ep_embeddings').value = e.embeddings; }); return b; })(),
  ]));

  // Server (read-only) + Notes
  var serverInner = [];
  if (d.server && Object.keys(d.server).length) {
    var dl = el('dl', { class: 'kv-static' });
    Object.keys(d.server).forEach(function (k) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: String(d.server[k]) })); });
    serverInner.push(el('div', { class: 'field-col' }, [el('label', { text: '서버 정보 (읽기전용)' }), dl]));
  } else serverInner.push(el('div', { class: 'field-note', text: '서버 메타 없음' }));
  if (d.notes && d.notes.length) {
    var ul = el('ul', { class: 'notes-list' }); d.notes.forEach(function (n) { ul.appendChild(el('li', { text: n })); });
    serverInner.push(el('div', { class: 'field-col' }, [el('label', { text: '주의사항 (notes)' }), ul]));
  }
  if (d.examples && (d.examples.curl || d.examples.python)) {
    if (d.examples.curl) serverInner.push(fcol('examples.curl', el('textarea', { class: 'field field-mono', rows: 3, readonly: 'readonly', text: d.examples.curl })));
  }
  body.appendChild(acc('Server / Notes / Examples', '읽기전용 메타', false, serverInner));

  // 진단 결과 영역
  body.appendChild(el('div', { id: 'pf_diag' }));
}
function collectProfileForm() {
  var u = {
    schemaVersion: '1',
    service: $('#pf_label').value.trim(),
    base_url: $('#pf_baseURL').value.trim(),
    host: $('#pf_host').value.trim() || undefined,
    port: $('#pf_port').value ? Number($('#pf_port').value) : undefined,
    model: $('#pf_model').value.trim(),
    model_note: $('#pf_modelNote').value.trim() || undefined,
    network: $('#pf_network').value.trim() || undefined,
    auth: { type: $('#pf_authType').value, api_key: $('#pf_apiKey').value, header: $('#pf_headerSpec').value.trim() || undefined },
    endpoints: {
      chat_completions: $('#pf_ep_chat').value.trim(),
      completions: $('#pf_ep_completions').value.trim(),
      models: $('#pf_ep_models').value.trim(),
      embeddings: $('#pf_ep_embeddings').value.trim() || undefined,
    },
  };
  // 편집 시 기존 server/notes/examples/params 보존
  if (_editingId) {
    var ex = L.profiles.get(_editingId);
    if (ex) {
      if (ex.server && Object.keys(ex.server).length) u.server = ex.server;
      if (ex.notes && ex.notes.length) u.notes = ex.notes;
      if (ex.examples && Object.keys(ex.examples).length) u.examples = ex.examples;
      if (ex.params) u.params = ex.params;
    }
  } else if (_profilePasteExtras) {
    // 새 연결: 붙여넣기로 감지된, 폼에 없는 메타 보존
    if (_profilePasteExtras.server) u.server = _profilePasteExtras.server;
    if (_profilePasteExtras.notes) u.notes = _profilePasteExtras.notes;
    if (_profilePasteExtras.examples) u.examples = _profilePasteExtras.examples;
    if (_profilePasteExtras.params) u.params = _profilePasteExtras.params;
  }
  return u;
}
function saveProfileForm() {
  var u = collectProfileForm();
  var v = L.profiles.validate(u);
  if (!v.ok) { toast('저장 불가: ' + v.errors[0], 'err'); return; }
  if (v.warnings.length) toast('경고: ' + v.warnings[0], 'warn');
  if (_editingId) {
    var p = L.profiles.fromUserJSON(u, { id: _editingId });
    // update via replace: 편집은 내부 patch로 반영
    L.profiles.update(_editingId, {
      label: p.label, baseURL: p.baseURL, host: p.host, port: p.port, model: p.model, modelNote: p.modelNote,
      network: p.network, auth: p.auth, ep: p.ep, notes: p.notes, examples: p.examples, server: p.server,
    });
    toast('저장됨');
  } else {
    var np = L.profiles.add(u, { activate: true });
    toast('연결 추가됨: ' + np.label);
  }
  closeOverlay('#profileOverlay');
}
function testProfileConnection() {
  var u = collectProfileForm();
  var diagEl = $('#pf_diag'); diagEl.innerHTML = '<div class="diag-step"><span class="lamp" data-state="loading"></span><span class="diag-step__name">연결 테스트 중…</span></div>';
  L.diagnose(u).then(function (rep) {
    diagEl.innerHTML = '';
    var wrap = el('div', { class: 'diag' });
    rep.steps.forEach(function (s) {
      var row = el('div', { class: 'diag-step' }, [
        el('span', { class: 'lamp', dataset: { state: s.ok ? 'ok' : 'err' } }),
        el('span', { class: 'diag-step__name', text: s.name + ' — ' + (s.summary || '') }),
        el('span', { class: 'diag-step__ms', text: s.ms != null ? (s.ms + 'ms') : '' }),
      ]);
      wrap.appendChild(row);
      if (s.name === 'models' && s.models && s.models.length) {
        var ml = el('div', { class: 'models-list' });
        s.models.slice(0, 20).forEach(function (m) { ml.appendChild(el('span', { class: 'model-chip', text: m })); });
        wrap.appendChild(ml);
      }
    });
    diagEl.appendChild(wrap);
    toast(rep.ok ? '진단 완료 — 정상' : '진단 완료 — 문제 발견', rep.ok ? 'ok' : 'warn');
  });
}

/* ============================================================
   12. Import / Export (LLM 프로필 · DB 연결 공용)
   ============================================================ */
var _ioKind = 'llm'; // 'llm' | 'db'
function ioStore() { return _ioKind === 'db' ? L.db : L.profiles; }

function openImport(kind) {
  _ioKind = kind === 'db' ? 'db' : 'llm';
  $('#importTitle').textContent = _ioKind === 'db' ? 'DB 연결 가져오기' : '연결 가져오기';
  var hint = $('#importHint');
  if (hint) hint.innerHTML = _ioKind === 'db'
    ? '단일 DB 연결(<code>kind:"db-connection"</code>) 또는 묶음(<code>type:"llm-lab-db-connections"</code>)을 자동 감지합니다. JSON 붙여넣기 또는 파일(.json)을 선택하세요.'
    : '단일 프로필 객체 또는 묶음(<code>type:"llm-lab-profiles"</code>)을 자동 감지합니다. JSON 붙여넣기 또는 파일(.json)을 선택하세요.';
  $('#importText').value = ''; $('#importFilename').textContent = '';
  $('#importReport').hidden = true; $('#importReport').innerHTML = '';
  openOverlay('#importOverlay');
}
function doImport() {
  var text = $('#importText').value.trim();
  if (!text) { toast('가져올 JSON을 입력하거나 파일을 선택하세요.', 'warn'); return; }
  var res = ioStore().import(text, { onDuplicate: function () { return 'add'; } });
  var rep = $('#importReport'); rep.hidden = false; rep.innerHTML = '';
  rep.appendChild(el('div', { class: 'ok', text: '추가 ' + res.added.length + ' · 갱신 ' + res.updated.length + ' · 건너뜀 ' + res.skipped.length + ' (' + res.kind + ')' }));
  res.added.forEach(function (p) { rep.appendChild(el('div', { text: '+ ' + p.label })); });
  (res.warnings || []).forEach(function (w) { rep.appendChild(el('div', { class: 'warn', text: '⚠ ' + (w.service || w.label || '') + ': ' + w.warnings.join('; ') })); });
  (res.errors || []).forEach(function (e) { rep.appendChild(el('div', { class: 'err', text: '✕ ' + (e.service || e.label || '') + ': ' + e.errors.join('; ') })); });
  if (res.added.length || res.updated.length) {
    toast('가져오기 완료: +' + res.added.length, 'ok');
    setTimeout(function () { closeOverlay('#importOverlay'); }, 900);
  }
}
function openExport(kind, singleId) {
  _ioKind = kind === 'db' ? 'db' : 'llm';
  $('#exportTitle').textContent = _ioKind === 'db' ? 'DB 연결 내보내기' : '연결 내보내기';
  var lbl = $('#exportKeyLabel');
  if (lbl) lbl.innerHTML = _ioKind === 'db'
    ? '비밀번호 포함 <span class="field-note">(공유 시 주의 — 기본 제외 권장)</span>'
    : 'API 키 포함 <span class="field-note">(공유 시 주의 — 기본 제외 권장)</span>';
  $('#exportIncludeKey').setAttribute('aria-checked', 'false');
  $('#exportModal').dataset.single = singleId || '';
  refreshExportPreview();
  openOverlay('#exportOverlay');
}
function refreshExportPreview() {
  var includeSecret = $('#exportIncludeKey').getAttribute('aria-checked') === 'true';
  var single = $('#exportModal').dataset.single;
  var opts = _ioKind === 'db' ? { redactPassword: !includeSecret } : { includeKey: includeSecret };
  var store = ioStore();
  var text = single ? store.exportOne(single, opts) : store.exportAll(opts);
  $('#exportPreview').value = text || '(없음)';
}
function doExportDownload() {
  var includeSecret = $('#exportIncludeKey').getAttribute('aria-checked') === 'true';
  var single = $('#exportModal').dataset.single;
  var store = ioStore();
  var opts = _ioKind === 'db' ? { redactPassword: !includeSecret } : { includeKey: includeSecret };
  if (single) {
    var p = store.get(single);
    var base = p ? p.label.replace(/[^\w가-힣.-]+/g, '_') : (_ioKind === 'db' ? 'db-connection' : 'profile');
    downloadFile(base + '.json', store.exportOne(single, opts));
  } else {
    downloadFile(_ioKind === 'db' ? 'llm-lab-db-connections.json' : 'llm-lab-profiles.json', store.exportAll(opts));
  }
  toast('다운로드' + (includeSecret ? ' (비밀 포함)' : ' (비밀 제외)'), includeSecret ? 'warn' : 'ok');
}

/* ============================================================
   12b. DB 연결 관리 (사이드바 · 편집기 · 테스트)
   ============================================================ */
var DB_TYPE_LABEL = { sqlite: 'SQLite', mysql: 'MySQL', postgres: 'PostgreSQL', pgvector: 'pgvector', neo4j: 'Neo4j' };
var _dbEditingId = null;

function renderDbList() {
  var listEl = $('#dbList'); if (!listEl) return;
  listEl.innerHTML = '';
  var conns = L.db ? L.db.list() : [];
  $('#dbCount').textContent = String(conns.length);
  if (!conns.length) {
    listEl.appendChild(el('div', { class: 'field-note', text: '연결된 DB 없음 — 새 DB로 SQLite/pgvector/Neo4j 등을 추가' }));
    return;
  }
  conns.forEach(function (p) {
    var st = p.status || {};
    var lampState = st.state === 'ok' ? 'ok' : (st.state === 'err' ? 'err' : 'idle');
    var card = el('div', { class: 'conn-card', role: 'listitem' }, [
      el('div', { class: 'conn-card__top' }, [
        el('span', { class: 'lamp', dataset: { state: lampState } }),
        el('span', { class: 'conn-card__name', text: p.label }),
        el('span', { class: 'db-type db-type--' + p.type, text: DB_TYPE_LABEL[p.type] || p.type }),
        (function () {
          var b = el('button', { class: 'btn-icon conn-card__menu', type: 'button', 'aria-label': 'DB 메뉴' });
          b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
          b.addEventListener('click', function (e) { e.stopPropagation(); openDbCardMenu(p, b); });
          return b;
        })(),
      ]),
      el('div', { class: 'conn-card__meta' }, [
        el('span', { class: 'conn-card__model', text: dbTarget(p) }),
        (st.provider ? provBadge(st.provider) : null),
      ]),
    ]);
    card.addEventListener('click', function () { openDbEditor(p.id); });
    listEl.appendChild(card);
  });
}
function dbTarget(p) {
  var c = p.connection || {};
  if (p.type === 'sqlite') return c.db_path || '(파일 미지정)';
  if (p.type === 'neo4j') return c.uri || ((c.host || '') + ':' + (c.port || 7473));
  return (c.host || '') + ':' + (c.port || '') + (c.database ? '/' + c.database : '');
}
function openDbCardMenu(p, anchor) {
  closeMenus();
  var menu = el('div', { class: 'menu', role: 'menu' });
  var items = [
    { label: '편집', fn: function () { openDbEditor(p.id); } },
    { label: '연결 테스트', fn: function () { openDbEditor(p.id); setTimeout(testDbConnection, 60); } },
    { label: '복제', fn: function () { L.db.duplicate(p.id); toast('복제됨'); } },
    { label: 'Export', fn: function () { openExport('db', p.id); } },
    { label: '삭제', danger: true, fn: function () { confirmDialog('DB 연결 "' + p.label + '"을(를) 삭제할까요?', function () { L.db.remove(p.id); toast('삭제됨'); }); } },
  ];
  items.forEach(function (it) {
    var b = el('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', text: it.label });
    b.addEventListener('click', function () { closeMenus(); it.fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  var r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed'; menu.style.top = (r.bottom + 4) + 'px'; menu.style.left = Math.max(8, r.right - 180) + 'px'; menu.style.zIndex = 70;
  menu.dataset.floating = '1';
  _floatingMenu = menu;
}

function openDbEditor(id) {
  _dbEditingId = id;
  var p = id ? L.db.get(id) : null;
  $('#dbTitle').textContent = p ? 'DB 연결 편집' : '새 DB 연결';
  $('#dbDelete').style.display = p ? '' : 'none';
  $('#dbDup').style.display = p ? '' : 'none';
  $('#dbExportOne').style.display = p ? '' : 'none';
  buildDbForm(p);
  openOverlay('#dbOverlay');
}

function dbSwitch(id, on) {
  var b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!on), type: 'button', id: id });
  b.addEventListener('click', function () { var v = b.getAttribute('aria-checked') === 'true'; b.setAttribute('aria-checked', String(!v)); });
  return b;
}

function buildDbForm(p) {
  var body = $('#dbBody'); body.innerHTML = '';
  var d = p || { label: '', type: 'sqlite', network: '', connection: { tls: { enabled: false } }, options: {}, vector: null, graph: null, notes: [] };
  var c = d.connection || {}; var o = d.options || {}; var v = d.vector || {}; var g = d.graph || {};

  function acc(title, hint, open, inner, attrs) {
    var wrap = el('div', Object.assign({ class: 'acc', dataset: { open: open ? 'true' : 'false' } }, attrs || {}));
    var head = el('button', { type: 'button', class: 'acc__head' }, []);
    head.innerHTML = '<svg class="ic acc__chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="acc__title">' + escapeHtml(title) + '</span>' + (hint ? '<span class="acc__hint">' + escapeHtml(hint) + '</span>' : '');
    var bodyEl = el('div', { class: 'acc__body' }, inner);
    head.addEventListener('click', function () { var op = wrap.dataset.open === 'true'; wrap.dataset.open = op ? 'false' : 'true'; });
    wrap.appendChild(head); wrap.appendChild(bodyEl); return wrap;
  }
  function fcol(t, input) { return el('div', { class: 'field-col' }, [el('label', { text: t }), input]); }
  function inp(id, val, ph, type) { return el('input', { type: type || 'text', class: 'field', id: id, value: val == null ? '' : val, placeholder: ph || '' }); }

  // JSON 붙여넣기 → 자동 채우기 (최상단)
  body.appendChild(buildJsonPasteSection('db'));

  // 기본
  var typeSel = el('select', { class: 'field', id: 'dbf_type' });
  L.db.TYPES.forEach(function (t) { var op = el('option', { value: t, text: DB_TYPE_LABEL[t] || t }); if (d.type === t) op.selected = true; typeSel.appendChild(op); });
  typeSel.addEventListener('change', updateDbTypeUI);
  body.appendChild(acc('기본', 'label · type', true, [
    fcol('연결 이름 (label) *', inp('dbf_label', d.label, '예: 연구 코퍼스 (pgvector)')),
    fcol('type *', typeSel),
    fcol('network (접근 범위)', inp('dbf_network', d.network, 'external / localhost / intranet')),
  ]));

  // Connection — sqlite
  var sqliteBlock = el('div', { id: 'dbf_sqlite' }, [
    fcol('db_path * (파일 경로 또는 :memory:)', inp('dbf_db_path', c.db_path, '../_data/demo.sqlite')),
    el('div', { class: 'field-note', text: 'PDO_sqlite는 대부분 호스팅에 탑재 — 무설치 실동작 레퍼런스.' }),
  ]);
  // Connection — server(mysql/postgres/pgvector/neo4j)
  var pwInput = el('input', { type: 'password', class: 'field', id: 'dbf_password', value: c.password || '', placeholder: '비밀번호 (등록 시 서버 보관)' });
  var showPw = el('label', { class: 'reason-toggle' }, [(function () { var x = el('input', { type: 'checkbox' }); x.addEventListener('change', function () { pwInput.type = x.checked ? 'text' : 'password'; }); return x; })(), el('span', { text: '표시' })]);
  var serverBlock = el('div', { id: 'dbf_server' }, [
    el('div', { class: 'param-grid' }, [
      fcol('host *', inp('dbf_host', c.host, 'db.example.com')),
      fcol('port', inp('dbf_port', c.port, '', 'number')),
    ]),
    el('div', { class: 'param-grid' }, [
      fcol('database', inp('dbf_database', c.database, 'ragdb')),
      fcol('user', inp('dbf_user', c.user, 'rag_ro')),
    ]),
    fcol('password', el('div', { class: 'field-col' }, [pwInput, showPw])),
    el('div', { class: 'field-col', id: 'dbf_uri_wrap' }, [el('label', { text: 'uri (neo4j HTTP, 예: https://host:7473)' }), inp('dbf_uri', c.uri, 'https://graph.example.com:7473')]),
    el('div', { class: 'field-row switch-row' }, [el('label', { text: 'TLS 사용' }), dbSwitch('dbf_tls', c.tls && c.tls.enabled)]),
  ]);
  body.appendChild(acc('Connection', '접속 정보', true, [sqliteBlock, serverBlock]));

  // Options
  body.appendChild(acc('Options', 'readonly · 상한', false, [
    el('div', { class: 'field-row switch-row' }, [el('label', { text: 'readonly (읽기전용 · 권장)' }), dbSwitch('dbf_readonly', o.readonly !== false)]),
    el('div', { class: 'param-grid' }, [
      fcol('connect_timeout_ms', inp('dbf_ct', o.connect_timeout_ms != null ? o.connect_timeout_ms : 10000, '', 'number')),
      fcol('statement_timeout_ms', inp('dbf_st', o.statement_timeout_ms != null ? o.statement_timeout_ms : 15000, '', 'number')),
    ]),
    fcol('row_cap (최대 행)', inp('dbf_rowcap', o.row_cap != null ? o.row_cap : 200, '', 'number')),
  ]));

  // Vector block (pgvector)
  var metricSel = el('select', { class: 'field', id: 'dbf_metric' });
  [['cosine', 'cosine (1-<=>)'], ['l2', 'l2 (<->)'], ['ip', 'inner product (<#>)']].forEach(function (m) { var op = el('option', { value: m[0], text: m[1] }); if ((v.metric || 'cosine') === m[0]) op.selected = true; metricSel.appendChild(op); });
  var indexSel = el('select', { class: 'field', id: 'dbf_index' });
  ['hnsw', 'ivfflat', 'none'].forEach(function (m) { var op = el('option', { value: m, text: m }); if ((v.index || 'hnsw') === m) op.selected = true; indexSel.appendChild(op); });
  body.appendChild(acc('Vector (pgvector)', 'table · columns · dim', false, [
    el('div', { class: 'param-grid' }, [
      fcol('table *', inp('dbf_v_table', v.table, 'chunks')),
      fcol('embedding_column *', inp('dbf_v_emb', v.embedding_column, 'embedding')),
    ]),
    el('div', { class: 'param-grid' }, [
      fcol('id_column', inp('dbf_v_id', v.id_column || 'id', 'id')),
      fcol('text_column', inp('dbf_v_text', v.text_column || 'text', 'text')),
    ]),
    fcol('metadata_columns (쉼표구분)', inp('dbf_v_meta', (v.metadata_columns || []).join(','), 'doc_id,title,loc')),
    el('div', { class: 'param-grid' }, [
      fcol('dim (임베딩 차원)', inp('dbf_v_dim', v.dim != null ? v.dim : 384, '', 'number')),
      fcol('metric', metricSel),
    ]),
    fcol('index', indexSel),
    el('div', { class: 'field-note', text: 'DB측: CREATE EXTENSION vector; + 벡터 컬럼. pdo_pgsql 미탑재 호스팅이면 mock으로 강등됩니다.' }),
  ], { id: 'dbf_vector' }));

  // Graph block (neo4j)
  body.appendChild(acc('Graph (Neo4j)', 'labels · rel_types', false, [
    fcol('database', inp('dbf_g_db', g.database || 'neo4j', 'neo4j')),
    el('div', { class: 'param-grid' }, [
      fcol('entity_label', inp('dbf_g_entity', g.entity_label || 'Entity', 'Entity')),
      fcol('community_label', inp('dbf_g_comm', g.community_label || 'Community', 'Community')),
    ]),
    fcol('rel_types (쉼표구분)', inp('dbf_g_rels', (g.rel_types || []).join(','), 'RELATED,WORKS_WITH')),
    el('div', { class: 'param-grid' }, [
      fcol('name_property', inp('dbf_g_name', g.name_property || 'name', 'name')),
      fcol('summary_property', inp('dbf_g_summary', g.summary_property || 'summary', 'summary')),
    ]),
    el('div', { class: 'field-note', text: 'Bolt 확장 불요 — HTTP API(/db/{db}/tx/commit, cURL). 미도달 시 mock 그래프로 강등됩니다.' }),
  ], { id: 'dbf_graph' }));

  // Notes
  var notesTa = el('textarea', { class: 'field field-mono', rows: 3, id: 'dbf_notes', placeholder: '한 줄에 하나씩' });
  notesTa.value = (d.notes || []).join('\n');
  body.appendChild(acc('Notes', '메모', false, [fcol('notes (줄바꿈 구분)', notesTa)]));

  body.appendChild(el('div', { id: 'dbf_diag' }));
  updateDbTypeUI();
}
function updateDbTypeUI() {
  var t = $('#dbf_type') ? $('#dbf_type').value : 'sqlite';
  var isSqlite = t === 'sqlite', isNeo = t === 'neo4j', isPgv = t === 'pgvector';
  var show = function (id, on) { var e = $('#' + id); if (e) e.hidden = !on; };
  show('dbf_sqlite', isSqlite);
  show('dbf_server', !isSqlite);
  var uriWrap = $('#dbf_uri_wrap'); if (uriWrap) uriWrap.hidden = !isNeo;
  var hostLabel = $('#dbf_host'); // neo4j에서는 host가 선택(uri 대체 가능)
  var vecAcc = $('#dbf_vector'); if (vecAcc) { vecAcc.hidden = !isPgv; if (isPgv) vecAcc.dataset.open = 'true'; }
  var grAcc = $('#dbf_graph'); if (grAcc) { grAcc.hidden = !isNeo; if (isNeo) grAcc.dataset.open = 'true'; }
}
function collectDbForm() {
  var t = $('#dbf_type').value;
  var val = function (id) { var e = $('#' + id); return e ? e.value : ''; };
  var num = function (id) { var e = $('#' + id); return e && e.value !== '' ? Number(e.value) : undefined; };
  var sw = function (id) { var e = $('#' + id); return e ? e.getAttribute('aria-checked') === 'true' : false; };
  var csv = function (id) { return val(id).split(',').map(function (s) { return s.trim(); }).filter(Boolean); };

  var connection = {};
  if (t === 'sqlite') {
    connection.db_path = val('dbf_db_path').trim();
  } else {
    connection.host = val('dbf_host').trim();
    connection.port = num('dbf_port');
    connection.database = val('dbf_database').trim() || undefined;
    connection.user = val('dbf_user').trim() || undefined;
    connection.password = val('dbf_password') || undefined;
    if (t === 'neo4j') connection.uri = val('dbf_uri').trim() || undefined;
    connection.tls = { enabled: sw('dbf_tls') };
  }
  var u = {
    schemaVersion: '1', kind: 'db-connection',
    label: val('dbf_label').trim(), type: t,
    network: val('dbf_network').trim() || undefined,
    connection: connection,
    options: {
      readonly: sw('dbf_readonly'),
      connect_timeout_ms: num('dbf_ct'), statement_timeout_ms: num('dbf_st'),
      row_cap: num('dbf_rowcap'),
    },
    vector: null, graph: null,
    notes: val('dbf_notes').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
  };
  if (t === 'pgvector') {
    u.vector = {
      table: val('dbf_v_table').trim(), id_column: val('dbf_v_id').trim() || 'id',
      text_column: val('dbf_v_text').trim() || 'text', embedding_column: val('dbf_v_emb').trim(),
      metadata_columns: csv('dbf_v_meta'), dim: num('dbf_v_dim'),
      metric: val('dbf_metric'), index: val('dbf_index'),
    };
  }
  if (t === 'neo4j') {
    u.graph = {
      database: val('dbf_g_db').trim() || 'neo4j', entity_label: val('dbf_g_entity').trim() || 'Entity',
      community_label: val('dbf_g_comm').trim() || 'Community', rel_types: csv('dbf_g_rels'),
      name_property: val('dbf_g_name').trim() || 'name', summary_property: val('dbf_g_summary').trim() || 'summary',
    };
  }
  return u;
}
function saveDbForm() {
  var u = collectDbForm();
  var v = L.db.validate(u);
  if (!v.ok) { toast('저장 불가: ' + v.errors[0], 'err'); return; }
  if (v.warnings.length) toast('경고: ' + v.warnings[0], 'warn');
  if (_dbEditingId) {
    var p = L.db.fromUserJSON(u, { id: _dbEditingId });
    L.db.update(_dbEditingId, { label: p.label, type: p.type, network: p.network, connection: p.connection, options: p.options, vector: p.vector, graph: p.graph, notes: p.notes });
    toast('저장됨');
  } else {
    var np = L.db.add(u, { activate: !L.db.getActiveId() });
    toast('DB 연결 추가됨: ' + np.label);
  }
  closeOverlay('#dbOverlay');
}
function testDbConnection() {
  var u = collectDbForm();
  var v = L.db.validate(u);
  var diagEl = $('#dbf_diag'); diagEl.innerHTML = '';
  if (!v.ok) { diagEl.appendChild(el('div', { class: 'diag-step' }, [el('span', { class: 'lamp', dataset: { state: 'err' } }), el('span', { class: 'diag-step__name', text: '입력 오류 — ' + v.errors[0] })])); return; }
  diagEl.innerHTML = '<div class="diag-step"><span class="lamp" data-state="loading"></span><span class="diag-step__name">연결 테스트 중… (POST /api/db/test)</span></div>';
  L.db.test(u).then(function (r) {
    diagEl.innerHTML = '';
    var wrap = el('div', { class: 'diag' });
    var head = el('div', { class: 'diag-step' }, [
      el('span', { class: 'lamp', dataset: { state: r.ok ? 'ok' : (r.unreachable ? 'idle' : 'err') } }),
      el('span', { class: 'diag-step__name', text: (r.ok ? '연결 성공' : (r.unreachable ? '백엔드 미도달 (mock 강등)' : '연결 실패')) + (r.server_version ? ' · ' + r.server_version : '') }),
      el('span', { class: 'diag-step__ms', text: r.ms != null ? (r.ms + 'ms') : '' }),
      provBadge(r.provider || 'error'),
    ]);
    wrap.appendChild(head);
    if (r.driver || (r.checks && r.checks.extension != null)) {
      var drv = r.driver || (u.type === 'sqlite' ? 'pdo_sqlite' : u.type === 'neo4j' ? 'curl' : ('pdo_' + (u.type === 'mysql' ? 'mysql' : 'pgsql')));
      var avail = r.checks ? r.checks.extension : (r.driver ? true : null);
      wrap.appendChild(el('div', { class: 'diag-step' }, [
        el('span', { class: 'lamp', dataset: { state: avail === false ? 'err' : (avail ? 'ok' : 'idle') } }),
        el('span', { class: 'diag-step__name', text: '드라이버: ' + drv + ' — ' + (avail === false ? '미탑재' : (avail ? '사용 가능' : '미확인')) }),
      ]));
    }
    if (r.checks) {
      Object.keys(r.checks).forEach(function (k) {
        if (k === 'extension') return;
        wrap.appendChild(el('div', { class: 'diag-step' }, [
          el('span', { class: 'lamp', dataset: { state: r.checks[k] ? 'ok' : 'err' } }),
          el('span', { class: 'diag-step__name', text: k + ': ' + (r.checks[k] ? 'ok' : 'fail') }),
        ]));
      });
    }
    if (r.error) wrap.appendChild(el('div', { class: 'field-note', text: '· ' + r.error }));
    if (r.hint) wrap.appendChild(el('div', { class: 'field-note', text: '힌트: ' + r.hint }));
    diagEl.appendChild(wrap);
    toast(r.ok ? '연결 성공' : (r.unreachable ? '백엔드 미도달 — mock 강등' : '연결 실패'), r.ok ? 'ok' : 'warn');
  });
}

/* ============================================================
   13. 상세 환경설정(파라미터 폼)
   ============================================================ */
function openSettings() {
  var p = activeProfile();
  $('#settingsScope').textContent = p ? ('활성: ' + p.label) : '연결 없음';
  buildSettingsForm();
  openOverlay('#settingsOverlay');
}
function buildSettingsForm() {
  var body = $('#settingsBody'); body.innerHTML = '';
  var params = mergedParams();

  function accGroup(title, hint, open, inner) {
    var wrap = el('div', { class: 'acc', dataset: { open: open ? 'true' : 'false' } });
    var head = el('button', { type: 'button', class: 'acc__head' }, []);
    head.innerHTML = '<svg class="ic acc__chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="acc__title">' + escapeHtml(title) + '</span><span class="acc__hint">' + escapeHtml(hint) + '</span>';
    var bodyEl = el('div', { class: 'acc__body' }, inner);
    head.addEventListener('click', function () { var o = wrap.dataset.open === 'true'; wrap.dataset.open = o ? 'false' : 'true'; });
    wrap.appendChild(head); wrap.appendChild(bodyEl); return wrap;
  }
  function setParam(key, val) { state.sessionParams[key] = val; if (key === 'context_window') updateInspectorGauge(); }

  function rangeControl(c) {
    var val = params[c.key] != null ? params[c.key] : c.def;
    var out = el('output', { text: String(val) });
    var input = el('input', { type: 'range', min: c.min, max: c.max, step: c.step, value: val });
    input.addEventListener('input', function () { out.textContent = input.value; setParam(c.key, Number(input.value)); });
    return el('div', { class: 'range-row' }, [
      el('div', { class: 'range-row__top' }, [
        el('label', { html: '<span class="param-row__key">' + c.key + '</span>' }), out,
      ]),
      input,
      el('div', { class: 'param-row__label' }, [el('span', { class: 'param-row__tip', text: c.tip }), el('span', { class: 'param-row__support', text: c.support })]),
    ]);
  }
  function numberControl(c) {
    var val = params[c.key];
    var input = el('input', { type: 'number', class: 'field field-num', step: c.step, value: val == null ? '' : val });
    if (c.min != null) input.min = c.min;
    input.addEventListener('input', function () { setParam(c.key, input.value === '' ? null : Number(input.value)); });
    return el('div', { class: 'param-row' }, [
      el('div', { class: 'param-row__label' }, [el('span', { class: 'param-row__key', text: c.key }), el('span', { class: 'param-row__tip', text: c.tip }), el('span', { class: 'param-row__support', text: c.support })]),
      input,
    ]);
  }
  function controlFor(c) { return c.type === 'range' ? rangeControl(c) : numberControl(c); }

  // Group A/B — Connection & Headers
  var useProxyVal = state.ui.useProxy;
  var proxySwitch = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(useProxyVal !== false), type: 'button' });
  proxySwitch.addEventListener('click', function () { var on = proxySwitch.getAttribute('aria-checked') === 'true'; proxySwitch.setAttribute('aria-checked', String(!on)); state.ui.useProxy = !on; saveUI(); });
  var timeoutInput = el('input', { type: 'number', class: 'field field-num', min: 0, step: 1000, value: params.timeout_ms || 120000 });
  timeoutInput.addEventListener('input', function () { setParam('timeout_ms', Number(timeoutInput.value)); });
  var hdrList = el('div', { class: 'hdr-list', id: 'set_hdrList' });
  renderHeaderRows(hdrList);
  var addHdr = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ 헤더 추가' });
  addHdr.addEventListener('click', function () { state.extraHeaders.push({ name: '', value: '', enabled: true }); renderHeaderRows(hdrList); });
  body.appendChild(accGroup('Connection & Headers', 'A·B', true, [
    el('div', { class: 'field-row switch-row' }, [el('label', { text: '프록시 경유 (server.py /api/proxy)' }), proxySwitch]),
    el('div', { class: 'param-row' }, [el('div', { class: 'param-row__label' }, [el('span', { class: 'param-row__key', text: 'timeout_ms' }), el('span', { class: 'param-row__tip', text: '요청 타임아웃' })]), timeoutInput]),
    el('div', { class: 'field-col' }, [el('label', { text: '커스텀 헤더 (그룹 B)' }), hdrList, addHdr]),
  ]));

  // Groups C, D, E
  PARAM_GROUPS.forEach(function (g) {
    var inner = g.controls.map(controlFor);
    if (g.id !== 'context') inner = [el('div', { class: 'param-grid' }, inner)];
    body.appendChild(accGroup(g.title, g.hint, g.id === 'sampling', inner));
  });

  // Group F — Control & Output
  var stopInput = el('textarea', { class: 'field field-mono', rows: 3, placeholder: '줄바꿈 = stop 배열' });
  stopInput.value = Array.isArray(params.stop) ? params.stop.join('\n') : (params.stop || '');
  stopInput.addEventListener('input', function () { setParam('stop', stopInput.value.split('\n').filter(function (s) { return s.length; })); });
  var seedInput = el('input', { type: 'number', class: 'field field-num', value: params.seed == null ? '' : params.seed, placeholder: 'null' });
  seedInput.addEventListener('input', function () { setParam('seed', seedInput.value === '' ? null : Number(seedInput.value)); });
  var seedRand = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '🎲 random' });
  seedRand.addEventListener('click', function () { var s = Math.floor(Math.random() * 1e9); seedInput.value = s; setParam('seed', s); });
  var nInput = el('input', { type: 'number', class: 'field field-num', min: 1, value: params.n || 1 });
  nInput.addEventListener('input', function () { setParam('n', Number(nInput.value)); });
  var rfSel = el('select', { class: 'field' });
  ['text', 'json_object', 'json_schema'].forEach(function (o) { var opt = el('option', { value: o, text: o }); var cur = params.response_format && params.response_format.type ? params.response_format.type : (params.response_format || 'text'); if (cur === o) opt.selected = true; rfSel.appendChild(opt); });
  var rfSchema = el('textarea', { class: 'field field-mono', rows: 4, placeholder: '{ "type":"json_schema", "json_schema": {...} }' });
  if (params.response_format && typeof params.response_format === 'object' && params.response_format.type !== 'text') rfSchema.value = JSON.stringify(params.response_format, null, 2);
  rfSchema.hidden = rfSel.value === 'text';
  rfSel.addEventListener('change', function () {
    rfSchema.hidden = rfSel.value === 'text';
    if (rfSel.value === 'text') setParam('response_format', undefined);
    else if (rfSel.value === 'json_object') setParam('response_format', { type: 'json_object' });
    else { try { setParam('response_format', JSON.parse(rfSchema.value || '{"type":"json_schema"}')); } catch (e) { setParam('response_format', { type: 'json_schema' }); } }
  });
  rfSchema.addEventListener('input', function () { try { setParam('response_format', JSON.parse(rfSchema.value)); } catch (e) {} });
  var streamSwitch = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(params.stream !== false), type: 'button' });
  streamSwitch.addEventListener('click', function () { var on = streamSwitch.getAttribute('aria-checked') === 'true'; streamSwitch.setAttribute('aria-checked', String(!on)); setParam('stream', !on); });
  var logprobsSwitch = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!params.logprobs), type: 'button' });
  logprobsSwitch.addEventListener('click', function () { var on = logprobsSwitch.getAttribute('aria-checked') === 'true'; logprobsSwitch.setAttribute('aria-checked', String(!on)); setParam('logprobs', !on); });
  body.appendChild(accGroup('Control & Output', 'F', false, [
    el('div', { class: 'field-col' }, [el('label', { html: '<span class="param-row__key">stop</span>' }), stopInput]),
    el('div', { class: 'param-grid' }, [
      el('div', { class: 'field-col' }, [el('label', { html: '<span class="param-row__key">seed</span>' }), el('div', { class: 'field-row' }, [seedInput, seedRand])]),
      el('div', { class: 'field-col' }, [el('label', { html: '<span class="param-row__key">n</span>' }), nInput]),
    ]),
    el('div', { class: 'field-col' }, [el('label', { html: '<span class="param-row__key">response_format</span>' }), rfSel, rfSchema]),
    el('div', { class: 'param-grid' }, [
      el('div', { class: 'field-row switch-row' }, [el('label', { html: '<span class="param-row__key">stream</span>' }), streamSwitch]),
      el('div', { class: 'field-row switch-row' }, [el('label', { html: '<span class="param-row__key">logprobs</span>' }), logprobsSwitch]),
    ]),
  ]));

  // Group G — Backend-specific (extra_body)
  var eb = params.extra_body && typeof params.extra_body === 'object' ? params.extra_body : {};
  var thinkOn = !(eb.chat_template_kwargs && eb.chat_template_kwargs.enable_thinking === false);
  var thinkSwitch = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(thinkOn), type: 'button' });
  var ebText = el('textarea', { class: 'field field-mono', rows: 6, placeholder: '{ "chat_template_kwargs": {...}, "guided_json": {...} }' });
  ebText.value = Object.keys(eb).length ? JSON.stringify(eb, null, 2) : '';
  function syncEB(obj) { setParam('extra_body', obj); ebText.value = Object.keys(obj).length ? JSON.stringify(obj, null, 2) : ''; }
  thinkSwitch.addEventListener('click', function () {
    var on = thinkSwitch.getAttribute('aria-checked') === 'true'; thinkSwitch.setAttribute('aria-checked', String(!on));
    var cur = {}; try { cur = ebText.value ? JSON.parse(ebText.value) : {}; } catch (e) { cur = eb; }
    cur.chat_template_kwargs = Object.assign({}, cur.chat_template_kwargs, { enable_thinking: !on });
    syncEB(cur);
  });
  ebText.addEventListener('input', function () { try { setParam('extra_body', ebText.value ? JSON.parse(ebText.value) : {}); ebText.setCustomValidity && ebText.setCustomValidity(''); } catch (e) { /* 유효할 때만 반영 */ } });
  body.appendChild(accGroup('Backend-specific → extra_body', 'G (vLLM)', false, [
    el('div', { class: 'field-row switch-row' }, [el('label', { html: '<span class="param-row__key">chat_template_kwargs.enable_thinking</span> <span class="param-row__tip">reasoning on/off</span>' }), thinkSwitch]),
    el('div', { class: 'field-col' }, [el('label', { text: 'extra_body (JSON, 표준 필드와 격리)' }), ebText]),
  ]));
}
function renderHeaderRows(container) {
  container.innerHTML = '';
  state.extraHeaders.forEach(function (h, i) {
    var name = el('input', { type: 'text', class: 'field', value: h.name, placeholder: '헤더명' });
    var value = el('input', { type: 'text', class: 'field', value: h.value, placeholder: '값' });
    name.addEventListener('input', function () { h.name = name.value; });
    value.addEventListener('input', function () { h.value = value.value; });
    var rm = el('button', { class: 'btn-icon', type: 'button', 'aria-label': '헤더 삭제' }); rm.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    rm.addEventListener('click', function () { state.extraHeaders.splice(i, 1); renderHeaderRows(container); });
    container.appendChild(el('div', { class: 'hdr-item' }, [name, value, rm]));
  });
  if (!state.extraHeaders.length) container.appendChild(el('div', { class: 'field-note', text: '커스텀 헤더 없음' }));
}
function saveParamsToProfile() {
  var p = activeProfile();
  if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
  L.profiles.update(p.id, { params: Object.assign({}, p.params, state.sessionParams) });
  toast('프로필 기본값으로 저장됨: ' + p.label, 'ok');
}
function resetParams() {
  state.sessionParams = {};
  var p = activeProfile();
  if (p) L.profiles.update(p.id, { params: Object.assign({}, L.DEFAULT_PARAMS, { context_window: p.params.context_window }) });
  buildSettingsForm();
  toast('기본값 복원');
}

/* ============================================================
   14. INSPECTOR
   ============================================================ */
var INSP_TABS = [
  { id: 'request', label: 'Request' }, { id: 'response', label: 'Response' },
  { id: 'timing', label: 'Timing' }, { id: 'usage', label: 'Usage' },
  { id: 'error', label: 'Error' }, { id: 'viewcode', label: 'View code' },
];
function renderInspectorTabs() {
  var bar = $('#inspectorTabs'); bar.innerHTML = '';
  var r = state.lastResult;
  INSP_TABS.forEach(function (t) {
    if (t.id === 'error' && (!r || !r.error)) return;
    var tab = el('button', { type: 'button', role: 'tab', class: 'insp-tab' + (t.id === state.inspectorTab ? ' is-active' : ''), 'aria-selected': t.id === state.inspectorTab });
    tab.innerHTML = escapeHtml(t.label) + (t.id === 'error' && r && r.error ? '<span class="insp-tab__dot insp-tab__dot--err"></span>' : '');
    tab.addEventListener('click', function () { state.inspectorTab = t.id; renderInspector(); });
    bar.appendChild(tab);
  });
}
function codeBlock(text, isJson) {
  var wrap = el('div', { class: 'codeblock' });
  var pre = el('pre'); if (isJson) pre.innerHTML = jsonHighlight(text); else pre.textContent = text;
  var copy = el('button', { class: 'codeblock__copy', type: 'button', text: '복사' });
  copy.addEventListener('click', function () { copyText(typeof text === 'string' ? text : JSON.stringify(text, null, 2)); copy.textContent = '복사됨!'; setTimeout(function () { copy.textContent = '복사'; }, 1500); });
  wrap.appendChild(copy); wrap.appendChild(pre); return wrap;
}
function renderInspector() {
  renderInspectorTabs();
  var body = $('#inspectorBody'); var r = state.lastResult;
  if (!r) { body.innerHTML = ''; body.appendChild($('#inspectorEmpty') || el('div')); return; }
  $('#inspectorMeta').textContent = (r.module || 'chat') + ' · ' + (r.model || '');
  body.innerHTML = '';
  var tab = state.inspectorTab;

  // 저장 전(부분) 응답 안내 — 사라지는 toast가 아니라 body 안에 상시 노출
  if (r._partial) {
    body.appendChild(el('div', { class: 'insp-note', html: '이 응답은 상세 요청 스냅샷이 저장되기 전이라 일부 필드(요청 본문/헤더 등)가 없습니다. 모델·도메인·응답 내용은 표시됩니다.' }));
  }

  if (tab === 'request') {
    var req = r.request || {};
    var kv = el('dl', { class: 'insp-kv' });
    [['method', req.method], ['url', req.url], ['model', r.model], ['endpoint', req.endpoint], ['proxy', req.useProxy == null ? null : String(!!req.useProxy)]].forEach(function (p) { kv.appendChild(el('dt', { text: p[0] })); kv.appendChild(el('dd', { text: p[1] == null || p[1] === '' ? '—' : String(p[1]) })); });
    body.appendChild(sec('Target', kv));
    if (req.headers) body.appendChild(sec('Headers (마스킹)', codeBlock(req.headers, true)));
    else body.appendChild(sec('Headers (마스킹)', el('div', { class: 'list-empty', text: r._partial ? '저장 안 됨 (과거/미저장 응답)' : '—' })));
    if (req.body) body.appendChild(sec('Body', codeBlock(req.body, true)));
    else body.appendChild(sec('Body', el('div', { class: 'list-empty', text: r._partial ? '저장 안 됨 (요청 본문 미저장)' : '—' })));
  } else if (tab === 'response') {
    var resp = r.response || {};
    var kv2 = el('dl', { class: 'insp-kv' });
    [['status', resp.status], ['statusText', resp.statusText], ['finish_reason', r.finishReason], ['stream', resp.stream == null ? null : String(!!resp.stream)], ['viaProxy', resp.viaProxy == null ? null : String(!!resp.viaProxy)]].forEach(function (p) { kv2.appendChild(el('dt', { text: p[0] })); kv2.appendChild(el('dd', { text: p[1] == null ? '—' : String(p[1]) })); });
    body.appendChild(sec('Status', kv2));
    if (resp.headers && Object.keys(resp.headers).length) body.appendChild(sec('Response headers', codeBlock(resp.headers, true)));
    if (r.content) body.appendChild(sec('Assembled content', codeBlock(r.content, false)));
    else if (r._partial && !r.error) body.appendChild(sec('Assembled content', el('div', { class: 'list-empty', text: '응답 내용 없음' })));
    if (r.error) body.appendChild(sec('오류', el('div', { class: 'err-hint', html: '<b>' + escapeHtml(r.error.type || 'error') + (r.error.status ? ' · HTTP ' + r.error.status : '') + '</b><br>' + escapeHtml(r.error.message || '') })));
    if (resp.rawChunks && resp.rawChunks.length) {
      var det = el('details'); det.appendChild(el('summary', { text: '원시 SSE 청크 (' + resp.rawChunks.length + ')' }));
      det.appendChild(codeBlock(resp.rawChunks.join('\n'), false)); body.appendChild(sec('Raw stream', det));
    }
  } else if (tab === 'timing') {
    var t = r.timing || {};
    var grid = el('div', { class: 'metric-grid' }, [
      metric('TTFT', t.ttftMs != null ? t.ttftMs + '<small> ms</small>' : '—'),
      metric('tok/s', t.tokPerSec != null ? (t.tokPerSec + (t.tokPerSecApprox ? '<small> ~approx</small>' : '')) : '—'),
      metric('Total', t.totalMs != null ? fmtMs(t.totalMs) : '—'),
      metric('Provider', '<span class="prov prov--' + (r.provider || 'server') + '">' + (r.provider || 'server') + '</span>'),
    ]);
    body.appendChild(sec('Performance', grid));
  } else if (tab === 'usage') {
    var u = r.usage;
    if (u) {
      var grid2 = el('div', { class: 'metric-grid' }, [
        metric('Prompt', fmtNum(u.prompt_tokens)), metric('Completion', fmtNum(u.completion_tokens)),
        metric('Total', fmtNum(u.total_tokens)), metric('Model', '<span class="mono" style="font-size:12px">' + escapeHtml(r.model || '') + '</span>'),
      ]);
      body.appendChild(sec('Token usage', grid2));
      body.appendChild(gaugeEl(u));
    } else body.appendChild(el('div', { class: 'list-empty', text: 'usage 정보 없음 (stream_options.include_usage 확인)' }));
  } else if (tab === 'error') {
    if (r.error) {
      body.appendChild(el('div', { class: 'err-hint', html: '<b>' + escapeHtml(r.error.type || 'error') + (r.error.status ? ' · HTTP ' + r.error.status : '') + '</b><br>' + escapeHtml(r.error.message || '') + (r.error.hint ? '<br><span style="color:var(--color-text-muted)">힌트: ' + escapeHtml(r.error.hint) + '</span>' : '') }));
      if (r.error.body) body.appendChild(sec('Response body', codeBlock(r.error.body, false)));
    } else body.appendChild(el('div', { class: 'list-empty', text: '오류 없음' }));
  } else if (tab === 'viewcode') {
    var sub = el('div', { class: 'vc-tabs' });
    ['curl', 'python', 'fetch'].forEach(function (k) {
      var b = el('button', { type: 'button', class: 'vc-tab' + (state.vcTab === k ? ' is-active' : ''), text: k });
      b.addEventListener('click', function () { state.vcTab = k; renderInspector(); });
      sub.appendChild(b);
    });
    body.appendChild(sub);
    var codeReq = state._lastViewReq || {};
    var code = '';
    try { code = L.viewCode[state.vcTab](codeReq); } catch (e) { code = '// View code 생성 실패: ' + e.message; }
    body.appendChild(codeBlock(code, false));
  }
  function sec(label, node) { var s = el('div', { class: 'insp-sec' }); s.appendChild(el('div', { class: 'insp-sec__label', text: label })); s.appendChild(node); return s; }
  function metric(label, valHtml) { return el('div', { class: 'metric' }, [el('div', { class: 'metric__label', text: label }), el('div', { class: 'metric__value', html: valHtml })]); }
  function gaugeEl(u) {
    // 게이지 context_window는 이 RunResult의 프로필 기준(활성 프로필 아님 — 메시지별 인스펙터 정합성)
    var p = (r && r.profileId && L.profiles.get(r.profileId)) || activeProfile();
    var cw = (r && r.request && r.request.body && r.request.body.context_window) ||
             (state.lastResult === r ? state.sessionParams.context_window : 0) ||
             (p && p.params && p.params.context_window) || 0;
    var used = (u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0));
    var pct = cw ? Math.min(100, (used / cw) * 100) : 0;
    var g = el('div', { class: 'gauge' }, [
      el('div', { class: 'gauge__bar' }, [el('div', { class: 'gauge__fill', style: 'width:' + pct.toFixed(1) + '%' })]),
      el('div', { class: 'gauge__label' }, [el('span', { text: used + ' / ' + (cw || '?') + ' tokens' }), el('span', { text: cw ? pct.toFixed(1) + '%' : 'context_window 미설정' })]),
    ]);
    return g;
  }
}
function updateInspectorGauge() { if (state.ui.inspectorOpen && state.inspectorTab === 'usage') renderInspector(); }
function openInspector() { state.ui.inspectorOpen = true; saveUI(); var i = $('#inspector'); i.hidden = false; $('#inspectorToggle').setAttribute('aria-pressed', 'true'); if (window.innerWidth <= 1279) $('#inspectorBackdrop').hidden = false; renderInspector(); }
function closeInspector() { state.ui.inspectorOpen = false; saveUI(); $('#inspector').hidden = true; $('#inspectorToggle').setAttribute('aria-pressed', 'false'); $('#inspectorBackdrop').hidden = true; }
function toggleInspector() { state.ui.inspectorOpen ? closeInspector() : openInspector(); }

// RunResult 수신 → 인스펙터 갱신
function onRunResult(r) {
  state.lastResult = r;
  // View code 재현용 요청 스냅샷 저장
  state._lastViewReq = viewReqFromRun(r);
  if (state.ui.inspectorOpen) renderInspector();
  renderHistory();
}

// 특정 어시스턴트 메시지의 인스펙터 열기 — 그 메시지 자신의 RunResult를 표시 (현재 활성 모델 아님)
function inspectMessage(m) {
  if (!m) { openInspector(); return; }
  if (m.runResult) {
    // happy path: 저장된 전체 RunResult 사용 (동작 변경 없음)
    state.lastResult = m.runResult;
    state._lastViewReq = viewReqFromRun(m.runResult);
    openInspector();
    return;
  }
  // 폴백: runResult 미저장 응답(마이그레이션된 과거 메시지·요청 실패·모델 미도달 등)도
  // 그 메시지 자신의 저장 필드로 최소 인스펙터를 구성해 body가 비지 않고 메시지마다 바뀌게 한다.
  state.lastResult = partialResultFromMessage(m);
  state._lastViewReq = viewReqFromRun(state.lastResult);
  openInspector();
}
// 저장된 메시지 필드 → 경량 RunResult 유사객체(_partial) 합성
function partialResultFromMessage(m) {
  var url = m.baseURL || (m.host ? 'https://' + m.host + '/v1/chat/completions' : '');
  var st = m.stats || null;
  return {
    _partial: true,
    module: 'chat',
    model: m.model || '',
    provider: 'server',
    profileId: m.profileId,
    profileLabel: m.profileName,
    content: m.content || '',
    reasoning: m.reasoning || '',
    error: m.error || null,
    finishReason: undefined,
    usage: (st && st.usage) || undefined,
    timing: st ? { ttftMs: st.ttftMs, tokPerSec: st.tokPerSec, totalMs: st.totalMs, tokPerSecApprox: st.approx } : undefined,
    request: { url: url, method: 'POST', endpoint: 'chat', useProxy: undefined, headers: undefined, body: undefined },
    response: { status: undefined, statusText: undefined, headers: undefined, viaProxy: undefined, stream: undefined },
    ts: undefined,
  };
}

/* ============================================================
   15. CHAT 워크벤치
   ============================================================ */
var chatEls = {};
function initChat() {
  chatEls.list = $('#messageList'); chatEls.scroll = $('#chatScroll'); chatEls.input = $('#chatInput');
  chatEls.send = $('#sendBtn'); chatEls.welcome = $('#chatWelcome'); chatEls.fab = $('#scrollFab');
  renderChat();

  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); if (state.streaming) stopStream(); else sendChat(); });
  chatEls.input.addEventListener('input', autoGrow);
  chatEls.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!state.streaming) sendChat(); }
  });
  $$('#promptCards .prompt-card').forEach(function (c) { c.addEventListener('click', function () { chatEls.input.value = c.dataset.prompt; autoGrow(); chatEls.input.focus(); }); });
  chatEls.scroll.addEventListener('scroll', function () {
    var near = chatEls.scroll.scrollHeight - chatEls.scroll.scrollTop - chatEls.scroll.clientHeight < 120;
    chatEls.fab.hidden = near;
  });
  chatEls.fab.addEventListener('click', scrollToBottom);
}
function autoGrow() {
  var ta = chatEls.input; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  chatEls.send.disabled = state.streaming ? false : !ta.value.trim();
  $('#charCount').textContent = ta.value.length ? ta.value.length + ' 자' : '';
}
function scrollToBottom() { chatEls.scroll.scrollTop = chatEls.scroll.scrollHeight; }
function renderChat() {
  chatEls.welcome.hidden = state.chat.length > 0;
  chatEls.list.innerHTML = '';
  state.chat.forEach(function (m, i) { chatEls.list.appendChild(buildMessageEl(m, i)); });
  scrollToBottom();
}
function buildMessageEl(m, i) {
  var row = el('div', { class: 'msg msg--' + m.role });
  row.appendChild(el('div', { class: 'msg__role', text: m.role === 'user' ? 'You' : 'Assistant' }));
  if (m.role === 'assistant') {
    if (m.reasoning) row.appendChild(buildReasoning(m.reasoning));
    var bubble = el('div', { class: 'msg__bubble md' });
    if (m.error) bubble.innerHTML = '<div class="msg__error"><b>' + escapeHtml(m.error.type || '오류') + '</b>' + escapeHtml(m.error.message || '') + (m.error.hint ? '<div class="hint">' + escapeHtml(m.error.hint) + '</div>' : '') + '</div>';
    else if (m.pending && !m.content) bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    else renderMarkdownInto(bubble, m.content || '');
    row.appendChild(bubble);
    // 모델 뱃지 — 이 응답이 어떤 모델/도메인으로 왔는지 (전송 시점 캡처)
    if (!m.pending && (m.model || m.host)) {
      var badgeHost = m.host || hostFromURL(m.baseURL);
      var badge = el('div', { class: 'msg__model' }, [
        el('span', { class: 'msg__model-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'msg__model-name mono', text: m.model || '(모델 미상)' }),
        badgeHost ? el('span', { class: 'msg__model-host mono', text: badgeHost }) : null,
      ]);
      if (m.profileName) badge.title = m.profileName + (badgeHost ? ' · ' + badgeHost : '');
      row.appendChild(badge);
    }
    if (!m.pending && m.stats) {
      var s = m.stats;
      var stats = el('div', { class: 'msg__stats' });
      if (s.ttftMs != null) stats.appendChild(el('span', { html: 'TTFT <b>' + s.ttftMs + 'ms</b>' }));
      if (s.tokPerSec != null) stats.appendChild(el('span', { html: 'tok/s <b>' + s.tokPerSec + (s.approx ? '~' : '') + '</b>' }));
      if (s.totalMs != null) stats.appendChild(el('span', { html: 'total <b>' + fmtMs(s.totalMs) + '</b>' }));
      if (s.usage) stats.appendChild(el('span', { html: 'tokens <b>' + (s.usage.total_tokens || '?') + '</b>' }));
      row.appendChild(stats);
    }
    if (!m.pending) {
      var acts = el('div', { class: 'msg__actions' });
      var copy = el('button', { class: 'msg__act', type: 'button', text: '복사' }); copy.addEventListener('click', function () { copyText(m.content || ''); toast('복사됨'); });
      var insp = el('button', { class: 'msg__act', type: 'button', text: '인스펙터' });
      insp.addEventListener('click', function () { inspectMessage(m); });
      var regen = el('button', { class: 'msg__act', type: 'button', text: '재생성' }); regen.addEventListener('click', function () { regenerate(i); });
      acts.appendChild(copy); acts.appendChild(insp); acts.appendChild(regen);
      row.appendChild(acts);
    }
  } else {
    var ub = el('div', { class: 'msg__bubble', text: m.content });
    row.appendChild(ub);
  }
  return row;
}
function buildReasoning(text) {
  var wrap = el('div', { class: 'reasoning is-open' });
  var head = el('button', { type: 'button', class: 'reasoning__head' }, []);
  head.innerHTML = '<svg class="ic reasoning__chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span>사고 과정 (reasoning)</span>';
  var body = el('div', { class: 'reasoning__body', text: text });
  head.addEventListener('click', function () { wrap.classList.toggle('is-open'); });
  wrap.appendChild(head); wrap.appendChild(body); return wrap;
}
function sendChat() {
  var text = chatEls.input.value.trim(); if (!text) return;
  var p = activeProfile();
  if (!p) { toast('활성 연결이 없습니다. 먼저 연결을 추가하세요.', 'warn'); return; }
  var mdl = profileModel(p);
  state.chat.push({ role: 'user', content: text });
  var asst = { role: 'assistant', content: '', reasoning: '', pending: true,
    model: mdl, profileId: p.id, profileName: p.label, baseURL: p.baseURL, host: hostFromURL(p.baseURL) };
  state.chat.push(asst);
  chatEls.input.value = ''; autoGrow(); renderChat();

  var reasoningEnabled = $('#reasonToggle').checked;
  state.streaming = true; chatEls.send.classList.add('is-streaming'); chatEls.send.disabled = false;
  var ctl = new AbortController(); state.abortCtl = ctl;

  var messages = state.chat.filter(function (m) { return !m.pending && (m.role === 'user' || (m.role === 'assistant' && m.content)); })
    .map(function (m) { return { role: m.role, content: m.content }; });

  L.kernel.run({
    module: 'chat', profileId: p.id, model: mdl,
    messages: messages, stream: state.sessionParams.stream !== false, useProxy: state.ui.useProxy,
    params: state.sessionParams, extraHeaders: activeHeaders(), reasoningEnabled: reasoningEnabled,
    signal: ctl.signal,
    onToken: function (d) { asst.content += d; updatePendingBubble(asst); },
    onReasoning: function (d) { asst.reasoning += d; updatePendingBubble(asst); },
    onDone: function (r) { finalizeAssistant(asst, r); },
    onError: function (err) { asst.pending = false; asst.error = err; state.streaming = false; chatEls.send.classList.remove('is-streaming'); autoGrow(); renderChat(); saveChat(); },
  });
}
function activeHeaders() { return state.extraHeaders.filter(function (h) { return h.enabled !== false && h.name; }); }
function updatePendingBubble(asst) {
  // 스트리밍 중 마지막 메시지만 부분 렌더(성능)
  var rows = chatEls.list.children; var row = rows[rows.length - 1]; if (!row) return;
  var bubble = row.querySelector('.msg__bubble');
  if (asst.reasoning && !row.querySelector('.reasoning')) { row.insertBefore(buildReasoning(asst.reasoning), bubble); }
  else if (asst.reasoning) { var rb = row.querySelector('.reasoning__body'); if (rb) rb.textContent = asst.reasoning; }
  if (bubble) { if (asst.content) renderMarkdownInto(bubble, asst.content); }
  var near = chatEls.scroll.scrollHeight - chatEls.scroll.scrollTop - chatEls.scroll.clientHeight < 200;
  if (near) scrollToBottom();
}
function finalizeAssistant(asst, r) {
  asst.pending = false; asst.content = r.content || asst.content; asst.reasoning = r.reasoning || asst.reasoning;
  asst.stats = { ttftMs: r.timing.ttftMs, tokPerSec: r.timing.tokPerSec, totalMs: r.timing.totalMs, approx: r.timing.tokPerSecApprox, usage: r.usage };
  // 실제 요청 기준으로 모델/도메인 확정 + 이 메시지 전용 RunResult 저장 (인스펙터 정합성)
  if (r.model) asst.model = r.model;
  asst.profileId = r.profileId || asst.profileId;
  asst.profileName = r.profileLabel || asst.profileName;
  var reqUrl = r.request && r.request.url;
  if (reqUrl) { asst.host = hostFromURL(reqUrl); asst.baseURL = reqUrl; }
  asst.runResult = trimRunResult(r);
  state.streaming = false; chatEls.send.classList.remove('is-streaming'); autoGrow();
  renderChat(); saveChat();
}
function stopStream() { if (state.abortCtl) state.abortCtl.abort(); state.streaming = false; chatEls.send.classList.remove('is-streaming'); }
function regenerate(index) {
  // index는 assistant 메시지. 그 이전까지 유지하고 재생성
  if (state.streaming) return;
  // 세션 messages 배열 참조 유지를 위해 in-place 절단
  state.chat.length = index;
  // 마지막 user 메시지 기반 재요청
  var lastUser = null; for (var i = state.chat.length - 1; i >= 0; i--) { if (state.chat[i].role === 'user') { lastUser = state.chat[i]; break; } }
  if (!lastUser) { renderChat(); saveChat(); return; }
  var p = activeProfile(); if (!p) { renderChat(); saveChat(); return; }
  var mdl = profileModel(p);
  var asst = { role: 'assistant', content: '', reasoning: '', pending: true,
    model: mdl, profileId: p.id, profileName: p.label, baseURL: p.baseURL, host: hostFromURL(p.baseURL) };
  state.chat.push(asst); renderChat();
  state.streaming = true; chatEls.send.classList.add('is-streaming');
  var ctl = new AbortController(); state.abortCtl = ctl;
  var messages = state.chat.filter(function (m) { return !m.pending; }).map(function (m) { return { role: m.role, content: m.content }; });
  L.kernel.run({
    module: 'chat', profileId: p.id, model: mdl, messages: messages, stream: state.sessionParams.stream !== false,
    useProxy: state.ui.useProxy, params: state.sessionParams, extraHeaders: activeHeaders(), reasoningEnabled: $('#reasonToggle').checked, signal: ctl.signal,
    onToken: function (d) { asst.content += d; updatePendingBubble(asst); },
    onReasoning: function (d) { asst.reasoning += d; updatePendingBubble(asst); },
    onDone: function (r) { finalizeAssistant(asst, r); },
    onError: function (err) { asst.pending = false; asst.error = err; state.streaming = false; chatEls.send.classList.remove('is-streaming'); renderChat(); saveChat(); },
  });
}
// 새 대화 = 새 세션 생성 후 전환 (기존 세션은 보존)
function newChat() {
  if (state.streaming) stopStream();
  saveChat();
  var s = newSessionObj();
  state.sessions.unshift(s);
  state.activeSessionId = s.id;
  state.chat = s.messages;
  persistSessions();
  renderChat(); renderSessions();
  switchTab('chat');
  if (chatEls.input) chatEls.input.focus();
}
function switchSession(id) {
  if (id === state.activeSessionId) { switchTab('chat'); return; }
  if (state.streaming) { toast('스트리밍 중에는 세션을 전환할 수 없습니다. 먼저 중단하세요.', 'warn'); return; }
  saveChat();
  state.activeSessionId = id;
  var s = activeSession();
  if (!s) { initSessions(); }
  state.chat = activeSession().messages;
  persistSessions();
  renderChat(); renderSessions();
  switchTab('chat');
  closeSidebarIfMobile();
}
function deleteSession(id) {
  var target = null; for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === id) target = state.sessions[i];
  if (!target) return;
  if (state.streaming && id === state.activeSessionId) { toast('스트리밍 중에는 삭제할 수 없습니다.', 'warn'); return; }
  confirmDialog('“' + (target.title || '새 대화') + '” 대화를 삭제할까요? 되돌릴 수 없습니다.', function () {
    var idx = -1; for (var j = 0; j < state.sessions.length; j++) if (state.sessions[j].id === id) idx = j;
    if (idx < 0) return;
    state.sessions.splice(idx, 1);
    if (!state.sessions.length) {
      var ns = newSessionObj(); state.sessions.push(ns); state.activeSessionId = ns.id;
    } else if (id === state.activeSessionId) {
      state.activeSessionId = state.sessions[0].id;
    }
    state.chat = activeSession().messages;
    persistSessions();
    renderChat(); renderSessions();
    toast('대화를 삭제했습니다.');
  }, { okText: '삭제', title: '대화 삭제' });
}
function renameSession(id, newTitle) {
  var s = null; for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === id) s = state.sessions[i];
  if (!s) return;
  var t = String(newTitle == null ? '' : newTitle).replace(/\s+/g, ' ').trim();
  s.title = t || '새 대화';
  s.updatedAt = Date.now();
  persistSessions();
  renderSessions();
}
function sessionPreview(s) {
  for (var i = 0; i < s.messages.length; i++) {
    var m = s.messages[i];
    if (m.role === 'assistant' && m.content) { var c = String(m.content).replace(/\s+/g, ' ').trim(); return c.slice(0, 60); }
  }
  for (var k = 0; k < s.messages.length; k++) {
    var mm = s.messages[k];
    if (mm.role === 'user' && mm.content) { var u = String(mm.content).replace(/\s+/g, ' ').trim(); return u.slice(0, 60); }
  }
  return '빈 대화';
}
function renderSessions() {
  var box = $('#sessionList'); if (!box) return;
  box.innerHTML = '';
  var countEl = $('#sessionCount'); if (countEl) countEl.textContent = state.sessions.length;
  var sorted = state.sessions.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  if (!sorted.length) { box.appendChild(el('div', { class: 'session-empty', text: '대화가 없습니다.' })); return; }
  sorted.forEach(function (s) {
    var isActive = s.id === state.activeSessionId;
    var item = el('div', { class: 'session-item' + (isActive ? ' is-active' : ''), dataset: { id: s.id }, role: 'listitem' });
    var main = el('button', { type: 'button', class: 'session-item__main', title: s.title || '새 대화' }, [
      el('span', { class: 'session-item__title', text: s.title || '새 대화' }),
      el('span', { class: 'session-item__preview', text: sessionPreview(s) }),
    ]);
    main.addEventListener('click', function () { switchSession(s.id); });
    var actions = el('div', { class: 'session-item__actions' });
    var renameBtn = el('button', { type: 'button', class: 'session-act', 'aria-label': '이름 변경', title: '이름 변경',
      html: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' });
    renameBtn.addEventListener('click', function (e) { e.stopPropagation(); startInlineRename(item, s); });
    var delBtn = el('button', { type: 'button', class: 'session-act danger', 'aria-label': '삭제', title: '삭제',
      html: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>' });
    delBtn.addEventListener('click', function (e) { e.stopPropagation(); deleteSession(s.id); });
    actions.appendChild(renameBtn); actions.appendChild(delBtn);
    item.appendChild(main); item.appendChild(actions);
    box.appendChild(item);
  });
}
function startInlineRename(item, s) {
  if (item.querySelector('.session-rename')) return;
  var titleEl = item.querySelector('.session-item__title');
  if (!titleEl) return;
  var input = el('input', { type: 'text', class: 'session-rename', value: s.title || '' });
  titleEl.replaceWith(input);
  input.focus(); input.select();
  var done = false;
  function commit(save) {
    if (done) return; done = true;
    if (save) renameSession(s.id, input.value);
    else renderSessions();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', function () { commit(true); });
  input.addEventListener('click', function (e) { e.stopPropagation(); });
}
function closeSidebarIfMobile() {
  if (window.innerWidth <= 900 && state.ui.sidebarOpen) { closeSidebar && closeSidebar(); }
}

/* ============================================================
   16. HISTORY (실행 로그)
   ============================================================ */
function renderHistory() {
  L.runLog.list({ limit: 200 }).then(function (list) {
    var box = $('#historyList'); box.innerHTML = '';
    var q = state.historyFilter.toLowerCase();
    var filtered = list.filter(function (e) { return !q || (e.model || '').toLowerCase().indexOf(q) >= 0 || (e.module || '').toLowerCase().indexOf(q) >= 0 || (e.contentPreview || '').toLowerCase().indexOf(q) >= 0; });
    $('#historyCount').textContent = list.length;
    if (!filtered.length) { box.appendChild(el('div', { class: 'history-empty', text: q ? '검색 결과 없음' : '실행 로그가 없습니다.' })); return; }
    filtered.forEach(function (e) {
      var item = el('button', { type: 'button', class: 'history-item' }, [
        el('div', { class: 'history-item__top' }, [
          el('span', { class: 'lamp', dataset: { state: e.ok ? 'ok' : 'err' } }),
          el('span', { class: 'history-item__mod', text: e.module || 'chat' }),
          el('span', { class: 'history-item__time', text: timeAgo(e.ts) }),
        ]),
        el('div', { class: 'history-item__body', text: e.contentPreview || (e.error ? e.error.message : '(내용 없음)') }),
        el('div', { class: 'history-item__stats' }, [
          el('span', { text: (e.model || '').slice(0, 22) }),
          e.timing && e.timing.totalMs != null ? el('span', { text: fmtMs(e.timing.totalMs) }) : null,
          e.usage && e.usage.total_tokens ? el('span', { text: e.usage.total_tokens + ' tok' }) : null,
        ]),
      ]);
      item.addEventListener('click', function () { reproduceFromLog(e); });
      box.appendChild(item);
    });
  });
}
function reproduceFromLog(e) {
  // 인스펙터에 로그 항목을 재현 표시(경량 RunResult 형태로 매핑)
  state.lastResult = {
    module: e.module, model: e.model, provider: e.provider, finishReason: e.finishReason,
    content: e.contentPreview, usage: e.usage, timing: e.timing || {}, error: e.error,
    request: { method: 'POST', endpoint: 'chat', body: e.requestBody, headers: {}, useProxy: e.responseMeta && e.responseMeta.viaProxy },
    response: { status: e.status, headers: (e.responseMeta && e.responseMeta.headers) || {}, viaProxy: e.responseMeta && e.responseMeta.viaProxy },
  };
  state._lastViewReq = { profileId: e.profileId, model: e.model, messages: e.requestBody && e.requestBody.messages, params: {} };
  openInspector();
  toast('로그 재현 — 인스펙터 표시');
}

/* ============================================================
   17. 명령 팔레트
   ============================================================ */
var _paletteItems = [], _paletteActive = 0;
function buildPaletteItems() {
  var items = [];
  TABS.forEach(function (t) { items.push({ cat: '탭', label: t.label + ' 열기', fn: function () { switchTab(t.id); } }); });
  L.profiles.list().forEach(function (p) { items.push({ cat: '연결', label: '연결 전환: ' + p.label, fn: function () { L.profiles.setActive(p.id); } }); });
  items.push({ cat: '액션', label: '새 연결 추가', fn: function () { openProfileEditor(null); } });
  items.push({ cat: '액션', label: '연결 Import', fn: openImport });
  items.push({ cat: '액션', label: '연결 Export (전체)', fn: function () { openExport(null); } });
  items.push({ cat: '액션', label: '헬스체크 실행', fn: runHealthCheck });
  items.push({ cat: '액션', label: '상세 환경설정', fn: openSettings });
  items.push({ cat: '액션', label: '인스펙터 토글', fn: toggleInspector });
  items.push({ cat: '액션', label: '새 Chat', fn: newChat });
  items.push({ cat: '액션', label: '테마 전환', fn: toggleTheme });
  state.lastModels.forEach(function (m) { items.push({ cat: '모델', label: '모델: ' + m, fn: function () { state.activeModel = m; renderModelSwitcher(); } }); });
  return items;
}
function openPalette() { _paletteItems = buildPaletteItems(); $('#paletteInput').value = ''; _paletteActive = 0; renderPalette(''); openOverlay('#paletteOverlay'); }
function renderPalette(q) {
  var list = $('#paletteList'); list.innerHTML = '';
  q = (q || '').toLowerCase();
  var filtered = _paletteItems.filter(function (it) { return !q || it.label.toLowerCase().indexOf(q) >= 0 || it.cat.toLowerCase().indexOf(q) >= 0; });
  if (_paletteActive >= filtered.length) _paletteActive = 0;
  filtered.forEach(function (it, i) {
    var b = el('button', { type: 'button', class: 'palette-item' + (i === _paletteActive ? ' is-active' : ''), role: 'option' }, [
      el('span', { text: it.label }), el('span', { class: 'palette-item__cat', text: it.cat }),
    ]);
    b.addEventListener('click', function () { closeOverlay('#paletteOverlay'); it.fn(); });
    list.appendChild(b);
  });
  list._filtered = filtered;
}

/* ============================================================
   18. 메뉴 닫기 (외부 클릭)
   ============================================================ */
function closeMenus() {
  $$('.menu-wrap .menu').forEach(function (m) { m.hidden = true; });
  $$('.switch-btn[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  if (_floatingMenu) { _floatingMenu.remove(); _floatingMenu = null; }
}
function toggleMenu(btnSel, menuSel, builder) {
  var btn = $(btnSel), menu = $(menuSel);
  var open = !menu.hidden;
  closeMenus();
  if (!open) { if (builder) builder(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
}

/* ============================================================
   19. 이벤트 바인딩
   ============================================================ */
function bindEvents() {
  $('#hamburger').addEventListener('click', function () { state.ui.sidebarOpen ? closeSidebar() : openSidebar(); });
  $('#sidebarBackdrop').addEventListener('click', closeSidebar);
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#inspectorToggle').addEventListener('click', toggleInspector);
  $('#inspectorClose').addEventListener('click', closeInspector);
  $('#inspectorBackdrop').addEventListener('click', closeInspector);
  $('#statusChip').addEventListener('click', runHealthCheck);

  $('#connSwitchBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu('#connSwitchBtn', '#connSwitchMenu', buildConnMenu); });
  $('#modelSwitchBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu('#modelSwitchBtn', '#modelSwitchMenu', buildModelMenu); });

  var newSessBtn = $('#newSessionBtn'); if (newSessBtn) newSessBtn.addEventListener('click', newChat);
  $('#newConnBtn').addEventListener('click', function () { openProfileEditor(null); });
  $('#importConnBtn').addEventListener('click', function () { openImport('llm'); });
  $('#exportConnBtn').addEventListener('click', function () { openExport('llm', null); });

  // profile editor
  $('#profileClose').addEventListener('click', function () { closeOverlay('#profileOverlay'); });
  $('#profileCancel').addEventListener('click', function () { closeOverlay('#profileOverlay'); });
  $('#profileSave').addEventListener('click', saveProfileForm);
  $('#profileTest').addEventListener('click', testProfileConnection);
  $('#profileDup').addEventListener('click', function () { if (_editingId) { L.profiles.duplicate(_editingId); toast('복제됨'); closeOverlay('#profileOverlay'); } });
  $('#profileExportOne').addEventListener('click', function () { if (_editingId) { closeOverlay('#profileOverlay'); openExport('llm', _editingId); } });
  $('#profileDelete').addEventListener('click', function () { if (!_editingId) return; var p = L.profiles.get(_editingId); confirmDialog('연결 "' + (p ? p.label : '') + '"을(를) 삭제할까요?', function () { L.profiles.remove(_editingId); closeOverlay('#profileOverlay'); toast('삭제됨'); }); });

  // DB 연결 사이드바 + 편집기
  $('#newDbBtn').addEventListener('click', function () { openDbEditor(null); });
  $('#importDbBtn').addEventListener('click', function () { openImport('db'); });
  $('#exportDbBtn').addEventListener('click', function () { openExport('db', null); });
  $('#dbClose').addEventListener('click', function () { closeOverlay('#dbOverlay'); });
  $('#dbCancel').addEventListener('click', function () { closeOverlay('#dbOverlay'); });
  $('#dbSave').addEventListener('click', saveDbForm);
  $('#dbTest').addEventListener('click', testDbConnection);
  $('#dbDup').addEventListener('click', function () { if (_dbEditingId) { L.db.duplicate(_dbEditingId); toast('복제됨'); closeOverlay('#dbOverlay'); } });
  $('#dbExportOne').addEventListener('click', function () { if (_dbEditingId) { closeOverlay('#dbOverlay'); openExport('db', _dbEditingId); } });
  $('#dbDelete').addEventListener('click', function () { if (!_dbEditingId) return; var p = L.db.get(_dbEditingId); confirmDialog('DB 연결 "' + (p ? p.label : '') + '"을(를) 삭제할까요?', function () { L.db.remove(_dbEditingId); closeOverlay('#dbOverlay'); toast('삭제됨'); }); });

  // import
  $('#importClose').addEventListener('click', function () { closeOverlay('#importOverlay'); });
  $('#importCancel').addEventListener('click', function () { closeOverlay('#importOverlay'); });
  $('#importDo').addEventListener('click', doImport);
  $('#importFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return; $('#importFilename').textContent = f.name;
    var reader = new FileReader(); reader.onload = function () { $('#importText').value = reader.result; }; reader.readAsText(f);
  });

  // export
  $('#exportClose').addEventListener('click', function () { closeOverlay('#exportOverlay'); });
  $('#exportIncludeKey').addEventListener('click', function () { var on = this.getAttribute('aria-checked') === 'true'; this.setAttribute('aria-checked', String(!on)); refreshExportPreview(); });
  $('#exportCopy').addEventListener('click', function () { copyText($('#exportPreview').value); toast('복사됨'); });
  $('#exportDownload').addEventListener('click', doExportDownload);

  // settings params
  $('#settingsClose').addEventListener('click', function () { closeOverlay('#settingsOverlay'); });
  $('#settingsCancel').addEventListener('click', function () { closeOverlay('#settingsOverlay'); });
  $('#settingsSaveProfile').addEventListener('click', saveParamsToProfile);
  $('#paramsReset').addEventListener('click', resetParams);

  // confirm
  $('#confirmCancel').addEventListener('click', function () { closeOverlay('#confirmOverlay'); _confirmCb = null; });
  $('#confirmOk').addEventListener('click', function () { closeOverlay('#confirmOverlay'); if (_confirmCb) { var cb = _confirmCb; _confirmCb = null; cb(); } });

  // history
  $('#historySearch').addEventListener('input', function () { state.historyFilter = this.value; renderHistory(); });
  $('#historyExportBtn').addEventListener('click', function () { L.runLog.exportJSON().then(function (j) { downloadFile('llm-lab-runlog.json', j); }); });
  $('#historyCsvBtn').addEventListener('click', function () { L.runLog.exportCSV().then(function (c) { downloadFile('llm-lab-runlog.csv', c, 'text/csv'); }); });
  $('#historyClearBtn').addEventListener('click', function () { confirmDialog('실행 로그를 모두 비울까요?', function () { L.runLog.clear().then(function () { renderHistory(); toast('로그 비움'); }); }); });

  // palette
  $('#paletteInput').addEventListener('input', function () { renderPalette(this.value); });
  $('#paletteInput').addEventListener('keydown', function (e) {
    var f = $('#paletteList')._filtered || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); _paletteActive = Math.min(f.length - 1, _paletteActive + 1); renderPalette(this.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _paletteActive = Math.max(0, _paletteActive - 1); renderPalette(this.value); }
    else if (e.key === 'Enter') { e.preventDefault(); if (f[_paletteActive]) { closeOverlay('#paletteOverlay'); f[_paletteActive].fn(); } }
  });

  // 외부 클릭으로 메뉴/오버레이 닫기
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.menu-wrap') && !e.target.closest('.menu[data-floating]') && !e.target.closest('.conn-card__menu')) closeMenus();
  });
  $$('.overlay').forEach(function (o) { o.addEventListener('mousedown', function (e) { if (e.target === o) o.hidden = true; }); });

  // 키보드 단축키
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); state.ui.sidebarOpen ? closeSidebar() : openSidebar(); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); toggleInspector(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); return; }
    if (e.key === 'Escape') { if (anyOverlayOpen()) { $$('.overlay').forEach(function (o) { o.hidden = true; }); } else { closeMenus(); } }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 899) { $('#sidebarBackdrop').hidden = true; $('#app').classList.remove('sidebar-open'); }
    if (window.innerWidth > 1279 && state.ui.inspectorOpen) $('#inspectorBackdrop').hidden = true;
  });
}

/* ============================================================
   20. 엔진 이벤트 구독
   ============================================================ */
function subscribeEngine() {
  L.on('run:done', onRunResult);
  L.on('run:error', onRunResult);
  L.on('profiles:change', function () { renderConnList(); renderConnSwitcher(); renderModelSwitcher(); });
  L.on('active:change', function () { state.activeModel = null; state.sessionParams = {}; renderConnList(); renderConnSwitcher(); renderModelSwitcher(); setStatus('idle', '미확인', null); });
  if (L.db && L.db.onChange) L.db.onChange(function () { renderDbList(); if (typeof RAG !== 'undefined' && RAG.refreshBackends) RAG.refreshBackends(); });
}

/* ============================================================
   22. 공용: provider 배지 · 스텝퍼
   ============================================================ */
function provBadge(p) { p = p || 'browser'; return el('span', { class: 'prov prov--' + p, text: p }); }
function labSection(title, hintNode) {
  var head = el('div', { class: 'lab-sec__head' }, [el('h3', { class: 'lab-sec__title', text: title })]);
  if (hintNode) head.appendChild(hintNode);
  var sec = el('section', { class: 'card lab-sec' }, [head]);
  return sec;
}

/* ============================================================
   23. RAG LAB 모듈
   ============================================================ */
var RAG = (function () {
  var E = {};                 // element refs
  var EV = {};                // 검색 평가(Eval) element refs
  var docs = [];              // [{id,title,text}]
  var index = null;           // {chunks, vectors, dim, embedProvider, chunkMs, embedMs}
  var lastResult = null;
  var graphView = null, graphData = null, graphMounted = false;
  var abortCtl = null, busy = false;

  var SAMPLE = [
    { id: 'doc-graphrag', title: 'GraphRAG 개요', text: 'GraphRAG는 지식그래프를 구축하고 커뮤니티 요약을 활용해 전역적 질의에 답하는 검색증강생성 기법이다. 코퍼스에서 엔티티와 관계를 추출하여 그래프를 만들고, 커뮤니티 탐지로 클러스터를 형성한 뒤 각 커뮤니티를 요약한다. 전역 검색은 맵-리듀스로 커뮤니티 요약을 종합하고, 지역 검색은 질의와 가까운 엔티티에서 그래프를 순회한다.' },
    { id: 'doc-vector', title: '벡터 RAG', text: '벡터 RAG는 문서를 청크로 나누고 임베딩하여 코사인 유사도로 top-k를 검색한다. chunk_size와 overlap, top_k가 품질에 큰 영향을 준다. 벡터 검색은 어휘가 달라도 의미가 유사한 문서를 잘 찾지만, 전역적 요약 질문에는 약하다.' },
    { id: 'doc-hybrid', title: '하이브리드 검색', text: '하이브리드 검색은 BM25 키워드 검색과 밀집 벡터 검색을 각각 수행한 뒤 Reciprocal Rank Fusion으로 순위를 융합한다. RRF는 점수 스케일 보정 없이 순위만으로 융합하므로 강건하다. 재랭킹 단계에서 크로스인코더나 LLM으로 상위 후보를 재정렬한다.' },
  ];

  // 검색 평가용 내장 데모 코퍼스(6문서) + 라벨셋(5질의 · 이진/등급 혼합)
  var EVAL_CORPUS = [
    { id: 'd-graphrag', title: 'GraphRAG', text: 'GraphRAG는 지식그래프를 구축하고 커뮤니티 탐지로 클러스터를 만든 뒤 각 커뮤니티를 요약한다. 전역 검색은 맵-리듀스로 커뮤니티 요약을 종합하여 전역적 질문에 답한다. 지역 검색은 질의와 가까운 엔티티에서 그래프를 순회한다.' },
    { id: 'd-vector', title: '벡터 검색', text: '벡터 검색은 문서를 청크로 나누고 임베딩하여 코사인 유사도로 top-k를 검색한다. 밀집 임베딩은 어휘가 달라도 의미가 유사한 문서를 잘 찾는다. 쿼리 임베딩과 문서 임베딩의 코사인 유사도로 순위를 매긴다.' },
    { id: 'd-hybrid', title: '하이브리드 융합', text: '하이브리드 검색은 BM25 키워드 검색과 밀집 벡터 검색을 각각 수행한 뒤 Reciprocal Rank Fusion(RRF)으로 두 순위를 융합한다. RRF는 점수 스케일 보정 없이 순위만으로 결합하므로 강건하다.' },
    { id: 'd-bm25', title: 'BM25 희소 검색', text: 'BM25는 용어 빈도(TF)와 역문서빈도(IDF)에 문서 길이 정규화를 결합한 키워드 기반 희소 검색 랭킹 함수다. 정확한 키워드 매칭에 강하지만 동의어나 의미 유사성은 포착하지 못한다.' },
    { id: 'd-rerank', title: '재랭킹', text: '재랭킹은 1차 검색으로 얻은 상위 후보를 크로스인코더나 LLM으로 다시 채점하여 재정렬한다. 크로스인코더는 질의와 문서를 함께 인코딩하여 정밀한 관련도를 산출하지만 비용이 크므로 상위 후보에만 적용한다.' },
    { id: 'd-chunk', title: '청킹 전략', text: '청킹은 문서를 검색 단위로 분할하는 과정이다. chunk_size와 overlap이 검색 품질에 큰 영향을 준다. 너무 크면 노이즈가 섞이고 너무 작으면 문맥이 끊긴다. 문장/재귀 분할이 고정 분할보다 문맥 보존에 유리하다.' },
  ];
  var EVAL_LABELS = [
    { query: '커뮤니티 요약으로 전역적 질문에 답하는 검색 기법은?', relevant: ['d-graphrag'] },
    { query: 'BM25 키워드 검색과 밀집 벡터 검색을 RRF로 융합하는 방법', relevant: { 'd-hybrid': 3, 'd-bm25': 1, 'd-vector': 1 } },
    { query: '임베딩 코사인 유사도로 top-k 문서를 찾는 방법', relevant: ['d-vector'] },
    { query: '크로스인코더로 상위 후보를 다시 채점해 재정렬하는 리랭킹', relevant: ['d-rerank'] },
    { query: 'chunk_size와 overlap이 검색 품질에 미치는 영향', relevant: ['d-chunk'] },
  ];
  var evalDemoIndex = null;   // 데모 코퍼스 인덱스 캐시

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    // 헤더
    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [
        el('div', { class: 'lab__title', text: 'RAG Lab' }),
        el('div', { class: 'lab__sub', text: '코퍼스 → 청킹 → 임베딩 → 검색 → 융합 → 재랭킹 → 컨텍스트 → 생성. 각 단계의 근거를 눈으로 확인합니다.' }),
      ]),
      el('div', { class: 'prov-legend' }, [provBadge('browser'), provBadge('server'), provBadge('approx'), provBadge('mock')]),
    ]));

    buildCorpusSection(inner);
    buildQuerySection(inner);
    buildEvalSection(inner);

    // 결과 영역
    E.pipeline = el('section', { class: 'card lab-sec', hidden: true });
    E.pipeline.appendChild(el('div', { class: 'lab-sec__head' }, [el('h3', { class: 'lab-sec__title', text: '파이프라인' })]));
    E.pipelineBody = el('div', { class: 'stepper' }); E.pipeline.appendChild(E.pipelineBody);
    inner.appendChild(E.pipeline);

    E.results = el('div', { id: 'ragResults' }); inner.appendChild(E.results);

    renderChunkPreview();
  }

  function buildCorpusSection(inner) {
    var sec = labSection('1 · 코퍼스 & 청킹');
    E.paste = el('textarea', { class: 'field field-mono', rows: 5, placeholder: '문서 텍스트를 붙여넣거나, 파일을 첨부하세요…' });

    var fileLbl = el('label', { class: 'btn btn-ghost btn-sm', for: 'ragFile', text: '파일(.txt/.md)' });
    var fileInp = el('input', { type: 'file', id: 'ragFile', accept: '.txt,.md,.markdown,text/plain', multiple: true, hidden: true });
    fileInp.addEventListener('change', function (e) {
      Array.prototype.forEach.call(e.target.files, function (f) {
        var r = new FileReader(); r.onload = function () { docs.push({ id: 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), title: f.name, text: String(r.result || '') }); renderDocList(); }; r.readAsText(f);
      });
      e.target.value = '';
    });
    var addPaste = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ 붙여넣기 추가' });
    addPaste.addEventListener('click', function () {
      var t = E.paste.value.trim(); if (!t) { toast('붙여넣을 텍스트가 없습니다.', 'warn'); return; }
      docs.push({ id: 'doc-' + Date.now(), title: '붙여넣기 ' + (docs.length + 1), text: t }); E.paste.value = ''; renderDocList();
    });
    var sampleBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '샘플 코퍼스' });
    sampleBtn.addEventListener('click', function () { docs = SAMPLE.map(function (d) { return { id: d.id, title: d.title, text: d.text }; }); renderDocList(); toast('샘플 코퍼스 3건 로드'); });

    // 드래그앤드롭
    E.paste.addEventListener('dragover', function (e) { e.preventDefault(); E.paste.classList.add('is-drop'); });
    E.paste.addEventListener('dragleave', function () { E.paste.classList.remove('is-drop'); });
    E.paste.addEventListener('drop', function (e) {
      e.preventDefault(); E.paste.classList.remove('is-drop');
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { var r = new FileReader(); r.onload = function () { docs.push({ id: 'doc-' + Date.now() + Math.random(), title: f.name, text: String(r.result || '') }); renderDocList(); }; r.readAsText(f); });
    });

    E.docList = el('div', { class: 'doc-list' });

    // 청킹 파라미터
    E.method = el('select', { class: 'field' });
    ['recursive', 'sentence', 'fixed'].forEach(function (m) { E.method.appendChild(el('option', { value: m, text: m })); });
    E.size = el('input', { type: 'number', class: 'field field-num', min: 50, step: 32, value: 400 });
    E.overlap = el('input', { type: 'number', class: 'field field-num', min: 0, step: 16, value: 64 });
    [E.method, E.size, E.overlap].forEach(function (c) { c.addEventListener('input', renderChunkPreview); });

    var buildBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '인덱스 구축 (청킹 + 임베딩)' });
    buildBtn.addEventListener('click', buildIndex);
    E.buildBtn = buildBtn;

    E.chunkInfo = el('div', { class: 'lab-note' });
    E.chunkPrev = el('div', { class: 'chunk-prev' });

    sec.appendChild(el('div', { class: 'lab-grid' }, [
      el('div', { class: 'field-col' }, [E.paste, el('div', { class: 'lab-btnrow' }, [addPaste, fileLbl, fileInp, sampleBtn])]),
      el('div', { class: 'field-col' }, [
        el('div', { class: 'param-mini' }, [
          el('label', { text: 'method' }), E.method,
          el('label', { text: 'chunk_size' }), E.size,
          el('label', { text: 'overlap' }), E.overlap,
        ]),
        E.docList,
        buildBtn,
      ]),
    ]));
    sec.appendChild(E.chunkInfo);
    sec.appendChild(E.chunkPrev);
    inner.appendChild(sec);
    renderDocList();
  }

  function renderDocList() {
    E.docList.innerHTML = '';
    if (!docs.length) { E.docList.appendChild(el('div', { class: 'field-note', text: '문서 없음 — 붙여넣기·파일·샘플로 추가' })); renderChunkPreview(); return; }
    docs.forEach(function (d, i) {
      var chip = el('span', { class: 'doc-chip' }, [
        el('span', { class: 'doc-chip__t', text: d.title }),
        el('span', { class: 'doc-chip__n', text: d.text.length + '자' }),
      ]);
      var rm = el('button', { type: 'button', class: 'doc-chip__x', 'aria-label': '삭제', text: '×' });
      rm.addEventListener('click', function () { docs.splice(i, 1); renderDocList(); });
      chip.appendChild(rm); E.docList.appendChild(chip);
    });
    renderChunkPreview();
  }

  function renderChunkPreview() {
    if (!E.chunkPrev) return;
    if (!docs.length) { E.chunkInfo.textContent = ''; E.chunkPrev.innerHTML = ''; return; }
    var res = L.rag.chunk({ docs: docs, method: E.method.value, size: Number(E.size.value), overlap: Number(E.overlap.value) });
    E.chunkInfo.innerHTML = '';
    E.chunkInfo.appendChild(el('span', { text: '예상 청크 ' + res.count + '개 · ' + res.ms + 'ms' }));
    E.chunkInfo.appendChild(provBadge(res.provider));
    if (index) E.chunkInfo.appendChild(el('span', { class: 'lab-note__ok', text: '· 인덱스: ' + index.chunks.length + '청크, dim ' + index.dim })), E.chunkInfo.appendChild(provBadge(index.embedProvider));
    E.chunkPrev.innerHTML = '';
    res.chunks.slice(0, 4).forEach(function (c, i) {
      E.chunkPrev.appendChild(el('div', { class: 'chunk-prev__item' }, [
        el('span', { class: 'chunk-prev__loc mono', text: '#' + (i + 1) + ' ' + c.docTitle + ' ' + c.loc }),
        el('span', { class: 'chunk-prev__txt', text: c.text.slice(0, 140) }),
      ]));
    });
    if (res.count > 4) E.chunkPrev.appendChild(el('div', { class: 'field-note', text: '… 외 ' + (res.count - 4) + '개' }));
  }

  function buildIndex() {
    if (!docs.length) { toast('먼저 문서를 추가하세요.', 'warn'); return; }
    var p = activeProfile();
    E.buildBtn.disabled = true; E.buildBtn.textContent = '구축 중…';
    var res = L.rag.chunk({ docs: docs, method: E.method.value, size: Number(E.size.value), overlap: Number(E.overlap.value) });
    L.rag.embed({ chunks: res.chunks, profile: p, useProxy: state.ui.useProxy }).then(function (emb) {
      index = { chunks: res.chunks, vectors: emb.vectors, dim: emb.dim, embedProvider: emb.provider, chunkMs: res.ms, embedMs: emb.ms };
      E.buildBtn.disabled = false; E.buildBtn.textContent = '인덱스 재구축 (청킹 + 임베딩)';
      renderChunkPreview();
      toast('인덱스 구축 완료 · ' + res.chunks.length + '청크 · 임베딩=' + emb.provider);
    });
  }

  function buildQuerySection(inner) {
    var sec = labSection('2 · 쿼리 & 검색');
    E.query = el('textarea', { class: 'field', rows: 2, placeholder: '질문을 입력하세요… (예: GraphRAG가 전역 질문에 강한 이유는?)' });

    E.mode = el('select', { class: 'field' });
    [['vector', 'Vector'], ['bm25', 'BM25'], ['hybrid', 'Hybrid (BM25+Dense+RRF)'], ['graph', 'Graph']].forEach(function (m) { E.mode.appendChild(el('option', { value: m[0], text: m[1] })); });
    E.mode.value = 'hybrid';
    E.mode.addEventListener('change', updateModeUI);

    E.topk = el('input', { type: 'number', class: 'field field-num', min: 1, max: 20, value: 4 });
    E.alpha = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 0.5 });
    E.alphaOut = el('output', { text: '0.5' });
    E.alpha.addEventListener('input', function () { E.alphaOut.textContent = E.alpha.value; });
    E.rrfk = el('input', { type: 'number', class: 'field field-num', min: 1, step: 1, value: 60 });

    E.hyde = mkToggle('HyDE');
    E.multi = mkToggle('Multi-Query');
    E.rerank = mkToggle('리랭크 (재정렬)');
    E.rerank.input.addEventListener('change', updateRerankUI);

    // 리랭크 상세 옵션 (토글 ON일 때 노출)
    E.rrMethod = el('select', { class: 'field' });
    [['llm', 'LLM (커널 채점)'], ['endpoint', 'Endpoint (Cohere류)']].forEach(function (m) { E.rrMethod.appendChild(el('option', { value: m[0], text: m[1] })); });
    E.rrMethod.addEventListener('change', updateRerankUI);
    E.rrTopN = el('input', { type: 'number', class: 'field field-num', min: 2, max: 50, step: 1, value: 10 });
    E.rrUrl = el('input', { type: 'text', class: 'field field-mono', placeholder: 'https://…/rerank (Cohere 호환)' });
    E.rrUrlRow = el('div', { class: 'param-mini' }, [el('label', { text: 'endpoint URL' }), E.rrUrl]);
    E.rerankRow = el('div', { class: 'param-mini rerank-row', hidden: true }, [
      el('label', { text: 'method' }), E.rrMethod,
      el('label', { text: 'top_n' }), E.rrTopN,
    ]);

    E.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '검색 실행' });
    E.runBtn.addEventListener('click', function () { runRetrieve(true); });
    E.genBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '검색 + 생성' });
    E.genBtn.addEventListener('click', function () { runRetrieveAndGenerate(); });
    E.cmpBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'RAG on/off 비교' });
    E.cmpBtn.addEventListener('click', function () { runCompare(); });

    E.hybridRow = el('div', { class: 'param-mini' }, [
      el('label', { text: 'α(dense)' }), el('div', { class: 'range-inline' }, [E.alpha, E.alphaOut]),
      el('label', { text: 'rrf_k' }), E.rrfk,
    ]);

    // 검색 백엔드 선택 (브라우저 / DB(pgvector·neo4j))
    E.backend = el('select', { class: 'field', id: 'ragBackend' });
    E.backendBadge = el('span', { class: 'backend-badge' });
    E.backend.addEventListener('change', updateBackendBadge);

    sec.appendChild(E.query);
    sec.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: 'mode' }), E.mode,
      el('label', { text: 'top_k' }), E.topk,
    ]));
    sec.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: '검색 백엔드' }), el('div', { class: 'range-inline' }, [E.backend, E.backendBadge]),
    ]));
    sec.appendChild(E.hybridRow);
    sec.appendChild(el('div', { class: 'lab-btnrow toggles' }, [E.hyde.wrap, E.multi.wrap, E.rerank.wrap]));
    sec.appendChild(E.rerankRow);
    sec.appendChild(E.rrUrlRow);
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [E.runBtn, E.genBtn, E.cmpBtn]));
    inner.appendChild(sec);
    updateModeUI();
    updateRerankUI();
    refreshBackends();
  }
  function updateRerankUI() {
    if (!E.rerankRow) return;
    var on = E.rerank.checked;
    E.rerankRow.hidden = !on;
    E.rrUrlRow.hidden = !(on && E.rrMethod.value === 'endpoint');
  }
  function rerankCfg() {
    return {
      enabled: E.rerank.checked,
      method: E.rrMethod ? E.rrMethod.value : 'llm',
      topN: E.rrTopN ? (Number(E.rrTopN.value) || 10) : 10,
      endpoint: E.rrUrl ? E.rrUrl.value.trim() : '',
    };
  }
  function refreshBackends() {
    if (!E.backend) return;
    var cur = E.backend.value;
    E.backend.innerHTML = '';
    E.backend.appendChild(el('option', { value: '', text: '브라우저 (기본)' }));
    (L.db ? L.db.list() : []).forEach(function (dbc) {
      if (dbc.type === 'pgvector' || dbc.type === 'neo4j') {
        E.backend.appendChild(el('option', { value: dbc.id, text: dbc.label + ' · ' + dbc.type }));
      }
    });
    var found = Array.prototype.some.call(E.backend.options, function (o) { return o.value === cur; });
    E.backend.value = found ? cur : '';
    updateBackendBadge();
  }
  function updateBackendBadge() {
    if (!E.backendBadge) return;
    E.backendBadge.innerHTML = '';
    var id = E.backend.value;
    if (!id) { E.backendBadge.appendChild(provBadge('browser')); return; }
    var dbc = L.db ? L.db.get(id) : null;
    E.backendBadge.appendChild(provBadge('server'));
    E.backendBadge.appendChild(el('span', { class: 'field-note', text: dbc ? ('DB · ' + dbc.type + (dbc.type === 'neo4j' ? ' (graph 모드)' : ' (vector/hybrid)')) : '' }));
  }
  function selectedDbConnId() { return E.backend ? (E.backend.value || null) : null; }
  function mkToggle(label) {
    var input = el('input', { type: 'checkbox' });
    var wrap = el('label', { class: 'chk' }, [input, el('span', { text: label })]);
    return { wrap: wrap, input: input, get checked() { return input.checked; } };
  }
  function updateModeUI() {
    var m = E.mode.value;
    E.hybridRow.hidden = (m !== 'hybrid');
    E.hyde.wrap.style.display = (m === 'graph' || m === 'bm25') ? 'none' : '';
    E.multi.wrap.style.display = (m === 'graph') ? 'none' : '';
    E.rerank.wrap.style.display = (m === 'graph') ? 'none' : '';
    if (E.rerankRow) { E.rerankRow.style.display = (m === 'graph') ? 'none' : ''; E.rrUrlRow.style.display = (m === 'graph') ? 'none' : ''; }
    if (m !== 'graph') updateRerankUI();
  }

  function params() {
    var rc = rerankCfg();
    var baseTopK = Number(E.topk.value) || 4;
    // 리랭크 ON: 후보 풀을 top_n까지 확장(retrieve는 fuse까지만 — 재정렬은 별도 rerank() 스테이지).
    var effTopK = rc.enabled ? Math.max(baseTopK, rc.topN) : baseTopK;
    return {
      top_k: effTopK,
      hybrid: { alpha: Number(E.alpha.value), rrf_k: Number(E.rrfk.value) || 60 },
      hyde: E.hyde.checked, multiQuery: E.multi.checked,
      rerank: { enabled: false },   // 인라인 재랭킹 비활성 — L.rag.rerank() 독립 스테이지 사용
    };
  }

  function renderStepper(stages, extra) {
    E.pipeline.hidden = false;
    E.pipelineBody.innerHTML = '';
    (stages || []).forEach(function (s) {
      E.pipelineBody.appendChild(el('div', { class: 'step' }, [
        el('span', { class: 'step__name', text: s.name }),
        el('span', { class: 'step__ms mono', text: s.ms + 'ms' }),
        (s.count != null ? el('span', { class: 'step__cnt', text: s.count + '건' }) : null),
        provBadge(s.provider || 'browser'),
        (s.note ? el('span', { class: 'step__note', text: s.note }) : null),
      ]));
    });
    if (extra) E.pipelineBody.appendChild(extra);
  }

  function ensureIndex() {
    if (index) return true;
    // 자동 구축(동기 청킹 + approx 임베딩은 즉시)
    return false;
  }

  function runRetrieve(render) {
    var q = E.query.value.trim(); if (!q) { toast('질문을 입력하세요.', 'warn'); return; }
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
    var mode = E.mode.value;
    if (mode === 'graph') return runGraph(q);
    var dbId = selectedDbConnId();
    var dbc = dbId && L.db ? L.db.get(dbId) : null;
    var pgBackend = !!(dbc && dbc.type === 'pgvector' && (mode === 'vector' || mode === 'hybrid'));
    if (!ensureIndex() && !pgBackend) { toast('먼저 인덱스를 구축하세요.', 'warn'); return; }
    // pgvector 백엔드인데 로컬 인덱스가 없으면 stub 인덱스(서버 검색 전용)
    if (!index && pgBackend) index = { chunks: [], vectors: [], dim: (dbc.vector && dbc.vector.dim) || 384, embedProvider: 'server', chunkMs: 0, embedMs: 0 };
    busy = true; setBusy(true);
    var t0 = performance.now();
    return L.rag.retrieve({
      chunks: index.chunks, vectors: index.vectors, dim: index.dim, embedProvider: index.embedProvider,
      query: q, mode: mode, params: params(), profile: p, model: profileModel(p), useProxy: state.ui.useProxy,
      dbConnId: dbId,
    }).then(function (res) {
      lastResult = res;
      var stages = [{ name: 'chunk', ms: index.chunkMs, count: index.chunks.length, provider: 'browser' },
                    { name: 'embed', ms: index.embedMs, count: index.chunks.length, provider: index.embedProvider }].concat(res.stages);
      var rc = rerankCfg();
      // ── retrieve→fuse→rerank: 융합 결과 상위 후보를 별도 rerank() 스테이지로 재정렬 ──
      if (rc.enabled && res.results && res.results.length) {
        var cand = res.results.map(function (r, i) {
          return { id: r.chunkId, chunkId: r.chunkId, text: r.text, score: r.score, rank: i + 1 };
        });
        return L.rag.rerank({
          query: q, candidates: cand, method: rc.method, topN: rc.topN, endpoint: rc.endpoint,
          profile: p, profileId: p.id, model: profileModel(p), useProxy: state.ui.useProxy,
        }).then(function (rr) {
          applyRerank(res, rr);
          stages.push({ name: 'rerank(' + rr.method + ')', ms: rr.ms, count: rr.after.length,
            provider: rr.provider,
            note: rr.ok ? (rr.scoreMode || '') : ('실패 — 원순위 유지' + (rr.error ? ': ' + (rr.error.message || rr.error.type || '') : '')) });
          busy = false; setBusy(false);
          renderStepper(stages);
          if (render) renderResults(res, null);
          return res;
        });
      }
      busy = false; setBusy(false);
      renderStepper(stages);
      if (render) renderResults(res, null);
      return res;
    });
  }

  // rerank 결과를 res.results에 반영(재정렬 + signals.rerank 주입)
  function applyRerank(res, rr) {
    res.rerank = rr;
    if (!rr || !rr.ok) return;   // 실패 시 원순위 유지
    var byId = {}; (res.results || []).forEach(function (r) { byId[r.chunkId] = r; });
    var reordered = [];
    rr.after.forEach(function (a) {
      var r = byId[a.id] != null ? byId[a.id] : byId[a.chunkId];
      if (r) { r.signals = r.signals || {}; r.signals.rerank = a.score; reordered.push(r); }
    });
    (res.results || []).forEach(function (r) { if (reordered.indexOf(r) < 0) reordered.push(r); });
    res.results = reordered;
  }

  function runRetrieveAndGenerate() {
    var pr = runRetrieve(false);
    if (!pr) return;
    pr.then(function (res) {
      if (!res || !res.results || !res.results.length) { renderResults(res, null); toast('검색 결과가 없습니다.', 'warn'); return; }
      var ctx = L.rag.buildContext(res.results, { maxChars: 4000 });
      var ansWrap = renderResults(res, ctx);
      generateAnswer(E.query.value.trim(), ctx, ansWrap);
    });
  }

  function generateAnswer(q, ctx, ansWrap) {
    var p = activeProfile();
    var bubble = ansWrap.bubble; var badge = ansWrap.badge;
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    var sys = '너는 제공된 컨텍스트만 근거로 답한다. 각 문장 끝에 사용한 근거 번호를 [n] 형식으로 인용하라. 컨텍스트에 없으면 모른다고 답하라.\n\n[컨텍스트]\n' + ctx.contextText;
    var full = '';
    var ctl = new AbortController(); abortCtl = ctl;
    L.kernel.run({
      module: 'rag', profileId: p.id, model: profileModel(p), useProxy: state.ui.useProxy,
      params: state.sessionParams, extraHeaders: activeHeaders(), stream: true, reasoningEnabled: false, signal: ctl.signal,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: q }],
      onToken: function (d) { full += d; renderMarkdownInto(bubble, full); },
      onDone: function (r) { full = r.content || full; renderMarkdownInto(bubble, linkifyCitations(full)); badge.innerHTML = ''; badge.appendChild(provBadge('server')); },
      onError: function (e) { bubble.innerHTML = '<div class="msg__error"><b>' + escapeHtml(e.type || '오류') + '</b>' + escapeHtml(e.message || '') + '</div>'; },
    });
  }
  function linkifyCitations(md) {
    return md.replace(/\[(\d+)\]/g, function (m, n) { return '<sup class="cite" data-n="' + n + '">[' + n + ']</sup>'; });
  }

  function renderResults(res, ctx) {
    E.results.innerHTML = '';
    // 쿼리 변환 표시
    if (res && (res.hydeDoc || (res.transformedQueries && res.transformedQueries.length))) {
      var qtSec = labSection('쿼리 변환', provBadge('server'));
      if (res.hydeDoc) qtSec.appendChild(el('div', { class: 'lab-note' }, [el('b', { text: 'HyDE 가상문서: ' }), el('span', { text: res.hydeDoc.slice(0, 260) })]));
      if (res.transformedQueries && res.transformedQueries.length) {
        var ul = el('ul', { class: 'qt-list' }); res.transformedQueries.forEach(function (q) { ul.appendChild(el('li', { text: q })); }); qtSec.appendChild(ul);
      }
      E.results.appendChild(qtSec);
    }
    // 3열 랭킹 비교(hybrid)
    if (res && res.mode === 'hybrid' && res.lists && res.lists.fused) {
      E.results.appendChild(buildRankCompare(res));
    }
    // 리랭킹 전/후 비교
    if (res && res.rerank) {
      E.results.appendChild(buildRerankCompare(res.rerank));
    }
    // 근거 청크
    var chunkSec = labSection('Retrieved Chunks (' + (res && res.results ? res.results.length : 0) + ')', provBadge(res ? res.provider : 'browser'));
    var byId = {}; index.chunks.forEach(function (c) { byId[c.id] = c; });
    (res && res.results ? res.results : []).forEach(function (r, i) {
      var n = i + 1;
      var sig = r.signals || {};
      var sigrow = el('div', { class: 'sig-row' });
      [['bm25', sig.bm25], ['dense', sig.dense], ['rrf', sig.rrf], ['rerank', sig.rerank]].forEach(function (pair) {
        if (pair[1] == null) return;
        sigrow.appendChild(el('span', { class: 'sig', html: '<i>' + pair[0] + '</i>' + (typeof pair[1] === 'number' ? pair[1].toFixed(pair[0] === 'rrf' ? 4 : (pair[0] === 'rerank' ? 0 : 3)) : pair[1]) }));
      });
      chunkSec.appendChild(el('div', { class: 'rchunk', id: 'rag-chunk-' + n }, [
        el('div', { class: 'rchunk__head' }, [
          el('span', { class: 'rchunk__n', text: '[' + n + ']' }),
          el('span', { class: 'rchunk__src mono', text: (r.source.title || r.docId) + ' · ' + (r.source.loc || '') }),
          el('span', { class: 'rchunk__score mono', text: 'score ' + (r.score != null ? r.score.toFixed(4) : '—') }),
        ]),
        el('div', { class: 'rchunk__txt', text: r.text }),
        sigrow,
      ]));
    });
    E.results.appendChild(chunkSec);

    // 컨텍스트 프리뷰
    if (ctx) {
      var cSec = labSection('컨텍스트 프리뷰 (모델 주입)');
      cSec.appendChild(codeBlock(ctx.contextText, false));
      E.results.appendChild(cSec);
    }

    // 최종 답변 컨테이너
    var badge = el('span', {});
    var ansSec = labSection('최종 답변', badge);
    var bubble = el('div', { class: 'msg__bubble md rag-answer' });
    ansSec.appendChild(bubble);
    E.results.appendChild(ansSec);
    // 인용 클릭 → 청크로 스크롤
    bubble.addEventListener('click', function (e) {
      var c = e.target.closest('.cite'); if (!c) return;
      var t = document.getElementById('rag-chunk-' + c.dataset.n);
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('is-flash'); setTimeout(function () { t.classList.remove('is-flash'); }, 1200); }
    });
    return { bubble: bubble, badge: badge };
  }

  function buildRankCompare(res) {
    var sec = labSection('랭킹 비교 (BM25 · Dense · RRF-Fused)', provBadge('browser'));
    var byId = {}; index.chunks.forEach(function (c) { byId[c.id] = c; });
    var cols = [['BM25', res.lists.bm25 || []], ['Dense (' + res.embedProvider + ')', res.lists.dense || []], ['RRF-Fused', res.lists.fused || []]];
    var fusedRank = {}; (res.lists.fused || []).forEach(function (r) { fusedRank[r.chunkId] = r.rank; });
    var grid = el('div', { class: 'rank-grid' });
    cols.forEach(function (col) {
      var box = el('div', { class: 'rank-col' }, [el('div', { class: 'rank-col__h', text: col[0] })]);
      col[1].slice(0, 8).forEach(function (r) {
        var c = byId[r.chunkId] || {};
        var delta = fusedRank[r.chunkId] != null ? (fusedRank[r.chunkId] - r.rank) : null;
        var arrow = '';
        if (col[0].indexOf('Fused') < 0 && delta != null) { arrow = delta > 0 ? '▲' + delta : (delta < 0 ? '▼' + (-delta) : '='); }
        box.appendChild(el('div', { class: 'rank-item' }, [
          el('span', { class: 'rank-item__r mono', text: '#' + r.rank }),
          el('span', { class: 'rank-item__t', text: (c.docTitle || '') + ' ' + (c.loc || '') }),
          el('span', { class: 'rank-item__s mono', text: (r.score != null ? r.score.toFixed(3) : '') }),
          arrow ? el('span', { class: 'rank-item__d', text: arrow }) : null,
        ]));
      });
      grid.appendChild(box);
    });
    sec.appendChild(el('div', { class: 'scroll-x' }, [grid]));
    return sec;
  }

  // 리랭킹 전/후 비교 뷰 — 융합 순위 → rerank 순위, 이동(▲/▼)·점수 표시
  function buildRerankCompare(rr) {
    var methodLabel = rr.method === 'endpoint' ? 'Endpoint' : 'LLM';
    var sec = labSection('리랭킹 · 재정렬 전/후 (' + methodLabel + (rr.scoreMode ? ' · ' + rr.scoreMode : '') + ')', provBadge(rr.provider));
    if (!rr.ok) {
      sec.appendChild(el('div', { class: 'lab-note lab-note--warn' }, [
        el('b', { text: '재정렬 실패 — 원순위 유지. ' }),
        el('span', { text: rr.error ? ('(' + (rr.error.type || '') + ') ' + (rr.error.message || '')) : '' }),
      ]));
    }
    // 요약 스탯: 이동한 후보 수
    var movedN = (rr.moved || []).filter(function (m) { return m.delta !== 0; }).length;
    sec.appendChild(el('div', { class: 'lab-note', text: '후보 ' + (rr.after ? rr.after.length : 0) + '개 · 순위 변동 ' + movedN + '개 · ' + rr.ms + 'ms' }));

    var beforeById = {}; (rr.before || []).forEach(function (b) { beforeById[String(b.id)] = b; });
    var beforeCol = el('div', { class: 'rr-col' }, [el('div', { class: 'rr-col__h', text: '재정렬 전 (융합 순위)' })]);
    (rr.before || []).forEach(function (b) {
      beforeCol.appendChild(el('div', { class: 'rr-item' }, [
        el('span', { class: 'rr-item__r mono', text: '#' + b.rank }),
        el('span', { class: 'rr-item__t', text: (b.text || '').replace(/\s+/g, ' ').slice(0, 80) }),
        el('span', { class: 'rr-item__s mono', text: b.score != null ? b.score.toFixed(4) : '—' }),
      ]));
    });
    var afterCol = el('div', { class: 'rr-col' }, [el('div', { class: 'rr-col__h', text: '재정렬 후 (rerank 점수)' })]);
    (rr.after || []).forEach(function (a) {
      var cls = a.delta > 0 ? 'rr-up' : (a.delta < 0 ? 'rr-down' : 'rr-same');
      var arrow = a.delta > 0 ? ('▲' + a.delta) : (a.delta < 0 ? ('▼' + (-a.delta)) : '=');
      afterCol.appendChild(el('div', { class: 'rr-item ' + cls }, [
        el('span', { class: 'rr-item__r mono', text: '#' + a.rank }),
        el('span', { class: 'rr-item__from mono', text: '전 #' + a.fromRank }),
        el('span', { class: 'rr-item__d ' + cls, text: arrow }),
        el('span', { class: 'rr-item__t', text: (a.text || '').replace(/\s+/g, ' ').slice(0, 70) }),
        el('span', { class: 'rr-item__s mono', text: a.score != null ? ('' + a.score) : '—' }),
      ]));
    });
    var grid = el('div', { class: 'rr-grid' }, [beforeCol, afterCol]);
    sec.appendChild(el('div', { class: 'scroll-x' }, [grid]));
    return sec;
  }

  function runCompare() {
    var q = E.query.value.trim(); if (!q) { toast('질문을 입력하세요.', 'warn'); return; }
    var pr = runRetrieve(false); if (!pr) return;
    pr.then(function (res) {
      var ctx = res && res.results && res.results.length ? L.rag.buildContext(res.results, { maxChars: 4000 }) : { contextText: '', citations: [] };
      renderResults(res, ctx);
      var cmp = labSection('RAG on/off 비교', null);
      var p = activeProfile();
      var withB = el('div', { class: 'msg__bubble md' }), woB = el('div', { class: 'msg__bubble md' });
      cmp.appendChild(el('div', { class: 'cmp-grid' }, [
        el('div', { class: 'cmp-col' }, [el('div', { class: 'cmp-col__h' }, [el('span', { text: 'RAG 켜짐' }), provBadge('server')]), withB]),
        el('div', { class: 'cmp-col' }, [el('div', { class: 'cmp-col__h' }, [el('span', { text: 'RAG 꺼짐' }), provBadge('server')]), woB]),
      ]));
      E.results.appendChild(cmp);
      streamInto(withB, [{ role: 'system', content: '컨텍스트만 근거로 [n] 인용하며 답하라.\n' + ctx.contextText }, { role: 'user', content: q }], p);
      streamInto(woB, [{ role: 'user', content: q }], p);
    });
  }
  function streamInto(bubble, messages, p) {
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    var full = '';
    L.kernel.run({
      module: 'rag', profileId: p.id, model: profileModel(p), useProxy: state.ui.useProxy, params: state.sessionParams,
      extraHeaders: activeHeaders(), stream: true, reasoningEnabled: false, messages: messages,
      onToken: function (d) { full += d; renderMarkdownInto(bubble, full); },
      onDone: function (r) { renderMarkdownInto(bubble, r.content || full); },
      onError: function (e) { bubble.innerHTML = '<div class="msg__error">' + escapeHtml(e.message || '오류') + '</div>'; },
    });
  }

  function runGraph(q) {
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
    setBusy(true);
    renderStepper([{ name: 'graph build', ms: 0, provider: 'browser', note: '추출 중…' }]);
    var chunks = index ? index.chunks : L.rag.chunk({ docs: docs, method: E.method.value, size: Number(E.size.value), overlap: Number(E.overlap.value) }).chunks;
    L.rag.buildGraph({ chunks: chunks, query: q, mode: 'global', profile: p, model: profileModel(p), useProxy: state.ui.useProxy, dbConnId: selectedDbConnId() }).then(function (g) {
      setBusy(false); graphData = g;
      renderStepper([{ name: 'graph build', ms: g.stats ? g.stats.latencyMs : 0, count: g.nodes.length, provider: g.provider, note: g.note || (g.degraded ? 'mock 강등' : (g.provider === 'browser' ? 'LLM 추출' : (g.provider === 'server' ? 'DB(neo4j·server)' : ''))) }]);
      renderGraphResults(g);
    });
  }
  function renderGraphResults(g) {
    E.results.innerHTML = '';
    var sec = labSection('Knowledge Graph (' + g.nodes.length + ' 노드 · ' + g.edges.length + ' 엣지 · ' + (g.communities ? g.communities.length : 0) + ' 커뮤니티)', provBadge(g.provider));
    var canvas = el('canvas', { class: 'graph-canvas' });
    var holder = el('div', { class: 'graph-holder' }, [canvas]);
    sec.appendChild(holder);
    E.results.appendChild(sec);
    if (window.GraphView && g.nodes.length) {
      try {
        if (graphView) graphView.destroy();
        graphView = window.GraphView; graphView.mount(canvas, {}); graphMounted = true;
        graphView.setTheme(state.ui.theme !== 'light');
        graphView.setData({ nodes: g.nodes, edges: g.edges, communities: g.communities });
        setTimeout(function () { try { graphView.resize(); graphView.reheat && graphView.reheat(); } catch (e) {} }, 60);
      } catch (e) { holder.appendChild(el('div', { class: 'field-note', text: '그래프 렌더 실패: ' + e.message })); }
    }
    // 커뮤니티 요약
    if (g.communities && g.communities.length) {
      var cs = labSection('커뮤니티', null);
      g.communities.forEach(function (c) { cs.appendChild(el('div', { class: 'lab-note' }, [el('b', { text: (c.title || c.id) + ': ' }), el('span', { text: c.summary || '' })])); });
      E.results.appendChild(cs);
    }
    // 그래프 mock 답변
    if (g.answer) {
      var asec = labSection('그래프 응답', provBadge(g.provider));
      var b = el('div', { class: 'msg__bubble md' }); renderMarkdownInto(b, g.answer); asec.appendChild(b);
      E.results.appendChild(asec);
    }
  }

  function setBusy(on) {
    E.runBtn.disabled = on; E.genBtn.disabled = on; E.cmpBtn.disabled = on;
    E.runBtn.textContent = on ? '실행 중…' : '검색 실행';
  }

  /* ============================================================
     3 · 검색 평가 (Retrieval Eval) — nDCG · MRR · Recall · Precision · MAP
     ============================================================ */
  var METHOD_LABELS = { bm25: 'BM25', dense: 'Dense (Vector)', hybrid: 'Hybrid (RRF)', 'hybrid+rerank': 'Hybrid + Rerank' };

  function buildEvalSection(inner) {
    var sec = labSection('3 · 검색 평가 (Retrieval Eval)', provBadge('browser'));
    sec.appendChild(el('div', { class: 'lab-note', text: '라벨된 질의셋에 대해 검색 방법을 실행하고 nDCG · MRR · Recall · Precision · MAP를 계산해 정량 비교합니다. 라벨: [\"docId\",…](이진) 또는 {\"docId\":grade}(등급).' }));

    // 코퍼스 소스
    EV.corpus = el('select', { class: 'field' });
    [['demo', '데모 코퍼스 (내장 6문서)'], ['current', '현재 인덱스 (위에서 구축한 코퍼스)']].forEach(function (o) { EV.corpus.appendChild(el('option', { value: o[0], text: o[1] })); });

    // 라벨셋 입력
    EV.labels = el('textarea', { class: 'field field-mono', rows: 6, placeholder: '라벨셋(JSON 배열 또는 JSONL)…\n[{"query":"…","relevant":["docId1","docId2"]},\n {"query":"…","relevant":{"docId1":3,"docId2":1}}]' });
    var demoBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '데모 라벨셋 로드' });
    demoBtn.addEventListener('click', function () {
      EV.corpus.value = 'demo';
      EV.labels.value = JSON.stringify(EVAL_LABELS, null, 2);
      toast('데모 라벨셋 5질의 로드 (데모 코퍼스 6문서)');
    });
    var clearBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비우기' });
    clearBtn.addEventListener('click', function () { EV.labels.value = ''; });

    // 방법 체크
    EV.methods = {};
    var methodRow = el('div', { class: 'lab-btnrow toggles' });
    [['bm25', true], ['dense', true], ['hybrid', true], ['hybrid+rerank', false]].forEach(function (m) {
      var input = el('input', { type: 'checkbox' }); input.checked = m[1];
      EV.methods[m[0]] = input;
      methodRow.appendChild(el('label', { class: 'chk' }, [input, el('span', { text: METHOD_LABELS[m[0]] })]));
    });

    // k 설정
    EV.ks = el('input', { type: 'text', class: 'field field-mono', value: '5,10', placeholder: '5,10' });

    EV.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '평가 실행' });
    EV.runBtn.addEventListener('click', runRetrievalEval);
    EV.status = el('span', { class: 'field-note' });

    sec.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: '코퍼스' }), EV.corpus,
      el('label', { text: 'k (쉼표)' }), EV.ks,
    ]));
    sec.appendChild(el('div', { class: 'field-col' }, [
      EV.labels,
      el('div', { class: 'lab-btnrow' }, [demoBtn, clearBtn]),
    ]));
    sec.appendChild(el('div', { class: 'field-note', text: '비교할 검색 방법:' }));
    sec.appendChild(methodRow);
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [EV.runBtn, EV.status]));
    EV.out = el('div', { class: 'eval-out' });
    sec.appendChild(EV.out);
    inner.appendChild(sec);

    // 데모 라벨셋 기본 프리필(즉시 실행 가능하도록)
    EV.labels.value = JSON.stringify(EVAL_LABELS, null, 2);
  }

  function parseKs(s) {
    var ks = String(s || '').split(/[,\s]+/).map(function (x) { return parseInt(x, 10); }).filter(function (n) { return n > 0; });
    return ks.length ? ks.filter(function (n, i, a) { return a.indexOf(n) === i; }).sort(function (a, b) { return a - b; }) : [5, 10];
  }
  function parseLabelset(text) {
    text = String(text || '').trim();
    if (!text) return [];
    // JSON 배열 우선
    if (text[0] === '[') { try { var a = JSON.parse(text); if (Array.isArray(a)) return a; } catch (e) {} }
    // 단일 객체
    if (text[0] === '{' && text.indexOf('\n') < 0) { try { var o = JSON.parse(text); if (o && o.query) return [o]; } catch (e) {} }
    // JSONL (줄마다 객체)
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim(); if (!line || line === '[' || line === ']') return;
      if (line.slice(-1) === ',') line = line.slice(0, -1);
      try { var r = JSON.parse(line); if (r && r.query) out.push(r); } catch (e) {}
    });
    return out;
  }

  // 데모 코퍼스 인덱스(청킹 + approx 임베딩, 오프라인 결정적) — 캐시
  function ensureEvalDemoIndex() {
    if (evalDemoIndex) return Promise.resolve(evalDemoIndex);
    var res = L.rag.chunk({ docs: EVAL_CORPUS, method: 'sentence', size: 400, overlap: 0 });
    return L.rag.embed({ chunks: res.chunks, allowServer: false, useProxy: false, dim: 256 }).then(function (emb) {
      evalDemoIndex = { chunks: res.chunks, vectors: emb.vectors, dim: emb.dim, embedProvider: 'approx' };
      return evalDemoIndex;
    });
  }

  // 검색 → docId 랭킹(중복 제거, 순위 보존)
  function evalRetrieveFn(idx, allowRerank) {
    return function (query, method) {
      var mode = method === 'bm25' ? 'bm25' : (method === 'dense' ? 'vector' : 'hybrid');
      var doRerank = (method === 'hybrid+rerank') && allowRerank;
      var maxK = Math.min(idx.chunks.length || 10, 50);
      return L.rag.retrieve({
        chunks: idx.chunks, vectors: idx.vectors, dim: idx.dim, embedProvider: idx.embedProvider,
        query: query, mode: mode,
        params: { top_k: maxK, hybrid: { alpha: 0.5, rrf_k: 60 }, rerank: doRerank ? { enabled: true, top_n: maxK } : { enabled: false } },
        profile: doRerank ? activeProfile() : null, model: doRerank ? profileModel(activeProfile()) : undefined,
        useProxy: state.ui.useProxy,
      }).then(function (res) {
        var seen = {}, ids = [];
        (res.results || []).forEach(function (r) { var d = r.docId; if (d != null && !seen[d]) { seen[d] = true; ids.push(d); } });
        return ids;
      });
    };
  }

  function runRetrievalEval() {
    var dataset = parseLabelset(EV.labels.value);
    if (!dataset.length) { toast('라벨셋을 입력하거나 "데모 라벨셋 로드"를 누르세요.', 'warn'); return; }
    var methods = Object.keys(EV.methods).filter(function (m) { return EV.methods[m].checked; });
    if (!methods.length) { toast('비교할 방법을 하나 이상 선택하세요.', 'warn'); return; }
    var ks = parseKs(EV.ks.value);
    var useCurrent = EV.corpus.value === 'current';

    // rerank는 활성 연결이 있을 때만 실제 수행(없으면 hybrid 순위로 폴백 — 결정적, 네트워크 없음)
    var hasProfile = !!activeProfile();
    if (methods.indexOf('hybrid+rerank') >= 0 && !hasProfile) {
      toast('활성 연결이 없어 Hybrid+Rerank는 Hybrid 순위로 폴백됩니다.', 'warn');
    }

    EV.runBtn.disabled = true; EV.runBtn.textContent = '평가 중…'; EV.status.textContent = '';
    EV.out.innerHTML = '';

    var idxP;
    if (useCurrent) {
      if (!index || !index.chunks.length) { EV.runBtn.disabled = false; EV.runBtn.textContent = '평가 실행'; toast('현재 인덱스가 없습니다. 위에서 "인덱스 구축"을 먼저 하세요.', 'warn'); return; }
      idxP = Promise.resolve(index);
    } else {
      idxP = ensureEvalDemoIndex();
    }

    idxP.then(function (idx) {
      return L.eval.runRetrievalEval({
        dataset: dataset, methods: methods, ks: ks,
        retrieveFn: function (q, m) { return evalRetrieveFn(idx, hasProfile)(q, m); },
        onProgress: function (p) { EV.status.textContent = p.done + ' / ' + p.total; },
      });
    }).then(function (res) {
      EV.runBtn.disabled = false; EV.runBtn.textContent = '평가 실행';
      EV.status.textContent = '완료 · ' + res.perQuery.length + '개 (질의×방법)';
      renderEvalResults(res, useCurrent ? '현재 인덱스' : '데모 코퍼스');
    }).catch(function (e) {
      EV.runBtn.disabled = false; EV.runBtn.textContent = '평가 실행';
      EV.status.textContent = '오류: ' + (e && e.message || e);
      toast('평가 실패: ' + (e && e.message || e), 'warn');
    });
  }

  function fmt(v) { return (typeof v === 'number' && !isNaN(v)) ? v.toFixed(3) : '—'; }

  function renderEvalResults(res, corpusLabel) {
    EV.out.innerHTML = '';
    var ks = res.ks;
    // 지표 컬럼 순서
    var cols = [];
    ks.forEach(function (k) { cols.push('ndcg@' + k); });
    ks.forEach(function (k) { cols.push('recall@' + k); });
    ks.forEach(function (k) { cols.push('precision@' + k); });
    cols.push('mrr'); cols.push('map');

    // 각 컬럼 최고값(강조용)
    var best = {};
    cols.forEach(function (c) {
      var mx = -Infinity;
      res.methods.forEach(function (m) { var v = res.byMethod[m].avg[c]; if (typeof v === 'number' && v > mx) mx = v; });
      best[c] = mx;
    });

    // 요약 표 (method × metric)
    EV.out.appendChild(el('div', { class: 'eval-cap', text: '평균 지표 · ' + corpusLabel + ' · 질의 ' + (res.perQuery.length / res.methods.length) + '개 · 최고값 강조' }));
    var thead = el('tr', {}, [el('th', { class: 'eval-th-m', text: '방법' })].concat(cols.map(function (c) { return el('th', { text: c }); })));
    var rows = [thead];
    res.methods.forEach(function (m) {
      var avg = res.byMethod[m].avg;
      var tds = [el('td', { class: 'eval-td-m', text: METHOD_LABELS[m] || m })];
      cols.forEach(function (c) {
        var v = avg[c];
        var isBest = (typeof v === 'number') && best[c] > -Infinity && Math.abs(v - best[c]) < 1e-9 && v > 0;
        tds.push(el('td', { class: 'mono' + (isBest ? ' eval-best' : ''), text: fmt(v) }));
      });
      rows.push(el('tr', {}, tds));
    });
    var table = el('table', { class: 'eval-table' }, [el('tbody', {}, rows)]);
    EV.out.appendChild(el('div', { class: 'scroll-x' }, [table]));

    // 질의별 상세(펼침)
    var det = el('details', { class: 'eval-details' }, [el('summary', { text: '질의별 상세 (' + (res.perQuery.length / res.methods.length) + '질의 × ' + res.methods.length + '방법)' })]);
    // 질의 인덱스별 그룹
    var byQi = {};
    res.perQuery.forEach(function (r) { (byQi[r.qi] = byQi[r.qi] || []).push(r); });
    Object.keys(byQi).forEach(function (qi) {
      var group = byQi[qi];
      var q = group[0];
      var relStr = Array.isArray(q.relevant) ? q.relevant.join(', ') : Object.keys(q.relevant).map(function (k) { return k + ':' + q.relevant[k]; }).join(', ');
      var qbox = el('div', { class: 'eval-qbox' });
      qbox.appendChild(el('div', { class: 'eval-q' }, [el('span', { class: 'eval-q__i', text: 'Q' + (Number(qi) + 1) }), el('span', { class: 'eval-q__t', text: q.query })]));
      qbox.appendChild(el('div', { class: 'eval-q__rel mono', text: '정답: ' + relStr }));
      var qrows = [el('tr', {}, [el('th', { text: '방법' }), el('th', { class: 'eval-th-rank', text: '랭킹 (docId)' })].concat(cols.map(function (c) { return el('th', { text: c }); })))];
      group.forEach(function (r) {
        var relSet = {}; (Array.isArray(r.relevant) ? r.relevant : Object.keys(r.relevant).filter(function (k) { return Number(r.relevant[k]) > 0; })).forEach(function (id) { relSet[id] = true; });
        var rankSpans = r.ranked.slice(0, Math.max.apply(null, ks)).map(function (id) {
          return el('span', { class: 'eval-rk' + (relSet[id] ? ' eval-rk--hit' : ''), text: id });
        });
        var tds = [el('td', { class: 'eval-td-m', text: METHOD_LABELS[r.method] || r.method }), el('td', {}, [el('div', { class: 'eval-rankline' }, rankSpans)])];
        cols.forEach(function (c) { tds.push(el('td', { class: 'mono', text: fmt(r.metrics[c]) })); });
        qrows.push(el('tr', {}, tds));
      });
      qbox.appendChild(el('div', { class: 'scroll-x' }, [el('table', { class: 'eval-table eval-table--q' }, [el('tbody', {}, qrows)])]));
      det.appendChild(qbox);
    });
    EV.out.appendChild(det);
  }

  return {
    build: build,
    onShow: function () { if (graphMounted && graphView) setTimeout(function () { try { graphView.resize(); } catch (e) {} }, 40); },
    onTheme: function (isDark) { if (graphMounted && graphView) { try { graphView.setTheme(isDark); } catch (e) {} } },
    refreshBackends: function () { try { if (E.backend) refreshBackends(); } catch (e) {} },
  };
})();

/* ============================================================
   24. CHAIN / WORKFLOW 모듈
   ============================================================ */
var CHAIN = (function () {
  var E = {};
  var chain = { id: 'chain-' + Date.now(), name: '새 체인', steps: [] };
  var vars = [];              // [{name,value}]
  var abortCtl = null, running = false;
  var LSKEY = 'llmlab.chains';

  var TYPES = [
    { t: 'input', label: 'Input', desc: '변수 설정' },
    { t: 'llm', label: 'Prompt/LLM', desc: '템플릿 → 모델 호출' },
    { t: 'transform', label: 'Transform', desc: 'JS 변환' },
    { t: 'condition', label: 'Condition', desc: '분기/중단' },
    { t: 'output', label: 'Output', desc: '최종 결과' },
  ];

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [el('div', { class: 'lab__title', text: 'Chain / Workflow' }), el('div', { class: 'lab__sub', text: '스텝 출력이 다음 입력으로 전달되는 선형 체인 러너. Transform(JS)·Condition(분기)·저장/불러오기 지원.' })]),
      el('div', { class: 'prov-legend' }, [provBadge('browser'), provBadge('server')]),
    ]));

    // 툴바
    E.name = el('input', { type: 'text', class: 'field', value: chain.name, placeholder: '체인 이름' });
    E.name.addEventListener('input', function () { chain.name = E.name.value; });
    var runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ Run chain' }); runBtn.addEventListener('click', run); E.runBtn = runBtn;
    var saveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '저장' }); saveBtn.addEventListener('click', saveChain);
    var loadBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '불러오기' }); loadBtn.addEventListener('click', openLoadMenu);
    var expBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export' }); expBtn.addEventListener('click', exportChain);
    var impBtn = el('label', { class: 'btn btn-ghost btn-sm', for: 'chainImport', text: 'Import' });
    var impInp = el('input', { type: 'file', id: 'chainImport', accept: '.json,application/json', hidden: true });
    impInp.addEventListener('change', importChain);
    var presetBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '프리셋' }); presetBtn.addEventListener('click', openPresetMenu);

    inner.appendChild(el('section', { class: 'card lab-sec' }, [
      el('div', { class: 'lab-btnrow' }, [E.name, runBtn, saveBtn, loadBtn, expBtn, impBtn, impInp, presetBtn]),
      (E.loadArea = el('div', {})),
    ]));

    // 변수 정의
    var vsec = labSection('Variables');
    E.varList = el('div', { class: 'var-list' });
    var addVar = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ 변수' });
    addVar.addEventListener('click', function () { vars.push({ name: 'var' + (vars.length + 1), value: '' }); renderVars(); });
    vsec.appendChild(E.varList); vsec.appendChild(addVar);
    inner.appendChild(vsec);

    // 스텝
    var ssec = labSection('Steps');
    E.stepList = el('div', { class: 'step-list' });
    E.addRow = el('div', { class: 'lab-btnrow' });
    TYPES.forEach(function (ty) {
      var b = el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: '+ ' + ty.label });
      b.addEventListener('click', function () { chain.steps.push(L.chain.blankStep(ty.t)); renderSteps(); });
      E.addRow.appendChild(b);
    });
    ssec.appendChild(E.stepList); ssec.appendChild(E.addRow);
    inner.appendChild(ssec);

    // 트레이스
    E.trace = el('div', { id: 'chainTrace' });
    inner.appendChild(E.trace);

    if (!chain.steps.length) loadPreset('extract-summarize');
    renderVars(); renderSteps();
  }

  function renderVars() {
    E.varList.innerHTML = '';
    if (!vars.length) { E.varList.appendChild(el('div', { class: 'field-note', text: '변수 없음 — 프롬프트에서 {{name}}으로 참조' })); return; }
    vars.forEach(function (v, i) {
      var name = el('input', { type: 'text', class: 'field', value: v.name, placeholder: '이름' });
      var val = el('input', { type: 'text', class: 'field', value: v.value, placeholder: '값' });
      name.addEventListener('input', function () { v.name = name.value; });
      val.addEventListener('input', function () { v.value = val.value; });
      var rm = el('button', { type: 'button', class: 'btn-icon', 'aria-label': '삭제' }); rm.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      rm.addEventListener('click', function () { vars.splice(i, 1); renderVars(); });
      E.varList.appendChild(el('div', { class: 'var-item' }, [name, val, rm]));
    });
  }

  function renderSteps() {
    E.stepList.innerHTML = '';
    if (!chain.steps.length) { E.stepList.appendChild(el('div', { class: 'field-note', text: '스텝을 추가하세요.' })); return; }
    chain.steps.forEach(function (s, i) { E.stepList.appendChild(buildStepCard(s, i)); });
  }

  function stepIcon(t) {
    return { input: '#5A97FF', llm: 'llm', transform: 'js', condition: '?', output: 'out' }[t];
  }
  function buildStepCard(s, i) {
    var card = el('div', { class: 'step-card step-card--' + s.type, id: 'step-' + s.id });
    var head = el('div', { class: 'step-card__head' }, [
      el('span', { class: 'step-card__idx mono', text: (i + 1) }),
      el('span', { class: 'step-card__type', text: s.type }),
      el('input', { type: 'text', class: 'field step-card__title', value: s.title || '', placeholder: '스텝 제목', oninput: function (e) { s.title = e.target.value; } }),
    ]);
    var up = el('button', { type: 'button', class: 'btn-icon btn-icon--xs', 'aria-label': '위로', title: '위로' }); up.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>';
    up.addEventListener('click', function () { if (i > 0) { var t = chain.steps[i - 1]; chain.steps[i - 1] = s; chain.steps[i] = t; renderSteps(); } });
    var dn = el('button', { type: 'button', class: 'btn-icon btn-icon--xs', 'aria-label': '아래로', title: '아래로' }); dn.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
    dn.addEventListener('click', function () { if (i < chain.steps.length - 1) { var t = chain.steps[i + 1]; chain.steps[i + 1] = s; chain.steps[i] = t; renderSteps(); } });
    var rm = el('button', { type: 'button', class: 'btn-icon btn-icon--xs', 'aria-label': '삭제', title: '삭제' }); rm.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    rm.addEventListener('click', function () { chain.steps.splice(i, 1); renderSteps(); });
    head.appendChild(el('div', { class: 'step-card__ctrls' }, [up, dn, rm]));
    card.appendChild(head);

    var bodyEl = el('div', { class: 'step-card__body' });
    if (s.type === 'input') {
      s.vars = s.vars || [];
      var vl = el('div', { class: 'var-list' });
      var render = function () {
        vl.innerHTML = '';
        s.vars.forEach(function (v, vi) {
          var nm = el('input', { type: 'text', class: 'field', value: v.name, placeholder: '이름', oninput: function (e) { v.name = e.target.value; } });
          var vv = el('input', { type: 'text', class: 'field', value: v.value, placeholder: '값 ({{다른변수}} 사용가능)', oninput: function (e) { v.value = e.target.value; } });
          var x = el('button', { type: 'button', class: 'btn-icon btn-icon--xs' }); x.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
          x.addEventListener('click', function () { s.vars.splice(vi, 1); render(); });
          vl.appendChild(el('div', { class: 'var-item' }, [nm, vv, x]));
        });
      };
      render();
      var add = el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: '+ 변수' }); add.addEventListener('click', function () { s.vars.push({ name: 'v' + (s.vars.length + 1), value: '' }); render(); });
      bodyEl.appendChild(vl); bodyEl.appendChild(add);
    } else if (s.type === 'llm') {
      var ta = el('textarea', { class: 'field field-mono', rows: 3, placeholder: '프롬프트 — {{변수}} · {{stepId.output}} · {{input}}', value: s.prompt || '' });
      ta.value = s.prompt || ''; ta.addEventListener('input', function () { s.prompt = ta.value; });
      var model = el('input', { type: 'text', class: 'field', value: s.model || '', placeholder: '모델(비우면 활성 모델)' });
      model.addEventListener('input', function () { s.model = model.value; });
      bodyEl.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'prompt' }), ta]));
      bodyEl.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'model 오버라이드' }), model]));
      bodyEl.appendChild(el('div', { class: 'field-note', text: 'id: ' + s.id + ' → 다음 스텝에서 {{' + s.id + '.output}}' }));
    } else if (s.type === 'transform') {
      var code = el('textarea', { class: 'field field-mono', rows: 4, placeholder: 'return input.trim();' });
      code.value = s.code || ''; code.addEventListener('input', function () { s.code = code.value; });
      bodyEl.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'JS: (ctx, input, vars) → 결과' }), code]));
      bodyEl.appendChild(el('div', { class: 'field-note', text: '옵트인 · 브라우저 로컬 실행(사용자 코드)' }));
    } else if (s.type === 'condition') {
      var expr = el('input', { type: 'text', class: 'field field-mono', value: s.expr || '', placeholder: 'input.length > 100' });
      expr.addEventListener('input', function () { s.expr = expr.value; });
      var thenSel = mkStepSelect(s, 'then'); var elseSel = mkStepSelect(s, 'els');
      var stop = el('input', { type: 'checkbox' }); stop.checked = !!s.stopOnFalse; stop.addEventListener('change', function () { s.stopOnFalse = stop.checked; });
      bodyEl.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'expr: (ctx, input) → boolean' }), expr]));
      bodyEl.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: 'true →' }), thenSel, el('label', { text: 'false →' }), elseSel]));
      bodyEl.appendChild(el('label', { class: 'chk' }, [stop, el('span', { text: 'false 이면 체인 중단' })]));
    } else if (s.type === 'output') {
      var src = el('input', { type: 'text', class: 'field field-mono', value: s.source || '', placeholder: '비우면 직전 출력 · 또는 stepId.output' });
      src.addEventListener('input', function () { s.source = src.value; });
      bodyEl.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'source' }), src]));
    }
    // 스텝 결과(트레이스 연동)
    s._out = el('div', { class: 'step-card__result', hidden: true });
    bodyEl.appendChild(s._out);
    card.appendChild(bodyEl);
    return card;
  }
  function mkStepSelect(s, key) {
    var sel = el('select', { class: 'field' });
    sel.appendChild(el('option', { value: '', text: '(다음 스텝)' }));
    chain.steps.forEach(function (st) { if (st.id !== s.id) { var o = el('option', { value: st.id, text: (st.title || st.type) }); if (s[key] === st.id) o.selected = true; sel.appendChild(o); } });
    sel.addEventListener('change', function () { s[key] = sel.value; });
    return sel;
  }

  function run() {
    if (running) { if (abortCtl) abortCtl.abort(); return; }
    var v = L.chain.validate(chain);
    if (!v.ok) { toast('체인 오류: ' + v.errors[0], 'warn'); return; }
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
    running = true; E.runBtn.textContent = '■ 중단'; E.runBtn.classList.add('is-running');
    var ctl = new AbortController(); abortCtl = ctl;
    // 트레이스 초기화
    E.trace.innerHTML = '';
    var tsec = labSection('실행 트레이스', null);
    var body = el('div', { class: 'trace' }); tsec.appendChild(body); E.trace.appendChild(tsec);
    chain.steps.forEach(function (s) { if (s._out) { s._out.hidden = true; s._out.innerHTML = ''; } });

    var varMap = {}; vars.forEach(function (x) { if (x.name) varMap[x.name] = x.value; });

    L.chain.run({
      chain: chain, vars: varMap, profile: p, profileId: p.id, model: profileModel(p),
      params: state.sessionParams, useProxy: state.ui.useProxy, signal: ctl.signal,
      onStep: function (info) { markStep(info.stepId, 'running'); },
      onStepDone: function (rec) { appendTrace(body, rec); markStep(rec.stepId, rec.status, rec); },
    }).then(function (res) {
      running = false; E.runBtn.textContent = '▶ Run chain'; E.runBtn.classList.remove('is-running');
      var out = labSection('최종 출력', provBadge('browser'));
      var b = el('div', { class: 'msg__bubble md' }); renderMarkdownInto(b, res.output || '(빈 출력)'); out.appendChild(b);
      E.trace.appendChild(out);
      toast(res.ok ? '체인 완료' : (res.aborted ? '중단됨' : '체인 오류'), res.ok ? 'ok' : 'warn');
    });
  }
  function markStep(id, status, rec) {
    var card = document.getElementById('step-' + id); if (!card) return;
    card.dataset.status = status;
    var st = chain.steps.filter(function (x) { return x.id === id; })[0];
    if (rec && st && st._out) {
      st._out.hidden = false; st._out.innerHTML = '';
      st._out.appendChild(el('div', { class: 'step-card__result-h' }, [
        el('span', { class: 'mono', text: status + ' · ' + (rec.ms || 0) + 'ms' }),
        provBadge(rec.provider || 'browser'),
        (rec.usage ? el('span', { class: 'mono', text: (rec.usage.total_tokens || '?') + ' tok' }) : null),
        (rec.note ? el('span', { class: 'step__note', text: rec.note }) : null),
      ]));
      if (rec.output) st._out.appendChild(el('pre', { class: 'step-card__out', text: String(rec.output).slice(0, 800) }));
      if (rec.error) st._out.appendChild(el('div', { class: 'msg__error', text: rec.error.message || '오류' }));
    }
  }
  function appendTrace(body, rec) {
    body.appendChild(el('div', { class: 'trace__item trace__item--' + rec.status }, [
      el('span', { class: 'trace__dot' }),
      el('span', { class: 'trace__name', text: (rec.title || rec.type) }),
      el('span', { class: 'trace__type mono', text: rec.type }),
      el('span', { class: 'trace__ms mono', text: (rec.ms || 0) + 'ms' }),
      provBadge(rec.provider || 'browser'),
    ]));
  }

  /* 저장/불러오기/export/import */
  function saved() { return lsGet(LSKEY, {}); }
  function saveChain() {
    if (!chain.name.trim()) { toast('체인 이름을 입력하세요.', 'warn'); return; }
    var all = saved(); all[chain.name] = snapshot(); lsSet(LSKEY, all); toast('저장됨: ' + chain.name);
  }
  function snapshot() { return { id: chain.id, name: chain.name, steps: clone(chain.steps), vars: clone(vars) }; }
  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
  function openLoadMenu() {
    E.loadArea.innerHTML = '';
    var all = saved(); var names = Object.keys(all);
    if (!names.length) { E.loadArea.appendChild(el('div', { class: 'field-note', text: '저장된 체인 없음' })); return; }
    var box = el('div', { class: 'lab-btnrow' });
    names.forEach(function (n) {
      var b = el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: n }); b.addEventListener('click', function () { loadChain(all[n]); E.loadArea.innerHTML = ''; });
      var x = el('button', { type: 'button', class: 'btn btn-ghost btn-xs danger', text: '×' }); x.addEventListener('click', function () { delete all[n]; lsSet(LSKEY, all); openLoadMenu(); });
      box.appendChild(el('span', { class: 'load-chip' }, [b, x]));
    });
    E.loadArea.appendChild(box);
  }
  function loadChain(snap) {
    chain = { id: snap.id || ('chain-' + Date.now()), name: snap.name || '체인', steps: snap.steps || [] };
    vars = snap.vars || [];
    E.name.value = chain.name; renderVars(); renderSteps(); E.trace.innerHTML = '';
    toast('불러옴: ' + chain.name);
  }
  function exportChain() { downloadFile((chain.name || 'chain').replace(/\s+/g, '_') + '.json', JSON.stringify(Object.assign({ schemaVersion: '1', type: 'llm-lab-chain' }, snapshot()), null, 2)); }
  function importChain(e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader(); r.onload = function () {
      try { var data = JSON.parse(r.result); loadChain(data); } catch (err) { toast('Import 실패: ' + err.message, 'err'); }
    }; r.readAsText(f); e.target.value = '';
  }

  /* 프리셋 — 프롬프트 체이닝 패턴 20종 (조사: _workspace/01_chain_presets_research.md)
     스텝 상호참조가 필요하면 blankStep의 랜덤 id를 사람이 읽는 슬러그로 오버라이드한다.
     라우팅(2방향)은 "가드 스텝" 패턴으로 구현(엔진은 condition~target 사이만 skip). */
  /* PRESETS_START (verify_v32_presets.js 가 이 마커 사이를 추출한다 — 편집 시 마커 유지) */
  var mkLlm = function (id, title, prompt, params) { return Object.assign(L.chain.blankStep('llm'), { id: id, title: title, prompt: prompt, params: params || {} }); };
  var mkCond = function (id, title, expr, then, els) { return Object.assign(L.chain.blankStep('condition'), { id: id, title: title, expr: expr, then: then || '', els: els || '', stopOnFalse: false }); };
  var mkTf = function (id, title, code) { return Object.assign(L.chain.blankStep('transform'), { id: id, title: title, code: code }); };
  var mkOut = function (id, title) { return Object.assign(L.chain.blankStep('output'), { id: id || 'out', title: title || '최종 출력', source: '' }); };
  var PRESETS = {
    'extract-summarize': { name: '추출→요약 (문서 QA)', tier: 'basic', desc: '긴 문서에서 근거 인용문을 먼저 뽑고 그 근거만으로 답을 합성',
      vars: [{ name: 'question', value: '이 계약의 해지 통지 기간은?' }, { name: 'doc', value: '제12조(해지) 본 임대차 계약은 어느 일방이 해지하고자 할 경우, 계약 만료일 최소 60일 전까지 서면으로 상대방에게 통지하여야 한다. 통지 없이 만료일이 도래하면 동일 조건으로 1년간 자동 갱신된다.' }],
      steps: [
        mkLlm('extract', '근거 추출', '다음 문서에서 "{{question}}"에 답하는 데 필요한 핵심 인용문만 골라 <quote> 태그로 감싸 나열하라. 없으면 "관련 없음". 문서:\n{{doc}}'),
        mkLlm('synth', '답변 합성', '아래 인용문만 근거로 "{{question}}"에 정확하고 도움이 되게 답하라. 각 주장 끝에 근거 인용을 표시하라. 인용문:\n{{input}}'),
        mkOut(),
      ] },
    'chain-of-thought': { name: '단계적 추론 (CoT)', tier: 'basic', desc: '단계별로 생각시켜 추론 정확도를 높이고 최종 답만 분리 추출',
      vars: [{ name: 'problem', value: '카페에 사과 23개가 있었다. 20개를 쓰고 6개를 더 샀다. 남은 사과는?' }],
      steps: [
        mkLlm('reason', '단계적 추론', '다음 문제를 단계별로 차근차근 풀어라. 각 단계의 계산·근거를 명시하라.\n문제: {{problem}}'),
        mkLlm('answer', '정답 추출', '아래 풀이의 최종 정답만 한 줄로 간결히 제시하라.\n풀이:\n{{input}}'),
        mkOut(),
      ] },
    'self-refine': { name: '자기비평→개선 (Self-Refine)', tier: 'basic', desc: '초안을 스스로 비평하고 그 피드백으로 다시 쓰기 (추가 학습 없이 품질↑)',
      vars: [{ name: 'task', value: '원격근무의 장단점을 한 문단으로 설명하는 글' }],
      steps: [
        mkLlm('draft', '초안', '다음 작업의 결과물 초안을 작성하라.\n작업: {{task}}'),
        mkLlm('critique', '자기비평', '아래 결과물을 비평가로서 평가하라. 구체적 결함 3~5가지와 개선 지시를 목록으로 작성하라.\n결과물:\n{{input}}'),
        mkLlm('refine', '개선', '원래 작업: {{task}}\n초안: {{draft.output}}\n피드백: {{critique.output}}\n피드백을 모두 반영해 개선본을 작성하라.'),
        mkOut(),
      ] },
    'draft-critique-revise': { name: '초안→비평→수정 (글쓰기)', tier: 'basic', desc: '청중·목적 렌즈로 톤/구조/설득력을 점검하는 실무 글쓰기 3단계',
      vars: [{ name: 'topic', value: '사내 4일 근무제 도입 제안' }, { name: 'audience', value: '경영진' }, { name: 'goal', value: '파일럿 승인 설득' }],
      steps: [
        mkLlm('draft', '초안', '주제 "{{topic}}"에 대해 대상 독자 "{{audience}}", 목적 "{{goal}}"에 맞는 글 초안을 작성하라.'),
        mkLlm('critique', '편집자 비평', '편집자로서 아래 글을 명료성·구조·설득력·톤 기준으로 평가하고 수정 지시를 목록화하라. 독자: {{audience}}.\n글:\n{{input}}'),
        mkLlm('revise', '수정', '지시에 따라 글을 다시 써라.\n원문: {{draft.output}}\n지시: {{critique.output}}'),
        mkOut(),
      ] },
    'translate-polish': { name: '번역→윤문', tier: 'basic', desc: '직역 후 원어민 문체로 다듬는 2단계 (기계번역 어색함 제거)',
      vars: [{ name: 'src', value: 'Our new release ships next week; hit us up if you run into issues.' }, { name: 'targetLang', value: '한국어' }, { name: 'tone', value: '정중한 비즈니스체' }],
      steps: [
        mkLlm('translate', '직역', '다음 텍스트를 {{targetLang}}로 정확히 번역하라. 의미 누락 없이.\n{{src}}'),
        mkLlm('polish', '윤문', '아래 번역문을 원문 의미를 유지하며 {{targetLang}} 원어민이 쓴 듯 자연스럽게, 톤은 {{tone}}로 다듬어라.\n번역:\n{{input}}'),
        mkOut(),
      ] },
    'classify-route': { name: '분류→라우팅', tier: 'routing', desc: '입력을 분류하고 종류별 전용 프롬프트로 분기 (가드 스텝 패턴)',
      vars: [{ name: 'msg', value: '지난주 결제한 프로 요금제를 취소하고 돈을 돌려받고 싶어요.' }],
      steps: [
        mkLlm('classify', '분류', '다음 문의를 [환불, 기술지원, 일반문의] 중 하나로 분류하라. 라벨 한 단어만 출력하라.\n문의: {{msg}}'),
        mkCond('route', '분기: 환불?', "input.includes('환불')", 'refund', 'general'),
        mkLlm('refund', '환불 응대', '환불 정책에 따라 정중히 환불 절차를 안내하는 답변 초안을 작성하라. 문의: {{msg}}'),
        mkCond('guard', '→ 출력으로(가드)', 'true', 'out', ''),
        mkLlm('general', '기술/일반 응대', '문의 유형 "{{classify.output}}"에 맞춰 해결 지향적 답변 초안을 작성하라. 문의: {{msg}}'),
        mkOut(),
      ] },
    'least-to-most': { name: '질문분해→종합 (Least-to-Most)', tier: 'basic', desc: '복잡한 질문을 쉬운 하위질문으로 분해→순차 해결→최종 종합',
      vars: [{ name: 'question', value: '반지름 5cm 원기둥에 물을 3cm 채운 뒤 반지름 1cm 쇠공 4개를 넣으면 수위는?' }],
      steps: [
        mkLlm('decompose', '분해', '다음 질문을 풀기 위해 먼저 답해야 할 하위 질문들을 쉬운 것부터 순서대로 번호 매겨 나열하라.\n질문: {{question}}'),
        mkLlm('solve', '순차 해결', '원 질문: {{question}}\n하위 질문 목록:\n{{input}}\n각 하위 질문에 순서대로 답하되, 앞 답을 활용해 누적 추론하라.'),
        mkLlm('synth', '종합', '아래 하위 답변들을 종합해 원 질문 "{{question}}"에 대한 최종 답을 제시하라.\n{{input}}'),
        mkOut(),
      ] },
    'map-reduce-summary': { name: 'Map-Reduce 요약 (근사)', tier: 'pipeline', desc: '장문을 청크로 나눠(transform) 각 청크 요약+통합요약 — 병렬 팬아웃은 없는 순차 근사',
      vars: [{ name: 'doc', value: '(장문 문서를 여기에 붙여넣으세요) 1장 서론: 본 백서는 분산 시스템의 합의 알고리즘을 다룬다. 2장 배경: Paxos와 Raft의 차이를 설명한다. 3장 구현: 리더 선출과 로그 복제 과정을 기술한다. 4장 평가: 처리량과 지연을 벤치마크했다. 5장 결론: Raft가 이해와 구현 측면에서 우수하다.' }],
      steps: [
        mkTf('chunk', '청킹(≈1200자)', "var d=String(ctx.doc||input||'');var parts=d.match(/[\\s\\S]{1,1200}/g)||[d];return parts.map(function(c,i){return '=== 청크 '+(i+1)+' ===\\n'+c;}).join('\\n\\n');"),
        mkLlm('summarize', '청크요약+통합', '다음은 긴 문서를 청크로 나눈 것이다. 각 청크(=== 청크 N ===)를 2~3문장으로 각각 요약한 뒤, 마지막에 전체를 아우르는 하나의 통합 요약을 작성하라. 중복은 제거하라.\n\n{{input}}'),
        mkOut(),
      ] },
    'chain-of-verification': { name: '검증체인 (CoVe)', tier: 'basic', desc: '답→검증질문 생성→검증→수정으로 환각을 줄이는 사실형 답변',
      vars: [{ name: 'question', value: '1990년대에 노벨 문학상을 받은 한국 작가를 모두 알려줘.' }],
      steps: [
        mkLlm('answer', '기준 답', '다음 질문에 답하라: {{question}}'),
        mkLlm('verifyq', '검증 질문 생성', '아래 답변의 사실성을 점검할 독립 검증 질문 3~5개를 만들어라.\n답변:\n{{input}}'),
        mkLlm('verify', '검증 답변', '다음 검증 질문들에 각각 사실 기반으로 간결히 답하라.\n{{input}}'),
        mkLlm('revise', '최종 수정', '원 질문: {{question}}\n초기 답: {{answer.output}}\n검증 결과: {{verify.output}}\n검증과 모순되는 부분을 바로잡아 최종 답을 작성하라.'),
        mkOut(),
      ] },
    'step-back': { name: 'Step-Back (추상화 먼저)', tier: 'basic', desc: '구체 질문에 답하기 전 상위 원리/개념을 먼저 끌어내 맥락을 잡음',
      vars: [{ name: 'question', value: '이상기체가 압력 2배, 절대온도 2배가 되면 부피는 어떻게 되나?' }],
      steps: [
        mkLlm('abstract', '추상화', '다음 질문에 답하기 전에, 관련된 더 일반적인 원리나 배경 개념은 무엇인지 먼저 서술하라.\n질문: {{question}}'),
        mkLlm('answer', '본답', '배경 원리:\n{{input}}\n이 원리를 근거로 원 질문에 정확히 답하라.\n질문: {{question}}'),
        mkOut(),
      ] },
    'plan-and-solve': { name: '계획→실행 (Plan-and-Solve)', tier: 'basic', desc: '명시적 계획을 먼저 세우고 그 계획대로 실행 (계산 누락 감소)',
      vars: [{ name: 'task', value: '한 반 30명 중 60%가 안경을 쓰고, 그중 1/3이 콘택트렌즈도 쓴다. 콘택트렌즈 사용자 수는?' }],
      steps: [
        mkLlm('plan', '계획', '문제를 이해하고, 변수를 추출하고, 풀이 계획을 단계별로 세워라. 아직 계산은 하지 마라.\n문제: {{task}}'),
        mkLlm('solve', '실행', '아래 계획을 그대로 실행해 각 단계를 계산·수행하고 최종 답을 내라.\n계획:\n{{input}}\n문제: {{task}}'),
        mkOut(),
      ] },
    'extract-validate-json': { name: '추출→JSON검증→정형화', tier: 'pipeline', desc: 'LLM 추출→transform JSON.parse 검증→실패 시 재요청(가드), 성공 시 정형 출력',
      vars: [{ name: 'text', value: '안녕하세요, 홍길동입니다. 3월 5일에 노트북 2대와 마우스 3개 주문했고 총 245만원 결제했습니다.' }],
      steps: [
        mkLlm('extract', '추출', '다음 텍스트에서 {name, date, amount, items[]}를 JSON으로만 추출하라. 설명·마크다운 금지, 순수 JSON만.\n{{text}}'),
        mkTf('validate', 'JSON 검증', "var s=String(input).replace(/```json/gi,'').replace(/```/g,'').trim();try{var o=JSON.parse(s);return JSON.stringify(o,null,2);}catch(e){return 'INVALID: '+s;}"),
        mkCond('gate', '분기: 유효?', "input.indexOf('INVALID')===0", 'reask', 'out'),
        mkLlm('reask', '재요청', '이전 출력이 유효한 JSON이 아니었다. 반드시 유효한 JSON만 다시 출력하라. 설명·마크다운 금지. 원문:\n{{text}}'),
        mkOut('out', '정형 출력'),
      ] },
    'support-sentiment-route': { name: '고객지원 감정분기', tier: 'routing', desc: '감정/긴급도 판별→부정·긴급이면 공감·에스컬레이션, 아니면 표준 (가드 패턴)',
      vars: [{ name: 'ticket', value: '벌써 세 번째 배송 지연입니다. 정말 화가 나네요. 당장 처리해 주세요.' }],
      steps: [
        mkLlm('classify', '감정/긴급 분류', '다음 고객 메시지의 감정을 [긍정, 중립, 부정] 중 하나, 긴급도를 [낮음, 높음] 중 하나로 판단하라. "감정|긴급도" 형식으로만 출력하라.\n{{ticket}}'),
        mkCond('route', '분기: 부정/긴급?', "input.includes('부정')||input.includes('높음')", 'empathize', 'standard'),
        mkLlm('empathize', '공감·에스컬레이션', '불편을 겪은 고객에게 진심 어린 사과로 시작해 즉시 해결 의지를 보이고, 필요 시 담당자 연결을 제안하는 답변 초안을 작성하라. 문의: {{ticket}}'),
        mkCond('guard', '→ 출력으로(가드)', 'true', 'out', ''),
        mkLlm('standard', '표준 응대', '친절하고 간결한 표준 지원 답변 초안을 작성하라. 문의: {{ticket}}'),
        mkOut(),
      ] },
    'fact-check': { name: '사실확인 (주장→검증→판정)', tier: 'basic', desc: '텍스트에서 검증가능한 주장을 뽑아 각각 확인하고 종합 판정',
      vars: [{ name: 'statement', value: '에베레스트는 세계에서 가장 높은 산이며 높이는 약 8,848m이고 네팔과 인도 국경에 있다.' }],
      steps: [
        mkLlm('claims', '주장 추출', '다음 글에서 사실 여부를 확인할 수 있는 개별 주장들을 번호로 나열하라.\n{{statement}}'),
        mkLlm('verify', '개별 검증', '각 주장에 대해 알려진 사실에 비추어 [참/거짓/불명]과 근거를 적어라.\n{{input}}'),
        mkLlm('verdict', '종합 판정', '아래 검증 결과를 바탕으로 원문 전체의 신뢰도를 판정(정확/부분오류/오류)하고 요약하라.\n{{input}}'),
        mkOut(),
      ] },
    'code-test-fix': { name: '코드생성→테스트→수정', tier: 'basic', desc: '함수 생성→테스트케이스 자작→실패 지점 점검·보정으로 코드 신뢰성↑',
      vars: [{ name: 'spec', value: '정수 배열을 받아 중복을 제거하고 원래 순서를 유지해 반환하는 JS 함수' }],
      steps: [
        mkLlm('code', '코드 생성', '다음 요구사항을 만족하는 함수를 작성하라. 코드만.\n요구사항: {{spec}}'),
        mkLlm('tests', '테스트 설계', '아래 함수에 대한 경계·예외 포함 테스트케이스(입력→기대출력) 5개를 표로 제시하라.\n{{input}}'),
        mkLlm('fix', '검토·수정', '함수: {{code.output}}\n테스트: {{tests.output}}\n각 테스트를 머릿속으로 실행해 실패하는 케이스를 찾고, 버그를 수정한 최종 코드를 제시하라.'),
        mkOut(),
      ] },
    'meeting-actions': { name: '회의록→액션→우선순위', tier: 'basic', desc: '회의록에서 할 일을 추출해 담당·기한을 붙이고 우선순위로 정렬',
      vars: [{ name: 'transcript', value: '김PM: 다음 주 데모 전에 로그인 버그 고쳐야 해요. 이대리가 맡죠. 박대리는 발표자료 준비, 금요일까지. 마케팅은 나중에 논의.' }],
      steps: [
        mkLlm('extract', '액션 추출', '다음 회의록에서 액션 아이템을 {할일, 담당자, 기한} 형태로 목록화하라. 미언급은 "미정".\n{{transcript}}'),
        mkLlm('prioritize', '우선순위화', '아래 액션 아이템을 긴급도·중요도 기준으로 High/Med/Low 우선순위를 매기고 정렬해 표로 제시하라.\n{{input}}'),
        mkOut(),
      ] },
    'self-consistency': { name: '다중추론→다수결 (Self-Consistency)', tier: 'advanced', desc: '같은 문제를 3경로로 풀어(temp 0.8) 다수결 채택 — 정확도↑ 대신 지연 3배',
      vars: [{ name: 'problem', value: '주차장에 차가 3대 있고 2대가 더 들어온 뒤 절반이 나갔다. 남은 차는?' }],
      steps: [
        mkLlm('p1', '경로 1', '문제를 단계별로 풀고 최종 답을 밝혀라. 문제: {{problem}}', { temperature: 0.8 }),
        mkLlm('p2', '경로 2', '문제를 단계별로 풀고 최종 답을 밝혀라. 문제: {{problem}}', { temperature: 0.8 }),
        mkLlm('p3', '경로 3', '문제를 단계별로 풀고 최종 답을 밝혀라. 문제: {{problem}}', { temperature: 0.8 }),
        mkLlm('agg', '집계(다수결)', '아래 세 풀이의 최종 답을 비교해 가장 많이 나온 답(다수결)을 최종 답으로 확정하고 이유를 밝혀라.\n풀이1:{{p1.output}}\n풀이2:{{p2.output}}\n풀이3:{{p3.output}}'),
        mkOut(),
      ] },
    'skeleton-of-thought': { name: '개요→살붙이기 (SoT)', tier: 'basic', desc: '먼저 답의 뼈대(요점 목록)를 만들고 각 항목을 확장 — 구조·일관성↑',
      vars: [{ name: 'question', value: '주니어 개발자가 코드 리뷰를 잘 받으려면 어떻게 해야 하나?' }],
      steps: [
        mkLlm('skeleton', '뼈대', '다음 질문에 대한 답의 핵심 요점만 3~7개 짧은 항목으로 나열하라(각 3~5단어).\n질문: {{question}}'),
        mkLlm('expand', '살 붙이기', '아래 각 요점을 2~4문장으로 확장해 완결된 답을 작성하라. 요점 순서 유지.\n요점:\n{{input}}\n질문: {{question}}'),
        mkOut(),
      ] },
    'tree-of-thought-lite': { name: '후보→평가→전개 (ToT 근사)', tier: 'basic', desc: '여러 후보 생성→자기 평가→최선 선택→전개 (너비 1 빔서치 근사)',
      vars: [{ name: 'problem', value: '예산 500만원으로 소규모 카페의 첫 달 마케팅 전략을 짜라.' }],
      steps: [
        mkLlm('propose', '후보 생성', '다음 문제의 접근 방법을 서로 다른 3가지로 각각 한 단락씩 제안하라.\n문제: {{problem}}'),
        mkLlm('evaluate', '평가·선택', '아래 3가지 접근을 실현가능성·기대성과로 평가하고 최선 1개를 골라 이유를 밝혀라.\n{{input}}'),
        mkLlm('expand', '전개', '선택된 접근을 끝까지 구체적으로 전개해 최종 해답을 완성하라.\n선택:\n{{input}}\n문제: {{problem}}'),
        mkOut(),
      ] },
    'evaluator-optimizer': { name: '생성↔평가 루프 (Evaluator-Optimizer)', tier: 'advanced', desc: '생성기/평가기를 분리해 기준 통과 시 확정, 미달 시 1회 개선 (finalize가 분기별 출력 정렬)',
      vars: [{ name: 'task', value: '스타트업 소개 문구를 20자 이내 슬로건으로' }, { name: 'criteria', value: '20자 이내, 임팩트, 제품 핵심가치 반영' }],
      steps: [
        mkLlm('generate', '생성', '작업을 수행해 결과물을 작성하라. 작업: {{task}}'),
        mkLlm('evaluate', '평가', '아래 결과물을 기준 "{{criteria}}"로 채점하라. 통과면 첫 줄에 "PASS", 아니면 첫 줄에 "FAIL"과 개선점을 출력하라.\n{{input}}'),
        mkCond('gate', '분기: PASS?', "input.indexOf('PASS')===0", 'finalize', 'improve'),
        mkLlm('improve', '개선', '평가 피드백을 반영해 결과물을 개선하라.\n결과물:{{generate.output}}\n피드백:{{evaluate.output}}'),
        mkTf('finalize', '결과 확정', "return (ctx.gate&&ctx.gate.output==='true')?ctx.generate.output:(ctx.improve?ctx.improve.output:input);"),
        mkOut(),
      ] },
  };
  /* PRESETS_END */
  var PRESET_TIERS = [
    { key: 'basic', label: '기본 선형' },
    { key: 'routing', label: '조건 분기' },
    { key: 'pipeline', label: 'Transform 파이프라인' },
    { key: 'advanced', label: '다중 샘플·루프' },
  ];
  function openPresetMenu() {
    E.loadArea.innerHTML = '';
    var open = E.loadArea.dataset.mode === 'preset';
    if (open) { E.loadArea.dataset.mode = ''; return; }
    E.loadArea.dataset.mode = 'preset';
    var wrap = el('div', { class: 'preset-picker' });
    PRESET_TIERS.forEach(function (ti) {
      var keys = Object.keys(PRESETS).filter(function (k) { return (PRESETS[k].tier || 'basic') === ti.key; });
      if (!keys.length) return;
      wrap.appendChild(el('div', { class: 'preset-group__label' }, [
        el('span', { text: ti.label }), el('span', { class: 'preset-group__count mono', text: keys.length }),
      ]));
      var row = el('div', { class: 'preset-group__row' });
      keys.forEach(function (k) {
        var p = PRESETS[k];
        var b = el('button', { type: 'button', class: 'btn btn-ghost btn-xs preset-chip', text: p.name, title: p.desc || p.name });
        b.addEventListener('click', function () { loadPreset(k); E.loadArea.innerHTML = ''; E.loadArea.dataset.mode = ''; });
        row.appendChild(b);
      });
      wrap.appendChild(row);
    });
    E.loadArea.appendChild(wrap);
  }
  function loadPreset(k) {
    var p = PRESETS[k]; if (!p) return;
    chain = { id: 'chain-' + Date.now(), name: p.name, steps: clone(p.steps) };
    vars = clone(p.vars);
    if (E.name) { E.name.value = chain.name; renderVars(); renderSteps(); if (E.trace) E.trace.innerHTML = ''; }
  }

  return { build: build, onShow: function () {} };
})();

/* ============================================================
   25. AGENT / TOOLS 모듈 (§8.6 · ReAct)
   ============================================================ */
var AGENT = (function () {
  var A = L.agent;
  var E = {};
  var tools = [];             // tool def 객체(OpenAI tools 스키마)
  var abortCtl = null, running = false;

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [
        el('div', { class: 'lab__title', text: 'Agent / Tools' }),
        el('div', { class: 'lab__sub', text: 'tool 정의(JSON Schema) → tools/tool_choice 전송 → 모델 tool_call 파싱 → mock 결과 입력 또는 옵트인 JS 툴 실행 → 재주입. ReAct 멀티스텝 루프의 think → act → observe 트레이스.' }),
      ]),
      el('div', { class: 'prov-legend' }, [provBadge('server'), provBadge('js'), provBadge('mock')]),
    ]));

    buildToolSection(inner);
    buildRunSection(inner);

    E.trace = el('div', { id: 'agentTrace' });
    inner.appendChild(E.trace);

    if (!tools.length) tools = [A.blankTool()];
    renderToolList();
  }

  /* --- 1 · Tool 정의 에디터 --- */
  function buildToolSection(inner) {
    var sec = labSection('1 · Tool 정의 (JSON Schema)');
    E.toolText = el('textarea', { class: 'field field-mono', rows: 8, placeholder: 'OpenAI tools 스키마 …' });
    E.toolText.value = JSON.stringify(A.blankTool(), null, 2);

    var validateBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '검증' });
    validateBtn.addEventListener('click', function () {
      var r = A.validateTool(E.toolText.value);
      renderValidation(r);
    });
    var addBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '+ 목록에 추가' });
    addBtn.addEventListener('click', function () {
      var r = A.validateTool(E.toolText.value);
      renderValidation(r);
      if (!r.ok) { toast('검증 실패 — 오류를 확인하세요.', 'warn'); return; }
      tools.push(r.tool); renderToolList(); toast('tool 추가: ' + r.tool.function.name);
    });
    var tplBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '템플릿(blank)' });
    tplBtn.addEventListener('click', function () { E.toolText.value = JSON.stringify(A.blankTool(), null, 2); renderValidation(null); });
    var biBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '내장 JS 툴 삽입' });
    biBtn.addEventListener('click', function () {
      var added = 0;
      A.builtinTools().forEach(function (t) {
        if (!tools.some(function (x) { return x.function && x.function.name === t.function.name; })) { tools.push(t); added++; }
      });
      renderToolList(); toast('내장 JS 툴 ' + added + '개 추가 (toolMode=js 로 실행)');
    });

    E.valOut = el('div', { class: 'lab-note' });
    E.toolList = el('div', { class: 'tool-list' });

    sec.appendChild(el('div', { class: 'field-col' }, [E.toolText]));
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [validateBtn, addBtn, tplBtn, biBtn]));
    sec.appendChild(E.valOut);
    sec.appendChild(el('div', { class: 'field-note', text: '등록된 tools (요청 payload의 tools[] 로 전송):' }));
    sec.appendChild(E.toolList);
    inner.appendChild(sec);
  }
  function renderValidation(r) {
    E.valOut.innerHTML = '';
    if (!r) return;
    if (r.ok) { E.valOut.appendChild(el('span', { class: 'lab-note__ok', text: '✓ 유효한 tool 정의' })); }
    else { r.errors.forEach(function (e) { E.valOut.appendChild(el('span', { class: 'atrace__err', text: '• ' + e })); }); }
  }
  function isBuiltin(name) { return !!A.BUILTINS[name]; }
  function renderToolList() {
    E.toolList.innerHTML = '';
    if (!tools.length) { E.toolList.appendChild(el('div', { class: 'field-note', text: '등록된 tool 없음' })); return; }
    tools.forEach(function (t, i) {
      var nm = t.function ? t.function.name : '(이름없음)';
      var chip = el('span', { class: 'tool-chip tool-chip--reg' }, [
        el('b', { text: nm }),
        isBuiltin(nm) ? provBadge('js') : null,
      ]);
      var view = el('button', { type: 'button', class: 'tool-chip__b', title: '에디터로 불러오기', text: '⤢' });
      view.addEventListener('click', function () { E.toolText.value = JSON.stringify(t, null, 2); renderValidation(null); });
      var rm = el('button', { type: 'button', class: 'tool-chip__x', 'aria-label': '삭제', text: '×' });
      rm.addEventListener('click', function () { tools.splice(i, 1); renderToolList(); });
      chip.appendChild(view); chip.appendChild(rm);
      E.toolList.appendChild(chip);
    });
  }

  /* --- 2 · ReAct 실행 --- */
  function buildRunSection(inner) {
    var sec = labSection('2 · ReAct 실행 (think → act → observe)');
    E.system = el('textarea', { class: 'field field-mono', rows: 2, placeholder: '시스템 프롬프트(선택) — 예: 도구를 활용해 단계적으로 문제를 해결하라.' });
    E.goal = el('textarea', { class: 'field', rows: 2, placeholder: '목표 / 사용자 메시지 — 예: 서울의 현재 날씨를 조회하고 섭씨로 알려줘.' });

    E.maxSteps = el('input', { type: 'number', class: 'field field-num', min: 1, max: 20, step: 1, value: 6 });
    E.toolMode = el('select', { class: 'field' });
    [['mock', 'mock (결과 손입력)'], ['js', 'js (옵트인 내장툴)'], ['server', 'server (계약)']].forEach(function (o) { E.toolMode.appendChild(el('option', { value: o[0], text: o[1] })); });
    E.toolChoice = el('select', { class: 'field' });
    [['', 'auto'], ['required', 'required'], ['none', 'none']].forEach(function (o) { E.toolChoice.appendChild(el('option', { value: o[0], text: 'tool_choice: ' + o[1] })); });
    E.parallel = el('input', { type: 'checkbox' });

    E.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ ReAct 실행' });
    E.runBtn.addEventListener('click', run);

    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'system (선택)' }), E.system]));
    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '목표(user)' }), E.goal]));
    sec.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: 'max_steps' }), E.maxSteps,
      el('label', { text: 'toolMode' }), E.toolMode,
      E.toolChoice,
      el('label', { class: 'chk' }, [E.parallel, el('span', { text: 'parallel_tool_calls' })]),
    ]));
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [E.runBtn]));
    sec.appendChild(el('div', { class: 'field-note', text: 'mock: 모델이 tool_call을 내면 결과를 직접 입력해 재주입 · js: 내장 화이트리스트 툴을 브라우저에서 실행(옵트인).' }));
    inner.appendChild(sec);
  }

  function run() {
    if (running) { if (abortCtl) abortCtl.abort(); return; }
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
    var goal = E.goal.value.trim(); if (!goal) { toast('목표(user 메시지)를 입력하세요.', 'warn'); return; }
    var msgs = [];
    if (E.system.value.trim()) msgs.push({ role: 'system', content: E.system.value.trim() });
    msgs.push({ role: 'user', content: goal });
    var mode = E.toolMode.value;

    running = true; E.runBtn.textContent = '■ 중단'; E.runBtn.classList.add('is-running');
    var ctl = new AbortController(); abortCtl = ctl;

    E.trace.innerHTML = '';
    var tsec = labSection('실행 트레이스 (ReAct)', provBadge('server'));
    var body = el('div', { class: 'agent-trace' }); tsec.appendChild(body); E.trace.appendChild(tsec);

    A.runReAct({
      messages: msgs, tools: tools.slice(), toolMode: mode,
      toolChoice: E.toolChoice.value || undefined,
      parallelToolCalls: E.parallel.checked || undefined,
      maxSteps: parseInt(E.maxSteps.value, 10) || 6,
      profileId: p.id, model: profileModel(p),
      params: state.sessionParams, useProxy: state.ui.useProxy,
      reasoningEnabled: true, signal: ctl.signal, ctx: { useProxy: state.ui.useProxy },
      invoke: mode === 'mock' ? mockInvoke(body, ctl) : undefined,
      onStep: function (rec) { appendStep(body, rec); },
    }).then(function (res) {
      running = false; E.runBtn.textContent = '▶ ReAct 실행'; E.runBtn.classList.remove('is-running');
      appendSummary(body, res);
      toast(res.ok ? ('ReAct 완료 · ' + res.steps + ' step') : ('ReAct 종료: ' + res.stopReason), res.ok ? 'ok' : 'warn');
    });
  }

  // mock 모드: tool_call 마다 결과 입력 UI를 띄우고 사용자가 주입할 때까지 대기
  function mockInvoke(body, ctl) {
    return function (tc) {
      return new Promise(function (resolve) {
        if (ctl.signal.aborted) return resolve({ content: '', provider: 'mock', ms: 0 });
        var box = el('div', { class: 'mock-inject' });
        box.appendChild(el('div', { class: 'mock-inject__h' }, [
          el('span', { class: 'mono', text: 'mock 결과 입력 · ' + tc.name + '(' + shortArgs(tc.args) + ')' }),
          provBadge('mock'),
        ]));
        var ta = el('textarea', { class: 'field field-mono', rows: 2, placeholder: '툴 실행 결과(JSON 또는 텍스트)를 입력…' });
        ta.value = JSON.stringify({ result: 'mock:' + tc.name, args: tc.args });
        var send = el('button', { type: 'button', class: 'btn btn-primary btn-xs', text: '주입 →' });
        var done = false;
        function finish(v) { if (done) return; done = true; box.classList.add('is-done'); ta.disabled = true; send.disabled = true; resolve({ content: v, provider: 'mock', ms: 0 }); }
        send.addEventListener('click', function () { finish(ta.value); });
        ctl.signal.addEventListener('abort', function () { finish(''); });
        box.appendChild(ta); box.appendChild(el('div', { class: 'lab-btnrow' }, [send]));
        body.appendChild(box); ta.focus();
      });
    };
  }

  function shortArgs(args) { try { var s = JSON.stringify(args); return s.length > 60 ? s.slice(0, 57) + '…' : s; } catch (e) { return '{}'; } }

  function appendStep(body, rec) {
    if (rec.type === 'think') {
      var it = el('div', { class: 'atrace atrace--think' });
      it.appendChild(el('div', { class: 'atrace__h' }, [
        el('span', { class: 'atrace__k', text: 'think' }),
        el('span', { class: 'atrace__step mono', text: 'step ' + rec.step }),
        rec.ms != null ? el('span', { class: 'mono atrace__ms', text: fmtMs(rec.ms) }) : null,
        rec.usage ? el('span', { class: 'mono', text: (rec.usage.total_tokens || '?') + ' tok' }) : null,
        provBadge(rec.provider || 'server'),
      ]));
      if (rec.thought) {
        var d = el('details', { class: 'think-block' });
        d.appendChild(el('summary', { text: 'reasoning' }));
        d.appendChild(el('div', { class: 'think-block__body', text: rec.thought }));
        it.appendChild(d);
      }
      if (rec.content) { var b = el('div', { class: 'atrace__body md' }); renderMarkdownInto(b, rec.content); it.appendChild(b); }
      body.appendChild(it);
    } else if (rec.type === 'tool_call') {
      body.appendChild(el('div', { class: 'atrace atrace--act' }, [
        el('div', { class: 'atrace__h' }, [
          el('span', { class: 'atrace__k', text: 'act' }),
          el('span', { class: 'tool-chip mono' }, [el('b', { text: rec.name }), el('span', { text: '(' + shortArgs(rec.args) + ')' })]),
          provBadge(rec.provider || 'server'),
        ]),
      ]));
    } else if (rec.type === 'observation') {
      var it3 = el('div', { class: 'atrace atrace--obs' });
      it3.appendChild(el('div', { class: 'atrace__h' }, [
        el('span', { class: 'atrace__k', text: 'observe' }),
        el('span', { class: 'mono', text: rec.name }),
        rec.ms != null ? el('span', { class: 'mono atrace__ms', text: fmtMs(rec.ms) }) : null,
        provBadge(rec.provider || 'mock'),
        rec.error ? el('span', { class: 'atrace__err', text: String(rec.error) }) : null,
      ]));
      it3.appendChild(el('pre', { class: 'step-card__out', text: String(rec.content == null ? '' : rec.content).slice(0, 800) }));
      body.appendChild(it3);
    } else if (rec.type === 'final') {
      var it4 = el('div', { class: 'atrace atrace--final' });
      it4.appendChild(el('div', { class: 'atrace__h' }, [el('span', { class: 'atrace__k', text: 'final' }), el('span', { class: 'mono', text: 'finish: ' + (rec.finishReason || 'stop') }), provBadge('server')]));
      var fb = el('div', { class: 'msg__bubble md' }); renderMarkdownInto(fb, rec.content || '(빈 응답)'); it4.appendChild(fb);
      body.appendChild(it4);
    } else if (rec.type === 'error') {
      body.appendChild(el('div', { class: 'msg__error', text: (rec.error && rec.error.message) || 'ReAct 실행 오류' }));
    }
  }

  function appendSummary(body, res) {
    var expBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: '트레이스 export' });
    expBtn.addEventListener('click', function () { downloadFile('agent_trace.json', JSON.stringify({ schemaVersion: '1', type: 'llm-lab-agent-trace', stopReason: res.stopReason, steps: res.steps, trace: res.trace }, null, 2)); });
    body.appendChild(el('div', { class: 'atrace-summary' }, [
      el('span', { class: 'mono', text: 'stopReason: ' + res.stopReason }),
      el('span', { class: 'mono', text: 'steps: ' + res.steps }),
      provBadge(res.provider || 'server'),
      expBtn,
    ]));
  }

  return { build: build, onShow: function () {} };
})();

/* ============================================================
   26. EVAL / BENCH 모듈 (§8.7)
   ============================================================ */
var EVAL = (function () {
  var EV = L.eval;
  var E = {};
  var variants = [newVariant('A'), newVariant('B')];
  var cases = [];
  var lastRun = null;
  var abortCtl = null, running = false;
  var METRICS = ['exact_match', 'contains', 'regex', 'json_valid', 'length'];
  var subView = 'eval';   // 'eval' | 'sweep'

  function newVariant(id) { return { id: id, profileId: '', model: '', system: '', promptTemplate: '', params: { temperature: 0.7, max_tokens: 512, top_p: 1 } }; }

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [
        el('div', { class: 'lab__title', text: 'Eval / Bench' }),
        el('div', { class: 'lab__sub', text: 'A/B 변형 × 케이스 × N회 반복(분포·diff·자동지표·LLM-judge), 여러 샘플링 파라미터 조합을 비교하는 Parameter Sweep(그리드 서치), 그리고 엔드포인트에 부하를 걸어 지연 분포(p50/p95/p99)·처리량(req/s·tok/s)·에러율을 측정하는 Bench(부하/지연 벤치마크)를 제공합니다.' }),
      ]),
      el('div', { class: 'prov-legend' }, [provBadge('browser'), provBadge('server')]),
    ]));

    // 서브탭: A/B Eval | Parameter Sweep | Bench
    var subbar = el('div', { class: 'vc-tabs sweep-subtabs' });
    E.evalPane = el('div', {});
    E.sweepPane = el('div', { hidden: true });
    E.benchPane = el('div', { hidden: true });
    E.subBtns = {};
    [['eval', 'A/B Eval'], ['sweep', 'Parameter Sweep'], ['bench', 'Bench']].forEach(function (o) {
      var b = el('button', { type: 'button', class: 'vc-tab' + (subView === o[0] ? ' is-active' : ''), text: o[1] });
      b.addEventListener('click', function () { setSubView(o[0]); });
      E.subBtns[o[0]] = b; subbar.appendChild(b);
    });
    inner.appendChild(subbar);
    inner.appendChild(E.evalPane);
    inner.appendChild(E.sweepPane);
    inner.appendChild(E.benchPane);

    buildVariantSection(E.evalPane);
    buildCaseSection(E.evalPane);
    buildConfigSection(E.evalPane);
    E.results = el('div', { id: 'evalResults' });
    E.evalPane.appendChild(E.results);

    buildSweepSection(E.sweepPane);
    buildBenchSection(E.benchPane);
  }

  function setSubView(v) {
    subView = v;
    E.evalPane.hidden = v !== 'eval';
    E.sweepPane.hidden = v !== 'sweep';
    E.benchPane.hidden = v !== 'bench';
    Object.keys(E.subBtns).forEach(function (k) { E.subBtns[k].classList.toggle('is-active', k === v); });
  }

  /* --- 변형 A/B --- */
  function buildVariantSection(inner) {
    var sec = labSection('1 · 변형(Variants) A / B');
    E.variantGrid = el('div', { class: 'variant-grid' });
    variants.forEach(function (v) { E.variantGrid.appendChild(buildVariantCard(v)); });
    sec.appendChild(E.variantGrid);
    inner.appendChild(sec);
  }
  function buildVariantCard(v) {
    var card = el('div', { class: 'variant-card variant-card--' + v.id.toLowerCase() });
    card.appendChild(el('div', { class: 'variant-card__h' }, [el('span', { class: 'variant-badge', text: v.id }), el('span', { class: 'field-note', text: '슬롯 ' + v.id })]));

    var prof = el('select', { class: 'field' });
    prof.appendChild(el('option', { value: '', text: '(활성 연결)' }));
    L.profiles.list().forEach(function (p) { var o = el('option', { value: p.id, text: p.label }); if (v.profileId === p.id) o.selected = true; prof.appendChild(o); });
    prof.addEventListener('change', function () { v.profileId = prof.value; });

    var model = el('input', { type: 'text', class: 'field', value: v.model, placeholder: '모델 override(비우면 활성 모델)' });
    model.addEventListener('input', function () { v.model = model.value; });
    var sys = el('textarea', { class: 'field field-mono', rows: 2, placeholder: 'system 프롬프트(선택)' });
    sys.value = v.system; sys.addEventListener('input', function () { v.system = sys.value; });
    var tpl = el('input', { type: 'text', class: 'field field-mono', value: v.promptTemplate, placeholder: 'promptTemplate: {{input}} (비우면 입력 그대로)' });
    tpl.addEventListener('input', function () { v.promptTemplate = tpl.value; });

    var temp = el('input', { type: 'number', class: 'field field-num', step: 0.05, min: 0, max: 2, value: v.params.temperature });
    temp.addEventListener('input', function () { v.params.temperature = num(temp.value, 0.7); });
    var maxt = el('input', { type: 'number', class: 'field field-num', step: 16, min: 1, value: v.params.max_tokens });
    maxt.addEventListener('input', function () { v.params.max_tokens = num(maxt.value, 512); });
    var topp = el('input', { type: 'number', class: 'field field-num', step: 0.01, min: 0, max: 1, value: v.params.top_p });
    topp.addEventListener('input', function () { v.params.top_p = num(topp.value, 1); });

    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '연결' }), prof]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '모델' }), model]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'system' }), sys]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'promptTemplate' }), tpl]));
    card.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: 'temp' }), temp, el('label', { text: 'max_tok' }), maxt, el('label', { text: 'top_p' }), topp]));
    return card;
  }
  function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }

  /* --- 케이스(데이터셋) --- */
  function buildCaseSection(inner) {
    var sec = labSection('2 · 데이터셋 케이스');
    E.caseText = el('textarea', { class: 'field field-mono', rows: 4, placeholder: '한 줄에 한 케이스(입력)… 또는 CSV(input,expected) · JSON 배열을 붙여넣기' });
    var parseBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '텍스트 → 케이스 파싱' });
    parseBtn.addEventListener('click', function () {
      var txt = E.caseText.value.trim(); if (!txt) { toast('입력이 비었습니다.', 'warn'); return; }
      var parsed;
      if (txt[0] === '[' || txt[0] === '{' || /,/.test(txt.split('\n')[0])) parsed = EV.parseDataset(txt);
      else parsed = txt.split('\n').map(function (l, i) { return { id: String(i + 1), input: l.trim(), expected: '' }; }).filter(function (c) { return c.input; });
      cases = parsed; renderCases(); toast(cases.length + '개 케이스 로드');
    });
    var fileLbl = el('label', { class: 'btn btn-ghost btn-sm', for: 'evalFile', text: '파일(.csv/.json)' });
    var fileInp = el('input', { type: 'file', id: 'evalFile', accept: '.csv,.json,.txt', hidden: true });
    fileInp.addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader(); r.onload = function () { cases = EV.parseDataset(String(r.result || ''), f.name); renderCases(); toast(cases.length + '개 케이스 로드 (' + f.name + ')'); }; r.readAsText(f); e.target.value = '';
    });
    var sampleBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '샘플' });
    sampleBtn.addEventListener('click', function () {
      cases = [
        { id: '1', input: '대한민국의 수도는?', expected: '서울' },
        { id: '2', input: '3 곱하기 4는?', expected: '12' },
        { id: '3', input: 'HTTP 200의 의미를 한 문장으로.', expected: '' },
      ];
      renderCases(); toast('샘플 3케이스 로드');
    });

    E.caseTable = el('div', { class: 'scroll-x' });
    sec.appendChild(el('div', { class: 'field-col' }, [E.caseText]));
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [parseBtn, fileLbl, fileInp, sampleBtn]));
    sec.appendChild(E.caseTable);
    inner.appendChild(sec);
    renderCases();
  }
  function renderCases() {
    E.caseTable.innerHTML = '';
    if (!cases.length) { E.caseTable.appendChild(el('div', { class: 'field-note', text: '케이스 없음' })); return; }
    var t = el('table', { class: 'data-table' });
    t.appendChild(el('thead', {}, [el('tr', {}, [th('id'), th('input'), th('expected'), th('')])]));
    var tb = el('tbody', {});
    cases.forEach(function (c, i) {
      var rm = el('button', { type: 'button', class: 'tool-chip__x', text: '×', 'aria-label': '삭제' });
      rm.addEventListener('click', function () { cases.splice(i, 1); renderCases(); });
      tb.appendChild(el('tr', {}, [td(c.id, true), td(c.input), td(c.expected || '—'), el('td', {}, [rm])]));
    });
    t.appendChild(tb); E.caseTable.appendChild(t);
  }
  function th(x) { return el('th', { text: x }); }
  function td(x, mono) { return el('td', { class: mono ? 'mono' : '', text: x == null ? '' : String(x) }); }

  /* --- 실행 설정 --- */
  function buildConfigSection(inner) {
    var sec = labSection('3 · 실행 설정');
    E.repeats = el('input', { type: 'number', class: 'field field-num', min: 1, max: 20, step: 1, value: 1 });

    E.metricBox = el('div', { class: 'lab-btnrow toggles' });
    E.metricChecks = {};
    METRICS.forEach(function (m) {
      var cb = el('input', { type: 'checkbox' }); E.metricChecks[m] = cb;
      E.metricBox.appendChild(el('label', { class: 'chk' }, [cb, el('span', { text: m })]));
    });

    // judge
    E.judgeOn = el('input', { type: 'checkbox' });
    E.judgeMode = el('select', { class: 'field' });
    [['pairwise', 'pairwise(쌍대)'], ['rubric', 'rubric(루브릭)']].forEach(function (o) { E.judgeMode.appendChild(el('option', { value: o[0], text: o[1] })); });
    E.judgeRandom = el('input', { type: 'checkbox' }); E.judgeRandom.checked = true;
    E.judgeBidir = el('input', { type: 'checkbox' }); E.judgeBidir.checked = true;
    E.judgeProf = el('select', { class: 'field' });
    E.judgeProf.appendChild(el('option', { value: '', text: '심판=활성 연결' }));
    L.profiles.list().forEach(function (p) { E.judgeProf.appendChild(el('option', { value: p.id, text: p.label })); });

    var judgeFs = el('div', { class: 'judge-config' }, [
      el('label', { class: 'chk' }, [E.judgeOn, el('span', { text: 'LLM-as-judge 사용' })]),
      el('span', { class: 'lab-flag', text: '참고치(reference only)' }),
      el('div', { class: 'param-mini' }, [
        E.judgeMode, E.judgeProf,
        el('label', { class: 'chk' }, [E.judgeRandom, el('span', { text: '순서 무작위' })]),
        el('label', { class: 'chk' }, [E.judgeBidir, el('span', { text: '양방향 평균' })]),
      ]),
      el('div', { class: 'field-note', text: '판정은 위치·순서 편향을 보정한 참고 지표입니다. 절대 점수가 아니라 상대 선호로만 해석하세요.' }),
    ]);

    E.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ Eval 실행' });
    E.runBtn.addEventListener('click', run);
    E.progress = el('div', { class: 'eval-progress', hidden: true }, [el('div', { class: 'eval-progress__bar' })]);
    E.progressTxt = el('span', { class: 'mono field-note' });

    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '반복수 N' }), E.repeats]));
    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '자동지표' }), E.metricBox]));
    sec.appendChild(judgeFs);
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [E.runBtn, E.progressTxt]));
    sec.appendChild(E.progress);
    inner.appendChild(sec);
  }

  function run() {
    if (running) { if (abortCtl) abortCtl.abort(); return; }
    if (!cases.length) { toast('케이스를 먼저 로드하세요.', 'warn'); return; }
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }

    // 변형 profileId 확정(빈 값 → 활성)
    var vs = variants.map(function (v) {
      return { id: v.id, profileId: v.profileId || p.id, model: v.model || profileModel(p), system: v.system, promptTemplate: v.promptTemplate, params: Object.assign({}, v.params) };
    });
    var metrics = METRICS.filter(function (m) { return E.metricChecks[m].checked; });
    var judge = { enabled: E.judgeOn.checked, mode: E.judgeMode.value, randomizeOrder: E.judgeRandom.checked, bidirectional: E.judgeBidir.checked, profileId: E.judgeProf.value || p.id };

    running = true; E.runBtn.textContent = '■ 중단'; E.runBtn.classList.add('is-running');
    var ctl = new AbortController(); abortCtl = ctl;
    E.progress.hidden = false; E.progress.querySelector('.eval-progress__bar').style.width = '0%';
    E.results.innerHTML = '';
    var partial = [];

    EV.runEval({
      cases: cases, variants: vs, repeats: parseInt(E.repeats.value, 10) || 1,
      autoMetrics: metrics, judge: judge, useProxy: state.ui.useProxy, signal: ctl.signal,
      onResult: function (rec) { partial.push(rec); },
      onProgress: function (pr) {
        var pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
        E.progress.querySelector('.eval-progress__bar').style.width = pct + '%';
        E.progressTxt.textContent = pr.done + ' / ' + pr.total;
      },
    }).then(function (res) {
      running = false; E.runBtn.textContent = '▶ Eval 실행'; E.runBtn.classList.remove('is-running');
      E.progress.hidden = true;
      lastRun = res; lastRun._variants = vs; lastRun._cases = cases.slice();
      renderResults();
      toast(ctl.signal.aborted ? '중단됨 · 부분 결과' : ('Eval 완료 · ' + res.results.length + ' 실행'), ctl.signal.aborted ? 'warn' : 'ok');
    });
  }

  /* --- 결과 렌더 --- */
  function renderResults() {
    E.results.innerHTML = '';
    if (!lastRun || !lastRun.results.length) return;
    renderResultTable();
    renderDistribution();
    renderDiff();
    if (lastRun.judge) renderJudge();
    renderExport();
  }

  function renderResultTable() {
    var sec = labSection('결과 (' + lastRun.results.length + ' 실행)', provBadge('server'));
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact' });
    t.appendChild(el('thead', {}, [el('tr', {}, ['변형', 'case', 'rep', 'TTFT', 'latency', 'tok/s', '지표', 'output'].map(function (h) { return th(h); }))]));
    var tb = el('tbody', {});
    lastRun.results.forEach(function (r) {
      var metricCell = el('td', {});
      (r.metricResults || []).forEach(function (m) {
        metricCell.appendChild(el('span', { class: 'metric-pill metric-pill--' + (m.pass === true ? 'ok' : m.pass === false ? 'no' : 'na'), title: m.name, text: m.name.split('_')[0] + (typeof m.value === 'number' && m.name === 'length' ? ':' + m.value : '') }));
      });
      var out = el('td', { class: 'cell-output', title: r.output || '' , text: (r.output || (r.error ? '⚠ ' + (r.error.message || 'error') : '')).slice(0, 120) });
      tb.appendChild(el('tr', { class: r.ok ? '' : 'row-err' }, [
        el('td', {}, [el('span', { class: 'variant-badge variant-badge--sm', text: r.variantId })]),
        td(r.caseId, true), td(r.repeat, true),
        td(r.ttftMs != null ? Math.round(r.ttftMs) : '—', true),
        td(r.latencyMs != null ? Math.round(r.latencyMs) : '—', true),
        td(r.tokPerSec != null ? r.tokPerSec.toFixed(1) : '—', true),
        metricCell, out,
      ]));
    });
    t.appendChild(tb); wrap.appendChild(t); sec.appendChild(wrap);
    E.results.appendChild(sec);
  }

  function renderDistribution() {
    var sec = labSection('분포 (N회 반복)', provBadge('browser'));
    var metricSel = el('select', { class: 'field' });
    [['latencyMs', 'latency (ms)'], ['ttftMs', 'TTFT (ms)'], ['tokPerSec', 'tok/s']].forEach(function (o) { metricSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    var holder = el('div', { class: 'dist-grid' });
    function draw() {
      holder.innerHTML = '';
      var key = metricSel.value;
      lastRun._variants.forEach(function (v, vi) {
        var arr = lastRun.results.filter(function (r) { return r.variantId === v.id && r[key] != null; }).map(function (r) { return r[key]; });
        var s = EV.stats(arr), h = EV.histogram(arr, 8);
        var col = 'var(--viz-' + ((vi % 4) + 1) + ')';
        var card = el('div', { class: 'dist-card' });
        card.appendChild(el('div', { class: 'dist-card__h' }, [el('span', { class: 'variant-badge variant-badge--sm', text: v.id }), el('span', { class: 'field-note mono', text: 'n=' + s.n })]));
        card.appendChild(el('div', { class: 'dist-stats mono' }, [
          statCell('min', fmtStat(s.min)), statCell('med', fmtStat(s.median)), statCell('mean', fmtStat(s.mean)),
          statCell('p90', fmtStat(s.p90)), statCell('max', fmtStat(s.max)), statCell('σ', fmtStat(s.stdev)),
        ]));
        var bars = el('div', { class: 'hist' });
        h.bins.forEach(function (b) {
          var pct = h.max ? (b.count / h.max * 100) : 0;
          var bar = el('div', { class: 'hist__col', title: b.lo.toFixed(0) + '–' + b.hi.toFixed(0) + ' · ' + b.count });
          var fill = el('div', { class: 'hist__bar' }); fill.style.height = Math.max(2, pct) + '%'; fill.style.background = col;
          bar.appendChild(fill); bars.appendChild(bar);
        });
        card.appendChild(bars);
        holder.appendChild(card);
      });
    }
    metricSel.addEventListener('change', draw);
    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '지표' }), metricSel]));
    sec.appendChild(holder);
    E.results.appendChild(sec); draw();
  }
  function statCell(k, v) { return el('span', { class: 'stat-cell' }, [el('i', { text: k }), el('b', { text: v })]); }
  function fmtStat(x) { return x == null ? '—' : (Math.abs(x) >= 100 ? Math.round(x) : x.toFixed(1)); }

  function renderDiff() {
    if (lastRun._variants.length < 2) return;
    var sec = labSection('출력 diff (A vs B)', provBadge('browser'));
    var caseSel = el('select', { class: 'field' });
    lastRun._cases.forEach(function (c) { caseSel.appendChild(el('option', { value: c.id, text: 'case ' + c.id + ' · ' + c.input.slice(0, 30) })); });
    var modeSel = el('select', { class: 'field' });
    [['word', 'word diff'], ['line', 'line diff']].forEach(function (o) { modeSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    var view = el('div', { class: 'diff-view md' });
    function draw() {
      var cid = caseSel.value;
      var a = firstOutput(lastRun._variants[0].id, cid), b = firstOutput(lastRun._variants[1].id, cid);
      var parts = modeSel.value === 'line' ? EV.diffLines(a, b) : EV.diffWords(a, b);
      view.innerHTML = '';
      parts.forEach(function (p) {
        var cls = p.type === 'add' ? 'diff-add' : p.type === 'del' ? 'diff-del' : 'diff-eq';
        var text = p.text + (modeSel.value === 'line' ? '\n' : '');
        view.appendChild(el('span', { class: cls, text: text }));
      });
    }
    caseSel.addEventListener('change', draw); modeSel.addEventListener('change', draw);
    sec.appendChild(el('div', { class: 'param-mini' }, [caseSel, modeSel, el('span', { class: 'field-note', text: 'A=' + lastRun._variants[0].id + ' 기준 · 추가=B, 삭제=A' })]));
    sec.appendChild(view);
    E.results.appendChild(sec); draw();
  }
  function firstOutput(vid, cid) { for (var i = 0; i < lastRun.results.length; i++) { var r = lastRun.results[i]; if (r.variantId === vid && r.caseId === cid) return r.output || ''; } return ''; }

  function renderJudge() {
    var j = lastRun.judge;
    var sec = labSection('LLM-as-judge (' + j.mode + ')', el('span', { class: 'lab-flag', text: '참고치' }));
    var sm = j.summary || {};
    sec.appendChild(el('div', { class: 'judge-summary' }, [
      el('div', { class: 'judge-tally' }, [el('span', { class: 'variant-badge variant-badge--sm', text: sm.variantA || 'A' }), el('b', { class: 'mono', text: '승 ' + (sm.winsA || 0) })]),
      el('div', { class: 'judge-tally' }, [el('span', { class: 'field-note', text: '무승부' }), el('b', { class: 'mono', text: (sm.ties || 0) })]),
      el('div', { class: 'judge-tally' }, [el('span', { class: 'variant-badge variant-badge--sm', text: sm.variantB || 'B' }), el('b', { class: 'mono', text: '승 ' + (sm.winsB || 0) })]),
    ]));
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact' });
    if (j.mode === 'rubric') {
      t.appendChild(el('thead', {}, [el('tr', {}, ['case', 'A 총점', 'B 총점'].map(th))]));
      var tb = el('tbody', {});
      (j.perCase || []).forEach(function (pc) { tb.appendChild(el('tr', {}, [td(pc.caseId, true), td(pc.rubricA ? pc.rubricA.total : '—', true), td(pc.rubricB ? pc.rubricB.total : '—', true)])); });
      t.appendChild(tb);
    } else {
      t.appendChild(el('thead', {}, [el('tr', {}, ['case', 'winner', '패스(방향별)'].map(th))]));
      var tb2 = el('tbody', {});
      (j.perCase || []).forEach(function (pc) {
        var passes = (pc.passes || []).map(function (p) { return p.direction + '→' + p.winner; }).join(' · ');
        tb2.appendChild(el('tr', {}, [td(pc.caseId, true), el('td', {}, [el('span', { class: 'variant-badge variant-badge--sm', text: pc.winner })]), td(passes, true)]));
      });
      t.appendChild(tb2);
    }
    wrap.appendChild(t); sec.appendChild(wrap);
    sec.appendChild(el('div', { class: 'field-note', text: '순서 무작위화 + 양방향(A우선/B우선) 평균으로 위치 편향을 보정했습니다. 참고용 상대 선호입니다.' }));
    E.results.appendChild(sec);
  }

  function renderExport() {
    var sec = el('div', { class: 'lab-btnrow' });
    var jbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export JSON' });
    jbtn.addEventListener('click', function () { downloadFile('eval_run.json', JSON.stringify({ schemaVersion: '1', type: 'llm-lab-eval', variants: lastRun._variants, results: lastRun.results, judge: lastRun.judge }, null, 2)); });
    var cbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export CSV' });
    cbtn.addEventListener('click', function () { downloadFile('eval_run.csv', toCSV(lastRun.results), 'text/csv'); });
    sec.appendChild(jbtn); sec.appendChild(cbtn);
    E.results.appendChild(sec);
  }
  function toCSV(results) {
    var cols = ['variantId', 'caseId', 'repeat', 'ok', 'ttftMs', 'latencyMs', 'tokPerSec', 'output'];
    var lines = [cols.join(',')];
    results.forEach(function (r) { lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(',')); });
    return lines.join('\n');
  }
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  /* ============================================================
     PARAMETER SWEEP — 그리드 서치 서브뷰
     ============================================================ */
  var SW = L.sweep;
  var S = {};                       // sweep element refs
  var SWEEP_AXES = [
    { key: 'temperature', ph: '0, 0.5, 1.0' },
    { key: 'top_p', ph: '0.8, 0.9, 1.0' },
    { key: 'top_k', ph: '20, 40' },
    { key: 'max_tokens', ph: '128, 512' },
    { key: 'frequency_penalty', ph: '0, 0.5' },
    { key: 'presence_penalty', ph: '0, 0.5' },
  ];
  var swAbort = null, swRunning = false, swLastRun = null;
  var swSortKey = 'combo';

  function buildSweepSection(pane) {
    // 1 · 프롬프트
    var p1 = labSection('1 · 프롬프트 & 연결');
    S.sys = el('textarea', { class: 'field field-mono', rows: 2, placeholder: 'system 프롬프트 (선택)' });
    S.prompt = el('textarea', { class: 'field field-mono', rows: 3, placeholder: '모든 파라미터 조합에 동일하게 실행할 프롬프트 (user)' });
    S.prof = el('select', { class: 'field' });
    S.prof.appendChild(el('option', { value: '', text: '(활성 연결)' }));
    L.profiles.list().forEach(function (p) { S.prof.appendChild(el('option', { value: p.id, text: p.label })); });
    S.model = el('input', { type: 'text', class: 'field', placeholder: '모델 override (비우면 활성 모델)' });
    var sampleBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '샘플 채우기' });
    sampleBtn.addEventListener('click', function () {
      S.prompt.value = '창의적인 스타트업 이름 3개를 지어줘. 분야: 친환경 배송.';
      SWEEP_AXES.forEach(function (a) { S.axis[a.key].on.checked = false; });
      S.axis.temperature.on.checked = true; S.axis.temperature.vals.value = '0, 0.7, 1.2';
      S.axis.top_p.on.checked = true; S.axis.top_p.vals.value = '0.9, 1.0';
      S.repeats.value = '2';
      updatePreview();
      toast('샘플: temperature×top_p (3×2) · repeats 2');
    });
    p1.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'system (선택)' }), S.sys]));
    p1.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'prompt' }), S.prompt]));
    p1.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '연결' }), S.prof, el('label', { text: '모델' }), S.model]));
    p1.appendChild(el('div', { class: 'lab-btnrow' }, [sampleBtn]));
    pane.appendChild(p1);

    // 2 · 축 편집기
    var p2 = labSection('2 · 파라미터 축 (그리드)', el('span', { class: 'field-note', text: '켠 축에 콤마로 값 목록 입력 · 값 문자열은 자동 숫자화' }));
    S.axis = {};
    var grid = el('div', { class: 'sweep-axes' });
    SWEEP_AXES.forEach(function (a) {
      var on = el('input', { type: 'checkbox' });
      var vals = el('input', { type: 'text', class: 'field field-mono', placeholder: a.ph });
      on.addEventListener('change', updatePreview);
      vals.addEventListener('input', updatePreview);
      S.axis[a.key] = { on: on, vals: vals };
      var row = el('div', { class: 'sweep-axis' }, [
        el('label', { class: 'chk sweep-axis__k' }, [on, el('span', { class: 'mono', text: a.key })]),
        vals,
      ]);
      grid.appendChild(row);
    });
    p2.appendChild(grid);

    // baseParams (고정값 — 축으로 안 켠 파라미터에 공통 적용)
    S.baseTemp = el('input', { type: 'number', class: 'field field-num', step: 0.05, min: 0, max: 2, value: 0.7 });
    S.baseMax = el('input', { type: 'number', class: 'field field-num', step: 16, min: 1, value: 512 });
    p2.appendChild(el('div', { class: 'param-mini sweep-base' }, [
      el('label', { text: '고정값(base) · 축 미사용 시' }),
      el('label', { class: 'mono', text: 'temperature' }), S.baseTemp,
      el('label', { class: 'mono', text: 'max_tokens' }), S.baseMax,
      el('span', { class: 'field-note', text: '해당 파라미터를 축으로 켜면 축 값이 우선합니다.' }),
    ]));
    pane.appendChild(p2);

    // 3 · 실행
    var p3 = labSection('3 · 실행 설정');
    S.repeats = el('input', { type: 'number', class: 'field field-num', min: 1, max: 20, step: 1, value: 1 });
    S.repeats.addEventListener('input', updatePreview);
    S.concurrency = el('input', { type: 'range', class: 'batch-range', min: 1, max: 10, step: 1, value: 3 });
    S.concLabel = el('span', { class: 'mono field-note', text: '동시성 3' });
    S.concurrency.addEventListener('input', function () { S.concLabel.textContent = '동시성 ' + S.concurrency.value; });

    // judge (선택)
    S.judgeOn = el('input', { type: 'checkbox' });
    S.judgeProf = el('select', { class: 'field' });
    S.judgeProf.appendChild(el('option', { value: '', text: '심판=활성 연결' }));
    L.profiles.list().forEach(function (p) { S.judgeProf.appendChild(el('option', { value: p.id, text: p.label })); });
    var judgeFs = el('div', { class: 'judge-config' }, [
      el('label', { class: 'chk' }, [S.judgeOn, el('span', { text: 'LLM-as-judge 로 조합 대표출력 채점' })]),
      el('span', { class: 'lab-flag', text: '참고치' }),
      el('div', { class: 'param-mini' }, [el('label', { text: '심판 연결' }), S.judgeProf]),
      el('div', { class: 'field-note', text: '각 조합의 대표(첫 정상) 출력을 루브릭(정확성·유용성)으로 채점합니다. 상대 참고용입니다.' }),
    ]);

    S.preview = el('div', { class: 'sweep-preview' });
    S.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ Sweep 실행' });
    S.runBtn.addEventListener('click', runSweep);
    S.progress = el('div', { class: 'eval-progress', hidden: true }, [el('div', { class: 'eval-progress__bar' })]);
    S.progressTxt = el('span', { class: 'mono field-note' });

    p3.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: '반복수 N (조합당)' }), S.repeats,
      el('label', { text: '동시 실행' }), S.concurrency, S.concLabel,
    ]));
    p3.appendChild(judgeFs);
    p3.appendChild(S.preview);
    p3.appendChild(el('div', { class: 'lab-btnrow' }, [S.runBtn, S.progressTxt]));
    p3.appendChild(S.progress);
    pane.appendChild(p3);

    S.results = el('div', { id: 'sweepResults' });
    pane.appendChild(S.results);

    updatePreview();
  }

  // 켠 축들을 { key:[values...] } 로 수집 (콤마 분해)
  function collectAxes() {
    var axes = {};
    SWEEP_AXES.forEach(function (a) {
      var ax = S.axis[a.key];
      if (!ax.on.checked) return;
      var vals = ax.vals.value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
      if (vals.length) axes[a.key] = vals;
    });
    return axes;
  }

  function updatePreview() {
    var axes = collectAxes();
    var combos = SW.expandGrid(axes);
    var n = combos.length;
    var reps = Math.max(1, parseInt(S.repeats.value, 10) || 1);
    var m = n * reps;
    S.preview.innerHTML = '';
    var enabledKeys = Object.keys(axes);
    var dims = enabledKeys.length ? enabledKeys.map(function (k) { return k + '(' + axes[k].length + ')'; }).join(' × ') : '축 없음(기본 1조합)';
    S.preview.appendChild(el('div', { class: 'sweep-preview__line' }, [
      el('span', { class: 'batch-badge', text: n + ' combos' }),
      el('span', { class: 'field-note mono', text: '× ' + reps + ' repeats = ' }),
      el('span', { class: 'sweep-preview__runs mono', text: m + ' runs' }),
      el('span', { class: 'field-note mono', text: '·  ' + dims }),
    ]));
    if (m > 50) {
      S.preview.appendChild(el('div', { class: 'sweep-warn' }, [
        el('span', { text: '⚠ ' + m + '회 실행 예정 — 다수의 요청은 시간·토큰·레이트리밋에 유의하세요.' }),
      ]));
    }
    S.runBtn.disabled = false;
  }

  function runSweep() {
    if (swRunning) { if (swAbort) swAbort.abort(); return; }
    var prompt = S.prompt.value.trim();
    if (!prompt) { toast('프롬프트를 입력하세요.', 'warn'); return; }
    var p = activeProfile();
    var pid = S.prof.value || (p && p.id);
    if (!pid) { toast('활성 연결이 없습니다. 연결을 추가하세요.', 'warn'); return; }

    var axes = collectAxes();
    var reps = Math.max(1, parseInt(S.repeats.value, 10) || 1);
    var baseParams = { temperature: num(S.baseTemp.value, 0.7), max_tokens: num(S.baseMax.value, 512) };
    var judge = { enabled: S.judgeOn.checked, profileId: S.judgeProf.value || pid };

    swRunning = true; S.runBtn.textContent = '■ 중단'; S.runBtn.classList.add('is-running');
    var ctl = new AbortController(); swAbort = ctl;
    S.progress.hidden = false; S.progress.querySelector('.eval-progress__bar').style.width = '0%';
    S.progressTxt.textContent = '0 / …';
    S.results.innerHTML = '';

    SW.runSweep({
      prompt: prompt, systemPrompt: S.sys.value,
      axes: axes, baseParams: baseParams, repeats: reps,
      profileId: pid, model: S.model.value || '',
      concurrency: parseInt(S.concurrency.value, 10) || 3,
      useProxy: state.ui.useProxy, signal: ctl.signal,
      judge: judge.enabled ? judge : null,
      onProgress: function (pr) {
        var pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
        S.progress.querySelector('.eval-progress__bar').style.width = pct + '%';
        S.progressTxt.textContent = pr.done + ' / ' + pr.total;
      },
    }).then(function (res) {
      swRunning = false; S.runBtn.textContent = '▶ Sweep 실행'; S.runBtn.classList.remove('is-running');
      S.progress.hidden = true;
      swLastRun = res;
      renderSweepResults();
      toast(ctl.signal.aborted ? '중단됨 · 부분 결과' : ('Sweep 완료 · ' + res.stats.okRuns + '/' + res.stats.totalRuns + ' 성공'), ctl.signal.aborted ? 'warn' : 'ok');
    }).catch(function (e) {
      swRunning = false; S.runBtn.textContent = '▶ Sweep 실행'; S.runBtn.classList.remove('is-running'); S.progress.hidden = true;
      toast('Sweep 오류: ' + (e && e.message || e), 'err');
    });
  }

  function paramBadges(combo) {
    var keys = Object.keys(combo);
    if (!keys.length) return [el('span', { class: 'sweep-badge sweep-badge--base', text: 'base' })];
    return keys.map(function (k) { return el('span', { class: 'sweep-badge', text: k + '=' + combo[k] }); });
  }

  function sortedCombos() {
    var arr = (swLastRun.combos || []).map(function (c, i) { return { c: c, i: i }; });
    if (swSortKey === 'len') arr.sort(function (a, b) { return b.c.agg.outLenAvg - a.c.agg.outLenAvg; });
    else if (swSortKey === 'distinct') arr.sort(function (a, b) { return a.c.agg.distinctRatio - b.c.agg.distinctRatio; });
    else if (swSortKey === 'toks') arr.sort(function (a, b) { return (b.c.agg.tokPerSecAvg || 0) - (a.c.agg.tokPerSecAvg || 0); });
    return arr;
  }

  function renderSweepResults() {
    S.results.innerHTML = '';
    if (!swLastRun || !swLastRun.combos.length) return;
    var st = swLastRun.stats;

    var sec = labSection('결과 (' + st.comboCount + ' 조합 · ' + st.totalRuns + ' 실행)', provBadge('server'));
    sec.appendChild(el('div', { class: 'batch-stats' }, [
      statChip('조합', st.comboCount), statChip('실행', st.totalRuns),
      statChip('성공', st.okRuns, 'ok'), statChip('실패', st.errRuns, st.errRuns ? 'no' : ''),
      statChip('반복/조합', st.repeats),
    ]));

    // 정렬 선택
    var sortSel = el('select', { class: 'field' });
    [['combo', '조합 순서'], ['len', '출력길이(내림)'], ['distinct', '일관성(오름·낮을수록 결정적)'], ['toks', 'tok/s(내림)']].forEach(function (o) {
      var op = el('option', { value: o[0], text: o[1] }); if (swSortKey === o[0]) op.selected = true; sortSel.appendChild(op);
    });
    sortSel.addEventListener('change', function () { swSortKey = sortSel.value; renderComboList(list); });
    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '정렬' }), sortSel]));

    var list = el('div', { class: 'sweep-list' });
    sec.appendChild(list);
    S.results.appendChild(sec);
    renderComboList(list);

    renderSweepJudge();
    renderSweepExport();
  }

  function renderComboList(list) {
    list.innerHTML = '';
    // judge 점수 매핑
    var jmap = {};
    if (swLastRun.judge) (swLastRun.judge.perCombo || []).forEach(function (pc) { jmap[pc.comboIndex] = pc; });
    sortedCombos().forEach(function (item) {
      var c = item.c, ci = item.i, ag = c.agg;
      var card = el('div', { class: 'sweep-combo' });
      var head = el('div', { class: 'sweep-combo__h' }, [el('div', { class: 'sweep-combo__badges' }, paramBadges(c.combo))]);
      var metrics = el('div', { class: 'sweep-combo__metrics mono' }, [
        metricCell('outLen', Math.round(ag.outLenAvg)),
        metricCell('distinct', ag.distinctRatio.toFixed(2)),
        metricCell('tok/s', ag.tokPerSecAvg != null ? ag.tokPerSecAvg.toFixed(1) : '—'),
        metricCell('ok', ag.okCount + '/' + ag.n),
      ]);
      if (jmap[ci]) metrics.appendChild(metricCell('judge', jmap[ci].total));
      head.appendChild(metrics);
      card.appendChild(head);

      // 대표 출력
      var rep = repOutput(c);
      var repText = rep.error ? ('⚠ ' + (rep.error.message || 'error')) : (rep.output || '(빈 출력)');
      card.appendChild(el('div', { class: 'sweep-combo__out' + (rep.error ? ' is-err' : ''), text: repText.length > 400 ? repText.slice(0, 400) + '…' : repText }));

      // repeats>1 이면 샘플 펼침
      if (c.runs.length > 1) {
        var det = el('details', { class: 'sweep-samples' });
        det.appendChild(el('summary', { class: 'mono field-note', text: c.runs.length + '개 샘플 펼치기' }));
        c.runs.forEach(function (r, ri) {
          var t = r.error ? ('⚠ ' + (r.error.message || 'error')) : (r.output || '(빈 출력)');
          det.appendChild(el('div', { class: 'sweep-sample' + (r.error ? ' is-err' : '') }, [
            el('span', { class: 'sweep-sample__k mono', text: '#' + (ri + 1) }),
            el('span', { class: 'sweep-sample__t', text: t.length > 300 ? t.slice(0, 300) + '…' : t }),
          ]));
        });
        card.appendChild(det);
      }
      list.appendChild(card);
    });
  }
  function metricCell(k, v) { return el('span', { class: 'sweep-metric' }, [el('i', { text: k }), el('b', { text: String(v) })]); }
  function statChip(k, v, kind) { return el('div', { class: 'batch-stat' + (kind ? ' batch-stat--' + kind : '') }, [el('i', { text: k }), el('b', { class: 'mono', text: String(v) })]); }
  function repOutput(c) { for (var i = 0; i < c.runs.length; i++) if (c.runs[i] && !c.runs[i].error) return c.runs[i]; return c.runs[0] || { output: '', error: null }; }

  function renderSweepJudge() {
    if (!swLastRun.judge) return;
    var sec = labSection('LLM-as-judge (조합 채점)', el('span', { class: 'lab-flag', text: '참고치' }));
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact' });
    t.appendChild(el('thead', {}, [el('tr', {}, ['조합', '총점'].map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody', {});
    var rows = (swLastRun.judge.perCombo || []).slice().sort(function (a, b) { return b.total - a.total; });
    rows.forEach(function (pc) {
      var badges = el('td', {}, paramBadges(pc.params));
      tb.appendChild(el('tr', {}, [badges, el('td', { class: 'mono', text: String(pc.total) })]));
    });
    t.appendChild(tb); wrap.appendChild(t); sec.appendChild(wrap);
    sec.appendChild(el('div', { class: 'field-note', text: '조합 대표출력을 루브릭 채점한 상대 참고치입니다.' }));
    S.results.appendChild(sec);
  }

  function renderSweepExport() {
    var sec = el('div', { class: 'lab-btnrow' });
    var jbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export JSON' });
    jbtn.addEventListener('click', function () {
      downloadFile('sweep_run.json', JSON.stringify({ schemaVersion: '1', type: 'llm-lab-sweep', axes: swLastRun.axes, stats: swLastRun.stats,
        combos: swLastRun.combos.map(function (c) { return { params: c.params, agg: c.agg, runs: c.runs.map(function (r) { return { output: r.output, ms: r.ms, tokPerSec: r.tokPerSec, error: r.error }; }) }; }),
        judge: swLastRun.judge || null }, null, 2));
    });
    var cbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export CSV' });
    cbtn.addEventListener('click', function () { downloadFile('sweep_run.csv', sweepToCSV(), 'text/csv'); });
    sec.appendChild(el('span', { class: 'field-note', text: '내보내기: 조합별 파라미터 + 집계지표 + 대표출력' }));
    sec.appendChild(jbtn); sec.appendChild(cbtn);
    S.results.appendChild(sec);
  }
  function sweepToCSV() {
    var keys = {}; swLastRun.combos.forEach(function (c) { Object.keys(c.combo).forEach(function (k) { keys[k] = true; }); });
    var axisCols = Object.keys(keys);
    var header = axisCols.concat(['outLenAvg', 'distinctRatio', 'tokPerSecAvg', 'okCount', 'n', 'repOutput']);
    var lines = [header.map(csvCell).join(',')];
    swLastRun.combos.forEach(function (c) {
      var rep = repOutput(c);
      var row = axisCols.map(function (k) { return csvCell(c.combo[k]); });
      row.push(csvCell(Math.round(c.agg.outLenAvg)));
      row.push(csvCell(c.agg.distinctRatio.toFixed(3)));
      row.push(csvCell(c.agg.tokPerSecAvg != null ? c.agg.tokPerSecAvg.toFixed(2) : ''));
      row.push(csvCell(c.agg.okCount));
      row.push(csvCell(c.agg.n));
      row.push(csvCell(rep.error ? ('error:' + (rep.error.message || '')) : (rep.output || '')));
      lines.push(row.join(','));
    });
    return lines.join('\n');
  }

  /* ======================================================================
     BENCH — 엔드포인트 부하/지연 벤치마킹 (L.bench 소비)
     ====================================================================== */
  var BN = L.bench;
  var BE = {};                       // bench element refs
  var bnAbort = null, bnRunning = false, bnLastRun = null, bnLastSweep = null;
  var bnMode = 'single';             // 'single' | 'sweep'

  function buildBenchSection(pane) {
    // 주의 배너 — 실제 부하 경고 (상시)
    pane.appendChild(el('div', { class: 'bench-caution', role: 'note' }, [
      el('span', { class: 'bench-caution__i', 'aria-hidden': 'true', text: '⚡' }),
      el('span', { text: '실제 엔드포인트에 부하를 겁니다. 요청 수·동시성을 실서버 용량에 맞춰 신중히 설정하세요. (요청·토큰·레이트리밋 소모)' }),
    ]));

    // 1 · 프롬프트 & 연결
    var p1 = labSection('1 · 프롬프트 & 연결');
    BE.prompt = el('textarea', { class: 'field field-mono', rows: 2, placeholder: '모든 요청에 동일하게 보낼 고정 프롬프트' });
    BE.prompt.value = 'Reply with a single short sentence about the number 42.';
    BE.prof = el('select', { class: 'field' });
    BE.prof.appendChild(el('option', { value: '', text: '(활성 연결)' }));
    L.profiles.list().forEach(function (p) { BE.prof.appendChild(el('option', { value: p.id, text: p.label })); });
    BE.model = el('input', { type: 'text', class: 'field', placeholder: '모델 override (비우면 활성 모델)' });
    p1.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '고정 프롬프트' }), BE.prompt]));
    p1.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '연결' }), BE.prof, el('label', { text: '모델' }), BE.model]));
    pane.appendChild(p1);

    // 2 · 부하 설정
    var p2 = labSection('2 · 부하 설정');
    // 모드 토글
    BE.modeSingle = el('button', { type: 'button', class: 'seg-btn is-active', text: '단일 동시성' });
    BE.modeSweep = el('button', { type: 'button', class: 'seg-btn', text: '동시성 스윕' });
    BE.modeSingle.addEventListener('click', function () { setBenchMode('single'); });
    BE.modeSweep.addEventListener('click', function () { setBenchMode('sweep'); });
    p2.appendChild(el('div', { class: 'seg' }, [BE.modeSingle, BE.modeSweep]));

    BE.requests = el('input', { type: 'number', class: 'field field-num', min: 1, max: 2000, step: 1, value: 20 });
    BE.requests.addEventListener('input', updateBenchPreview);
    BE.concurrency = el('input', { type: 'number', class: 'field field-num', min: 1, max: 64, step: 1, value: 4 });
    BE.concurrency.addEventListener('input', updateBenchPreview);
    BE.levels = el('input', { type: 'text', class: 'field field-mono', value: '1, 2, 4, 8', placeholder: '예: 1, 2, 4, 8' });
    BE.levels.addEventListener('input', updateBenchPreview);
    BE.warmup = el('input', { type: 'number', class: 'field field-num', min: 0, max: 100, step: 1, value: 2 });
    BE.maxTokens = el('input', { type: 'number', class: 'field field-num', min: 1, max: 4096, step: 16, value: 64 });

    BE.singleRow = el('div', { class: 'param-mini' }, [
      el('label', { text: '요청 수' }), BE.requests,
      el('label', { text: '동시성' }), BE.concurrency,
    ]);
    BE.sweepRow = el('div', { class: 'param-mini', hidden: true }, [
      el('label', { text: '레벨당 요청 수' }), BE.requests2Holder(),
      el('label', { text: '동시성 레벨' }), BE.levels,
    ]);
    p2.appendChild(BE.singleRow);
    p2.appendChild(BE.sweepRow);
    p2.appendChild(el('div', { class: 'param-mini' }, [
      el('label', { text: 'warmup (제외)' }), BE.warmup,
      el('label', { text: 'max_tokens' }), BE.maxTokens,
      el('span', { class: 'field-note', text: 'warmup 요청은 통계·처리량에서 제외됩니다.' }),
    ]));
    pane.appendChild(p2);

    // 3 · 실행
    var p3 = labSection('3 · 실행');
    BE.preview = el('div', { class: 'sweep-preview' });
    BE.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ 벤치 실행' });
    BE.runBtn.addEventListener('click', runBench);
    BE.progress = el('div', { class: 'eval-progress', hidden: true }, [el('div', { class: 'eval-progress__bar' })]);
    BE.progressTxt = el('span', { class: 'mono field-note' });
    p3.appendChild(BE.preview);
    p3.appendChild(el('div', { class: 'lab-btnrow' }, [BE.runBtn, BE.progressTxt]));
    p3.appendChild(BE.progress);
    pane.appendChild(p3);

    BE.results = el('div', { id: 'benchResults' });
    pane.appendChild(BE.results);

    updateBenchPreview();
  }

  // 스윕 모드에서 '요청 수' 입력(BE.requests)을 재사용하기 위한 placeholder 노드.
  // 같은 input 을 두 행에 넣을 수 없으므로 스윕용 별도 input 을 만들어 값 동기화.
  BE.requests2Holder = function () {
    BE.requestsSweep = el('input', { type: 'number', class: 'field field-num', min: 1, max: 2000, step: 1, value: 20 });
    BE.requestsSweep.addEventListener('input', updateBenchPreview);
    return BE.requestsSweep;
  };

  function setBenchMode(m) {
    bnMode = m;
    BE.modeSingle.classList.toggle('is-active', m === 'single');
    BE.modeSweep.classList.toggle('is-active', m === 'sweep');
    BE.singleRow.hidden = m !== 'single';
    BE.sweepRow.hidden = m !== 'sweep';
    updateBenchPreview();
  }

  function parseLevels() {
    return BE.levels.value.split(',').map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return !isNaN(n) && n >= 1; }).map(function (n) { return Math.min(64, n); });
  }

  function updateBenchPreview() {
    BE.preview.innerHTML = '';
    var reqs, plannedReqs, dims;
    if (bnMode === 'sweep') {
      var levels = parseLevels();
      reqs = Math.max(1, parseInt(BE.requestsSweep.value, 10) || 20);
      var warm = Math.max(0, parseInt(BE.warmup.value, 10) || 0);
      plannedReqs = levels.length * (reqs + warm);
      dims = levels.length + '개 레벨(' + (levels.join('/') || '—') + ') × ' + reqs + '요청';
      BE.preview.appendChild(el('div', { class: 'sweep-preview__line' }, [
        el('span', { class: 'batch-badge', text: levels.length + ' levels' }),
        el('span', { class: 'field-note mono', text: '· 레벨당 ' + reqs + ' + warmup ' + warm + ' = ' }),
        el('span', { class: 'sweep-preview__runs mono', text: plannedReqs + ' 총요청' }),
        el('span', { class: 'field-note mono', text: '· ' + dims }),
      ]));
    } else {
      reqs = Math.max(1, parseInt(BE.requests.value, 10) || 20);
      var conc = Math.max(1, parseInt(BE.concurrency.value, 10) || 1);
      var warm2 = Math.max(0, parseInt(BE.warmup.value, 10) || 0);
      plannedReqs = reqs + warm2;
      BE.preview.appendChild(el('div', { class: 'sweep-preview__line' }, [
        el('span', { class: 'batch-badge', text: reqs + ' requests' }),
        el('span', { class: 'field-note mono', text: '· 동시성 ' + conc + ' + warmup ' + warm2 + ' = ' }),
        el('span', { class: 'sweep-preview__runs mono', text: plannedReqs + ' 총요청' }),
      ]));
    }
    if (plannedReqs > 200) {
      BE.preview.appendChild(el('div', { class: 'sweep-warn' }, [
        el('span', { text: '⚠ 총 ' + plannedReqs + '회 실제 요청 예정 — 대량 부하입니다. 실서버 용량·레이트리밋·비용에 특히 유의하세요.' }),
      ]));
    }
  }

  function benchProfileId() {
    var p = activeProfile();
    return BE.prof.value || (p && p.id);
  }

  function runBench() {
    if (bnRunning) { if (bnAbort) bnAbort.abort(); return; }
    var prompt = BE.prompt.value.trim();
    if (!prompt) { toast('고정 프롬프트를 입력하세요.', 'warn'); return; }
    var pid = benchProfileId();
    if (!pid) { toast('활성 연결이 없습니다. 연결을 추가하세요.', 'warn'); return; }

    var warm = Math.max(0, parseInt(BE.warmup.value, 10) || 0);
    var maxTok = Math.max(1, parseInt(BE.maxTokens.value, 10) || 64);
    var common = {
      prompt: prompt, profileId: pid, model: BE.model.value || '',
      warmup: warm, maxTokens: maxTok, useProxy: state.ui.useProxy,
    };

    bnRunning = true; BE.runBtn.textContent = '■ 중단'; BE.runBtn.classList.add('is-running');
    var ctl = new AbortController(); bnAbort = ctl;
    BE.progress.hidden = false; BE.progress.querySelector('.eval-progress__bar').style.width = '0%';
    BE.progressTxt.textContent = '0 / …';
    BE.results.innerHTML = '';

    var onProgress = function (pr) {
      var pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
      BE.progress.querySelector('.eval-progress__bar').style.width = pct + '%';
      var ph = pr.phase === 'warmup' ? '워밍업' : '측정';
      var lvl = pr.level != null ? ('동시성 ' + pr.level + ' · ') : '';
      BE.progressTxt.textContent = lvl + ph + ' ' + pr.done + ' / ' + pr.total;
    };

    var promise;
    if (bnMode === 'sweep') {
      var levels = parseLevels();
      if (!levels.length) { toast('동시성 레벨을 입력하세요 (예: 1, 2, 4, 8).', 'warn'); bnDoneUI(); return; }
      var reqs = Math.max(1, parseInt(BE.requestsSweep.value, 10) || 20);
      promise = BN.runConcurrencySweep(Object.assign({}, common, {
        requests: reqs, concurrencyLevels: levels, signal: ctl.signal, onProgress: onProgress,
      })).then(function (res) {
        bnLastSweep = res; bnLastRun = null; renderBenchSweep(res);
        toast(ctl.signal.aborted ? '중단됨 · 부분 결과' : ('스윕 완료 · ' + res.levels.length + '개 레벨'), ctl.signal.aborted ? 'warn' : 'ok');
      });
    } else {
      var reqs2 = Math.max(1, parseInt(BE.requests.value, 10) || 20);
      var conc = Math.max(1, parseInt(BE.concurrency.value, 10) || 1);
      promise = BN.runBenchmark(Object.assign({}, common, {
        requests: reqs2, concurrency: conc, signal: ctl.signal, onProgress: onProgress,
      })).then(function (res) {
        bnLastRun = res; bnLastSweep = null; renderBenchSingle(res);
        toast(ctl.signal.aborted ? '중단됨 · 부분 결과' : ('벤치 완료 · ' + res.okCount + '/' + res.perRequest.length + ' 성공'), ctl.signal.aborted ? 'warn' : 'ok');
      });
    }
    promise.catch(function (e) { toast('벤치 오류: ' + (e && e.message || e), 'err'); }).then(bnDoneUI);
  }

  function bnDoneUI() {
    bnRunning = false; BE.runBtn.textContent = '▶ 벤치 실행'; BE.runBtn.classList.remove('is-running'); BE.progress.hidden = true;
  }

  function fmtMs(v) { return v == null ? '—' : (Math.round(v) + ' ms'); }
  function fmtNum(v, d) { return v == null ? '—' : (Number(v).toFixed(d == null ? 2 : d)); }
  function fmtPct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }

  // 단일 벤치 결과 렌더 — 통계 칩 + percentile 표 + 히스토그램
  function renderBenchSingle(res) {
    BE.results.innerHTML = '';
    var errKind = res.errorRate > 0 ? (res.errorRate >= 0.5 ? 'no' : 'warn') : 'ok';
    var sec = labSection('결과 · 단일 동시성 ' + res.concurrency, provBadge('server'));
    sec.appendChild(el('div', { class: 'batch-stats' }, [
      statChip('요청', res.perRequest.length),
      statChip('동시성', res.concurrency),
      statChip('성공', res.okCount, 'ok'),
      statChip('실패', res.failCount, res.failCount ? 'no' : ''),
      statChip('에러율', fmtPct(res.errorRate), errKind),
      statChip('벽시계', fmtMs(res.wallMs)),
    ]));
    sec.appendChild(el('div', { class: 'batch-stats' }, [
      statChip('req/s', fmtNum(res.throughput.reqPerSec, 2), 'ok'),
      statChip('tok/s', fmtNum(res.throughput.tokPerSec, 1), 'ok'),
      statChip('총 토큰', res.throughput.totalTokens),
      statChip('warmup', res.warmup),
      statChip('peak 동시성', res.peakConcurrency),
    ]));

    // percentile 표
    sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: '지연 분포 (성공 요청 기준)' }));
    sec.appendChild(benchPercentileTable(res.ttft, res.total));

    // 히스토그램 (총지연 / TTFT)
    var totVals = res.perRequest.filter(function (r) { return r.ok && typeof r.totalMs === 'number'; }).map(function (r) { return r.totalMs; });
    var ttftVals = res.perRequest.filter(function (r) { return r.ok && typeof r.ttftMs === 'number'; }).map(function (r) { return r.ttftMs; });
    if (totVals.length) {
      sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: '총지연 분포 히스토그램 (ms)' }));
      sec.appendChild(benchHistogramSVG(totVals, '--viz-1'));
    }
    if (ttftVals.length) {
      sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: 'TTFT 분포 히스토그램 (ms)' }));
      sec.appendChild(benchHistogramSVG(ttftVals, '--viz-3'));
    }

    BE.results.appendChild(sec);
    renderBenchExport(false);
  }

  function benchPercentileTable(ttft, total) {
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact bench-ptable' });
    t.appendChild(el('thead', {}, [el('tr', {}, [
      th('지표'), th('n'), th('min'), th('p50'), th('p95'), th('p99'), th('max'), th('mean'),
    ])]));
    var tb = el('tbody', {});
    function row(label, s) {
      return el('tr', {}, [
        el('td', { class: 'mono', text: label }),
        td(s.count, true), td(fmtMs(s.min), true), td(fmtMs(s.p50), true),
        td(fmtMs(s.p95), true), td(fmtMs(s.p99), true), td(fmtMs(s.max), true),
        td(s.mean == null ? '—' : (Math.round(s.mean) + ' ms'), true),
      ]);
    }
    tb.appendChild(row('TTFT', ttft));
    tb.appendChild(row('총지연', total));
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  // 결정적 SVG 히스토그램 — L.bench.histogram 사용
  function benchHistogramSVG(values, colorVar) {
    var h = BN.histogram(values, 12);
    var W = 640, H = 150, padL = 40, padB = 24, padT = 10, padR = 10;
    var plotW = W - padL - padR, plotH = H - padB - padT;
    var bins = h.bins, maxC = h.max || 1;
    var bw = bins.length ? plotW / bins.length : plotW;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'bench-hist', width: '100%', preserveAspectRatio: 'xMidYMid meet', role: 'img' });
    // 축선
    svg.appendChild(svgEl('line', { x1: padL, y1: padT, x2: padL, y2: padT + plotH, stroke: 'var(--color-border-strong)', 'stroke-width': '1' }));
    svg.appendChild(svgEl('line', { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: 'var(--color-border-strong)', 'stroke-width': '1' }));
    // y max 라벨
    svg.appendChild(svgText(padL - 6, padT + 8, String(maxC), { anchor: 'end', size: 10 }));
    svg.appendChild(svgText(padL - 6, padT + plotH, '0', { anchor: 'end', size: 10 }));
    bins.forEach(function (b, i) {
      var bh = maxC ? (b.count / maxC) * plotH : 0;
      var x = padL + i * bw;
      var y = padT + plotH - bh;
      svg.appendChild(svgEl('rect', {
        x: (x + 1).toFixed(1), y: y.toFixed(1), width: Math.max(1, bw - 2).toFixed(1), height: Math.max(0, bh).toFixed(1),
        fill: 'var(' + colorVar + ')', rx: '2', opacity: '0.85',
      }));
      if (b.count > 0) svg.appendChild(svgText(x + bw / 2, y - 3, String(b.count), { anchor: 'middle', size: 9, fill: 'var(--color-text-muted)' }));
    });
    // x축 라벨(첫/끝 구간 경계)
    if (bins.length) {
      svg.appendChild(svgText(padL, padT + plotH + 14, Math.round(bins[0].lo) + '', { anchor: 'start', size: 9, fill: 'var(--color-text-muted)' }));
      svg.appendChild(svgText(padL + plotW, padT + plotH + 14, Math.round(bins[bins.length - 1].hi) + '', { anchor: 'end', size: 9, fill: 'var(--color-text-muted)' }));
    }
    var box = el('div', { class: 'bench-viz scroll-x' });
    box.appendChild(svg);
    return box;
  }

  // 동시성 스윕 결과 렌더 — 레벨 표 + 처리량 vs 동시성 곡선 + p95 곡선
  function renderBenchSweep(res) {
    BE.results.innerHTML = '';
    var sec = labSection('결과 · 동시성 스윕 (' + res.levels.length + '개 레벨)', provBadge('server'));

    // 레벨 표
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact bench-ptable' });
    t.appendChild(el('thead', {}, [el('tr', {}, [
      th('동시성'), th('req/s'), th('tok/s'), th('TTFT p50'), th('TTFT p95'), th('총 p50'), th('총 p95'), th('에러율'), th('성공/실패'),
    ])]));
    var tb = el('tbody', {});
    res.levels.forEach(function (lv) {
      tb.appendChild(el('tr', {}, [
        td(lv.concurrency, true),
        el('td', { class: 'mono bench-hl', text: fmtNum(lv.reqPerSec, 2) }),
        td(fmtNum(lv.tokPerSec, 1), true),
        td(fmtMs(lv.ttftP50), true), td(fmtMs(lv.ttftP95), true),
        td(fmtMs(lv.totalP50), true), td(fmtMs(lv.totalP95), true),
        el('td', { class: 'mono', text: fmtPct(lv.errorRate) }),
        td(lv.okCount + ' / ' + lv.failCount, true),
      ]));
    });
    t.appendChild(tb); wrap.appendChild(t);
    sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: '레벨별 요약' }));
    sec.appendChild(wrap);

    // 곡선: 처리량 vs 동시성
    sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: '처리량(req/s) vs 동시성' }));
    sec.appendChild(benchLineChart(res.levels, function (lv) { return lv.reqPerSec; }, '--viz-2', 'req/s'));
    // 곡선: p95 지연 vs 동시성
    sec.appendChild(el('div', { class: 'bench-tbl-h field-note', text: '총지연 p95(ms) vs 동시성' }));
    sec.appendChild(benchLineChart(res.levels, function (lv) { return lv.totalP95; }, '--viz-1', 'ms'));

    BE.results.appendChild(sec);
    renderBenchExport(true);
  }

  // 결정적 SVG 라인차트 — x=동시성(레벨 인덱스 균등), y=accessor
  function benchLineChart(levels, accessor, colorVar, unit) {
    var W = 640, H = 170, padL = 48, padB = 28, padT = 12, padR = 14;
    var plotW = W - padL - padR, plotH = H - padB - padT;
    var vals = levels.map(accessor).map(function (v) { return typeof v === 'number' && !isNaN(v) ? v : 0; });
    var maxV = Math.max.apply(null, vals.concat([0]));
    if (maxV <= 0) maxV = 1;
    var n = levels.length;
    var stepX = n > 1 ? plotW / (n - 1) : 0;
    function px(i) { return padL + (n > 1 ? i * stepX : plotW / 2); }
    function py(v) { return padT + plotH - (v / maxV) * plotH; }
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'bench-line', width: '100%', preserveAspectRatio: 'xMidYMid meet', role: 'img' });
    // 축
    svg.appendChild(svgEl('line', { x1: padL, y1: padT, x2: padL, y2: padT + plotH, stroke: 'var(--color-border-strong)', 'stroke-width': '1' }));
    svg.appendChild(svgEl('line', { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: 'var(--color-border-strong)', 'stroke-width': '1' }));
    svg.appendChild(svgText(padL - 6, padT + 8, fmtNum(maxV, maxV < 10 ? 1 : 0) + '', { anchor: 'end', size: 10, fill: 'var(--color-text-muted)' }));
    svg.appendChild(svgText(padL - 6, padT + plotH, '0', { anchor: 'end', size: 10, fill: 'var(--color-text-muted)' }));
    svg.appendChild(svgText(padL - 30, padT + plotH / 2, unit, { anchor: 'middle', size: 9, fill: 'var(--color-text-faint)' }));
    // 폴리라인
    var pts = vals.map(function (v, i) { return px(i).toFixed(1) + ',' + py(v).toFixed(1); }).join(' ');
    if (n > 1) svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(' + colorVar + ')', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
    // 점 + 값 + x라벨
    vals.forEach(function (v, i) {
      svg.appendChild(svgEl('circle', { cx: px(i).toFixed(1), cy: py(v).toFixed(1), r: '3.5', fill: 'var(' + colorVar + ')' }));
      svg.appendChild(svgText(px(i), py(v) - 7, fmtNum(v, v < 10 ? 2 : 0), { anchor: 'middle', size: 9, fill: 'var(--color-text)' }));
      svg.appendChild(svgText(px(i), padT + plotH + 15, 'c' + levels[i].concurrency, { anchor: 'middle', size: 10, fill: 'var(--color-text-muted)' }));
    });
    var box = el('div', { class: 'bench-viz scroll-x' });
    box.appendChild(svg);
    return box;
  }

  function renderBenchExport(isSweep) {
    var sec = el('div', { class: 'lab-btnrow' });
    var jbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export JSON' });
    jbtn.addEventListener('click', function () {
      if (isSweep && bnLastSweep) {
        downloadFile('bench_sweep.json', JSON.stringify({
          schemaVersion: '1', type: 'llm-lab-bench-sweep', concurrencyLevels: bnLastSweep.concurrencyLevels,
          levels: bnLastSweep.levels.map(function (lv) {
            return { concurrency: lv.concurrency, reqPerSec: lv.reqPerSec, tokPerSec: lv.tokPerSec, ttftP50: lv.ttftP50, ttftP95: lv.ttftP95, totalP50: lv.totalP50, totalP95: lv.totalP95, errorRate: lv.errorRate, okCount: lv.okCount, failCount: lv.failCount, wallMs: lv.wallMs };
          }),
        }, null, 2));
      } else if (bnLastRun) {
        var r = bnLastRun;
        downloadFile('bench_run.json', JSON.stringify({
          schemaVersion: '1', type: 'llm-lab-bench', concurrency: r.concurrency, requests: r.requests, warmup: r.warmup,
          wallMs: r.wallMs, throughput: r.throughput, errorRate: r.errorRate, ttft: r.ttft, total: r.total,
          perRequest: r.perRequest,
        }, null, 2));
      }
    });
    var cbtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export CSV' });
    cbtn.addEventListener('click', function () {
      if (isSweep && bnLastSweep) downloadFile('bench_sweep.csv', benchSweepCSV(), 'text/csv');
      else if (bnLastRun) downloadFile('bench_run.csv', benchRunCSV(), 'text/csv');
    });
    sec.appendChild(el('span', { class: 'field-note', text: '내보내기: 요청별 계측 + 요약 지표' }));
    sec.appendChild(jbtn); sec.appendChild(cbtn);
    BE.results.appendChild(sec);
  }

  function benchRunCSV() {
    var header = ['index', 'ok', 'ttftMs', 'totalMs', 'completionTokens', 'error'];
    var lines = [header.join(',')];
    bnLastRun.perRequest.forEach(function (r, i) {
      lines.push([i, r.ok ? 'ok' : 'error', csvCell(r.ttftMs == null ? '' : r.ttftMs), csvCell(r.totalMs), csvCell(r.completionTokens), csvCell(r.error ? (r.error.message || '') : '')].join(','));
    });
    return lines.join('\n');
  }
  function benchSweepCSV() {
    var header = ['concurrency', 'reqPerSec', 'tokPerSec', 'ttftP50', 'ttftP95', 'totalP50', 'totalP95', 'errorRate', 'okCount', 'failCount', 'wallMs'];
    var lines = [header.join(',')];
    bnLastSweep.levels.forEach(function (lv) {
      lines.push([lv.concurrency, fmtNum(lv.reqPerSec, 3), fmtNum(lv.tokPerSec, 2), csvCell(lv.ttftP50), csvCell(lv.ttftP95), csvCell(lv.totalP50), csvCell(lv.totalP95), fmtNum(lv.errorRate, 4), lv.okCount, lv.failCount, lv.wallMs].join(','));
    });
    return lines.join('\n');
  }

  // SVG 헬퍼(네임스페이스)
  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function svgText(x, y, str, o) {
    o = o || {};
    var t = svgEl('text', { x: Number(x).toFixed(1), y: Number(y).toFixed(1), 'text-anchor': o.anchor || 'start', 'font-size': (o.size || 10), fill: o.fill || 'var(--color-text)', 'font-family': 'var(--font-mono, monospace)' });
    t.textContent = str;
    return t;
  }

  return { build: build, onShow: function () {} };
})();

/* ============================================================
   26b. BATCH RUNNER 모듈 — 데이터셋 배치 실행
   ============================================================ */
var BATCH = (function () {
  var BT = L.batch;
  var E = {};
  var dataset = { rows: [], columns: [], format: 'empty' };
  var lastRun = null;
  var abortCtl = null, running = false;

  var DEMO_CSV = 'input,expected\n"대한민국의 수도는?",서울\n"2 더하기 2는?",4\n"물의 화학식은?",H2O\n"HTTP 404의 의미를 한 문장으로.",\n"파이썬에서 리스트를 뒤집는 함수는?",reverse';
  var DEMO_JSONL = '{"topic":"광합성","level":"초등학생"}\n{"topic":"양자역학","level":"대학생"}\n{"topic":"블록체인","level":"일반인"}';

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [
        el('div', { class: 'lab__title', text: 'Batch Runner' }),
        el('div', { class: 'lab__sub', text: '프롬프트(또는 체인)를 데이터셋의 각 행에 일괄 실행합니다. CSV/JSONL 자동 감지, {{컬럼}} 템플릿 보간, 동시성 제한, 진행률·중단, 행별 에러 격리. 결과는 CSV/JSONL로 내보냅니다.' }),
      ]),
      el('div', { class: 'prov-legend' }, [provBadge('server'), provBadge('browser')]),
    ]));

    buildDatasetSection(inner);
    buildTemplateSection(inner);
    buildRunSection(inner);

    E.results = el('div', { id: 'batchResults' });
    inner.appendChild(E.results);
  }

  /* --- 1. 데이터셋 --- */
  function buildDatasetSection(inner) {
    var sec = labSection('1 · 데이터셋 (CSV / JSONL 자동 감지)');
    E.dataText = el('textarea', { class: 'field field-mono', rows: 6, placeholder: 'CSV(헤더행 포함) 또는 JSONL(줄별 JSON)을 붙여넣으세요…\n예) name,question\\n또는 {"input":"...","lang":"en"}' });
    E.dataText.addEventListener('input', function () { scheduleParse(); });

    var parseBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '파싱' });
    parseBtn.addEventListener('click', doParse);
    var demoCsvBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '데모 CSV' });
    demoCsvBtn.addEventListener('click', function () { E.dataText.value = DEMO_CSV; doParse(); });
    var demoJsonlBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '데모 JSONL' });
    demoJsonlBtn.addEventListener('click', function () { E.dataText.value = DEMO_JSONL; doParse(); });
    var fileLbl = el('label', { class: 'btn btn-ghost btn-sm', for: 'batchFile', text: '파일(.csv/.jsonl)' });
    var fileInp = el('input', { type: 'file', id: 'batchFile', accept: '.csv,.jsonl,.json,.txt', hidden: true });
    fileInp.addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { E.dataText.value = String(r.result || ''); doParse(); toast('로드: ' + f.name); };
      r.readAsText(f); e.target.value = '';
    });

    E.preview = el('div', { class: 'batch-preview' });
    sec.appendChild(el('div', { class: 'field-col' }, [E.dataText]));
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [parseBtn, demoCsvBtn, demoJsonlBtn, fileLbl, fileInp]));
    sec.appendChild(E.preview);
    inner.appendChild(sec);
    renderPreview();
  }
  var _parseTimer = null;
  function scheduleParse() { if (_parseTimer) clearTimeout(_parseTimer); _parseTimer = setTimeout(doParse, 350); }
  function doParse() {
    if (_parseTimer) { clearTimeout(_parseTimer); _parseTimer = null; }
    var txt = E.dataText.value;
    if (!txt.trim()) { dataset = { rows: [], columns: [], format: 'empty' }; renderPreview(); return; }
    dataset = BT.parseDataset(txt);
    renderPreview();
  }
  function renderPreview() {
    E.preview.innerHTML = '';
    if (!dataset.rows.length) {
      E.preview.appendChild(el('div', { class: 'field-note', text: dataset.format === 'empty' ? '데이터셋 없음 — 붙여넣거나 데모를 불러오세요.' : '파싱된 행이 없습니다.' }));
      return;
    }
    var fmtBadge = el('span', { class: 'batch-badge', text: dataset.format.toUpperCase() });
    E.preview.appendChild(el('div', { class: 'batch-preview__meta' }, [
      fmtBadge,
      el('span', { class: 'field-note mono', text: dataset.rows.length + '행 · ' + dataset.columns.length + '컬럼' }),
      el('span', { class: 'field-note mono', text: '컬럼: ' + dataset.columns.map(function (c) { return '{{' + c + '}}'; }).join(' ') }),
    ]));
    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact' });
    t.appendChild(el('thead', {}, [el('tr', {}, [thc('#')].concat(dataset.columns.map(thc)))]));
    var tb = el('tbody', {});
    dataset.rows.slice(0, 5).forEach(function (row, i) {
      var tds = [tdc(String(i + 1), true)].concat(dataset.columns.map(function (c) { return tdc(row[c]); }));
      tb.appendChild(el('tr', {}, tds));
    });
    t.appendChild(tb); wrap.appendChild(t); E.preview.appendChild(wrap);
    if (dataset.rows.length > 5) E.preview.appendChild(el('div', { class: 'field-note', text: '… 상위 5행 미리보기 (전체 ' + dataset.rows.length + '행)' }));
  }
  function thc(x) { return el('th', { text: x == null ? '' : String(x) }); }
  function tdc(x, mono) { var s = x == null ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)); return el('td', { class: 'cell-clip' + (mono ? ' mono' : ''), title: s, text: s.length > 60 ? s.slice(0, 60) + '…' : s }); }

  /* --- 2. 템플릿 · 모드 --- */
  function buildTemplateSection(inner) {
    var sec = labSection('2 · 프롬프트 템플릿 · 모드');
    E.template = el('textarea', { class: 'field field-mono', rows: 3, placeholder: '{{컬럼}} 로 행 값을 삽입합니다. 예) 다음 질문에 답하세요: {{input}}' });
    E.template.value = '{{input}}';
    E.system = el('textarea', { class: 'field field-mono', rows: 2, placeholder: 'system 프롬프트 (선택)' });

    E.mode = el('select', { class: 'field' });
    [['prompt', '단일 프롬프트'], ['chain', '체인 (Chain)']].forEach(function (o) { E.mode.appendChild(el('option', { value: o[0], text: o[1] })); });
    E.mode.addEventListener('change', function () { E.chainWrap.hidden = E.mode.value !== 'chain'; if (E.mode.value === 'chain') refreshChains(); });

    E.prof = el('select', { class: 'field' });
    E.prof.appendChild(el('option', { value: '', text: '(활성 연결)' }));
    L.profiles.list().forEach(function (p) { E.prof.appendChild(el('option', { value: p.id, text: p.label })); });
    E.model = el('input', { type: 'text', class: 'field', placeholder: '모델 override (비우면 활성 모델)' });
    E.temp = el('input', { type: 'number', class: 'field field-num', step: 0.05, min: 0, max: 2, value: 0.7 });
    E.maxt = el('input', { type: 'number', class: 'field field-num', step: 16, min: 1, value: 512 });

    // 체인 선택 (저장된 체인)
    E.chainSel = el('select', { class: 'field' });
    E.chainJson = el('textarea', { class: 'field field-mono', rows: 3, placeholder: '체인 정의 JSON (steps) 붙여넣기 — 비우면 위에서 선택한 저장된 체인 사용' });
    E.chainWrap = el('div', { class: 'field-col', hidden: true }, [
      el('label', { text: '체인 선택 (Chain 탭에서 저장한 체인)' }), E.chainSel,
      el('label', { text: '또는 체인 정의 JSON' }), E.chainJson,
      el('div', { class: 'field-note', text: '각 행에서 {{컬럼}} 보간 결과가 체인의 input 으로 전달됩니다. 저장된 체인이 없으면 Chain 탭에서 먼저 저장하세요.' }),
    ]);

    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '프롬프트 템플릿  ({{컬럼}} 사용)' }), E.template]));
    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: 'system 프롬프트 (선택)' }), E.system]));
    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '모드' }), E.mode, el('label', { text: '연결' }), E.prof, el('label', { text: '모델' }), E.model]));
    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: 'temp' }), E.temp, el('label', { text: 'max_tok' }), E.maxt]));
    sec.appendChild(E.chainWrap);
    inner.appendChild(sec);
  }
  function refreshChains() {
    var saved = lsGet('llmlab.chains', {}) || {};
    var names = Object.keys(saved);
    E.chainSel.innerHTML = '';
    if (!names.length) { E.chainSel.appendChild(el('option', { value: '', text: '(저장된 체인 없음)' })); return; }
    E.chainSel.appendChild(el('option', { value: '', text: '(선택)' }));
    names.forEach(function (n) { E.chainSel.appendChild(el('option', { value: n, text: n })); });
  }
  function resolveChain() {
    var raw = E.chainJson.value.trim();
    if (raw) { try { var c = JSON.parse(raw); if (c && (c.steps || c.nodes)) return c; toast('체인 JSON에 steps가 없습니다.', 'warn'); } catch (e) { toast('체인 JSON 파싱 실패: ' + e.message, 'err'); return null; } }
    var name = E.chainSel.value;
    if (name) { var saved = lsGet('llmlab.chains', {}) || {}; if (saved[name]) return saved[name]; }
    return null;
  }

  /* --- 3. 실행 --- */
  function buildRunSection(inner) {
    var sec = labSection('3 · 실행');
    E.concurrency = el('input', { type: 'range', class: 'batch-range', min: 1, max: 10, step: 1, value: 3 });
    E.concLabel = el('span', { class: 'mono field-note', text: '동시성 3' });
    E.concurrency.addEventListener('input', function () { E.concLabel.textContent = '동시성 ' + E.concurrency.value; });

    E.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ Run batch' });
    E.runBtn.addEventListener('click', run);
    E.progress = el('div', { class: 'eval-progress', hidden: true }, [el('div', { class: 'eval-progress__bar' })]);
    E.progressTxt = el('span', { class: 'mono field-note' });

    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '동시 실행(concurrency)' }), E.concurrency, E.concLabel]));
    sec.appendChild(el('div', { class: 'field-note', text: '순차(1) ~ 병렬(10). 값이 클수록 빠르지만 서버 부하·레이트리밋에 유의하세요.' }));
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [E.runBtn, E.progressTxt]));
    sec.appendChild(E.progress);
    inner.appendChild(sec);
  }

  function run() {
    if (running) { if (abortCtl) abortCtl.abort(); return; }
    if (!dataset.rows.length) { toast('데이터셋을 먼저 파싱하세요.', 'warn'); return; }
    var p = activeProfile();
    var pid = E.prof.value || (p && p.id);
    if (!pid) { toast('활성 연결이 없습니다. 연결을 추가하세요.', 'warn'); return; }
    var mode = E.mode.value;
    var chain = null;
    if (mode === 'chain') { chain = resolveChain(); if (!chain) { toast('체인을 선택하거나 정의 JSON을 입력하세요.', 'warn'); return; } }

    running = true; E.runBtn.textContent = '■ 중단'; E.runBtn.classList.add('is-running');
    var ctl = new AbortController(); abortCtl = ctl;
    E.progress.hidden = false; E.progress.querySelector('.eval-progress__bar').style.width = '0%';
    E.progressTxt.textContent = '0 / ' + dataset.rows.length;
    E.results.innerHTML = '';

    BT.runBatch({
      rows: dataset.rows,
      template: E.template.value,
      systemPrompt: E.system.value,
      mode: mode, chain: chain,
      profileId: pid, model: E.model.value || '',
      params: { temperature: num(E.temp.value, 0.7), max_tokens: num(E.maxt.value, 512) },
      concurrency: parseInt(E.concurrency.value, 10) || 3,
      useProxy: state.ui.useProxy, signal: ctl.signal,
      onProgress: function (pr) {
        var pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
        E.progress.querySelector('.eval-progress__bar').style.width = pct + '%';
        E.progressTxt.textContent = pr.done + ' / ' + pr.total + ' (ok ' + pr.ok + ' · 실패 ' + pr.failed + ')';
      },
    }).then(function (res) {
      running = false; E.runBtn.textContent = '▶ Run batch'; E.runBtn.classList.remove('is-running');
      E.progress.hidden = true;
      lastRun = res;
      renderResults();
      toast(ctl.signal.aborted ? '중단됨 · 부분 결과' : ('배치 완료 · ' + res.stats.ok + '/' + res.stats.count + ' 성공'), ctl.signal.aborted ? 'warn' : 'ok');
    }).catch(function (e) {
      running = false; E.runBtn.textContent = '▶ Run batch'; E.runBtn.classList.remove('is-running'); E.progress.hidden = true;
      toast('배치 오류: ' + (e && e.message || e), 'err');
    });
  }
  function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }

  /* --- 결과 --- */
  function renderResults() {
    E.results.innerHTML = '';
    if (!lastRun) return;
    var st = lastRun.stats;
    var sec = labSection('결과 (' + st.count + '행)', provBadge('server'));
    // 요약 통계
    sec.appendChild(el('div', { class: 'batch-stats' }, [
      statChip('총', st.count), statChip('성공', st.ok, 'ok'), statChip('실패', st.failed, st.failed ? 'no' : ''),
      statChip('총 소요', fmtMs(st.totalMs)), statChip('평균/행', fmtMs(st.avgMs)),
    ]));

    var wrap = el('div', { class: 'scroll-x' });
    var t = el('table', { class: 'data-table data-table--compact' });
    var inputCols = lastRun.rows.length ? Object.keys(lastRun.rows[0].vars || {}) : [];
    t.appendChild(el('thead', {}, [el('tr', {}, [thc('#')].concat(inputCols.map(thc)).concat([thc('상태'), thc('ms'), thc('output')]))]));
    var tb = el('tbody', {});
    lastRun.rows.forEach(function (r) {
      var status = r.error
        ? el('span', { class: 'metric-pill metric-pill--no', title: (r.error.type || '') + ' ' + (r.error.message || ''), text: '실패' })
        : el('span', { class: 'metric-pill metric-pill--ok', text: 'ok' });
      var outText = r.error ? ('⚠ ' + (r.error.message || 'error')) : (r.output || '');
      var outCell = el('td', { class: 'cell-output', title: outText, text: outText.length > 160 ? outText.slice(0, 160) + '…' : outText });
      var cells = [tdc(String(r.index + 1), true)]
        .concat(inputCols.map(function (c) { return tdc((r.vars || {})[c]); }))
        .concat([el('td', {}, [status]), tdc(r.ms, true), outCell]);
      tb.appendChild(el('tr', { class: r.error ? 'row-err' : '' }, cells));
    });
    t.appendChild(tb); wrap.appendChild(t); sec.appendChild(wrap);
    E.results.appendChild(sec);

    renderExport();
  }
  function statChip(k, v, kind) {
    return el('div', { class: 'batch-stat' + (kind ? ' batch-stat--' + kind : '') }, [el('i', { text: k }), el('b', { class: 'mono', text: String(v) })]);
  }

  function renderExport() {
    var sec = el('div', { class: 'lab-btnrow' });
    var csvBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'CSV 다운로드' });
    csvBtn.addEventListener('click', function () { downloadFile('batch_results.csv', BT.toCSV(lastRun), 'text/csv'); });
    var jsonlBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'JSONL 다운로드' });
    jsonlBtn.addEventListener('click', function () { downloadFile('batch_results.jsonl', BT.toJSONL(lastRun), 'application/x-ndjson'); });
    var csvCopy = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'CSV 복사' });
    csvCopy.addEventListener('click', function () { copyText(BT.toCSV(lastRun)).then(function () { toast('CSV 클립보드 복사'); }); });
    var jsonlCopy = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'JSONL 복사' });
    jsonlCopy.addEventListener('click', function () { copyText(BT.toJSONL(lastRun)).then(function () { toast('JSONL 클립보드 복사'); }); });
    sec.appendChild(el('span', { class: 'field-note', text: '내보내기: 입력 컬럼 + output + status + error + ms' }));
    sec.appendChild(csvBtn); sec.appendChild(jsonlBtn); sec.appendChild(csvCopy); sec.appendChild(jsonlCopy);
    E.results.appendChild(sec);
  }

  return { build: build, onShow: function () {} };
})();

/* ============================================================
   27. SIMULATE 모듈 (§8.8)
   ============================================================ */
var SIM = (function () {
  var S = L.sim;
  var E = {};
  var PERSONAS = {
    helpful: '너는 친절하고 유능한 조수다. 명확하고 간결하게 돕는다.',
    socratic: '너는 소크라테스식 교사다. 답을 바로 주기보다 질문으로 사고를 유도한다.',
    skeptic: '너는 근거를 요구하는 회의적 검토자다. 주장마다 출처와 논리를 따진다.',
    customer: '너는 제품에 관심 있는 실제 사용자다. 궁금한 점을 자연스럽게 계속 물어본다.',
  };
  function newPart(id, name) { return { id: id, name: name, role: 'assistant', persona: PERSONAS.helpful, goal: '', profileId: '', model: '', params: { temperature: 0.8 } }; }
  var parts = [newPart('a', 'A'), newPart('b', 'B')];
  var abortCtl = null, running = false;
  var lastTranscript = [];

  function build(panel) {
    panel.dataset.built = '1';
    var scroll = el('div', { class: 'lab__scroll' });
    var inner = el('div', { class: 'lab__inner' });
    scroll.appendChild(inner);
    panel.appendChild(el('div', { class: 'lab' }, [scroll]));

    inner.appendChild(el('div', { class: 'lab__head' }, [
      el('div', {}, [
        el('div', { class: 'lab__title', text: 'Simulate' }),
        el('div', { class: 'lab__sub', text: '멀티턴 시나리오에서 모델 vs 모델 자동 대화 · 페르소나/목표 · user-simulator · 종료조건(최대턴/정지문자열/목표). 화자 색 구분 타임라인, 중단, transcript export.' }),
      ]),
      el('div', { class: 'prov-legend' }, [provBadge('server')]),
    ]));

    buildParticipantSection(inner);
    buildScenarioSection(inner);

    E.timeline = el('div', { id: 'simTimeline' });
    inner.appendChild(E.timeline);

    E.expBtn.addEventListener('click', function () {
      downloadFile('simulation.json', JSON.stringify({ schemaVersion: '1', type: 'llm-lab-simulation', transcript: lastTranscript }, null, 2));
    });
  }

  function buildParticipantSection(inner) {
    var sec = labSection('1 · 참가자');
    E.partGrid = el('div', { class: 'variant-grid' });
    parts.forEach(function (p, i) { E.partGrid.appendChild(buildPartCard(p, i)); });
    sec.appendChild(E.partGrid);
    inner.appendChild(sec);
  }
  function buildPartCard(p, idx) {
    var card = el('div', { class: 'variant-card sim-part' });
    card.style.borderLeft = '3px solid var(--viz-' + ((idx % 4) + 1) + ')';
    var name = el('input', { type: 'text', class: 'field', value: p.name, placeholder: '이름' });
    name.addEventListener('input', function () { p.name = name.value; });
    card.appendChild(el('div', { class: 'variant-card__h' }, [el('span', { class: 'sim-dot', style: 'background:var(--viz-' + ((idx % 4) + 1) + ')' }), name]));

    var role = el('select', { class: 'field' });
    [['assistant', 'assistant(모델)'], ['user_sim', 'user-simulator']].forEach(function (o) { var op = el('option', { value: o[0], text: o[1] }); if (p.role === o[0]) op.selected = true; role.appendChild(op); });
    role.addEventListener('change', function () { p.role = role.value; });

    var pset = el('select', { class: 'field' });
    pset.appendChild(el('option', { value: '', text: '페르소나 프리셋…' }));
    Object.keys(PERSONAS).forEach(function (k) { pset.appendChild(el('option', { value: k, text: k })); });
    pset.addEventListener('change', function () { if (pset.value) { p.persona = PERSONAS[pset.value]; persona.value = p.persona; } });

    var persona = el('textarea', { class: 'field field-mono', rows: 2, placeholder: '페르소나 / 시스템' });
    persona.value = p.persona; persona.addEventListener('input', function () { p.persona = persona.value; });
    var goal = el('input', { type: 'text', class: 'field', value: p.goal, placeholder: '목표(선택)' });
    goal.addEventListener('input', function () { p.goal = goal.value; });

    var prof = el('select', { class: 'field' });
    prof.appendChild(el('option', { value: '', text: '(활성 연결)' }));
    L.profiles.list().forEach(function (pr) { var o = el('option', { value: pr.id, text: pr.label }); if (p.profileId === pr.id) o.selected = true; prof.appendChild(o); });
    prof.addEventListener('change', function () { p.profileId = prof.value; });
    var model = el('input', { type: 'text', class: 'field', value: p.model, placeholder: '모델 override' });
    model.addEventListener('input', function () { p.model = model.value; });
    var temp = el('input', { type: 'number', class: 'field field-num', step: 0.05, min: 0, max: 2, value: p.params.temperature });
    temp.addEventListener('input', function () { p.params.temperature = parseFloat(temp.value); });

    card.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '역할' }), role, pset]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '페르소나' }), persona]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '목표' }), goal]));
    card.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: '연결' }), prof, el('label', { text: 'temp' }), temp]));
    card.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '모델' }), model]));
    return card;
  }

  function buildScenarioSection(inner) {
    var sec = labSection('2 · 시나리오 & 종료조건');
    E.scenario = el('textarea', { class: 'field', rows: 2, placeholder: '상황 설명(선택) — 예: 고객이 환불 정책을 문의하는 상담 대화' });
    E.seed = el('input', { type: 'text', class: 'field', placeholder: '첫 발화 시드(선택) — 첫 화자가 받는 메시지' });
    E.maxTurns = el('input', { type: 'number', class: 'field field-num', min: 1, max: 40, step: 1, value: 8 });
    E.firstSpeaker = el('select', { class: 'field' });
    parts.forEach(function (p, i) { E.firstSpeaker.appendChild(el('option', { value: i, text: '첫 화자: ' + p.name })); });
    E.stopStr = el('input', { type: 'text', class: 'field field-mono', placeholder: '정지 문자열(선택) — 예: [END]' });
    E.mode = el('select', { class: 'field' });
    [['normal', '일반'], ['redteam', '레드팀/적대적']].forEach(function (o) { E.mode.appendChild(el('option', { value: o[0], text: o[1] })); });
    E.redteamNote = el('div', { class: 'redteam-note', hidden: true }, [
      el('span', { class: 'lab-flag lab-flag--warn', text: '연구·방어 목적' }),
      el('span', { class: 'field-note', text: '적대적/레드팀 모드는 모델의 취약점을 연구하고 방어책을 개선하기 위한 용도입니다. 범위를 제한해 사용하세요.' }),
    ]);
    E.mode.addEventListener('change', function () { E.redteamNote.hidden = E.mode.value !== 'redteam'; });

    E.runBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '▶ 시뮬레이션 실행' });
    E.runBtn.addEventListener('click', run);
    E.expBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Export', hidden: true });
    E.expMenu = el('div', {});

    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '시나리오' }), E.scenario]));
    sec.appendChild(el('div', { class: 'field-col' }, [el('label', { text: '시드' }), E.seed]));
    sec.appendChild(el('div', { class: 'param-mini' }, [el('label', { text: 'max_turns' }), E.maxTurns, E.firstSpeaker, el('label', { text: 'stop' }), E.stopStr, el('label', { text: 'mode' }), E.mode]));
    sec.appendChild(E.redteamNote);
    sec.appendChild(el('div', { class: 'lab-btnrow' }, [E.runBtn, E.expBtn]));
    inner.appendChild(sec);
  }

  function run() {
    if (running) { if (abortCtl) abortCtl.abort(); return; }
    var p = activeProfile(); if (!p) { toast('활성 연결이 없습니다.', 'warn'); return; }
    var participants = parts.map(function (x) {
      return { id: x.id, name: x.name, role: x.role, persona: x.persona, goal: x.goal,
        profileId: x.profileId || p.id, model: x.model || profileModel(p), params: Object.assign({}, x.params) };
    });

    running = true; E.runBtn.textContent = '■ 중단'; E.runBtn.classList.add('is-running');
    var ctl = new AbortController(); abortCtl = ctl;
    E.timeline.innerHTML = '';
    var tsec = labSection('대화 타임라인', provBadge('server'));
    var body = el('div', { class: 'sim-timeline' }); tsec.appendChild(body); E.timeline.appendChild(tsec);
    lastTranscript = [];

    S.runSimulation({
      participants: participants, maxTurns: parseInt(E.maxTurns.value, 10) || 8,
      scenario: E.scenario.value.trim(), seedMessage: E.seed.value.trim(),
      firstSpeaker: parseInt(E.firstSpeaker.value, 10) || 0,
      stop: { onStopString: E.stopStr.value.trim() || null },
      mode: E.mode.value, useProxy: state.ui.useProxy, signal: ctl.signal,
      onTurn: function (rec) { appendTurn(body, rec); },
    }).then(function (res) {
      running = false; E.runBtn.textContent = '▶ 시뮬레이션 실행'; E.runBtn.classList.remove('is-running');
      lastTranscript = res.transcript;
      var m = res.metrics || {};
      body.appendChild(el('div', { class: 'sim-summary' }, [
        el('span', { class: 'mono', text: 'outcome: ' + res.outcome }),
        el('span', { class: 'mono', text: 'turns: ' + m.turns }),
        el('span', { class: 'mono', text: (m.totalTokens || 0) + ' tok · ' + fmtMs(m.totalMs) }),
        res.redteam ? el('span', { class: 'lab-flag lab-flag--warn', text: '레드팀(연구·방어)' }) : null,
      ]));
      E.expBtn.hidden = false;
      toast(ctl.signal.aborted ? '중단됨' : ('시뮬레이션 종료: ' + res.outcome), ctl.signal.aborted ? 'warn' : 'ok');
    });
  }

  function partIndex(id) { for (var i = 0; i < parts.length; i++) if (parts[i].id === id) return i; return 0; }
  function appendTurn(body, rec) {
    var idx = partIndex(rec.speakerId);
    var vi = (idx % 4) + 1;
    var turn = el('div', { class: 'sim-turn sim-turn--' + (idx % 2 === 0 ? 'l' : 'r') });
    turn.style.setProperty('--turn-color', 'var(--viz-' + vi + ')');
    var head = el('div', { class: 'sim-turn__h' }, [
      el('span', { class: 'sim-dot', style: 'background:var(--viz-' + vi + ')' }),
      el('span', { class: 'sim-turn__name', text: rec.name || rec.speakerId }),
      el('span', { class: 'sim-turn__role mono', text: rec.role }),
      rec.ms != null ? el('span', { class: 'mono field-note', text: fmtMs(rec.ms) }) : null,
      rec.usage ? el('span', { class: 'mono field-note', text: (rec.usage.total_tokens || '?') + ' tok' }) : null,
      provBadge(rec.provider || 'server'),
    ]);
    turn.appendChild(head);
    if (rec.error) { turn.appendChild(el('div', { class: 'msg__error', text: (rec.error.message || '오류') })); }
    else { var b = el('div', { class: 'sim-turn__bubble md' }); renderMarkdownInto(b, rec.content || '(빈 응답)'); turn.appendChild(b); }
    body.appendChild(turn);
    body.scrollTop = body.scrollHeight;
  }

  return { build: build, onShow: function () {} };
})();

/* ============================================================
   21. 초기화
   ============================================================ */
function init() {
  applyTheme();
  initMermaid();
  renderTabbar(); renderWbNav();
  initSideSections();
  renderConnList(); renderConnSwitcher(); renderModelSwitcher();
  renderDbList();
  initSessions(); renderSessions();
  initChat();
  bindEvents();
  subscribeEngine();
  renderHistory();
  // 인스펙터 복원
  if (state.ui.inspectorOpen) openInspector();
  // 활성 탭 복원
  switchTab(state.ui.activeTab || 'chat');
  // 첫 진입 시 조용히 헬스체크(자동)
  if (activeProfile()) setTimeout(runHealthCheck, 300);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
