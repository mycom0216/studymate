# 공개 시연용 SQLite 데이터베이스

`studymate.db`는 프로젝트의 `tools/seed-demo.mjs`로 새로 생성한 가상 학습 데이터입니다. 사용자 개인 데이터나 API 키를 포함하지 않습니다. SQLite `PRAGMA integrity_check` 결과 `ok`를 확인했습니다.

| 테이블 | 행 수 |
|---|---:|
| learners | 2 |
| qa_log | 9 |
| quiz_items | 72 |
| attempts | 72 |
| mastery | 55 |

시연: Node.js 24 이상에서 저장소 루트의 `data/studymate.db`가 **없을 때만** 이 파일을 `data/studymate.db`로 복사한 뒤 `npm start`를 실행하고 `http://127.0.0.1:5300/?learner=demo-learner-01`로 접속합니다. 기존 개인 학습 데이터는 덮어쓰지 마세요.

PowerShell:

```powershell
if (!(Test-Path data/studymate.db)) { Copy-Item data/demo/studymate.db data/studymate.db }
npm start
```

실제 사용 중 생성되는 DB, WAL/SHM, `.env`, 개인 자료는 Git에 등록하지 않습니다. 이 샘플은 가상 데이터 전용입니다.
