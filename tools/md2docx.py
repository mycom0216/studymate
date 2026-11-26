"""간단한 마크다운 → Word(.docx) 변환기. 제출 문서(기획서·결과보고서) 생성용.
사용법: python tools/md2docx.py docs/StudyMate_기획서.md docs/StudyMate_기획서.docx
지원: # ## ### 제목, 표, 코드블록, 이미지, 글머리표/번호 목록, **굵게**, `코드`
"""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# 한국어 제출 문서의 기본 글꼴을 정합니다.
FONT = "Malgun Gothic"


# 동아시아 글꼴을 함께 지정해 한글이 다른 글꼴로 바뀌는 현상을 줄입니다.
def set_font(run, size=None, bold=None, mono=False, color=None):
    name = "Consolas" if mono else FONT
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


# 마크다운의 굵게·인라인 코드를 여러 Word 런으로 나누어 표현합니다.
def add_inline(par, text, size=10.5):
    for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**"):
            set_font(par.add_run(part[2:-2]), size, True)
        elif part.startswith("`"):
            set_font(par.add_run(part[1:-1]), size - 0.5, mono=True, color="4F46E5")
        else:
            set_font(par.add_run(part), size)


# 표의 셀에 배경색을 넣기 위해 WordprocessingML 속성을 설정합니다.
def shade(cell, hex_fill):
    tcPr = cell._element.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcPr.append(shd)


# 마크다운을 위에서 아래로 읽으며 지원하는 문서 요소를 순서대로 생성합니다.
def convert(src, dst):
    lines = Path(src).read_text(encoding="utf-8").splitlines()
    base = Path(src).parent
    # 새 문서와 페이지 여백, 기본 서식을 설정합니다.
    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)
    doc.styles["Normal"].font.name = FONT
    doc.styles["Normal"].element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    i = 0
    # 한 블록을 처리할 때 읽은 줄 수만큼 인덱스를 이동합니다.
    while i < len(lines):
        ln = lines[i]
        # 코드 블록은 닫는 백틱까지 모아 들여쓰기와 고정폭 글꼴을 적용합니다.
        if ln.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.4)
            for k, b in enumerate(block):
                set_font(p.add_run(b + ("\n" if k < len(block) - 1 else "")), 8.5, mono=True)
            i += 1
            continue
        # 표 헤더의 구분선을 제외하고 행·열 데이터를 Word 표로 변환합니다.
        if ln.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                if not re.match(r"^\|[\s:|-]+\|$", lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = doc.add_table(rows=len(rows), cols=len(rows[0]))
            t.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, txt in enumerate(row):
                    cell = t.cell(r, c)
                    cell.text = ""
                    par = cell.paragraphs[0]
                    pm = re.match(r"!\[[^\]]*\]\(([^)]+)\)", txt)
                    if pm and (base / pm.group(1)).exists():
                        par.add_run().add_picture(str(base / pm.group(1)), width=Cm(7.4))
                        continue
                    add_inline(par, txt, 9.5)
                    if r == 0:
                        shade(cell, "ECEAFD")
                        for run in par.runs:
                            run.font.bold = True
            doc.add_paragraph()
            continue
        # 독립 이미지의 상대 경로를 원본 마크다운 파일 위치 기준으로 해석합니다.
        m = re.match(r"!\[[^\]]*\]\(([^)]+)\)", ln)
        if m:
            f = base / m.group(1)
            if f.exists():
                doc.add_picture(str(f), width=Cm(15))
                doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            i += 1
            continue
        # 제목 수준, 목록, 일반 문단을 각각 구분해 서식을 적용합니다.
        if ln.startswith("# "):
            p = doc.add_paragraph()
            set_font(p.add_run(ln[2:]), 22, True, color="3730A3")
        elif ln.startswith("## "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14)
            set_font(p.add_run(ln[3:]), 15, True, color="3730A3")
        elif ln.startswith("### "):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(8)
            set_font(p.add_run(ln[4:]), 12, True)
        elif re.match(r"^\s*- ", ln):
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, re.sub(r"^\s*- ", "", ln))
        elif re.match(r"^\d+\. ", ln):
            p = doc.add_paragraph(style="List Number")
            add_inline(p, re.sub(r"^\d+\. ", "", ln))
        elif ln.strip():
            p = doc.add_paragraph()
            add_inline(p, ln)
        i += 1
    # 모든 블록 처리 후 지정된 경로에 DOCX를 기록합니다.
    doc.save(dst)
    print("saved", dst)


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
