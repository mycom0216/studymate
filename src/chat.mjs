// ─────────────────────────────────────────────────────────────────────────────
// chat.mjs — 학습 챗봇(RAG) 한 번의 질문-답변 흐름
//
// [RAG 란?]  Retrieval-Augmented Generation(검색 증강 생성). AI 가 기억에 의존해 지어내지 않도록
//            "① 내 자료에서 관련 부분을 먼저 검색 → ② 그 부분만 근거로 답변 생성" 순서로 일하게 하는 방식.
//
// [ask() 전체 흐름]
//   1) 질문 길이 검사(2~500자)
//   2) 개인정보 마스킹(maskPII)  → 저장·LLM 전달 전에 전화/이메일/카드/주민번호를 가림
//   3) 검색(retriever.search)    → 관련 자료 조각(hits)과 "근거가 있다고 믿는 정도"(confidence, 0~1)
//   4) confidence < threshold   → 근거 없음: 지어내지 않고 정중히 거절(NO_EVIDENCE)
//      그 외 LLM 이 있으면 → LLM 답변 생성 → guardAnswer(환각 검사) 통과하면 채택
//                            통과 못 하면 자료 원문 발췌(extractiveAnswer)로 대체하고 note 로 이유를 알림
//      LLM 이 없거나 연결 실패 → 자료 원문 발췌로 답변
//   5) 질문·답변·근거·응답시간을 DB 에 기록(운영 지표·다음 질문의 대화 맥락용)
//   6) 화면에 보여 줄 형태(답변, 근거 출처, 신뢰도, 관련 항목)로 반환
//
// [generator 값의 의미]  'llm' = AI 가 쓴 답  /  'extractive' = 자료 원문 발췌  /  'none' = 답변 거절
// ─────────────────────────────────────────────────────────────────────────────
import { HttpError } from './errors.mjs';
import { extractiveAnswer, guardAnswer } from './guard.mjs';
import { maskPII } from './text.mjs';

// 자료에서 근거를 못 찾았을 때 보여 주는 거절 문구. 틀린 답을 그럴듯하게 내놓는 것보다 "모른다"고 말하는 편이 학습 도구로서 안전합니다.
const NO_EVIDENCE = '올려 두신 학습 자료에서 이 질문의 근거를 찾지 못했어요. 질문을 조금 더 구체적으로 바꾸거나, 자료함에 관련 자료를 추가해 보세요.';

// getKb: 현재 지식베이스를 돌려주는 함수 / store: DB 저장소 / llm: LLM 어댑터 / threshold: 거절 기준 신뢰도
// (app.mjs 가 실제로는 0.3 을 넘겨 줍니다. 여기 기본값 0.2 는 값을 안 넘겼을 때만 쓰임)
export class ChatService {
  // Object.assign(this, {...}) 는 받은 값들을 같은 이름의 인스턴스 속성으로 한꺼번에 저장하는 줄임 표기입니다.
  constructor({ getKb, store, llm, threshold = 0.2 }) { Object.assign(this, { getKb, store, llm, threshold }); }

  // 질문 하나를 처리합니다. 반환 객체: { id(기록 번호), answer, generator, confidence, sources[], note, piiMasked[], related[], latencyMs }
  //   learnerId  질문한 학습자 ID / question  사용자가 입력한 질문 / level 'easy'면 초보자용 쉬운 설명 모드
  async ask(learnerId, question, { level = 'normal' } = {}) {
    const q = String(question ?? '').trim();
    // 길이 제한: 너무 짧으면 검색 의미가 없고, 너무 길면 LLM 비용·프롬프트 주입 시도 부담이 커집니다.
    if (q.length < 2 || q.length > 500) throw new HttpError(400, '질문은 2~500자로 입력해 주세요.');
    // 응답 시간 측정용 시작 시각(밀리초)
    const t0 = Date.now();
    // 2단계: found 는 "어떤 종류의 개인정보를 가렸는지" 목록(예: ['전화번호'])이라 화면에 안내할 수 있습니다.
    // 이후로는 원문 q 가 아니라 masked 만 사용하므로 DB 와 LLM 어디에도 원문 개인정보가 가지 않습니다.
    const { masked, found } = maskPII(q); // 외부 LLM에 개인정보가 나가지 않도록 먼저 가립니다
    const { retriever } = this.getKb();
    // 3단계: 상위 4개 자료 조각을 가져옵니다. hits 항목은 { chunk, bm25, coverage, cosine, fused } 형태(rag.mjs 참고).
    const { hits, confidence } = await retriever.search(masked, 4);
    // 화면에 "함께 보면 좋은 항목"으로 보여 줄 때 필요한 최소 정보만 추려 내는 도우미(본문 text 는 제외).
    const related = (list) => list.map((h) => ({ id: h.chunk.id, title: h.chunk.title, unit: h.chunk.unit, unitTitle: h.chunk.unitTitle }));
    // answer: 최종 답변 / generator: 누가 만들었나 / used: 실제 근거로 쓴 자료 조각들 / note: 사용자에게 알릴 안내(대체 사유)
    let answer, generator, used = [], note = null;

    // 4단계 A: 신뢰도가 기준보다 낮다 = 자료에 답이 없다고 판단 → 거절(LLM 호출 자체를 하지 않아 비용·환각 위험 모두 줄임)
    if (confidence < this.threshold) {
      answer = NO_EVIDENCE; generator = 'none';
    } else {
      // LLM 에는 상위 3개만 근거로 줍니다(길어질수록 비용↑·산만해짐).
      const ctx = hits.slice(0, 3);
      let g = null;
      // 4단계 B: LLM 사용 가능할 때만 시도.
      if (this.llm?.available) {
        try {
          // 직전 대화 2개(history)를 함께 보내 "그건 왜?" 같은 후속 질문을 이해시킵니다.
          const raw = await this.llm.answer(masked, ctx, { history: this.store.recentQA(learnerId, 2), level });
          // 환각 방지 검사. 결과 g: { ok, reason, cites[], groundedness } (guard.mjs 참고)
          g = guardAnswer(raw, masked, ctx);
          // 통과: 본문의 [1] 같은 인용 표시는 화면에 따로 근거 목록을 보여 주므로 지우고, 인용된 자료만 근거로 삼습니다(인용이 없으면 1순위 자료).
          if (g.ok) { answer = raw.replace(/\s*\[\d+\]/g, '').trim(); generator = 'llm'; used = g.cites.length ? g.cites.map((n) => ctx[n - 1]) : ctx.slice(0, 1); }
          else if (g.reason === 'abstain') { answer = NO_EVIDENCE; generator = 'none'; } // LLM이 자료에 근거가 없다고 판단 → 억지로 원문을 내밀지 않고 거절
          // 검사 실패: LLM 답을 버리고(아래 4단계 C 에서 원문 발췌로 대체) 이유(g.reason)를 안내 문구로 남깁니다.
          else note = `AI 답변이 근거 검사를 통과하지 못해 자료 원문으로 대신했어요(${g.reason}).`;
        // LLM 호출 자체가 실패(네트워크·타임아웃·키 오류 등): 서비스가 멈추지 않도록 원문 발췌로 대체합니다.
        } catch { note = 'AI 서버에 연결하지 못해 자료 원문으로 대신했어요.'; }
      }
      // 4단계 C: 아직 답이 정해지지 않았다면(LLM 없음/실패/검사 탈락) 질문과 겹치는 자료 문장을 그대로 보여 줍니다(항상 동작하는 안전한 기본값).
      if (!answer) { const ex = extractiveAnswer(masked, ctx); answer = ex.text; generator = 'extractive'; used = ex.hitIndexes.map((i) => ctx[i]); }
    }

    // 화면용 근거 목록: n 은 1부터 시작하는 번호, text 는 클릭하면 볼 수 있는 원문입니다.
    const sources = used.map((h, i) => ({ n: i + 1, id: h.chunk.id, title: h.chunk.title, unit: h.chunk.unit, unitTitle: h.chunk.unitTitle, text: h.chunk.text }));
    // 거절('none')이 아니면 "답변했다"로 집계 → 운영 지표의 "근거 있는 답변 비율"이 됩니다.
    const answered = generator !== 'none';
    // 5단계: 기록 저장. unit(단원)은 어느 단원 질문이 많은지 통계 내려는 용도이며 거절한 질문은 null 로 둡니다.
    // 질문은 마스킹된 문장(masked)만 저장합니다. sources 에는 근거 조각의 ID 만 넣습니다.
    const qaId = this.store.addQA({
      learnerId, question: masked, answer, generator, confidence, unit: answered ? used[0]?.chunk.unit ?? hits[0].chunk.unit : null,
      sources: sources.map((s) => s.id), answered, latencyMs: Date.now() - t0,
    });
    // 6단계: 근거로 쓰지 않은 나머지 검색 결과 중 최대 3개를 "관련 항목"으로 제안합니다. confidence 는 소수 둘째 자리까지 반올림.
    const usedIds = new Set(used.map((h) => h.chunk.id));
    return {
      id: qaId, answer, generator, confidence: Math.round(confidence * 100) / 100, sources, note,
      piiMasked: found, related: related(hits.filter((h) => !usedIds.has(h.chunk.id)).slice(0, 3)),
      latencyMs: Date.now() - t0,
    };
  }
}
