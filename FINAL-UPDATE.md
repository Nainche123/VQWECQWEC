# NEXIVO HUB — 통합 웹사이트 최신본

이 ZIP은 현재 운영 중인 NEXIVO HUB Control Center의 전체 교체용 프로젝트입니다.

## 이번 최신본에서 정리된 것
- NEXIVO HUB 전체 브랜딩 유지
- OWNER 로그인은 라이선스 키를 입력하지 않고 내부 OWNER PRO 라이선스로 검증
- OWNER UI는 `OWNER PRO`로 표시
- 일반 구매자는 본인 플랜으로 표시
- 오너 전용 라이선스 발급 메뉴/권한 유지
- Bot Token은 오너 전용 설정에서 마스킹 + 서버 암호화 저장
- 구매자 브라우저에는 Bot Token 미노출
- 입금 안내(`bankInfo`)는 로그인 계정별/연결 서버별로 분리
- 상품/재고/주문/봇 연동/매출 리포트 등 기존 패널 유지
- 웹↔Discord 실시간 이벤트 스트림 유지
- Render Web Service + Discord Worker 구조 유지

## 배포
현재 Render 프로젝트에서 웹 서비스의 Git 저장소 내용을 이 프로젝트로 교체하고 재배포하세요.
실제 `.env`는 커밋하지 말고 Render Environment에 넣으세요.
