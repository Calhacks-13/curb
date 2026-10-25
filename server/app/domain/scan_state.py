"""Canonical map writes shared by scanner responses and lifecycle maintenance."""
import logging
from datetime import UTC, datetime
from app.models.cv import BlockObservation, SpotDocument
from app.models.domain import (
    CurbZoneView as CanonicalCurbZone, DayOfWeek, GeoLineString,
    GeoPoint as CanonicalGeoPoint, GeoPolygon, InternalSpaceState, LegalStatus,
    ParkingSpaceView as CanonicalParkingSpace, PaymentRules, PermitRules,
    RuleKind, SignRuleView as CanonicalSignRule, WeeklyRuleWindow,
)
from app.repositories.protocols import ParkingRepository
from app.domain.sign_rules import has_curb_evidence, rule_text, rule_summary, evaluate_rule_text
logger = logging.getLogger(__name__)


def utc_iso(value: datetime | str | None) -> str | None:
    """Legacy CV dates were naive UTC; never let phones interpret them as local."""
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    aware = parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    return aware.isoformat().replace("+00:00", "Z")


async def persist_confirmed_scan(repository: ParkingRepository, block: BlockObservation, spot: SpotDocument | None = None, evaluated_at: datetime | None = None) -> None:
    """Store a scanner-confirmed opening in the canonical map repository.

    A scanner observation is tied to its captured GPS coordinates; it never
    moves demo data or invents a location elsewhere on the map.
    """
    if not (-90 <= block.lat <= 90 and -180 <= block.lng <= 180) or (block.lat == block.lng == 0):
        logger.warning("Not persisting scan %s without a valid GPS coordinate", block.segment_id)
        return

    observed_at = block.confirmed_at
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=UTC)
    else:
        observed_at = observed_at.astimezone(UTC)

    sign = block.sign_rules if has_curb_evidence(block.sign_rules) else None
    evidence = rule_text(sign)
    status, next_change = evaluate_rule_text(evidence, evaluated_at)
    legal_status = LegalStatus(status)
    # Conditional/monthly restrictions must not become all-day weekly bans.
    conditional = bool(next_change) or status == "UNKNOWN"
    rule_kind = RuleKind.NO_PARKING if status == "ILLEGAL" else RuleKind.ALLOWED
    rule_id = f"scan-rule:{block.segment_id}"
    d = 0.00003
    line_d = 0.00005
    coordinates = (block.lng, block.lat)

    rule = CanonicalSignRule(
        id=rule_id,
        zone_id=block.segment_id,
        weekly_schedule=[] if conditional else [WeeklyRuleWindow(
            days=list(DayOfWeek), start_local="00:00", end_local="23:59", kind=rule_kind,
        )],
        max_minutes=sign.combined_max_duration_min if sign else None,
        payment_rules=PaymentRules(
            required=bool(sign and sign.combined_price),
            price_text=sign.combined_price if sign else None,
        ),
        permit_rules=PermitRules(required=False, permitted_labels=[]),
        exceptions=sign.combined_restrictions if sign else [],
        evidence_text=evidence,
        interpretation_confidence=sign.confidence_score if sign else 0.0,
        last_validated_at=observed_at,
        version=spot.version if spot else 1,
    )
    zone = CanonicalCurbZone(
        id=block.segment_id,
        geometry=GeoLineString(type="LineString", coordinates=[
            (block.lng - line_d, block.lat), (block.lng + line_d, block.lat),
        ]),
        sign_rule_id=rule_id,
        legal_status_now=legal_status,
        current_rules=rule_summary(sign),
        next_change_at=next_change,
        version=spot.version if spot else 1,
    )
    state = InternalSpaceState.OPEN if block.gap_count > 0 else InternalSpaceState.OCCUPIED
    label = "Likely open"
    if spot is not None:
        state = InternalSpaceState.UNKNOWN if spot.status == "expired" else InternalSpaceState(spot.status.upper())
        label = {"open": "Likely open", "occupied": "Occupied", "expired": "Stale"}[spot.status]
    space = CanonicalParkingSpace(
        id=spot.id if spot else block.segment_id,
        zone_id=block.segment_id,
        location=CanonicalGeoPoint(type="Point", coordinates=coordinates),
        stall_geometry=GeoPolygon(type="Polygon", coordinates=[[
            (block.lng - d, block.lat - d), (block.lng + d, block.lat - d),
            (block.lng + d, block.lat + d), (block.lng - d, block.lat + d),
            (block.lng - d, block.lat - d),
        ]]),
        internal_state=state,
        last_observed_at=observed_at,
        base_confidence=max(0.0, min(1.0, block.confidence)),
        freshness=None,
        status_label=label,
        distance_m=0,
        version=spot.version if spot else 1,
    )
    await repository.upsert("rules", rule)
    await repository.upsert("zones", zone)
    await repository.upsert("spaces", space)



async def persist_spot(repository: ParkingRepository, spot: SpotDocument, now: datetime | None = None) -> None:
    await persist_confirmed_scan(repository, BlockObservation(
        segment_id=spot.segment_id, gap_count=1 if spot.status == "open" else 0,
        confidence=spot.confidence, sign_rules=spot.sign_rules,
        confirmed_at=spot.last_seen_at, lat=spot.lat, lng=spot.lng, location=spot.location,
    ), spot, now)
