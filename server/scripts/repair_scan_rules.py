"""Repair scanner rules in an explicitly selected test area; preserve sightings.

Run from server/: PYTHONPATH=. .venv/bin/python scripts/repair_scan_rules.py
  --lat 37.8043 --lng -122.4484 --radius-m 100
No new OCR calls are made, and sign text/observation dates are retained.
"""
import argparse
import asyncio
import json

from app.azure import cosmos
from app.config import settings
from app.cv.pipeline import SignDeduplicator
from app.cv.sign_localizer import _haversine_m
from app.domain.scan_state import persist_spot
from app.domain.sign_rules import assess_reading, evaluate_rule_text, rule_text, rule_summary
from app.models.cv import SignDocument, SpotDocument
from app.models.domain import InternalSpaceState
from app.repositories.cosmos import CosmosParkingRepository


async def repair_scan_rules(repository, lat: float, lng: float, radius_m: float):
    counts = {"signs_normalized": 0, "spaces_repaired": 0, "aliases_retired": 0, "skipped": 0}
    dedup = SignDeduplicator()
    for raw in await cosmos.query_signs_nearby(lat, lng, radius_m):
        if not raw.get("pole_reading"):
            continue
        doc = SignDocument.model_validate(raw)
        assessed = assess_reading(doc.pole_reading)
        if assessed != doc.pole_reading:
            doc.pole_reading = assessed
            await cosmos.upsert_sign_document(doc)
            counts["signs_normalized"] += 1
        dedup.register(doc)

    for space in await repository.list_spaces():
        slng, slat = space.location.coordinates
        if _haversine_m(lat, lng, slat, slng) > radius_m:
            continue
        zone = await repository.get_zone(space.zone_id)
        if zone is None or not zone.sign_rule_id or not zone.sign_rule_id.startswith("scan-rule:"):
            continue
        raw = await cosmos.get_spot_by_segment(space.zone_id)
        if raw is None:
            counts["skipped"] += 1
            continue
        if raw["id"] != space.id:
            # Older scanner responses used segment IDs while realtime used spot
            # IDs. Retire the alias without rewriting its observation date.
            if space.internal_state != InternalSpaceState.UNKNOWN:
                await repository.upsert("spaces", space.model_copy(update={
                    "internal_state": InternalSpaceState.UNKNOWN, "version": space.version + 1,
                }))
                counts["aliases_retired"] += 1
            continue
        spot = SpotDocument.model_validate(raw)
        resolved = await dedup.find_rules_for_segment(spot.segment_id, spot.lat, spot.lng)
        rule = await repository.get_rule(zone.sign_rule_id)
        status, next_change = evaluate_rule_text(rule_text(resolved))
        if (resolved == spot.sign_rules and rule is not None and rule.evidence_text == rule_text(resolved)
                and rule.interpretation_confidence == (resolved.confidence_score if resolved else 0)
                and zone.current_rules == rule_summary(resolved)
                and zone.legal_status_now == status
                and not (next_change is not None and rule.weekly_schedule)):
            continue
        spot.sign_rules = resolved
        spot.version = max(spot.version, space.version) + 1
        spot.last_transition_reason = "stored_sign_rule_repaired"
        await cosmos.upsert_spot(spot)
        await persist_spot(repository, spot)
        counts["spaces_repaired"] += 1
    return counts


async def main(args):
    repository = await CosmosParkingRepository.connect(settings.cosmos_endpoint, settings.cosmos_key, settings.cosmos_database)
    try:
        await cosmos.init()
        print(json.dumps(await repair_scan_rules(repository, args.lat, args.lng, args.radius_m)))
    finally:
        await cosmos.close()
        await repository.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lng", type=float, required=True)
    parser.add_argument("--radius-m", type=float, default=100)
    asyncio.run(main(parser.parse_args()))
