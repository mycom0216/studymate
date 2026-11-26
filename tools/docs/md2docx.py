"""Convert the project Markdown documents to editable Word files.
Preserves headings, lists, fenced code, tables, inline code, bold text and diagrams.
Usage: python tools/docs/md2docx.py input.md output.docx
"""
import os
import re
import sys
from pathlib import Path
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from PIL import Image

FONT = os.environ.get('DOCS_FONT', 'Malgun Gothic' if os.name == 'nt' else 'Noto Sans CJK KR')
MONO = 'Consolas' if os.name == 'nt' else 'DejaVu Sans Mono'
BODY_WIDTH = 16.6


def set_font(run, size=10.5, bold=None, mono=False, color=None):
    run.font.name = MONO if mono else FONT
    rpr = run._element.get_or_add_rPr()
    rpr.rFonts.set(qn('w:eastAsia'), FONT)
    run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    return run


def add_inline(par, text, size=10.5):
    # Link labels stay readable and destinations are retained as plain text.
    text = re.sub(r'(?<!!)\[([^\]]+)\]\(([^)]+)\)', r'\1 (\2)', text)
    for part in re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', text):
        if not part:
            continue
        if part.startswith('**'):
            set_font(par.add_run(part[2:-2]), size, True)
        elif part.startswith('`'):
            set_font(par.add_run(part[1:-1]), size-0.5, mono=True, color='4F46E5')
        else:
            set_font(par.add_run(part), size)


def shade(cell, fill):
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill)
    cell._element.get_or_add_tcPr().append(shd)


def table_cells(line):
    """Pipes inside inline code and escaped pipes are not cell separators."""
    s = line.strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|'):
        s = s[:-1]
    cells, buf, code, i = [], [], False, 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i+1 < len(s) and s[i+1] == '|':
            buf.append('|'); i += 2; continue
        if c == '`':
            code = not code
        if c == '|' and not code:
            cells.append(''.join(buf).strip()); buf=[]
        else:
            buf.append(c)
        i += 1
    cells.append(''.join(buf).strip())
    return cells


def picture_size(path, width, max_height):
    with Image.open(path) as im:
        w, h = im.size
    return Cm(min(width, max_height * w / max(h, 1)))


def add_table(doc, rows, base, src):
    n = len(rows[0])
    if any(len(row) != n for row in rows):
        raise ValueError(f'{src}: table column mismatch: expected {n}, got {[len(r) for r in rows]}')
    table = doc.add_table(rows=len(rows), cols=n)
    table.style = 'Table Grid'; table.autofit = False
    weights = [min(max(len(re.sub(r'[*`]', '', row[c])) for row in rows), 48)+7 for c in range(n)]
    if any(re.match(r'!\[', x) for r in rows for x in r):
        weights = [1]*n
    minimum = min(1.35, BODY_WIDTH/n*0.72)
    widths = [minimum + (BODY_WIDTH-minimum*n)*w/sum(weights) for w in weights]
    for c, width in enumerate(widths):
        table.columns[c].width = Cm(width)
        for row in table.rows:
            row.cells[c].width = Cm(width)
    for r, row in enumerate(rows):
        trpr = table.rows[r]._tr.get_or_add_trPr()
        trpr.append(OxmlElement('w:cantSplit'))
        if r == 0:
            trpr.append(OxmlElement('w:tblHeader'))
        for c, txt in enumerate(row):
            cell = table.cell(r,c)
            par = cell.paragraphs[0]
            par.paragraph_format.space_after = Pt(3)
            par.paragraph_format.space_before = Pt(2)
            par.paragraph_format.line_spacing = 1.06
            pm = re.fullmatch(r'!\[[^\]]*\]\(([^)]+)\)', txt)
            if pm:
                f = base / pm.group(1)
                if not f.is_file(): raise FileNotFoundError(f)
                par.alignment = WD_ALIGN_PARAGRAPH.CENTER
                par.add_run().add_picture(str(f), width=picture_size(f, widths[c]-0.32, 8.5))
            else:
                add_inline(par, txt, 8.8 if n>=5 else 9.5)
            if r == 0:
                shade(cell, 'ECEAFD')
                for run in par.runs:
                    run.font.bold = True
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def convert(src, dst):
    src=Path(src); lines=src.read_text(encoding='utf-8').splitlines(); base=src.parent
    doc=Document(); sec=doc.sections[0]
    sec.page_width=Cm(21); sec.page_height=Cm(29.7)
    sec.left_margin=sec.right_margin=Cm(2.2)
    sec.top_margin=Cm(2.0); sec.bottom_margin=Cm(2.0)
    sec.header_distance=Cm(0.8); sec.footer_distance=Cm(0.8)
    normal=doc.styles['Normal']; normal.font.name=FONT; normal.font.size=Pt(10.5)
    normal.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), FONT)
    normal.paragraph_format.line_spacing=1.12; normal.paragraph_format.space_after=Pt(4)
    for name in ('List Bullet','List Number','Title','Heading 1','Heading 2','Heading 3'):
        st=doc.styles[name]; st.font.name=FONT;st.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),FONT)
        if name.startswith('Heading') or name=='Title':st.paragraph_format.keep_with_next=True
    project=src.stem.split('_',1)[0]
    hp=sec.header.paragraphs[0]; hp.alignment=WD_ALIGN_PARAGRAPH.RIGHT
    set_font(hp.add_run(project+' · 프로젝트 문서'),8.5,color='667085')
    fp=sec.footer.paragraphs[0]; fp.alignment=WD_ALIGN_PARAGRAPH.CENTER
    set_font(fp.add_run(project+'  |  '),8.5,color='667085')
    fld=OxmlElement('w:fldSimple');fld.set(qn('w:instr'),'PAGE');fp._p.append(fld)
    i=0
    while i<len(lines):
        ln=lines[i]
        if ln.startswith('```'):
            i+=1; block=[]
            while i<len(lines) and not lines[i].startswith('```'):
                block.append(lines[i]);i+=1
            p=doc.add_paragraph();p.paragraph_format.left_indent=Cm(.25);p.paragraph_format.line_spacing=1.0
            for k,b in enumerate(block):set_font(p.add_run(b+ ('\n' if k<len(block)-1 else '')),8.1,mono=True)
            i+=1;continue
        if ln.startswith('|') and i+1<len(lines) and re.match(r'^\|[\s:|-]+\|$',lines[i+1]):
            rows=[]
            while i<len(lines) and lines[i].startswith('|'):
                if not re.match(r'^\|[\s:|-]+\|$',lines[i]):rows.append(table_cells(lines[i]))
                i+=1
            add_table(doc,rows,base,src);continue
        m=re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)',ln.strip())
        if m:
            f=base/m.group(2)
            if not f.is_file():raise FileNotFoundError(f)
            p=doc.add_paragraph();p.alignment=WD_ALIGN_PARAGRAPH.CENTER
            p.add_run().add_picture(str(f),width=picture_size(f,15.6,21.0))
            if m.group(1):
                cp=doc.add_paragraph();cp.alignment=WD_ALIGN_PARAGRAPH.CENTER;set_font(cp.add_run(m.group(1)),9,color='667085')
            i+=1;continue
        m=re.match(r'^(#{1,6})\s+(.*)$',ln)
        if m:
            level=len(m.group(1)); p=doc.add_paragraph(style='Title' if level==1 else f'Heading {min(level-1,3)}')
            p.paragraph_format.keep_with_next=True
            p.paragraph_format.space_before=Pt(0 if level==1 else (12 if level==2 else 8))
            p.paragraph_format.space_after=Pt(5)
            set_font(p.add_run(m.group(2)),22 if level==1 else (15 if level==2 else 12),True,color='3730A3' if level<3 else '1C2333')
        elif re.match(r'^\s*- ',ln):
            p=doc.add_paragraph(style='List Bullet');add_inline(p,re.sub(r'^\s*- ','',ln))
        elif re.match(r'^\d+\. ',ln):
            p=doc.add_paragraph(style='List Number');add_inline(p,re.sub(r'^\d+\. ','',ln))
        elif ln.startswith('> '):
            p=doc.add_paragraph();p.paragraph_format.left_indent=Cm(.3);add_inline(p,ln[2:],10)
        elif ln.strip() and not re.fullmatch(r'---+',ln.strip()):
            add_inline(doc.add_paragraph(),ln)
        i+=1
    doc.core_properties.title=src.stem.replace('_',' ')
    doc.save(dst);print('saved',dst)


if __name__=='__main__':
    convert(sys.argv[1],sys.argv[2])
