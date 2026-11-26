// ─────────────────────────────────────────────────────────────────────────────
// errors.mjs — "HTTP 상태 코드가 붙은 오류" 한 종류만 정의합니다.
//
// 서비스 코드(chat/quiz/db 등)는 HTTP 를 직접 다루지 않고 `throw new HttpError(404, '메시지')` 처럼
// "무슨 일이 왜 실패했는지"만 던집니다. 맨 바깥 요청 처리기(http.mjs)가 이를 잡아
// status 를 HTTP 응답 코드로, message 를 사용자에게 보이는 오류 문구로 바꿉니다.
// HttpError 가 아닌 예외(예상 못 한 버그)는 500 으로 처리되고 상세 내용은 사용자에게 숨겨집니다.
// ─────────────────────────────────────────────────────────────────────────────
export class HttpError extends Error {
  // status: 400(잘못된 요청) 404(없음) 409(충돌) 413(너무 큼) 429(너무 자주) 등 HTTP 상태 코드
  constructor(status, message) { super(message); this.status = status; }
}
