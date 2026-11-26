// ─────────────────────────────────────────────────────────────────────────────
// server.mjs — StudyMate 서버의 "시작 지점"(npm start 가 실행하는 파일)
//
// [이 파일의 역할]
//   실제 일은 src/ 아래 모듈들이 하고, 이 파일은 "조립해서 켜는" 일만 합니다.
//     1) .env 파일에서 설정(API 키 등)을 읽는다
//     2) 서비스 묶음(svc: 챗봇·퀴즈·학습분석·DB·검색기·LLM)을 만든다   → src/app.mjs
//     3) 요청 처리기(handler)를 만들어 HTTP 서버에 연결한다             → src/http.mjs
//     4) 지정한 주소(HOST:PORT)에서 접속을 기다린다
//
// [외부 npm 패키지 없이] node:http, node:fs 같은 Node.js 내장 모듈만 씁니다(Node.js 24 이상 필요).
// [보안] 기본 HOST 가 127.0.0.1(이 PC에서만 접속 가능)입니다. 외부에 열려면 HOST 를 일부러 바꿔야 합니다.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { ROOT, createServices } from './src/app.mjs';
import { createHandler } from './src/http.mjs';

// .env(API 키 등)가 있으면 읽어 옵니다. 이미 설정된 환경변수가 우선합니다.
// [1단계] 설정 읽기
// process.loadEnvFile 은 Node.js 내장 .env 읽기 함수입니다(dotenv 패키지 불필요).
// 이미 OS 에 설정된 환경변수는 덮어쓰지 않으므로 "실제 환경변수 > .env" 순서로 우선합니다.
// .env 는 선택 사항이라 없으면 예외가 나는데, 그냥 무시하고 계속 진행합니다(키가 없으면 LLM 없이 동작).
try { process.loadEnvFile(`${ROOT}.env`); } catch { /* .env 없음 */ }

// 접속 포트·주소. 환경변수가 문자열이라 Number() 로 숫자 변환. ??는 "값이 없을 때만" 기본값을 씁니다.
const PORT = Number(process.env.PORT ?? 5300);
const HOST = process.env.HOST ?? '127.0.0.1';
// 사용자 자료(업로드한 노트)를 저장할 폴더를 미리 만듭니다. recursive:true 는 이미 있어도 오류 없이 넘어가고 상위 폴더도 함께 만든다는 뜻입니다.
mkdirSync(`${ROOT}data/materials`, { recursive: true });

// [2단계] 서비스 조립(최상위 await: ES 모듈에서만 가능). dbFile 은 SQLite 파일 위치, embeddings 는 "EMBEDDINGS=on"일 때만 임베딩 검색을 켭니다.
const svc = await createServices({
  dbFile: process.env.DB_FILE ?? `${ROOT}data/studymate.db`,
  embeddings: process.env.EMBEDDINGS === 'on',
});

// [3~4단계] HTTP 서버 생성 + 대기. createHandler(svc)가 (req, res)를 받아 API/정적파일/카카오 요청을 나눠 처리합니다.
// 시작되면 검색 방식(BM25 또는 hybrid), 학습 항목(chunk) 수, 단원 수, 연결된 LLM 을 한 줄로 알려 줍니다.
createServer(createHandler(svc)).listen(PORT, HOST, () => {
  console.log(`StudyMate 실행 중: http://${HOST}:${PORT}`);
  console.log(`검색: ${svc.kb.retriever.mode} · 학습 항목 ${svc.kb.chunks.length}개(${svc.kb.units.length}개 단원) · LLM: ${svc.llm.label}`);
});
