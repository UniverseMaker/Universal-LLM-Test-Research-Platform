# DB 연결 형식 가이드 (v1)

> 이 문서는 **범용 LLM 테스트·연구 플랫폼(LLM Lab)**에 데이터베이스 연결(DB Connection)을 등록하기 위한 **연결 JSON 표준 형식**을 정의합니다.
> 사람이 손으로 작성하거나, **다른 AI 세션이 이 형식에 맞춰 자동으로 출력**한 뒤 붙여넣어 **한 번에 등록**할 수 있도록 스키마·규칙·예시·프롬프트·빈 템플릿을 제공합니다.
> 플랫폼의 "가져오기(Import)"·"분석하여 바로 등록"은 이 형식을 그대로 받아들이며, "내보내기(Export)"도 이 형식으로 출력합니다.
> (정본 로직: `db.js` — `DB_TYPES`, `DEFAULT_PORT`, `fromUserJSON`, `toUserJSON`, `validate`, `parse`.)

---

## 1. 목적과 사용처

- **플랫폼 등록:** 이 JSON 한 개(단일) 또는 여러 개(배열·묶음)를 붙여넣기/파일 업로드하면 DB 연결이 생성됩니다.
- **AI로 생성:** 접속 정보를 아는 AI 세션에 "이 DB 접속 정보를 아래 형식의 연결 JSON으로 뽑아줘"라고 요청하면, 그대로 붙여넣어 등록할 수 있습니다(7장 프롬프트 템플릿).
- **강등 규약:** 백엔드(PHP `/api/db`)가 없거나 드라이버 미탑재면 앱이 죽지 않고 `provider:"mock"`으로 강등되어 등록·표시는 정상 동작합니다(실쿼리만 대기).
- **보안:** `connection.password`는 민감정보입니다. **내보내기 시 기본 `"<REDACTED>"`로 마스킹**됩니다(공유용 export 권장). 로컬 저장은 평문입니다.

---

## 2. 최상위 스키마 (정본 봉투)

| 필드 | 타입 | 필수 | 설명 |
|------|------|:---:|------|
| `kind` | string | 권장 | 항상 `"db-connection"`. (단일 식별용. 없어도 `type`+`connection`으로 단일 인식) |
| `schemaVersion` | string | 선택 | 형식 버전. 없으면 `"1"`로 간주 |
| `label` | string | ★ | 사람이 읽는 연결 이름 (예: `"연구 코퍼스 (pgvector)"`) — **비면 등록 오류** |
| `type` | string | ★ | `sqlite` / `mysql` / `postgres` / `pgvector` / `neo4j` 중 하나 |
| `network` | string | 선택 | 접근 범위 메모 (예: `"local"`, `"external"`, `"intranet"`) |
| `connection` | object | ★ | 접속 정보. type별 구조는 3장 참조 |
| `options` | object | 선택 | 실행 옵션(readonly·타임아웃·행 상한). 5장 참조 |
| `vector` | object | pgvector면 ★ | pgvector 유사도 검색 매핑. 4-1장 참조 |
| `graph` | object | neo4j 권장 | Neo4j 그래프 라벨/관계 매핑. 4-2장 참조 |
| `notes` | string[] | 선택 | 주의사항·특이점 목록 |
| `id` | string | 선택 | 안정 식별자(생략 시 자동 생성). Import 시 중복 판단은 `label` 기준 |

> `type`이 목록에 없으면 `fromUserJSON`이 **`sqlite`로 폴백**하지만, `validate`는 오류로 잡습니다. 반드시 5종 중 하나로 지정하세요.

---

## 3. type별 `connection` 필드

### 3-1. type별 필수/선택 표

| type | 필수 필드 | 선택 필드 | 기본 포트 |
|------|-----------|-----------|:--------:|
| `sqlite` | `db_path` | — | — |
| `mysql` | `host` | `port`, `database`, `user`, `password`, `tls` | **3306** |
| `postgres` | `host` | `port`, `database`, `user`, `password`, `tls` | **5432** |
| `pgvector` | `host` (+ `vector` 서브객체) | `port`, `database`, `user`, `password`, `tls` | **5432** |
| `neo4j` | `host` **또는** `uri` | `port`, `database`, `user`, `password`, `tls`, `uri` | **7473** |

> 포트를 생략하면 `fromUserJSON`이 위 기본값을 채웁니다(`sqlite`는 포트 없음).

### 3-2. `connection` 필드 상세

| 필드 | 타입 | 적용 type | 설명 |
|------|------|-----------|------|
| `db_path` | string | sqlite | 파일 경로 또는 `":memory:"`. sqlite **필수** |
| `host` | string | mysql/postgres/pgvector/neo4j | 호스트/IP. sqlite 외 필수(neo4j는 uri로 대체 가능) |
| `port` | number | 위 4종 | 미지정 시 기본 포트 자동 |
| `database` | string | mysql/postgres/pgvector/neo4j | DB(스키마) 이름. 비면 경고 |
| `user` | string | 위 4종 | 접속 계정(**읽기전용 권장**). 비면 경고 |
| `password` | string | 위 4종 | 비밀번호. export 시 `"<REDACTED>"` |
| `uri` | string | neo4j | HTTP 엔드포인트(예: `"https://host:7473"`). host 대체 |
| `tls` | object | 위 4종 | `{ "enabled": true, "mode": "require", "verify": false }` 등 |

---

## 4. 서브객체 상세

### 4-1. `vector` (pgvector 전용 · **필수**)

pgvector 유사도 검색을 위해 DB 테이블/컬럼을 매핑합니다.

| 필드 | 타입 | 필수 | 설명 |
|------|------|:---:|------|
| `table` | string | ★ | 임베딩이 저장된 테이블명 |
| `embedding_column` | string | ★ | 벡터 컬럼명 |
| `id_column` | string | 선택 | 기본 `"id"` |
| `text_column` | string | 선택 | 기본 `"text"` (원문 컬럼) |
| `metadata_columns` | string[] | 선택 | 함께 조회할 메타 컬럼(예: `["doc_id","title","loc"]`) |
| `dim` | number | 권장 | 임베딩 차원(비면 경고). 예: `384`, `768`, `1536` |
| `metric` | string | 선택 | `"cosine"`(기본) / `"l2"` / `"ip"` |
| `index` | string | 선택 | `"hnsw"`(기본) / `"ivfflat"` / `"none"` |

### 4-2. `graph` (neo4j 권장)

GraphRAG 조회 시 라벨/관계 이름을 매핑합니다(없어도 등록은 되나 그래프 조회 매핑에 사용).

| 필드 | 타입 | 설명 |
|------|------|------|
| `database` | string | 그래프 DB명(기본 `"neo4j"`) |
| `entity_label` | string | 엔터티 노드 라벨(기본 `"Entity"`) |
| `community_label` | string | 커뮤니티 노드 라벨(기본 `"Community"`) |
| `rel_types` | string[] | 관계 타입 목록(예: `["RELATED","WORKS_WITH"]`) |
| `name_property` | string | 이름 속성(기본 `"name"`) |
| `summary_property` | string | 요약 속성(기본 `"summary"`) |

---

## 5. `options` · `notes` · 비밀 마스킹

### 5-1. `options`

| 필드 | 타입 | 기본 | 설명 |
|------|------|:---:|------|
| `readonly` | boolean | **true** | 읽기전용. `false`면 쓰기 허용 — **경고 발생**(최소권한 계정 권장) |
| `connect_timeout_ms` | number | 10000 | 연결 타임아웃(ms) |
| `statement_timeout_ms` | number | 15000 | 문장 타임아웃(ms) |
| `row_cap` | number | 200 | 반환 최대 행 수 |

> `readonly`는 **명시적으로 `false`일 때만** 쓰기 허용으로 간주됩니다(그 외 값·생략은 모두 true). 안전을 위해 읽기전용 계정을 권장합니다.

### 5-2. `notes`
문자열 배열. 접근 제약·드라이버 요건·주의사항을 자유롭게 기록합니다. (편집기에서는 줄바꿈 구분으로 표시)

### 5-3. 비밀번호 마스킹 규칙
- **로컬 저장:** 평문(`localStorage`).
- **Export(내보내기):** 기본 `connection.password` → `"<REDACTED>"`. (키 포함 옵션을 켜야 실제 값 포함)
- **가이드/공유 JSON:** 실제 비밀번호 대신 `"YOUR_PASSWORD"` 같은 placeholder를 사용하세요.

---

## 6. type별 완성 예시 5종

> 아래 예시는 실제 시크릿 없이 placeholder(`db.example.com` · `YOUR_PASSWORD`)만 사용합니다. 그대로 복사해 host/user/password/table 등만 바꿔 등록하세요.

### 6-1. SQLite (무설치 · 즉시 실동작)
```json
{
  "schemaVersion": "1",
  "kind": "db-connection",
  "label": "SQLite 데모 (무설치)",
  "type": "sqlite",
  "network": "local",
  "connection": { "db_path": "_data/demo.sqlite" },
  "options": { "readonly": true, "row_cap": 200 },
  "notes": ["PDO_sqlite는 대부분 호스팅에 탑재 — 즉시 실 DB 쿼리 시연"]
}
```

### 6-2. MySQL
```json
{
  "schemaVersion": "1",
  "kind": "db-connection",
  "label": "MySQL 앱 DB (읽기전용)",
  "type": "mysql",
  "network": "local",
  "connection": {
    "host": "db.example.com",
    "port": 3306,
    "database": "app_db",
    "user": "app_ro",
    "password": "YOUR_PASSWORD"
  },
  "options": { "readonly": true, "connect_timeout_ms": 10000, "row_cap": 200 },
  "notes": ["읽기전용 계정 권장"]
}
```

### 6-3. PostgreSQL
```json
{
  "schemaVersion": "1",
  "kind": "db-connection",
  "label": "PostgreSQL 분석 DB",
  "type": "postgres",
  "network": "external",
  "connection": {
    "host": "db.example.com",
    "port": 5432,
    "database": "analytics",
    "user": "analytics_ro",
    "password": "YOUR_PASSWORD",
    "tls": { "enabled": true, "mode": "require", "verify": false }
  },
  "options": { "readonly": true, "statement_timeout_ms": 15000, "row_cap": 500 }
}
```

### 6-4. pgvector (PostgreSQL + 벡터 검색)
```json
{
  "schemaVersion": "1",
  "kind": "db-connection",
  "label": "연구 코퍼스 (pgvector)",
  "type": "pgvector",
  "network": "external",
  "connection": {
    "host": "db.example.com",
    "port": 5432,
    "database": "ragdb",
    "user": "rag_ro",
    "password": "YOUR_PASSWORD",
    "tls": { "enabled": true, "mode": "require", "verify": false }
  },
  "options": { "readonly": true, "row_cap": 200 },
  "vector": {
    "table": "chunks",
    "embedding_column": "embedding",
    "id_column": "id",
    "text_column": "text",
    "metadata_columns": ["doc_id", "title", "loc"],
    "dim": 384,
    "metric": "cosine",
    "index": "hnsw"
  },
  "notes": ["DB측: CREATE EXTENSION vector; + 벡터 테이블 사전 준비"]
}
```

### 6-5. Neo4j (GraphRAG · HTTP API)
```json
{
  "schemaVersion": "1",
  "kind": "db-connection",
  "label": "GraphRAG (Neo4j)",
  "type": "neo4j",
  "network": "external",
  "connection": {
    "host": "graph.example.com",
    "port": 7473,
    "database": "neo4j",
    "user": "neo4j",
    "password": "YOUR_PASSWORD",
    "uri": "https://graph.example.com:7473",
    "tls": { "enabled": true, "verify": false }
  },
  "graph": {
    "database": "neo4j",
    "entity_label": "Entity",
    "community_label": "Community",
    "rel_types": ["RELATED", "WORKS_WITH"],
    "name_property": "name",
    "summary_property": "summary"
  },
  "options": { "readonly": true },
  "notes": ["Bolt 확장 불요 — Transactional Cypher HTTP API(/db/{db}/tx/commit) 사용", "7474=HTTP, 7473=HTTPS"]
}
```

---

## 7. 여러 연결 한 번에 (묶음 · Import/Export 형식)

플랫폼 전체 내보내기와 "한 번에 등록"은 배열 래핑 묶음을 사용합니다:

```json
{
  "schemaVersion": "1",
  "type": "llm-lab-db-connections",
  "exportedAt": "2026-09-07T00:00:00Z",
  "connections": [
    { "kind": "db-connection", "label": "SQLite 데모", "type": "sqlite", "connection": { "db_path": "_data/demo.sqlite" } },
    { "kind": "db-connection", "label": "MySQL 앱 DB", "type": "mysql", "connection": { "host": "db.example.com", "database": "app_db", "user": "app_ro", "password": "YOUR_PASSWORD" } }
  ]
}
```

- **단일 연결 객체**(6장 형태)와 **묶음 객체**(`connections[]`)와 **순수 배열**(`[ {...}, {...} ]`) 모두 인식.
- "분석하여 바로 등록"은 유효한 연결을 **모두** 즉시 추가하고, 오류가 있는 항목만 건너뛰고 리포트합니다. `label` 중복은 이름 뒤에 `(2)`를 붙여 추가합니다.

---

## 8. AI에게 줄 프롬프트 (복사용 템플릿)

> 아래 전체를 임의의 AI에 붙여넣고, DB 접속 정보를 알려주면 올바른 연결 JSON을 생성해 줍니다. 결과를 그대로 플랫폼의 "JSON 붙여넣기 → 분석하여 바로 등록"에 붙이면 됩니다.

```
너는 "LLM Lab" 플랫폼의 DB 연결 JSON 생성기다. 아래 규칙과 스키마를 지켜, 내가 준 접속 정보를 연결 JSON으로만 출력하라.

[출력 규칙]
1. 순수 JSON 하나만 출력한다. 설명 문장·코드펜스·주석 없이 JSON 본문만.
2. 최상위 봉투: { "schemaVersion":"1", "kind":"db-connection", "label":<필수, 사람이 읽는 이름>, "type":<sqlite|mysql|postgres|pgvector|neo4j>, "network":<선택>, "connection":{...}, "options":{...}, ... }
3. type별 connection 필수:
   - sqlite   → { "db_path": "..." }
   - mysql    → { "host":"...", "port":3306, "database":"...", "user":"...", "password":"..." }
   - postgres → { "host":"...", "port":5432, "database":"...", "user":"...", "password":"..." }
   - pgvector → postgres와 동일 + 최상위에 "vector":{ "table":<필수>, "embedding_column":<필수>, "id_column":"id", "text_column":"text", "metadata_columns":[...], "dim":<정수>, "metric":"cosine", "index":"hnsw" }
   - neo4j    → { "host" 또는 "uri" 필수, "port":7473, "database":"neo4j", "user":"...", "password":"..." } + 최상위에 "graph":{ "entity_label":"Entity", "community_label":"Community", "rel_types":[...], "name_property":"name", "summary_property":"summary" }
4. options 기본: { "readonly": true, "connect_timeout_ms":10000, "statement_timeout_ms":15000, "row_cap":200 }. 쓰기가 꼭 필요할 때만 readonly:false.
5. 접근 제약(로컬/인트라넷/공개)은 "network"와 "notes"[]에 적는다.
6. 비밀번호를 모르면 "password":"YOUR_PASSWORD" 로 둔다(내가 나중에 채운다).
7. type을 확신할 수 없으면 나에게 되묻지 말고 가장 그럴듯한 하나를 고르고 notes에 근거를 적는다.

[내 접속 정보]
<여기에 host/port/DB종류/계정/테이블 등 아는 대로 적기>
```

---

## 9. type별 빈 템플릿 (복사용)

**sqlite**
```json
{ "schemaVersion":"1", "kind":"db-connection", "label":"", "type":"sqlite", "network":"local", "connection":{ "db_path":"" }, "options":{ "readonly":true, "row_cap":200 }, "notes":[] }
```
**mysql / postgres** (type만 교체)
```json
{ "schemaVersion":"1", "kind":"db-connection", "label":"", "type":"mysql", "network":"", "connection":{ "host":"", "port":3306, "database":"", "user":"", "password":"YOUR_PASSWORD" }, "options":{ "readonly":true, "connect_timeout_ms":10000, "row_cap":200 }, "notes":[] }
```
**pgvector**
```json
{ "schemaVersion":"1", "kind":"db-connection", "label":"", "type":"pgvector", "network":"", "connection":{ "host":"", "port":5432, "database":"", "user":"", "password":"YOUR_PASSWORD" }, "options":{ "readonly":true, "row_cap":200 }, "vector":{ "table":"", "embedding_column":"", "id_column":"id", "text_column":"text", "metadata_columns":[], "dim":384, "metric":"cosine", "index":"hnsw" }, "notes":[] }
```
**neo4j**
```json
{ "schemaVersion":"1", "kind":"db-connection", "label":"", "type":"neo4j", "network":"", "connection":{ "host":"", "port":7473, "database":"neo4j", "user":"", "password":"YOUR_PASSWORD", "uri":"" }, "graph":{ "entity_label":"Entity", "community_label":"Community", "rel_types":[], "name_property":"name", "summary_property":"summary" }, "options":{ "readonly":true }, "notes":[] }
```

---

## 10. 검증 체크리스트 (등록 전에 확인)

- [ ] `label`이 비어 있지 않은가 (필수)
- [ ] `type`이 `sqlite|mysql|postgres|pgvector|neo4j` 중 하나인가
- [ ] `sqlite`면 `connection.db_path`가 있는가
- [ ] `mysql/postgres/pgvector`면 `connection.host`가 있는가 (없으면 오류; database·user 비면 경고)
- [ ] `neo4j`면 `connection.host` 또는 `connection.uri` 중 하나가 있는가
- [ ] `pgvector`면 `vector.table`·`vector.embedding_column`이 있는가 (dim 비면 경고)
- [ ] `options.readonly`가 `false`면 의도한 것인가 (쓰기 허용 경고)
- [ ] 공유용이면 `connection.password`를 placeholder로 두었는가

---

*형식 버전: v1 · 이 문서는 플랫폼의 DB 연결 Import/Export 및 `db.js`(validate/fromUserJSON/toUserJSON)와 1:1로 대응합니다. 형식이 바뀌면 `schemaVersion`을 올리고 이 문서를 갱신합니다.*
