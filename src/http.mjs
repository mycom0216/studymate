// ─────────────────────────────────────────────────────────────────────────────
// http.mjs — HTTP 요청 처리기: API 라우팅 + 정적 파일 제공 + 카카오 스킬 + 오류 변환
//
// [요청이 처리되는 길]  (맨 아래 createHandler 가 반환하는 함수)
//     /kakao/skill      → 토큰 검사 → kakao.mjs 의 kakaoSkill
//     /api/...          → api() 함수의 if 문들(라우팅: 메서드+경로로 어떤 기능을 부를지 고름)
//     그 외(/, /app.js)  → public/ 폴더의 파일을 그대로 전송(정적 파일)
//     어디서든 throw 된 오류 → 맨 아래 catch 에서 상태 코드·JSON 으로 변환
//
// [이 파일이 지키는 보안 장치]
//     · 요청 본문 크기 제한(readBody) — 엔드포인트마다 다른 한도, 초과 시 413
//     · 학습자 ID 형식 검사(learnerOf) — 영문/숫자/_/- 6~64자만 허용
//     · 질문 도배 방지(lastAsk: 학습자당 0.8초에 1회) — 외부 LLM 호출 비용 남용 방지
//     · 경로 이탈(directory traversal) 차단 — '..' 포함 경로 거부
//     · 카카오 스킬 토큰 비교(timing-safe)  · nosniff 헤더  · 500 오류 내용 숨김
//     · 소유자 검사(IDOR 방지)는 서비스 계층이 합니다: 퀴즈 답안은 quiz.answer 가, 피드백은 db.setFeedback 이
//       learnerId 가 일치하는 기록만 다룹니다.
//   주의: 이 앱은 로그인이 없습니다. learnerId 는 "브라우저가 만든 무작위 ID"일 뿐 비밀번호가 아니므로,
//         ID 를 아는 사람은 그 학습자의 기록을 볼 수 있습니다(개인 실습/데모용 설계).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { ROOT } from './app.mjs';
import { HttpError } from './errors.mjs';
import { kakaoSkill, tokenOk } from './kakao.mjs';

// 확장자 → Content-Type(브라우저가 파일 종류를 알도록). 목록에 없는 확장자는 'application/octet-stream'(내려받기용 바이너리)로 처리.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
// JSON 응답 도우미. no-store: 학습 기록이 브라우저/중간 서버에 캐시되어 오래된 값이 보이지 않게 합니다.
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
// 요청 본문을 읽어 JSON 객체로 돌려줍니다. limit 은 허용 최대 바이트 수.
// 본문이 없으면 빈 객체 {}, JSON 이 깨졌으면 400, 한도를 넘으면 413.
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0, tooBig = false; const parts = [];
  // 한도를 넘으면 본문은 버리고 끝까지 읽은 뒤 413으로 응답합니다(destroy하면 응답 없이 연결이 끊김).
  // 조각(chunk) 단위로 도착하는 본문을 모읍니다. 한도를 넘은 뒤에는 더 모으지 않아 메모리 폭증을 막습니다.
  req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else if (!tooBig) parts.push(c); });
  // 다 받은 뒤: 한도 초과면 413 거절, 아니면 조각을 합쳐 UTF-8 문자열 → JSON.parse.
  req.on('end', () => {
    if (tooBig) return reject(new HttpError(413, '요청이 너무 큽니다.'));
    try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.')); }
  });
});

// 학습자 ID 허용 형식: 글자·숫자·밑줄·하이픈 6~64자. 이상한 문자가 DB·로그·경로에 섞이는 것을 막습니다.
const ID = /^[\w-]{6,64}$/u;
// 입력값을 문자열로 바꿔 형식 검사. 통과하면 그 ID 를 돌려주고, 아니면 400 을 던집니다.
const learnerOf = (src) => {
  const id = String(src ?? '');
  if (!ID.test(id)) throw new HttpError(400, 'learnerId가 필요합니다.');
  return id;
};
// 표시 이름 정리: 제어문자(\u0000-\u001f)와 < > 를 제거(HTML 태그 삽입 시도 방지의 1차 방어)하고 앞뒤 공백 제거, 최대 20자.
// (화면에서는 textContent 로만 출력해 2차 방어를 합니다 — public/app.js 참고)
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f<>]/gu, '').trim().slice(0, 20);

// 서비스 묶음(svc)을 받아 Node http 서버용 요청 처리기를 만듭니다.
export function createHandler(svc) {
  // 카카오 사용자별 마지막 질문 시각(도배 방지). 메모리에만 있어 서버를 끄면 초기화됩니다.
  const kakaoLastAsk = new Map();
  const lastAsk = new Map(); // 학습자당 0.8초에 1회 질문(외부 LLM 호출 남용 방지)

  // /api/ 경로 전용 라우터. m = HTTP 메서드, p = 경로. mm 은 정규식으로 경로에서 번호(:id)를 꺼낼 때 쓰는 임시 변수.
  // 반환은 항상 json(...) 응답이며, 처리할 수 없으면 맨 끝에서 404 를 던집니다.
  async function api(req, res, url) {
    const m = req.method, p = url.pathname;
    let mm;
    // GET /api/status — 서버 상태(자료 수·검색 방식·LLM 연결 여부). API 키 값은 절대 포함하지 않습니다(lastError 는 160자로 잘린 오류 요약).
    if (m === 'GET' && p === '/api/status') {
      return json(res, 200, {
        chunks: svc.kb.chunks.length, units: svc.kb.units.length, retrieval: svc.kb.retriever.mode,
        llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError,
      });
    }
    // GET /api/units — 단원 목록
    if (m === 'GET' && p === '/api/units') return json(res, 200, svc.kb.units);
    // GET /api/kb — 자료함 목록. 화면 표시에 필요한 필드만 골라 내보냅니다(구조분해로 불필요한 내부 필드 제외).
    if (m === 'GET' && p === '/api/kb') return json(res, 200, svc.kb.chunks.map(({ id, title, unit, unitTitle, text, user }) => ({ id, title, unit, unitTitle, text, user })));
    // GET /api/kb/search?q= — 검색 디버그/데모용. 질의는 200자까지만 받고, 점수와 신뢰도를 보여 줍니다.
    if (m === 'GET' && p === '/api/kb/search') {
      const q = String(url.searchParams.get('q') ?? '').slice(0, 200);
      const { hits, confidence } = await svc.kb.retriever.search(q, 5);
      return json(res, 200, { confidence, hits: hits.map((h) => ({ id: h.chunk.id, title: h.chunk.title, unitTitle: h.chunk.unitTitle, score: h.fused })) });
    }
    // GET /api/stats — 전체 운영 지표(개인 식별 정보 없음, 합계만)
    if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());

    // POST /api/learners — 학습자 등록/이름 갱신. 본문 한도 2000바이트.
    if (m === 'POST' && p === '/api/learners') {
      const b = await readBody(req, 2000);
      return json(res, 200, svc.store.ensureLearner(learnerOf(b.learnerId), cleanName(b.name)));
    }
    // POST /api/chat — 챗봇 질문. 본문 한도 4000바이트.
    // 도배 방지: 같은 학습자가 0.8초 안에 다시 보내면 429. Map 이 5000명을 넘으면 비워 메모리가 무한히 늘지 않게 합니다.
    if (m === 'POST' && p === '/api/chat') {
      const b = await readBody(req, 4000);
      const id = learnerOf(b.learnerId);
      const now = Date.now();
      if (now - (lastAsk.get(id) ?? 0) < 800) throw new HttpError(429, '잠시 후 다시 질문해 주세요.');
      lastAsk.set(id, now);
      if (lastAsk.size > 5000) lastAsk.clear();
      svc.store.ensureLearner(id, cleanName(b.name));
      return json(res, 200, await svc.chat.ask(id, b.question, { level: b.level === 'easy' ? 'easy' : 'normal' }));
    }
    // POST /api/chat/:번호/feedback — 도움됨(true)/아님(false) 평가. helpful 은 반드시 불리언이어야 하고,
    // 남의 기록이면 db.setFeedback 이 false 를 돌려줘 404 로 처리합니다(IDOR 방지).
    if (m === 'POST' && (mm = /^\/api\/chat\/(\d+)\/feedback$/u.exec(p))) {
      const b = await readBody(req, 1000);
      if (typeof b.helpful !== 'boolean') throw new HttpError(400, 'helpful(true/false)이 필요합니다.');
      if (!svc.store.setFeedback(Number(mm[1]), learnerOf(b.learnerId), b.helpful)) throw new HttpError(404, '질문을 찾을 수 없습니다.');
      return json(res, 200, { ok: true });
    }
    // POST /api/quiz — 퀴즈 생성. mode 는 'review' 아니면 'unit' 으로 강제(그 밖의 값 무시), ai 는 false 로 명시했을 때만 끕니다.
    // 응답 items 에는 정답이 없습니다(quiz.create 가 화면용 필드만 반환).
    if (m === 'POST' && p === '/api/quiz') {
      const b = await readBody(req, 2000);
      const id = learnerOf(b.learnerId);
      svc.store.ensureLearner(id, cleanName(b.name));
      const items = await svc.quiz.create(id, { unit: b.unit, mode: b.mode === 'review' ? 'review' : 'unit', count: b.count, ai: b.ai !== false });
      return json(res, 200, { items });
    }
    // POST /api/quiz/:번호/answer — 채점. 소유자·중복 제출 검사는 quiz.answer 안에서 합니다.
    if (m === 'POST' && (mm = /^\/api\/quiz\/(\d+)\/answer$/u.exec(p))) {
      const b = await readBody(req, 1000);
      return json(res, 200, svc.quiz.answer(learnerOf(b.learnerId), Number(mm[1]), b.answer));
    }
    // GET /api/progress, /api/recommend — 내 학습현황, 오늘의 학습 추천(둘 다 learnerId 쿼리 필수)
    if (m === 'GET' && p === '/api/progress') return json(res, 200, svc.learning.progress(learnerOf(url.searchParams.get('learnerId'))));
    if (m === 'GET' && p === '/api/recommend') return json(res, 200, svc.learning.recommend(learnerOf(url.searchParams.get('learnerId'))));

    // POST /api/materials — 내 자료 추가. 본문 한도 40000바이트(자료 글자 수 한도 30000자보다 넉넉하게 잡은 값).
    // 입력이 부적합하면 kb.mjs 가 던진 일반 Error 를 400 으로 바꿔 사용자에게 이유를 알려 줍니다.
    if (m === 'POST' && p === '/api/materials') {
      const b = await readBody(req, 40000);
      try { return json(res, 200, { unit: await svc.addMaterial(b.title, b.text), units: svc.kb.units }); }
      catch (e) { throw new HttpError(400, e.message); }
    }
    // DELETE /api/materials/u숫자 — 내 자료 삭제. 경로 정규식이 'u+숫자'만 허용해 기본 자료나 임의 파일명은 애초에 매칭되지 않습니다.
    if (m === 'DELETE' && (mm = /^\/api\/materials\/(u\d+)$/u.exec(p))) {
      if (!(await svc.removeMaterial(mm[1]))) throw new HttpError(404, '삭제할 수 있는 자료가 아닙니다(기본 자료는 삭제할 수 없어요).');
      return json(res, 200, { ok: true });
    }
    // 어떤 경로에도 맞지 않으면 404
    throw new HttpError(404, '없는 API입니다.');
  }

  // 최종 요청 처리기(서버가 요청마다 호출). 모든 예외를 맨 아래 catch 에서 한 곳으로 모읍니다.
  return async (req, res) => {
    try {
      // req.url 은 경로만 담고 있어 URL 객체로 파싱하려면 임의의 기준 주소가 필요합니다(실제 값은 쓰이지 않음).
      const url = new URL(req.url, 'http://localhost');
      // 카카오 스킬: POST 만, 토큰이 설정돼 있으면 일치해야 함(401). 본문이 깨져도 오류 대신 빈 요청으로 처리해 카카오 쪽에는 항상 정상 응답을 줍니다.
      if (url.pathname === '/kakao/skill') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST만 지원합니다.');
        if (!tokenOk(process.env.KAKAO_SKILL_TOKEN, url.searchParams.get('token'))) throw new HttpError(401, '인증에 실패했습니다.');
        let body = {};
        try { body = await readBody(req, 20000); } catch { /* 잘못된 본문은 빈 요청으로 처리 → 안내 문구 */ }
        return json(res, 200, await kakaoSkill(svc, body, { lastAsk: kakaoLastAsk }));
      }
      // API 요청은 위 라우터로
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      // 정적 파일: ① '/' 는 index.html ② normalize 로 '/a/../b' 같은 경로를 정리 ③ 앞쪽 '/' 제거(join 이 루트 밖으로 못 나가게)
      // ④ 그래도 '..' 가 남아 있으면 403. public/ 폴더 밖의 파일(.env, data/ 등)은 이 경로로 읽을 수 없습니다.
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/u, '');
      if (rel.includes('..')) throw new HttpError(403, '접근할 수 없습니다.');
      // 파일 읽기 실패(없음)는 404 로. 오류 상세(파일 경로)를 노출하지 않습니다.
      let file;
      try { file = readFileSync(join(ROOT, 'public', rel)); } catch { throw new HttpError(404, '찾을 수 없습니다.'); }
      // nosniff: 브라우저가 내용을 추측해 다른 형식(예: 스크립트)으로 실행하지 못하게 합니다.
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      res.end(file);
    // 오류 처리: HttpError 면 그 상태 코드, 그 외는 500. 500 은 서버 로그에만 자세히 남기고 사용자에게는 일반 문구만 보냅니다(내부 정보 노출 방지).
    // API 요청은 JSON {error}, 화면 요청은 평문으로 응답.
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (req.url.startsWith('/api/')) json(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : e.message });
      else { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message); }
    }
  };
}
