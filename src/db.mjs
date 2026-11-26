// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — SQLite 저장소(학습자·질문기록·퀴즈·풀이기록·숙련도)
//
// [SQLite]  파일 하나로 동작하는 작은 데이터베이스. Node.js 24 내장 node:sqlite 를 쓰므로 npm 설치가 필요 없습니다.
//           DatabaseSync 는 "동기식"(결과가 즉시 반환, await 불필요)이라 코드가 단순합니다.
//
// [테이블]
//   learners     학습자(id, 이름)           — 로그인 대신 브라우저가 만든 임의 ID 로 구분
//   qa_log       챗봇 질문·답변 기록(+ 도움됨/아님 피드백, 응답시간, 근거 조각 ID 목록)
//   quiz_items   생성된 퀴즈 문제(정답 포함 — 서버에만 있고, 화면에는 정답 없이 내려줌)
//   attempts     학습자의 풀이 기록(맞았는지)
//   mastery      (학습자, 개념) 별 숙련도: 라이트너 상자 번호, 다음 복습 시각, 시도/정답 횟수
//
// [보안] 모든 SQL 은 `?` 자리표시자(prepared statement)로 값을 넘깁니다. 사용자 입력이 SQL 문장에
//        섞이지 않으므로 SQL 인젝션이 불가능합니다. 학습자별 조회는 항상 learner_id 조건을 겁니다.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

// 테이블 정의(맨 아래 CREATE INDEX 두 줄은 학습자별 조회가 기록이 많아져도 빠르도록 learner_id 에 거는 인덱스). IF NOT EXISTS 라서 서버를 몇 번 켜도(이미 있어도) 안전합니다.
// 시각(created_at)은 ISO 문자열, 복습 시각(due_at/last_at)은 계산하기 쉬운 "밀리초 숫자"로 저장합니다.
// 불리언(answered, correct)은 SQLite 에 불리언형이 없어 0/1 정수로 저장합니다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS learners (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, learner_id TEXT NOT NULL, created_at TEXT NOT NULL,
  question TEXT NOT NULL, answer TEXT NOT NULL, generator TEXT NOT NULL, confidence REAL NOT NULL,
  unit TEXT, sources TEXT NOT NULL DEFAULT '[]', answered INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER NOT NULL DEFAULT 0, feedback INTEGER
);
CREATE TABLE IF NOT EXISTS quiz_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, learner_id TEXT NOT NULL, created_at TEXT NOT NULL,
  chunk_id TEXT NOT NULL, unit TEXT NOT NULL, qtype TEXT NOT NULL, generator TEXT NOT NULL,
  prompt TEXT NOT NULL, options TEXT, answer TEXT NOT NULL, explanation TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, learner_id TEXT NOT NULL, created_at TEXT NOT NULL,
  item_id INTEGER NOT NULL, chunk_id TEXT NOT NULL, unit TEXT NOT NULL, qtype TEXT NOT NULL,
  user_answer TEXT NOT NULL, correct INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mastery (
  learner_id TEXT NOT NULL, chunk_id TEXT NOT NULL, box INTEGER NOT NULL, due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
  PRIMARY KEY (learner_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_att_learner ON attempts(learner_id);
CREATE INDEX IF NOT EXISTS idx_qa_learner ON qa_log(learner_id);
`;

// 라이트너 상자: 맞히면 상자가 올라가 복습 간격이 늘고, 틀리면 1번 상자(즉시 복습)로 돌아갑니다.
// (라이트너 시스템 = 간격 반복 학습법. 잘 아는 것은 드물게, 헷갈리는 것은 자주 복습합니다.)
export const BOX_DAYS = [0, 0, 1, 3, 7, 14]; // 인덱스 = 상자 번호(1~5)
// 하루를 밀리초로 나타낸 값(24*60*60*1000)
const DAY = 86400000;

// DB 를 엽니다(file 이 ':memory:' 면 메모리 DB). WAL 모드는 읽기·쓰기가 서로 덜 막히게 하는 SQLite 저널 방식이고,
// foreign_keys=ON 은 외래키 제약을 켭니다. 마지막에 테이블이 없으면 만듭니다.
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// 모든 DB 입출력을 모은 클래스. now 를 주입받아 테스트에서 시간을 마음대로 돌릴 수 있게 했습니다(복습 주기 테스트용).
export class Store {
  constructor(db, now = () => Date.now()) { this.db = db; this.now = now; }

  // 현재 시각을 ISO 8601 문자열(예: 2026-01-01T00:00:00.000Z)로
  iso() { return new Date(this.now()).toISOString(); }

  // 학습자가 없으면 만들고, 있으면 이름이 바뀐 경우에만 갱신합니다(멱등: 여러 번 불러도 결과 동일). 이름이 비면 '학습자'.
  ensureLearner(id, name) {
    const row = this.db.prepare('SELECT * FROM learners WHERE id = ?').get(id);
    if (!row) {
      this.db.prepare('INSERT INTO learners (id, name, created_at) VALUES (?,?,?)').run(id, name || '학습자', this.iso());
      return { id, name: name || '학습자' };
    }
    if (name && name !== row.name) this.db.prepare('UPDATE learners SET name = ? WHERE id = ?').run(name, id);
    return { id, name: name || row.name };
  }

  // 챗봇 질문·답변 1건 저장. r.sources(근거 조각 ID 배열)는 JSON 문자열로 저장하고, 생성된 기록 번호를 돌려줍니다.
  addQA(r) {
    const info = this.db.prepare(`INSERT INTO qa_log (learner_id, created_at, question, answer, generator, confidence, unit, sources, answered, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.learnerId, this.iso(), r.question, r.answer, r.generator, r.confidence, r.unit ?? null, JSON.stringify(r.sources), r.answered ? 1 : 0, r.latencyMs);
    return Number(info.lastInsertRowid);
  }

  // 최근 n개의 (질문, 답변) — LLM 에게 대화 맥락으로 줍니다. "답변된 것만" 가져오고, 최신순으로 뽑은 뒤 reverse()로 시간순으로 되돌립니다.
  recentQA(learnerId, n = 2) {
    return this.db.prepare('SELECT question, answer FROM qa_log WHERE learner_id = ? AND answered = 1 ORDER BY id DESC LIMIT ?').all(learnerId, n).reverse();
  }

  // 답변에 대한 "도움이 됐어요/아니에요" 저장. WHERE 에 learner_id 까지 걸어서 "남의 질문 기록에 피드백을 다는 것"(IDOR)을 막습니다.
  // 반환: 실제로 바뀐 행이 있으면 true(내 기록이 아니거나 없는 번호면 false → 404).
  setFeedback(id, learnerId, helpful) {
    return this.db.prepare('UPDATE qa_log SET feedback = ? WHERE id = ? AND learner_id = ?').run(helpful ? 1 : 0, id, learnerId).changes > 0;
  }

  // 퀴즈 문제 1건 저장(보기 options 는 배열 → JSON 문자열). 처음엔 answered=0(아직 안 풀림).
  addQuizItem(it) {
    const info = this.db.prepare(`INSERT INTO quiz_items (learner_id, created_at, chunk_id, unit, qtype, generator, prompt, options, answer, explanation)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(it.learnerId, this.iso(), it.chunkId, it.unit, it.qtype, it.generator, it.prompt, it.options ? JSON.stringify(it.options) : null, it.answer, it.explanation);
    return Number(info.lastInsertRowid);
  }

  // 문제 1건 조회. 보기를 JSON 문자열에서 배열로 복원합니다. 소유자 검사는 호출자(quiz.answer)가 합니다.
  quizItem(id) {
    const r = this.db.prepare('SELECT * FROM quiz_items WHERE id = ?').get(id);
    return r ? { ...r, options: r.options ? JSON.parse(r.options) : null } : null;
  }

  // 한 문제는 한 번만 채점합니다(중복 제출로 기록이 부풀려지는 것을 막음).
  // 단계: ① answered 0→1 을 "먼저 선점"(UPDATE ... WHERE answered = 0). 변경된 행이 0이면 이미 제출됨 → null
  //       ② 풀이 기록 추가  ③ 이 개념의 현재 상자 조회  ④ 맞으면 상자+1(최대 5), 틀리면 1번 상자
  //       ⑤ 다음 복습 시각 = 지금 + 상자별 간격  ⑥ mastery 에 upsert(없으면 추가, 있으면 갱신)
  // ①이 한 SQL 문 하나로 "확인 + 표시"를 동시에 하므로 같은 문제를 동시에 두 번 제출해도 한 번만 반영됩니다.
  recordAttempt(item, userAnswer, correct) {
    const claimed = this.db.prepare('UPDATE quiz_items SET answered = 1 WHERE id = ? AND answered = 0').run(item.id).changes;
    if (!claimed) return null;
    const t = this.now();
    this.db.prepare('INSERT INTO attempts (learner_id, created_at, item_id, chunk_id, unit, qtype, user_answer, correct) VALUES (?,?,?,?,?,?,?,?)')
      .run(item.learner_id, new Date(t).toISOString(), item.id, item.chunk_id, item.unit, item.qtype, userAnswer, correct ? 1 : 0);
    // 이 개념의 현재 숙련도 행(처음 푸는 개념이면 undefined).
    const cur = this.db.prepare('SELECT * FROM mastery WHERE learner_id = ? AND chunk_id = ?').get(item.learner_id, item.chunk_id);
    // 현재 상자(기록이 없으면 1번에서 시작). 정답 시 +1 하되 5를 넘지 않게 Math.min.
    const box = correct ? Math.min(5, (cur?.box ?? 1) + 1) : 1;
    // 복습 시각(ms) = 지금 + BOX_DAYS[상자] 일.
    const due = t + BOX_DAYS[box] * DAY;
    // upsert: PRIMARY KEY(learner_id, chunk_id) 충돌 시 UPDATE. attempts 는 +1, correct 는 이번 정답(0/1)만큼 누적.
    // (처음 INSERT 되는 행에는 시도 1, 정답 여부가 그대로 들어갑니다. excluded 는 "넣으려던 새 값"을 가리키는 SQLite 문법)
    this.db.prepare(`INSERT INTO mastery (learner_id, chunk_id, box, due_at, attempts, correct, last_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(learner_id, chunk_id) DO UPDATE SET box = excluded.box, due_at = excluded.due_at, attempts = attempts + 1, correct = correct + excluded.correct, last_at = excluded.last_at`)
      .run(item.learner_id, item.chunk_id, box, due, 1, correct ? 1 : 0, t);
    return { box, dueAt: due };
  }

  // 한 학습자의 개념별 숙련도 전체를 Map(chunk_id → 행)으로
  chunkStats(learnerId) {
    const m = new Map();
    for (const r of this.db.prepare('SELECT * FROM mastery WHERE learner_id = ?').all(learnerId)) m.set(r.chunk_id, r);
    return m;
  }

  // 전체 풀이 횟수와 정답 횟수. COALESCE(SUM(...),0)은 기록이 없을 때 NULL 대신 0 을 주기 위함.
  attemptTotals(learnerId) {
    return this.db.prepare('SELECT COUNT(*) attempts, COALESCE(SUM(correct),0) correct FROM attempts WHERE learner_id = ?').get(learnerId);
  }

  // 최근 풀이 n건(최신순) — "내 학습현황"의 최근 기록
  recentAttempts(learnerId, n = 10) {
    return this.db.prepare('SELECT created_at, chunk_id, unit, qtype, correct FROM attempts WHERE learner_id = ? ORDER BY id DESC LIMIT ?').all(learnerId, n);
  }

  // 이 학습자의 총 질문 수
  questionsAsked(learnerId) {
    return this.db.prepare('SELECT COUNT(*) n FROM qa_log WHERE learner_id = ?').get(learnerId).n;
  }

  // 학습자 이름(없으면 '학습자')
  learnerName(id) { return this.db.prepare('SELECT name FROM learners WHERE id = ?').get(id)?.name ?? '학습자'; }

  // 전체 운영 지표(발표용 대시보드)
  // 전체 운영 지표(발표용 대시보드): 모든 학습자를 합산한 값입니다. 비율은 분모가 0이면 null(화면에서 '-')로 돌려줍니다.
  //   answeredRate: 근거 있는 답변 비율 / llm·extractive: 답변 방식별 개수 / helpfulRate: 도움됨 비율
  //   topUnits: 질문이 많은 단원 6개 / quizByUnit: 단원별 정답률 / hardest: 2회 이상 풀었고 정답률이 낮은 개념 5개
  stats() {
    // SUM(generator='llm') 처럼 조건식의 합은 "조건이 참인 행의 수"를 셉니다(SQLite 는 참=1).
    const q = this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(answered),0) answered,
      COALESCE(SUM(generator='llm'),0) llm, COALESCE(SUM(generator='extractive'),0) extractive,
      COALESCE(AVG(latency_ms),0) avg_ms, COALESCE(SUM(feedback=1),0) up, COALESCE(SUM(feedback=0),0) down FROM qa_log`).get();
    const byUnit = this.db.prepare("SELECT unit, COUNT(*) n FROM qa_log WHERE unit IS NOT NULL GROUP BY unit ORDER BY n DESC LIMIT 6").all();
    const quiz = this.db.prepare('SELECT COUNT(*) attempts, COALESCE(SUM(correct),0) correct FROM attempts').get();
    const quizByUnit = this.db.prepare('SELECT unit, COUNT(*) attempts, SUM(correct) correct FROM attempts GROUP BY unit').all();
    const learners = this.db.prepare('SELECT COUNT(*) n FROM learners').get().n;
    // HAVING attempts >= 2: 한두 번 우연히 틀린 개념이 "어려운 개념"으로 뽑히지 않도록 최소 2회 이상 푼 것만 봅니다.
    const hardest = this.db.prepare(`SELECT chunk_id, COUNT(*) attempts, SUM(correct) correct FROM attempts GROUP BY chunk_id HAVING attempts >= 2
      ORDER BY (1.0 * SUM(correct) / COUNT(*)) ASC, attempts DESC LIMIT 5`).all();
    const rated = q.up + q.down;
    return {
      learners, questions: q.total, answered: q.answered, answeredRate: q.total ? q.answered / q.total : null,
      llmAnswers: q.llm, extractiveAnswers: q.extractive, avgLatencyMs: Math.round(q.avg_ms),
      helpfulRate: rated ? q.up / rated : null, rated, topUnits: byUnit,
      quiz: { attempts: quiz.attempts, correct: quiz.correct, accuracy: quiz.attempts ? quiz.correct / quiz.attempts : null },
      quizByUnit: quizByUnit.map((u) => ({ ...u, accuracy: u.attempts ? u.correct / u.attempts : null })), hardest,
    };
  }
}
