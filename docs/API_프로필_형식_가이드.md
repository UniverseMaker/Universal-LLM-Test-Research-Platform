# LLM API 프로필 형식 가이드 (v1)

> 이 문서는 **범용 LLM 챗봇 테스트 플랫폼**에 연결(Connection)을 등록하기 위한 **API 프로필 JSON 표준 형식**을 정의합니다.
> 사람이 손으로 작성하거나, **다른 AI 세션이 이 형식에 맞춰 자동으로 출력**할 수 있도록 스키마·규칙·예시·템플릿을 제공합니다.
> 플랫폼의 "가져오기(Import)"는 이 형식을 그대로 받아들이며, "내보내기(Export)"도 이 형식으로 출력합니다.

---

## 1. 목적과 사용처

- **플랫폼 Import:** 이 JSON 한 개(또는 배열)를 붙여넣기/파일 업로드하면 연결 프로필이 생성됩니다.
- **연결 필수값:** `base_url`, `model`, `auth.api_key` (이 셋만 있으면 채팅/테스트 가능).
- **나머지 필드:** 문서화·표시·진단용 메타데이터(연결 자체에는 불필요하지만 연구/운영에 유용).
- **타 세션 출력용:** 새 모델 서버를 띄운 뒤 "이 서버 접속 정보를 프로필 JSON으로 뽑아줘"라고 하면, 아래 스키마대로 출력하면 됩니다.

---

## 2. 최상위 스키마

| 필드 | 타입 | 필수 | 설명 |
|------|------|:---:|------|
| `service` | string | ★ | 사람이 읽는 연결 이름/라벨 (예: `"Gemma 4 26B vLLM (OpenAI-compatible)"`) |
| `base_url` | string(URL) | ★ | OpenAI 호환 베이스 URL. **끝에 `/v1` 포함** 권장 (예: `http://your-host.example.com:8000/v1`) |
| `model` | string | ★ | 서버에 전송할 정식 모델 id (예: `your-org/your-model-id`) |
| `auth` | object | ★ | 인증 정보. 아래 `auth` 스키마 참조 |
| `host` | string | 권장 | 호스트/IP (base_url에서 유도 가능하나 명시 권장) |
| `port` | number | 권장 | 포트 (예: `8002`) |
| `network` | string | 권장 | 접근 범위 메모 (예: `"intranet-only (LAN)"`, `"public"`, `"localhost"`) |
| `model_note` | string | 선택 | 모델 부연 설명(양자화·베이스모델 등) |
| `endpoints` | object | 선택 | 주요 엔드포인트 전체 URL. 아래 참조 |
| `server` | object | 선택 | 서버/인프라 메타데이터(진단·운영용). 아래 참조 |
| `notes` | string[] | 선택 | 주의사항·특이점 목록 |
| `examples` | object | 선택 | 호출 예시(curl/python 등) |
| `params` | object | 선택 | 기본 생성 파라미터(플랫폼 확장 필드). 3장 참조 |
| `schemaVersion` | string | 선택 | 이 형식의 버전(예: `"1"`). 없으면 `"1"`로 간주 |

### 2-1. `auth` 스키마
| 필드 | 타입 | 필수 | 설명 |
|------|------|:---:|------|
| `type` | string | ★ | `"bearer"` (기본) / `"none"` / `"custom"` |
| `api_key` | string | type=bearer면 ★ | API 키. `type:"none"`이면 생략 |
| `header` | string | 선택 | 헤더 표기 예: `"Authorization: Bearer <api_key>"`. `type:"custom"`이면 실제 헤더명 지정 |

> **보안 주의:** `api_key`는 민감정보입니다. 내보내기 시 **키 제외 옵션**을 지원하며(플레이스홀더 `"<REDACTED>"` 로 치환), 공유용 export는 키를 빼는 것을 권장합니다.

### 2-2. `endpoints` 스키마 (선택 — 없으면 base_url로 자동 유도)
| 필드 | 타입 | 설명 |
|------|------|------|
| `chat_completions` | string | 보통 `{base_url}/chat/completions` |
| `completions` | string | `{base_url}/completions` |
| `models` | string | `{base_url}/models` (헬스체크·모델 목록용) |
| `embeddings` | string | (있으면) `{base_url}/embeddings` — RAG 임베딩용 |

### 2-3. `server` 스키마 (선택 — 순수 메타데이터, 연결에 미사용)
`ssh`, `gpu`, `vram_used_mib`, `vram_total_mib`, `runtime`, `service_unit`, `api_key_file` 등 자유 형식. 플랫폼은 "서버 정보" 패널에 그대로 표시합니다.

---

## 3. 플랫폼 확장 필드 (선택) — `params`

서버마다 컨텍스트 윈도·기본값이 다르므로, 프로필에 기본 생성 파라미터를 함께 저장할 수 있습니다. 모두 선택이며 UI에서 조정 가능합니다.

```json
"params": {
  "context_window": 131072,      // 모델 최대 컨텍스트(n_ctx / max_model_len)
  "max_tokens": 1024,            // 출력 상한
  "temperature": 0.7,
  "top_p": 1.0,
  "top_k": 0,
  "min_p": 0.0,
  "repetition_penalty": 1.0,
  "presence_penalty": 0.0,
  "frequency_penalty": 0.0,
  "stop": [],
  "seed": null,
  "stream": true,
  "timeout_ms": 120000,
  "extra_body": {}               // vLLM 등 확장 파라미터 격리(chat_template_kwargs, guided_* 등)
}
```

---

## 4. 필드 매핑 (프로필 JSON → 플랫폼 내부)

| 프로필 JSON | 플랫폼 내부 사용 |
|-------------|------------------|
| `service` | 연결 이름(라벨) |
| `base_url` | 요청 baseURL |
| `model` | 요청 body.model |
| `auth.api_key` | `Authorization: Bearer <api_key>` 헤더 |
| `auth.type:"none"` | 인증 헤더 미전송 |
| `endpoints.models` | 헬스체크/모델 목록 조회 |
| `params.*` | 생성 파라미터 기본값 |
| `server`, `notes`, `network`, `model_note`, `examples` | 표시/진단용 메타데이터 |

---

## 5. 완전한 예시 (사용자 제공 Gemma 프로필)

```json
{
  "schemaVersion": "1",
  "service": "Gemma 4 26B vLLM (OpenAI-compatible)",
  "network": "intranet-only (LAN)",
  "base_url": "http://your-host.example.com:8000/v1",
  "host": "your-host.example.com",
  "port": 8002,
  "model": "your-org/your-model-id",
  "model_note": "Google Gemma 4 26B-A4B (NVFP4 재양자화, vLLM용)",
  "auth": {
    "type": "bearer",
    "header": "Authorization: Bearer <api_key>",
    "api_key": "YOUR_API_KEY"
  },
  "endpoints": {
    "chat_completions": "http://your-host.example.com:8000/v1/chat/completions",
    "completions": "http://your-host.example.com:8000/v1/completions",
    "models": "http://your-host.example.com:8000/v1/models"
  },
  "server": {
    "ssh": "user@your-host.example.com",
    "gpu": "NVIDIA RTX 5090 (32GB)",
    "vram_used_mib": 28792,
    "vram_total_mib": 32607,
    "runtime": "vLLM 0.27.1 (torch cu129)",
    "service_unit": "systemd --user vllm-gemma.service (linger, 재부팅 자동기동)",
    "api_key_file": "~/vllm-gemma/api_key.txt"
  },
  "notes": [
    "127.0.0.1 로는 접근 불가 — 서버 안에서도 your-host.example.com:8000 사용",
    "API 키 없으면 401",
    "공개 인터넷 미노출(NAT 뒤, 인트라넷 전용)"
  ],
  "examples": {
    "curl": "curl http://your-host.example.com:8000/v1/chat/completions -H \"Authorization: Bearer YOUR_API_KEY\" -H \"Content-Type: application/json\" -d '{\"model\":\"your-org/your-model-id\",\"messages\":[{\"role\":\"user\",\"content\":\"안녕하세요\"}],\"max_tokens\":256}'",
    "python": "from openai import OpenAI; client = OpenAI(base_url='http://your-host.example.com:8000/v1', api_key='YOUR_API_KEY'); print(client.chat.completions.create(model='your-org/your-model-id', messages=[{'role':'user','content':'안녕하세요'}]).choices[0].message.content)"
  }
}
```

---

## 6. 여러 프로필 한 번에 (Import/Export 묶음 형식)

플랫폼의 전체 내보내기는 배열을 래핑한 형태를 사용합니다:

```json
{
  "schemaVersion": "1",
  "type": "llm-lab-profiles",
  "exportedAt": "2026-08-26T09:00:00Z",
  "profiles": [ { /* 위 프로필 객체 */ }, { /* ... */ } ]
}
```

- **단일 프로필 객체**(5장 형태)와 **묶음 객체**(`profiles[]`) 둘 다 Import 허용.
- Import 시 `service` 중복이면 "덮어쓰기 / 새로 추가(이름 뒤 (2)) / 건너뛰기" 선택.

---

## 7. 다른 AI 세션이 이 형식을 출력할 때 규칙 (프롬프트 가이드)

새 모델 서버를 띄운 세션에서 접속 정보를 뽑을 때, 아래를 지켜 **위 5장과 동일한 키 구조의 JSON만** 출력하세요:

1. **필수 3종 반드시 포함:** `base_url`(끝에 `/v1`), `model`(서버 `/v1/models`의 정식 id), `auth.api_key`.
2. `base_url`은 **실제 클라이언트가 접근 가능한 주소**로. (localhost 전용/인트라넷 전용이면 `network`·`notes`에 명시. 예: "127.0.0.1 불가, LAN IP 사용".)
3. `endpoints`는 `base_url` 기준으로 채우기(`/chat/completions`, `/completions`, `/models`, 가능하면 `/embeddings`).
4. `server` 메타데이터(GPU·VRAM·runtime·systemd 유닛 등)는 아는 만큼 채우기(연구/운영 재현에 유용).
5. `examples.curl`·`examples.python`은 **실제 동작하는** 최소 예시로.
6. 컨텍스트 윈도가 특수하면 `params.context_window`에 명시.
7. **출력은 순수 JSON 하나**(주석·설명 텍스트 없이). 코드펜스 ```json 안에 담아도 됨.
8. 공유용이면 `auth.api_key`를 `"<REDACTED>"`로 두고, 실제 키는 별도 안전 채널로 전달.

### 7-1. 빈 템플릿 (복사용)
```json
{
  "schemaVersion": "1",
  "service": "",
  "network": "",
  "base_url": "http://HOST:PORT/v1",
  "host": "",
  "port": 0,
  "model": "",
  "model_note": "",
  "auth": { "type": "bearer", "header": "Authorization: Bearer <api_key>", "api_key": "" },
  "endpoints": {
    "chat_completions": "http://HOST:PORT/v1/chat/completions",
    "completions": "http://HOST:PORT/v1/completions",
    "models": "http://HOST:PORT/v1/models"
  },
  "server": { "ssh": "", "gpu": "", "vram_used_mib": 0, "vram_total_mib": 0, "runtime": "", "service_unit": "", "api_key_file": "" },
  "notes": [],
  "examples": { "curl": "", "python": "" },
  "params": { "context_window": null, "max_tokens": 1024, "temperature": 0.7, "stream": true, "timeout_ms": 120000, "extra_body": {} }
}
```

---

## 8. 검증 체크리스트 (Import 전에 확인)

- [ ] `base_url`이 유효한 URL이고 `/v1`로 끝나는가
- [ ] `model`이 서버 `/v1/models` 목록의 id와 정확히 일치하는가
- [ ] `auth.type`이 `bearer`면 `api_key`가 있는가
- [ ] 접근 제약(localhost/LAN/공개)이 `network`·`notes`에 적혀 있는가
- [ ] (선택) `examples.curl`이 실제로 200을 반환하는가

---

*형식 버전: v1 · 이 문서는 플랫폼 Import/Export와 1:1로 대응합니다. 형식이 바뀌면 `schemaVersion`을 올리고 이 문서를 갱신합니다.*
