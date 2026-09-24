# NEXIVO HUB Render 배포 가이드

## 1. GitHub
`NEXIVO HUB-CONTROL-CENTER-shared-bot-production.zip`을 풀어 새 GitHub 저장소에 올립니다. `.env`와 실제 Discord 토큰은 올리지 않습니다.

## 2. Render
Blueprint로 `render.yaml`을 사용하거나 Web Service + Background Worker를 각각 생성합니다.

### Web Service 환경변수
- `NEXIVO_OPERATOR_USER` = `0nTop`
- `NEXIVO_OPERATOR_PASSWORD` = 원하는 오너 비밀번호 (Secret)
- `NEXIVO_OWNER_LICENSE_KEY` = 오너 전용 `VEX-PRP-XXXXXX-XXXXXX-XXXXXX` 키 (Secret)
- `NEXIVO_OWNER_DISCORD_ID` = 오너 본인 Discord User ID (Secret)
- `NEXIVO_BOT_WORKER_SECRET` = 긴 랜덤 문자열 (Web/Worker 동일)
- `NEXIVO_LICENSE_ISSUE_SECRET` = 긴 랜덤 문자열
- `NEXIVO_DB_FILE` = `/var/data/db.json`
- `COOKIE_SECURE` = `true`

### Discord Bot Worker 환경변수
- `DISCORD_TOKEN` = 선택 사항. 웹 설정에 Token을 저장해 사용할 경우 비워둬도 됩니다.
- `WEBSITE_URL` = 실제 NEXIVO HUB Web Service URL
- `NEXIVO_BOT_WORKER_SECRET` = Web Service와 **완전히 같은 값**

## 3. 동작 구조
한 개의 Discord 봇이 여러 고객 서버에 들어갈 수 있습니다. 웹에서 고객 라이선스와 Guild ID가 연결되면 worker가 해당 서버를 tenant로 인식하고, 그 서버에 해당하는 상품/재고/주문만 동기화합니다.

웹 상품/재고 변경 → SSE 이벤트 → shared bot worker → 해당 Guild 재고 메시지 갱신

Discord 주문/상태 변경 → worker-state API → 웹 대시보드/매출 리포트 갱신

## 4. 공용 Bot Token 설정 및 보안
오너 로그인 → `설정` → `공용 Discord 봇 설정`에서 Bot Token을 입력하고 저장할 수 있습니다. 입력창은 password 타입이며 눈 아이콘으로 입력 중 표시/숨김이 가능합니다. 저장된 원문 Token은 브라우저로 다시 보내지 않으며 서버에서 AES-256-GCM으로 암호화합니다. 봇 Worker는 `NEXIVO_BOT_WORKER_SECRET`로 인증한 뒤 서버에서 Token을 받아 시작합니다. Token 자체는 구매자에게 노출하지 않습니다.

## 5. 데이터 영속성
`render.yaml`은 Web Service에 Persistent Disk(`/var/data`)를 연결합니다. 더 큰 규모에서는 Postgres로 옮기는 것을 권장합니다.


### Bot license activation
1. Customer activates a license on the web site.
2. Customer invites the shared NEXIVO HUB Discord bot to their server.
3. Customer runs `/라이센스` and enters the same license key.
4. The bot validates the key through the web service and binds the current Guild ID only when the Discord User ID matches the ID stored on the license.
5. Before activation, other application commands are blocked with an ephemeral license reminder.

The owner login does not require typing the internal OWNER PRO PREMIUM key. The owner account is validated server-side.


## Discord 웹 인증(선택)
1. Discord Developer Portal에서 같은 앱의 OAuth2 Client Secret을 확인합니다.
2. Render Web Service에 아래 값을 설정합니다.
   - `NEXIVO_DISCORD_CLIENT_ID` = Application ID
   - `NEXIVO_DISCORD_CLIENT_SECRET` = Client Secret
   - `NEXIVO_DISCORD_REDIRECT_URI` = `https://YOUR_DOMAIN/verify/callback`
   - `NEXIVO_IP_LOG_RETENTION_DAYS` = `30`
3. Discord OAuth2 Redirect URI에도 동일한 `https://YOUR_DOMAIN/verify/callback`을 등록합니다.
4. `/인증패널`에서 생성된 `🌐 웹에서 인증하기` 버튼을 사용하면 브라우저 인증 요청 IP, User-Agent, Discord User ID, 시간, Guild ID가 방어용 보안 로그로 저장됩니다. Discord 봇 자체는 사용자의 실제 IP를 볼 수 없습니다.

## 라이선스 보호
- 봇이 초대되어도 활성 라이선스가 연결되지 않은 서버에서는 `/라이센스` 외 명령이 차단됩니다.
- `/라이센스`에 웹에서 활성화된 키를 입력하고, 발급된 Discord User ID가 일치해야 서버가 연결됩니다.
- `/서버생성`, `/서버삭제`, `/보안로그`, `/충전승인`, `/잔액지급`은 오너 Discord ID에 바인딩된 OWNER 라이선스에서만 사용할 수 있습니다.
