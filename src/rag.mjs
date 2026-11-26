// ─────────────────────────────────────────────────────────────────────────────
// rag.mjs — 검색기(Retriever): 질문과 가장 관련 있는 학습 자료 조각 찾기
//
// [검색(Retrieval) 두 갈래]
//   1) BM25  : 단어(여기서는 text.mjs 의 토큰) 겹침으로 점수를 매기는 고전적 검색 알고리즘.
//              "질문에 있는 단어가 이 문서에 몇 번, 그 단어가 얼마나 희귀한지"를 계산합니다.
//   2) 임베딩: (선택) 글을 숫자 벡터로 바꿔 의미가 비슷한지(코사인 유사도)를 비교합니다. Ollama 서버가 있어야 해서
//              없거나 실패하면 BM25 만 씁니다(자동 대체).
//   → 둘의 점수를 섞은 값(fused)으로 순위를 매깁니다.
//
// [신뢰도(confidence)] "찾은 결과가 질문에 진짜 답이 될 만한가"를 0~1 로 추정한 값.
//   chat.mjs 가 이 값이 기준보다 낮으면 답을 지어내지 않고 거절합니다. 구성:
//     coverage  질문 토큰 중 1순위 문서가 가진 비율(희귀 토큰일수록 가중)
//     (+ 임베딩 유사도)  ·  OOV 감점: 질문의 핵심 단어가 자료 어디에도 없으면 범위 밖일 가능성이 커서 깎음
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FILLER, tokens, words } from './text.mjs';

// BM25 상수. K1 = 같은 단어가 여러 번 나올 때 점수 증가 한도(클수록 반복에 후함), B = 문서 길이 보정 강도(0~1).
// 1.4 / 0.75 는 BM25 에서 흔히 쓰는 범위의 값입니다.
const K1 = 1.4, B = 0.75;

// BM25(문자 바이그램) + 선택적 임베딩(Ollama) 하이브리드 검색기.
// chunks: kb.mjs 가 만든 자료 조각 배열 [{ id, title, text, unit, ... }]
// 옵션: ollamaUrl/embedModel = 임베딩 서버 주소·모델, cacheFile = 임베딩 계산 결과 저장 파일, useEmbeddings = 임베딩 사용 여부
export class Retriever {
  constructor(chunks, { ollamaUrl = 'http://127.0.0.1:11434', embedModel = 'embeddinggemma', cacheFile = null, useEmbeddings = true } = {}) {
    this.chunks = chunks;
    this.ollamaUrl = ollamaUrl;
    this.embedModel = embedModel;
    this.cacheFile = cacheFile;
    this.useEmbeddings = useEmbeddings;
    // vectors: 조각별 임베딩 벡터(없으면 null → BM25 전용). init() 이 채웁니다.
    this.vectors = null;
    this.queryVectors = new Map();
    // 색인 만들기: 조각마다 토큰 빈도표(tf: 토큰 → 등장 횟수)와 길이(len)를 미리 계산해 둡니다.
    // 제목을 두 번 넣는 것은 제목에 있는 단어에 가중치를 주려는 간단한 장치입니다.
    this.docs = chunks.map((c) => {
      const toks = tokens(`${c.title} ${c.title} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { tf, len: toks.length };
    });
    // 전체 문서의 평균 길이(BM25 길이 보정용). 문서가 0개여도 0 으로 나누지 않게 || 1.
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    // df(document frequency): 각 토큰이 몇 개의 문서에 나오는가. 희귀한 토큰일수록 변별력이 크다는 BM25 의 기본 재료입니다.
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  // 현재 검색 방식 이름(상태 화면·로그용)
  get mode() { return this.vectors ? 'hybrid(BM25+embedding)' : 'BM25'; }

  // idf(역문서빈도): 희귀할수록 큰 값. N=전체 문서 수, n=그 토큰을 가진 문서 수. 로그 안에 1+ 를 둬 음수가 되지 않게 합니다.
  idf(t) {
    const n = this.df.get(t) ?? 0, N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  // Ollama 임베딩 API 호출: 텍스트 배열 → 벡터 배열. timeoutMs 안에 응답이 없으면 예외(AbortSignal.timeout)로 끊습니다.
  async embed(texts, timeoutMs = 20000) {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('embed ' + res.status);
    return (await res.json()).embeddings;
  }

  // 초기화: 임베딩을 쓰도록 설정된 경우 모든 조각의 벡터를 준비합니다.
  // 자료 내용이 그대로면 매번 다시 계산하지 않도록 (모델명+모든 텍스트)의 SHA-256 해시를 key 로 캐시 파일에 저장해 재사용합니다.
  async init() {
    if (!this.useEmbeddings) return this;
    const texts = this.chunks.map((c) => `${c.title}\n${c.text}`);
    const key = createHash('sha256').update(this.embedModel + JSON.stringify(texts)).digest('hex');
    try {
      if (this.cacheFile && existsSync(this.cacheFile)) {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        if (cached.key === key) { this.vectors = cached.vectors; return this; }
      }
      this.vectors = await this.embed(texts, 60000);
      if (this.cacheFile) writeFileSync(this.cacheFile, JSON.stringify({ key, vectors: this.vectors }));
    // 임베딩 서버 연결 실패 등 어떤 오류든 BM25 전용으로 조용히 후퇴합니다(서비스가 멈추지 않게).
    } catch {
      this.vectors = null; // 임베딩 서버가 없으면 BM25만 사용
    }
    return this;
  }

  // BM25 점수 계산. 반환: 조각별 { score(원점수), coverage(질문 토큰을 얼마나 포함하나 0~1) } 배열(chunks 와 같은 순서).
  bm25(query) {
    // 질문 토큰(중복 제거, 군말 제외)
    const q = [...new Set(tokens(query, { query: true }))];
    // 코퍼스에 한 번도 없는 토큰(군말·오탈자)은 영향력을 낮춰 커버리지가 과도하게 떨어지지 않게 합니다.
    // 토큰 가중치: 자료에 있는 토큰은 idf, 없는 토큰은 idf 의 30%(0.3) 만 반영
    const weight = (t) => (this.df.has(t) ? this.idf(t) : 0.3 * this.idf(t));
    // qWeight: 질문 토큰 가중치의 총합(coverage 의 분모). 0 이면 0 으로 나누지 않게 || 1
    const qWeight = q.reduce((s, t) => s + weight(t), 0) || 1;
    // 각 문서에 대해 질문 토큰별로: 문서에 없으면 건너뛰고, 있으면 BM25 공식으로 점수를 더하고(f=문서 내 빈도),
    // 가진 토큰의 가중치를 hit 에 누적합니다.
    return this.docs.map((d) => {
      let score = 0, hit = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = this.idf(t);
        // BM25 공식: idf × f(K1+1) / (f + K1(1 − B + B·문서길이/평균길이)). 긴 문서가 단어를 많이 가졌다는 이유만으로 유리하지 않게 보정합니다.
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / this.avgLen));
        hit += weight(t);
      }
      // coverage = (문서가 가진 질문 토큰 가중치 합) ÷ (질문 토큰 가중치 총합)
      return { score, coverage: hit / qWeight };
    });
  }

  // OOV(out-of-vocabulary) 비율: 질문의 핵심 어절 중 자료 어디에도 글자 조합이 없는 것의 비율.
  // 예: 자료에 없는 "양자컴퓨터" → 범위 밖 질문일 가능성이 높다는 신호. 0(전부 자료에 있음)~1(전부 없음).
  oovRatio(query) {
    // 군말을 뺀 어절
    const ws = words(query).filter((w) => !FILLER.has(w));
    if (!ws.length) return 0;
    // 3글자 이상 어절이면서, 그 어절의 바이그램/한글자 토큰이 하나도 색인에 없을 때만 "모르는 단어"로 셉니다.
    // (짧은 단어는 우연한 불일치가 많아 제외)
    const oov = ws.filter((w) => {
      const ts = tokens(w, { query: true }).filter((t) => t[0] === 'b' || t[0] === 'c');
      return w.length >= 3 && ts.length > 0 && ts.every((t) => !this.df.has(t));
    });
    return oov.length / ws.length;
  }

  // 검색 본체. 반환: { hits(상위 k개 [{chunk, bm25, coverage, cosine, fused}]), confidence(0~1), oovRatio }
  async search(query, k = 4) {
    // 1) 어휘 검색(BM25) 점수
    const lex = this.bm25(query);
    // 2) 임베딩이 켜져 있으면 질문 벡터와 각 조각 벡터의 코사인 유사도. 실패하면 null(= BM25 전용으로 진행)
    let cos = null;
    if (this.vectors) {
      try {
        let qv = this.queryVectors.get(query);
        if (!qv) {
          [qv] = await this.embed([query], 5000);
          if (!Array.isArray(qv) || qv.length !== this.vectors[0]?.length || !qv.every(Number.isFinite)) throw new Error('Invalid query vector');
          if (this.queryVectors.size >= 512) this.queryVectors.delete(this.queryVectors.keys().next().value);
          this.queryVectors.set(query, qv);
        }
        cos = this.vectors.map((v) => cosine(qv, v));
      } catch { cos = null; }
    }
    // 3) BM25 점수를 0~1 로 맞추기(1등=1). 임베딩이 있으면 두 점수를 5:5 로 섞습니다. 코사인은 보통 0.3 이하는 무관하다고 보고
    //    (sem-0.3)/0.5 로 0~1 에 펴 줍니다(이 기준값들은 경험적 설정).
    const maxBm = Math.max(...lex.map((l) => l.score), 1e-9);
    const rows = this.chunks.map((c, i) => {
      const bn = lex[i].score / maxBm;
      const sem = cos ? cos[i] : null;
      const fused = sem === null ? bn : 0.5 * bn + 0.5 * Math.max(0, (sem - 0.3) / 0.5);
      return { chunk: c, bm25: lex[i].score, coverage: lex[i].coverage, cosine: sem, fused };
    });
    // 4) fused 높은 순으로 정렬해 상위 k개
    rows.sort((a, b) => b.fused - a.fused);
    const top = rows.slice(0, k);
    // 신뢰도: 질의 토큰 커버리지(어휘 근거)와 임베딩 유사도(의미 근거)를 섞은 값
    const best = top[0];
    // 임베딩 점수: 코사인 0.35 이하→0, 0.7 이상→1 로 펴서 사용
    const semScore = best.cosine === null ? null : Math.min(1, Math.max(0, (best.cosine - 0.35) / 0.35));
    // 임베딩이 없으면 coverage 만, 있으면 coverage 와 의미 점수를 5:5 로 평균
    const base = semScore === null ? best.coverage : 0.5 * best.coverage + 0.5 * semScore;
    // 질의의 핵심 어절이 지식베이스 어디에도 없으면(예: "양자컴퓨터", "블랙홀") 범위 밖일 가능성이 높아 신뢰도를 깎습니다.
    // 최종 신뢰도 = 기본값 × (1 − 0.7 × OOV 비율): OOV 가 100%면 30% 수준으로 떨어집니다.
    const oov = this.oovRatio(query);
    return { hits: top, confidence: base * (1 - 0.7 * oov), oovRatio: oov };
  }
}

// 코사인 유사도: 두 벡터의 방향이 얼마나 비슷한가(−1~1, 1에 가까울수록 의미가 비슷). 내적 ÷ (두 길이의 곱). 0으로 나누기 방지 || 1.
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}
