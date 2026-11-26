# StudyMate — RAG 챗봇 기반 AI 맞춤형 학습 지원 시스템

내 학습 자료를 **근거로 질문에 답하고**, 자료에서 **퀴즈를 만들어 채점**하고, 풀이 기록으로 **약한 개념을 찾아 복습 순서를 추천**하는 학습 도우미입니다. (인공지능 응용 시스템 개발 종합 프로젝트)

- **학습 챗봇(RAG)**: 답변 + 근거 항목(원문 보기) + 신뢰도, 자료에 없는 질문은 지어내지 않고 거절
- **퀴즈**: 객관식·빈칸·O/X 자동 생성(정답 비노출), 채점·해설, 약점 복습 모드
- **내 학습현황**: 단원별 정답률, 약점 개념, 라이트너 복습 주기, 오늘의 학습 추천
- **자료함**: 내 노트(텍스트/.md/.txt)를 추가하면 곧바로 검색·퀴즈에 반영
- **운영 지표**: 질문 수, 근거 있는 답변 비율, 응답 시간, 단원별 질문·정답률
- **환각 방지**: 신뢰도 임계값 → LLM "근거 부족" 응답 → 숫자·인용·자료 일치도 검사 → 실패 시 원문 발췌

## 실행

필요한 것: **Node.js 24 이상** (외부 npm 패키지 없음).

```bash
npm start
```

브라우저에서 <http://127.0.0.1:5300> 을 엽니다. Windows는 `시작하기.cmd`를 더블클릭해도 됩니다.

### AI(LLM) 연결 — 선택
`.env.example`을 `.env`로 복사하고 쓸 키만 채우세요. **키가 없어도 실행됩니다**(자료 원문 발췌 답변 + 규칙 기반 퀴즈).

| 설정 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude 사용 (기본 모델 `claude-haiku-5-5`, `ANTHROPIC_MODEL`로 변경) |
| `OPENAI_API_KEY` | ChatGPT 사용 (기본 모델 `gpt-4o-mini`, `OPENAI_MODEL`로 변경) |
| `LLM_PROVIDER` | `auto`(기본: Claude 키 → OpenAI 키 → 로컬 Ollama 순) / `anthropic` / `openai` / `ollama` / `off` |
| `OLLAMA_MODEL` | 로컬 Ollama 모델(기본 `kanana2:3b`) |
| `PORT` / `HOST` | 접속 주소(기본 5300 / 127.0.0.1) |
| `EMBEDDINGS=on` | Ollama `embeddinggemma` 임베딩을 BM25와 섞어 검색(선택, 이 PC에서는 미검증) |

> 외부 LLM을 쓰면 **마스킹된 질문과 검색된 자료 일부**가 해당 회사 API로 전송됩니다. 자료함에 개인정보·비공개 자료를 올리지 마세요. 로컬 Ollama는 외부로 나가지 않습니다.
> AI 출제(퀴즈)는 Claude·ChatGPT가 연결된 경우에만 쓰고, 로컬 소형 모델에서는 느리고 품질이 낮아 규칙 기반으로 출제합니다.

### 카카오톡 챗봇 연동 — 선택
`POST /kakao/skill` 이 카카오 i 오픈빌더의 **스킬 서버** 형식(요청 `userRequest.utterance`, 응답 `version 2.0 / simpleText / quickReplies`)을 처리합니다. 같은 RAG 파이프라인(마스킹 → 검색 → 검증 → 근거 표시)을 쓰고, 근거 항목은 답변 아래 "📚 근거"로, 관련 항목은 빠른 답장 버튼으로 보여 줍니다.

- 5초 제한: 4.5초 안에 답이 없으면 안내 문구로 응답하고, 오류가 나도 항상 HTTP 200 + 안내 문구로 응답합니다.
- 카카오 사용자 ID는 해시한 값으로만 저장합니다. `KAKAO_SKILL_TOKEN`을 설정하면 스킬 URL에 `?token=값`이 맞아야 응답합니다.
- 실제 연결: 오픈빌더에서 봇과 폴백 블록의 스킬 URL을 `https://<공개 주소>/kakao/skill?token=…` 으로 지정합니다. 공개 주소(예: 클라우드 배포 또는 터널)가 필요하며, **이 개발 환경에서는 실제 카카오 채널 연결을 검증하지 못했고 요청·응답 형식을 자동 테스트로만 확인했습니다.**
- 로컬 확인:
  ```bash
  curl -X POST http://127.0.0.1:5300/kakao/skill -H "content-type: application/json" -d "{\"userRequest\":{\"utterance\":\"과대적합이 뭐야?\",\"user\":{\"id\":\"test-user\"}}}"
  ```

### 시연 순서 (5분)
1. (선택) 시연 데이터: `node tools/seed-demo.mjs` 후 <http://127.0.0.1:5300/?learner=demo-learner-01> 접속
2. **학습 챗봇**: "과대적합이 뭐야?" → 근거 칩을 눌러 원문 확인 → "쉽게" 모드로 다시 질문
3. "양자컴퓨터 원리 알려줘" → 지어내지 않고 근거 없음 안내
4. **퀴즈**: 단원 선택 → 5문항 풀이(객관식·빈칸·O/X) → 해설과 다음 복습 시점 확인
5. **내 학습현황**: 단원별 정답률, 약점 개념, 오늘의 학습 추천 → "약점 복습 퀴즈"
6. **자료함**: 내 노트 붙여 넣기 → 챗봇에서 바로 질문
7. **운영 지표** 확인

## 테스트와 평가

```bash
npm test                                             # 자동 테스트 30개
node tools/eval.mjs                                  # 검색·거절·퀴즈 구조 평가 (LLM 없이, 수 초)
node tools/eval.mjs --llm --out evidence/eval-llm.json   # 실제 LLM 답변 평가 (Ollama 또는 API 키 필요)
```

측정 결과와 한계는 [결과보고서](docs/StudyMate_결과보고서.md)를 참고하세요. **평가 질문과 자료는 개발자가 직접 작성했으므로 실제 학습자 질문에 대한 성능을 보장하지 않습니다.**

## 구조

```
server.mjs            서버 시작(.env 로드)
src/http.mjs          REST API + 정적 파일
src/chat.mjs          질문 처리: 마스킹 → 검색 → 신뢰도 → LLM → 검증 → 대체/거절
src/llm.mjs           Claude / ChatGPT / Ollama 어댑터
src/guard.mjs         환각 방지 검사, 추출형 답변
src/rag.mjs           BM25(문자 바이그램) 검색, 신뢰도, (선택) 임베딩
src/quiz.mjs          퀴즈 생성(규칙·AI), 채점
src/learning.mjs      약점 분석, 복습 추천
src/db.mjs            SQLite(학습자, 질문 기록, 문제, 풀이, 숙련도)
src/kb.mjs            자료 로드·업로드 청크 분할
knowledge/            기본 학습 자료 6개 단원(44개 항목, 직접 작성)
data/                 DB, 사용자가 추가한 자료 (git 제외)
public/               웹 화면
tools/                eval, seed-demo, 문서·PPT 생성 스크립트
docs/                 기획서, 결과보고서, 발표 PPT
evidence/             평가 질문·결과
```

API: `POST /api/chat` · `POST /api/chat/:id/feedback` · `POST /api/quiz` · `POST /api/quiz/:id/answer` · `GET /api/progress` · `GET /api/recommend` · `GET/POST/DELETE /api/materials` · `GET /api/units` · `GET /api/kb` · `GET /api/kb/search?q=` · `GET /api/stats` · `GET /api/status`

## 한계 (요약)
- 기본 자료는 직접 요약해 쓴 것이고 실제 수업 교재가 아닙니다. PDF 업로드는 지원하지 않습니다(텍스트로 붙여 넣기).
- 로그인이 없습니다. 학습자는 브라우저에 저장된 임의 ID로 구분되므로 다른 사람이 ID를 알면 기록을 볼 수 있습니다(교육용 데모).
- 주관식 채점은 문자열 비교 기반이라 동의어(예: 오버피팅/과대적합)를 오답으로 처리할 수 있습니다.
- 소형 LLM(3B)은 조건을 빠뜨리거나 부연을 지어낼 수 있고, 의미가 반대인 답변은 검사로 걸러내지 못합니다.
- LLM 없이(추출형) 운영하면 어휘가 일부 겹치는 범위 밖 질문에 관련 없는 항목이 나올 수 있습니다.
- Claude·ChatGPT 연동은 요청 형식을 자동 테스트(가짜 서버)로만 검증했고, 실제 API 호출은 이 개발 환경에서 검증하지 못했습니다(키 없음).

## 2026-11-26 인수인계 검증

원본 ZIP을 기준으로 도구 파일 5개에 주석을 보강하고 단위 테스트 30/30 및 일반·어려운 질문·범위 밖 질문·132개 규칙 퀴즈 평가를 재현했다(Node.js 22.16 로컬). Node.js 24 이상이 공식 목표 환경이다. 결과보고서의 F13 카카오 스킬 누락 및 역사적 LLM 중앙값(2.55초)을 정정했다. [문서 목록](docs/README.md) 및 `evidence/handover-eval-2026-11-26.json` 참고. 실제 Claude/ChatGPT 호출·카카오 채널 연동·인증·실사용자 검증은 포함하지 않는다.


## 공개 시연용 DB

가상 학습자 2명과 학습 기록을 포함한 [SQLite 데모 DB](data/demo/studymate.db)를 제공합니다. [사용 및 재생성 안내](data/demo/README.md)를 참고하세요. 개인 학습 데이터가 포함된 실행용 DB는 계속 Git에서 제외합니다.
