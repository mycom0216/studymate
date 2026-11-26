// ─────────────────────────────────────────────────────────────────────────────
// quiz.mjs — 퀴즈 자동 출제와 채점
//
// [문제 유형(qtype)]
//     mcq   객관식(보기 4개)   cloze 빈칸 쓰기(주관식)   ox  O/X 판별
// [출제 방식 두 가지]
//     rule  규칙 기반: 자료 문장에서 "핵심 용어"(굵은 글씨 등)를 ____ 로 가려 빈칸 문제를 만든다. AI 없이 항상 가능.
//     llm   AI 출제: Claude/ChatGPT 가 자료만 보고 객관식을 만들게 하되, 자료와 어긋나면 코드로 걸러 낸다.
// [create() 흐름]  문제 풀 구성(단원 또는 약점 복습) → 학습 우선순위로 개념 선택 → 문제 생성 → DB 저장 →
//                  화면용 정보 반환. 이때 정답·해설은 DB 에만 두고 화면에는 내려보내지 않습니다(정답 비노출).
// [answer() 흐름]  문제 조회 → 소유자 확인 → 중복 제출 확인 → 채점 → 숙련도 갱신 → 정답·해설 공개
// [보안]  · 정답은 제출 전까지 서버에만 있음  · 남의 문제 채점 시도는 "없는 문제"(404)로 응답(IDOR 방지)
//         · 한 문제는 한 번만 채점(409)  · 답 입력은 200자로 자름  · 문제 수는 1~10개로 제한
// ─────────────────────────────────────────────────────────────────────────────
import { HttpError } from './errors.mjs';
import { groundedness } from './guard.mjs';
import { extractJson } from './llm.mjs';
import { BOX_DAYS } from './db.mjs';
import { normalize, sentences } from './text.mjs';

// 정규식 특수문자(. * + ? ^ $ { } ( ) | [ ] \)를 앞에 \ 를 붙여 "글자 그대로" 취급하게 만듭니다.
// 핵심 용어에 괄호 같은 문자가 있어도 정규식이 깨지지 않고, 자료 속 문자열이 정규식 명령으로 해석되는 것을 막습니다.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// 비교용 정규화: 표준화·소문자화 후 "모든 공백 제거". 띄어쓰기가 달라도 같은 답으로 봅니다.
const norm = (s) => normalize(s).replace(/\s+/gu, '');
// 용어를 안전하게 정규식으로 만듭니다(기본 플래그: i 대소문자 무시, u 유니코드).
const re = (term, flags = 'iu') => new RegExp(esc(term), flags);

// 배열을 무작위로 섞은 새 배열(Fisher–Yates 방식: 뒤에서부터 앞쪽 임의 위치와 교환). rng 는 난수 함수라 테스트에서 고정할 수 있습니다.
export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 문장 안에 핵심 용어가 있는 (문장, 용어) 후보. 용어의 실제 표기는 원문 그대로 꺼냅니다.
// 반환: [{ sentence: 원문 문장, term: 문장에서 실제로 찾은 표기 }]. 후보가 없으면 그 개념으로는 빈칸 문제를 못 만듭니다.
export function clozeCandidates(chunk) {
  const out = [];
  for (const s of sentences(chunk.text)) {
    // 문장이 너무 짧으면(15자 미만) 빈칸을 뚫어도 단서가 부족해 제외
    if (s.length < 15) continue;
    for (const t of chunk.terms) {
      const m = re(t).exec(s);
      if (m) out.push({ sentence: s, term: m[0] });
    }
  }
  return out;
}

// 문장 속 용어(모든 등장 위치)를 '____' 로 가립니다. g = 전부 치환.
const blank = (sentence, term) => sentence.replace(re(term, 'giu'), '____');

// 퀴즈 서비스. 의존 서비스: getKb(자료), store(DB), learning(우선순위), llm, rng(난수)
export class QuizService {
  constructor({ getKb, store, learning, llm, rng = Math.random }) {
    Object.assign(this, { getKb, store, learning, llm, rng });
  }

  // 오답 보기: 다른 개념의 핵심 용어 중 문장에 없고 길이가 비슷한 것
  // 점수 d(작을수록 좋음) = 정답과의 글자 수 차이 + 무작위 0~3 − (같은 단원이면 2). 그럴듯해 보이면서 너무 뻔하지 않게 고르는 장치입니다.
  // 정답과 같은 용어(공백 차이 무시)와 문장에 이미 나온 용어는 보기에서 제외합니다. n 개를 반환(후보가 부족하면 더 적게).
  distractors(answer, sentence, chunk, n = 3) {
    const { chunks } = this.getKb();
    const seen = new Set([norm(answer)]);
    const pool = [];
    for (const c of chunks) {
      for (const t of c.terms) {
        const k = norm(t);
        if (seen.has(k) || re(t).test(sentence)) continue;
        seen.add(k);
        pool.push({ t, same: c.unit === chunk.unit, d: Math.abs(t.length - answer.length) + this.rng() * 3 - (c.unit === chunk.unit ? 2 : 0) });
      }
    }
    return pool.sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.t);
  }

  // 규칙 기반 출제: 한 개념(chunk)에서 문제 1개를 만듭니다. 후보 문장 중 하나를 무작위로 골라 용어를 가립니다.
  // 보기를 만들 수 없으면(후보 부족) 항상 만들 수 있는 빈칸(cloze)형으로 후퇴합니다.
  // 반환 문제 객체: { chunkId, unit, generator, qtype, prompt, options, answer, explanation }
  ruleItem(chunk, qtype) {
    const cands = clozeCandidates(chunk);
    if (!cands.length) return null;
    // 선택된 (문장, 용어)
    const { sentence, term } = cands[Math.floor(this.rng() * cands.length)];
    // 단서 유출 방지: 개념 제목에 정답 용어가 그대로 들어 있으면 제목 라벨을 문제에 붙이지 않습니다(제목이 곧 정답이 되므로).
    const leaks = norm(chunk.title).includes(norm(term)) || norm(term).includes(norm(chunk.title));
    const label = `[${chunk.unitTitle}${leaks ? '' : ' · ' + chunk.title}]`;
    const base = { chunkId: chunk.id, unit: chunk.unit, generator: 'rule' };
    // 해설 = (필요하면 머리말) + 자료 원문. 정답 공개 후 근거를 함께 보여 주려는 용도.
    const explain = (extra = '') => `${extra}${chunk.text}`;
    // 객관식은 오답 3개, O/X 는 "틀린 문장"을 만들 대체 용어 1개, 빈칸은 오답 불필요.
    const dis = qtype === 'cloze' ? [] : this.distractors(term, sentence, chunk, qtype === 'mcq' ? 3 : 1);
    // 객관식: 빈칸 문장 + 보기 4개(정답+오답 3, 순서 섞음)
    if (qtype === 'mcq' && dis.length === 3) {
      return { ...base, qtype, prompt: `${label}\n빈칸에 들어갈 말로 알맞은 것을 고르세요.\n${blank(sentence, term)}`, options: shuffle([term, ...dis], this.rng), answer: term, explanation: explain(`정답: ${term}. `) };
    }
    // O/X: 절반 확률로 원문 그대로(O), 나머지는 용어를 다른 용어로 바꿔 틀린 문장(X)으로 보여 줍니다.
    if (qtype === 'ox' && dis.length === 1) {
      const isTrue = this.rng() < 0.5;
      const shown = isTrue ? sentence : sentence.replace(re(term), dis[0]);
      return { ...base, qtype, prompt: `[${chunk.unitTitle}]\n다음 설명이 맞으면 O, 틀리면 X를 고르세요.\n${shown}`, options: ['O', 'X'], answer: isTrue ? 'O' : 'X', explanation: explain(isTrue ? '맞는 설명입니다. ' : `틀린 설명입니다. 올바른 문장: ${sentence} `) };
    }
    // 그 외(빈칸형이거나 보기를 못 만든 경우) → 빈칸 쓰기 문제
    return { ...base, qtype: 'cloze', prompt: `${label}\n빈칸에 알맞은 용어를 쓰세요.\n${blank(sentence, term)}`, options: null, answer: term, explanation: explain(`정답: ${term}. `) };
  }

  // LLM이 자료만 보고 객관식 1문제를 만들게 하고, 자료와 맞지 않으면 버립니다.
  // 버리면 null → 규칙 기반으로 대체됩니다.
  // 아래 검증은 "AI 가 만든 문제를 그대로 믿지 않는" 안전장치입니다: 형식 → 보기·정답 → 길이 → 정답 노출 → 자료 일치도.
  async llmItem(chunk) {
    // 프롬프트: 시스템(역할) + 사용자(자료 본문 + 출력 JSON 형식 + 규칙). 자료만 근거로 하라고 지시합니다.
    const system = '당신은 시험 문제 출제자입니다. 주어진 자료만 근거로 문제를 만들고, 설명 없이 JSON 객체 하나만 출력하세요.';
    const user = `[자료]\n${chunk.text}\n\n이 자료만으로 풀 수 있는 객관식 문제 1개를 만드세요.\n형식: {"question":"문제","options":["보기1","보기2","보기3","보기4"],"answer":정답 보기의 번호(0~3),"explanation":"자료에 근거한 한 문장 해설"}\n규칙: 보기는 서로 다른 4개, 정답은 자료에 있는 내용, 문제 본문에 정답 문구를 그대로 쓰지 말 것, 한국어.`;
    // 응답에서 JSON 을 꺼냄(없거나 깨졌으면 null)
    const out = extractJson(await this.llm.complete({ system, messages: [{ role: 'user', content: user }], maxTokens: 400 }));
    // 형식 검사: question 은 문자열, options 는 정확히 4개짜리 배열
    if (!out || typeof out.question !== 'string' || !Array.isArray(out.options) || out.options.length !== 4) return null;
    const options = out.options.map((o) => String(o).trim());
    // 정답 번호 ans 는 0~3 의 정수
    const ans = Number(out.answer);
    if (!Number.isInteger(ans) || ans < 0 || ans > 3) return null;
    // 보기: 빈 값·80자 초과 금지, 정규화 후 서로 달라야 함(중복 보기 금지)
    if (options.some((o) => !o || o.length > 80) || new Set(options.map(norm)).size !== 4) return null;
    const q = out.question.trim(), correct = options[ans], expl = String(out.explanation ?? '').trim();
    // 문제 5~200자, 해설 5~300자
    if (q.length < 5 || q.length > 200 || expl.length < 5 || expl.length > 300) return null;
    // 정답 문구(3자 이상)가 문제 본문에 그대로 들어 있으면 정답이 노출된 문제이므로 버림
    if (norm(q).includes(norm(correct)) && correct.length >= 3) return null; // 정답이 문제에 그대로 노출
    const hit = [{ chunk }];
    // 자료 일치도(guard.mjs 의 groundedness): 정답 보기는 0.6 이상, 해설은 0.5 이상이어야 통과. 자료와 어긋나는 AI 문제를 거릅니다.
    if (groundedness(correct, hit) < 0.6 || groundedness(expl, hit) < 0.5) return null; // 자료와 어긋남
    // 합격한 AI 문제. 해설 끝에 자료 원문을 덧붙입니다.
    return { chunkId: chunk.id, unit: chunk.unit, generator: 'llm', qtype: 'mcq', prompt: `[${chunk.unitTitle}]\n${q}`, options, answer: correct, explanation: `정답: ${correct}. ${expl}\n${chunk.text}` };
  }

  // 문제 세트 생성. 반환: 화면용 문제 배열 [{ id, qtype, prompt, options, unit, unitTitle, generator }] — 정답·해설은 없음.
  //   unit: 단원 ID / mode: 'unit'(단원 퀴즈) 또는 'review'(전체에서 약점 우선) / count: 문제 수 / ai: AI 출제 허용 여부
  async create(learnerId, { unit, mode = 'unit', count = 5, ai = true } = {}) {
    const kb = this.getKb();
    // 문제 수를 1~10 으로 제한(잘못된 값이면 5). 과도한 요청으로 AI 호출 비용이 폭증하는 것을 막습니다.
    count = Math.max(1, Math.min(10, Math.trunc(Number(count)) || 5));
    // 1) 문제 풀: 단원 모드는 그 단원의 개념만(단원이 없으면 400, 없는 단원이면 404), 복습 모드는 전체 개념.
    let pool = kb.chunks;
    if (mode !== 'review') {
      if (!unit) throw new HttpError(400, '단원을 선택해 주세요.');
      pool = pool.filter((c) => c.unit === unit);
      if (!pool.length) throw new HttpError(404, '없는 단원입니다.');
    }
    // 빈칸을 뚫을 수 있는(핵심 용어가 문장에 있는) 개념만 남깁니다. 하나도 없으면 422(처리할 수 없는 요청).
    pool = pool.filter((c) => clozeCandidates(c).length > 0);
    if (!pool.length) throw new HttpError(422, '퀴즈를 만들 수 있는 항목이 없습니다. 굵은 글씨(**용어**)로 핵심 용어를 표시해 보세요.');
    // 우선순위가 높은 개념부터, 같은 점수면 무작위
    // 2) 우선순위가 높은 개념부터, 같은 점수면 무작위
    // learning.rank 가 약점·복습 시점 도래·미학습 개념에 높은 점수를 줍니다. 점수에 0~0.05 의 작은 난수를 더해 동점일 때 매번 같은 문제만 나오지 않게 합니다.
    const ranked = this.learning.rank(learnerId, pool).map((r) => ({ ...r, score: r.score + this.rng() * 0.05 })).sort((a, b) => b.score - a.score);
    // 상위 count 개 개념 선택
    const chosen = ranked.slice(0, count).map((r) => r.chunk);
    // 3) 규칙 기반 문제 유형을 번갈아 쓰기 위한 무작위 순서(객관식·빈칸·O/X 가 고르게 섞임)
    const order = shuffle(['mcq', 'cloze', 'ox'], this.rng);
    // AI 출제는 클라우드 모델(Claude·ChatGPT)에서만 씁니다. 로컬 소형 모델은 느리고 품질이 낮아 규칙 기반 출제가 더 낫습니다.
    const useAi = ai && this.llm?.available && this.llm.provider !== 'ollama';
    // 개념마다 문제를 만듭니다(Promise.all 로 AI 호출을 동시에 진행). AI 출제가 실패/탈락하면 규칙 기반으로 대체합니다.
    const made = await Promise.all(chosen.map(async (c, i) => {
      if (useAi) {
        try { const it = await this.llmItem(c); if (it) return it; } catch { /* 규칙 기반으로 대체 */ }
      }
      return this.ruleItem(c, order[i % 3]);
    }));
    // 4) 만들지 못한 것(null)은 빼고 DB 에 저장합니다. 저장하면 문제 번호(id)가 생기고, 화면에는 정답·해설 없이 필요한 필드만 돌려줍니다.
    return made.filter(Boolean).map((it) => {
      const id = this.store.addQuizItem({ ...it, learnerId });
      const c = kb.chunks.find((x) => x.id === it.chunkId);
      return { id, qtype: it.qtype, prompt: it.prompt, options: it.options, unit: it.unit, unitTitle: c?.unitTitle ?? it.unit, generator: it.generator };
    });
  }

  // 채점: 둘 다 normalize(공백 제거·소문자)해서 비교합니다. 빈 답은 오답.
  // 빈칸(cloze)은 관대하게: 정답과 같거나, 사용자의 답이 정답 용어를 포함하되 정답 길이의 2.5배 이내이면 정답으로 봅니다
  // (예: 정답 '반품' ← 사용자 '반품이요'). 길이 제한은 아무 말이나 길게 써서 우연히 포함시키는 꼼수를 막기 위한 것입니다.
  // 객관식·O/X 는 보기와 정확히 같아야 정답입니다.
  grade(item, userAnswer) {
    const u = norm(userAnswer), a = norm(item.answer);
    if (!u) return false;
    if (item.qtype === 'cloze') return u === a || (a.length >= 2 && u.includes(a) && u.length <= a.length * 2.5);
    return u === a;
  }

  // 답안 제출 처리. 반환: { correct, correctAnswer, explanation, source, box(새 상자 번호), nextReviewDays }
  answer(learnerId, itemId, userAnswer) {
    // 1) 문제 조회 + 소유자 확인. 없거나 "내 문제가 아니면" 똑같이 404 로 응답해 남의 문제 번호가 존재하는지도 알려 주지 않습니다(IDOR 방지).
    const item = this.store.quizItem(itemId);
    if (!item || item.learner_id !== learnerId) throw new HttpError(404, '문제를 찾을 수 없습니다.');
    // 2) 이미 풀었으면 409(충돌). DB 의 recordAttempt 가 한 번 더(동시 제출 대비) 확인합니다.
    if (item.answered) throw new HttpError(409, '이미 제출한 문제입니다.');
    // 3) 답은 앞뒤 공백 제거·200자까지만. 비어 있으면 400.
    const text = String(userAnswer ?? '').trim().slice(0, 200);
    if (!text) throw new HttpError(400, '답을 입력해 주세요.');
    // 4) 채점 → 기록(풀이 + 숙련도 갱신)
    const correct = this.grade(item, text);
    const rec = this.store.recordAttempt(item, text, correct);
    // 기록 단계에서 다른 요청이 먼저 제출했다면 null → 409
    if (!rec) throw new HttpError(409, '이미 제출한 문제입니다.');
    // 5) 출처 정보(개념 제목 등)를 붙여 응답. 자료가 그 사이 삭제됐어도 오류 없이 ID 로 대체합니다(c?.).
    const c = this.getKb().chunks.find((x) => x.id === item.chunk_id);
    return {
      correct, correctAnswer: item.answer, explanation: item.explanation,
      source: { id: item.chunk_id, title: c?.title ?? item.chunk_id, unit: item.unit, unitTitle: c?.unitTitle ?? item.unit },
      box: rec.box, nextReviewDays: BOX_DAYS[rec.box],
    };
  }
}
