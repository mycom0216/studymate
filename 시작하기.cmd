@echo off
rem UTF-8 콘솔로 전환해 한글 안내가 깨지지 않도록 합니다.
chcp 65001 >nul
rem 현재 작업 위치를 이 배치 파일이 있는 프로젝트 폴더로 이동합니다.
cd /d "%~dp0"
rem Node.js 실행 파일이 PATH에 있는지 확인하고 없으면 안내 후 종료합니다.
where node >nul 2>nul || (echo Node.js 24 이상이 필요합니다. https://nodejs.org 에서 설치하세요. & pause & exit /b 1)
rem 환경 설정 파일은 선택 사항이며 API 키가 없을 때도 기본 기능은 동작합니다.
if not exist .env if exist .env.example echo [안내] .env 파일이 없습니다. Claude/ChatGPT 키가 없으면 로컬 Ollama 또는 추출형 답변으로 동작합니다.
echo StudyMate를 시작합니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.
rem 로컬 데모 주소를 기본 브라우저로 열고 서버 프로세스는 현재 콘솔에서 실행합니다.
start "" http://127.0.0.1:5300
node server.mjs
rem 서버 종료 뒤 콘솔을 유지해 오류나 종료 안내를 확인할 수 있게 합니다.
pause
