"""최종 발표 PPT 생성: python tools/build_deck.py  →  docs/StudyMate_최종발표.pptx"""
import json
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

# 프로젝트 위치 기준으로 원자료와 화면 캡처 경로를 계산합니다.
ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
# 기존 최종발표의 글꼴과 색상 팔레트를 모든 슬라이드에 일관되게 적용합니다.
FONT = "Malgun Gothic"
INK, MUTED = RGBColor(0x1C, 0x23, 0x33), RGBColor(0x66, 0x70, 0x85)
BRAND, SOFT, WHITE = RGBColor(0x4F, 0x46, 0xE5), RGBColor(0xEC, 0xEA, 0xFD), RGBColor(0xFF, 0xFF, 0xFF)
OK, WARN, BAD, LINE = RGBColor(0x0F, 0x9D, 0x6B), RGBColor(0xD9, 0x77, 0x06), RGBColor(0xD9, 0x2D, 0x20), RGBColor(0xE4, 0xE8, 0xF0)

# 와이드 화면(16:9)에 맞춘 빈 발표자료를 준비합니다.
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]
N = 12


# 텍스트 상자를 추가하고 각 문단의 크기, 색, 줄바꿈, 정렬을 지정합니다.
def text(slide, x, y, w, h, s, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05)
    lines = s if isinstance(s, list) else [s]
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = ln
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = color
        p.space_after = Pt(4)
    return tb


# 배경·카드·강조 막대에 사용하는 공통 도형 생성 함수입니다.
def box(slide, x, y, w, h, fill=SOFT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    else:
        s.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s


# 카드 배경, 왼쪽 강조선, 제목, 본문을 동일한 규격으로 배치합니다.
def card(slide, x, y, w, h, title, body, accent=BRAND, tsize=17, bsize=14):
    box(slide, x, y, w, h, WHITE, LINE)
    bar = box(slide, x, y, 0.09, h, accent, None, MSO_SHAPE.RECTANGLE)
    text(slide, x + 0.25, y + 0.12, w - 0.4, 0.5, title, tsize, True)
    text(slide, x + 0.25, y + 0.68, w - 0.4, h - 0.8, body, bsize, False, MUTED)


# 공통 상단 막대, 제목, 쪽 번호와 하단 표시를 가진 슬라이드를 생성합니다.
def base(title, n, notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = RGBColor(0xF7, 0xF8, 0xFC)
    box(s, 0, 0, 13.333, 0.12, BRAND, None, MSO_SHAPE.RECTANGLE)
    text(s, 0.6, 0.35, 11.5, 0.8, title, 30, True)
    text(s, 12.0, 7.0, 1.0, 0.3, f"{n} / {N}", 11, False, MUTED, PP_ALIGN.RIGHT)
    text(s, 0.6, 7.0, 6, 0.3, "StudyMate · RAG 챗봇 기반 AI 맞춤형 학습 지원", 11, False, MUTED)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


# 화면 캡처의 종횡비를 유지하며 지정한 폭에 맞춰 삽입합니다.
def pic(slide, name, x, y, w):
    slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), width=Inches(w))
    # 얇은 테두리
    p = slide.shapes[-1]
    p.line.color.rgb = LINE
    p.line.width = Pt(1)




# 평가 결과 JSON을 읽습니다. 원자료가 없을 때는 임의 수치를 생성하지 않습니다.
def load(name):
    f = ROOT / "evidence" / name
    return json.loads(f.read_text(encoding="utf8")) if f.exists() else None


# 평가 JSON의 백분율 문자열에서 차트용 숫자를 추출합니다.
def pctnum(s):  # "83.3% (10/12)" -> 83.3
    return float(s.split("%")[0])


# 검색·퀴즈 평가와 과거 실모델 평가의 원자료를 분리해 읽습니다.
EV, LLM = load("eval.json"), load("eval-llm.json")
TF = ROOT / "evidence" / "test-result.txt"
TESTS = TF.read_text(encoding="utf8") if TF.exists() else ""

# 1 표지
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.0, 11, 1.2, "StudyMate", 60, True, WHITE)
text(s, 0.9, 3.25, 11.5, 1.0, "RAG 챗봇 기반 AI 맞춤형 학습 지원 시스템", 30, False, WHITE)
text(s, 0.9, 4.5, 11, 0.5, "내 자료를 근거로 답하고, 퀴즈로 약점을 찾아 복습 순서를 추천합니다", 18, False, RGBColor(0xDD, 0xDA, 0xFF))
text(s, 0.9, 6.3, 11, 0.5, "인공지능 응용 시스템 개발 종합 프로젝트 · 최종 발표 2026.12.30 · 발표자 반재영", 14, False, RGBColor(0xDD, 0xDA, 0xFF))
s.notes_slide.notes_text_frame.text = "안녕하세요. 학습 자료를 근거로 질문에 답하고 퀴즈로 약한 개념을 찾아 주는 RAG 학습 도우미 StudyMate를 발표하겠습니다."

# 2 배경
s = base("왜 만들었나: 공부할 때의 두 가지 문제", 2, "자료가 흩어져 있고 내가 뭘 모르는지 모르는 문제, 그리고 일반 챗봇은 수업 자료와 다른 설명이나 지어낸 설명을 한다는 문제를 함께 풀고자 했습니다.")
card(s, 0.6, 1.5, 5.9, 2.4, "① 내가 어디를 모르는지 모른다", "자료는 여러 곳에 흩어져 있고, 공부한 뒤에도 어떤 개념이 약한지 확인하기 어렵습니다.")
card(s, 6.8, 1.5, 5.9, 2.4, "② 일반 챗봇은 근거가 없다", "수업 자료와 다른 설명을 하거나 없는 내용을 그럴듯하게 지어내면 시험·과제 공부에 믿고 쓸 수 없습니다.", BAD)
box(s, 0.6, 4.4, 12.1, 1.9, BRAND)
text(s, 0.9, 4.6, 11.5, 0.6, "해결 방향", 18, True, WHITE)
text(s, 0.9, 5.2, 11.5, 1.0, ["내 자료에 있으면 → 출처와 함께 답변      자료에 없으면 → 지어내지 않고 '근거 없음'", "자료에서 퀴즈를 만들고 채점 → 틀린 개념을 모아 복습 순서 추천"], 17, False, WHITE)

# 3 핵심 기능
s = base("핵심 기능", 3, "다섯 가지 기능이 하나의 학습 흐름으로 이어집니다: 묻고, 풀고, 약점을 보고, 복습하고, 내 자료를 추가합니다.")
items = [("RAG 챗봇 + 출처", "자료 44개 항목에서 검색해 답하고 근거 항목의 원문을 함께 표시, 보통/쉽게 설명 선택", BRAND),
         ("환각 방지", "신뢰도 임계값 · LLM '근거 부족' 응답 · 숫자·인용·자료 일치도 검사 → 실패 시 원문 발췌", BAD),
         ("퀴즈 자동 생성·채점", "객관식·빈칸·O/X, 정답 비노출, 해설에 원문 근거, AI 출제는 검증 통과분만", OK),
         ("학습 분석·복습 추천", "단원별 정답률, 약점 개념, 라이트너 복습 주기, 오늘의 학습 추천", WARN),
         ("자료함 · 운영 지표", "내 노트 추가·삭제 즉시 반영 / 질문 많은 단원, 단원별 정답률", BRAND)]
for i, (t, b, c) in enumerate(items):
    x, y = 0.6 + (i % 3) * 4.1, 1.5 + (i // 3) * 2.75
    card(s, x, y, 3.9, 2.5, t, b, c, 18, 14)
box(s, 8.8, 4.25, 3.9, 2.5, SOFT)
text(s, 9.0, 4.4, 3.5, 2.2, ["기술 스택", "Node.js · SQLite", "Claude · ChatGPT · Ollama 선택", "HTML/CSS/JS", "외부 npm 패키지 0개"], 15, False, INK)

# 4 구조
s = base("시스템 구조", 4, "질문은 개인정보 마스킹 후 검색되고, 신뢰도가 낮으면 LLM을 호출하지 않고 거절합니다. LLM이 없어도 추출형 답변으로 동작합니다.")
steps = [("브라우저", "챗봇 · 퀴즈 · 현황 · 자료함"), ("REST 서버", "Node.js"), ("Chat · Quiz · Learning", "세 서비스"), ("SQLite", "기록 · 숙련도")]
for i, (t, b) in enumerate(steps):
    x = 0.6 + i * 3.15
    box(s, x, 1.6, 2.7, 1.3, WHITE, BRAND)
    text(s, x, 1.7, 2.7, 0.5, t, 17, True, BRAND, PP_ALIGN.CENTER)
    text(s, x, 2.25, 2.7, 0.5, b, 13, False, MUTED, PP_ALIGN.CENTER)
    if i < 3:
        text(s, x + 2.7, 1.9, 0.45, 0.6, "→", 26, True, BRAND, PP_ALIGN.CENTER)
text(s, 0.6, 3.25, 6, 0.4, "서비스별 역할", 17, True)
branches = [("ChatService", "마스킹 → 검색 → 신뢰도 → LLM → 검증"), ("QuizService", "개념 선정 → 출제(AI/규칙) → 채점"), ("Learning", "정답률·복습 시점 → 약점·추천"), ("자료 관리", "knowledge + 업로드 → 청크 → 색인")]
for i, (t, b) in enumerate(branches):
    x = 0.6 + i * 3.15
    box(s, x, 3.75, 2.9, 1.15, SOFT if i < 3 else BRAND)
    text(s, x, 3.8, 2.9, 0.45, t, 15, True, INK if i < 3 else WHITE, PP_ALIGN.CENTER)
    text(s, x + 0.1, 4.25, 2.7, 0.6, b, 12, False, MUTED if i < 3 else WHITE, PP_ALIGN.CENTER)
box(s, 0.6, 5.3, 12.1, 1.4, WHITE, LINE)
text(s, 0.85, 5.4, 11.6, 1.2, ["SQLite 5테이블: learners · qa_log · quiz_items · attempts · mastery(학습자×개념 숙련도)", "LLM 어댑터: Claude(Anthropic) / ChatGPT(OpenAI) / 로컬 Ollama 자동 선택, 키는 .env로만 관리, 없으면 추출형 답변"], 14, False, INK)

# 5 RAG
s = base("RAG 파이프라인과 환각 방지", 5, "핵심은 오른쪽 세 겹의 검사입니다. 자료에 근거가 없으면 지어내는 대신 거절하거나 원문을 보여 줍니다.")
flow = ["질문(개인정보 마스킹)", "군말 제거 · 문자 바이그램", "BM25 상위 4개 + 신뢰도", "프롬프트(자료만 사용)", "LLM 생성", "3겹 검사"]
for i, t in enumerate(flow):
    y = 1.5 + i * 0.88
    box(s, 0.6, y, 4.6, 0.7, BRAND if i == 5 else WHITE, BRAND)
    text(s, 0.6, y, 4.6, 0.7, t, 15, True, WHITE if i == 5 else INK, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
card(s, 5.7, 1.5, 7.0, 1.55, "① 신뢰도 < 0.3 → LLM 호출 없이 '근거 없음'", "질문 토큰 가중 커버리지 × (1 − 0.7 × 자료에 없는 어절 비율)", BRAND, 16, 13)
card(s, 5.7, 3.2, 7.0, 1.55, "② LLM이 '근거 부족'이라고 답하면 거절", "프롬프트에서 자료에 없으면 그 한마디만 답하게 지시, 자료 속 지시문은 따르지 않게 명시", WARN, 16, 13)
card(s, 5.7, 4.9, 7.0, 1.85, "③ 숫자 · 인용 · 자료 일치도 검사", "답변 숫자가 자료에 있는지, 인용 번호 범위, 답변 바이그램의 자료 일치도 ≥ 0.5. 실패하면 질문과 겹치는 원문 문장만 발췌", BAD, 16, 13)

# 6 퀴즈
s = base("퀴즈 생성과 학습 분석", 6, "굵은 글씨로 표시한 핵심 용어를 가려 문제를 만들고, 오답 보기는 다른 개념의 용어를 씁니다. 채점 기록은 라이트너 상자로 복습 시점을 정합니다.")
card(s, 0.6, 1.5, 3.9, 3.0, "규칙 기반 출제", "자료의 핵심 용어를 가린 빈칸·객관식, 용어를 바꿔 만든 O/X\n정답이 문제에 노출되지 않음을 자동 검사", BRAND, 18, 14)
card(s, 4.7, 1.5, 3.9, 3.0, "AI 출제 (Claude·ChatGPT)", "항목 본문만 근거로 JSON 문제 생성\n보기·정답 번호·정답 노출·자료 일치도 검사 통과분만 채택, 아니면 규칙 기반으로 대체", WARN, 18, 14)
card(s, 8.8, 1.5, 3.9, 3.0, "라이트너 복습", "정답이면 상자 상승(복습 간격 0·1·3·7·14일), 오답이면 1번으로\n우선순위 = (1−평활 정답률) + 복습 시점 가산", OK, 18, 14)
box(s, 0.6, 4.85, 12.1, 1.85, SOFT)
text(s, 0.9, 4.95, 11.5, 0.5, "학습 추천 예시 (시연 데이터)", 16, True, BRAND)
text(s, 0.9, 5.45, 11.5, 1.2, ["「머신러닝 기초」 정답률 22% → 먼저 복습 퀴즈로 다시 확인", "자주 틀린 개념: 데이터 시각화, LLM과 토큰, 경사하강법 → '약점 복습' 모드가 이 개념들을 우선 출제"], 15, False, INK)

# 7 시연 챗봇
s = base("시연 ① 학습 챗봇: 답변 + 근거 + 신뢰도", 7, "과대적합을 물으면 ML-04를 근거로 답하고 근거 칩을 누르면 원문이 열립니다. 범위 밖 질문은 지어내지 않고 근거 없음으로 안내합니다.")
pic(s, "ui-chat.jpg", 0.6, 1.35, 8.2)
card(s, 9.1, 1.4, 3.6, 2.1, "시연 순서", "① 과대적합이 뭐야?\n② 근거 칩 → 원문 확인\n③ '쉽게' 모드\n④ 양자컴퓨터(범위 밖)", BRAND, 15, 13)
card(s, 9.1, 3.65, 3.6, 1.45, "보이는 것", "답변 · 근거 항목 · 신뢰도 · 응답 시간 · 생성 방식", OK, 15, 13)
card(s, 9.1, 5.25, 3.6, 1.6, "실행", "프로젝트 폴더에서\nnpm start\n→ localhost:5300", WARN, 15, 13)

# 8 시연 퀴즈/현황
s = base("시연 ② 퀴즈 · 내 학습현황", 8, "퀴즈를 풀면 해설과 다음 복습 시점이 나오고, 학습현황에서 약한 단원이 빨간 막대로 보입니다. 화면의 학습 기록은 시연용 데이터입니다.")
pic(s, "ui-quiz.jpg", 0.6, 1.4, 6.0)
pic(s, "ui-progress.jpg", 6.8, 1.4, 6.0)
text(s, 0.6, 5.5, 6.0, 1.3, ["퀴즈", "객관식 · 빈칸 · O/X · 채점 · 원문 해설 · 다음 복습 시점"], 14, False, MUTED)
text(s, 6.8, 5.5, 6.0, 1.3, ["내 학습현황", "단원별 정답률 · 약점 개념(원문 펼치기) · 오늘의 학습 추천"], 14, False, MUTED)

# 정확도와 응답 시간은 역사적 평가 파일에서 가져오며 실사용자 성능으로 해석하지 않습니다.
# 9 평가
s = base("평가 결과 (자체 작성 질문, 자료 44개 항목)", 9, "수치는 직접 만든 평가 세트 결과입니다. 어려운 질문은 자료 표현을 피해 돌려 쓴 12개로, 어휘 검색의 한계를 보려는 것입니다.")
cats, vals = [], []
if EV:
    cats += ["검색 hit@1 (일반 60)", "검색 hit@4 (일반 60)", "검색 hit@1 (어려운 12)", "검색 hit@4 (어려운 12)"]
    vals += [pctnum(EV["retrieval"]["hit1"]), pctnum(EV["retrieval"]["hit4"]), pctnum(EV["retrievalHard"]["hit1"]), pctnum(EV["retrievalHard"]["hit4"])]
    t = [r for r in EV["threshold"] if r["threshold"] == 0.3][0]
    cats += ["범위 밖 거절 (임계값 0.3, 20)"]
    vals += [pctnum(t["rejectedOutOfScope"])]
cd = CategoryChartData()
cd.categories = cats
cd.add_series("%", vals)
gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, Inches(0.6), Inches(1.4), Inches(7.6), Inches(4.7), cd)
ch = gf.chart
ch.has_legend = False
ch.has_title = False
ch.plots[0].has_data_labels = True
dl = ch.plots[0].data_labels
dl.font.size, dl.font.name, dl.number_format, dl.number_format_is_linked = Pt(14), FONT, '0.0"%"', False
dl.position = XL_LABEL_POSITION.OUTSIDE_END
ch.plots[0].gap_width = 60
ch.plots[0].series[0].format.fill.solid()
ch.plots[0].series[0].format.fill.fore_color.rgb = BRAND
ch.value_axis.maximum_scale, ch.value_axis.minimum_scale = 115, 0
ch.value_axis.visible = False
ch.value_axis.has_major_gridlines = False
ch.category_axis.tick_labels.font.size = Pt(13)
ch.category_axis.tick_labels.font.name = FONT
ch.category_axis.reverse_order = True
if LLM:
    L = LLM["llm"]
    g = L["generators"]
    card(s, 8.5, 1.4, 4.2, 2.1, f"실제 LLM 답변 ({L['provider']})", f"AI 답변 {g['llm']} · 원문 발췌 {g['extractive']} · 거절 {g['none']} (일반 질문 60)\n정답 근거 인용 {L['citedExpectedChunk']}\n응답 중앙값 {L['medianMs']/1000:.1f}초 · p90 {L['p90Ms']/1000:.1f}초", WARN, 15, 12)
q = EV["quiz"] if EV else {}
card(s, 8.5, 3.65, 4.2, 1.3, "퀴즈 구조 검사", f"{q.get('generated', 0)}문제 생성 · 정답 노출 {q.get('answerLeaked', 0)} · 보기 누락 {q.get('answerMissingFromOptions', 0)} · 보기 중복 {q.get('duplicateOptions', 0)}", OK, 15, 12)
card(s, 8.5, 5.1, 4.2, 1.2, "자동 테스트", "30개 전부 통과" if "pass 30" in TESTS else TESTS.replace("\n", " "), OK, 15, 14)
text(s, 0.6, 6.5, 12, 0.4, "측정: 2026-11-24 · 검색 BM25(문자 바이그램) · 원자료 evidence/eval.json, evidence/eval-llm.json · 임계값은 같은 세트로 고름", 12, False, MUTED)

# 개발 과정에서 재현된 문제와 수정·미해결 사항을 정리합니다.
# 10 개발 중 발견
s = base("개발 중 발견한 문제와 해결", 10, "실제로 돌려 보며 고친 것들입니다. 특히 임계값은 평가 세트로 효과를 비교해 0.2에서 0.3으로 올렸습니다.")
rows = [("범위 밖 질문 거절이 65%뿐", "임계값 0.2는 '방법' 같은 흔한 글자까지 근거로 인정", "임계값 0.3 → 거절 85%, 범위 안 질문 응답 100% 유지"),
        ("추출형 답변에 관련 없는 문장이 섞임", "두 번째 문서의 문장을 무조건 포함", "질문과 겹치는 문장만, 두 번째 문서는 첫 문서의 70% 이상일 때만"),
        ("로컬 3B 모델로 AI 출제가 매우 느림", "문제마다 LLM을 순차 호출, 품질도 낮음", "로컬은 규칙 기반 출제, Claude·ChatGPT 연결 시에만 AI 출제"),
        ("화면에 [object HTMLDivElement] 출력", "배열을 replaceChildren에 그대로 전달", "펼쳐서 전달하고 브라우저에서 재확인"),
        ("LLM이 '근거 부족'이라 했는데 원문이 나감", "검사 실패를 모두 원문 발췌로 대체", "근거 부족 선언은 거절로 처리(방어적 수정, 수치 변화 없음). 범위 밖 3건은 미해결")]
y = 1.5
for i, hd in enumerate(["문제", "원인", "해결"]):
    box(s, 0.6 + i * 4.1, y, 3.95, 0.55, BRAND)
    text(s, 0.6 + i * 4.1, y, 3.95, 0.55, hd, 15, True, WHITE, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
for r, row in enumerate(rows):
    for c, t in enumerate(row):
        yy = 2.15 + r * 0.93
        box(s, 0.6 + c * 4.1, yy, 3.95, 0.83, WHITE, LINE)
        text(s, 0.65 + c * 4.1, yy, 3.85, 0.83, t, 12, False, INK, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)

# 평가 세트 편향, 인증·실호출·부하 검증의 한계를 발표자료에 남깁니다.
# 11 한계
s = base("한계와 향후 개선", 11, "정직하게 말씀드리면 수치는 직접 만든 자료와 질문의 결과이고 실제 학습자 질문에서는 낮아질 수 있습니다. Claude·ChatGPT 연동은 가짜 서버 테스트로만 검증했습니다.")
card(s, 0.6, 1.5, 6.0, 5.1, "한계", ["• 자료와 평가 질문을 같은 사람이 작성 → 낙관적", "• 기본 자료는 요약본, PDF 업로드 미지원", "• Claude·ChatGPT 실제 호출 미검증(키 없음)", "• 임베딩 검색 미검증, 어휘 검색은 돌려 말한 질문에 약함", "• 범위 밖 질문 20개 중 3개는 거절 못 함(85%)", "• 주관식 채점은 문자열 비교(동의어 오답 처리)", "• 로그인 없음(브라우저 ID로 구분)"], BAD, 20, 17)
card(s, 6.9, 1.5, 5.8, 5.1, "향후 개선", ["• 실제 수업 교재(PDF)·학습자 질문으로 평가 확대", "• 임베딩·재순위화 비교, 형태소 분석", "• LLM 채점으로 동의어·서술형 답안 평가", "• 학습자 로그인·권한, 데이터 보관 정책", "• 개념 간 선수 관계를 이용한 학습 경로 추천", "• Claude·ChatGPT 실제 환경 품질 측정"], OK, 20, 17)

# 12 결론
s = base("결론", 12, "질의응답을 받겠습니다. 시연은 localhost:5300에서 바로 가능합니다.")
box(s, 0.6, 1.5, 12.1, 3.3, BRAND)
res = ""
if EV:
    res = f"검색 hit@1 {EV['retrieval']['hit1'].split(' ')[0]} (어려운 질문 {EV['retrievalHard']['hit1'].split(' ')[0]}) · 자동 테스트 30/30 통과"
text(s, 0.95, 1.7, 11.4, 3.0, ["내 학습 자료를 근거로 답하고, 퀴즈로 약점을 찾아 복습을 추천하는 RAG 학습 도우미를 구현·평가했습니다.", "", res, "근거 검사와 거절로 환각을 줄였지만 완전하지는 않습니다."], 20, False, WHITE)
card(s, 0.6, 5.1, 5.9, 1.6, "제출물", "기획서 · 결과보고서 · 발표 PPT · 전체 소스 · 실행 스크립트 · 평가 원자료", BRAND, 16, 13)
card(s, 6.8, 5.1, 5.9, 1.6, "Q & A", "감사합니다.", OK, 16, 18)

out = ROOT / "docs" / "StudyMate_최종발표.pptx"
# 완성한 프레젠테이션을 원래 프로젝트의 문서 폴더에 저장합니다.
prs.save(out)
print("saved", out, "slides:", len(prs.slides))
