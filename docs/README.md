# StudyMate 문서 묶음

작성자 반재영 · 과목: 인공지능 응용 시스템 개발 종합 프로젝트 · 작성 2026-11-26

| 문서 | 파일 |
|---|---|
| 기획서 (11/26 인수인계 보완) | `StudyMate_기획서` (.md · .docx · .pdf) |
| 최종 결과보고서 (11/26 정정 및 재검증) | `StudyMate_결과보고서` (.md · .docx · .pdf) |
| 요구사항 분석서 | `StudyMate_요구사항분석서` (.md · .docx · .pdf) |
| 요구사항 명세서 (FR/NFR, API, 검증 매핑) | `StudyMate_요구사항명세서` |
| 데이터정의서 (ERD 포함) | `StudyMate_데이터정의서`, `images/erd.png` |
| 순서도 4종 (개발 절차 · 질문 처리 · 퀴즈 출제 · 채점) | `StudyMate_순서도`, `images/flow-*.png` |
| 개발일정표 | `StudyMate_개발일정표` |
| 포트폴리오 | `StudyMate_포트폴리오` |
| 발표자료 | `StudyMate_발표자료.pptx` · `.pdf` (기존 최종발표 12장 + 새 슬라이드 5장 = 17장) |
| 시연 시나리오 | `StudyMate_시연시나리오.md` |
| 기존 최종발표 원본 | `StudyMate_최종발표.pptx` (수정 없음, 발표자료의 바탕) |

## 주의: 기존 문서와 코드의 불일치
11/24 기획서·결과보고서의 원래 내용은 유지하고 11/26 인수인계에서 불일치와 검증 결과를 보완했습니다. 새 문서는 현재 코드를 기준으로 썼습니다. 다른 점은 `StudyMate_요구사항분석서.md` 12장에 정리했습니다(예: 결과보고서에 카카오톡 스킬 서버 누락, 응답 시간 2.6초/2.5초 표기 차이(원자료 2.55초로 정정), 임계값 기본값 0.2/0.3 두 곳, 스키마에 FK·CHECK 없음). 수치는 `evidence/`의 원자료와 `npm test`·`node tools/eval.mjs` 재실행(2026-11-26)으로 확인했습니다. 평가 질문·자료는 개발자가 직접 작성했습니다.

## 다시 만들기
프로젝트 폴더(`projects/StudyMate`)에서 실행합니다.
```powershell
python tools/docs/make_diagrams.py     # 순서도 4종·ERD PNG → docs/images
# md → docx (문서마다 한 번씩)
python tools/docs/md2docx.py docs/StudyMate_요구사항분석서.md docs/StudyMate_요구사항분석서.docx
# docx → pdf (Word 필요)
powershell -NoProfile -ExecutionPolicy Bypass -File tools/docs/docx2pdf.ps1 docs/StudyMate_요구사항분석서.docx
python tools/docs/build_deck.py        # 발표자료 보강 (docs/StudyMate_최종발표.pptx → docs/StudyMate_발표자료.pptx)
# pptx → pdf (PowerPoint 필요, 두 번째 인자는 슬라이드 PNG 미리보기 폴더)
powershell -NoProfile -ExecutionPolicy Bypass -File tools/docs/pptx2pdf.ps1 docs/StudyMate_발표자료.pptx
```
평가·테스트 재측정: `npm test`, `node tools/eval.mjs`(LLM 없이 수 초), `node tools/eval.mjs --llm --out evidence/eval-llm.json`(Ollama 또는 API 키 필요).
