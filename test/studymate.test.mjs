// ─────────────────────────────────────────────────────────────────────────────
// studymate.test.mjs — StudyMate 자동 테스트(Node.js 내장 테스트 러너, 외부 패키지 없음)
//
// [실행] 프로젝트 폴더에서  node --test test/   (npm test 도 같은 명령)
// [테스트 도구]  node:test 의 describe(묶음) / test(개별 시험) / before·after(준비·정리),
//                node:assert/strict 의 assert.equal 등(조건이 틀리면 테스트 실패).
// [테스트 설계 원칙]
//   · 실제 외부 서비스(OpenAI·Claude·Ollama)를 호출하지 않습니다. LLM 은 "가짜(fakeLLM)"로 바꿔 끼워
//     "AI 가 거짓 숫자를 말하면?", "AI 서버가 죽으면?" 같은 상황을 재현합니다.
//   · DB 는 메모리(:memory:), 사용자 자료는 임시 폴더를 써서 실제 data/ 폴더를 건드리지 않습니다.
//   · 난수는 고정 시드(seeded)로 만들어 매번 같은 결과가 나오게 합니다.
//   · 서비스 계층(chat/quiz/learning), 환각 검사, LLM 어댑터, HTTP API(진짜 서버를 임시 포트로 띄움)까지 다룹니다.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createServices } from '../src/app.mjs';
import { extractiveAnswer, guardAnswer } from '../src/guard.mjs';
import { createHandler } from '../src/http.mjs';
import { kakaoSkill, learnerIdOf, tokenOk } from '../src/kakao.mjs';
import { buildMaterialMarkdown } from '../src/kb.mjs';
import { LLM, extractJson } from '../src/llm.mjs';
import { maskPII } from '../src/text.mjs';

// 재현 가능한 의사난수
// 재현 가능한 의사난수: 선형합동 생성기(LCG). 같은 seed 면 항상 같은 0~1 수열이 나옵니다.
// 퀴즈 출제는 난수를 쓰므로 이렇게 고정해야 테스트 결과가 매번 같습니다.
const seeded = (seed = 1) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
// LLM 을 끈 상태(provider:'off')로 초기화 → "AI 없이도 동작"을 시험할 때 사용
const offLLM = () => new LLM({ provider: 'off' }).init();
// 가짜 LLM: 실제 네트워크 호출 없이 complete() 가 reply(문자열 또는 함수)를 돌려주는 척합니다.
// 함수를 주면 호출 때 실행하므로 예외를 던져 "AI 서버 장애"도 흉내 낼 수 있습니다. provider 는 'openai' 로 둬서 AI 출제 경로도 켜집니다.
const fakeLLM = (reply) => Object.assign(new LLM({ provider: 'off' }), { available: true, provider: 'openai', model: 'fake', complete: async () => (typeof reply === 'function' ? reply() : reply) });
// 테스트용 학습자 ID(서버의 ID 형식 규칙 6~64자를 만족)
const L = 'learner-test-01';

// ── 1) 지식 자료와 검색(rag.mjs·kb.mjs) ──
// 서비스를 한 번만 만들어(before) 여러 테스트가 공유하고, 끝나면 임시 폴더를 지웁니다(after).
describe('지식 자료와 검색', () => {
  let svc, dir;
  before(async () => { dir = mkdtempSync(join(tmpdir(), 'sm-')); svc = await createServices({ llm: await offLLM(), materialsDir: dir, rng: seeded() }); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  // 기본 자료가 단원 6개·항목 40개 이상으로 잘 나뉘고, 모든 항목에 핵심 용어가 있으며 굵은 글씨 표시(**)가 본문에서 제거됐는지 확인
  test('기본 자료 6개 단원이 항목으로 나뉜다', () => {
    assert.equal(svc.kb.units.length, 6);
    assert.ok(svc.kb.chunks.length >= 40);
    assert.ok(svc.kb.chunks.every((c) => c.terms.length > 0 && !c.text.includes('**')));
  });

  // 대표 질문마다 정답 항목(ID)이 검색 1위인지 확인 → 검색 품질의 회귀(품질 저하) 방지
  test('질문에 맞는 항목이 1위로 검색된다', async () => {
    for (const [q, id] of [['과대적합이 뭐야?', 'ML-04'], ['RAG는 어떻게 동작해?', 'LM-04'], ['정밀도와 재현율 차이', 'ML-05'], ['REST API가 뭐야', 'WB-02'], ['try except 예외 처리', 'PY-06']]) {
      const { hits } = await svc.kb.retriever.search(q, 4);
      assert.equal(hits[0].chunk.id, id, q);
    }
  });

  // 자료와 무관한 질문(양자컴퓨터·날씨·피자)은 신뢰도가 낮아 "근거 없음"(none)으로 거절되고 근거 목록이 비어야 한다 → 지어내기 방지
  test('범위 밖 질문은 신뢰도가 낮아 거절된다', async () => {
    for (const q of ['양자컴퓨터 원리 알려줘', '오늘 서울 날씨 어때?', '피자 맛있게 굽는 법']) {
      const r = await svc.chat.ask(L, q);
      assert.equal(r.generator, 'none', q);
      assert.equal(r.sources.length, 0);
    }
  });

  // LLM 이 없어도 자료 원문 발췌(extractive)로 답하고 근거에 올바른 항목(ML-07)이 포함되는지
  test('LLM 없이도 근거가 달린 추출형 답변을 준다', async () => {
    const r = await svc.chat.ask(L + 'x', '경사하강법에서 학습률이 너무 크면 어떻게 돼?');
    assert.equal(r.generator, 'extractive');
    assert.match(r.answer, /발산/u);
    assert.ok(r.sources.some((s) => s.id === 'ML-07'));
  });

  // 전화번호가 가려져(piiMasked) 응답되고, DB 에 저장된 질문에는 번호 일부('1234')도 남지 않는지 직접 SQL 로 확인. 이메일 마스킹도 확인
  test('개인정보는 가려서 저장한다', async () => {
    const r = await svc.chat.ask(L, '제 번호 010-1234-5678 인데 과대적합이 뭐예요?');
    assert.deepEqual(r.piiMasked, ['전화번호']);
    assert.ok(!svc.store.db.prepare('SELECT question FROM qa_log WHERE id = ?').get(r.id).question.includes('1234'));
    assert.equal(maskPII('a@b.com').masked, '[이메일]');
  });

  // 사용자 자료 추가 → 새 단원 ID(u숫자) 생성·검색 반영 → 삭제. 기본 자료('python')는 삭제 거부(false)되고 단원 수가 원래(6)로 돌아오는지 확인
  test('사용자 자료를 추가하면 검색·삭제가 된다', async () => {
    const unit = await svc.addMaterial('운영체제 기초', '## 프로세스\n**프로세스**는 실행 중인 프로그램을 말하며 운영체제가 자원을 배정하는 단위입니다. 각 프로세스는 독립된 메모리 공간을 가집니다.\n\n## 스레드\n**스레드**는 프로세스 안에서 실행되는 작은 흐름이며 같은 프로세스의 스레드끼리는 메모리를 공유합니다.');
    assert.match(unit, /^u\d+$/u);
    const { hits } = await svc.kb.retriever.search('스레드와 메모리 공유', 3);
    assert.equal(hits[0].chunk.title, '스레드');
    assert.ok(svc.kb.units.find((u) => u.unit === unit).user);
    assert.equal(await svc.removeMaterial(unit), true);
    assert.equal(await svc.removeMaterial('python'), false); // 기본 자료는 삭제 불가
    assert.equal(svc.kb.units.length, 6);
  });

  // 소제목 없는 일반 텍스트도 "## [U1-…]" 항목으로 나뉘고, 너무 짧은 본문/빈 제목은 오류로 거부되는지
  test('붙여 넣은 일반 텍스트도 항목으로 나뉘고 짧은 입력은 거부한다', () => {
    const md = buildMaterialMarkdown('메모', '첫 문단입니다. 충분히 길게 써서 하나의 항목이 되도록 합니다. '.repeat(6) + '\n\n둘째 문단입니다. ' + '내용을 이어서 씁니다. '.repeat(10), 1);
    assert.ok((md.match(/^## \[U1-\d+\]/gmu) ?? []).length >= 1);
    assert.throws(() => buildMaterialMarkdown('메모', '너무 짧음', 1), /40자/u);
    assert.throws(() => buildMaterialMarkdown('', '가'.repeat(100), 1), /제목/u);
  });
});

// ── 2) 환각 방지 검사(guard.mjs) ──
describe('환각 방지 검사', () => {
  // 가짜 검색 결과 1건(반품 규정). 숫자 7·3000 만 "자료에 있는 숫자"입니다.
  const hits = [{ chunk: { id: 'X-1', title: '반품 기간', text: '상품은 7일 이내에 반품할 수 있습니다. 배송비는 3000원입니다.' } }];
  // 5가지 시나리오: ① 정상 통과 ② 자료에 없는 숫자(14일) 거부 ③ '근거 부족' 응답은 abstain ④ 범위 밖 인용 [3] 거부 ⑤ 자료와 무관한 문장은 ungrounded
  test('근거 없는 숫자·거절·잘못된 인용을 걸러낸다', () => {
    assert.equal(guardAnswer('상품은 7일 이내에 반품할 수 있습니다. [1]', '반품?', hits).ok, true);
    assert.match(guardAnswer('상품은 14일 이내에 반품할 수 있습니다.', '반품?', hits).reason, /unsupported-number/u);
    assert.equal(guardAnswer('근거 부족', '반품?', hits).reason, 'abstain');
    assert.equal(guardAnswer('상품은 7일 이내에 반품할 수 있습니다. [3]', '반품?', hits).reason, 'bad-citation');
    assert.equal(guardAnswer('우주의 기원은 빅뱅이며 별은 수소로 이루어져 있습니다.', '반품?', hits).reason, 'ungrounded');
  });
  // 추출형 답변은 질문("배송비")과 겹치는 문장만 고르고, 근거로 첫 번째 문서만 썼는지(hitIndexes [0]) 확인
  test('추출형 답변은 질문과 겹치는 문장만 고른다', () => {
    const r = extractiveAnswer('배송비 얼마?', hits);
    assert.match(r.text, /3000원/u);
    assert.deepEqual(r.hitIndexes, [0]);
  });
  // AI 가 자료에 없는 숫자(1000)를 말하면 검사에서 떨어져 원문 발췌로 대체되고, 이유 안내(note)에 "근거 검사"가 들어가는지
  test('LLM 답변이 근거 검사를 통과 못 하면 원문으로 대체한다', async () => {
    const svc = await createServices({ llm: fakeLLM('과대적합은 모델이 매우 빠르게 학습하여 1000번 반복하는 현상입니다. [1]') });
    const r = await svc.chat.ask(L, '과대적합이 뭐야?');
    assert.equal(r.generator, 'extractive');
    assert.match(r.note, /근거 검사/u);
  });
  // AI 가 자료와 맞는 답을 하면 AI 답변(llm)으로 채택되고, 인용 번호 [1] 은 본문에서 지워지며 근거 항목이 정확한지
  test('LLM 답변이 근거와 맞으면 AI 답변으로 인용과 함께 낸다', async () => {
    const svc = await createServices({ llm: fakeLLM('과대적합은 모델이 학습 데이터에는 매우 잘 맞지만 새 데이터에서 성능이 떨어지는 현상입니다. [1]') });
    const r = await svc.chat.ask(L, '과대적합이 뭐야?');
    assert.equal(r.generator, 'llm');
    assert.equal(r.sources[0].id, 'ML-04');
    assert.ok(!r.answer.includes('[1]'));
  });
  // AI 가 '근거 부족'이라 답하면(검색 신뢰도는 높아도) 원문을 억지로 내밀지 않고 거절(none)하고, 운영 지표에서도 "답변됨"으로 세지 않는지
  test('LLM이 근거 부족이라고 답하면 원문을 내밀지 않고 거절한다', async () => {
    const svc = await createServices({ llm: fakeLLM('근거 부족') });
    const r = await svc.chat.ask(L, '과대적합이 뭐야?'); // 검색 신뢰도는 높지만 LLM이 근거 없다고 판단한 경우
    assert.equal(r.generator, 'none');
    assert.equal(r.sources.length, 0);
    assert.equal(svc.store.stats().answered, 0);
  });
  // AI 호출이 예외로 실패해도 서비스가 멈추지 않고 추출형으로 답하는지
  test('LLM 호출이 실패해도 추출형으로 답한다', async () => {
    const svc = await createServices({ llm: fakeLLM(() => { throw new Error('boom'); }) });
    const r = await svc.chat.ask(L, '과대적합이 뭐야?');
    assert.equal(r.generator, 'extractive');
  });
});

// ── 3) LLM 어댑터(llm.mjs) ──
describe('LLM 어댑터', () => {
  // 공급자 선택 규칙: off → 사용 불가 / 키만 있으면 해당 공급자 / 둘 다 있어도 명시한 공급자(openai) 우선
  test('키가 없으면 꺼짐, 키가 있으면 해당 공급자를 고른다', async () => {
    assert.equal((await new LLM({ env: {}, provider: 'off' }).init()).available, false);
    const a = await new LLM({ env: { ANTHROPIC_API_KEY: 'k' }, provider: 'auto' }).init();
    assert.equal(a.provider, 'anthropic');
    const o = await new LLM({ env: { OPENAI_API_KEY: 'k' }, provider: 'auto' }).init();
    assert.equal(o.provider, 'openai');
    const both = await new LLM({ env: { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, provider: 'openai' }).init();
    assert.equal(both.provider, 'openai');
  });
  // 요청 형식 확인: fetchFn 을 가짜로 바꿔 호출 내용(주소·헤더·본문)을 기록합니다.
  // Claude: 올바른 주소·x-api-key 헤더·system 필드. OpenAI: 처음 요청이 temperature 때문에 400 으로 거절되면 temperature 를 뺀 채 딱 한 번 재시도하는지
  test('Claude·ChatGPT 요청 형식과 temperature 거절 시 재시도', async () => {
    const calls = [];
    const mk = (provider, env, responder) => new LLM({ env, provider, fetchFn: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return responder(calls.length); } }).init();
    const ok = (json) => ({ ok: true, json: async () => json });
    const a = await mk('anthropic', { ANTHROPIC_API_KEY: 'sk-a' }, () => ok({ content: [{ type: 'text', text: '안녕' }] }));
    assert.equal(await a.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }), '안녕');
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].headers['x-api-key'], 'sk-a');
    assert.equal(calls[0].body.system, 's');
    calls.length = 0;
    const o = await mk('openai', { OPENAI_API_KEY: 'sk-o' }, (n) => (n === 1 ? { ok: false, status: 400, text: async () => 'Unsupported value: temperature' } : ok({ choices: [{ message: { content: '반가워요' } }] })));
    assert.equal(await o.complete({ system: 's', messages: [{ role: 'user', content: 'q' }] }), '반가워요');
    assert.equal(calls.length, 2);
    assert.ok('temperature' in calls[0].body && !('temperature' in calls[1].body));
    assert.equal(calls[1].headers.authorization, 'Bearer sk-o');
  });
  // 보안: 401 오류가 나도 lastError(상태 화면에 노출되는 값)에 API 키('sk-SECRET')가 섞여 나오지 않아야 한다
  test('실패 원인에 API 키가 새지 않는다', async () => {
    const l = await new LLM({ env: { OPENAI_API_KEY: 'sk-SECRET' }, provider: 'openai', fetchFn: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) }).init();
    await assert.rejects(l.complete({ system: 's', messages: [] }));
    assert.ok(!String(l.lastError).includes('SECRET'));
  });
  // 모델이 코드펜스(```json)나 군더더기 설명을 붙여도 JSON 을 꺼내고, JSON 이 없으면 null
  test('JSON 추출은 코드펜스와 군더더기를 허용한다', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n``` 끝'), { a: 1 });
    assert.equal(extractJson('없음'), null);
  });
});

// ── 4) 퀴즈·채점·학습 분석(quiz.mjs·learning.mjs·db.mjs) ──
describe('퀴즈·채점·학습 분석', () => {
  let svc;
  // now 를 함수로 주입해 테스트가 시간을 조작할 수 있게 해 둔 서비스(AI 끔, 고정 시드)
  before(async () => { svc = await createServices({ llm: await offLLM(), rng: seeded(7), now: () => svc?.clock ?? Date.now() }); });

  // 출제된 문제(화면용)에는 answer 가 없고, DB 의 정답이 보기에 포함되며, 빈칸 문제의 본문에는 정답이 노출되지 않고, 유형이 2가지 이상 섞이는지
  test('문제는 정답을 숨기고 보기에 정답이 하나 들어 있다', async () => {
    const items = await svc.quiz.create(L, { unit: 'ml', count: 8 });
    assert.equal(items.length, 8);
    for (const it of items) {
      assert.ok(!('answer' in it));
      const row = svc.store.quizItem(it.id);
      if (it.options) assert.ok(it.options.includes(row.answer), it.prompt);
      if (it.qtype !== 'ox') assert.ok(!it.prompt.split('\n').slice(2).join(' ').includes(row.answer), `정답 노출: ${it.prompt}`);
      assert.ok(it.prompt.includes('[') && (it.qtype === 'ox' || it.prompt.includes('____')));
    }
    assert.ok(new Set(items.map((i) => i.qtype)).size >= 2);
  });

  // 채점 시나리오: 남의 학습자 ID 로 제출 → 404(IDOR 방지) / 정답 제출 → 정답, 상자 1→2 / 같은 문제 재제출 → 거부 / 없는 문제 번호 → 404
  test('채점: 정답·오답·중복 제출·남의 문제', async () => {
    const [it] = await svc.quiz.create(L + 'a', { unit: 'python', count: 1 });
    const row = svc.store.quizItem(it.id);
    assert.throws(() => svc.quiz.answer('other-learner-1', it.id, row.answer), /찾을 수 없/u);
    const r = svc.quiz.answer(L + 'a', it.id, row.answer);
    assert.equal(r.correct, true);
    assert.equal(r.box, 2);
    assert.throws(() => svc.quiz.answer(L + 'a', it.id, row.answer), /이미 제출/u);
    assert.throws(() => svc.quiz.answer(L + 'a', 99999, 'x'), /찾을 수 없/u);
  });

  // 주관식 채점의 관대함: 공백·대소문자·조사('과대적합이요') 허용, 다른 단어와 빈 답은 오답
  test('주관식은 공백·대소문자·조사 포함 답을 정답으로 본다', () => {
    const g = (answer, user) => svc.quiz.grade({ qtype: 'cloze', answer }, user);
    assert.ok(g('원-핫 인코딩', '원-핫인코딩'));
    assert.ok(g('RAG', 'rag'));
    assert.ok(g('과대적합', '과대적합이요'));
    assert.ok(!g('과대적합', '과소적합'));
    assert.ok(!g('과대적합', ''));
  });

  // 단원 문제를 일부러 전부 틀린 뒤 전부 맞히면 정답률이 0~1 사이가 되고, 3개 개념을 학습했다고 집계되며 추천이 생성되는지
  test('틀리면 약점·복습 대상이 되고, 맞히면 상자가 올라간다', async () => {
    const id = L + 'w';
    for (let k = 0; k < 2; k++) {
      const items = await svc.quiz.create(id, { unit: 'dl', count: 3 });
      for (const it of items) svc.quiz.answer(id, it.id, k === 0 ? '틀린답입니다' : svc.store.quizItem(it.id).answer);
    }
    const p = svc.learning.progress(id);
    assert.equal(p.totals.attempts, 6);
    assert.ok(p.totals.accuracy > 0 && p.totals.accuracy < 1);
    const dl = p.units.find((u) => u.unit === 'dl');
    assert.equal(dl.seen, 3);
    const rec = svc.learning.recommend(id);
    assert.ok(rec.plan.length >= 1);
  });

  // 복습 모드: 앞 2문항을 일부러 틀리면 다음 복습 출제 2문제는 정확히 그 2개 개념이어야 한다(약점 우선 출제)
  test('복습 모드는 틀린 개념을 먼저 출제한다', async () => {
    const id = L + 'r';
    const first = await svc.quiz.create(id, { unit: 'web', count: 7 });
    // 앞 2문항을 일부러 틀리고 나머지는 맞힘
    const wrong = new Set();
    first.forEach((it, i) => { const row = svc.store.quizItem(it.id); if (i < 2) { svc.quiz.answer(id, it.id, '아님'); wrong.add(row.chunk_id); } else svc.quiz.answer(id, it.id, row.answer); });
    const again = await svc.quiz.create(id, { mode: 'review', count: 2 });
    const got = again.map((it) => svc.store.quizItem(it.id).chunk_id);
    assert.deepEqual(new Set(got), wrong);
  });

  // AI 출제 검증: 자료와 맞는 문제는 채택(generator 'llm'), 자료와 무관한 보기(bad)나 정답이 문제에 노출된 문제(leak)는 null 로 버려지는지.
  // (create()에서 우선순위상 다른 개념이 뽑히면 AI 문제가 자료와 어긋나 규칙 기반으로 대체됩니다.)
  test('AI 출제: 자료와 맞는 문제만 받아들이고 어긋나면 규칙 기반으로 대체한다', async () => {
    const good = JSON.stringify({ question: '모델이 학습 데이터에는 잘 맞지만 새 데이터에서 성능이 떨어지는 현상은?', options: ['과대적합', '과소적합', '교차검증', '정규화'], answer: 0, explanation: '학습 데이터에는 매우 잘 맞지만 새 데이터에서 성능이 떨어지는 현상을 과대적합이라고 합니다.' });
    const s1 = await createServices({ llm: fakeLLM(good), rng: seeded(3) });
    const it = (await s1.quiz.create(L, { unit: 'ml', count: 1 }))[0];
    assert.equal(it.generator, 'rule'); // 우선순위상 다른 개념이 뽑히면 자료와 안 맞아 규칙 기반으로 대체됨
    const chunk = s1.kb.chunks.find((c) => c.id === 'ML-04');
    const ok = await s1.quiz.llmItem(chunk);
    assert.equal(ok.generator, 'llm');
    assert.equal(ok.answer, '과대적합');
    const bad = JSON.stringify({ question: '과대적합의 정의는?', options: ['달 탐사선', '반도체 공정', '해양 지질', '고대 건축'], answer: 1, explanation: '반도체 공정에서 쓰는 용어입니다.' });
    const s2 = await createServices({ llm: fakeLLM(bad) });
    assert.equal(await s2.quiz.llmItem(s2.kb.chunks.find((c) => c.id === 'ML-04')), null);
    const leak = JSON.stringify({ question: '과대적합은 무엇인가요? 정답은 과대적합입니다', options: ['과대적합', '과소적합', '교차검증', '정규화'], answer: 0, explanation: '학습 데이터에는 매우 잘 맞지만 새 데이터에서 성능이 떨어지는 현상입니다.' });
    const s3 = await createServices({ llm: fakeLLM(leak) });
    assert.equal(await s3.quiz.llmItem(s3.kb.chunks.find((c) => c.id === 'ML-04')), null);
  });

  // 잘못된 입력: 없는 단원은 404, 단원을 안 고르면 400
  test('없는 단원·단원 누락은 오류', async () => {
    await assert.rejects(svc.quiz.create(L, { unit: 'nope' }), /없는 단원/u);
    await assert.rejects(svc.quiz.create(L, {}), /단원을 선택/u);
  });
});

// ── 5) HTTP API(http.mjs): 진짜 서버를 임시 포트(0 = 운영체제가 빈 포트 배정)로 띄워 실제 요청을 보냅니다 ──
describe('HTTP API', () => {
  let svc, server, base, dir;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sm-http-'));
    svc = await createServices({ llm: await offLLM(), materialsDir: dir, rng: seeded(5) });
    server = createServer(createHandler(svc));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  // call: JSON 요청 도우미 → { status, body }
  const call = async (path, body, method) => {
    const res = await fetch(base + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // 기본 API 와 정적 파일. '/../server.mjs' 와 인코딩된 '/%2e%2e/server.mjs' 모두 404 → public/ 밖 파일 노출(경로 이탈) 차단 확인
  test('상태·단원·정적 파일', async () => {
    const s = await call('/api/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.units, 6);
    assert.equal((await call('/api/units')).body.length, 6);
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/../server.mjs')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e/server.mjs')).status, 404);
  });

  // 사용자 흐름 전체: 질문 → 도배 방지(즉시 재질문 429) → 피드백(본인 200 / 타인 404 = IDOR 방지) → 퀴즈 생성·제출 → 학습현황·운영 지표 반영
  test('챗봇 → 피드백 → 학습현황 흐름', async () => {
    const id = 'http-learner-1';
    const r = await call('/api/chat', { learnerId: id, name: '테스터', question: '교차검증이 뭐야?' });
    assert.equal(r.status, 200);
    assert.ok(r.body.sources.some((s) => s.id === 'ML-06'));
    assert.equal((await call('/api/chat', { learnerId: id, question: '다시 질문하기' })).status, 429);
    assert.equal((await call(`/api/chat/${r.body.id}/feedback`, { learnerId: id, helpful: true })).status, 200);
    assert.equal((await call(`/api/chat/${r.body.id}/feedback`, { learnerId: 'someone-else-1', helpful: true })).status, 404);
    const q = await call('/api/quiz', { learnerId: id, unit: 'ml', count: 2 });
    assert.equal(q.body.items.length, 2);
    const a = await call(`/api/quiz/${q.body.items[0].id}/answer`, { learnerId: id, answer: '아무거나' });
    assert.equal(a.status, 200);
    assert.ok('correctAnswer' in a.body);
    const p = await call('/api/progress?learnerId=' + id);
    assert.equal(p.body.totals.attempts, 1);
    assert.equal(p.body.learner.name, '테스터');
    const st = await call('/api/stats');
    assert.ok(st.body.questions >= 1 && st.body.quiz.attempts >= 1);
  });

  // 입력 검증: learnerId 없음/형식 오류/질문 너무 짧음·너무 긺 → 400, 없는 API → 404, 본문 한도 초과 → 413, 깨진 JSON → 400
  test('입력 검증과 오류 응답', async () => {
    assert.equal((await call('/api/chat', { question: '질문' })).status, 400);
    assert.equal((await call('/api/chat', { learnerId: 'bad id!', question: '질문' })).status, 400);
    assert.equal((await call('/api/chat', { learnerId: 'valid-learner-2', question: '가' })).status, 400);
    assert.equal((await call('/api/chat', { learnerId: 'valid-learner-3', question: '가'.repeat(600) })).status, 400);
    assert.equal((await call('/api/progress')).status, 400);
    assert.equal((await call('/api/nothing')).status, 404);
    const big = await call('/api/chat', { learnerId: 'valid-learner-4', question: 'a'.repeat(6000) });
    assert.equal(big.status, 413);
    const res = await fetch(base + '/api/chat', { method: 'POST', body: '{깨진 json' });
    assert.equal(res.status, 400);
  });

  // 자료 API: 추가(7개 단원이 됨) → 새 자료로 질문하면 근거에 잡힘 → 너무 짧은 자료 400 → 삭제 200, 없는 번호·기본 자료 삭제 404
  test('자료 추가·삭제 API', async () => {
    const add = await call('/api/materials', { title: '네트워크', text: '## TCP\n**TCP**는 연결을 맺고 데이터를 순서대로 전달하는 신뢰성 있는 프로토콜입니다.\n\n## UDP\n**UDP**는 연결 없이 빠르게 보내는 프로토콜이며 전달을 보장하지 않습니다.' });
    assert.equal(add.status, 200);
    assert.equal(add.body.units.length, 7);
    const r = await call('/api/chat', { learnerId: 'http-learner-9', question: 'UDP는 전달을 보장해?' });
    assert.ok(r.body.sources.some((s) => s.title === 'UDP'));
    assert.equal((await call('/api/materials', { title: '짧음', text: '짧다' })).status, 400);
    assert.equal((await call('/api/materials/' + add.body.unit, null, 'DELETE')).status, 200);
    assert.equal((await call('/api/materials/u999', null, 'DELETE')).status, 404);
    assert.equal((await call('/api/materials/python', null, 'DELETE')).status, 404);
  });

  // 카카오 스킬: 응답 형식(version 2.0, 1000자 이하, '📚 근거', 빠른 답장 버튼 규격), 도배 안내, 범위 밖 질문 거절, 빈 발화·사용자 정보 없음 안내,
  // 깨진 본문도 HTTP 200, GET 은 405, 사용자 ID 해시 형식(kakao- + 16진수 24자)
  test('카카오 스킬 서버: 응답 형식·근거·오류도 200', async () => {
    const skill = (utterance, uid = 'kakao-user-A') => call('/kakao/skill', { userRequest: { utterance, user: { id: uid } } });
    const r = await skill('교차검증이 뭐야?');
    assert.equal(r.status, 200);
    assert.equal(r.body.version, '2.0');
    const text = r.body.template.outputs[0].simpleText.text;
    assert.ok(text.includes('📚 근거:') && text.length <= 1000);
    assert.ok(r.body.template.quickReplies.every((q) => q.label.length <= 14 && q.action === 'message'));
    assert.ok((await skill('다시 질문', 'kakao-user-A')).body.template.outputs[0].simpleText.text.includes('잠시 후'));
    assert.ok((await skill('양자컴퓨터 원리 알려줘', 'kakao-user-B')).body.template.outputs[0].simpleText.text.includes('근거를 찾지 못했'));
    assert.ok((await skill('', 'kakao-user-C')).body.template.outputs[0].simpleText.text.includes('입력'));
    assert.ok((await call('/kakao/skill', {})).body.template.outputs[0].simpleText.text.includes('사용자 정보'));
    const bad = await fetch(base + '/kakao/skill', { method: 'POST', body: '{깨짐' });
    assert.equal(bad.status, 200);
    assert.equal((await fetch(base + '/kakao/skill')).status, 405);
    assert.equal(learnerIdOf('abc'), learnerIdOf('abc'));
    assert.match(learnerIdOf('abc'), /^kakao-[0-9a-f]{24}$/u);
  });

  // 카카오 타임아웃: 응답이 200ms 걸리는 가짜 챗봇에 한도 30ms 를 주면 "시간이 걸리고…" 안내가 나오는지. 토큰 검사: 설정 없으면 통과, 같으면 통과, 다르거나 없으면 거부
  test('카카오 스킬 서버: 느린 응답은 시간 초과 안내, 토큰 검사', async () => {
    const slow = { store: svc.store, chat: { ask: () => new Promise((r) => setTimeout(r, 200)) } };
    const r = await kakaoSkill(slow, { userRequest: { utterance: '질문입니다', user: { id: 'slow-user' } } }, { timeoutMs: 30 });
    assert.ok(r.template.outputs[0].simpleText.text.includes('시간이 걸리고'));
    assert.ok(tokenOk('', undefined) && tokenOk('s3cret', 's3cret'));
    assert.ok(!tokenOk('s3cret', 'wrong') && !tokenOk('s3cret', undefined));
  });
});
