# NEXIVO HUB

## NEXIVO Store / Wallet-only Checkout

- 웹사이트 상점은 **지갑 잔액 결제만** 지원합니다. 카드/암호화폐 결제 UI는 제거되어 있습니다.
- 지갑 충전은 Discord 자판기의 `충전` 버튼에서 신청 → 판매자 계좌이체 → OWNER 승인 방식입니다.
- 구매 완료 시 `PLATFORM_LICENSE` 상품은 라이선스를 자동 발급하고 구매자의 Discord ID/서버에 자동 연결합니다. 사용자는 별도의 `/라이센스` 입력이나 워커 연결을 할 필요가 없습니다.
- 웹사이트 구매완료 화면에서 리뷰를 작성하면 `review.created` 이벤트가 중앙 봇으로 전달되어 Discord의 `「⭐」구매후기` 또는 `구매후기` 채널에 자동 게시됩니다.
- 체크아웃에는 서비스 약관, 개인정보 처리방침, 환불/취소 정책 링크가 포함되어 있으며 판매자 정보는 실제 운영 정책에 맞게 최종 입력해야 합니다.
- Discord 자판기 UI는 `공지 / 제품 / 충전 / 정보 / 구매 / ⭐ 구매후기 / 새로고침` 흐름과 카테고리 → 상품 드롭다운을 사용합니다.
- 웹용 브랜드 이미지는 `web/public/assets/nexivo-vending-banner.png`, 봇 프로필용 이미지는 `bot/assets/nexivo-profile.png`입니다.
