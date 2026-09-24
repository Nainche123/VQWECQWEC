NEXIVO HUB wallet flow

1. Discord vending bot -> 충전
2. User enters amount
3. Bot creates a topup request in the web DB and shows the seller bank account
4. User transfers the exact amount
5. OWNER approves the request
6. Web wallet is credited
7. Website Store uses wallet balance only; there is no website card/crypto checkout in the current UI
8. PLATFORM_LICENSE products automatically issue a license and bind it to the buyer's Discord ID. First use in a Discord guild automatically binds the active license to that guild; no customer worker connection or /라이센스 command is required.
9. Website review submission emits review.created; the shared bot publishes it to the configured 「⭐」구매후기 / 구매후기 channel.
