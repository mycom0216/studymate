// 검색·거절·퀴즈 품질 평가. 사용법:
//   node tools/eval.mjs                    검색/거절/퀴즈 구조 평가(LLM 없이, 수 초)
//   node tools/eval.mjs --llm --out evidence/eval-llm.json   실제 LLM 답변까지 평가(.env의 키 또는 Ollama 필요)
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT, createServices } from '../src/app.mjs';
import { LLM } from '../src/llm.mjs';
import { clozeCandidates } from '../src/quiz.mjs';

// 환경 설정 파일은 선택 사항입니다. 키가 없으면 LLM 없이도 검색과 퀴즈 구조를 평가합니다.
try { process.loadEnvFile(`${ROOT}.env`); } catch { /* .env 없음 */ }
// 명령행 옵션으로 실제 생성 답변 평가와 결과 JSON 저장을 각각 선택합니다.
const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const useEmbeddings = args.includes('--embeddings') || process.env.EMBEDDINGS === 'on';
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
// 일반 60개, 어려운 12개, 범위 밖 20개 질문 세트의 원본을 읽습니다.
const set = JSON.parse(readFileSync(`${ROOT}evidence/eval-questions.json`, 'utf8'));
// 정답 개수와 전체 개수를 함께 표시해 백분율의 분모를 숨기지 않습니다.
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}% (${a}/${b})`;

// 고정 난수 시드로 규칙 기반 퀴즈 결과를 재현하며 평가 서비스는 메모리 DB를 사용합니다.
const svc = await createServices({ llm: await new LLM({ provider: useLlm ? undefined : 'off' }).init(), embeddings: useEmbeddings, threshold: 0.3, rng: (() => { let s = 11; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })() });
if (useEmbeddings && !svc.kb.retriever.vectors) throw new Error('Requested embeddings unavailable; refusing silent BM25 fallback');
const report = { retrievalMode: svc.kb.retriever.mode, date: new Date().toISOString().slice(0, 10), chunks: svc.kb.chunks.length, inScope: set.inScope.length, outOfScope: set.outOfScope.length };

// 1) 검색 정확도
// 정답 청크의 1위·상위 4위 적중 횟수와 역순위 합계를 초기화합니다.
let h1 = 0, h4 = 0, mrr = 0;
const misses = [];
const confIn = [], confOut = [];
// 검색 단계만 측정하므로 답변 생성 품질과 구분해야 합니다.
for (const { q, id } of set.inScope) {
  const { hits, confidence } = await svc.kb.retriever.search(q, 4);
  const rank = hits.findIndex((h) => h.chunk.id === id);
  if (rank === 0) h1++; else misses.push({ q, expected: id, got: hits.map((h) => h.chunk.id) });
  if (rank >= 0) { h4++; mrr += 1 / (rank + 1); }
  confIn.push(confidence);
}
// 범위 밖 질문은 정답 청크가 아니라 검색 신뢰도를 수집합니다.
for (const q of set.outOfScope) confOut.push((await svc.kb.retriever.search(q, 4)).confidence);
report.retrieval = { hit1: pct(h1, set.inScope.length), hit4: pct(h4, set.inScope.length), mrr: +(mrr / set.inScope.length).toFixed(3), misses };

// 자료 속 표현을 피해 돌려 말한 질문(BM25의 한계를 보려는 어려운 세트)
let hh1 = 0, hh4 = 0;
// 어려운 표현의 실패 목록과 신뢰도는 일반 질문 결과와 별도로 집계합니다.
const hardMisses = [], confHard = [];
for (const { q, id } of set.hard ?? []) {
  const { hits, confidence } = await svc.kb.retriever.search(q, 4);
  confHard.push(confidence);
  const rank = hits.findIndex((h) => h.chunk.id === id);
  if (rank === 0) hh1++;
  if (rank >= 0) hh4++;
  if (rank !== 0) hardMisses.push({ q, expected: id, got: hits.map((h) => h.chunk.id) });
}
report.retrievalHard = { questions: (set.hard ?? []).length, hit1: pct(hh1, set.hard?.length ?? 0), hit4: pct(hh4, set.hard?.length ?? 0), misses: hardMisses };

// 2) 거절 임계값별 효과: 범위 안 질문은 답하고(재현), 범위 밖 질문은 거절(정밀)해야 함
// 임계값을 높일수록 오답 응답은 줄 수 있지만 정상 질문 거절이 늘어날 수 있습니다.
report.threshold = [0.15, 0.2, 0.25, 0.3, 0.4].map((t) => ({
  threshold: t,
  answeredInScope: pct(confIn.filter((c) => c >= t).length, confIn.length),
  answeredHard: pct(confHard.filter((c) => c >= t).length, confHard.length),
  rejectedOutOfScope: pct(confOut.filter((c) => c < t).length, confOut.length),
}));

// 3) 퀴즈 구조 품질(규칙 기반): 모든 개념에서 문제가 만들어지고, 정답이 문제에 노출되지 않으며, 정답이 보기에 들어 있는지
// 출제 가능한 모든 청크를 문제 유형별로 검사하며 교육적 난이도 평가는 포함하지 않습니다.
let made = 0, leaked = 0, noAnswerOpt = 0, dupOpt = 0;
const types = { mcq: 0, cloze: 0, ox: 0 };
for (const c of svc.kb.chunks) {
  for (const t of ['mcq', 'cloze', 'ox']) {
    if (!clozeCandidates(c).length) continue;
    const it = svc.quiz.ruleItem(c, t);
    if (!it) continue;
    made++; types[it.qtype]++;
    // 문제 제목·맥락 표시 줄을 제외한 본문에서 정답 문자열의 노출 여부를 검사합니다.
    const body = it.prompt.split('\n').slice(2).join(' ');
    if (it.qtype !== 'ox' && body.toLowerCase().includes(it.answer.toLowerCase())) leaked++;
    if (it.options && !it.options.includes(it.answer)) noAnswerOpt++;
    if (it.options && new Set(it.options.map((o) => o.toLowerCase())).size !== it.options.length) dupOpt++;
  }
}
// 출제 누락, 정답 노출, 객관식 정답 누락, 보기 중복을 분리해 기록합니다.
report.quiz = { generated: made, byType: types, answerLeaked: leaked, answerMissingFromOptions: noAnswerOpt, duplicateOptions: dupOpt, chunksWithoutQuiz: svc.kb.chunks.filter((c) => !clozeCandidates(c).length).length };

// 4) (선택) 실제 LLM 답변
// 실모델 모드에서만 서비스의 전체 답변 파이프라인과 실제 응답 시간을 측정합니다.
if (useLlm) {
  const rows = [];
  // AI 생성·추출형·거절 비율과 정답 청크 인용을 별도로 집계합니다.
  let gen = { llm: 0, extractive: 0, none: 0 }, ms = [], citeOk = 0;
  for (const { q, id } of set.inScope) {
    const r = await svc.chat.ask('eval-learner-01', q);
    gen[r.generator]++; ms.push(r.latencyMs);
    if (r.sources.some((s) => s.id === id)) citeOk++;
    rows.push({ q, expected: id, generator: r.generator, cited: r.sources.map((s) => s.id), answer: r.answer, note: r.note });
    console.error(`[LLM] ${rows.length}/${set.inScope.length} in-scope: ${r.generator} (${r.latencyMs}ms)`);
  }
  let rejected = 0;
  const outRows = [];
  for (const q of set.outOfScope) {
    const r = await svc.chat.ask('eval-learner-01', q);
    if (r.generator === 'none') rejected++;
    outRows.push({ q, generator: r.generator, answer: r.answer });
    console.error(`[LLM] ${outRows.length}/${set.outOfScope.length} out-of-scope: ${r.generator}`);
  }
  // 응답 시간을 오름차순으로 정렬해 중앙값 및 90백분위 위치의 값을 산출합니다.
  ms.sort((a, b) => a - b);
  report.llm = { provider: svc.llm.label, generators: gen, citedExpectedChunk: pct(citeOk, set.inScope.length), medianMs: ms[Math.floor(ms.length / 2)], p90Ms: ms[Math.floor(ms.length * 0.9)], outOfScopeRejected: pct(rejected, set.outOfScope.length), rows, outRows };
}

// 콘솔에는 요약만 보여 주되 --out 결과에는 질문별 응답 원자료도 남깁니다.
console.log(JSON.stringify(report, (k, v) => (k === 'rows' || k === 'outRows' ? undefined : v), 2));
if (outFile) { writeFileSync(`${ROOT}${outFile}`, JSON.stringify(report, null, 2)); console.log('저장:', outFile); }
