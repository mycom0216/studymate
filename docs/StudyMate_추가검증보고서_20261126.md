# StudyMate — 2026-11-26 추가 검증 기록

기존 문서와 발표자료는 원본 작성 시점의 기록으로 보존한다. 아래는 후속 GitHub 검증 결과이며, 기존 문서의 과거 수치와 혼동하지 않는다.

- 자동 단위 테스트 30/30 통과. Ollama qwen2.5:3b 일반 평가: 정답 근거 인용 58/60(96.7%), 범위 밖 거절 20/20(100%).
- 일반 평가 실행: https://github.com/mycom0216/studymate/actions/runs/45741354068
- Hybrid RAG(qwen2.5:3b + embeddinggemma) 보고: 일반 Hit@1/4 60/60, 어려운 Hit@1 10/12, Hit@4 12/12, 정답 근거 인용 57/60(95%), 범위 밖 거절 20/20.
- 응답 유형: AI 생성 52건, 원문 대체 5건, 거절 3건(범위 내 60건). 응답 시간 중앙값 18.854초, P90 22.640초.
- Hybrid 실행은 평가 및 결과 업로드 후 검증 명령의 셸 따옴표 오류로 실패 종료했다. 이후 검증기를 수정하고 평가 요약을 보존했다. 전체 모델 재실행은 하지 않았다.
- 근거: https://github.com/mycom0216/studymate/actions/runs/45742897022
- 최종 검증: https://github.com/mycom0216/studymate/actions/runs/45745692710
- 공개 데모 SQLite DB: data/demo/studymate.db. 질의 임베딩 캐시 추가. 측정된 가속 효과 및 모든 질의의 실제 임베딩 사용 여부는 확정하지 못했다. GPU 가속 미적용.
- 개발용 가상 자료에 대한 평가이며 실제 학습 성과를 입증하지 않는다.
