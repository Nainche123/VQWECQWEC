# NEXIVO HUB Control Center

NEXIVO HUB is a license-gated store/control panel for Discord vending bots.

## Architecture

- **Web Service (Node.js):** dashboard, products, stock, orders, reports, licensing.
- **Shared Discord Bot Worker (Python):** one Discord bot token for all customer servers.
- **Per-tenant isolation:** each active license is bound to a customer and Discord Guild ID. The shared bot receives only that tenant's products/orders/settings when operating inside the guild.
- **Plan gating:** BASIC / BASIC PREMIUM / PRO / PRO PREMIUM are enforced server-side. The browser cannot unlock a feature by changing its UI.
- **Realtime:** web changes emit events over SSE; the shared worker consumes them and updates the matching Discord server. Worker order/state updates flow back to the web service.

## Security

The shared Discord bot token can be entered by the OWNER in the Settings page. It is never returned to normal browser clients; the web service stores it encrypted (AES-256-GCM), and only the authenticated Discord Bot Worker may request the plaintext token. You may alternatively set `DISCORD_TOKEN` directly on the Worker.

The OWNER account is also gated by a real `PRO_PREMIUM` license. Configure `NEXIVO_OWNER_LICENSE_KEY` and `NEXIVO_OWNER_DISCORD_ID`; the OWNER cannot log in when the protected license is suspended/revoked.

Do not commit a real `.env`, a real Discord token, or your production secrets to GitHub.

## Local

1. Copy `.env.example` to `.env` and set the owner password + shared secrets.
2. `npm install` (the web app has no external runtime dependency, but this keeps the workflow consistent).
3. `npm start`.
4. Configure the bot worker from `BOT-INTEGRATION/NEXIVO_HUB_bot.env.example`.

## Render

Use `render.yaml` to create one Web Service and one Background Worker. The web service uses a Persistent Disk at `/var/data` so the JSON database survives normal restarts/redeploys. For larger production traffic, move to a managed database such as Postgres.


고객별 공용 봇 연결
--------------------
오너가 고객의 Discord User ID를 포함한 라이선스를 발급하고, 고객은 공용 봇을 자신의 서버에 초대한 뒤 Guild ID를 패널에 등록합니다. 하나의 Discord 봇 토큰으로 여러 서버를 운영하지만, 웹/봇 데이터는 라이선스와 Guild ID 기준으로 분리됩니다.

오너는 설정 화면에서 공용 Bot Token을 입력할 수 있습니다. 토큰은 password 입력창으로 마스킹되고 저장 후 원문을 다시 브라우저에 반환하지 않습니다. Worker는 `NEXIVO_BOT_WORKER_SECRET`로 인증한 뒤 서버에서 토큰을 받아 실행할 수 있습니다.

플랜별 권한
------------
BASIC / BASIC PREMIUM / PRO / PRO PREMIUM은 같은 봇을 사용하되, 각 라이선스의 features를 서버에서 확인하여 관리 기능 실행을 제한합니다. 현재 `tenant_is_admin()`은 고객 라이선스의 Discord User ID를 우선하며, 서버 소유권만으로 우회할 수 없습니다.


## 공용 Discord Bot Token 저장
오너는 설정 화면에서 Bot Token을 입력하고 저장할 수 있습니다. 입력란은 password 타입이며 눈 아이콘으로 입력 중 표시/숨김이 가능합니다. 저장 후 원문 토큰은 API/브라우저에 다시 반환하지 않고 서버에서 AES-256-GCM으로 암호화합니다. Worker는 `NEXIVO_BOT_WORKER_SECRET`로 인증한 뒤 `/api/bot/secret-token`에서 토큰을 받아 시작할 수 있습니다. 웹 서비스의 DB 저장 경로가 영속 저장소에 있어야 재시작 이후에도 유지됩니다.


## Discord 라이선스 게이트
웹사이트에서 라이선스를 활성화한 뒤 구매자는 자신의 Discord 서버에 공용 NEXIVO HUB 봇을 초대하고 `/라이센스` 명령어로 키를 입력합니다. 서버에 등록된 Discord User ID와 라이선스의 Discord User ID가 일치할 때만 해당 서버가 활성 테넌트로 연결됩니다. 연결 전 다른 봇 명령어를 실행하면 다음과 같은 안내가 사용자에게만 표시됩니다: `⚠️ 라이선스 키를 입력 후 사용하실 수 있습니다! 먼저 /라이센스 를 사용해주세요.`

오너 계정 `0nTop`은 로그인 시 키를 입력할 필요가 없으며 서버에 보관되는 OWNER PRO PREMIUM 라이선스로 내부 검증합니다. 오너 Discord 계정은 `NEXIVO_OWNER_DISCORD_ID`로 바인딩할 수 있습니다.


## NEXIVO HUB 운영 명령어
- `/라이센스` : 웹에서 활성화한 라이선스를 현재 Discord 서버에 연결
- `/서버삭제 confirm:삭제` : 오너 전용. 현재 채널 하나를 남기고 나머지 채널 삭제
- `/서버생성` : 오너 전용. NEXIVO HUB 서버 템플릿 재생성
- `/보안로그` : 오너 전용. 웹 인증에서 기록된 보안 감사 로그 확인
- `/충전 금액` / `/잔액` : 구매자 잔액 충전 요청 및 잔액 확인
- `/충전대기` / `/충전승인` / `/잔액지급` : 오너 전용 잔액 운영

### 웹 인증 보안 로그
Discord 봇은 사용자의 실제 IP 주소를 제공받지 않습니다. 따라서 `/verify` 웹 인증은 브라우저의 웹 요청 IP, User-Agent, Discord User ID, 시간, 연결 Guild ID를 방어 목적의 감사 기록으로 저장합니다. IP 기록은 기본 30일 후 자동 정리됩니다. 이 기능은 신고·차단·계정/서버 보안 대응을 위한 용도로 사용하세요.

## 결제 계좌 정보
입금 계좌 정보는 전역 `.env` 값이 아닙니다. 각 판매자 계정이 웹사이트의 **설정 → 입금 안내**에 입력한 값이 해당 계정에 연결된 Discord 서버의 주문 티켓에만 표시됩니다.
다른 판매자의 서버에는 공유되지 않습니다. 계좌를 설정하지 않은 서버에서는 결제 계좌를 표시하지 않습니다.


## Wallet / Discord 계좌이체 충전
- 상점은 계정 로그인 후 지갑 잔액으로 즉시 구매합니다.
- 구매 완료와 동시에 플랫폼 라이선스 또는 상품 키가 자동 지급됩니다.
- Discord 구매도 같은 웹 지갑을 사용합니다.
- 기본 운영 흐름은 Discord 자판기에서 계좌이체 충전 신청 → OWNER 승인 → 웹사이트/Discord 지갑 반영입니다.
- 과거 PortOne 자동충전 코드는 레거시로 남아 있지만 현재 상점 UI와 구매 API에서는 사용하지 않습니다.
- 고객은 워커 시크릿이나 별도 워커 연결을 입력하지 않습니다. 공용 봇은 운영자가 한 번 구성하고, 라이선스 구매/Discord 사용자 확인으로 서버가 자동 바인딩됩니다.
