// ─────────────────────────────────────────────────────────────────────────────
// learning.mjs — 학습 분석: 어떤 개념이 약한지 찾고, 무엇을 먼저 복습할지 정하기
//
// [개념 = 청크]  자료의 "## [ID] 제목" 한 항목이 개념 하나입니다. 퀴즈를 풀 때마다 db.mjs 의 mastery 표에
//                (개념별 상자 번호 box, 다음 복습 시각 due_at, 시도 횟수 attempts, 정답 횟수 correct)가 갱신됩니다.
// [이 파일의 3가지 기능]
//     rank()       퀴즈 출제 때 "어떤 개념부터 낼지" 우선순위 정렬(quiz.mjs 가 사용)
//     progress()   "내 학습현황": 단원별 진행·정답률, 약점 개념, 복습할 개념, 최근 풀이
//     recommend()  "오늘의 학습": progress 를 바탕으로 해야 할 일 목록(plan)
// ─────────────────────────────────────────────────────────────────────────────
// 학습 분석: 개념(청크)별 숙련도로 약점을 찾고 복습 순서를 정합니다.
// 라플라스 평활(smoothing)로 보정한 정답률 = (정답+1) ÷ (시도+2).
// 1번 풀어 1번 맞혔다고 정답률 100%로 단정하면 과신이므로, "맞음 1/틀림 1" 을 미리 더해 둔 것처럼 계산해 0.5 쪽으로 당깁니다.
// 시도가 많아질수록 실제 정답률에 가까워집니다.
const smoothed = (s) => (s.correct + 1) / (s.attempts + 2); // 시도가 적을 때 과신하지 않도록 라플라스 평활

// 개념별 숙련도 계산기. getKb 로 현재 자료를, store 로 풀이 기록을 읽습니다.
export class Learning {
  constructor({ getKb, store }) { this.getKb = getKb; this.store = store; }

  // 복습 우선순위(높을수록 먼저): 정답률이 낮을수록, 복습 시점이 지났을수록, 안 풀어 본 개념일수록 높습니다.
  // stat: mastery 행(없으면 null/undefined = 아직 안 푼 개념), now: 현재 시각(ms)
  // 점수 = (1 − 보정 정답률) + (복습 시점 지남 0.35) − (이미 4상자 이상 숙련 0.2). 가중치는 경험적으로 정한 값입니다.
  priority(stat, now) {
    if (!stat) return 0.6; // 아직 안 푼 개념: 약점보다는 낮고 숙련된 개념보다는 높게
    const acc = smoothed(stat);
    return (1 - acc) + (stat.due_at <= now ? 0.35 : 0) - (stat.box >= 4 ? 0.2 : 0);
  }

  // 학습자의 개념 목록을 우선순위 점수로 내림차순 정렬합니다. 반환: [{ chunk, stat, score }]
  rank(learnerId, chunks) {
    const now = this.store.now();
    const stats = this.store.chunkStats(learnerId);
    return chunks.map((c) => ({ chunk: c, stat: stats.get(c.id) ?? null, score: this.priority(stats.get(c.id), now) }))
      .sort((a, b) => b.score - a.score);
  }

  // 내 학습현황. 반환: { learner, totals(전체 합계), units(단원별), weak(약점), due(복습할 개념), recent(최근 풀이) }
  progress(learnerId) {
    // 1) 준비: 현재 자료, 현재 시각, 이 학습자의 개념별 숙련도 표, 전체 풀이 합계
    const { chunks } = this.getKb();
    const now = this.store.now();
    const stats = this.store.chunkStats(learnerId);
    const tot = this.store.attemptTotals(learnerId);
    // 2) 단원별 집계: chunks 총 개수 / seen 풀어 본 개념 수 / mastered 숙련(상자 4 이상) 개념 수 / attempts·correct 시도·정답 합
    const unitMap = new Map();
    for (const c of chunks) {
      if (!unitMap.has(c.unit)) unitMap.set(c.unit, { unit: c.unit, title: c.unitTitle, chunks: 0, seen: 0, mastered: 0, attempts: 0, correct: 0 });
      const u = unitMap.get(c.unit), s = stats.get(c.id);
      u.chunks++;
      if (s) { u.seen++; u.attempts += s.attempts; u.correct += s.correct; if (s.box >= 4) u.mastered++; }
    }
    const units = [...unitMap.values()].map((u) => ({ ...u, accuracy: u.attempts ? u.correct / u.attempts : null }));
    // 3) 개념 단위 분류. byId 로 숙련도 기록의 chunk_id 를 현재 자료의 조각과 연결합니다.
    const byId = new Map(chunks.map((c) => [c.id, c]));
    // weak: 약점(보정 정답률 < 0.6) / due: 정답률은 괜찮지만 복습 시각이 지났고 아직 마지막(5) 상자가 아닌 것
    const weak = [], due = [];
    for (const [id, s] of stats) {
      const c = byId.get(id);
      // 자료가 삭제돼 더는 없는 개념은 건너뜁니다.
      if (!c) continue;
      // acc: 보정 정답률(약점 판단용)
      const acc = smoothed(s);
      // 화면에 보여 줄 한 행. accuracy 는 보정 전 실제 정답률(정수 %로 표시하기 위함)
      const row = { chunkId: id, title: c.title, unit: c.unit, unitTitle: c.unitTitle, text: c.text, attempts: s.attempts, accuracy: s.correct / s.attempts, box: s.box };
      // 약점 판단은 보정 정답률(acc), 화면에 보이는 숫자는 실제 정답률로 구분합니다. 약점이 아니면서 복습 시각이 지났다면 due 목록에 넣습니다.
      if (acc < 0.6) weak.push({ ...row, reason: `정답률 ${Math.round(row.accuracy * 100)}% (${s.correct}/${s.attempts})` });
      else if (s.due_at <= now && s.box < 5) due.push({ ...row, reason: '복습할 시점이 되었어요' });
    }
    // 약점은 정답률 낮은 순으로
    weak.sort((a, b) => a.accuracy - b.accuracy);
    // 4) 결과 조립. 목록은 화면 공간상 약점·복습 각각 상위 6개, 최근 풀이 8개만 보냅니다.
    const seen = units.reduce((n, u) => n + u.seen, 0);
    return {
      learner: { id: learnerId, name: this.store.learnerName(learnerId) },
      totals: {
        attempts: tot.attempts, correct: tot.correct, accuracy: tot.attempts ? tot.correct / tot.attempts : null,
        questionsAsked: this.store.questionsAsked(learnerId), chunksSeen: seen, chunksTotal: chunks.length,
        mastered: units.reduce((n, u) => n + u.mastered, 0),
      },
      units, weak: weak.slice(0, 6), due: due.slice(0, 6), recent: this.store.recentAttempts(learnerId, 8),
    };
  }

  // 오늘의 학습 계획: 약한 단원 복습 → 복습 시점 도래 → 새 단원 순
  // 반환: { plan: [{ kind, unit, title, message, chunkIds? }], progress }  kind = review/concepts/due/new/keep
  recommend(learnerId) {
    const p = this.progress(learnerId);
    const plan = [];
    // 풀어 본 단원을 정답률 낮은 순으로
    const attempted = p.units.filter((u) => u.attempts > 0).sort((a, b) => a.accuracy - b.accuracy);
    // 정답률 70% 미만인 단원 최대 2개는 "복습 퀴즈 권유"
    for (const u of attempted.filter((x) => x.accuracy < 0.7).slice(0, 2)) {
      plan.push({ kind: 'review', unit: u.unit, title: u.title, message: `「${u.title}」 정답률이 ${Math.round(u.accuracy * 100)}%예요. 먼저 복습 퀴즈로 다시 확인해 보세요.` });
    }
    // 약점 개념이 있으면 가장 약한 개념 최대 3개를 알려 줍니다.
    if (p.weak.length) plan.push({ kind: 'concepts', unit: p.weak[0].unit, title: p.weak[0].unitTitle, message: `자주 틀린 개념: ${p.weak.slice(0, 3).map((w) => w.title).join(', ')}`, chunkIds: p.weak.slice(0, 3).map((w) => w.chunkId) });
    // 복습 시점이 된 개념이 있으면 알립니다.
    if (p.due.length) plan.push({ kind: 'due', unit: null, title: '복습 시점', message: `복습할 시점이 된 개념이 ${p.due.length}개 있어요: ${p.due.slice(0, 3).map((d) => d.title).join(', ')}`, chunkIds: p.due.map((d) => d.chunkId) });
    // 아직 한 번도 안 푼 단원이 있으면 첫 번째를 새로 시작하도록 제안
    const fresh = p.units.filter((u) => u.seen === 0);
    if (fresh.length) plan.push({ kind: 'new', unit: fresh[0].unit, title: fresh[0].title, message: `아직 시작하지 않은 단원: 「${fresh[0].title}」(${fresh[0].chunks}개 개념)` });
    // 아무 제안이 없으면 "유지" 메시지 하나는 항상 보여 줘 화면이 비지 않게 합니다.
    if (!plan.length) plan.push({ kind: 'keep', unit: null, title: '유지', message: '지금은 복습이 급한 개념이 없어요. 다른 단원 퀴즈로 실력을 넓혀 보세요.' });
    return { plan, progress: p };
  }
}
