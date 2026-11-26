// ─────────────────────────────────────────────────────────────────────────────
// app.js — StudyMate 웹 화면(브라우저에서 실행되는 JavaScript, 프레임워크 없음)
//
// [화면 구성: public/index.html 의 5개 탭]  학습 챗봇 / 퀴즈 / 내 학습현황 / 자료함 / 운영 지표
// [동작 방식]  버튼을 누르면 fetch 로 서버의 /api/... 를 호출하고(api 함수), 받은 JSON 으로 화면 조각(DOM)을 다시 만듭니다.
// [보안: XSS 방지]  XSS(Cross-Site Scripting) = 글 속에 숨긴 <script> 등이 화면에서 실행되는 공격.
//     서버에서 받은 글(답변·자료·이름 등)은 전부 h() 도우미로 "글자"(textContent/텍스트 노드)로만 넣고,
//     HTML 로 해석되는 innerHTML 은 쓰지 않습니다. 그래서 자료에 <script> 가 들어 있어도 글자 그대로 보일 뿐 실행되지 않습니다.
// [로그인 대신 learnerId]  브라우저 localStorage 에 무작위 학습자 ID 를 저장해 모든 요청에 실어 보냅니다(서버 쪽 설명은 src/http.mjs 참고).
// ─────────────────────────────────────────────────────────────────────────────
// 화면 코드: 모든 텍스트는 textContent로만 넣어 XSS를 막습니다(innerHTML 사용 안 함).
// $(선택자): 문서에서 첫 번째 요소를 찾는 줄임 함수(document.querySelector). 두 번째 인자로 검색 범위를 좁힐 수 있습니다.
const $ = (s, el = document) => el.querySelector(s);
// h(tag, props, ...kids): DOM 요소를 안전하게 만드는 도우미(hyperscript 방식).
//   예) h('button', { class: 'chip', onclick: fn }, '글자')  →  <button class="chip">글자</button> + 클릭 처리기
//   props: 'class' 는 className, 'on...' 으로 시작하면 이벤트 처리기, 그 밖에는 속성(false/null/undefined 면 생략)
//   kids : 자식들. 요소(nodeType 있음)는 그대로 붙이고, 나머지는 문자열로 바꿔 "텍스트 노드"로 붙임 → HTML 로 해석되지 않음(XSS 방지)
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  // 자식 배열을 평탄화(flat)해 하나씩 붙입니다. null/false 는 건너뛰므로 `조건 && 요소` 식으로 쓸 수 있습니다.
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
// 비율(0~1) → '85%' 형태 문자열. 값이 없으면(null) '-' (예: 아직 푼 문제가 없을 때)
const pct = (x) => (x == null ? '-' : Math.round(x * 100) + '%');
// 비율 → 막대 색상 등급: 80% 이상 high(초록), 60% 이상 mid(주황), 그 미만 low(빨강). CSS 의 .bar.high/.mid/.low 와 연결됩니다.
const tone = (x) => (x == null ? '' : x >= 0.8 ? 'high' : x >= 0.6 ? 'mid' : 'low');

// 학습자 ID 준비: localStorage 'sm_id' 에 저장된 값을 쓰고, 없으면 'l-' + 무작위 20자를 만들어 저장합니다(서버의 ID 형식 규칙 6~64자 영문/숫자/_/- 를 만족).
// 저장소 접근이 막힌 브라우저(시크릿 모드 등)에서는 예외가 나므로 catch 에서 저장 없이 임시 ID 를 씁니다(새로고침하면 바뀜).
let learnerId = (() => { try { return localStorage.getItem('sm_id') || (() => { const v = 'l-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20); localStorage.setItem('sm_id', v); return v; })(); } catch { return 'l-' + Math.random().toString(36).slice(2, 14).padEnd(12, 'x'); } })();
// 시연용: ?learner=demo-learner-01 로 접속하면 해당 학습자의 기록을 봅니다.
// 시연용: 주소에 ?learner=ID 를 붙이면 그 학습자의 기록을 봅니다(서버와 같은 형식 검사를 통과한 값만 받음).
{ const q = new URLSearchParams(location.search).get('learner'); if (q && /^[\w-]{6,64}$/.test(q)) { learnerId = q; try { localStorage.setItem('sm_id', q); } catch { /* 무시 */ } } }
// 이름 입력칸: 마지막에 쓴 이름을 localStorage 'sm_name' 에서 복원하고, 바뀌면 저장합니다(저장소를 못 쓰면 조용히 무시).
const nameInput = $('#name');
try { nameInput.value = localStorage.getItem('sm_name') || ''; } catch { /* 저장소 사용 불가 */ }
nameInput.addEventListener('change', () => { try { localStorage.setItem('sm_name', nameInput.value); } catch { /* 무시 */ } });
// 서버로 보낼 "나는 누구" 정보. 이름이 비어 있으면 undefined → JSON 에서 아예 빠져 서버가 기본 이름('학습자')을 씁니다.
const who = () => ({ learnerId, name: nameInput.value.trim() || undefined });

// 서버 API 호출 도우미. path 는 '/api' 뒤의 경로, opt.body 가 있으면 JSON 으로 POST, 없으면 GET(opt.method 로 DELETE 등 지정 가능).
// 응답이 오류(2xx 아님)면 서버가 준 error 문구로 Error 를 던져, 호출한 화면 코드가 사용자에게 보여 줄 수 있게 합니다.
async function api(path, opt = {}) {
  const res = await fetch('/api' + path, { method: opt.method || (opt.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  // 응답 본문이 JSON 이 아니어도 죽지 않게 빈 객체로 대체
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
}

// ---------- 탭 ----------
// 탭 이름 → 그 탭을 열 때 실행할 함수. (챗봇 탭은 따로 불러올 데이터가 없어 목록에 없음)
const loaders = { progress: loadProgress, materials: loadMaterials, stats: loadStats, quiz: fillUnits };
// 상단 탭 버튼마다 클릭 처리기 연결(버튼의 data-tab 속성이 탭 이름)
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => showTab(b.dataset.tab));
}
// 탭 전환: 버튼과 본문 영역의 'on' 클래스를 토글(CSS 에서 .tab.on 만 보임)한 뒤 그 탭의 불러오기 함수를 실행합니다. ?. 는 함수가 없으면 건너뜀.
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === name));
  loaders[name]?.();
}

// ---------- 상태 ----------
// 단원 목록 캐시(서버 /api/units 결과: [{ unit, title, user, chunks }])
let units = [];
// 시작 시 1회: 서버의 AI 연결 상태를 상단에 표시하고 단원 목록과 예시 질문 버튼을 준비합니다.
async function loadStatus() {
  const s = await api('/status');
  $('#llm').textContent = s.llmProvider ? `AI: ${s.llm}` : 'AI 없음: 자료 원문 발췌';
  units = await api('/units');
  fillExamples();
}

// ---------- 챗봇 ----------
// 예시 질문 버튼(처음 써 보는 사용자가 무엇을 물을지 막막하지 않도록)
const EXAMPLES = ['과대적합이 뭐야?', 'RAG는 어떻게 동작해?', '정밀도와 재현율의 차이는?', 'REST API가 뭐야?', '리스트와 튜플의 차이'];
// 예시 질문 칩을 그립니다. replaceChildren() 은 기존 내용을 비우고 새로 채웁니다(중복 방지).
function fillExamples() {
  const box = $('#examples'); box.replaceChildren();
  for (const e of EXAMPLES) box.append(h('button', { class: 'chip', onclick: () => ask(e) }, e));
}
// 대화창에 말풍선 추가. cls 는 'user'/'bot', body 는 DOM 또는 글자. 항상 맨 아래로 스크롤(scrollTop 을 큰 값으로)하고 요소를 돌려줍니다.
function addMsg(cls, body) { const m = h('div', { class: 'msg ' + cls }, body); $('#log').append(m); $('#log').scrollTop = 1e9; return m; }

// 질문 보내기: ① 내 말풍선 표시 ② "찾는 중…" 임시 말풍선 ③ 서버 응답으로 그 말풍선 내용을 교체. 실패하면 오류 문구로 교체합니다.
async function ask(question) {
  question = question.trim(); if (!question) return;
  $('#q').value = '';
  addMsg('user', question);
  const wait = addMsg('bot', h('span', { class: 'muted' }, '자료에서 근거를 찾는 중…'));
  try {
    // level: 설명 수준 선택('normal' 또는 'easy'). who() 로 학습자 ID·이름을 함께 보냅니다.
    const r = await api('/chat', { body: { ...who(), question, level: $('#level').value } });
    wait.replaceChildren(...botBody(r));
  } catch (e) { wait.replaceChildren(h('span', { class: 'muted' }, '⚠ ' + e.message)); }
  $('#log').scrollTop = 1e9;
}

// 서버 응답 r 을 화면 조각 배열로 바꿉니다. r 모양: { id, answer, generator, confidence, latencyMs, sources[], note, piiMasked[], related[] }
function botBody(r) {
  // generator 값을 사람이 읽는 라벨로(AI 답변 / 원문 발췌 / 근거 없음)
  const gen = { llm: 'AI 답변(근거 검사 통과)', extractive: '자료 원문 발췌', none: '근거 없음' }[r.generator];
  // 구성: 답변 → 배지줄(방식·신뢰도·응답시간·개인정보 가림 여부) → 안내(note) → 근거 버튼 → 관련 질문 → 도움됨 평가
  const nodes = [h('div', { class: 'text' }, r.answer)];
  const meta = h('div', { class: 'meta' }, h('span', { class: 'badge' + (r.generator === 'none' ? ' warn' : '') }, gen), h('span', {}, `신뢰도 ${pct(r.confidence)}`), h('span', {}, `${(r.latencyMs / 1000).toFixed(1)}초`));
  // 개인정보가 가려졌다면 사용자가 알 수 있도록 경고 배지 표시
  if (r.piiMasked.length) meta.append(h('span', { class: 'badge warn' }, '개인정보 가림: ' + r.piiMasked.join(', ')));
  nodes.push(meta);
  if (r.note) nodes.push(h('div', { class: 'muted' }, r.note));
  // 근거: 버튼을 누르면 해당 자료 원문을 펼치고(ev 영역), 다시 누르면 접습니다. 답변의 출처를 직접 확인할 수 있게 하는 장치입니다.
  if (r.sources.length) {
    const ev = h('div');
    const srcRow = h('div', { class: 'chips' }, h('span', { class: 'muted' }, '근거:'));
    for (const s of r.sources) {
      srcRow.append(h('button', { class: 'chip', onclick: () => { if (ev.firstChild) ev.replaceChildren(); else ev.replaceChildren(h('div', { class: 'evidence' }, `[${s.id}] ${s.unitTitle} · ${s.title}\n${s.text}`)); } }, `${s.unitTitle} · ${s.title}`));
    }
    nodes.push(srcRow, ev);
  }
  // 관련 항목 버튼: 누르면 "{제목}에 대해 알려줘" 를 바로 질문합니다.
  if (r.related.length) {
    const row = h('div', { class: 'chips' }, h('span', { class: 'muted' }, '이것도 물어볼까요?'));
    for (const x of r.related) row.append(h('button', { class: 'chip', onclick: () => ask(x.title + '에 대해 알려줘') }, x.title));
    nodes.push(row);
  }
  // 만족도 평가(👍/👎): 서버에 저장되어 운영 지표의 "도움됨 비율"이 됩니다. 성공하면 문구로 바꾸고, 실패하면 버튼만 비활성화합니다.
  const fb = h('div', { class: 'meta' }, '도움이 되었나요?');
  for (const [label, v] of [['👍', true], ['👎', false]]) {
    fb.append(h('button', { onclick: async (ev) => { try { await api(`/chat/${r.id}/feedback`, { body: { learnerId, helpful: v } }); fb.replaceChildren('의견 고마워요!'); } catch { ev.target.disabled = true; } } }, label));
  }
  nodes.push(fb);
  return nodes;
}
// 폼 제출(엔터/질문 버튼): 기본 동작(페이지 새로고침)을 막고 질문을 보냅니다.
$('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); ask($('#q').value); });
// 첫 인사말
addMsg('bot', h('div', { class: 'text' }, '안녕하세요! 올려 둔 학습 자료를 바탕으로 질문에 답하고, 퀴즈로 약한 부분을 찾아 드려요. 답변에는 항상 근거 자료가 함께 표시됩니다.'));

// ---------- 퀴즈 ----------
// 퀴즈 범위 선택 목록을 채웁니다: 맨 위는 "약점 복습(전체)"(값 '__review'), 그 아래 단원들. 다시 채울 때 이전 선택값이 아직 있으면 유지합니다.
function fillUnits() {
  const sel = $('#quizUnit'); const prev = sel.value; sel.replaceChildren(h('option', { value: '__review' }, '약점 복습(전체)'));
  for (const u of units) sel.append(h('option', { value: u.unit }, `${u.title} (${u.chunks})`));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
// 진행 중인 퀴즈 상태: { items: 문제 배열, i: 현재 번호, score: 맞힌 수, wrong: 틀린 개념 제목들 }
let session = null;
$('#quizStart').addEventListener('click', () => startQuiz($('#quizUnit').value, Number($('#quizCount').value)));
// 퀴즈 시작: 서버에 문제 생성을 요청(약점 복습이면 mode:'review', 아니면 선택 단원). 생성되는 동안 버튼을 잠가 중복 요청을 막습니다.
async function startQuiz(unit, count) {
  const btn = $('#quizStart'); btn.disabled = true; $('#quizBox').replaceChildren(h('p', { class: 'muted' }, '문제를 만드는 중…'));
  try {
    const review = unit === '__review';
    const { items } = await api('/quiz', { body: { ...who(), mode: review ? 'review' : 'unit', unit: review ? undefined : unit, count, ai: $('#quizAi').checked } });
    session = { items, i: 0, score: 0, wrong: [] }; showQuestion();
  } catch (e) { $('#quizBox').replaceChildren(h('p', { class: 'muted' }, '⚠ ' + e.message)); }
  btn.disabled = false;
}
// 문제 1개를 화면에 그립니다. 서버가 준 문제에는 정답이 없고(정답 비노출), 제출 후 서버가 채점 결과로 알려 줍니다.
function showQuestion() {
  const { items, i } = session, it = items[i];
  const card = h('div', { class: 'card' }, h('div', { class: 'muted' }, `${i + 1} / ${items.length} · ${it.unitTitle}` + (it.generator === 'llm' ? ' · AI 출제' : '')), h('div', { class: 'q-prompt' }, it.prompt));
  // done: 채점 결과 r 을 받아 화면에 반영(입력 잠금 → 정답/오답 보기 색칠 → 점수 집계 → 정답·해설·다음 복습 시점 표시 → 다음 버튼)
  // nextReviewDays 가 0 이면 "곧바로" 복습(라이트너 1번 상자).
  const done = (r, given) => {
    card.querySelectorAll('button,input').forEach((x) => { x.disabled = true; });
    card.querySelectorAll('.opts button').forEach((b) => { if (b.textContent === r.correctAnswer) b.classList.add('right'); else if (b.textContent === given) b.classList.add('wrong'); });
    if (r.correct) session.score++; else session.wrong.push(r.source.title);
    card.append(h('div', { class: 'result ' + (r.correct ? 'ok' : 'bad') }, r.correct ? '정답입니다! ✔' : `오답이에요. 정답: ${r.correctAnswer}`,
      h('div', { class: 'exp' }, r.explanation), h('div', { class: 'muted' }, `다음 복습: ${r.nextReviewDays === 0 ? '곧바로' : r.nextReviewDays + '일 뒤'} · 상자 ${r.box}/5`)),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => { session.i++; session.i < items.length ? showQuestion() : showSummary(); } }, i + 1 < items.length ? '다음 문제' : '결과 보기')));
  };
  // submit: 답을 서버에 제출해 채점받습니다. 서버가 소유자·중복 제출을 확인하며, 오류는 문제 카드 아래에 표시합니다.
  const submit = async (answer) => { try { done(await api(`/quiz/${it.id}/answer`, { body: { learnerId, answer } }), answer); } catch (e) { card.append(h('p', { class: 'muted' }, '⚠ ' + e.message)); } };
  // 보기가 있으면(객관식·O/X) 보기 버튼, 없으면(빈칸) 입력칸+제출 버튼
  if (it.options) {
    card.append(h('div', { class: 'opts' }, it.options.map((o) => h('button', { onclick: () => submit(o) }, o))));
  } else {
    const inp = h('input', { type: 'text', placeholder: '정답을 입력하세요', maxlength: 100 });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) submit(inp.value); });
    card.append(h('div', { class: 'row' }, inp, h('button', { class: 'primary', onclick: () => inp.value.trim() && submit(inp.value) }, '제출')));
    setTimeout(() => inp.focus(), 0);
  }
  $('#quizBox').replaceChildren(card);
}
// 결과 요약: 점수, 정답률 막대, 틀린 개념 목록, 다음 행동 버튼. (style 에 들어가는 width 는 계산한 숫자라 사용자 글이 섞이지 않음)
function showSummary() {
  const { items, score, wrong } = session;
  $('#quizBox').replaceChildren(h('div', { class: 'card' }, h('h2', {}, `결과: ${score} / ${items.length}`), h('div', { class: `bar ${tone(score / items.length)}` }, h('i', { style: `width:${(score / items.length) * 100}%` })),
    wrong.length ? h('p', {}, '다시 볼 개념: ' + [...new Set(wrong)].join(', ')) : h('p', {}, '모두 맞혔어요! 🎉'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => showTab('progress') }, '내 학습현황 보기'), h('button', { onclick: () => startQuiz('__review', 5) }, '약점 복습 퀴즈'))));
}

// ---------- 학습현황 ----------
// 내 학습현황 탭: 서버 /api/recommend 한 번으로 "오늘의 추천 + 진행 요약"을 받아 KPI 카드·추천·단원별 정답률·약점 개념을 그립니다.
async function loadProgress() {
  const box = $('#progBox'); box.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
  try {
    const { plan, progress: p } = await api('/recommend?learnerId=' + learnerId);
    const t = p.totals;
    // KPI(핵심 지표) 카드들
    const out = [h('div', { class: 'grid' }, kpi(t.attempts, '푼 문제'), kpi(pct(t.accuracy), '전체 정답률'), kpi(`${t.chunksSeen}/${t.chunksTotal}`, '학습한 개념'), kpi(t.mastered, '숙련한 개념'), kpi(t.questionsAsked, '챗봇 질문'))];
    // 오늘의 학습 추천 카드
    const planCard = h('div', { class: 'card' }, h('h2', {}, '오늘의 학습 추천'));
    for (const s of plan) planCard.append(h('p', {}, '• ' + s.message));
    planCard.append(h('button', { class: 'primary', onclick: () => { showTab('quiz'); $('#quizUnit').value = '__review'; } }, '약점 복습 퀴즈로 이동'));
    out.push(planCard);
    // 단원별 정답률 막대(풀지 않은 단원은 "미학습")
    const uc = h('div', { class: 'card' }, h('h2', {}, '단원별 정답률'));
    for (const u of p.units) uc.append(h('div', { class: 'unit' }, h('span', {}, u.title), h('div', { class: `bar ${tone(u.accuracy)}` }, h('i', { style: `width:${(u.accuracy ?? 0) * 100}%` })), h('span', { class: 'muted' }, u.attempts ? `${pct(u.accuracy)} (${u.correct}/${u.attempts})` : `미학습 · ${u.chunks}개`)));
    out.push(uc);
    // 약점 개념: 펼치면(details) 자료 원문을 보여 줘 바로 다시 읽을 수 있습니다.
    const wc = h('div', { class: 'card' }, h('h2', {}, '약점 개념'));
    if (!p.weak.length) wc.append(h('p', { class: 'muted' }, '아직 약점으로 잡힌 개념이 없어요. 퀴즈를 풀면 여기에 표시됩니다.'));
    for (const w of p.weak) wc.append(h('details', {}, h('summary', {}, `${w.unitTitle} · ${w.title} — ${w.reason}`), h('div', { class: 'evidence' }, w.text)));
    out.push(wc);
    box.replaceChildren(...out);
  } catch (e) { box.replaceChildren(h('p', { class: 'muted' }, '⚠ ' + e.message)); }
}
// KPI 카드 1개: 큰 숫자 v 와 설명 label
const kpi = (v, label) => h('div', { class: 'kpi' }, h('b', {}, String(v)), h('span', {}, label));

// ---------- 자료함 ----------
// 자료함 탭: 자료 목록을 서버에서 다시 받아 그립니다. 사용자가 추가한 자료만 삭제 버튼이 있습니다(기본 자료는 삭제 불가).
async function loadMaterials() {
  units = await api('/units'); fillUnits();
  const box = $('#unitList'); box.replaceChildren(h('h2', {}, '자료 목록'));
  for (const u of units) {
    const row = h('div', { class: 'card row', style: 'justify-content:space-between' }, h('div', {}, h('b', {}, u.title), h('span', { class: 'muted' }, ` · 항목 ${u.chunks}개 · ${u.user ? '내가 추가한 자료' : '기본 자료'}`)));
    // 삭제는 confirm(확인창)으로 한 번 더 묻고, 성공하면 목록을 다시 불러옵니다.
    if (u.user) row.append(h('button', { onclick: async () => { if (confirm(`「${u.title}」 자료를 삭제할까요?`)) { await api('/materials/' + u.unit, { method: 'DELETE' }); loadMaterials(); } } }, '삭제'));
    box.append(row);
  }
}
// 파일 선택: .txt/.md 를 읽어 입력칸에 채웁니다. f.size 는 바이트 단위이며 서버의 본문 한도(40000바이트)와 맞춘 사전 검사입니다
// (한글은 UTF-8 에서 보통 글자당 3바이트라 실제 글자 수는 더 적을 수 있음). 제목이 비어 있으면 파일명(확장자 제외)을 제목으로.
$('#matFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 40000) { $('#matMsg').textContent = '파일이 너무 커요(약 3만 자 이하).'; return; }
  $('#matText').value = await f.text();
  if (!$('#matTitle').value) $('#matTitle').value = f.name.replace(/\.[^.]+$/, '');
});
// 자료 추가 버튼: 서버가 제목·길이를 검증하고, 실패 이유는 오류 문구로 돌려줍니다.
$('#matAdd').addEventListener('click', async () => {
  const msg = $('#matMsg'); msg.textContent = '추가하는 중…';
  try {
    await api('/materials', { body: { title: $('#matTitle').value, text: $('#matText').value } });
    $('#matTitle').value = ''; $('#matText').value = ''; msg.textContent = '자료를 추가했어요. 이제 챗봇과 퀴즈에서 쓸 수 있어요.'; loadMaterials();
  } catch (e) { msg.textContent = '⚠ ' + e.message; }
});

// ---------- 운영 지표 ----------
// 운영 지표 탭(발표용 대시보드): 모든 학습자의 합계 통계를 그립니다.
// 서버 /api/stats 결과 s 를 카드로. unitTitle 은 단원 ID → 제목 변환, card 는 제목+행 목록 카드(행이 없으면 "데이터가 아직 없어요").
async function loadStats() {
  const s = await api('/stats'); const box = $('#statsBox');
  const unitTitle = (u) => units.find((x) => x.unit === u)?.title ?? u;
  const card = (title, rows) => h('div', { class: 'card' }, h('h2', {}, title), rows.length ? rows : h('p', { class: 'muted' }, '데이터가 아직 없어요.'));
  box.replaceChildren(
    h('div', { class: 'grid' }, kpi(s.learners, '학습자'), kpi(s.questions, '챗봇 질문'), kpi(pct(s.answeredRate), '근거 있는 답변 비율'), kpi(s.avgLatencyMs ? (s.avgLatencyMs / 1000).toFixed(1) + '초' : '-', '평균 응답시간'), kpi(pct(s.helpfulRate), `도움됨(${s.rated}건)`), kpi(pct(s.quiz.accuracy), `퀴즈 정답률(${s.quiz.attempts}문항)`)),
    card('질문이 많은 단원', s.topUnits.map((u) => h('p', {}, `${unitTitle(u.unit)} — ${u.n}건`))),
    card('단원별 퀴즈 정답률', s.quizByUnit.map((u) => h('div', { class: 'unit' }, h('span', {}, unitTitle(u.unit)), h('div', { class: `bar ${tone(u.accuracy)}` }, h('i', { style: `width:${u.accuracy * 100}%` })), h('span', { class: 'muted' }, `${pct(u.accuracy)} (${u.correct}/${u.attempts})`)))),
  );
}

// 시작: 상태 불러오기 → 퀴즈 범위 채우기. 서버에 연결하지 못하면 대화창에 안내를 띄웁니다.
loadStatus().then(() => { fillUnits(); }).catch((e) => addMsg('bot', h('span', { class: 'muted' }, '⚠ 서버에 연결하지 못했어요: ' + e.message)));
