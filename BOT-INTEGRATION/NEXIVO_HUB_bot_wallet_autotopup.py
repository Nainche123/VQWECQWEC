import asyncio
import json
import os
import secrets
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

BRAND = "NEXIVO HUB"
BOT_NAME = os.getenv("NEXIVO_BOT_DISPLAY_NAME", "NEXIVO HUB Bot").strip() or "NEXIVO HUB Bot"
TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
WEBSITE_URL = os.getenv("WEBSITE_URL", "").rstrip("/")
WORKER_SECRET = os.getenv("NEXIVO_BOT_WORKER_SECRET", "").strip()
OWNER_ID = int(os.getenv("NEXIVO_OWNER_DISCORD_ID", os.getenv("OWNER_ID", "0")) or 0)
BANK_INFO = os.getenv("BANK_INFO", "입금 계좌는 관리자에게 안내받아 주세요.").strip()
ADMIN_NAME = os.getenv("ADMIN_NAME", "NEXIVO HUB 운영팀").strip()
INVITE_URL = os.getenv("NEXIVO_BOT_INVITE_URL", "").strip()
BANNER_URL = os.getenv("NEXIVO_VENDING_BANNER_URL", f"{WEBSITE_URL}/assets/nexivo-banner.png").strip()
BASE_DIR = Path(__file__).resolve().parent
VENDING_BANNER_NAME = "nexivo-vending-banner.png"
VENDING_BANNER_FILE = BASE_DIR / "assets" / VENDING_BANNER_NAME
DATA_FILE = Path(os.getenv("BOT_DATA_FILE", "nexivo_bot_data.json"))
KST = timezone(timedelta(hours=9))

DEFAULT_DATA = {
    "balances": {},
    "topup_requests": {},
    "local_orders": {},
    "server_panels": {},
}


def now_iso() -> str:
    return datetime.now(KST).isoformat()


def money(value: int | float) -> str:
    return f"{int(value):,}원"


def make_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5).upper()}"


def load_local_data() -> dict[str, Any]:
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(DEFAULT_DATA, ensure_ascii=False, indent=2), encoding="utf-8")
        return json.loads(json.dumps(DEFAULT_DATA))
    try:
        raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    data = json.loads(json.dumps(DEFAULT_DATA))
    if isinstance(raw, dict):
        for key in DEFAULT_DATA:
            if key in raw:
                data[key] = raw[key]
    return data


LOCAL = load_local_data()
LOCAL_LOCK = asyncio.Lock()


async def save_local() -> None:
    async with LOCAL_LOCK:
        tmp = DATA_FILE.with_suffix(DATA_FILE.suffix + ".tmp")
        tmp.write_text(json.dumps(LOCAL, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(DATA_FILE)


class NEXIVOClient:
    def __init__(self) -> None:
        self.session: aiohttp.ClientSession | None = None
        self.tenants: dict[str, dict[str, Any]] = {}
        self.last_refresh: datetime | None = None
        self.refresh_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15, connect=5, sock_connect=5, sock_read=10),
                headers={"User-Agent": "NEXIVO-HUB-DiscordBot/3.0", "Accept": "application/json"},
            )

    async def close(self) -> None:
        if self.session and not self.session.closed:
            await self.session.close()

    def url(self, path: str) -> str:
        return f"{WEBSITE_URL}{path}"

    def headers(self, *, license_key: str | None = None, bot_secret: str | None = None) -> dict[str, str]:
        h = {"X-NEXIVO-Worker-Secret": WORKER_SECRET}
        if license_key:
            h["X-NEXIVO-License"] = license_key
        if bot_secret:
            h["X-NEXIVO-Bot-Secret"] = bot_secret
        return h

    async def request(self, method: str, path: str, *, headers: dict[str, str] | None = None, body: dict[str, Any] | None = None) -> tuple[int, Any]:
        if not WEBSITE_URL:
            return 503, {"error": "WEBSITE_URL이 설정되지 않았습니다."}
        await self.start()
        assert self.session is not None
        final_headers = dict(headers or {})
        try:
            async with self.session.request(method, self.url(path), headers=final_headers, json=body) as resp:
                text = await resp.text()
                try:
                    payload = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    payload = {"error": text[:500]}
                return resp.status, payload
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return 503, {"error": f"NEXIVO HUB 연결 실패: {exc}"}

    async def health(self) -> tuple[int, Any]:
        return await self.request("GET", "/api/health")

    async def refresh_tenants(self, force: bool = False) -> dict[str, dict[str, Any]]:
        async with self.refresh_lock:
            if not force and self.last_refresh:
                age = (datetime.now(timezone.utc) - self.last_refresh.astimezone(timezone.utc)).total_seconds()
                if age < 8:
                    return self.tenants
            status, payload = await self.request("GET", "/api/bot/tenants", headers=self.headers())
            if status != 200:
                return self.tenants
            new: dict[str, dict[str, Any]] = {}
            for tenant in payload.get("tenants", []) if isinstance(payload, dict) else []:
                gid = str(tenant.get("guildId") or "")
                if gid:
                    new[gid] = tenant
            self.tenants = new
            self.last_refresh = datetime.now(KST)
            return self.tenants

    async def activate_license(self, key: str, guild_id: int, discord_user_id: int, bot_user_id: int | None, bot_username: str | None) -> tuple[int, Any]:
        body = {
            "licenseKey": key.strip().upper(),
            "guildId": str(guild_id),
            "discordUserId": str(discord_user_id),
            "botUserId": str(bot_user_id) if bot_user_id else None,
            "botUsername": bot_username,
        }
        # Return the activation result immediately. Do not make Discord wait for
        # a second /api/bot/tenants request after a successful activation.
        status, payload = await self.request("POST", "/api/bot/license/activate", headers=self.headers(), body=body)
        if status == 200:
            asyncio.create_task(self.refresh_tenants(True))
        return status, payload

    async def products(self, tenant: dict[str, Any]) -> list[dict[str, Any]]:
        return list(tenant.get("products") or [])

    async def orders(self, tenant: dict[str, Any]) -> list[dict[str, Any]]:
        return list(tenant.get("orders") or [])

    async def adjust_stock(self, guild_id: int, product_id: str, delta: int) -> tuple[int, Any]:
        return await self.request(
            "POST",
            "/api/bot/stock-adjust",
            headers=self.headers(),
            body={"guildId": str(guild_id), "productId": product_id, "delta": int(delta)},
        )

    async def purchase_product(self, guild_id: int, product_id: str, discord_user_id: int, discord_username: str) -> tuple[int, Any]:
        return await self.request(
            "POST",
            "/api/bot/shop/purchase",
            headers=self.headers(),
            body={
                "guildId": str(guild_id),
                "productId": str(product_id),
                "discordUserId": str(discord_user_id),
                "discordUsername": str(discord_username),
            },
        )

    async def push_worker_state(self, guild_id: int, orders: list[dict[str, Any]], settings: dict[str, Any]) -> tuple[int, Any]:
        return await self.request(
            "POST",
            "/api/bot/worker-state",
            headers=self.headers(),
            body={
                "guildId": str(guild_id),
                "orders": orders,
                "settings": settings,
                "botUserId": str(bot.user.id) if bot.user else None,
                "botUsername": str(bot.user) if bot.user else BOT_NAME,
            },
        )

    async def security_logs(self, guild_id: int | None = None) -> tuple[int, Any]:
        q = f"?guildId={guild_id}" if guild_id else ""
        return await self.request("GET", f"/api/bot/security-logs{q}", headers=self.headers())

    async def bot_config(self) -> tuple[int, Any]:
        return await self.request("GET", "/api/bot/tenants", headers=self.headers())

    async def resolve_tenant(self, guild_id: int, discord_user_id: int, discord_username: str) -> tuple[int, Any]:
        return await self.request(
            "POST", "/api/bot/resolve-tenant", headers=self.headers(),
            body={"guildId": str(guild_id), "discordUserId": str(discord_user_id), "discordUsername": str(discord_username)},
        )

    async def wallet(self, discord_user_id: int) -> tuple[int, Any]:
        return await self.request("GET", f"/api/bot/wallet?discordUserId={discord_user_id}", headers=self.headers())

    async def topup_request(self, discord_user_id: int, discord_username: str, guild_id: int, amount: int) -> tuple[int, Any]:
        return await self.request("POST", "/api/bot/wallet/topup-request", headers=self.headers(), body={"discordUserId": str(discord_user_id), "discordUsername": discord_username, "guildId": str(guild_id), "amount": int(amount)})

    async def topup_pending(self) -> tuple[int, Any]:
        return await self.request("GET", "/api/bot/wallet/topups/pending", headers=self.headers())

    async def approve_topup(self, request_id: str, approved_by: str) -> tuple[int, Any]:
        return await self.request("POST", f"/api/bot/wallet/topups/{request_id}/approve", headers=self.headers(), body={"approvedBy": approved_by})

    async def reject_topup(self, request_id: str, approved_by: str) -> tuple[int, Any]:
        return await self.request("POST", f"/api/bot/wallet/topups/{request_id}/reject", headers=self.headers(), body={"approvedBy": approved_by})

    async def submit_review(self, order_id: str, discord_user_id: int, discord_username: str, rating: int, content: str) -> tuple[int, Any]:
        return await self.request("POST", "/api/bot/reviews", headers=self.headers(), body={"orderId": order_id, "discordUserId": str(discord_user_id), "discordUsername": discord_username, "rating": int(rating), "content": content})


api = NEXIVOClient()


intents = discord.Intents.default()
intents.guilds = True
intents.members = True
intents.messages = True
intents.message_content = False

bot = commands.Bot(command_prefix="!", intents=intents)


# ----------------------------
# Shared helpers / gating
# ----------------------------

def is_owner(user: discord.abc.User | None) -> bool:
    return bool(user and OWNER_ID and user.id == OWNER_ID)


def tenant_for_guild(guild_id: int) -> dict[str, Any] | None:
    return api.tenants.get(str(guild_id))


def plan_features(tenant: dict[str, Any] | None) -> set[str]:
    if not tenant:
        return set()
    return {str(x) for x in tenant.get("features") or []}


def plan_label(tenant: dict[str, Any] | None) -> str:
    if not tenant:
        return "미인증"
    return str(tenant.get("planLabel") or tenant.get("plan") or "Unknown")


def plan_family(tenant: dict[str, Any] | None) -> str:
    return str(tenant.get("botFamily") or "") if tenant else ""


async def gate(interaction: discord.Interaction, feature: str | None = None, *, owner_only: bool = False) -> dict[str, Any] | None:
    if not interaction.guild:
        await interaction.response.send_message("❌ Discord 서버에서만 사용할 수 있습니다.", ephemeral=True)
        return None
    if owner_only and not is_owner(interaction.user):
        await interaction.response.send_message("🔒 **OWNER PRO 전용 기능입니다.**", ephemeral=True)
        return None
    if is_owner(interaction.user):
        await api.refresh_tenants()
        tenant = tenant_for_guild(interaction.guild.id)
        if tenant:
            return tenant
        status, payload = await api.resolve_tenant(interaction.guild.id, interaction.user.id, str(interaction.user))
        if status == 200:
            tenant = payload.get("tenant") or {}
            api.tenants[str(interaction.guild.id)] = tenant
            return tenant
        if feature in {"products", "orders", "reports", "notice", "grades", "customers", "audit"}:
            await interaction.response.send_message("⚠️ 이 서버에 OWNER PRO 라이선스가 자동 연결되지 않았습니다. 상점에서 라이선스를 확인해주세요.", ephemeral=True)
            return None
        return {"role": "OWNER", "plan": "PRO_PREMIUM", "planLabel": "OWNER PRO", "features": [feature] if feature else []}
    await api.refresh_tenants()
    tenant = tenant_for_guild(interaction.guild.id)
    if not tenant:
        status, payload = await api.resolve_tenant(interaction.guild.id, interaction.user.id, str(interaction.user))
        if status == 200:
            tenant = payload.get("tenant") or {}
            api.tenants[str(interaction.guild.id)] = tenant
    if not tenant:
        await interaction.response.send_message("⚠️ 이 Discord 계정에는 활성 NEXIVO HUB 라이선스가 없습니다. 웹사이트 상점에서 라이선스를 구매하면 이 서버에서 자동으로 연결됩니다.", ephemeral=True)
        return None
    user_id = str(tenant.get("discordUserId") or "")
    if user_id and user_id != str(interaction.user.id) and feature in {"settings", "orders"}:
        await interaction.response.send_message("🔒 이 라이선스의 연결 사용자만 사용할 수 있는 기능입니다.", ephemeral=True)
        return None
    if feature and feature not in plan_features(tenant):
        await interaction.response.send_message(f"❌ 현재 **{plan_label(tenant)}** 라이선스에서는 사용할 수 없는 기능입니다.", ephemeral=True)
        return None
    return tenant

def embed_base(title: str, description: str = "", color: discord.Colour = discord.Colour.from_rgb(59, 130, 246)) -> discord.Embed:
    e = discord.Embed(title=title, description=description, color=color, timestamp=datetime.now(KST))
    if bot.user:
        e.set_author(name=f"{BRAND} • {BOT_NAME}", icon_url=bot.user.display_avatar.url)
    e.set_footer(text=f"{BRAND} • Secure Commerce")
    return e


async def web_balance(user_id: int) -> int:
    status, payload = await api.wallet(user_id)
    if status == 200:
        return max(0, int(((payload.get("wallet") or {}).get("balance")) or 0))
    return 0


def local_balance(guild_id: int, user_id: int) -> int:
    # Legacy fallback only; website wallet is the source of truth.
    return max(0, int(LOCAL.setdefault("balances", {}).setdefault(str(guild_id), {}).get(str(user_id), 0) or 0))


def set_balance(guild_id: int, user_id: int, amount: int) -> None:
    # Legacy cache. Purchases no longer mutate this cache.
    LOCAL.setdefault("balances", {}).setdefault(str(guild_id), {})[str(user_id)] = max(0, int(amount))


def find_product(tenant: dict[str, Any], token: str) -> dict[str, Any] | None:
    products = tenant.get("products") or []
    token_low = token.strip().lower()
    for p in products:
        if str(p.get("id")) == token or str(p.get("name", "")).lower() == token_low:
            return p
    return None


def tenant_bank_info(tenant: dict[str, Any] | None) -> str:
    """Return the bank/payment message for this specific tenant/server."""
    if not tenant:
        return BANK_INFO
    settings = tenant.get("settings") or {}
    return str(settings.get("bankInfo") or BANK_INFO).strip() or BANK_INFO


def product_list_text(products: list[dict[str, Any]], limit: int = 20) -> str:
    lines = []
    for idx, p in enumerate(products[:limit], 1):
        stock = p.get("stock", -1)
        stock_text = "∞ 무제한" if stock == -1 else f"재고 {int(stock):,}개"
        lines.append(
            f"`{idx:02d}` **{str(p.get('name','상품'))[:70]}**\n"
            f"　└ 💳 **{money(p.get('price',0))}** · 📦 {stock_text}"
        )
    return "\n\n".join(lines) or "현재 판매 상품이 없습니다."


# ----------------------------
# /라이센스
# ----------------------------
@bot.tree.command(name="라이센스", description="웹사이트에서 발급받은 라이선스를 이 Discord 서버에 연결합니다.")
@app_commands.describe(license_key="웹사이트에서 발급/활성화한 라이선스 키")
async def license_command(interaction: discord.Interaction, license_key: str):
    if not interaction.guild:
        await interaction.response.send_message("❌ 서버에서만 사용할 수 있습니다.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    try:
        status, payload = await asyncio.wait_for(
            api.activate_license(
                license_key,
                interaction.guild.id,
                interaction.user.id,
                bot.user.id if bot.user else None,
                str(bot.user) if bot.user else BOT_NAME,
            ),
            timeout=16,
        )
    except asyncio.TimeoutError:
        await interaction.followup.send(
            "❌ NEXIVO HUB 서버 응답이 너무 늦습니다. `WEBSITE_URL`과 `NEXIVO_BOT_WORKER_SECRET`를 확인해주세요.",
            ephemeral=True,
        )
        return
    except Exception as exc:
        print(f"[{BRAND}] license activation error: {exc!r}")
        await interaction.followup.send(
            "❌ 라이선스 인증 처리 중 오류가 발생했습니다. 봇 로그의 `license activation error`를 확인해주세요.",
            ephemeral=True,
        )
        return

    if status != 200:
        error = payload.get("error") if isinstance(payload, dict) else None
        await interaction.followup.send(f"❌ {error or '라이선스 인증에 실패했습니다.'}", ephemeral=True)
        return
    e = embed_base("✅ NEXIVO HUB • 라이선스 인증 완료", payload.get("message", "라이선스 코드가 확인되었습니다."), discord.Colour.green())
    e.add_field(name="플랜", value=f"`{payload.get('planLabel', payload.get('plan','UNKNOWN'))}`", inline=True)
    e.add_field(name="서버", value=interaction.guild.name, inline=True)
    e.add_field(name="상태", value="`CONNECTED`", inline=True)
    await interaction.followup.send(embed=e, ephemeral=True)


# ----------------------------
# Public vending UI
# ----------------------------
class CategorySelect(discord.ui.Select):
    def __init__(self, products: list[dict[str, Any]], *, mode: str = "browse"):
        categories = []
        seen = set()
        for p in products:
            cat = str(p.get("category") or "기본")
            if cat not in seen:
                categories.append(cat); seen.add(cat)
        categories = categories[:25] or ["기본"]
        self.products = products
        self.mode = mode
        options = [discord.SelectOption(label=c[:100], value=c[:100], description=f"{sum(1 for p in products if str(p.get('category') or '기본') == c)}개 상품") for c in categories]
        super().__init__(placeholder="카테고리를 선택하세요", min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        category = self.values[0]
        products = [p for p in (tenant.get("products") or []) if str(p.get("category") or "기본") == category]
        if not products:
            await interaction.response.send_message("❌ 선택한 카테고리에 상품이 없습니다.", ephemeral=True)
            return
        title = "🛒 구매 상품 선택" if self.mode == "buy" else "📦 제품 선택"
        e = embed_base(title, f"**{category}** 카테고리의 상품을 선택해주세요.\n원하는 상품을 선택하면 상세 정보와 구매 버튼이 표시됩니다.", discord.Colour.from_rgb(92, 80, 255))
        await interaction.response.send_message(embed=e, view=ProductSelect(products), ephemeral=True)


class ProductSelect(discord.ui.Select):
    def __init__(self, products: list[dict[str, Any]]):
        opts = []
        for p in products[:25]:
            stock = p.get("stock", -1)
            stock_text = "무제한" if stock == -1 else f"재고 {int(stock):,}개"
            opts.append(discord.SelectOption(
                label=str(p.get("name", "상품"))[:100],
                value=str(p.get("id")),
                description=f"{money(p.get('price', 0))} · {stock_text}"[:100],
            ))
        super().__init__(placeholder="상품을 선택하세요", min_values=1, max_values=1, options=opts)

    async def callback(self, interaction: discord.Interaction):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        product_id = self.values[0]
        product = next((p for p in tenant.get("products", []) if str(p.get("id")) == product_id), None)
        if not product:
            await interaction.response.send_message("❌ 상품 정보를 찾을 수 없습니다.", ephemeral=True)
            return
        stock = product.get("stock", -1)
        e = embed_base(f"🛍️ {product.get('name','상품')}", str(product.get("description") or "상품 상세 정보를 확인해주세요."), discord.Colour.from_rgb(96, 78, 255))
        e.add_field(name="가격", value=f"**{money(product.get('price',0))}**", inline=True)
        e.add_field(name="재고", value="무제한" if stock == -1 else f"`{int(stock):,}개`", inline=True)
        e.add_field(name="결제", value="`지갑 잔액`", inline=True)
        if product.get("features"):
            e.add_field(name="구성", value="\n".join(f"• {str(x)[:120]}" for x in product["features"][:8]), inline=False)
        await interaction.response.send_message(embed=e, view=PurchaseView(product_id), ephemeral=True)


def vending_banner_file() -> discord.File | None:
    """Use the bundled NEXIVO representative image directly in Discord embeds."""
    if VENDING_BANNER_FILE.exists():
        return discord.File(VENDING_BANNER_FILE, filename=VENDING_BANNER_NAME)
    return None


class VendingView(discord.ui.View):
    def __init__(self, products: list[dict[str, Any]]):
        super().__init__(timeout=None)
        self.products = products

    @discord.ui.button(label="공지", emoji="📣", style=discord.ButtonStyle.secondary, row=0, custom_id="nexivo_vending_notice")
    async def notice(self, interaction: discord.Interaction, _: discord.ui.Button):
        await interaction.response.send_message(embed=embed_base("📣 NEXIVO HUB • 공지", "NEXIVO VENDING은 Discord 자판기에서 잔액 충전과 상품 구매를 제공합니다.\n\n• 웹사이트: 잔액으로만 상품 구매\n• 충전: Discord에서 계좌이체 신청 → 운영자 승인\n• 구매 완료: 라이선스/상품 자동 지급\n• 구매 완료 후 웹사이트에서 후기 작성 가능"), ephemeral=True)

    @discord.ui.button(label="제품", emoji="🛍️", style=discord.ButtonStyle.secondary, row=0, custom_id="nexivo_vending_products")
    async def product_button(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        products = tenant.get("products") or []
        e = embed_base("🛍️ 카테고리 선택", "조회할 카테고리를 선택해주세요.")
        e.add_field(name="판매 상품", value=f"`{len(products):,}개`", inline=True)
        await interaction.response.send_message(embed=e, view=CategoryView(products, mode="browse"), ephemeral=True)

    @discord.ui.button(label="충전", emoji="💳", style=discord.ButtonStyle.secondary, row=0, custom_id="nexivo_vending_topup")
    async def topup(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        await interaction.response.send_modal(TopupModal())

    @discord.ui.button(label="정보", emoji="ℹ️", style=discord.ButtonStyle.secondary, row=0, custom_id="nexivo_vending_info")
    async def info(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction)
        if not tenant:
            return
        e = embed_base("ℹ️ NEXIVO HUB • 정보", "현재 서버에 연결된 NEXIVO HUB 정보입니다.")
        e.add_field(name="플랜", value=f"`{plan_label(tenant)}`", inline=True)
        e.add_field(name="봇", value=f"`{BOT_NAME}`", inline=True)
        e.add_field(name="서버", value=interaction.guild.name if interaction.guild else "-", inline=True)
        bal = await web_balance(interaction.user.id)
        e.add_field(name="내 잔액", value=f"`{money(bal)}`", inline=True)
        e.add_field(name="라이선스", value=f"`{tenant.get('licenseId','-')}`", inline=True)
        await interaction.response.send_message(embed=e, ephemeral=True)

    @discord.ui.button(label="구매", emoji="🛒", style=discord.ButtonStyle.primary, row=0, custom_id="nexivo_vending_buy")
    async def buy(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        products = tenant.get("products") or []
        if not products:
            await interaction.response.send_message("📦 현재 판매 중인 상품이 없습니다.", ephemeral=True)
            return
        e = embed_base("🛒 구매 카테고리 선택", "원하는 카테고리를 선택해주세요.\n카테고리 → 상품 → 구매하기 순서로 진행됩니다.")
        await interaction.response.send_message(embed=e, view=CategoryView(products, mode="buy"), ephemeral=True)

    @discord.ui.button(label="⭐ 구매후기", style=discord.ButtonStyle.success, row=1, custom_id="nexivo_vending_reviews")
    async def reviews(self, interaction: discord.Interaction, _: discord.ui.Button):
        e = embed_base("⭐ 구매후기", "상품을 구매하고 지급이 완료되면 웹사이트 구매완료 화면에서 후기를 작성할 수 있습니다.\n작성한 후기는 연결된 Discord 구매후기 채널로 자동 게시됩니다.")
        if WEBSITE_URL:
            view = discord.ui.View(timeout=120)
            view.add_item(discord.ui.Button(label="🌐 웹사이트에서 후기 작성", style=discord.ButtonStyle.link, url=f"{WEBSITE_URL}/?area=shop"))
            await interaction.response.send_message(embed=e, view=view, ephemeral=True)
        else:
            await interaction.response.send_message(embed=e, ephemeral=True)

    @discord.ui.button(label="🔄 새로고침", style=discord.ButtonStyle.secondary, row=1, custom_id="nexivo_vending_refresh")
    async def refresh(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        products = tenant.get("products") or []
        banner = vending_banner_file()
        await interaction.response.edit_message(embed=make_vending_embed(tenant), view=VendingView(products), attachments=[banner] if banner else [])


class CategoryView(discord.ui.View):
    def __init__(self, products: list[dict[str, Any]], *, mode: str = "browse"):
        super().__init__(timeout=180)
        self.add_item(CategorySelect(products, mode=mode))


class TopupModal(discord.ui.Modal, title="💳 NEXIVO HUB • 충전 신청"):

    amount = discord.ui.TextInput(
        label="충전 금액",
        placeholder="예: 10000",
        required=True,
        min_length=1,
        max_length=8,
    )

    async def on_submit(self, interaction: discord.Interaction):
        tenant = await gate(interaction, "products")
        if not tenant or not interaction.guild:
            return
        try:
            value = int(str(self.amount.value).replace(",", "").strip())
        except ValueError:
            await interaction.response.send_message("❌ 충전 금액은 숫자로 입력해주세요.", ephemeral=True)
            return
        if value < 1000 or value > 10_000_000:
            await interaction.response.send_message("❌ 충전 금액은 1,000원 이상 10,000,000원 이하로 입력해주세요.", ephemeral=True)
            return
        status, payload = await api.topup_request(interaction.user.id, str(interaction.user), interaction.guild.id, value)
        if status != 200:
            await interaction.response.send_message(f"❌ 충전 신청에 실패했습니다: {payload.get('error', '알 수 없는 오류')}", ephemeral=True)
            return
        req = payload.get("topup") or {}
        req_id = str(req.get("id") or make_id("TOP"))
        payment_info = str(req.get("paymentInfo") or tenant_bank_info(tenant))
        e = embed_base("💳 NEXIVO HUB • 충전 신청 접수", "아래 계좌로 정확한 금액을 입금한 뒤 운영자가 확인하면 웹사이트 지갑에 자동 반영됩니다.", discord.Colour.from_rgb(89, 108, 255))
        e.add_field(name="신청번호", value=f"`{req_id}`", inline=True)
        e.add_field(name="충전 금액", value=f"**{money(value)}**", inline=True)
        e.add_field(name="입금 계좌", value=payment_info, inline=False)
        e.add_field(name="진행", value="입금 → 운영자 확인 → 충전 승인 → 웹사이트 잔액 반영", inline=False)
        view = discord.ui.View(timeout=180)
        if WEBSITE_URL:
            view.add_item(discord.ui.Button(label="🌐 NEXIVO 상점 열기", style=discord.ButtonStyle.link, url=f"{WEBSITE_URL}/?area=shop"))
        await interaction.response.send_message(embed=e, view=view, ephemeral=True)
        if OWNER_ID:
            try:
                owner = bot.get_user(OWNER_ID) or await bot.fetch_user(OWNER_ID)
                dm_embed = embed_base("💳 NEXIVO HUB • 새로운 충전 신청", "입금 여부를 확인한 뒤 아래 버튼으로 승인/거절하세요.", discord.Colour.from_rgb(89, 108, 255))
                dm_embed.add_field(name="신청 ID", value=f"`{req_id}`", inline=True)
                dm_embed.add_field(name="금액", value=f"**{money(value)}**", inline=True)
                dm_embed.add_field(name="신청자", value=f"<@{interaction.user.id}>\n`{interaction.user.id}`", inline=True)
                dm_embed.add_field(name="서버", value=f"**{interaction.guild.name}**\n`{interaction.guild.id}`", inline=False)
                dm_embed.add_field(name="결제 안내", value=payment_info, inline=False)
                await owner.send(embed=dm_embed, view=TopupApprovalView(req_id))
            except (discord.Forbidden, discord.HTTPException):
                pass



def make_vending_embed(tenant: dict[str, Any]) -> discord.Embed:
    products = tenant.get("products") or []
    total_stock = 0
    unlimited = 0
    categories = sorted({str(p.get("category") or "기본") for p in products})
    for p in products:
        stock = p.get("stock", -1)
        if stock == -1:
            unlimited += 1
        else:
            total_stock += max(0, int(stock or 0))
    e = embed_base(
        "🛒 NEXIVO VENDING",
        "**원하는 상품을 쉽고 빠르게, NEXIVO와 함께하세요.**\n"
        "상품 선택 → 지갑 잔액 결제 → 자동 지급 → 웹사이트 후기",
        discord.Colour.from_rgb(94, 76, 255),
    )
    e.add_field(name="🛍️ 상품", value=f"`{len(products):,}개`", inline=True)
    e.add_field(name="📂 카테고리", value=f"`{len(categories):,}개`", inline=True)
    e.add_field(name="💳 잔액", value="`Discord 충전`", inline=True)
    e.add_field(name="✦ 이용 방법", value="**제품 / 구매** → 카테고리 선택 → 상품 선택 → **구매하기**", inline=False)
    e.add_field(name="✦ 충전 방법", value="**충전** 버튼 → 금액 입력 → 계좌이체 → 운영자 승인 → 지갑 반영", inline=False)
    e.add_field(name="✦ 후기", value="구매완료 후 웹사이트에서 후기를 작성하면 연결된 Discord 후기 채널에 자동 게시됩니다.", inline=False)
    if products:
        e.add_field(name="✦ 상품 미리보기", value=product_list_text(products, 5), inline=False)
    if VENDING_BANNER_FILE.exists():
        e.set_image(url=f"attachment://{VENDING_BANNER_NAME}")
    elif BANNER_URL:
        e.set_image(url=BANNER_URL)
    e.set_footer(text="NEXIVO • FAST · SAFE · TRUST • MORE THAN A BOT.")
    return e


class PurchaseView(discord.ui.View):
    def __init__(self, product_id: str):
        super().__init__(timeout=180)
        self.product_id = product_id

    @discord.ui.button(label="🛒 구매하기", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, _: discord.ui.Button):
        tenant = await gate(interaction, "products")
        if not tenant:
            return
        if not interaction.guild:
            await interaction.response.send_message("❌ Discord 서버에서만 구매할 수 있습니다.", ephemeral=True)
            return
        product = next((p for p in tenant.get("products", []) if str(p.get("id")) == self.product_id), None)
        if not product:
            await interaction.response.send_message("❌ 상품을 찾을 수 없습니다.", ephemeral=True)
            return
        price = int(float(product.get("price", 0) or 0))
        qty = 1
        total = price * qty
        stock = int(product.get("stock", -1))
        if stock == 0:
            await interaction.response.send_message("❌ 현재 품절된 상품입니다.", ephemeral=True)
            return
        bal = await web_balance(interaction.user.id)
        await interaction.response.defer(ephemeral=True)
        status, payload = await api.purchase_product(interaction.guild.id, self.product_id, interaction.user.id, str(interaction.user))
        if status != 200:
            await interaction.followup.send(f"❌ 구매 처리에 실패했습니다: {payload.get('error', '알 수 없는 오류')}", ephemeral=True)
            return
        order_info = payload.get("order") or {}
        order_id = str(order_info.get("id") or make_id("NXO"))
        delivery_key = str(payload.get("licenseKey") or order_info.get("deliveryKey") or "").strip()
        order = {
            "id": order_id,
            "guild_id": interaction.guild.id,
            "user_id": interaction.user.id,
            "username": str(interaction.user),
            "product_id": self.product_id,
            "product_name": str(product.get("name", "상품")),
            "quantity": qty,
            "amount": total,
            "total": total,
            "status": "완료",
            "delivery_type": str(order_info.get("deliveryType") or product.get("deliveryType") or "PLATFORM_LICENSE"),
            "license_key": delivery_key,
            "createdAt": order_info.get("createdAt") or now_iso(),
            "completedAt": order_info.get("deliveredAt") or now_iso(),
        }
        LOCAL.setdefault("local_orders", {})[order_id] = order
        await save_local()
        await sync_local_orders(interaction.guild.id, tenant)

        e = embed_base("✅ 구매 완료", "결제가 확인되어 라이선스 키가 자동 지급되었습니다.", discord.Colour.green())
        e.add_field(name="상품", value=str(product.get("name", "상품")), inline=False)
        e.add_field(name="주문번호", value=f"`{order_id}`", inline=True)
        e.add_field(name="결제 금액", value=f"**{money(total)}**", inline=True)
        if delivery_key:
            e.add_field(name="🔑 라이선스 키", value=f"`{delivery_key}`", inline=False)
            e.add_field(name="안내", value="구매에 사용한 Discord 계정에 라이선스가 자동 연결됩니다. 별도 `/라이센스` 입력은 필요하지 않습니다.", inline=False)
        wallet_after = (payload.get("wallet") or {}).get("balance", bal - total)
        e.add_field(name="잔액", value=f"`{money(wallet_after)}`", inline=True)
        await interaction.followup.send(embed=e, ephemeral=True)
        try:
            await interaction.user.send(embed=e)
        except (discord.Forbidden, discord.HTTPException):
            pass



@bot.tree.command(name="자판기", description="현재 서버에 연결된 NEXIVO HUB 자판기를 엽니다.")
async def vending_command(interaction: discord.Interaction):
    tenant = await gate(interaction, "products")
    if not tenant:
        return
    products = tenant.get("products") or []
    banner = vending_banner_file()
    if banner:
        await interaction.response.send_message(embed=make_vending_embed(tenant), view=VendingView(products), file=banner, ephemeral=True)
    else:
        await interaction.response.send_message(embed=make_vending_embed(tenant), view=VendingView(products), ephemeral=True)


@bot.tree.command(name="상품목록", description="현재 서버의 판매 상품을 확인합니다.")
async def products_command(interaction: discord.Interaction):
    tenant = await gate(interaction, "products")
    if not tenant:
        return
    e = embed_base("📦 NEXIVO HUB • 상품 목록", product_list_text(tenant.get("products") or [], 25))
    await interaction.response.send_message(embed=e, ephemeral=True)


# ----------------------------
# Wallet / top-up / purchase tickets
# ----------------------------
@bot.tree.command(name="잔액", description="내 자판기 잔액을 확인합니다.")
async def balance_command(interaction: discord.Interaction):
    tenant = await gate(interaction, "products")
    if not tenant:
        return
    bal = await web_balance(interaction.user.id)
    await interaction.response.send_message(f"💳 현재 잔액: **{money(bal)}**", ephemeral=True)


async def approve_topup_request(request_id: str, approver: discord.abc.User) -> tuple[bool, str, dict[str, Any] | None]:
    """웹사이트 지갑을 단일 진실 소스로 사용해 충전 신청을 승인합니다."""
    status, payload = await api.approve_topup(request_id.strip().upper(), str(approver))
    req = payload.get("topup") if isinstance(payload, dict) else None
    if status != 200:
        msg = payload.get("error", "충전 승인에 실패했습니다.") if isinstance(payload, dict) else "충전 승인에 실패했습니다."
        return False, f"❌ {msg}", req
    amount = int(req.get("amount", 0) or 0) if req else 0
    uid_raw = str(req.get("discordUserId", "") if req else "")
    user_id = int(uid_raw) if uid_raw.isdigit() else 0
    return True, f"✅ `{request_id.strip().upper()}` 승인 완료 · <@{user_id}> 지갑에 **{money(amount)}** 반영", req


class TopupApprovalView(discord.ui.View):
    def __init__(self, request_id: str):
        super().__init__(timeout=None)
        self.request_id = request_id

    @discord.ui.button(label="✅ 충전 승인", style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, _: discord.ui.Button):
        if not is_owner(interaction.user):
            await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=bool(interaction.guild))
            return
        ok, message, req = await approve_topup_request(self.request_id, interaction.user)
        if not ok:
            await interaction.response.send_message(message, ephemeral=bool(interaction.guild))
            return
        for child in self.children:
            if isinstance(child, discord.ui.Button): child.disabled = True
        if req:
            guild = bot.get_guild(int(req.get("guildId", 0) or 0))
            buyer = guild.get_member(int(req.get("discordUserId", 0) or 0)) if guild else None
            if buyer:
                try:
                    await buyer.send(embed=embed_base("✅ NEXIVO HUB • 충전 승인 완료", f"충전 신청 `{req.get('id', self.request_id)}`가 승인되었습니다. 지갑에 **{money(int(req.get('amount',0)))}**가 반영되었습니다.", discord.Colour.green()))
                except (discord.Forbidden, discord.HTTPException): pass
        await interaction.response.edit_message(embed=embed_base("✅ NEXIVO HUB • 충전 승인 완료", message + "\n\n웹사이트 지갑에 반영되었습니다.", discord.Colour.green()), view=self)

    @discord.ui.button(label="❌ 거절", style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, _: discord.ui.Button):
        if not is_owner(interaction.user):
            await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=bool(interaction.guild))
            return
        status, payload = await api.reject_topup(self.request_id.strip().upper(), str(interaction.user))
        if status != 200:
            await interaction.response.send_message(f"❌ {payload.get('error', '충전 거절에 실패했습니다.')}", ephemeral=bool(interaction.guild))
            return
        for child in self.children:
            if isinstance(child, discord.ui.Button): child.disabled = True
        req = payload.get("topup") or {}
        guild = bot.get_guild(int(req.get("guildId", 0) or 0))
        buyer = guild.get_member(int(req.get("discordUserId", 0) or 0)) if guild else None
        if buyer:
            try:
                await buyer.send(embed=embed_base("❌ NEXIVO HUB • 충전 신청 거절", f"충전 신청 `{req.get('id', self.request_id)}`이(가) 거절되었습니다.\n필요한 경우 정확한 금액으로 다시 신청해주세요.", discord.Colour.red()))
            except (discord.Forbidden, discord.HTTPException): pass
        await interaction.response.edit_message(embed=embed_base("❌ NEXIVO HUB • 충전 신청 거절", f"충전 신청 `{req.get('id', self.request_id)}`을(를) 거절 처리했습니다.", discord.Colour.red()), view=self)


@bot.tree.command(name="충전신청", description="Discord에서 지갑을 충전합니다.")
async def topup_request_command(interaction: discord.Interaction):
    tenant = await gate(interaction, "products")
    if not tenant:
        return
    await interaction.response.send_modal(TopupModal())


@bot.tree.command(name="충전대기", description="OWNER PRO: 대기 중인 계좌이체 충전 신청을 확인합니다.")
async def topup_pending_command(interaction: discord.Interaction):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
        return
    status, payload = await api.topup_pending()
    if status != 200:
        await interaction.response.send_message(f"❌ {payload.get('error', '충전 목록을 불러오지 못했습니다.')}", ephemeral=True)
        return
    rows = payload.get("topups") or []
    if not rows:
        await interaction.response.send_message("현재 대기 중인 충전 신청이 없습니다.", ephemeral=True)
        return
    lines = [f"`{x.get('id')}` · <@{x.get('discordUserId')}> · **{money(int(x.get('amount',0)))}**" for x in rows[:30]]
    await interaction.response.send_message(embed=embed_base("💳 OWNER PRO • 충전 대기", "\n".join(lines)), ephemeral=True)


@bot.tree.command(name="충전승인", description="OWNER PRO: 계좌이체 충전 신청을 승인합니다.")
@app_commands.describe(request_id="충전 신청 ID")
async def topup_approve_command(interaction: discord.Interaction, request_id: str):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
        return
    ok, message, _ = await approve_topup_request(request_id, interaction.user)
    await interaction.response.send_message(message, ephemeral=True)


async def create_purchase_ticket(interaction: discord.Interaction, tenant: dict[str, Any], order: dict[str, Any]) -> discord.TextChannel | None:
    if not interaction.guild:
        return None
    settings = tenant.get("settings") or {}
    category_id = str(settings.get("orderCategoryId") or "")
    category = interaction.guild.get_channel(int(category_id)) if category_id.isdigit() else None
    if not isinstance(category, discord.CategoryChannel):
        category = discord.utils.find(lambda c: c.name == "╭・🎫 NEXIVO ORDER CENTER", interaction.guild.categories)
    if not category:
        try:
            category = await interaction.guild.create_category("╭・🎫 NEXIVO ORDER CENTER", reason=f"{BRAND} order center")
        except discord.HTTPException:
            category = None
    overwrites = {interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False), interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, attach_files=True)}
    me = interaction.guild.me
    if me:
        overwrites[me] = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, manage_channels=True)
    try:
        channel = await interaction.guild.create_text_channel(f"order-{order['id'].lower()}", category=category, overwrites=overwrites, topic=f"{BRAND} 주문 {order['id']} · {order['product_name']}", reason=f"{BRAND} vending order")
    except discord.HTTPException:
        return None
    e = embed_base("🎫 NEXIVO HUB • PURCHASE CENTER", f"안녕하세요 {interaction.user.mention}님! 주문이 접수되었습니다.", discord.Colour.from_rgb(37, 99, 235))
    e.add_field(name="주문번호", value=f"`{order['id']}`", inline=True)
    e.add_field(name="상품", value=order["product_name"], inline=True)
    e.add_field(name="금액", value=f"**{money(order['total'])}**", inline=True)
    e.add_field(name="상태", value="`주문접수`", inline=True)
    e.add_field(name="진행", value="관리자가 지급을 완료하면 구매로그에 기록되고 후기 작성 버튼이 표시됩니다.", inline=False)
    await channel.send(content=interaction.user.mention, embed=e, view=OrderStaffView(order["id"]))
    return channel


class OrderStaffView(discord.ui.View):
    def __init__(self, order_id: str):
        super().__init__(timeout=None)
        self.order_id = order_id

    @discord.ui.button(label="✅ 구매 완료", style=discord.ButtonStyle.success)
    async def complete(self, interaction: discord.Interaction, _: discord.ui.Button):
        if not is_owner(interaction.user):
            await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
            return
        order = LOCAL.get("local_orders", {}).get(self.order_id)
        if not order:
            await interaction.response.send_message("❌ 주문을 찾을 수 없습니다.", ephemeral=True)
            return
        if order.get("status") == "완료":
            await interaction.response.send_message("이미 완료된 주문입니다.", ephemeral=True)
            return
        order["status"] = "완료"; order["completedAt"] = now_iso(); order["completedBy"] = str(interaction.user)
        await save_local()
        tenant = tenant_for_guild(interaction.guild.id) if interaction.guild else None
        if tenant:
            await sync_local_orders(interaction.guild.id, tenant)

        buyer_role_ok = False
        buyer_role_message = ""
        member = None
        if interaction.guild:
            try:
                member = interaction.guild.get_member(int(order.get("user_id", 0))) or await interaction.guild.fetch_member(int(order.get("user_id", 0)))
            except (discord.NotFound, discord.HTTPException):
                member = None
            if member:
                buyer_role_ok, buyer_role_message = await add_buyer_role(member)

        await send_purchase_log(interaction.guild, order)
        e = embed_base(
            "╭─── ✦ NEXIVO HUB • DELIVERY COMPLETE ✦ ───╮",
            f"🎉 <@{order['user_id']}>님의 주문 `{order['id']}`이 **정상적으로 지급 완료**되었습니다.",
            discord.Colour.green(),
        )
        e.add_field(name="📦 상품", value=order["product_name"], inline=True)
        e.add_field(name="💰 결제 금액", value=f"**{money(order['total'])}**", inline=True)
        e.add_field(name="⭐ 후기", value="아래 `⭐ 후기 작성하기` 버튼에서 후기를 남겨주세요.", inline=False)
        if buyer_role_ok:
            e.add_field(name="🎖️ 구매자 역할", value="NEXIVO 구매자 역할이 지급되었습니다.", inline=False)
        elif buyer_role_message:
            e.add_field(name="🎖️ 구매자 역할", value=buyer_role_message, inline=False)
        await interaction.channel.send(embed=e, view=ReviewButton(order["id"]))
        await interaction.response.send_message("✅ 지급 완료 처리 + 구매로그 기록 + 후기 버튼 표시를 완료했습니다.", ephemeral=True)

    @discord.ui.button(label="❌ 주문 취소", style=discord.ButtonStyle.danger)
    async def cancel(self, interaction: discord.Interaction, _: discord.ui.Button):
        if not is_owner(interaction.user):
            await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
            return
        order = LOCAL.get("local_orders", {}).get(self.order_id)
        if not order or order.get("status") in {"완료", "취소"}:
            await interaction.response.send_message("❌ 취소할 수 없는 주문입니다.", ephemeral=True)
            return
        order["status"] = "취소"; order["cancelledAt"] = now_iso(); order["cancelledBy"] = str(interaction.user)
        set_balance(int(order["guild_id"]), int(order["user_id"]), local_balance(int(order["guild_id"]), int(order["user_id"])) + int(order["total"]))
        tenant = tenant_for_guild(interaction.guild.id) if interaction.guild else None
        if int(order.get("guild_id", 0)) and tenant:
            if tenant:
                await api.adjust_stock(int(order["guild_id"]), str(order["product_id"]), int(order.get("quantity", 1)))
                await sync_local_orders(int(order["guild_id"]), tenant)
        await save_local()
        await interaction.response.send_message("↩️ 주문을 취소하고 잔액/재고를 복구했습니다.", ephemeral=True)


async def send_purchase_log(guild: discord.Guild | None, order: dict[str, Any]) -> None:
    if not guild:
        return
    channel = discord.utils.find(lambda c: c.name in {"「🧾」구매로그", "구매로그"}, guild.text_channels)
    if not channel:
        return
    e = embed_base("🧾 NEXIVO HUB • PURCHASE LOG", "구매 완료된 주문만 기록됩니다.", discord.Colour.green())
    e.add_field(name="구매자", value=f"<@{order['user_id']}>", inline=True)
    e.add_field(name="상품", value=order["product_name"], inline=True)
    e.add_field(name="금액", value=f"**{money(order['total'])}**", inline=True)
    e.add_field(name="주문번호", value=f"`{order['id']}`", inline=True)
    e.add_field(name="상태", value="`구매완료`", inline=True)
    await channel.send(embed=e)


async def sync_local_orders(guild_id: int, tenant: dict[str, Any]) -> None:
    orders = [o for o in LOCAL.get("local_orders", {}).values() if int(o.get("guild_id", 0)) == guild_id]
    settings = tenant.get("settings") or {}
    await api.push_worker_state(guild_id, orders, settings)


# ----------------------------
# Reviews
# ----------------------------
class ReviewModal(discord.ui.Modal, title="⭐ NEXIVO HUB 후기 작성"):
    rating = discord.ui.TextInput(label="별점 (1~5)", placeholder="5", min_length=1, max_length=1)
    content = discord.ui.TextInput(label="후기 내용", style=discord.TextStyle.paragraph, placeholder="상품과 서비스에 대한 후기를 작성해주세요.", max_length=1000)

    def __init__(self, order_id: str):
        super().__init__()
        self.order_id = order_id

    async def on_submit(self, interaction: discord.Interaction):
        order = LOCAL.get("local_orders", {}).get(self.order_id)
        if not order or int(order.get("user_id", 0)) != interaction.user.id or order.get("status") != "완료":
            await interaction.response.send_message("❌ 완료된 본인 주문만 후기를 작성할 수 있습니다.", ephemeral=True)
            return
        if order.get("review"):
            await interaction.response.send_message("ℹ️ 이 주문은 이미 후기를 작성하셨습니다.", ephemeral=True)
            return
        try:
            stars = max(1, min(5, int(str(self.rating.value))))
        except ValueError:
            await interaction.response.send_message("❌ 별점은 1~5 숫자로 입력해주세요.", ephemeral=True)
            return
        content = str(self.content.value).strip()
        status, payload = await api.submit_review(self.order_id, interaction.user.id, str(interaction.user), stars, content)
        if status != 200:
            await interaction.response.send_message(f"❌ 후기 등록에 실패했습니다: {payload.get('error', '알 수 없는 오류')}", ephemeral=True)
            return
        order["review"] = {"stars": stars, "content": content, "createdAt": now_iso()}
        await save_local()
        await interaction.response.send_message("✅ 후기가 정상적으로 등록되었습니다. 구매후기 채널에 자동 게시됩니다.", ephemeral=True)


class ReviewButton(discord.ui.View):
    def __init__(self, order_id: str):
        super().__init__(timeout=None)
        self.order_id = order_id

    @discord.ui.button(label="⭐ 후기 작성하기", style=discord.ButtonStyle.primary)
    async def review(self, interaction: discord.Interaction, _: discord.ui.Button):
        await interaction.response.send_modal(ReviewModal(self.order_id))


@bot.tree.command(name="후기작성", description="지급 완료된 내 주문에서 후기를 작성합니다.")
async def review_command(interaction: discord.Interaction):
    if not interaction.guild:
        await interaction.response.send_message("❌ Discord 서버에서만 사용할 수 있습니다.", ephemeral=True)
        return
    completed = [
        o for o in LOCAL.get("local_orders", {}).values()
        if int(o.get("guild_id", 0)) == interaction.guild.id
        and int(o.get("user_id", 0)) == interaction.user.id
        and o.get("status") == "완료"
        and not o.get("review")
    ]
    if not completed:
        await interaction.response.send_message("⭐ 작성할 수 있는 지급 완료 주문이 없습니다.", ephemeral=True)
        return
    e = embed_base(
        "╭─── ⭐ NEXIVO HUB • REVIEW ───╮",
        "지급이 완료된 주문을 선택해 후기를 남겨주세요.",
        discord.Colour.gold(),
    )
    rows = completed[-10:]
    e.add_field(
        name="작성 가능 주문",
        value="\n".join(f"`{o['id']}` · **{str(o['product_name'])[:45]}**" for o in rows),
        inline=False,
    )
    view = discord.ui.View(timeout=180)
    # Use one button per order, grouped into rows to stay within Discord limits.
    for idx, o in enumerate(rows):
        view.add_item(ReviewOrderButton(o["id"], row=idx // 5))
    await interaction.response.send_message(embed=e, view=view, ephemeral=True)


class ReviewOrderButton(discord.ui.Button):
    def __init__(self, order_id: str, row: int = 0):
        super().__init__(label=f"⭐ {order_id}", style=discord.ButtonStyle.primary, row=row)
        self.order_id = order_id

    async def callback(self, interaction: discord.Interaction):
        order = LOCAL.get("local_orders", {}).get(self.order_id)
        if not order or int(order.get("user_id", 0)) != interaction.user.id or order.get("status") != "완료":
            await interaction.response.send_message("❌ 지급 완료된 본인 주문만 작성할 수 있습니다.", ephemeral=True)
            return
        if order.get("review"):
            await interaction.response.send_message("ℹ️ 이 주문은 이미 후기를 작성하셨습니다.", ephemeral=True)
            return
        await interaction.response.send_modal(ReviewModal(self.order_id))


# ----------------------------
# Statistics / settings
# ----------------------------
@bot.tree.command(name="통계", description="Pro 이상: 서버 자판기 운영 통계를 확인합니다.")
async def stats_command(interaction: discord.Interaction):
    tenant = await gate(interaction, "reports")
    if not tenant:
        return
    orders = await api.orders(tenant)
    completed = [o for o in orders if str(o.get("status")) == "완료"]
    revenue = sum(int(float(o.get("amount", o.get("total", 0)) or 0)) for o in completed)
    e = embed_base("📊 NEXIVO HUB • 운영 통계", "현재 서버에 연결된 판매 운영 지표입니다.", discord.Colour.from_rgb(59, 130, 246))
    e.add_field(name="전체 주문", value=f"`{len(orders):,}건`", inline=True)
    e.add_field(name="완료 주문", value=f"`{len(completed):,}건`", inline=True)
    e.add_field(name="매출", value=f"**{money(revenue)}**", inline=True)
    e.add_field(name="판매 상품", value=f"`{len(tenant.get('products') or []):,}개`", inline=True)
    await interaction.response.send_message(embed=e, ephemeral=True)


@bot.tree.command(name="내정보", description="내 라이선스와 서버 연결 상태를 확인합니다.")
async def my_info_command(interaction: discord.Interaction):
    tenant = await gate(interaction)
    if not tenant:
        return
    e = embed_base("👤 NEXIVO HUB • 내 정보", f"<@{interaction.user.id}>님의 연결 정보입니다.")
    e.add_field(name="플랜", value=f"`{plan_label(tenant)}`", inline=True)
    e.add_field(name="봇 패밀리", value=f"`{plan_family(tenant) or 'OWNER'}`", inline=True)
    e.add_field(name="서버", value=interaction.guild.name, inline=True)
    e.add_field(name="라이선스", value=f"`{tenant.get('licenseId','-')}`", inline=False)
    bal = await web_balance(interaction.user.id)
    e.add_field(name="잔액", value=f"`{money(bal)}`", inline=True)
    await interaction.response.send_message(embed=e, ephemeral=True)


@bot.tree.command(name="동기화", description="OWNER PRO: 사이트의 상품/주문 정보를 즉시 새로 동기화합니다.")
async def sync_command(interaction: discord.Interaction):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    await api.refresh_tenants(True)
    tenant_count = len(api.tenants)
    await interaction.followup.send(f"✅ NEXIVO HUB 동기화 완료 · 활성 서버 `{tenant_count}`개", ephemeral=True)


@bot.tree.command(name="보안로그", description="OWNER PRO: 웹 인증 보안 로그를 확인합니다.")
@app_commands.describe(guild_id="특정 서버만 필터링하려면 Guild ID 입력")
async def security_logs_command(interaction: discord.Interaction, guild_id: str | None = None):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    gid = int(guild_id) if guild_id and guild_id.isdigit() else (interaction.guild.id if interaction.guild else None)
    status, payload = await api.security_logs(gid)
    if status != 200:
        await interaction.followup.send(f"❌ {payload.get('error','보안 로그를 불러오지 못했습니다.')}", ephemeral=True)
        return
    logs = payload.get("logs", [])[:15]
    if not logs:
        await interaction.followup.send("현재 보안 로그가 없습니다.", ephemeral=True)
        return
    lines = []
    for x in logs:
        ip = x.get("ip", "unknown")
        user = x.get("discordUsername") or x.get("discordUserId") or "-"
        lines.append(f"`{x.get('at','')[:19]}` · `{ip}` · `{user}` · `{x.get('action','')}` · `{x.get('result','')}`")
    e = embed_base("🛡️ OWNER PRO • 보안 로그", "웹 인증 방문 IP와 Discord 인증 기록을 확인합니다.", discord.Colour.red())
    e.add_field(name="최근 기록", value="\n".join(lines), inline=False)
    e.set_footer(text=f"IP 로그 보관 정책 · {payload.get('retentionDays',30)}일")
    await interaction.followup.send(embed=e, ephemeral=True)


# ----------------------------
# NEXIVO roles
# ----------------------------
ROLE_DEFINITIONS = {
    "verified": {
        "name": "NEXIVO VERIFIED",
        "color": discord.Colour.from_rgb(34, 197, 94),
        "hoist": False,
        "mentionable": False,
    },
    "buyer": {
        "name": "NEXIVO 구매자",
        "color": discord.Colour.from_rgb(59, 130, 246),
        "hoist": True,
        "mentionable": True,
    },
    "staff": {
        "name": "NEXIVO STAFF",
        "color": discord.Colour.from_rgb(168, 85, 247),
        "hoist": True,
        "mentionable": True,
    },
}


async def ensure_role(guild: discord.Guild, key: str) -> discord.Role | None:
    design = ROLE_DEFINITIONS[key]
    role = discord.utils.get(guild.roles, name=design["name"])
    if role:
        return role
    try:
        return await guild.create_role(
            name=design["name"],
            colour=design["color"],
            hoist=design["hoist"],
            mentionable=design["mentionable"],
            permissions=discord.Permissions.none(),
            reason=f"{BRAND} role template",
        )
    except discord.HTTPException:
        return None


async def ensure_nexivo_roles(guild: discord.Guild) -> dict[str, discord.Role]:
    roles: dict[str, discord.Role] = {}
    for key in ROLE_DEFINITIONS:
        role = await ensure_role(guild, key)
        if role:
            roles[key] = role
    return roles


async def add_buyer_role(member: discord.Member) -> tuple[bool, str]:
    role = await ensure_role(member.guild, "buyer")
    if not role:
        return False, "NEXIVO 구매자 역할을 만들 수 없습니다."
    if role in member.roles:
        return True, "이미 NEXIVO 구매자 역할을 보유하고 있습니다."
    if member.guild.me and role >= member.guild.me.top_role:
        return False, "NEXIVO 구매자 역할이 봇 역할보다 높습니다. 역할 순서를 조정해주세요."
    try:
        await member.add_roles(role, reason=f"{BRAND} completed purchase")
        return True, "NEXIVO 구매자 역할을 지급했습니다."
    except discord.Forbidden:
        return False, "구매자 역할 지급 권한이 없습니다. 봇의 역할이 NEXIVO 구매자 역할보다 위에 있는지 확인해주세요."
    except discord.HTTPException:
        return False, "구매자 역할 지급 중 Discord 오류가 발생했습니다."


# ----------------------------
# Server template / moderation-like owner tools
# ----------------------------
TEMPLATE = {
    "info": [
        ("「👋」환영", "welcome"), ("「🚪」퇴장", "leave"), ("「📢」공지", "notice"), ("「✅」인증", "verify"), ("「📖」이용방법", "guide")
    ],
    "store": [
        ("「🛍️」자판기", "vending"), ("「📦」상품목록", "products"), ("「🔥」인기상품", "popular")
    ],
    "community": [
        ("「⭐」구매후기", "reviews"), ("「🧾」구매로그", "purchase_log"), ("「🏆」구매인증", "showcase"), ("「🎉」이벤트", "event"), ("「💭」자유채팅", "chat")
    ],
    "order": [
        ("「🎫」주문센터", "orders"), ("「💳」충전안내", "payment")
    ],
    "logs": [
        ("「👋」입장로그", "join_log"), ("「🚪」퇴장로그", "leave_log")
    ],
    "support": [
        ("「💬」일반문의", "help"), ("「🤝」파트너문의", "partnership"), ("「🛠️」커스텀문의", "custom")
    ],
    "staff": [
        ("「🤖」봇로그", "bot_log"), ("「🔐」스태프채팅", "staff_chat")
    ],
}

CATEGORY_NAMES = {
    "info": "╭・📢 NEXIVO INFORMATION",
    "store": "╭・🛒 NEXIVO STORE",
    "order": "╭・🎫 NEXIVO ORDER CENTER",
    "support": "╭・💬 NEXIVO SUPPORT",
    "community": "╭・⭐ NEXIVO COMMUNITY",
    "staff": "╭・🔒 NEXIVO STAFF",
    "logs": "╭・🛡️ NEXIVO LOGS",
}


async def ensure_category(
    guild: discord.Guild,
    name: str,
    *,
    private: bool = False,
) -> discord.CategoryChannel | None:
    found = discord.utils.find(lambda c: c.name == name, guild.categories)
    if found:
        if private:
            try:
                overwrites = dict(found.overwrites)
                overwrites[guild.default_role] = discord.PermissionOverwrite(view_channel=False)
                if guild.me:
                    overwrites[guild.me] = discord.PermissionOverwrite(
                        view_channel=True, send_messages=True, read_message_history=True, manage_channels=True, manage_messages=True
                    )
                await found.edit(overwrites=overwrites, reason=f"{BRAND} private staff category")
            except discord.HTTPException:
                pass
        return found
    overwrites = {}
    if private:
        overwrites[guild.default_role] = discord.PermissionOverwrite(view_channel=False)
        if guild.me:
            overwrites[guild.me] = discord.PermissionOverwrite(
                view_channel=True, send_messages=True, read_message_history=True, manage_channels=True, manage_messages=True
            )
    try:
        return await guild.create_category(name, overwrites=overwrites, reason=f"{BRAND} server template")
    except discord.HTTPException:
        return None



async def create_named_channel(guild: discord.Guild, category: discord.CategoryChannel | None, name: str, kind: str):
    existing = discord.utils.get(guild.text_channels, name=name)
    if existing:
        return existing
    try:
        return await guild.create_text_channel(name, category=category, reason=f"{BRAND} server template")
    except discord.HTTPException:
        return None


async def send_panel(channel: discord.TextChannel, kind: str):
    if kind == "vending":
        tenant = tenant_for_guild(channel.guild.id)
        if tenant:
            banner = vending_banner_file()
            if banner:
                await channel.send(embed=make_vending_embed(tenant), view=VendingView(tenant.get("products") or []), file=banner)
            else:
                await channel.send(embed=make_vending_embed(tenant), view=VendingView(tenant.get("products") or []))
        else:
            await channel.send(embed=embed_base("🛍️ NEXIVO HUB • 자판기", "웹사이트에서 라이선스를 구매하면 이 Discord 서버에 자동으로 연결됩니다."))
    elif kind == "products":
        tenant = tenant_for_guild(channel.guild.id)
        e = embed_base("╭─── 📦 NEXIVO HUB • 상품목록 ───╮", product_list_text((tenant or {}).get("products") or []))
        if tenant:
            e.add_field(name="현재 플랜", value=f"`{plan_label(tenant)}`", inline=True)
            e.add_field(name="상품 수", value=f"`{len(tenant.get('products') or []):,}개`", inline=True)
        await channel.send(embed=e)
    elif kind == "verify":
        url = f"{WEBSITE_URL}/verify?guild={channel.guild.id}" if WEBSITE_URL else "#"
        view = discord.ui.View(timeout=None)
        view.add_item(discord.ui.Button(label="✅ Discord 인증하기", style=discord.ButtonStyle.link, url=url))
        e = embed_base("✅ NEXIVO HUB • 서버 인증", "아래 버튼을 눌러 Discord 계정을 인증해주세요.\n인증 과정은 웹에서 진행되며 보안 기록이 생성될 수 있습니다.", discord.Colour.green())
        await channel.send(embed=e, view=view)
    elif kind == "guide":
        e = embed_base("📖 NEXIVO HUB • 이용방법", "라이선스 구매 → 자동 연결 → `/자판기` → 상품 선택 → 잔액 결제 → 자동 지급 → 후기", discord.Colour.from_rgb(59, 130, 246))
        await channel.send(embed=e)
    elif kind == "purchase_log":
        await channel.send(embed=embed_base("╭─── 🧾 NEXIVO HUB • 구매로그 ───╮", "**지급이 완료된 주문만** 공개 기록됩니다.\n주문 진행 중인 정보는 이 채널에 노출되지 않습니다.", discord.Colour.green()))
    elif kind == "reviews":
        await channel.send(embed=embed_base("╭─── ⭐ NEXIVO HUB • 구매후기 ───╮", "지급 완료된 구매자가 직접 작성한 후기를 모아보는 공간입니다.", discord.Colour.gold()))
    elif kind == "welcome":
        e = embed_base("╭─── 👋 NEXIVO HUB • WELCOME ───╮", "**NEXIVO HUB에 오신 것을 환영합니다.**\n\n먼저 서버 인증을 완료한 뒤 자판기를 이용해주세요.")
        e.add_field(name="① 인증", value="웹사이트에서 Discord 계정으로 로그인/라이선스 구매를 완료합니다.", inline=False)
        e.add_field(name="② 쇼핑", value="`「🛍️」자판기`에서 상품을 선택합니다.", inline=False)
        e.add_field(name="③ 후기", value="지급 완료 후 `⭐ 후기 작성하기` 버튼으로 후기를 남길 수 있습니다.", inline=False)
        await channel.send(embed=e)
    elif kind == "notice":
        await channel.send(embed=embed_base("📢 NEXIVO HUB • 공지", "중요한 운영 공지사항을 안내하는 공간입니다."))
    elif kind == "payment":
        tenant = tenant_for_guild(channel.guild.id)
        e = embed_base("╭─── 💳 NEXIVO HUB • 충전안내 ───╮", "Discord 자판기에서 계좌이체 충전을 신청하고 운영자 승인 후 지갑에 반영됩니다.")
        e.add_field(name="이용 방법", value="`충전` 버튼 → 금액 입력 → 안내 계좌 입금 → 운영자 승인", inline=False)
        e.add_field(name="웹사이트", value=f"{WEBSITE_URL}/?area=shop" if WEBSITE_URL else "웹사이트 주소가 설정되지 않았습니다.", inline=False)
        await channel.send(embed=e)


@bot.tree.command(name="서버생성", description="OWNER PRO: NEXIVO HUB 서버 템플릿을 생성합니다.")
async def create_server_command(interaction: discord.Interaction):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 **OWNER PRO 전용 기능입니다.**\n이 명령어는 지정된 NEXIVO HUB 오너 Discord ID에서만 실행할 수 있습니다.", ephemeral=True)
        return
    if not interaction.guild:
        await interaction.response.send_message("❌ Discord 서버에서만 사용할 수 있습니다.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild

    roles = await ensure_nexivo_roles(guild)
    # The owner also receives the STAFF role for access to the private staff area.
    owner_role = roles.get("staff")
    if owner_role and owner_role not in interaction.user.roles and isinstance(interaction.user, discord.Member):
        if not guild.me or owner_role < guild.me.top_role:
            try:
                await interaction.user.add_roles(owner_role, reason=f"{BRAND} owner staff role")
            except discord.HTTPException:
                pass

    created = 0
    panel_count = 0
    for cat_key, rows in TEMPLATE.items():
        category = await ensure_category(
            guild,
            CATEGORY_NAMES[cat_key],
            private=(cat_key == "staff"),
        )
        if category and cat_key == "staff" and owner_role:
            try:
                overwrites = dict(category.overwrites)
                overwrites[guild.default_role] = discord.PermissionOverwrite(view_channel=False)
                overwrites[owner_role] = discord.PermissionOverwrite(
                    view_channel=True, send_messages=True, read_message_history=True, attach_files=True
                )
                if guild.me:
                    overwrites[guild.me] = discord.PermissionOverwrite(
                        view_channel=True, send_messages=True, read_message_history=True, manage_channels=True, manage_messages=True
                    )
                await category.edit(overwrites=overwrites, reason=f"{BRAND} staff role access")
            except discord.HTTPException:
                pass
        for name, kind in rows:
            ch = await create_named_channel(guild, category, name, kind)
            if ch:
                created += 1
                if kind in {"vending", "verify", "guide", "products", "reviews", "purchase_log", "welcome", "notice", "payment"}:
                    try:
                        if not ch.last_message_id:
                            await send_panel(ch, kind)
                            panel_count += 1
                    except discord.HTTPException:
                        pass

    # Keep shopper-facing categories near the top so reviews and purchase logs are visible immediately.
    category_priority = [
        CATEGORY_NAMES["info"],
        CATEGORY_NAMES["community"],
        CATEGORY_NAMES["store"],
        CATEGORY_NAMES["order"],
        CATEGORY_NAMES["logs"],
        CATEGORY_NAMES["support"],
        CATEGORY_NAMES["staff"],
    ]
    try:
        by_name = {c.name: c for c in guild.categories}
        for pos, category_name in enumerate(category_priority):
            category = by_name.get(category_name)
            if category:
                await category.edit(position=pos, reason=f"{BRAND} public category ordering")
    except discord.HTTPException:
        pass

    role_lines = []
    for key, label in (("verified", "인증 역할"), ("buyer", "구매자 역할"), ("staff", "스태프 역할")):
        role = roles.get(key)
        role_lines.append(f"{label}: {role.mention if role else '생성 실패'}")

    e = embed_base(
        "╭─── ✦ NEXIVO HUB • SERVER SETUP ✦ ───╮",
        "서버용 판매/주문/커뮤니티 구조를 생성하고 역할까지 연결했습니다.",
        discord.Colour.from_rgb(37, 99, 235),
    )
    e.add_field(name="📁 채널", value=f"`{created}개`", inline=True)
    e.add_field(name="🧩 패널", value=f"`{panel_count}개`", inline=True)
    e.add_field(name="🛡️ 역할", value=f"`{len(roles)}개`", inline=True)
    e.add_field(name="역할 구성", value="\n".join(role_lines), inline=False)
    e.add_field(name="📌 공개 영역", value="구매후기 · 구매로그 · 입장/퇴장로그를 위쪽의 공개 카테고리에 배치했습니다.", inline=False)
    e.add_field(name="🔒 운영 영역", value="봇로그 · 스태프채팅은 `NEXIVO STAFF` 카테고리에서 비공개로 운영됩니다.", inline=False)
    e.set_footer(text="NEXIVO HUB • OWNER PRO SERVER BUILDER")
    await interaction.followup.send(embed=e, ephemeral=True)


@bot.tree.command(name="서버삭제", description="OWNER PRO: 실행한 채널만 남기고 서버의 다른 채널을 정리합니다.")
@app_commands.describe(confirm="반드시 '삭제'라고 입력해야 실행됩니다.")
async def delete_server_command(interaction: discord.Interaction, confirm: str):
    if not is_owner(interaction.user):
        await interaction.response.send_message("🔒 OWNER PRO 전용 기능입니다.", ephemeral=True)
        return
    if confirm.strip() != "삭제":
        await interaction.response.send_message("⚠️ 정말 정리하려면 `확인: 삭제`를 입력해주세요. Discord 서버 자체는 삭제되지 않습니다.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    current = interaction.channel
    deleted = 0
    for ch in list(interaction.guild.channels):
        if ch.id == current.id:
            continue
        try:
            await ch.delete(reason=f"{BRAND} owner template reset")
            deleted += 1
        except (discord.Forbidden, discord.HTTPException):
            continue
    await interaction.followup.send(f"✅ 서버 채널 정리를 완료했습니다. 현재 채널은 남겨두었습니다. 삭제 처리: `{deleted}개`", ephemeral=True)


# ----------------------------
# Join / leave logs
# ----------------------------
async def log_join_leave(member: discord.Member, joined: bool) -> None:
    name = "「👋」입장로그" if joined else "「🚪」퇴장로그"
    channel = discord.utils.get(member.guild.text_channels, name=name)
    if not channel:
        return
    if joined:
        e = embed_base("👋 NEXIVO HUB • MEMBER JOIN", f"환영합니다, {member.mention}!", discord.Colour.green())
        e.add_field(name="사용자", value=f"{member} (`{member.id}`)", inline=True)
        e.add_field(name="멤버 수", value=f"`{member.guild.member_count:,}`", inline=True)
    else:
        e = embed_base("🚪 NEXIVO HUB • MEMBER LEAVE", f"`{member}` 님이 서버를 떠났습니다.", discord.Colour.red())
        e.add_field(name="사용자 ID", value=f"`{member.id}`", inline=True)
        e.add_field(name="서버", value=member.guild.name, inline=True)
    await channel.send(embed=e)


@bot.event
async def on_member_join(member: discord.Member):
    await log_join_leave(member, True)


@bot.event
async def on_member_remove(member: discord.Member):
    await log_join_leave(member, False)


# ----------------------------
# Verification event / security handling
# ----------------------------
async def apply_verification(guild_id: str, discord_user_id: str) -> None:
    guild = bot.get_guild(int(guild_id)) if guild_id.isdigit() else None
    if not guild:
        return
    role = await ensure_role(guild, "verified")
    if not role:
        return
    try:
        member = guild.get_member(int(discord_user_id)) or await guild.fetch_member(int(discord_user_id))
    except (discord.NotFound, discord.HTTPException):
        return
    try:
        await member.add_roles(role, reason=f"{BRAND} web verification")
    except discord.HTTPException:
        return


async def publish_web_review(payload: dict[str, Any]) -> None:
    guild_id = str(payload.get("guildId") or "")
    review = payload.get("review") or {}
    order = payload.get("order") or {}
    if not guild_id or not review:
        return
    guild = bot.get_guild(int(guild_id)) if guild_id.isdigit() else None
    if not guild:
        return
    channel = discord.utils.find(lambda c: c.name in {"「⭐」구매후기", "구매후기"}, guild.text_channels)
    if not channel:
        return
    e = embed_base("⭐ NEXIVO HUB • 구매 후기", f"<@{review.get('discordUserId') or order.get('buyerDiscordId') or '0'}>님의 후기입니다.", discord.Colour.from_rgb(244, 199, 78))
    e.add_field(name="상품", value=str(review.get("productName") or order.get("productName") or "상품"), inline=False)
    rating = max(1, min(5, int(review.get("rating") or 0)))
    e.add_field(name="별점", value="⭐" * rating + "☆" * (5 - rating), inline=True)
    e.add_field(name="주문번호", value=f"`{review.get('orderId') or order.get('id') or '-'} `".strip(), inline=True)
    e.add_field(name="후기", value=str(review.get("content") or "-")[:1024], inline=False)
    try:
        await channel.send(embed=e)
    except discord.HTTPException:
        pass


async def stream_loop() -> None:
    if not WEBSITE_URL or not WORKER_SECRET:
        return
    while not bot.is_closed():
        try:
            await api.start()
            assert api.session is not None
            url = api.url("/api/bot/stream")
            async with api.session.get(url, headers=api.headers(), timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=None)) as resp:
                if resp.status != 200:
                    await asyncio.sleep(5)
                    continue
                async for raw in resp.content:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    payload = data.get("payload") or {}
                    if str(data.get("type")) == "verification.completed":
                        gid = str(payload.get("guildId") or "")
                        uid = str(payload.get("discordUserId") or "")
                        if gid and uid:
                            await apply_verification(gid, uid)
                    if str(data.get("type")) == "review.created":
                        await publish_web_review(payload)
                    # Any website event may change products/orders/settings; refresh immediately.
                    if data:
                        await api.refresh_tenants(True)
        except asyncio.CancelledError:
            return
        except Exception:
            await asyncio.sleep(5)


async def refresh_loop() -> None:
    while not bot.is_closed():
        try:
            await api.refresh_tenants(True)
        except Exception:
            pass
        await asyncio.sleep(12)


# ----------------------------
# Help / ready
# ----------------------------
@bot.tree.command(name="도움말", description="NEXIVO HUB 명령어와 사용법을 확인합니다.")
async def help_command(interaction: discord.Interaction):
    e = embed_base("❔ NEXIVO HUB • 도움말", "공용 NEXIVO HUB 자판기봇입니다.")
    e.add_field(name="🔐 라이선스", value="상점에서 지갑으로 구매하면 Discord 계정에 자동 연결", inline=False)
    e.add_field(name="🛍️ 판매", value="`/자판기` · `/상품목록` · `/잔액` · `/충전신청`", inline=False)
    e.add_field(name="⭐ 후기", value="구매 완료 후 `⭐ 후기 작성하기`", inline=False)
    e.add_field(name="📊 Pro", value="`/통계` · 플랜에 따라 사용 가능", inline=False)
    e.add_field(name="👑 OWNER PRO", value="`/서버생성` · `/서버삭제` · `/충전승인` · `/동기화` · `/보안로그`", inline=False)
    if INVITE_URL:
        v = discord.ui.View(timeout=180)
        v.add_item(discord.ui.Button(label="🤖 NEXIVO HUB 봇 초대", style=discord.ButtonStyle.link, url=INVITE_URL))
        await interaction.response.send_message(embed=e, view=v, ephemeral=True)
    else:
        await interaction.response.send_message(embed=e, ephemeral=True)


@bot.event
async def on_ready():
    await api.start()
    try:
        bot.add_view(VendingView([]))
    except Exception:
        pass
    try:
        await api.refresh_tenants(True)
    except Exception:
        pass
    try:
        synced = await bot.tree.sync()
        print(f"[{BRAND}] logged in as {bot.user} | slash_commands={len(synced)} | tenants={len(api.tenants)}")
    except Exception as exc:
        print(f"[{BRAND}] command sync failed: {exc!r}")
    if not getattr(bot, "_background_tasks_started", False):
        bot._background_tasks_started = True
        bot.loop.create_task(refresh_loop())
        bot.loop.create_task(stream_loop())


@bot.event
async def on_disconnect():
    # discord.py will reconnect automatically where possible.
    pass


async def shutdown():
    await api.close()


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN이 설정되지 않았습니다.")
    if not WEBSITE_URL:
        raise SystemExit("WEBSITE_URL이 설정되지 않았습니다.")
    if not WORKER_SECRET:
        raise SystemExit("NEXIVO_BOT_WORKER_SECRET가 설정되지 않았습니다.")
    try:
        bot.run(TOKEN)
    finally:
        try:
            asyncio.run(shutdown())
        except RuntimeError:
            pass
