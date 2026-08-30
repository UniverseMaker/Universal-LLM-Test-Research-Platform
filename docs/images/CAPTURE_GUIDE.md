# Screenshot capture guide / 스크린샷 캡처 가이드

These images are shipped as **illustrative SVG mockups** in this folder. To replace any with a **real screenshot**, save a PNG/SVG over the matching filename below (the README and case study will pick it up automatically).

실제 모델이 **연결된 상태**로 아래 화면들을 캡처해, 표시된 **정확한 파일명**으로 이 폴더에 저장하세요. README와 케이스 스터디가 이 경로를 참조합니다.

> Tip: use a wide window (≈1440px), dark theme, and hide any real API keys before capturing.
> 팁: 넓은 창(≈1440px)·다크 테마로, 실제 API 키가 보이지 않게 가린 뒤 캡처하세요.

| Filename | What to show / 무엇을 담나 |
|---|---|
| `hero-chat.png` | **Main hero** — Chat with a connected model mid‑conversation; a completed answer visible, model badge under the message. / 연결된 모델과의 실제 대화(답변 완료, 메시지별 모델 뱃지). |
| `connections.png` | **Connections** panel — one or more connection profiles listed, the New/Edit dialog open showing the profile form (mask the key). / 연결 목록 + 새 연결/편집 대화상자(키 마스킹). |
| `inspector.png` | **Request inspector** open on a chat message — Request tab showing the real URL, model, and `messages` body; or the Timing tab (TTFT, tok/s). / 특정 메시지 인스펙터(요청 URL·모델·messages 본문 또는 타이밍). |
| `rag.png` | **RAG Lab** — a hybrid retrieval run with BM25 + dense + RRF results visible (ranked list / scores). / 하이브리드 검색 실행(BM25+Dense+RRF 결과·순위). |
| `chain.png` | **Chain** — a preset loaded (e.g. Chain‑of‑Verification or classify‑route) with the step list and a run trace. / 프리셋 로드 + 스텝 목록 + 실행 트레이스. |
| `agent.png` | **Agent / Tools** — a ReAct run showing Thought → Action → Observation steps. / ReAct 실행(Thought→Action→Observation). |
| `eval.png` | **Eval / Bench** — an A/B comparison of two models/prompts side by side (with diff or judge verdict). / A/B 비교(diff 또는 judge 판정). |
| `simulate.png` | *(optional)* **Simulate** — a model‑vs‑model conversation in progress. / 모델 대 모델 대화. |
| `graphrag.png` | *(optional)* **GraphRAG viewer** — the knowledge‑graph / community view. / GraphRAG 지식그래프·커뮤니티 뷰. |

After adding the images, they will render automatically in `README.md` and `docs/CASE_STUDY.html`.
이미지를 추가하면 `README.md`와 `docs/CASE_STUDY.html`에서 자동으로 표시됩니다.
