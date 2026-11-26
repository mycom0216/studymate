// ─────────────────────────────────────────────────────────────────────────────
// kb.mjs — 지식베이스(Knowledge Base): 학습 자료 파일 ↔ "청크(chunk)" 목록
//
// [청크란] 검색·퀴즈의 최소 단위가 되는 "작은 자료 조각" 하나. 모양:
//     { id: 'A-01', title: '제목', unit: 'ch1'(단원 ID=파일명), unitTitle: '단원 제목',
//       file, user: 사용자 업로드 여부, text: 본문, terms: 핵심 용어들, derivedTerms: 용어를 자동 추출했는지 }
//
// [자료 파일 형식(.md)]
//     # 단원 제목
//     ## [ID] 항목 제목        ← "## [ID] 제목" 마다 청크 하나. ID 는 영문대문자+숫자-숫자(예: A-01, U1-02)
//     본문 … **핵심 용어** …    ← 굵은 글씨(**…**)는 퀴즈 빈칸/보기로 쓰이는 "핵심 용어"
//
// [두 출처]  기본 자료(knowledge/, 삭제 불가)  +  사용자 자료(data/materials/u1.md, u2.md …, 삭제 가능)
// [이 파일의 보안 포인트]  사용자 자료 길이 제한, 삭제 대상 ID 를 'u숫자' 로 엄격히 제한(경로 조작 방지)
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILLER, sentences, stem, words } from './text.mjs';

// knowledge/*.md 를 "## [ID] 제목" 단위의 청크로 분할합니다. **굵은 글씨**는 퀴즈의 핵심 용어가 됩니다.
// 매개변수 user:true 면 사용자 자료로 표시(화면에서 삭제 버튼을 보이는 기준). 폴더가 없으면 빈 배열.
export function loadKnowledge(dir, { user = false } = {}) {
  if (!existsSync(dir)) return [];
  const chunks = [];
  // 파일 이름순(.sort())으로 읽어 항상 같은 순서가 되게 합니다. .md 파일만 대상.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    // 윈도우 줄바꿈(\r\n)을 \n 으로 통일해 아래 정규식이 환경과 무관하게 동작하게 합니다.
    const raw = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    // 단원 제목 = 파일의 첫 '# ' 제목(없으면 파일명). 단원 ID = 확장자를 뺀 파일명.
    const unitTitle = /^#\s+(.+)$/mu.exec(raw)?.[1].trim() ?? file;
    const unit = file.replace(/\.md$/u, '');
    // '## ' 로 시작하는 줄 기준으로 나눕니다(첫 조각 [0]은 '## ' 앞의 머리말이라 slice(1) 로 버림).
    for (const part of raw.split(/^##\s+/mu).slice(1)) {
      // "[ID] 제목\n본문" 형식이 아닌 조각은 조용히 건너뜁니다. 정규식 그룹: m[1]=ID, m[2]=제목, m[3]=본문
      const m = /^\[([A-Z]+\d*-\d+)\]\s*(.+)\n([\s\S]*)$/u.exec(part);
      if (!m) continue;
      const body = m[3].trim();
      // 본문에서 **굵은 글씨**를 모두 찾아 핵심 용어 목록(중복 제거)으로
      const terms = [...new Set([...body.matchAll(/\*\*(.+?)\*\*/gu)].map((t) => t[1].trim()).filter(Boolean))];
      // text 에서는 ** 표시를 지워 화면·검색에 깔끔한 본문을 저장합니다.
      chunks.push({ id: m[1], title: m[2].trim(), unit, unitTitle, file, user, text: body.replace(/\*\*/gu, ''), terms, derivedTerms: false });
    }
  }
  return chunks;
}

// 굵은 글씨가 없는 자료(사용자 업로드)는 문서에서 드문 단어를 핵심 용어로 고릅니다.
// 아이디어(TF-IDF 비슷한 방식): 여러 조각에 흔히 나오는 단어는 핵심이 아니고, 한두 조각에만 나오는 단어가 핵심일 가능성이 큼.
export function ensureTerms(chunks) {
  // df: 각 어간(stem)이 몇 개 조각에 나오는지
  const df = new Map();
  for (const c of chunks) for (const w of new Set(words(c.text).map(stem))) df.set(w, (df.get(w) ?? 0) + 1);
  // N: 전체 조각 수
  const N = chunks.length || 1;
  for (const c of chunks) {
    // 이미 핵심 용어가 있으면(굵은 글씨) 그대로 둡니다.
    if (c.terms.length) continue;
    // 후보 단어: 군말 제외, 조사 뗀 어간, 중복 제거 → 길이 2~12자·숫자만으로 된 것 제외 → 점수 s 계산
    // s = log(N/df)(희귀할수록 높음) + 영문 포함 가산 0.3 + 길이 가산(최대 6자까지 글자당 0.05). 가산점은 약한 타이브레이커입니다.
    const cand = [...new Set(words(c.text).filter((w) => !FILLER.has(w)).map(stem))]
      .filter((w) => w.length >= 2 && w.length <= 12 && !/^\d+$/u.test(w))
      .map((w) => ({ w, s: Math.log(N / (df.get(w) ?? 1)) + (/[a-z]/u.test(w) ? 0.3 : 0) + Math.min(w.length, 6) * 0.05 }))
      .sort((a, b) => b.s - a.s);
    // 점수 상위 3개를 핵심 용어로. derivedTerms=true 는 "자동 추출"이라는 표시(굵은 글씨 용어보다 품질이 낮을 수 있음).
    c.terms = cand.slice(0, 3).map((x) => x.w);
    c.derivedTerms = true;
  }
  return chunks;
}

// 기본 자료 + 사용자 자료를 모두 읽어 한 목록으로 합치고, 핵심 용어가 없는 조각에 용어를 채웁니다.
export function loadAll(builtinDir, userDir) {
  return ensureTerms([...loadKnowledge(builtinDir), ...loadKnowledge(userDir, { user: true })]);
}

// 단원 목록: [{ unit, title, user, chunks: 조각 수 }] — 화면의 단원 선택·자료함 목록에 쓰입니다.
export function listUnits(chunks) {
  const units = new Map();
  for (const c of chunks) {
    if (!units.has(c.unit)) units.set(c.unit, { unit: c.unit, title: c.unitTitle, user: c.user, chunks: 0 });
    units.get(c.unit).chunks++;
  }
  return [...units.values()];
}

// 업로드 자료 최대 글자 수(디스크·메모리·색인 시간 폭증 방지)
const MAX_TEXT = 30000;

// 사용자가 붙여 넣은 텍스트를 같은 형식의 마크다운으로 바꿉니다.
// n 은 새 단원 번호(U{n}-01, U{n}-02 … 로 조각 ID 를 매깁니다). 입력이 부적합하면 사용자용 메시지의 Error 를 던집니다.
export function buildMaterialMarkdown(title, text, n) {
  // 제목: 공백 정리 후 60자까지만
  title = String(title ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60);
  // 본문: 줄바꿈 통일 후 앞뒤 공백 제거
  text = String(text ?? '').replace(/\r\n/g, '\n').trim();
  // 입력 검증: 제목 2자 이상, 본문 40자 이상 30000자 이하
  if (title.length < 2) throw new Error('제목은 2자 이상 입력해 주세요.');
  if (text.length < 40) throw new Error('자료 내용은 40자 이상 입력해 주세요.');
  if (text.length > MAX_TEXT) throw new Error(`자료는 ${MAX_TEXT}자 이하로 올려 주세요.`);
  // 번호를 두 자리로 맞추는 도우미(1 → '01')
  const pad = (k) => String(k).padStart(2, '0');
  // sections: 최종 조각 후보 [{ title, body }]
  const sections = [];
  // 경우 1) 사용자가 직접 "## 소제목" 을 쓴 경우 → 그 구조를 존중해 나눕니다(소제목 앞의 [ID] 표기가 있으면 지움, 본문이 10자 미만이면 제외).
  if (/^##\s+/mu.test(text)) {
    for (const part of text.split(/^##\s+/mu).slice(1)) {
      const [head, ...rest] = part.split('\n');
      const body = rest.join('\n').trim();
      const t = head.replace(/^\[[^\]]*\]\s*/u, '').trim() || '내용';
      if (body.length >= 10) sections.push({ title: t.slice(0, 40), body });
    }
  } else {
    // 경우 2) 소제목이 없으면 자동 분할: 문단(빈 줄 기준)을 모아 약 200~600자 크기의 조각으로 만듭니다.
    let buf = '';
    // flush: 지금까지 모은 buf 를 조각으로 확정하고 비웁니다. 제목은 첫 문장(마침표 제거, 30자까지).
    const flush = () => {
      const body = buf.trim();
      if (body) sections.push({ title: (sentences(body)[0] ?? body).replace(/[.!?]$/u, '').slice(0, 30), body });
      buf = '';
    };
    // 문단마다 줄바꿈을 공백으로 합쳐 한 덩어리로
    for (const para of text.split(/\n\s*\n/u).map((p) => p.replace(/\s*\n\s*/gu, ' ').trim()).filter(Boolean)) {
      // 한 문단이 길면 문장 단위로 잘라 청크가 너무 커지지 않게 합니다.
      const pieces = para.length > 600 ? sentences(para) : [para];
      for (const piece of pieces) {
        // piece 를 더하면 600자를 넘는다면 먼저 지금까지를 확정하고, 더한 뒤 200자 이상이면 바로 확정 → 조각 크기가 200~600자 근처로 유지됩니다.
        if (buf && (buf + ' ' + piece).length > 600) flush();
        buf += (buf ? ' ' : '') + piece;
        if (buf.length >= 200) flush();
      }
    }
    flush();
  }
  // 하나도 못 만들면 사용자에게 이유 안내
  if (!sections.length) throw new Error('자료에서 학습 항목을 만들 수 없습니다. 내용을 더 길게 입력해 주세요.');
  // 마크다운 조립: "# 제목" 다음에 "## [U{n}-{번호}] 소제목\n본문" 을 이어 붙입니다. 소제목의 줄바꿈은 공백으로(형식 깨짐 방지).
  const lines = [`# ${title}`, ''];
  sections.forEach((s, i) => { lines.push(`## [U${n}-${pad(i + 1)}] ${s.title.replace(/\n/gu, ' ')}`, s.body, ''); });
  return lines.join('\n');
}

// 새 자료를 data/materials/u{n}.md 로 저장하고 단원 ID('u{n}')를 돌려줍니다.
// 번호 n = 기존 u숫자.md 중 최대값 + 1 (중간 번호가 삭제돼도 번호가 겹치지 않음).
export function addMaterial(dir, title, text) {
  mkdirSync(dir, { recursive: true });
  const used = readdirSync(dir).map((f) => /^u(\d+)\.md$/u.exec(f)?.[1]).filter(Boolean).map(Number);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  const md = buildMaterialMarkdown(title, text, n);
  writeFileSync(join(dir, `u${n}.md`), md, 'utf8');
  return `u${n}`;
}

// 사용자 자료 삭제. 안전장치: ID 가 정확히 'u숫자' 형태가 아니면(예: '../x', 기본 자료 'ch1') 거절해 임의 파일 삭제를 막습니다.
// 반환: 실제로 삭제했으면 true.
export function removeMaterial(dir, unit) {
  if (!/^u\d+$/u.test(unit)) return false;
  const file = join(dir, `${unit}.md`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
