"""Plan catalog, entitlement resolution, and capacity checks.

Source of truth for Starter / Pro / Advanced limits. There is no free plan: unpaid
orgs get zero ingest/upload capacity until a Paddle trial or paid sub (or promo).
Next.js must not invent caps — mutating paths call require_plan_capacity.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy.orm import Session

PlanId = Literal["starter", "pro", "advanced", "plus"]
PlanAction = Literal[
    "upload_files",
    "add_chunks",
    "add_seats",
    "add_source",
    "drive",
]
# `plus` kept as a legacy alias of `advanced`.
PAID_PLANS: frozenset[PlanId] = frozenset({"starter", "pro", "advanced", "plus"})

PAST_DUE_GRACE_DAYS = int(os.getenv("BILLING_PAST_DUE_GRACE_DAYS", "3"))
STARTER_PRICE_USD_CENTS = 1000    # Starter $10 / user / month
PRO_PRICE_USD_CENTS = 4000        # Pro $40 / user / month
ADVANCED_PRICE_USD_CENTS = 12000  # Advanced $120 / user / month
PLUS_PRICE_USD_CENTS = ADVANCED_PRICE_USD_CENTS  # legacy alias


@dataclass(frozen=True)
class PlanLimits:
    id: PlanId
    name: str
    seats: int
    chunks: int
    upload_files: int
    source_types: int | None  # None = unlimited
    drive: bool
    price_per_seat_usd_cents: int


PLANS: dict[PlanId, PlanLimits] = {
    "starter": PlanLimits(
        id="starter",
        name="Starter",
        seats=20,
        chunks=2_500,
        upload_files=10,
        source_types=2,
        drive=False,
        price_per_seat_usd_cents=STARTER_PRICE_USD_CENTS,
    ),
    "pro": PlanLimits(
        id="pro",
        name="Pro",
        seats=40,
        chunks=8_000,
        upload_files=50,
        source_types=4,
        drive=True,
        price_per_seat_usd_cents=PRO_PRICE_USD_CENTS,
    ),
    "advanced": PlanLimits(
        id="advanced",
        name="Advanced",
        seats=200,
        chunks=80_000,
        upload_files=2_000,
        source_types=None,
        drive=True,
        price_per_seat_usd_cents=ADVANCED_PRICE_USD_CENTS,
    ),
}

# Legacy Plus rows / webhooks normalize to Advanced limits.
PLANS["plus"] = PlanLimits(
    id="plus",
    name="Advanced",
    seats=PLANS["advanced"].seats,
    chunks=PLANS["advanced"].chunks,
    upload_files=PLANS["advanced"].upload_files,
    source_types=PLANS["advanced"].source_types,
    drive=True,
    price_per_seat_usd_cents=ADVANCED_PRICE_USD_CENTS,
)

# Unpaid / no subscription — seat for the creating admin only; no ingest or uploads.
UNPAID_LIMITS = PlanLimits(
    id="starter",
    name="No plan",
    seats=1,
    chunks=0,
    upload_files=0,
    source_types=0,
    drive=False,
    price_per_seat_usd_cents=STARTER_PRICE_USD_CENTS,
)


@dataclass
class Entitlement:
    plan: PlanId
    status: str
    source: str | None  # paddle | promo | None
    seats_billed: int
    current_period_end: datetime | None
    paddle_customer_id: str | None
    paddle_subscription_id: str | None
    limits: PlanLimits

    @property
    def is_paid(self) -> bool:
        # Paid or trialing via Paddle/promo. Unpaid orgs have source=None.
        return self.source in ("paddle", "promo") and self.plan in (
            "starter",
            "pro",
            "advanced",
            "plus",
        )

    @property
    def is_pro(self) -> bool:
        # Back-compat: any entitled paid plan (Pro / Advanced / legacy Plus).
        return self.is_paid


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def resolve_entitlement(session: Session, clerk_org_id: str) -> Entitlement:
    """Effective plan for an org: active/grace Paddle sub or unexpired promo, else Starter."""
    from database import OrgSubscription

    row = (
        session.query(OrgSubscription)
        .filter(OrgSubscription.clerk_org_id == clerk_org_id)
        .first()
    )
    if not row:
        return Entitlement(
            plan="starter",
            status="none",
            source=None,
            seats_billed=1,
            current_period_end=None,
            paddle_customer_id=None,
            paddle_subscription_id=None,
            limits=UNPAID_LIMITS,
        )

    now = _utcnow()
    period_end = _aware(row.current_period_end)
    status = (row.status or "active").lower()
    source = (row.source or "").lower()
    plan = (row.plan or "starter").lower()

    entitled = False
    effective: PlanId = "starter"
    known = plan in PLANS
    if known:
        effective = "advanced" if plan == "plus" else plan  # type: ignore[assignment]
        if source == "paddle" and status in ("active", "trialing"):
            entitled = True
        elif source == "paddle" and status == "past_due":
            grace_anchor = period_end or _aware(row.updated_at) or now
            entitled = now <= grace_anchor + timedelta(days=PAST_DUE_GRACE_DAYS)
        elif source == "promo" and status in ("active", "trialing"):
            entitled = period_end is None or now <= period_end
        elif status == "canceled" and period_end and now <= period_end:
            entitled = True

    if entitled:
        limits_key: PlanId = effective if effective in PLANS else "starter"
        return Entitlement(
            plan=effective,
            status=status,
            source=source or None,
            seats_billed=max(1, int(row.seats or 1)),
            current_period_end=period_end,
            paddle_customer_id=row.paddle_customer_id,
            paddle_subscription_id=row.paddle_subscription_id,
            limits=PLANS[limits_key],
        )

    return Entitlement(
        plan="starter",
        status=status if status else "none",
        source=source or None,
        seats_billed=max(1, int(row.seats or 1)),
        current_period_end=period_end,
        paddle_customer_id=row.paddle_customer_id,
        paddle_subscription_id=row.paddle_subscription_id,
        limits=UNPAID_LIMITS,
    )


def count_upload_files(session: Session, org_id: str) -> int:
    from database import DocumentFile, session_for_org

    # Tenant tables have FORCE RLS. The billing session is usually the DB owner
    # without athena.org_id set, so a direct count returns 0 on Render.
    with session_for_org(org_id) as scoped:
        return (
            scoped.query(DocumentFile)
            .filter(DocumentFile.org_id == org_id, DocumentFile.source_type == "upload")
            .count()
        )


def count_chunks(session: Session, org_id: str) -> int:
    from database import DocumentChunk, session_for_org

    with session_for_org(org_id) as scoped:
        return scoped.query(DocumentChunk).filter(DocumentChunk.org_id == org_id).count()


def count_members(session: Session, clerk_org_id: str) -> int:
    from database import OrganizationMember

    return (
        session.query(OrganizationMember)
        .filter(OrganizationMember.clerk_org_id == clerk_org_id)
        .count()
    )


def configured_source_keys(org) -> set[str]:
    """Distinct connector types currently configured on the org row."""
    keys: set[str] = set()
    if org is None:
        return keys
    if getattr(org, "notion_api_key", None) and getattr(org, "notion_root_page_id", None):
        keys.add("notion")
    docs = getattr(org, "public_doc_ids", None) or []
    if isinstance(docs, list) and any(docs):
        keys.add("google_docs")
    forms = getattr(org, "tally_form_ids", None) or []
    if getattr(org, "tally_api_key", None) and isinstance(forms, list) and any(forms):
        keys.add("tally")
    if getattr(org, "drive_folder_id", None):
        keys.add("drive")
    return keys


def source_keys_after_ingest(
    org,
    *,
    notion_api_key: str | None = None,
    notion_root_page_id: str | None = None,
    public_doc_ids: list[str] | None = None,
    drive_folder_id: str | None = None,
    tally_api_key: str | None = None,
    tally_form_ids: list[str] | None = None,
) -> set[str]:
    """What source set would look like after applying this ingest payload."""
    keys = configured_source_keys(org)
    if notion_api_key and notion_root_page_id:
        keys.add("notion")
    if public_doc_ids:
        keys.add("google_docs")
    if tally_api_key and tally_form_ids:
        keys.add("tally")
    if drive_folder_id:
        keys.add("drive")
    return keys


def _limit_error(
    *,
    limit_name: str,
    used: int,
    limit: int | None,
    plan: PlanId,
) -> HTTPException:
    return HTTPException(
        status_code=402,
        detail={
            "code": "plan_limit",
            "limit_name": limit_name,
            "used": used,
            "limit": limit,
            "plan": plan,
            "upgrade_path": "/admin/billing",
            "message": (
                f"{limit_name.replace('_', ' ').title()} limit reached on the "
                f"{PLANS[plan].name} plan."
                + (
                    " Upgrade to continue."
                    if plan not in ("advanced", "plus")
                    else ""
                )
            ),
        },
    )


def require_subscription(session: Session, clerk_org_id: str) -> Entitlement:
    """Raise 402 when the org has no active/trialing Paddle or promo entitlement."""
    ent = resolve_entitlement(session, clerk_org_id)
    if ent.is_paid:
        return ent
    raise HTTPException(
        status_code=402,
        detail={
            "code": "subscription_required",
            "limit_name": "subscription",
            "used": 0,
            "limit": 0,
            "plan": ent.plan,
            "upgrade_path": "/admin/billing",
            "message": (
                "Start a 7-day free trial to connect knowledge sources and upload files. "
                "There is no free plan."
            ),
        },
    )


def require_plan_capacity(
    session: Session,
    clerk_org_id: str,
    action: PlanAction,
    *,
    extra_files: int = 0,
    extra_chunks: int = 0,
    extra_seats: int = 0,
    proposed_sources: set[str] | None = None,
) -> Entitlement:
    """Raise HTTP 402 when unpaid, or when the action would exceed plan limits."""
    ent = resolve_entitlement(session, clerk_org_id)
    limits = ent.limits

    # Integrations + uploads require a trial or paid plan. Seat invites for the
    # founding admin are allowed so the org can still be set up.
    if action in ("upload_files", "add_chunks", "add_source", "drive") and not ent.is_paid:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "subscription_required",
                "limit_name": action,
                "used": 0,
                "limit": 0,
                "plan": ent.plan,
                "upgrade_path": "/admin/billing",
                "message": (
                    "Start a 7-day free trial to connect knowledge sources and upload files. "
                    "There is no free plan."
                ),
            },
        )

    if action == "drive":
        if not limits.drive:
            raise _limit_error(limit_name="google_drive", used=1, limit=0, plan=ent.plan)
        return ent

    if action == "upload_files":
        used = count_upload_files(session, clerk_org_id)
        if used + extra_files > limits.upload_files:
            raise _limit_error(
                limit_name="upload_files",
                used=used,
                limit=limits.upload_files,
                plan=ent.plan,
            )
        return ent

    if action == "add_chunks":
        used = count_chunks(session, clerk_org_id)
        if used + extra_chunks > limits.chunks:
            raise _limit_error(
                limit_name="chunks",
                used=used,
                limit=limits.chunks,
                plan=ent.plan,
            )
        return ent

    if action == "add_seats":
        used = count_members(session, clerk_org_id)
        if used + extra_seats > limits.seats:
            raise _limit_error(
                limit_name="seats",
                used=used,
                limit=limits.seats,
                plan=ent.plan,
            )
        return ent

    if action == "add_source":
        from database import Organization

        org = (
            session.query(Organization)
            .filter(Organization.clerk_org_id == clerk_org_id)
            .first()
        )
        sources = proposed_sources if proposed_sources is not None else configured_source_keys(org)
        if "drive" in sources and not limits.drive:
            raise _limit_error(limit_name="google_drive", used=1, limit=0, plan=ent.plan)
        if limits.source_types is not None:
            # Drive counts toward Pro sources; on Starter it's blocked above.
            countable = {s for s in sources if s != "drive" or limits.drive}
            if len(countable) > limits.source_types:
                raise _limit_error(
                    limit_name="source_types",
                    used=len(countable),
                    limit=limits.source_types,
                    plan=ent.plan,
                )
        return ent

    raise ValueError(f"Unknown plan action: {action}")


def usage_snapshot(session: Session, clerk_org_id: str, *, member_count: int | None = None) -> dict[str, Any]:
    """Payload shared by /stats and /billing/entitlement."""
    from database import Organization

    ent = resolve_entitlement(session, clerk_org_id)
    org = (
        session.query(Organization)
        .filter(Organization.clerk_org_id == clerk_org_id)
        .first()
    )
    sources = configured_source_keys(org)
    members = member_count if member_count is not None else count_members(session, clerk_org_id)
    chunks = count_chunks(session, clerk_org_id)
    files = count_upload_files(session, clerk_org_id)
    limits = ent.limits

    return {
        "plan": ent.plan,
        "plan_name": limits.name,
        "status": ent.status,
        "is_paid": ent.is_paid,
        "source": ent.source,
        "period_end": ent.current_period_end.isoformat() if ent.current_period_end else None,
        "seats_billed": ent.seats_billed,
        "paddle_customer_id": ent.paddle_customer_id,
        "paddle_subscription_id": ent.paddle_subscription_id,
        "chunks": chunks,
        "files": files,
        "members": members,
        "sources": sorted(sources),
        "source_count": len(sources),
        "limits": {
            "seats": limits.seats,
            "chunks": limits.chunks,
            "upload_files": limits.upload_files,
            "source_types": limits.source_types,
            "drive": limits.drive,
            "price_per_seat_usd_cents": limits.price_per_seat_usd_cents,
        },
        "client_token": os.getenv("PADDLE_CLIENT_TOKEN", "") or None,
        "environment": os.getenv("PADDLE_ENVIRONMENT", "sandbox"),
        "price_id": os.getenv("PADDLE_PRICE_ID_PRO", "") or None,
        "price_id_plus": os.getenv("PADDLE_PRICE_ID_PLUS", "") or None,
    }


def upsert_subscription(
    session: Session,
    clerk_org_id: str,
    *,
    plan: PlanId,
    status: str,
    source: str,
    seats: int,
    current_period_end: datetime | None = None,
    paddle_customer_id: str | None = None,
    paddle_subscription_id: str | None = None,
) -> None:
    from database import OrgSubscription

    row = (
        session.query(OrgSubscription)
        .filter(OrgSubscription.clerk_org_id == clerk_org_id)
        .first()
    )
    now = _utcnow()
    if row:
        row.plan = plan
        row.status = status
        row.source = source
        row.seats = max(1, seats)
        if current_period_end is not None:
            row.current_period_end = current_period_end
        if paddle_customer_id is not None:
            row.paddle_customer_id = paddle_customer_id
        if paddle_subscription_id is not None:
            row.paddle_subscription_id = paddle_subscription_id
        row.updated_at = now
    else:
        session.add(
            OrgSubscription(
                clerk_org_id=clerk_org_id,
                plan=plan,
                status=status,
                source=source,
                seats=max(1, seats),
                current_period_end=current_period_end,
                paddle_customer_id=paddle_customer_id,
                paddle_subscription_id=paddle_subscription_id,
            )
        )


def redeem_promo(
    session: Session,
    *,
    clerk_org_id: str,
    clerk_user_id: str,
    code: str,
) -> Entitlement:
    from database import PromoCode, PromoRedemption
    from sqlalchemy.exc import IntegrityError

    normalized = code.strip().upper()
    if not normalized:
        raise HTTPException(status_code=400, detail="Promo code is required.")

    promo = session.query(PromoCode).filter(PromoCode.code == normalized).first()
    if not promo or not promo.active:
        raise HTTPException(status_code=404, detail="Invalid or inactive promo code.")

    expires = _aware(promo.expires_at)
    if expires and _utcnow() > expires:
        raise HTTPException(status_code=400, detail="This promo code has expired.")

    if promo.max_redemptions is not None:
        used = (
            session.query(PromoRedemption)
            .filter(PromoRedemption.promo_code_id == promo.id)
            .count()
        )
        if used >= promo.max_redemptions:
            raise HTTPException(status_code=400, detail="This promo code has no redemptions left.")

    # Paid Paddle Pro already — no need to redeem.
    existing = resolve_entitlement(session, clerk_org_id)
    if existing.is_pro and existing.source == "paddle":
        raise HTTPException(status_code=400, detail="This organisation is already on Pro.")

    period_end = _utcnow() + timedelta(days=int(promo.duration_days or 30))
    grant_plan: PlanId = promo.grant_plan if promo.grant_plan in PAID_PLANS else "pro"  # type: ignore[assignment]
    seats = max(1, count_members(session, clerk_org_id) or 1)

    if (
        session.query(PromoRedemption)
        .filter(PromoRedemption.clerk_org_id == clerk_org_id)
        .first()
    ):
        raise HTTPException(
            status_code=400,
            detail="This organisation has already redeemed a promo code.",
        )

    session.add(
        PromoRedemption(
            promo_code_id=promo.id,
            clerk_org_id=clerk_org_id,
            redeemed_by=clerk_user_id,
        )
    )

    upsert_subscription(
        session,
        clerk_org_id,
        plan=grant_plan,
        status="active",
        source="promo",
        seats=seats,
        current_period_end=period_end,
        paddle_customer_id=existing.paddle_customer_id,
        paddle_subscription_id=existing.paddle_subscription_id,
    )
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=400,
            detail="This organisation has already redeemed a promo code.",
        )
    return resolve_entitlement(session, clerk_org_id)


def grant_signup_promo(
    session: Session,
    *,
    clerk_org_id: str,
    clerk_user_id: str,
    code: str | None = None,
) -> dict[str, Any]:
    """Apply the signup promo once. Already-redeemed and already-paid orgs are a no-op.

    Called with explicit Clerk ids from onboarding (server-to-server). The browser
    session JWT often has no org_id until setActive finishes, so this must not
    depend on require_auth.
    """
    promo_code = (code or os.getenv("SIGNUP_PROMO_CODE", "ATHENA-EARLY")).strip()
    try:
        ent = redeem_promo(
            session,
            clerk_org_id=clerk_org_id,
            clerk_user_id=clerk_user_id,
            code=promo_code,
        )
    except HTTPException as exc:
        if exc.status_code in (400, 404):
            detail = exc.detail if isinstance(exc.detail, str) else "Could not apply promo code."
            return {"granted": False, "reason": detail}
        raise
    period_end = ent.current_period_end.isoformat() if ent.current_period_end else None
    return {
        "granted": True,
        "plan": ent.plan,
        "source": ent.source,
        "period_end": period_end,
    }
