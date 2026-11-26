// ─────────────────────────────────────────────────────────────────────────────
// guard.mjs — 환각(hallucination) 방지 장치와 "자료 원문 발췌" 답변
//
// [환각이란] AI 가 자료에 없는 내용을 그럴듯하게 지어내는 현상. 학습 도구에서는 치명적이라
//            LLM 이 쓴 답을 그대로 믿지 않고, 아래 3가지를 코드로 검사한 뒤에만 사용자에게 보여 줍니다.
//              1) 숫자 검사   : 답변의 숫자는 자료(또는 질문)에 실제로 있어야 한다
//              2) 인용 검사   : [1] 같은 인용 번호는 제공한 자료 개수 범위 안이어야 한다
//              3) 근거 일치도 : 답변 글자 조합의 절반 이상이 자료에 등장해야 한다
//            하나라도 실패하면 chat.mjs 가 LLM 답을 버리고 extractiveAnswer(자료 원문 발췌)로 대체합니다.
//
// [hits 의 모양] 검색 결과 배열. 각 원소는 { chunk: { id, title, text, ... }, ... } (rag.mjs 참고)
// ─────────────────────────────────────────────────────────────────────────────
import { sentences, tokens } from './text.mjs';

// 근거 일치도 기준(0~1). 0.5 = 답변 바이그램의 절반 이상이 자료에 있어야 통과.
// 너무 높이면 정상적인 의역도 탈락하고, 너무 낮으면 지어낸 말이 통과하므로 중간값으로 잡았습니다.
export const GROUNDED_MIN = 0.5;

// 근거 일치도: 답변의 문자 바이그램 중 참고 문서에 실제로 등장하는 비율(질문 문구는 근거로 인정하지 않음).
// 바이그램 = 연속한 두 글자(예: '반품' → 'b:반품'). tokens() 가 만드는 토큰 중 앞글자가 'b' 인 것만 비교합니다.
// 형태소 분석 없이도 조사·어미가 달라진 표현("반품은/반품이")을 같은 것으로 보게 하려는 방식입니다.
// 반환: 0(전혀 일치 안 함)~1(전부 자료에 있음). 답변이 너무 짧아 바이그램이 없으면 0.
export function groundedness(answer, hits) {
  // ctx = 자료 제목+본문에서 나온 바이그램 집합(Set 이라 포함 여부 확인이 빠름). 질문은 일부러 넣지 않습니다.
  const ctx = new Set(tokens(hits.map((h) => h.chunk.title + ' ' + h.chunk.text).join(' ')).filter((t) => t[0] === 'b'));
  // ab = 답변의 바이그램 목록
  const ab = tokens(answer).filter((t) => t[0] === 'b');
  return ab.length ? ab.filter((t) => ctx.has(t)).length / ab.length : 0;
}

// 문자열에서 숫자 덩어리만 뽑아 문자열 배열로. "1,000"의 천 단위 쉼표를 먼저 없애 "1000" 하나로 보게 합니다.
const numbers = (s) => (String(s).replace(/(\d),(\d)/g, '$1$2').match(/\d+/g) ?? []);

// 환각 방지 검사: 숫자는 자료·질문에 있어야 하고, [n] 인용은 범위 안이어야 하며, 근거 일치도가 기준 이상이어야 합니다.
// 반환: 통과 { ok:true, cites:[인용된 자료 번호들], groundedness } / 실패 { ok:false, reason }
//   reason: 'empty'(비어 있음) 'abstain'(LLM 이 근거 부족이라 답함) 'unsupported-number:숫자들' 'bad-citation' 'ungrounded'
export function guardAnswer(answer, question, hits) {
  // 너무 짧거나 빈 답변은 쓸 수 없음
  if (!answer || answer.length < 5) return { ok: false, reason: 'empty' };
  // 시스템 프롬프트가 "근거가 없으면 '근거 부족' 이라고만 답하라"고 시켜 두었습니다. 이 신호를 받으면 억지로 답을 만들지 않고 거절합니다.
  if (/근거\s*부족/u.test(answer)) return { ok: false, reason: 'abstain' };
  // 허용 숫자 = 질문 + 참고 자료에 등장하는 숫자 전체. 답변에 이 밖의 숫자가 있으면 지어낸 것으로 봅니다.
  const allowed = new Set(numbers(question + ' ' + hits.map((h) => h.chunk.title + ' ' + h.chunk.text).join(' ')));
  // 인용 번호 [n] 들을 모읍니다(정규식 \[(\d+)\] = 대괄호 안의 숫자).
  const cites = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  // 인용 표시는 숫자 검사·일치도 계산에서 빼야 하므로 본문(body)에서 지웁니다.
  const body = answer.replace(/\[\d+\]/g, '');
  // 본문의 숫자 중 허용 목록에 없는 것(bad)이 있으면 실패
  const bad = numbers(body).filter((n) => !allowed.has(n));
  if (bad.length) return { ok: false, reason: 'unsupported-number:' + bad.join(',') };
  // 인용 번호는 1 ~ 제공한 자료 개수 사이여야 합니다(없는 자료 번호를 말하면 거짓 인용).
  if (cites.some((c) => c < 1 || c > hits.length)) return { ok: false, reason: 'bad-citation' };
  // 근거 일치도 계산(위 groundedness)
  const g = groundedness(body, hits);
  if (g < GROUNDED_MIN) return { ok: false, reason: 'ungrounded', groundedness: g };
  // 통과: 중복 제거한 인용 번호와 일치도를 돌려줍니다.
  return { ok: true, cites: [...new Set(cites)], groundedness: g };
}

// 추출형 답변: 질문과 겹치는 문장만 원문 그대로 보여 줍니다. LLM이 없어도 항상 동작하는 안전한 기본값입니다.
// 두 번째 문서의 문장은 첫 문서 못지않게 질문과 겹칠 때만 넣어, 관련 없는 문장이 끼는 것을 막습니다.
// 알고리즘: ① 상위 2개 문서의 모든 문장에 점수를 매김  ② 점수 높은 순으로 최대 maxSentences 개 고름
//           ③ 읽기 편하게 원래 순서(문서 순서, 문장 순서)로 정렬해 이어 붙임
// 반환: { text: 이어 붙인 답변, hitIndexes: 근거로 쓴 문서의 hits 내 위치 배열 }
export function extractiveAnswer(question, hits, maxSentences = 3) {
  // 질문 토큰 집합(query:true → "알려줘" 같은 군말은 뺌)
  const q = new Set(tokens(question, { query: true }));
  // scored 원소: { s: 문장, hi: 문서 순번, si: 문장 순번, overlap: 질문과 겹친 토큰 수, score }
  const scored = [];
  // 검색 상위 2개 문서만 사용(그 이상은 관련성이 떨어짐)
  hits.slice(0, 2).forEach((h, hi) => {
    sentences(h.chunk.text).forEach((s, si) => {
      // 문장 토큰 집합 → 질문 토큰과 몇 개나 겹치는지(overlap) 셉니다.
      const st = new Set(tokens(s));
      let overlap = 0;
      for (const t of q) if (st.has(t)) overlap++;
      // score = 겹친 수 ÷ √(문장 토큰 수): 긴 문장이 토큰이 많다는 이유만으로 유리해지지 않도록 길이를 보정합니다.
      scored.push({ s, hi, si, overlap, score: overlap / Math.sqrt(st.size || 1) });
    });
  });
  // 가장 높은 점수(문장이 하나도 없으면 0)
  const best = Math.max(...scored.map((x) => x.score), 0);
  // 후보: 질문과 하나라도 겹치고, (1순위 문서이거나 최고점의 70% 이상)인 문장. 점수순 정렬 후 최대 3개.
  let picked = scored.filter((x) => x.overlap > 0 && (x.hi === 0 || x.score >= best * 0.7)).sort((a, b) => b.score - a.score).slice(0, maxSentences);
  // 겹치는 문장이 하나도 없으면 1순위 문서의 첫 문장이라도 보여 줍니다(빈 답변 방지).
  if (!picked.length) picked = scored.filter((x) => x.hi === 0).slice(0, 1);
  // 읽는 순서대로: 문서 번호 → 문장 번호 순
  picked.sort((a, b) => a.hi - b.hi || a.si - b.si);
  // 답변 = 선택 문장을 공백으로 이음. hitIndexes = 쓰인 문서 번호(중복 제거) → chat.mjs 가 근거 출처로 표시
  return { text: picked.map((p) => p.s).join(' '), hitIndexes: [...new Set(picked.map((p) => p.hi))] };
}
