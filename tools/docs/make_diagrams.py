"""StudyMate 다이어그램 생성: python tools/docs/make_diagrams.py
  → docs/images/flow-dev.png     개발 절차 순서도
  → docs/images/flow-chat.png    질문 처리 순서도(POST /api/chat, RAG + 환각 방지)
  → docs/images/flow-quiz.png    퀴즈 출제 순서도(POST /api/quiz)
  → docs/images/flow-grade.png   채점·숙련도 갱신 순서도(POST /api/quiz/:id/answer)
  → docs/images/erd.png          ERD(SQLite 5테이블 + 학습 자료 파일)
표준 순서도 기호: 둥근 사각형=시작/끝, 사각형=처리, 마름모=판단, 평행사변형=입출력.
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon

# Windows 원본 글꼴 우선, Linux CI에서는 설치된 한국어 글꼴을 사용합니다.
from matplotlib import font_manager
_available = {f.name for f in font_manager.fontManager.ttflist}
plt.rcParams["font.family"] = next((f for f in ("Malgun Gothic", "Noto Sans CJK KR", "NanumGothic") if f in _available), "DejaVu Sans")
OUT = Path(__file__).resolve().parent.parent.parent / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
BRAND, GREEN, RED, ORANGE, INK = "#4f46e5", "#0f9d6b", "#d92d20", "#d97706", "#1b2430"


class Flow:
    def __init__(self, w, h, y0=-1.2):
        self.fig, self.ax = plt.subplots(figsize=(w, h - y0 if y0 < 0 else h - y0))
        self.ax.set_xlim(-1.2, w + 0.8)
        self.ax.set_ylim(y0, h)
        self.ax.axis("off")
        self.nodes = {}

    def node(self, key, x, y, text, kind="proc", w=3.4, h=0.8, dashed=False):
        a = self.ax
        if kind == "term":
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.3", fc=BRAND, ec=BRAND, zorder=3))
            col = "white"
        elif kind == "dec":
            hw, hh = w / 2 + 0.2, h / 2 + 0.25
            a.add_patch(Polygon([(x, y + hh), (x + hw, y), (x, y - hh), (x - hw, y)], fc="#fff7e6", ec=ORANGE, lw=1.8, zorder=3))
            col = INK
        elif kind == "io":
            s = 0.3
            a.add_patch(Polygon([(x - w / 2 + s, y + h / 2), (x + w / 2 + s, y + h / 2), (x + w / 2 - s, y - h / 2), (x - w / 2 - s, y - h / 2)], fc="#eef0ff", ec=BRAND, lw=1.8, zorder=3))
            col = INK
        else:
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.08", fc="white", ec=BRAND, lw=1.8, ls="--" if dashed else "-", zorder=3))
            col = INK
        a.text(x, y, text, ha="center", va="center", fontsize=11, color=col, zorder=5, fontweight="bold" if kind == "term" else "normal")
        hh = (h / 2 + 0.25) if kind == "dec" else h / 2
        hw = (w / 2 + 0.2) if kind == "dec" else w / 2
        self.nodes[key] = (x, y, hw, hh)

    def pt(self, key, side):
        x, y, hw, hh = self.nodes[key]
        return {"t": (x, y + hh), "b": (x, y - hh), "l": (x - hw, y), "r": (x + hw, y)}[side]

    def arrow(self, a, sa, b, sb, label="", via=None, color="#475467"):
        p1, p2 = self.pt(a, sa), self.pt(b, sb)
        pts = [p1] + (via or []) + [p2]
        for i in range(len(pts) - 1):
            last = i == len(pts) - 2
            self.ax.annotate("", xy=pts[i + 1], xytext=pts[i], zorder=2,
                             arrowprops=dict(arrowstyle="-|>" if last else "-", color=color, lw=1.5, shrinkA=0, shrinkB=0))
        if label:
            mx, my = pts[0][0] + (pts[1][0] - pts[0][0]) * 0.35, pts[0][1] + (pts[1][1] - pts[0][1]) * 0.35
            self.ax.text(mx + 0.12, my + 0.08, label, fontsize=10, color=RED if label.startswith("아니") else GREEN, fontweight="bold", zorder=6,
                         bbox=dict(fc="white", ec="none", pad=1))

    def save(self, name, title):
        self.ax.text(-1.0, self.ax.get_ylim()[1] - 0.35, title, fontsize=16, fontweight="bold", color=INK)
        self.fig.savefig(OUT / name, dpi=110, bbox_inches="tight", facecolor="white")
        # 위·아래에 남는 흰 여백을 잘라 내 문서·슬라이드에서 그림이 최대한 크게 보이게 합니다.
        from PIL import Image, ImageChops
        im = Image.open(OUT / name).convert("RGB")
        box = ImageChops.difference(im, Image.new("RGB", im.size, "white")).getbbox()
        if box:
            pad = 20
            im.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(im.width, box[2] + pad), min(im.height, box[3] + pad))).save(OUT / name)
        plt.close(self.fig)
        print("saved", OUT / name)


# ── 1) 개발 절차 순서도 ──────────────────────────────────────────────
f = Flow(9, 12.4)
f.node("s", 4.5, 11.3, "시작 (2026-11-24)", "term", 3.0, 0.7)
f.node("p1", 4.5, 10.1, "1 기획\n주제·범위 확정, 기획서 (제출 12/04)", "proc", 5.4)
f.node("p2", 4.5, 8.8, "2 설계\nRAG 파이프라인, 퀴즈·복습, SQLite 5테이블, API", "proc", 5.8)
f.node("p3", 4.5, 7.5, "3 구현\n검색·환각 방지·퀴즈·학습 분석·자료함·카카오 스킬", "proc", 6.0)
f.node("p4", 4.5, 6.2, "4 테스트\n자동 테스트 30개, 평가 질문 92개, 퀴즈 132문제", "proc", 5.6)
f.node("d1", 4.5, 4.7, "결함·개선 사항이\n남아 있는가?", "dec", 2.6, 0.7)
f.node("p5", 4.5, 3.2, "5 유지보수\nClaude·ChatGPT 실호출 검증, 평가 재측정(12/05~)", "proc", 5.8)
f.node("p6", 4.5, 1.95, "결과보고서·발표자료 정리, 시연 리허설", "proc", 4.8)
f.node("e", 4.5, 0.85, "최종 발표 (2026-12-30)", "term", 3.2, 0.7)
for a, b in [("s", "p1"), ("p1", "p2"), ("p2", "p3"), ("p3", "p4"), ("p4", "d1")]:
    f.arrow(a, "b", b, "t")
f.arrow("d1", "b", "p5", "t", "아니오")
f.arrow("d1", "r", "p3", "r", "예 → 구현으로 수정", via=[(8.2, 4.7), (8.2, 7.5)], color=RED)
f.arrow("p5", "b", "p6", "t"); f.arrow("p6", "b", "e", "t")
f.save("flow-dev.png", "개발 절차 순서도 (기획 → 설계 → 구현 → 테스트 → 유지보수)")

# ── 2) 질문 처리 순서도(POST /api/chat) ─────────────────────────────────
LX, RX, BUS = 2.7, 8.6, 11.0
c = Flow(12, 15.6, y0=-1.4)
c.node("s", LX, 14.7, "시작: 학습자 ID + 질문 입력", "term", 3.8, 0.6)
c.node("v1", LX, 13.4, "질문이 2~500자인가?", "dec", 2.6, 0.55)
c.node("e400", RX, 13.4, "400 오류 안내\n(LLM·검색 호출 안 함)", "proc", 3.4, 0.75)
c.node("m", LX, 12.0, "개인정보 마스킹\n(전화·이메일·카드·주민번호)", "proc", 3.8, 0.75)
c.node("se", LX, 10.7, "BM25 검색(문자 바이그램)\n상위 4개 항목 + 신뢰도 계산", "proc", 4.0, 0.75)
c.node("d1", LX, 9.2, "신뢰도 ≥ 임계값(0.3)?", "dec", 2.8, 0.55)
c.node("n1", RX, 9.2, "거절: '근거를 찾지 못했어요'\n(LLM 호출 없음, generator=none)", "proc", 4.0, 0.8)
c.node("d2", LX, 7.7, "LLM을 쓸 수 있는가?", "dec", 2.6, 0.55)
c.node("ex", RX, 7.7, "추출형 답변\n질문과 겹치는 원문 문장만 발췌", "proc", 3.9, 0.8)
c.node("ll", LX, 6.3, "LLM 호출(상위 3개 항목 +\n최근 2턴, '자료만 사용' 지시)", "proc", 4.0, 0.8)
c.node("d3", LX, 4.9, "호출에 성공했는가?", "dec", 2.6, 0.55)
c.node("d4", LX, 3.4, "근거 검사 통과?\n(숫자·인용 번호·일치도≥0.5)", "dec", 4.0, 0.6)
c.node("d5", RX, 3.4, "LLM 답이\n'근거 부족'인가?", "dec", 2.2, 0.55)
c.node("n2", RX, 1.9, "거절: 근거 없음 안내", "proc", 3.2, 0.6)
c.node("ai", LX, 1.9, "AI 답변\n(인용한 항목만 근거로 표시)", "proc", 3.6, 0.75)
c.node("e", LX, 0.4, "끝: qa_log 저장 → 응답\n(답변·근거·신뢰도·관련 항목)", "term", 4.4, 0.75)
c.arrow("s", "b", "v1", "t"); c.arrow("v1", "r", "e400", "l", "아니오"); c.arrow("v1", "b", "m", "t", "예")
c.arrow("m", "b", "se", "t"); c.arrow("se", "b", "d1", "t")
c.arrow("d1", "r", "n1", "l", "아니오"); c.arrow("d1", "b", "d2", "t", "예")
c.arrow("d2", "r", "ex", "l", "아니오"); c.arrow("d2", "b", "ll", "t", "예")
c.arrow("ll", "b", "d3", "t")
c.arrow("d3", "r", "ex", "r", "아니오", via=[(BUS, 4.9), (BUS, 7.7)])
c.arrow("d3", "b", "d4", "t", "예")
c.arrow("d4", "r", "d5", "l", "아니오"); c.arrow("d4", "b", "ai", "t", "예")
c.arrow("d5", "b", "n2", "t", "예"); c.arrow("d5", "r", "ex", "r", "아니오", via=[(BUS, 3.4), (BUS, 7.7)])
c.arrow("ai", "b", "e", "t")
c.ax.text(RX - 1.9, 0.6, "※ 400 외의 모든 경로(거절·추출형 포함)는\n   같은 방식으로 qa_log에 저장되고 응답됩니다.", fontsize=10, color="#667085", va="center")
c.save("flow-chat.png", "질문 처리 순서도 (POST /api/chat · RAG와 환각 방지)")

# ── 3) 퀴즈 출제 순서도(POST /api/quiz) ─────────────────────────────────
q = Flow(12, 15.4, y0=-1.4)
LX, RX, BUS = 2.7, 8.6, 11.2
q.node("s", LX, 14.5, "시작: 퀴즈 요청\n(단원 또는 약점 복습, 문항 수)", "term", 4.0, 0.75)
q.node("d1", LX, 13.0, "복습 모드이거나\n존재하는 단원인가?", "dec", 2.8, 0.6)
q.node("e1", RX, 13.0, "400(단원 미선택)·404(없는 단원)", "proc", 4.4, 0.6)
q.node("p1", LX, 11.5, "후보 = 핵심 용어가 든 문장이 있는 항목", "proc", 4.8, 0.6)
q.node("d2", LX, 10.1, "후보가 있는가?", "dec", 2.2, 0.55)
q.node("e2", RX, 10.1, "422 오류\n(굵은 글씨로 용어 표시 안내)", "proc", 3.8, 0.75)
q.node("p2", LX, 8.5, "우선순위 계산 후 상위 N개 선택(N=1~10, 기본 5)\n(1-평활 정답률) + 복습 시점 지남 - 숙련", "proc", 6.2, 0.8)
q.node("d3", LX, 6.9, "AI 출제를 쓸 수 있는가?\n(Claude·ChatGPT + 'AI 출제' 선택)", "dec", 4.8, 0.6)
q.node("p3", LX, 5.2, "LLM으로 객관식 1문제 생성(항목 본문만 근거)", "proc", 5.0, 0.6)
q.node("d4", LX, 3.9, "검사 통과?\n(보기 4개·정답 비노출·자료 일치)", "dec", 4.8, 0.55)
q.node("rule", RX, 2.6, "규칙 기반 출제\n빈칸·객관식·O/X", "proc", 3.0, 0.75)
q.node("sv", LX, 1.4, "문제를 quiz_items에 저장 → 정답 없이 반환", "proc", 5.0, 0.65)
q.node("e", LX, 0.0, "끝: 문제 목록 응답", "term", 3.0, 0.6)
q.arrow("s", "b", "d1", "t"); q.arrow("d1", "r", "e1", "l", "아니오"); q.arrow("d1", "b", "p1", "t", "예")
q.arrow("p1", "b", "d2", "t"); q.arrow("d2", "r", "e2", "l", "아니오"); q.arrow("d2", "b", "p2", "t", "예")
q.arrow("p2", "b", "d3", "t")
q.arrow("d3", "r", "rule", "r", "아니오", via=[(BUS, 6.9), (BUS, 2.6)])
q.arrow("d3", "b", "p3", "t", "예"); q.arrow("p3", "b", "d4", "t")
q.arrow("d4", "r", "rule", "t", "아니오", via=[(RX, 3.9)])
q.arrow("d4", "b", "sv", "t", "예")
q.arrow("rule", "l", "sv", "r", via=[(RX - 1.5 - 0.0, 2.6), (RX - 1.5, 1.4)])
q.arrow("sv", "b", "e", "t")
q.save("flow-quiz.png", "퀴즈 출제 순서도 (POST /api/quiz)")

# ── 4) 채점·숙련도 갱신 순서도(POST /api/quiz/:id/answer) ───────────────
g = Flow(12, 15.2, y0=-1.4)
LX, RX = 2.7, 8.6
g.node("s", LX, 14.4, "시작: 답 제출\n(학습자 ID·문제 ID·답)", "term", 3.6, 0.75)
g.node("d1", LX, 13.0, "내 문제로 존재하는가?", "dec", 2.8, 0.55)
g.node("e1", RX, 13.0, "404 문제를 찾을 수 없음", "proc", 3.6, 0.55)
g.node("d2", LX, 11.6, "이미 제출한 문제인가?", "dec", 2.8, 0.55)
g.node("e2", RX, 11.6, "409 이미 제출한 문제", "proc", 3.4, 0.55)
g.node("d3", LX, 10.2, "답이 비어 있지 않은가?", "dec", 2.8, 0.55)
g.node("e3", RX, 10.2, "400 답을 입력해 주세요", "proc", 3.4, 0.55)
g.node("p1", LX, 8.7, "채점(공백·대소문자·기호 차이 무시)\n빈칸은 정답을 포함하면 인정(길이 2.5배 이내)", "proc", 5.8, 0.8)
g.node("p2", LX, 7.3, "quiz_items.answered=1로 선점(1회만 채점)\nattempts에 풀이 1건 저장", "proc", 5.0, 0.8)
g.node("d4", LX, 5.8, "정답인가?", "dec", 1.8, 0.5)
g.node("up", RX - 0.8, 5.8, "상자 +1\n(최대 5)", "proc", 2.2, 0.7)
g.node("dn", LX, 4.5, "상자 1로(즉시 복습)", "proc", 3.0, 0.55)
g.node("p3", LX, 3.2, "다음 복습 시점 = 지금 + 상자별 간격\n(1상자 0일 · 2상자 1일 · 3상자 3일 · 4상자 7일 · 5상자 14일)", "proc", 6.4, 0.8)
g.node("p4", LX, 1.9, "mastery에 저장(UPSERT)\n시도·정답 횟수 누적", "proc", 4.0, 0.75)
g.node("o", LX, 0.6, "응답: 정답 여부·정답·해설·근거 항목\n상자 번호·다음 복습까지 일수", "io", 4.6, 0.8)
g.node("e", LX, -0.7, "끝", "term", 1.8, 0.5)
g.node("n", RX + 0.4, 0.6, "이후 학습현황·추천 요청 시\n평활 정답률 < 0.6 → 약점\n복습 시점 도래 → 복습 대상", "proc", 4.6, 1.2, dashed=True)
g.arrow("s", "b", "d1", "t"); g.arrow("d1", "r", "e1", "l", "아니오"); g.arrow("d1", "b", "d2", "t", "예")
g.arrow("d2", "r", "e2", "l", "예"); g.arrow("d2", "b", "d3", "t", "아니오")
g.arrow("d3", "r", "e3", "l", "아니오"); g.arrow("d3", "b", "p1", "t", "예")
g.arrow("p1", "b", "p2", "t"); g.arrow("p2", "b", "d4", "t")
g.arrow("d4", "r", "up", "l", "예")
g.arrow("d4", "b", "dn", "t", "아니오")
g.arrow("dn", "b", "p3", "t")
g.arrow("up", "b", "p3", "r", via=[(RX - 0.8, 3.2)])
g.arrow("p3", "b", "p4", "t"); g.arrow("p4", "b", "o", "t"); g.arrow("o", "b", "e", "t")
g.save("flow-grade.png", "채점·숙련도 갱신 순서도 (POST /api/quiz/:id/answer)")

# ── 5) ERD ──────────────────────────────────────────────────────────
fig, ax = plt.subplots(figsize=(12.5, 11.4))
ax.set_xlim(0, 12.5); ax.set_ylim(-2.3, 9.9); ax.axis("off")
ax.text(0.2, 9.7, "StudyMate 데이터 구조 (SQLite 5테이블 + 학습 자료 파일)", fontsize=17, fontweight="bold", color=INK)
ax.text(0.2, 9.3, "관계는 모두 논리적 참조입니다(스키마에 FOREIGN KEY·CHECK 제약 없음). 같은 learner_id로 묶입니다.", fontsize=10, color="#667085")
ax.text(0.2, 9.0, "chunk_id는 DB가 아니라 학습 자료 파일의 항목 번호(예: ML-04)를 가리킵니다.", fontsize=10, color="#667085")
RH = 0.36


def table(x, y, name, rows, color=BRAND, w=3.8, dashed=False):
    h = 0.55 + RH * len(rows)
    ax.add_patch(FancyBboxPatch((x, y - h), w, h, boxstyle="round,pad=0.02,rounding_size=0.1", fc="white", ec=color, lw=2, ls="--" if dashed else "-", zorder=3))
    ax.add_patch(FancyBboxPatch((x, y - 0.55), w, 0.55, boxstyle="round,pad=0.02,rounding_size=0.1", fc=color, ec=color, zorder=4))
    ax.text(x + w / 2, y - 0.28, name, color="white", fontsize=12, fontweight="bold", ha="center", va="center", zorder=5)
    for i, (k, c) in enumerate(rows):
        yy = y - 0.55 - RH * (i + 0.5)
        if k:
            ax.text(x + 0.12, yy, k, fontsize=8.5, color="#b42318" if k == "PK" else "#175cd3", fontweight="bold", va="center", zorder=5)
        ax.text(x + 0.62, yy, c, fontsize=9.5, color=INK, va="center", zorder=5)
    return h


def link(p1, p2, label="", via=None, dashed=False, lp=None):
    pts = [p1] + (via or []) + [p2]
    for i in range(len(pts) - 1):
        last = i == len(pts) - 2
        ax.annotate("", xy=pts[i + 1], xytext=pts[i], zorder=2,
                    arrowprops=dict(arrowstyle="-|>" if last else "-", color="#475467", lw=1.5, ls="--" if dashed else "-", shrinkA=0, shrinkB=0))
    if label:
        lx, ly = lp or ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        ax.text(lx, ly + 0.08, label, fontsize=9.5, color=RED, fontweight="bold", ha="center", bbox=dict(fc="white", ec="none", pad=1), zorder=6)


top = 8.2
table(0.2, top, "learners", [("PK", "id  TEXT"), ("", "name  TEXT  NOT NULL"), ("", "created_at  TEXT  NOT NULL")], w=3.3)
table(4.3, top, "qa_log (질문 기록)", [("PK", "id  INTEGER  AUTOINCREMENT"), ("", "learner_id  TEXT  → learners.id"), ("", "created_at  TEXT"), ("", "question  TEXT (마스킹됨)"),
                                      ("", "answer  TEXT"), ("", "generator  llm|extractive|none"), ("", "confidence  REAL"), ("", "unit  TEXT  NULL"), ("", "sources  TEXT (JSON, 항목 ID 배열)"),
                                      ("", "answered  INTEGER  DEFAULT 1"), ("", "latency_ms  INTEGER  DEFAULT 0"), ("", "feedback  INTEGER  NULL (1=도움됨)")], w=3.9)
table(8.6, top, "quiz_items (출제된 문제)", [("PK", "id  INTEGER  AUTOINCREMENT"), ("", "learner_id  TEXT  → learners.id"), ("", "created_at  TEXT"), ("", "chunk_id  TEXT  → 자료 항목"), ("", "unit  TEXT"),
                                          ("", "qtype  mcq|cloze|ox"), ("", "generator  rule|llm"), ("", "prompt  TEXT"), ("", "options  TEXT NULL (JSON)"), ("", "answer  TEXT"), ("", "explanation  TEXT"),
                                          ("", "answered  INTEGER  DEFAULT 0")], w=3.7)
bot = 2.75
table(0.2, bot, "mastery (개념별 숙련도)", [("PK", "learner_id  TEXT  (복합 PK)"), ("PK", "chunk_id  TEXT  (복합 PK)"), ("", "box  INTEGER  (1~5)"), ("", "due_at  INTEGER  (ms)"), ("", "attempts  INTEGER"), ("", "correct  INTEGER"), ("", "last_at  INTEGER  (ms)")], w=3.8)
table(8.6, bot, "attempts (풀이 기록)", [("PK", "id  INTEGER  AUTOINCREMENT"), ("", "learner_id  TEXT"), ("", "created_at  TEXT"), ("", "item_id  INTEGER  → quiz_items.id"), ("", "chunk_id  TEXT"), ("", "unit  TEXT"), ("", "qtype  TEXT"), ("", "user_answer  TEXT"), ("", "correct  INTEGER  (0/1)")], w=3.7)
table(4.75, 2.4, "학습 자료 파일 (DB 아님)", [("", "knowledge/*.md (6단원·44항목)"), ("", "data/materials/u{n}.md (내 자료)"), ("", "항목 ID: ML-04, LM-09, U1-02"), ("", "data/embeddings.json (선택)")], color="#667085", w=3.5, dashed=True)
# 관계선
link((3.5, top - 0.9), (4.3, top - 0.9), "1 : N", lp=(3.9, top - 0.9))                                   # learners → qa_log
link((1.85, top - 1.7), (1.85, bot), "1 : N", lp=(1.85, 5.0))                                             # learners → mastery
link((1.2, top), (9.5, top), "", via=[(1.2, top + 0.4), (9.5, top + 0.4)])
ax.text(5.4, top + 0.4, "1 : N  (learners → quiz_items)", fontsize=9.5, color=RED, fontweight="bold", ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=6)
link((10.45, top - 0.55 - RH * 12), (10.45, bot), "", lp=None)
ax.text(11.1, 3.1, "1 : N", fontsize=9.5, color=RED, fontweight="bold", ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=6)
link((4.75, 1.4), (3.95, 1.4), "", via=[], dashed=True)
link((8.25, 1.4), (8.6, 1.4), "", dashed=True)
ax.text(0.2, -1.7, "인덱스: idx_att_learner(attempts.learner_id), idx_qa_learner(qa_log.learner_id), mastery 복합 PK(learner_id, chunk_id)", fontsize=9.5, color="#475467")
ax.text(0.2, -2.1, "PRAGMA journal_mode=WAL, foreign_keys=ON 이지만 FK를 선언한 테이블이 없어 참조 무결성은 코드가 지킵니다.", fontsize=9.5, color="#667085")
fig.savefig(OUT / "erd.png", dpi=110, bbox_inches="tight", facecolor="white")
plt.close(fig)
print("saved", OUT / "erd.png")
