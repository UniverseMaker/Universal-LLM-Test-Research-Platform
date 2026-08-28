// api.js — vLLM(OpenAI 호환) 채팅 API 연동 계층 (v1)
// 계약: _workspace/03_frontend_api-contract.md 준수
//  - sendMessage({ messages, settings, onToken, onReasoning, onDone, onError, signal })
//  - onToken(delta:string) / onReasoning(delta:string)
//  - onDone({ content:string, reasoning:string }) / onError({ type, message })
//  - DEFAULT_CONFIG, buildFileContext(files)
//
// 대상: OpenAI 호환 /v1/chat/completions, stream:true (SSE)
// reasoning 이중 대응: delta.reasoning_content 우선, 없으면 본문 <think>…</think> 파싱.

/* ------------------------------------------------------------------ */
/* 설정 (한 곳에 모아 settings로 오버라이드 가능)                        */
/* ------------------------------------------------------------------ */

/* IIFE로 감싸 내부 이름(sendMessage 등)이 전역을 오염시키지 않게 한다.
   app.js도 같은 이름을 전역에 두므로, 감싸지 않으면 재선언 SyntaxError 발생. */
(function () {
'use strict';

const DEFAULT_CONFIG = {
  baseURL: '',
  model: '',
  apiKey: '',
  temperature: 0.7,
  max_tokens: 2048,
  top_p: 1,
};

// 파일 하나당 컨텍스트에 삽입할 최대 문자 수 (초과 시 잘림 표시)
const FILE_CONTEXT_CHAR_LIMIT = 8000;

/* ------------------------------------------------------------------ */
/* <think> 태그 스트리밍 파서 (본문/사고 라우팅)                        */
/* ------------------------------------------------------------------ */
// 스트림 청크 경계에 태그가 걸쳐도 안전하게 분리한다.
// - 사고 구간(<think>…</think>) → emitReasoning
// - 그 밖의 본문           → emitToken
function createThinkSplitter(emitReasoning, emitToken) {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let carry = '';

  function emit(str) {
    if (!str) return;
    if (inThink) emitReasoning(str);
    else emitToken(str);
  }

  function process(flush) {
    while (true) {
      const tag = inThink ? CLOSE : OPEN;
      const idx = carry.indexOf(tag);
      if (idx !== -1) {
        emit(carry.slice(0, idx)); // 태그 앞부분은 현재 모드로 방출
        carry = carry.slice(idx + tag.length);
        inThink = !inThink; // 모드 전환
        continue; // 남은 buffer에서 계속 탐색
      }
      // 완전한 태그 없음. flush가 아니면 부분 태그 가능성만큼 뒤를 보류.
      if (!flush) {
        let hold = 0;
        const maxLen = Math.min(tag.length - 1, carry.length);
        for (let k = maxLen; k > 0; k--) {
          if (carry.slice(carry.length - k) === tag.slice(0, k)) {
            hold = k;
            break;
          }
        }
        if (hold > 0) {
          emit(carry.slice(0, carry.length - hold));
          carry = carry.slice(carry.length - hold); // 부분 태그 보류
        } else {
          emit(carry);
          carry = '';
        }
      } else {
        emit(carry); // 종료: 남은 것 전부 방출
        carry = '';
      }
      break;
    }
  }

  return {
    feed(text) {
      carry += text;
      process(false);
    },
    end() {
      process(true);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 요청 body 구성                                                       */
/* ------------------------------------------------------------------ */
function buildRequestBody(messages, cfg) {
  let msgs = Array.isArray(messages) ? messages.slice() : [];

  // systemPrompt가 주어졌고 messages에 system이 없으면 앞에 주입 (S3).
  // 앱이 이미 system 메시지를 구성했다면 중복 주입하지 않는다.
  const hasSystem = msgs.some((m) => m && m.role === 'system');
  if (!hasSystem && cfg.systemPrompt && cfg.systemPrompt.trim()) {
    msgs = [{ role: 'system', content: cfg.systemPrompt }, ...msgs];
  }

  const body = {
    model: cfg.model,
    messages: msgs,
    stream: true,
    // F5: 스트리밍 중 usage(prompt/completion/total tokens)를 마지막 청크로 받기.
    stream_options: { include_usage: true },
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
  };
  if (cfg.top_p != null) body.top_p = cfg.top_p;

  // reasoning off 훅 (일부 모델 / vLLM): enable_thinking=false 전달.
  if (cfg.reasoningEnabled === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* HTTP 상태 → 사용자 친화 메시지                                       */
/* ------------------------------------------------------------------ */
function httpErrorMessage(status, bodyText) {
  const detail = (bodyText || '').slice(0, 300);
  let base;
  if (status === 401 || status === 403) {
    base = 'API 인증에 실패했습니다. API 키를 확인해 주세요.';
  } else if (status === 404) {
    base = '엔드포인트 또는 모델을 찾을 수 없습니다. baseURL과 model 설정을 확인해 주세요.';
  } else if (status === 429) {
    base = '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  } else if (status >= 500) {
    base = '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  } else {
    base = `요청이 거부되었습니다 (HTTP ${status}).`;
  }
  return detail ? `${base}\n(HTTP ${status}: ${detail})` : `${base} (HTTP ${status})`;
}

/* ------------------------------------------------------------------ */
/* 메인: 스트리밍 채팅                                                  */
/* ------------------------------------------------------------------ */
async function sendMessage({
  messages,
  settings,
  onToken,
  onReasoning,
  onDone,
  onError,
  signal,
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(settings || {}) };

  /* ------------------------------------------------------------------ */
  /* v24: LLM Lab 공용 커널 위임 (호환 유지)                             */
  /* window.LLMLab.kernel 이 로드돼 있으면 커널을 통해 실행하고,          */
  /* 콜백 shape({content,reasoning,usage})은 그대로 유지한다.            */
  /* 커널 부재(구형/단독 실행) 시 아래 레거시 경로로 폴백.               */
  /* ------------------------------------------------------------------ */
  if (!cfg.__legacy && typeof window !== 'undefined' && window.LLMLab && window.LLMLab.kernel) {
    // systemPrompt 주입(레거시 buildRequestBody와 동일 규칙): system 없을 때만.
    let msgs = Array.isArray(messages) ? messages.slice() : [];
    if (!msgs.some((m) => m && m.role === 'system') && cfg.systemPrompt && cfg.systemPrompt.trim()) {
      msgs = [{ role: 'system', content: cfg.systemPrompt }, ...msgs];
    }
    return window.LLMLab.kernel.run({
      module: 'chat',
      // 활성 프로필이 있으면 우선 사용, 없거나 설정 오버라이드가 있으면 ad-hoc connection.
      profileId: cfg.profileId || (window.LLMLab.profiles.getActiveId ? window.LLMLab.profiles.getActiveId() : null),
      connection: (cfg.baseURL || cfg.apiKey || cfg.model)
        ? { baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model }
        : undefined,
      model: cfg.model,
      messages: msgs,
      stream: true,
      reasoningEnabled: cfg.reasoningEnabled,
      params: {
        temperature: cfg.temperature,
        top_p: cfg.top_p,
        max_tokens: cfg.max_tokens,
        timeout_ms: Number(cfg.timeout) || undefined,
        stream: true,
      },
      onToken,
      onReasoning,
      onDone: (r) => {
        if (typeof onDone === 'function') onDone({ content: r.content, reasoning: r.reasoning, usage: r.usage });
      },
      onError: (err) => {
        if (typeof onError === 'function') onError({ type: err.type, message: err.message });
      },
      signal,
    }).then(() => {});
  }

  // 콜백 안전 가드 (계약상 제공되지만 누락 시 no-op)
  const _onToken = typeof onToken === 'function' ? onToken : () => {};
  const _onReasoning = typeof onReasoning === 'function' ? onReasoning : () => {};
  const _onDone = typeof onDone === 'function' ? onDone : () => {};
  const _onError = typeof onError === 'function' ? onError : () => {};

  // 누적 버퍼 (onDone에 전체 전달)
  let fullContent = '';
  let fullReasoning = '';
  // F5: usage(토큰 사용량) — include_usage로 스트림 마지막 청크에 실려 온다.
  let usage = null;
  const pickUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    // 계약: prompt_tokens / completion_tokens / total_tokens 만 정확히 전달.
    usage = {
      prompt_tokens: Number(u.prompt_tokens) || 0,
      completion_tokens: Number(u.completion_tokens) || 0,
      total_tokens:
        Number(u.total_tokens) ||
        (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
    };
  };
  const emitToken = (d) => {
    if (!d) return;
    fullContent += d;
    _onToken(d);
  };
  const emitReasoning = (d) => {
    if (!d) return;
    fullReasoning += d;
    _onReasoning(d);
  };
  const splitter = createThinkSplitter(emitReasoning, emitToken);

  // 취소/타임아웃: 내부 컨트롤러로 외부 signal + 타임아웃을 통합.
  const ctl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }
  let timer = null;
  const timeoutMs = Number(cfg.timeout) || 0; // settings.timeout(ms), 0이면 비활성
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  };

  try {
    let res;
    try {
      res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(messages, cfg)),
        signal: ctl.signal,
      });
    } catch (err) {
      // fetch 자체 실패 (네트워크/CORS/중단)
      if (err && err.name === 'AbortError') {
        if (timedOut) _onError({ type: 'timeout', message: '응답 시간이 초과되었습니다. 다시 시도해 주세요.' });
        else _onError({ type: 'abort', message: '요청이 중단되었습니다.' });
      } else {
        console.warn('[api] fetch 실패 — 서버 연결/CORS를 확인하세요:', err);
        _onError({
          type: 'network',
          message: '서버에 연결할 수 없습니다. 네트워크 상태 또는 baseURL/CORS 설정을 확인해 주세요.',
        });
      }
      return;
    }

    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        /* ignore */
      }
      _onError({ type: 'http', message: httpErrorMessage(res.status, bodyText) });
      return;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      _onError({
        type: 'network',
        message: '스트리밍 응답을 읽을 수 없습니다. 브라우저 또는 서버 설정을 확인해 주세요.',
      });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE는 라인 단위. \r\n 대비 정규화 후 개행 분리.
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 마지막 불완전 라인 보존

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue; // 주석/keep-alive 무시
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          splitter.end();
          _onDone({ content: fullContent, reasoning: fullReasoning, usage });
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 부분/비정상 라인 무시
        }
        // F5: usage 청크 — include_usage 시 마지막에 choices:[] + usage:{...} 형태로 온다.
        if (json.usage) pickUsage(json.usage);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        // 이중 대응: reasoning_content 우선 → 사고 블록
        if (delta.reasoning_content) emitReasoning(delta.reasoning_content);
        // 본문 content는 think-splitter를 통해 <think> 태그 폴백까지 처리
        if (delta.content) splitter.feed(delta.content);
      }
    }

    // [DONE] 없이 스트림 종료 — 남은 버퍼 flush 후 완료 처리
    splitter.end();
    _onDone({ content: fullContent, reasoning: fullReasoning, usage });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (timedOut) _onError({ type: 'timeout', message: '응답 시간이 초과되었습니다. 다시 시도해 주세요.' });
      else _onError({ type: 'abort', message: '요청이 중단되었습니다.' });
    } else {
      console.warn('[api] 스트림 처리 중 오류:', err);
      _onError({
        type: 'network',
        message: `응답을 처리하는 중 오류가 발생했습니다: ${err && err.message ? err.message : err}`,
      });
    }
  } finally {
    cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* 파일 컨텍스트 빌더                                                   */
/* ------------------------------------------------------------------ */

// 텍스트로 읽을 수 있는 파일 판별 (확장자 + MIME)
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'ini', 'conf', 'cfg', 'env', 'toml',
  // 코드
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'r', 'lua', 'pl',
  'dart', 'gradle', 'dockerfile', 'makefile',
]);

// 확장자 → 코드펜스 언어 라벨
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  jsx: 'jsx', tsx: 'tsx', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', json: 'json',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'tsv', toml: 'toml',
};

function getExt(name) {
  const base = (name || '').toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot === -1) return base; // Dockerfile, Makefile 등 확장자 없음
  return base.slice(dot + 1);
}

function isTextLike(file) {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('text/')) return true;
  if (
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/x-yaml' ||
    type === 'application/javascript' ||
    type === 'application/x-sh' ||
    type === 'application/csv'
  ) {
    return true;
  }
  if (type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/')) {
    return false;
  }
  return TEXT_EXTENSIONS.has(getExt(file.name));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('파일 읽기 실패'));
    reader.readAsText(file);
  });
}

// files: File[] | FileList → Promise<string>
// 텍스트/코드/md/json/csv/log 등은 코드펜스로 컨텍스트화(파일당 ~8000자 제한),
// 이미지/바이너리는 분석 불가 폴백 문구.
async function buildFileContext(files) {
  if (!files) return '';
  const list = Array.from(files);
  if (list.length === 0) return '';

  const parts = [];
  for (const file of list) {
    const name = file.name || '(이름없음)';
    if (isTextLike(file)) {
      let content;
      try {
        content = await readFileAsText(file);
      } catch (e) {
        parts.push(`[파일: ${name}] — 파일을 읽는 중 오류가 발생했습니다 (${e && e.message ? e.message : e}).`);
        continue;
      }
      let truncated = false;
      if (content.length > FILE_CONTEXT_CHAR_LIMIT) {
        content = content.slice(0, FILE_CONTEXT_CHAR_LIMIT);
        truncated = true;
      }
      const lang = EXT_LANG[getExt(name)] || '';
      let block = `[파일: ${name}]\n\`\`\`${lang}\n${content}\n\`\`\``;
      if (truncated) {
        block += `\n> (⚠ ${name}은(는) 너무 길어 앞 ${FILE_CONTEXT_CHAR_LIMIT}자까지만 표시되었습니다. 이후 내용은 잘렸습니다.)`;
      }
      parts.push(block);
    } else {
      const typeLabel = file.type || '알 수 없는 형식';
      parts.push(
        `[파일: ${name} (${typeLabel})] — 이 모델은 이미지 내용을 분석할 수 없습니다. 파일명만 참고하세요.`
      );
    }
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 웹 검색 (같은 출처의 server.py /api/search 프록시 호출)              */
/* 계약: _workspace/03_websearch-contract.md                            */
/*  - Promise<{query, source, results:[{title,url,snippet}], error}>    */
/*  - 실패 시 throw 하지 않고 error 필드를 채워 강등 유도.              */
/* ------------------------------------------------------------------ */
async function webSearch(query, { signal } = {}) {
  const q = (query || '').trim();
  if (!q) {
    return { query: q, source: null, results: [], error: '검색어가 비어 있습니다.' };
  }
  const url = '/api/search?q=' + encodeURIComponent(q) + '&n=5';
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      return {
        query: q,
        source: null,
        results: [],
        error: `웹 검색 요청이 실패했습니다 (HTTP ${res.status}).`,
      };
    }
    const data = await res.json();
    // 서버가 계약 형식을 지키지만, 방어적으로 필드 보정.
    return {
      query: data && data.query != null ? data.query : q,
      source: data && data.source != null ? data.source : null,
      results: data && Array.isArray(data.results) ? data.results : [],
      error: data && data.error != null ? data.error : null,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { query: q, source: null, results: [], error: '웹 검색이 중단되었습니다.' };
    }
    console.warn('[api] webSearch 실패 — server.py 실행 여부를 확인하세요:', err);
    return {
      query: q,
      source: null,
      results: [],
      error: '웹 검색 서버에 연결할 수 없습니다(server.py 실행 필요).',
    };
  }
}

/* ------------------------------------------------------------------ */
/* F8 — GraphRAG 어댑터 (POST /api/graphrag → 실패/부재/file:// 시 목폴백) */
/* 계약: 03_design_spec §6-4 — 실패·빈결과도 계약 스키마 객체로 반환.   */
/*  { query, mode, answer, entities[], relations[], communities[],       */
/*    sources[], subgraph{nodeIds,edgeIds}, stats{}, pipeline[],         */
/*    error, degraded, aborted }                                         */
/*  throw 금지 — 항상 계약 객체 반환(webSearch graceful-degrade 패턴).  */
/* ------------------------------------------------------------------ */

// 누락 필드를 계약 기본값으로 방어하고 degraded/aborted 플래그를 붙인다.
function normalizeGraphRag(data, meta) {
  const m = meta || {};
  const d = data && typeof data === 'object' ? data : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const sub = d.subgraph && typeof d.subgraph === 'object' ? d.subgraph : {};
  const stats = d.stats && typeof d.stats === 'object' ? d.stats : {};
  return {
    query: d.query != null ? d.query : (m.query != null ? m.query : ''),
    mode: d.mode != null ? d.mode : (m.mode || 'global'),
    answer: typeof d.answer === 'string' ? d.answer : '',
    entities: arr(d.entities),
    relations: arr(d.relations),
    communities: arr(d.communities),
    sources: arr(d.sources),
    subgraph: {
      nodeIds: arr(sub.nodeIds),
      edgeIds: arr(sub.edgeIds),
    },
    stats: {
      nodes: Number(stats.nodes) || 0,
      edges: Number(stats.edges) || 0,
      communities: Number(stats.communities) || 0,
      levels: Number(stats.levels) || 0,
      llmCalls: Number(stats.llmCalls) || 0,
      latencyMs: Number(stats.latencyMs) || 0,
    },
    pipeline: arr(d.pipeline),
    error: d.error != null ? d.error : (m.error != null ? m.error : null),
    degraded: !!m.degraded,
    aborted: !!m.aborted,
  };
}

// 인라인 샘플 그래프 — 서버 없이도 UI가 살아있도록(엔티티12·관계16·커뮤니티3·출처3).
// file:// 및 서버 부재 시 강등 경로에서 사용. GraphView가 이 스키마를 그대로 소비.
function mockGraphRag(query, mode) {
  const m = mode || 'global';
  const entities = [
    { id: 'e1',  name: '예시 대학',          type: 'ORGANIZATION', description: '예시용 종합 연구대학.',                       degree: 12, community: 'c1', rank: 0.97 },
    { id: 'e2',  name: '예시 도시',          type: 'GEO',          description: '예시 대학 본원이 위치한 도시.',               degree: 5,  community: 'c1', rank: 0.61 },
    { id: 'e3',  name: '예시 학부',          type: 'ORGANIZATION', description: '컴퓨터과학 교육·연구를 담당하는 학부.',       degree: 9,  community: 'c1', rank: 0.78 },
    { id: 'e4',  name: 'GraphRAG',          type: 'CONCEPT',      description: '지식그래프 기반 검색증강생성 기법.',          degree: 11, community: 'c2', rank: 0.93 },
    { id: 'e5',  name: '지식그래프',        type: 'CONCEPT',      description: '엔티티와 관계로 구성된 구조화 지식 표현.',     degree: 8,  community: 'c2', rank: 0.72 },
    { id: 'e6',  name: '커뮤니티 요약',     type: 'METHOD',       description: '그래프 커뮤니티 단위로 문맥을 요약하는 단계.', degree: 6,  community: 'c2', rank: 0.66 },
    { id: 'e7',  name: '벡터 검색',         type: 'METHOD',       description: '임베딩 유사도 기반 문서 검색.',               degree: 7,  community: 'c2', rank: 0.64 },
    { id: 'e8',  name: 'LLM',               type: 'TECHNOLOGY',   description: '대규모 언어모델. 맵-리듀스 종합에 사용.',      degree: 10, community: 'c2', rank: 0.85 },
    { id: 'e9',  name: '예시 LLM',           type: 'TECHNOLOGY',   description: '예시용 오픈 LLM.',                            degree: 4,  community: 'c3', rank: 0.55 },
    { id: 'e10', name: 'vLLM',              type: 'TECHNOLOGY',   description: '고성능 LLM 추론 서버.',                       degree: 4,  community: 'c3', rank: 0.52 },
    { id: 'e11', name: '연구실',            type: 'ORGANIZATION', description: 'GraphRAG를 실험하는 연구 그룹.',             degree: 6,  community: 'c1', rank: 0.58 },
    { id: 'e12', name: '코퍼스',            type: 'DATASET',      description: '색인 대상이 되는 문서 집합.',                degree: 8,  community: 'c2', rank: 0.69 },
  ];
  const relations = [
    { id: 'r1',  source: 'e1',  target: 'e2',  description: '위치',           weight: 2.0 },
    { id: 'r2',  source: 'e1',  target: 'e3',  description: '소속 학부',      weight: 3.0 },
    { id: 'r3',  source: 'e3',  target: 'e11', description: '산하 연구실',    weight: 2.5 },
    { id: 'r4',  source: 'e11', target: 'e4',  description: '연구 주제',      weight: 3.2 },
    { id: 'r5',  source: 'e4',  target: 'e5',  description: '기반 개념',      weight: 3.5 },
    { id: 'r6',  source: 'e4',  target: 'e6',  description: '핵심 단계',      weight: 3.0 },
    { id: 'r7',  source: 'e4',  target: 'e7',  description: '대안·보완',      weight: 1.8 },
    { id: 'r8',  source: 'e6',  target: 'e8',  description: 'LLM 호출',       weight: 2.6 },
    { id: 'r9',  source: 'e8',  target: 'e9',  description: '구현 모델',      weight: 2.2 },
    { id: 'r10', source: 'e9',  target: 'e10', description: '서빙',           weight: 2.0 },
    { id: 'r11', source: 'e5',  target: 'e12', description: '색인 대상',      weight: 2.4 },
    { id: 'r12', source: 'e7',  target: 'e12', description: '검색 대상',      weight: 2.1 },
    { id: 'r13', source: 'e12', target: 'e6',  description: '요약 입력',      weight: 1.9 },
    { id: 'r14', source: 'e3',  target: 'e4',  description: '연구 성과',      weight: 1.7 },
    { id: 'r15', source: 'e1',  target: 'e9',  description: '도입 기술',      weight: 1.5 },
    { id: 'r16', source: 'e11', target: 'e12', description: '데이터 구축',    weight: 2.3 },
  ];
  const communities = [
    { id: 'c1', level: 1, title: '기관·조직', summary: '예시 대학과 예시 학부·연구실 등 조직 엔티티가 예시 도시를 중심으로 연결된 커뮤니티.', rank: 0.9, size: 5, entityIds: ['e1', 'e2', 'e3', 'e11'] },
    { id: 'c2', level: 1, title: 'GraphRAG 방법론', summary: 'GraphRAG·지식그래프·커뮤니티 요약·벡터 검색 등 방법·개념이 밀집한 핵심 커뮤니티.', rank: 0.95, size: 6, entityIds: ['e4', 'e5', 'e6', 'e7', 'e8', 'e12'] },
    { id: 'c3', level: 1, title: '모델·인프라', summary: '예시 LLM과 vLLM 등 실행 기술 스택으로 구성된 커뮤니티.', rank: 0.7, size: 2, entityIds: ['e9', 'e10'] },
  ];
  const sources = [
    { n: 1, textUnitId: 't12', documentId: 'doc-graphrag', title: 'GraphRAG 개요',        snippet: 'GraphRAG는 지식그래프를 구축하고 커뮤니티 요약을 활용해 전역적 질의에 답한다.', url: null },
    { n: 2, textUnitId: 't34', documentId: 'doc-univ',     title: '예시 학부 소개',        snippet: '예시 학부 연구실에서 검색증강생성과 지식그래프를 연구한다.',               url: null },
    { n: 3, textUnitId: 't56', documentId: 'doc-infra',    title: '추론 인프라 노트',      snippet: '예시 LLM 모델을 vLLM으로 서빙하여 맵-리듀스 종합 단계를 수행한다.',       url: null },
  ];

  const answerByMode = {
    global:
      '**전역(Global) 요약** — 코퍼스의 핵심 주제는 **GraphRAG 방법론**[1]입니다. ' +
      '예시 대학 예시 학부의 연구실[2]이 **지식그래프**와 **커뮤니티 요약**을 중심으로 검색증강생성을 연구하며, ' +
      '실행은 **예시 LLM**을 **vLLM**으로 서빙해 수행합니다[3]. 세 개의 커뮤니티(기관·방법론·인프라)로 주제가 나뉩니다.',
    local:
      '**지역(Local) 응답** — 질의 "' + (query || '') + '"에 가장 가까운 엔티티는 **GraphRAG**[1]와 인접한 ' +
      '**지식그래프·커뮤니티 요약** 노드입니다. 이들은 예시 학부 연구실[2]과 직접 연결됩니다.',
    drift:
      '**DRIFT 응답** — 지역 단서에서 시작해 전역 커뮤니티로 확장했습니다. ' +
      'GraphRAG[1]의 핵심 단계(맵-리듀스)가 LLM 호출[3]로 이어지는 경로가 확인됩니다.',
    basic:
      '**기본(Basic) 응답** — 벡터 검색으로 회수한 문맥 기준: GraphRAG는 지식그래프 기반 RAG 기법입니다[1]. ' +
      '예시 대학 예시 학부에서 연구됩니다[2].',
  };

  return {
    query: query || '',
    mode: m,
    answer: answerByMode[m] || answerByMode.global,
    entities,
    relations,
    communities,
    sources,
    subgraph: { nodeIds: ['e4', 'e5', 'e6', 'e8', 'e12'], edgeIds: ['r5', 'r6', 'r8', 'r13'] },
    stats: { nodes: entities.length, edges: relations.length, communities: communities.length, levels: 1, llmCalls: 9, latencyMs: 4200 },
    pipeline: [
      { step: 'route',    label: '쿼리 라우팅',   status: 'done', ms: 28 },
      { step: 'retrieve', label: '그래프 검색',   status: 'done', ms: 214 },
      { step: 'map',      label: '커뮤니티 맵',   status: 'done', ms: 3580 },
      { step: 'reduce',   label: '종합',          status: 'done', ms: 372 },
    ],
    error: null,
  };
}

async function graphRagQuery(query, { mode = 'global', index = 'default', params = {}, model, signal } = {}) {
  const q = (query || '').trim();
  const meta = { query: q, mode };
  // file:// 에서는 fetch가 CORS/스킴 제약으로 실패 → 즉시 목폴백.
  const isFileProto =
    typeof location !== 'undefined' && location.protocol === 'file:';
  if (isFileProto) {
    return normalizeGraphRag(mockGraphRag(q, mode), { ...meta, degraded: true });
  }

  const body = {
    query: q,
    mode,
    index,
    params: { includeSubgraph: true, stream: false, ...params },
    model: model || DEFAULT_CONFIG.model,
  };
  try {
    const res = await fetch('/api/graphrag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return normalizeGraphRag(data, { ...meta, degraded: false });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return normalizeGraphRag(null, { ...meta, aborted: true, error: 'GraphRAG 질의가 중단되었습니다.' });
    }
    // 서버 부재/501/네트워크 등 → 모의 응답으로 강등(계약 동일 스키마).
    console.warn('[api] graphRagQuery 실패 — 샘플 그래프로 강등합니다:', e);
    return normalizeGraphRag(mockGraphRag(q, mode), { ...meta, degraded: true });
  }
}

/* ------------------------------------------------------------------ */
/* 전역 노출 (ES 모듈 미사용 — file:// 더블클릭 실행 지원)              */
/* app.js는 window.ChatAPI 에서 이 함수들을 가져다 쓴다.                */
/* ------------------------------------------------------------------ */
// _createThinkSplitter: v24 커널(llmlab.js)이 <think> 파서를 재사용하도록 노출.
window.ChatAPI = { DEFAULT_CONFIG, sendMessage, buildFileContext, webSearch, graphRagQuery, _createThinkSplitter: createThinkSplitter };

})();
