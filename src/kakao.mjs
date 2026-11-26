// ─────────────────────────────────────────────────────────────────────────────
// kakao.mjs — 카카오톡 챗봇 연동(카카오 i 오픈빌더 "스킬 서버" 어댑터)
//
// [스킬 서버란] 카카오톡 챗봇에서 사용자가 말을 걸면 카카오 서버가 우리 서버(/kakao/skill)에 POST 로
//               발화를 전달하고, 우리가 정해진 JSON 형식으로 답하면 카카오가 사용자 화면에 보여 줍니다.
// [이 파일이 하는 일] 카카오 형식의 요청을 꺼내 → 같은 RAG 챗봇(chat.ask)을 부르고 → 카카오 응답 형식으로 포장합니다.
// [보안·안정성] 사용자 ID 해시 저장 / 공유 토큰 검사(timing-safe) / 도배 방지 / 4.5초 타임아웃 / 오류여도 HTTP 200
// (실제 카카오 채널 연결은 이 개발 환경에서 검증하지 못했고 형식은 자동 테스트로만 확인했습니다.)
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.mjs';

// 카카오 i 오픈빌더 "스킬 서버" 어댑터.
// 요청: { userRequest: { utterance, user: { id } } }  →  응답: { version: '2.0', template: { outputs, quickReplies } }
// 카카오는 스킬 응답을 약 5초 안에 기다리므로 시간이 넘으면 안내 문구로 대신합니다.
// 오류가 나도 HTTP 200 + 안내 문구로 응답합니다(200이 아니면 사용자 화면에 아무것도 표시되지 않음).

// simpleText 한 말풍선의 최대 글자 수(카카오 규격). 넘으면 잘라 '…' 을 붙입니다.
const TEXT_LIMIT = 1000; // simpleText 최대 글자 수
// 카카오 스킬 응답 대기 한도(약 5초)보다 약간 짧게 잡아, 우리가 먼저 안내 문구로 답할 시간을 남깁니다.
const TIMEOUT_MS = 4500;
const TIMEOUT_MSG = '답변을 만드는 데 시간이 걸리고 있어요. 잠시 뒤 같은 질문을 다시 보내 주세요.';

// 카카오 응답 포장: 본문 text(+ 선택적 빠른 답장 버튼 quickReplies). 글이 너무 길면 자릅니다.
// 빠른 답장이 없으면 quickReplies 키 자체를 넣지 않습니다(스프레드 ...({}) 로 조건부 추가).
const reply = (text, quickReplies = []) => ({
  version: '2.0',
  template: {
    outputs: [{ simpleText: { text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text } }],
    ...(quickReplies.length ? { quickReplies } : {}),
  },
});

// 카카오 사용자 ID는 원문을 저장하지 않고 해시한 값으로 학습자 ID를 만듭니다.
// SHA-256 해시의 앞 24글자(16진수)에 'kakao-' 를 붙여 사용 — 되돌릴 수 없어 DB 가 유출돼도 카카오 ID 가 드러나지 않고,
// 앞의 'kakao-' 덕분에 http.mjs 의 learnerId 형식(영문/숫자/-, 6~64자)과도 맞습니다.
export const learnerIdOf = (kakaoUserId) => `kakao-${createHash('sha256').update(String(kakaoUserId)).digest('hex').slice(0, 24)}`;

// 공유 비밀값(KAKAO_SKILL_TOKEN)이 설정돼 있으면 스킬 URL의 ?token= 값과 일치해야 합니다.
// 설정이 없으면 항상 통과(로컬 개발 편의). timingSafeEqual 은 "걸린 시간"으로 비밀값을 추측하는 공격(타이밍 공격)을 막는
// 상수 시간 비교이며, 길이가 다르면 비교 함수가 오류를 내므로 길이부터 확인합니다.
export function tokenOk(expected, given) {
  if (!expected) return true;
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 스킬 요청 본문(body)을 처리해 카카오 응답 객체를 돌려줍니다. 어떤 경우에도 예외를 밖으로 던지지 않습니다.
//   body 모양: { userRequest: { utterance: 사용자 발화, user: { id } } }
//   lastAsk: 도배 방지용 Map(학습자 ID → 마지막 질문 시각) / timeoutMs: 응답 대기 한도
export async function kakaoSkill(svc, body, { lastAsk = new Map(), timeoutMs = TIMEOUT_MS } = {}) {
  // 1) 입력 꺼내기: ?. 로 중간 값이 없어도 오류 없이 빈 값 처리
  const utterance = String(body?.userRequest?.utterance ?? '').trim();
  const kakaoId = body?.userRequest?.user?.id;
  if (!kakaoId) return reply('사용자 정보를 확인하지 못했어요.');
  if (!utterance) return reply('궁금한 내용을 입력해 주세요.');

  // 2) 사용자 ID 를 해시한 학습자 ID 로 바꿉니다.
  const id = learnerIdOf(kakaoId);
  const now = Date.now();
  // 3) 도배 방지: 같은 사람이 0.8초 안에 다시 보내면 안내 문구. Map 이 5000명을 넘으면 비웁니다(메모리 보호).
  if (now - (lastAsk.get(id) ?? 0) < 800) return reply('잠시 후 다시 질문해 주세요.');
  lastAsk.set(id, now);
  if (lastAsk.size > 5000) lastAsk.clear();

  // 4) 질문 처리. 학습자 행이 없으면 만들고(이름은 빈 값 → '학습자')
  try {
    svc.store.ensureLearner(id, '');
    let timer;
    // 타임아웃 경주: 챗봇 답변과 "4.5초 뒤 null" 중 먼저 끝난 쪽을 채택합니다. 시간이 지나면 null → 안내 문구.
    // (늦게 끝난 답변은 버려지지만 기록은 남습니다. 사용자는 같은 질문을 다시 보내면 됩니다.)
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const r = await Promise.race([svc.chat.ask(id, utterance), timeout]);
    // 먼저 끝났으면 타이머 정리(불필요하게 Node 프로세스를 붙잡지 않도록)
    clearTimeout(timer);
    if (!r) return reply(TIMEOUT_MSG);
    // 근거가 있으면 답변 아래 "📚 근거: 제목들"을 붙입니다. 관련 항목은 빠른 답장 버튼(라벨 14자 제한, 최대 3개)으로 만들고
    // 누르면 "{제목}에 대해 알려줘" 가 다시 질문으로 전송됩니다.
    const src = r.sources.length ? `\n\n📚 근거: ${r.sources.map((s) => s.title).join(', ')}` : '';
    const quick = r.related.slice(0, 3).map((h) => ({ label: h.title.slice(0, 14), action: 'message', messageText: `${h.title}에 대해 알려줘` }));
    return reply(r.answer + src, quick);
  } catch (e) {
    // 질문이 너무 짧거나 긴 경우(HttpError 400)는 친절한 안내, 그 외 오류는 서버 로그에만 남기고 일반 안내 문구로 응답합니다.
    if (e instanceof HttpError && e.status === 400) return reply('질문은 2~500자로 입력해 주세요.');
    console.error(e);
    return reply('일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주세요.');
  }
}
