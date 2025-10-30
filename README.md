# 배포 가이드 (Render + Vercel)

## 개요
- 프론트: `dashboard/` 디렉터리 → Vercel에 배포
- 백엔드: `server/yt.js` → Render Web Service로 배포(퍼시스턴트 디스크 사용)

## 1) Render에 서버 배포
1. 이 리포지토리를 GitHub에 푸시
2. Render 대시보드 → New + → Blueprint → GitHub 리포지토리 선택
3. `render.yaml` 자동 감지됨 → 배포 시작
4. 환경변수 설정(필수 및 권장)
   - `YT_API_KEY` (필수)
   - `OPENAI_API_KEY` 또는 `GEMINI_API_KEY` (선택)
   - `LLM_PROVIDER` = `openai` | `gemini` (선택)
   - `CORS_ORIGIN` = `https://your-app.vercel.app` (Vercel 도메인, 여러 개면 쉼표 구분)
   - `DATA_DIR`는 기본 `/opt/render/project/src/data` (render.yaml에 이미 지정)
5. 첫 배포 완료 후 Render가 부여한 도메인 확인(예: `https://your-api.onrender.com`)

참고: 디스크는 `render.yaml`에서 `/opt/render/project/src/data`로 마운트됩니다.

## 2) Vercel에 프론트 배포
1. Vercel에서 New Project → GitHub 리포지토리 선택
2. 루트 디렉터리: `dashboard/`
3. Build Command: `npm run build`
4. Output Directory: `dist`
5. 환경변수 추가
   - `VITE_API_BASE` = Render 서버 URL (예: `https://your-api.onrender.com`)
   - 선택 `VITE_HTTP_TIMEOUT` (기본 90000ms)
6. 배포 후 도메인 확인(예: `https://your-app.vercel.app`)
7. Render 측 `CORS_ORIGIN`에 해당 도메인을 등록(여러 개면 쉼표 구분)

## 3) 로컬 개발
- 터미널 A: 루트에서 `npm run dev` (백엔드)
- 터미널 B: `cd dashboard && npm run dev` (프론트)
- 프론트는 dev 프록시(`/api -> http://localhost:8820`)로 서버에 접근합니다.

## 4) 환경변수 요약
- 서버
  - `YT_API_KEY` (필수)
  - `OPENAI_API_KEY` / `GEMINI_API_KEY` (선택)
  - `LLM_PROVIDER` (선택)
  - `CORS_ORIGIN` (배포 도메인, 쉼표로 여러 개)
  - `DATA_DIR` (Render 디스크 경로, 기본값 존재)
- 프론트
  - `VITE_API_BASE` (배포용 서버 URL)
  - `VITE_HTTP_TIMEOUT` (선택)

## 5) 문제 해결
- CORS 에러: Render의 `CORS_ORIGIN`에 Vercel 도메인 추가 또는 쉼표로 여러 개 등록
- 데이터가 사라짐: Render 서비스에 디스크가 마운트됐는지 확인(`render.yaml` 사용 권장)
- 429/Timeout: YouTube/LLM 쿼터 초과. 대기 후 재시도 또는 days/검색량 제한 조정
