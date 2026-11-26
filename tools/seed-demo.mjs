// 발표·시연용 데이터: 데모 학습자 2명의 질문과 퀴즈 풀이 기록을 DB에 넣습니다. (LLM 없이 실행, 같은 결과가 재현됨)
// 사용법: node tools/seed-demo.mjs   →   http://127.0.0.1:5300/?learner=demo-learner-01 로 접속
import { mkdirSync } from 'node:fs';
import { ROOT, createServices } from '../src/app.mjs';
import { LLM } from '../src/llm.mjs';

// DB를 저장할 data 디렉터리를 준비합니다. 별도 DB_FILE을 지정하면 시험용 파일도 사용할 수 있습니다.
mkdirSync(`${ROOT}data`, { recursive: true });
// 고정 시드의 선형 합동 난수로 같은 정답·오답 분포를 재현합니다.
let seed = 2026;
const rng = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
// 시연용 데이터는 외부 LLM을 호출하지 않으며, SQLite에 저장됩니다.
const svc = await createServices({ dbFile: process.env.DB_FILE ?? `${ROOT}data/studymate.db`, llm: await new LLM({ provider: 'off' }).init(), rng });

// 두 가상 학습자의 단원별 정답 확률과 풀이 횟수를 다르게 설정합니다.
const learners = [
  { id: 'demo-learner-01', name: '데모 학습자', rounds: 3, skill: { python: 0.9, data: 0.6, ml: 0.35, dl: 0.7, llm: 0.5, web: 0.85 } },
  { id: 'demo-learner-02', name: '두 번째 학습자', rounds: 1, skill: { python: 0.7, data: 0.5, ml: 0.6, dl: 0.4, llm: 0.8, web: 0.6 } },
];
// 학습 범위에 포함되는 질문과 범위 밖 질문을 함께 넣어 시연 기록을 구성합니다.
const questions = ['과대적합이 뭐야?', 'RAG는 어떻게 동작해?', '정밀도와 재현율의 차이는?', '임베딩은 뭐고 코사인 유사도는 왜 써?', 'REST API가 뭐야?', '양자컴퓨터 원리 알려줘'];

// 학습자별 질문·피드백·퀴즈 풀이를 순차적으로 생성합니다. 재실행 시 기존 DB에 기록이 추가될 수 있습니다.
for (const L of learners) {
  svc.store.ensureLearner(L.id, L.name);
  for (const q of questions.slice(0, L.id.endsWith('01') ? 6 : 3)) {
    const r = await svc.chat.ask(L.id, q);
    if (r.generator !== 'none') svc.store.setFeedback(r.id, L.id, rng() < 0.85);
  }
  for (let round = 0; round < L.rounds; round++) {
    for (const u of svc.kb.units) {
      // 서비스의 실제 규칙 기반 출제 및 채점 경로를 호출합니다.
      for (const it of await svc.quiz.create(L.id, { unit: u.unit, count: 3, ai: false })) {
        // 난수와 가상 숙련도를 비교해 정답 또는 의도적인 오답을 제출합니다.
        const right = rng() < (L.skill[u.unit] ?? 0.6);
        svc.quiz.answer(L.id, it.id, right ? svc.store.quizItem(it.id).answer : '모르겠어요');
      }
    }
  }
  // 학습 현황 서비스에서 누적 풀이·정답률·약점을 읽어 생성 결과를 요약합니다.
  const p = svc.learning.progress(L.id);
  console.log(`${L.name}: 풀이 ${p.totals.attempts}문항, 정답률 ${Math.round(p.totals.accuracy * 100)}%, 약점 ${p.weak.length}개`);
}
console.log('완료. http://127.0.0.1:5300/?learner=demo-learner-01 로 접속하세요.');
