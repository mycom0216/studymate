"""발표자료 보강: python tools/docs/build_deck.py
기존 최종 발표(docs/StudyMate_최종발표.pptx, 12장)의 복사본에 빠져 있던 그림과 정직한 측정 결과를 넣어 docs/StudyMate_발표자료.pptx 를 만듭니다.
  · 데이터 구조(ERD)            ← 시스템 구조 슬라이드 다음
  · 질문 처리 순서도            ← RAG 파이프라인 슬라이드 다음
  · 퀴즈 출제·채점 순서도       ← 퀴즈 생성 슬라이드 다음
  · 임계값 선택과 재현 확인     ← 평가 결과 슬라이드 다음
  · 검증 범위(확인한 것/못 한 것) ← 한계와 향후 개선 슬라이드 다음
새 슬라이드는 기존 슬라이드의 막대·제목·쪽 번호·카드 도형을 복사해 같은 모양으로 만듭니다(글꼴·색 그대로).
수치는 evidence/ 원자료와 2026-11-26 재실행 결과(npm test 30/30, node tools/eval.mjs 동일)를 따릅니다.
"""
import copy
import re
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent.parent.parent          # StudyMate/
SRC = ROOT / "docs" / "StudyMate_최종발표.pptx"
IMG = ROOT / "docs" / "images"
OUT = ROOT / "docs" / "StudyMate_발표자료.pptx"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

prs = Presentation(str(SRC))
orig = list(prs.slides)
ref = orig[2]          # '핵심 기능' 슬라이드: 막대·제목·쪽 번호·카드 모양의 견본
bar_src, title_src, num_src, foot_src = ref.shapes[0], ref.shapes[1], ref.shapes[2], ref.shapes[3]
box_src, accent_src, ctitle_src, cbody_src = ref.shapes[4], ref.shapes[5], ref.shapes[6], ref.shapes[7]
BRAND, SOFT, INK, MUTED = RGBColor(0x4F, 0x46, 0xE5), RGBColor(0xEC, 0xEA, 0xFD), RGBColor(0x1C, 0x23, 0x33), RGBColor(0x66, 0x70, 0x85)
FONT = "Malgun Gothic"


def clone(slide, src, text=None, x=None, y=None, w=None, h=None):
    """견본 도형을 복사하고(선택) 글자·위치를 바꿉니다. text가 리스트면 문단을 여러 개로 만듭니다."""
    el = copy.deepcopy(src._element)
    slide.shapes._spTree.append(el)
    shp = slide.shapes[-1]
    if text is not None:
        lines = text if isinstance(text, list) else [text]
        tx = shp._element.find(f"{P}txBody")
        paras = tx.findall(f"{A}p")
        first = paras[0]
        for extra in paras[1:]:
            tx.remove(extra)
        for i, ln in enumerate(lines):
            para = first if i == 0 else copy.deepcopy(first)
            if i > 0:
                tx.append(para)
            runs = para.findall(f"{A}r")
            runs[0].find(f"{A}t").text = ln
            for r in runs[1:]:
                para.remove(r)
    if x is not None:
        shp.left, shp.top, shp.width, shp.height = Emu(int(x * 914400)), Emu(int(y * 914400)), Emu(int(w * 914400)), Emu(int(h * 914400))
    return shp


def new_slide(title):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = ref._element.cSld.find(f"{P}bg")           # 슬라이드마다 따로 지정된 연한 배경을 복사
    if bg is not None:
        s._element.cSld.insert(0, copy.deepcopy(bg))
    clone(s, bar_src)
    clone(s, title_src, title)
    clone(s, num_src)
    clone(s, foot_src)
    return s


def card(slide, x, y, w, h, title, body, tsize=17, bsize=13):
    clone(slide, box_src, None, x, y, w, h)
    clone(slide, accent_src, None, x, y, 0.09, h)
    t = clone(slide, ctitle_src, title, x + 0.25, y + 0.1, w - 0.4, 0.45)
    t.text_frame.paragraphs[0].runs[0].font.size = Pt(tsize)
    b = clone(slide, cbody_src, body, x + 0.25, y + 0.6, w - 0.4, h - 0.7)
    for para in b.text_frame.paragraphs:
        for r in para.runs:
            r.font.size = Pt(bsize)
    return b


def picture(slide, name, x, y, h):
    pic = slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), height=Inches(h))
    return pic


# 1) 데이터 구조(ERD)
erd = new_slide("데이터 구조 (ERD)")
pic = picture(erd, "erd.png", 0.6, 1.3, 5.55)
cx = pic.left / 914400 + pic.width / 914400 + 0.3
cw = 12.75 - cx
card(erd, cx, 1.35, cw, 1.6, "SQLite 5테이블", ["learners · qa_log · quiz_items", "attempts · mastery(학습자×개념 숙련도)"])
card(erd, cx, 3.1, cw, 1.6, "관계는 논리적 참조", ["FOREIGN KEY·CHECK 제약 없음", "소유자 확인·1회 채점은 코드가 보장"])
card(erd, cx, 4.85, cw, 1.9, "학습 자료는 DB가 아닌 파일", ["knowledge/*.md 6단원 44항목", "data/materials/u{n}.md(사용자 자료)", "chunk_id가 항목 ID(예: ML-04)를 가리킴"])

# 2) 질문 처리 순서도
chat = new_slide("질문 처리 순서도 (POST /api/chat)")
pic = picture(chat, "flow-chat.png", 0.6, 1.25, 5.6)
cx = pic.left / 914400 + pic.width / 914400 + 0.35
cw = 12.75 - cx
card(chat, cx, 1.35, cw, 1.75, "3겹 환각 방지", ["① 신뢰도 < 0.3 → LLM 호출 없이 거절", "② LLM이 '근거 부족' → 거절", "③ 숫자·인용·일치도(≥0.5) 검사 실패 → 원문 발췌"])
card(chat, cx, 3.25, cw, 1.6, "LLM이 없어도 동작", ["키·서버가 없거나 호출이 실패하면 추출형 답변", "(질문과 겹치는 원문 문장만). 모든 경로를 기록"])
card(chat, cx, 5.0, cw, 1.75, "알려진 한계 (미해결)", ["범위 밖 20개 중 3개는 거절 못 함(85%)", "신뢰도가 정상 질문과 겹쳐 임계값으로 구분 불가"])

# 3) 퀴즈 출제·채점 순서도
quiz = new_slide("퀴즈 출제와 채점 순서도")
p1 = picture(quiz, "flow-quiz.png", 0.5, 1.25, 5.55)
p2 = picture(quiz, "flow-grade.png", p1.left / 914400 + p1.width / 914400 + 0.15, 1.25, 5.55)
cx = p2.left / 914400 + p2.width / 914400 + 0.3
cw = 12.75 - cx
card(quiz, cx, 1.35, cw, 1.75, "출제", ["약점·복습 시점 우선 N개", "AI 출제는 검사 통과분만", "아니면 규칙 기반, 정답은 응답에서 제외"], tsize=16, bsize=12)
card(quiz, cx, 3.25, cw, 1.75, "채점·복습", ["문제당 1회 채점(조건부 UPDATE)", "정답 상자 +1 / 오답 1번", "간격 0·1·3·7·14일"], tsize=16, bsize=12)
card(quiz, cx, 5.15, cw, 1.6, "한계", ["주관식은 문자열 비교(동의어 오답)", "AI 출제는 가짜 LLM으로만 검증"], tsize=16, bsize=12)

# 4) 임계값 선택과 재현 확인
thr = new_slide("임계값 선택과 재현 확인")
rows = [("임계값", "일반 질문 응답(60)", "어려운 질문 응답(12)", "범위 밖 거절(20)"),
        ("0.15", "100.0%", "100.0%", "55.0%"), ("0.20", "100.0%", "91.7%", "65.0%"), ("0.25", "100.0%", "83.3%", "65.0%"),
        ("0.30 (채택)", "100.0%", "83.3%", "85.0%"), ("0.40", "96.7%", "66.7%", "90.0%")]
gs = thr.shapes.add_table(len(rows), 4, Inches(0.6), Inches(1.45), Inches(7.3), Inches(3.6))
tbl = gs.table
for c, wd in enumerate([1.7, 1.9, 2.0, 1.7]):
    tbl.columns[c].width = Inches(wd)
for r, row in enumerate(rows):
    for c, txt in enumerate(row):
        cell = tbl.cell(r, c)
        cell.text = txt
        cell.fill.solid()
        cell.fill.fore_color.rgb = BRAND if r == 0 else (SOFT if r == 4 else RGBColor(0xFF, 0xFF, 0xFF))
        para = cell.text_frame.paragraphs[0]
        para.alignment = PP_ALIGN.CENTER
        run = para.runs[0]
        run.font.name, run.font.size = FONT, Pt(14)
        run.font.bold = r in (0, 4)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF) if r == 0 else INK
note = clone(thr, cbody_src, ["측정 2026-11-24, 2026-11-26 재실행 결과 동일 · 자료 44개 항목 · 원자료 evidence/eval.json"], 0.6, 5.25, 7.3, 0.6)
note.text_frame.paragraphs[0].runs[0].font.size = Pt(12)
card(thr, 8.2, 1.45, 4.55, 1.55, "0.3을 채택한 이유", ["범위 안 질문 응답 100% 유지", "범위 밖 거절 65% → 85%"])
card(thr, 8.2, 3.15, 4.55, 1.7, "낙관적일 수 있음", ["임계값을 평가 세트로 골랐음", "12월에 선정용·검증용 세트 분리 예정"])
card(thr, 8.2, 5.0, 4.55, 1.75, "해석 주의", ["돌려 말한 질문은 hit@1 83.3%", "자료·질문 모두 개발자가 작성"])

# 5) 검증 범위
ver = new_slide("검증 범위: 확인한 것과 못 한 것")
card(ver, 0.6, 1.4, 5.95, 5.3, "확인함", [
    "• 자동 테스트 30/30 통과(11/26 재실행)",
    "• 평가 재실행 결과 11/24 원자료와 동일",
    "• 검색 hit@1: 일반 100% · 어려운 83.3%",
    "• 퀴즈 132문제 구조 검사 오류 0건",
    "• 로컬 Ollama(kanana2:3b) 80문항 실측",
    "  AI 55 · 원문 대체 5 · 거절 17/20",
    "• Claude·ChatGPT·카카오 요청 형식(가짜 서버·자동 테스트)",
], tsize=19, bsize=15)
card(ver, 6.8, 1.4, 5.95, 5.3, "확인하지 못함", [
    "• Claude·ChatGPT 실호출(키 없음, 기본 모델 ID 포함)",
    "• 카카오 오픈빌더 실제 채널 연동",
    "• 임베딩 혼합 검색(이 PC에서 미검증)",
    "• 실제 수업 교재·실제 학습자 질문",
    "• 학습 효과, 부하·동시접속",
    "• 답변 문장의 정확성 전수 검토",
    "• 범위 밖 질문 3건 거절(미해결)",
], tsize=19, bsize=15)

# 순서: 원본 1~4, ERD, 원본 5, 질문 순서도, 원본 6, 퀴즈 순서도, 원본 7~9, 임계값, 원본 10~11, 검증 범위, 원본 12
lst = prs.slides._sldIdLst
ids = list(lst)
o = ids[: len(orig)]
e, c, q, t, v = ids[len(orig):]
order = o[:4] + [e] + o[4:5] + [c] + o[5:6] + [q] + o[6:9] + [t] + o[9:11] + [v] + o[11:]
for el in ids:
    lst.remove(el)
for el in order:
    lst.append(el)

# 쪽 번호를 "n / 전체"로 다시 매깁니다(제목 슬라이드 제외).
total = len(prs.slides)
for i, s in enumerate(prs.slides, 1):
    for shp in s.shapes:
        if shp.has_text_frame and re.fullmatch(r"\d+ / \d+", shp.text_frame.text.strip()):
            shp.text_frame.paragraphs[0].runs[0].text = f"{i} / {total}"

# Use the exact values from the historical evaluation JSON, not differently rounded slide labels.
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            for par in shape.text_frame.paragraphs:
                for run in par.runs:
                    run.text = run.text.replace("응답 중앙값 2.5초 · p90 5.3초", "응답 중앙값 2.55초 · p90 5.274초")
prs.save(str(OUT))
print("saved", OUT, "slides:", total)
