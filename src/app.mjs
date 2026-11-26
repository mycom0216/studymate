// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — 서비스 조립소(의존성 주입, DI)
//
// [왜 이런 파일이 있나]
//   챗봇(ChatService)·퀴즈(QuizService)·학습분석(Learning)은 서로 "필요한 부품"(DB, 검색기, LLM)을
//   직접 만들지 않고 생성자로 받습니다. 그래야 테스트에서 "인메모리 DB + 가짜 LLM + 임시 폴더"를
//   끼워 넣을 수 있습니다. 부품을 실제로 만들어 연결하는 곳이 이 파일의 createServices() 입니다.
//
// [만들어지는 서비스 묶음 svc 의 모양]
//   svc.llm          LLM 어댑터(Claude/OpenAI/Ollama/없음)            → llm.mjs
//   svc.kb           { chunks, retriever, units }  지식베이스(자료 조각·검색기·단원 목록)  → kb.mjs, rag.mjs
//   svc.store        SQLite 저장소(질문기록·퀴즈·시도·숙련도)           → db.mjs
//   svc.chat/quiz/learning   업무 서비스들
//   svc.reload()     자료 폴더를 다시 읽어 svc.kb 를 교체(자료 추가/삭제 후 호출)
//   svc.addMaterial / removeMaterial   사용자 자료 추가·삭제 + 자동 reload
// ─────────────────────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
import { ChatService } from './chat.mjs';
import { Store, openDb } from './db.mjs';
import { addMaterial, listUnits, loadAll, removeMaterial } from './kb.mjs';
import { Learning } from './learning.mjs';
import { LLM } from './llm.mjs';
import { QuizService } from './quiz.mjs';
import { Retriever } from './rag.mjs';

// 프로젝트 루트 폴더 경로(끝에 구분자 포함). import.meta.url 은 이 파일의 주소이므로
// '..' 로 src/ 의 한 단계 위(= 프로젝트 루트)를 가리키게 하고, URL → 파일 경로로 바꿉니다.
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 서비스 조립. 테스트에서는 인메모리 DB·가짜 LLM·임시 자료 폴더로 호출합니다.
// 매개변수(모두 선택):
//   dbFile        SQLite 파일 경로. ':memory:' 면 메모리 DB(프로세스가 끝나면 사라짐 → 테스트용)
//   llm           미리 만든 LLM 객체(테스트에서 가짜를 주입). 없으면 환경변수로 실제 어댑터를 초기화
//   embeddings    true 면 Ollama 임베딩을 BM25 와 섞어 검색(선택 기능)
//   threshold     "답할 근거가 충분한가"를 가르는 신뢰도 기준(0~1). 이보다 낮으면 챗봇이 답변을 거절합니다
//   knowledgeDir  기본 제공 학습 자료(.md) 폴더 / materialsDir  사용자가 올린 자료 폴더
//   rng           난수 함수(테스트에서 고정값으로 바꿔 결과를 재현 가능하게 함) / now  현재 시각 함수(테스트용)
export async function createServices({
  dbFile = ':memory:', llm, embeddings = false, threshold = 0.3,
  knowledgeDir = `${ROOT}knowledge`, materialsDir = `${ROOT}data/materials`, rng = Math.random, now,
} = {}) {
  // await new LLM().init(): 사용할 LLM 공급자를 고르고 연결 가능 여부를 확인합니다(없으면 available=false).
  const llmInst = llm ?? await new LLM().init();
  // kb 는 처음엔 null 이고, 아래 reload()가 채웁니다.
  const svc = { llm: llmInst, materialsDir, kb: null };
  // 자료를 (다시) 읽어 지식베이스를 만듭니다. 1) 기본+사용자 자료를 청크로 분할  2) 검색기 색인 생성
  // 3) 단원 목록 계산. 자료를 추가/삭제하면 이 함수로 통째로 교체하므로 검색·퀴즈에 즉시 반영됩니다.
  svc.reload = async () => {
    const chunks = loadAll(knowledgeDir, materialsDir);
    const retriever = await new Retriever(chunks, { cacheFile: `${ROOT}data/embeddings.json`, useEmbeddings: embeddings }).init();
    svc.kb = { chunks, retriever, units: listUnits(chunks) };
  };
  // 서비스들이 "현재의 kb"를 항상 최신으로 보도록, kb 를 직접 넘기지 않고 읽는 함수(getKb)를 넘깁니다(reload 후 객체가 바뀌기 때문).
  await svc.reload();
  const getKb = () => svc.kb;
  // 저장소: DB 를 열고(openDb) Store 로 감쌉니다. now 는 시간을 테스트에서 조작하기 위한 주입점입니다.
  svc.store = new Store(openDb(dbFile), now);
  svc.chat = new ChatService({ getKb, store: svc.store, llm: llmInst, threshold });
  svc.learning = new Learning({ getKb, store: svc.store });
  svc.quiz = new QuizService({ getKb, store: svc.store, learning: svc.learning, llm: llmInst, rng });
  // 자료 추가: 마크다운 파일 생성 → 지식베이스 다시 읽기. 새로 생긴 단원 ID(예: 'u3')를 돌려줍니다.
  svc.addMaterial = async (title, text) => { const unit = addMaterial(materialsDir, title, text); await svc.reload(); return unit; };
  // 자료 삭제: 실제로 지워졌을 때(ok)만 reload 합니다. 기본 자료·잘못된 ID 는 false.
  svc.removeMaterial = async (unit) => { const ok = removeMaterial(materialsDir, unit); if (ok) await svc.reload(); return ok; };
  return svc;
}
