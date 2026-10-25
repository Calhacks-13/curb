"""Reproducible presentation supply around Palace of Fine Arts.

Street geometry is from OpenStreetMap; observations and sign rules are invented.
Namespace IDs isolate this scenario from real CV records. UI uses normal contracts.
"""
import asyncio
import json
import math
import logging
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from app.domain.freshness import freshness_for
from app.models.domain import (
    CurbZoneView, DayOfWeek, DrivewayView, GeoLineString, GeoPoint, GeoPolygon, ParkingSpaceView,
    PaymentRules, PermitRules, SignRuleView, WeeklyRuleWindow,
)

PREFIX = "palace-v1:"
LA = ZoneInfo("America/Los_Angeles")
ROADS = json.loads(Path(__file__).with_name("palace.json").read_text())["roads"]
LAT = 37.803
METERS_LAT = 111_320
METERS_LNG = METERS_LAT * math.cos(math.radians(LAT))


def xy(point):
    return point[0] * METERS_LNG, point[1] * METERS_LAT


def lnglat(point):
    return round(point[0] / METERS_LNG, 8), round(point[1] / METERS_LAT, 8)


def along(road, fraction):
    points = [xy(point) for point in road["coordinates"]]
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    target = sum(lengths) * fraction
    for a, b, length in zip(points, points[1:], lengths):
        if target <= length and length:
            u = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
            # Shift the centerline to a curb, preserving the actual road curve.
            return (a[0] + u[0]*target + u[1]*3.5, a[1] + u[1]*target - u[0]*3.5), u
        target -= length
    raise ValueError("Invalid street geometry")


def next_boundary(now):
    local = now.astimezone(LA)
    for offset in (0, 1):
        for hour in (8, 18):
            instant = (local + timedelta(days=offset)).replace(hour=hour, minute=0, second=0, microsecond=0)
            if instant > local:
                return instant.astimezone(UTC)


def records(now: datetime):
    zones, rules, spaces = [], [], []
    index = 0
    for block, road in enumerate(ROADS):
        zone_id = f"{PREFIX}zone:{road['osm_way']}"
        profile = block % 5
        maximum = [240, 120, 120, None, None][profile]
        paid = profile == 2
        summary = [
            "4-hour parking, 8 AM–6 PM. No time limit outside posted hours.",
            "2-hour parking, 8 AM–6 PM. No time limit outside posted hours.",
            "2-hour metered parking, 8 AM–6 PM. Free outside posted hours.",
            "Parking permitted. No posted time limit.",
            "No sign read for this curb yet.",
        ][profile]
        rule_id = f"{PREFIX}rule:{road['osm_way']}" if profile != 4 else None
        change = next_boundary(now) if profile < 3 else None
        zones.append(CurbZoneView(id=zone_id,
            geometry=GeoLineString(type="LineString", coordinates=[lnglat(along(road, f)[0]) for f in [.07,.25,.5,.75,.93]]),
            sign_rule_id=rule_id, legal_status_now="UNKNOWN" if rule_id is None else "LEGAL",
            current_rules=summary, next_change_at=change, version=1))
        if rule_id:
            rules.append(SignRuleView(id=rule_id, zone_id=zone_id,
                weekly_schedule=[WeeklyRuleWindow(days=list(DayOfWeek), start_local="08:00", end_local="18:00", kind="METERED" if paid else "ALLOWED")],
                max_minutes=maximum, payment_rules=PaymentRules(required=paid, price_text="$3.50/hr, 8 AM–6 PM" if paid else None),
                permit_rules=PermitRules(required=False, permitted_labels=[]), exceptions=[], evidence_text=summary,
                interpretation_confidence=round(.86+(block%5)*.025, 2), last_validated_at=now-timedelta(seconds=240), version=1))
        for offset in range(road["count"]):
            point, u = along(road, .12 + .76*offset/(road["count"]-1))
            ring = []
            for length, width in [(-2.9,-1.1),(2.9,-1.1),(2.9,1.1),(-2.9,1.1)]:
                ring.append(lnglat((point[0]+u[0]*length+u[1]*width, point[1]+u[1]*length-u[0]*width)))
            ring.append(ring[0])
            state = "OCCUPIED" if index % 13 == 0 else "UNKNOWN" if index % 19 == 0 else "OPEN"
            age = 15+index%65 if index%5 < 3 else 105+index%50 if index%5 == 3 else 205+index%45
            observed = now - timedelta(seconds=age)
            spaces.append(ParkingSpaceView(id=f"{PREFIX}space:{road['osm_way']}:{offset+1:02d}", zone_id=zone_id,
                location=GeoPoint(type="Point", coordinates=lnglat(point)), stall_geometry=GeoPolygon(type="Polygon", coordinates=[ring]),
                internal_state=state, last_observed_at=observed, base_confidence=round(.84+(index%8)*.02, 2),
                detection_confidence=round(.83+(index%8)*.02, 2), freshness=freshness_for(observed, now) if state=="OPEN" else None,
                status_label="Likely open" if state=="OPEN" else "Occupied" if state=="OCCUPIED" else "Availability unknown", distance_m=0, version=1))
            index += 1
    # Keep a small, geographically spread sample, preserving stable marker IDs.
    openings = [space for space in spaces if space.internal_state == "OPEN"]
    spaces = [openings[round(index * (len(openings)-1) / 7)] for index in range(8)]
    selected_zones = {space.zone_id for space in spaces}
    return ([zone for zone in zones if zone.id in selected_zones],
            [rule for rule in rules if rule.zone_id in selected_zones], spaces)


async def load_driveways(repository, now):
    """Add sample residential listings once; preserve bookings and owner edits."""
    coordinates = [(-122.44691,37.80232), (-122.44692,37.80170),
                   (-122.44610,37.80296), (-122.44526,37.80306),
                   (-122.44709,37.80461), (-122.44824,37.80485)]
    selected = {0, 3, 5}
    for existing in await repository.list_driveways():
        if (existing.id.startswith(f"{PREFIX}driveway:")
                and existing.id not in {f"{PREFIX}driveway:{index+1:02d}" for index in selected}
                and existing.state == "AVAILABLE"):
            await repository.upsert("driveways", existing.model_copy(update={
                "state":"UNAVAILABLE", "available_now":False, "version":existing.version+1}))
    for index, point in enumerate(coordinates):
        if index not in selected:
            continue
        listing = DrivewayView(
            id=f"{PREFIX}driveway:{index+1:02d}", owner_id="owner_demo",
            location=GeoPoint(type="Point", coordinates=point),
            photo_url="https://placehold.co/640x400/png?text=Private+Driveway",
            price_usdc="0.50",
            availability_start=now-timedelta(days=1), availability_end=now+timedelta(days=30),
            availability_timezone="America/Los_Angeles", state="AVAILABLE",
            held_by_user_id=None, active_booking=None, available_now=True, distance_m=0, version=1)
        await repository.add_if_absent("driveways", listing)
    return len(selected)


class PalaceScenario:
    def __init__(self, repository, publish, clock=None):
        self.repository = repository
        self.publish = publish
        self.clock = clock or (lambda: datetime.now(UTC))
        self._refresh_task = None
        self._lock = asyncio.Lock()
        self._control_lock = asyncio.Lock()
        self.refresh_until = None

    async def _publish(self, kind, item):
        await self.publish(kind, item.id, item.model_dump(mode="json"), item.version)

    async def load(self):
        async with self._lock:
            zones, rules, spaces = records(self.clock())
            stored_zones = {item.id:item for item in await self.repository.list_zones() if item.id.startswith(PREFIX)}
            stored_spaces = {item.id:item for item in await self.repository.list_spaces() if item.id.startswith(PREFIX)}
            selected_ids = {item.id for item in spaces}
            for old in stored_spaces.values():
                if old.id not in selected_ids and old.internal_state != "UNKNOWN":
                    retired = old.model_copy(update={"internal_state":"UNKNOWN", "version":old.version+1,
                        "freshness":None, "status_label":"Availability unknown"})
                    await self.repository.upsert("spaces", retired)
                    await self._publish("space.expired", retired)
            zones = [item.model_copy(update={"version": stored_zones[item.id].version+1}) if item.id in stored_zones else item for item in zones]
            spaces = [item.model_copy(update={"version": stored_spaces[item.id].version+1}) if item.id in stored_spaces else item for item in spaces]
            versions = {item.id:item.version for item in zones}
            rules = [item.model_copy(update={"version":versions[item.zone_id]}) for item in rules]
            semaphore = asyncio.Semaphore(6)
            async def write(collection, item):
                async with semaphore:
                    await self.repository.upsert(collection, item)
            for collection, items in [("rules",rules),("zones",zones),("spaces",spaces)]:
                await asyncio.gather(*(write(collection,item) for item in items))
            async def announce(kind, item):
                async with semaphore:
                    await self._publish(kind,item)
            await asyncio.gather(*(announce("sign_rule.updated", item) for item in zones))
            await asyncio.gather(*(announce(("space.refreshed" if item.id in stored_spaces else "space.opened") if item.internal_state=="OPEN" else "space.occupied" if item.internal_state=="OCCUPIED" else "space.expired",item) for item in spaces))
            counts = Counter(item.internal_state.value for item in spaces)
            return {"spaces":len(spaces), "open":counts["OPEN"], "occupied":counts["OCCUPIED"], "unknown":counts["UNKNOWN"], "streets":len({road["street"] for road in ROADS if f"{PREFIX}zone:{road['osm_way']}" in versions}), "zones":len(zones)}

    async def close(self):
        task, self._refresh_task = self._refresh_task, None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.refresh_until = None

    async def start(self, keep_fresh_seconds):
        async with self._control_lock:
            await self.close()
            result = await self.load()
            if keep_fresh_seconds:
                self.refresh_until = self.clock()+timedelta(seconds=keep_fresh_seconds)
                async def refresh():
                    deadline = time.monotonic()+keep_fresh_seconds
                    while time.monotonic() < deadline:
                        await asyncio.sleep(min(30, max(0, deadline-time.monotonic())))
                        if time.monotonic() < deadline:
                            try:
                                await self.load()
                            except Exception as error:
                                logging.getLogger(__name__).warning("Palace refresh failed (%s)",type(error).__name__)
                self._refresh_task = asyncio.create_task(refresh())
            return {**result, "refresh_until":self.refresh_until}

    async def reset(self):
        async with self._control_lock:
            await self.close()
            async with self._lock:
                selected = [item for item in await self.repository.list_spaces() if item.id.startswith(PREFIX) and item.internal_state!="UNKNOWN"]
                for item in selected:
                    item = item.model_copy(update={"internal_state":"UNKNOWN", "version":item.version+1, "freshness":None, "status_label":"Availability unknown"})
                    await self.repository.upsert("spaces",item)
                    await self._publish("space.expired",item)
                return {"retired":len(selected)}
