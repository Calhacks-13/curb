from datetime import datetime

from app.domain.driveways import DrivewayService, NotFoundError
from app.domain.freshness import freshness_for
from app.domain.ranking import distance_m, distance_to_line_m, rank_options
from app.models.domain import (
    DrivewayState, GeoPoint, NearbyParkingResponse, ParkingSpaceView, SpaceDetail,
)
from app.repositories.protocols import ParkingRepository
from app.domain.sign_rules import evaluate_rule_text


class ParkingService:
    def __init__(self, repository: ParkingRepository, minimum_confidence: float = 0.8,
                 driveway_service: DrivewayService | None = None):
        self.repository = repository
        self.minimum_confidence = minimum_confidence
        self.driveway_service = driveway_service

    def _space_view(self, space: ParkingSpaceView, now: datetime, distance: float = 0):
        freshness = freshness_for(space.last_observed_at, now) if space.last_observed_at else None
        label = {"FRESH": "Likely open", "AGING": "May still be open", "STALE": "Stale observation"}.get(freshness, "Availability unknown")
        if space.internal_state != "OPEN":
            freshness, label = None, "Availability unknown"
        return space.model_copy(update={"freshness": freshness, "status_label": label, "distance_m": distance})

    async def nearby(
        self, origin: GeoPoint, radius_m: float, now: datetime, viewer_id: str | None = None
    ) -> NearbyParkingResponse:
        zones = [zone for zone in await self.repository.list_zones()
                 if distance_to_line_m(origin, zone.geometry) <= radius_m]
        for index, zone in enumerate(zones):
            if zone.sign_rule_id and zone.sign_rule_id.startswith("scan-rule:"):
                rule = await self.repository.get_rule(zone.sign_rule_id)
                if rule is not None:
                    status, change = evaluate_rule_text(rule.evidence_text, now)
                    zones[index] = zone.model_copy(update={"legal_status_now": status, "next_change_at": change})
        by_id = {zone.id: zone for zone in zones}
        spaces = []
        for space in await self.repository.list_spaces():
            zone = by_id.get(space.zone_id)
            if zone is None or zone.legal_status_now != "LEGAL" or zone.sign_rule_id is None:
                continue
            rule = await self.repository.get_rule(zone.sign_rule_id)
            if rule is None or rule.zone_id != zone.id:
                continue
            distance = distance_m(origin, space.location)
            view = self._space_view(space, now, distance)
            if (space.internal_state == "OPEN" and view.freshness is not None
                    and space.base_confidence >= self.minimum_confidence and distance <= radius_m):
                spaces.append(view)
        listings = []
        for view in await self.repository.list_driveways():
            if self.driveway_service is not None:
                try:
                    view = await self.driveway_service.get_driveway(view.id, now)
                except NotFoundError:
                    continue
            listings.append(view)
        driveways = []
        for view in listings:
            in_window = view.availability_start <= now < view.availability_end
            personal = viewer_id is not None and (
                view.owner_id == viewer_id or view.held_by_user_id == viewer_id
            )
            available_nearby = (
                view.state == DrivewayState.AVAILABLE
                and in_window
                and distance_m(origin, view.location) <= radius_m
            )
            if personal or available_nearby:
                driveways.append(view.model_copy(update={
                    "available_now": view.state == DrivewayState.AVAILABLE and in_window,
                }))
        ranked = rank_options(origin, [*driveways, *spaces])
        return NearbyParkingResponse(
            generated_at=now, zones=zones,
            spaces=[view for view in ranked if isinstance(view, ParkingSpaceView)],
            driveways=[view for view in ranked if not isinstance(view, ParkingSpaceView)],
        )

    async def detail(self, space_id: str, now: datetime) -> SpaceDetail | None:
        space = await self.repository.get_space(space_id)
        if space is None:
            return None
        zone = await self.repository.get_zone(space.zone_id)
        rule = await self.repository.get_rule(zone.sign_rule_id) if zone and zone.sign_rule_id else None
        if rule is None or rule.zone_id != space.zone_id:
            return None
        if rule.id.startswith("scan-rule:"):
            _, change = evaluate_rule_text(rule.evidence_text, now)
            zone = zone.model_copy(update={"next_change_at": change})
        return SpaceDetail(
            **self._space_view(space, now).model_dump(), sign_rule=rule,
            current_rules=(rule.evidence_text.splitlines()[0] if rule.id.startswith("scan-rule:") and rule.evidence_text else zone.current_rules), max_minutes=rule.max_minutes,
            next_change_at=zone.next_change_at,
        )
