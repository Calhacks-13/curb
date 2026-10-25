import asyncio
import json
from collections import deque
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.azure import cosmos, signalr
from app.cv.pipeline import Pipeline, SignDeduplicator
from app.cv.sign_reader import _parse_pole_reading
from app.cv.tracker import TrackedGap
from app.domain.sign_rules import assess_reading, evaluate_rule_text, has_curb_evidence, rule_text
from app.models.cv import SignDetection, SignDocument, SignPoleReading, SignReading
from app.models.cv import SpotDocument
from app.repositories.memory import InMemoryParkingRepository

TEXT = "NO PARKING 11 AM TO 1 PM ON THE 3RD TUESDAY OF THE MONTH STREET CLEANING"
LA = ZoneInfo("America/Los_Angeles")


def parking_reading():
    return SignPoleReading(
        signs=[SignReading(sign_type="no_parking", raw_text=TEXT, hours="11am-1pm on the 3rd Tuesday of the month")],
        combined_summary="No parking from 11am to 1pm on the 3rd Tuesday of each month due to street cleaning.",
        combined_hours="11am-1pm on the 3rd Tuesday of the month", confidence_score=0.85,
    )


def street_reading():
    return SignPoleReading(signs=[SignReading(sign_type="directional", raw_text="LYON")],
                           combined_summary="Street name sign indicating Lyon Street.", confidence_score=0.7)


@pytest.fixture
def memory(monkeypatch):
    monkeypatch.setattr(cosmos, "_use_memory", True)
    for name in ["_mem_spots", "_mem_signs", "_mem_blocks"]:
        monkeypatch.setattr(cosmos, name, {})
    monkeypatch.setattr(signalr, "_client", None)
    monkeypatch.setattr(signalr, "_event_log", deque(maxlen=500))
    monkeypatch.setattr(signalr, "_event_seq", 0)


@pytest.mark.parametrize("category,kind", [("street", "directional"), ("garage", "directional"), ("street", "parking")])
def test_street_name_never_becomes_a_curb_rule_or_garage(category, kind):
    data = street_reading().model_dump()
    data["sign_category"] = category
    data["signs"][0]["sign_type"] = kind
    parsed = _parse_pole_reading(json.dumps(data))
    assert parsed.sign_category == "informational"
    assert not has_curb_evidence(parsed)


def test_dark_illegible_reading_cannot_pass_on_json_completeness():
    parsed = _parse_pole_reading(json.dumps({
        "combined_summary": "Sign text is not legible due to very low image quality and darkness.",
        "signs": [{"sign_type": "other", "raw_text": "[text illegible due to image quality]"}],
        "sign_category": "street",
    }))
    assert parsed.flagged is True
    assert parsed.confidence_score <= 0.25
    assert parsed.sign_category == "unreadable"
    assert not has_curb_evidence(parsed)


@pytest.mark.parametrize("raw", ['[]', 'null', '{"signs":4}', '{"signs":[4]}', '{broken'])
def test_bad_reader_output_is_flagged_instead_of_crashing(raw):
    parsed = _parse_pole_reading(raw)
    assert parsed.flagged
    assert not has_curb_evidence(parsed)


@pytest.mark.parametrize("local,status", [
    ((2026, 11, 17, 10, 59), "LEGAL"), ((2026, 11, 17, 11, 0), "ILLEGAL"),
    ((2026, 11, 17, 12, 59), "ILLEGAL"), ((2026, 11, 17, 13, 0), "LEGAL"),
    ((2026, 11, 10, 11, 30), "LEGAL"), ((2026, 11, 24, 11, 30), "LEGAL"),
    ((2026, 10, 20, 11, 30), "ILLEGAL"),  # daylight-saving offset differs
])
def test_recorded_street_cleaning_rule_respects_clock_monthly_ordinal_and_timezone(local, status):
    now = datetime(*local, tzinfo=LA).astimezone(UTC)
    result, change = evaluate_rule_text(rule_text(parking_reading()), now)
    assert result == status
    assert change is not None and change > now


@pytest.mark.parametrize("text", [
    "No parking 11-1pm", "No parking except holidays 11am-1pm",
    "No parking on the last Tuesday 11am-1pm", "Parking permit zone R",
    "No parking on the 1st and 3rd Tuesday 11am-1pm",
    "Street name sign indicating Lyon Street.", "No validated parking sign read for this curb.",
])
def test_unsupported_or_nonparking_text_stays_unknown(text):
    assert evaluate_rule_text(text)[0] == "UNKNOWN"


def test_overnight_weekly_window_uses_previous_days_restriction():
    text = "NO PARKING MONDAY 10PM-2AM"
    assert evaluate_rule_text(text, datetime(2026, 11, 17, 1, tzinfo=LA))[0] == "ILLEGAL"
    assert evaluate_rule_text(text, datetime(2026, 11, 17, 3, tzinfo=LA))[0] == "LEGAL"


@pytest.mark.asyncio
async def test_nearest_street_name_or_illegible_doc_cannot_override_real_parking_sign(memory):
    dedup = SignDeduplicator()
    for id, lat, reading in [
        ("street", 37.8, street_reading()),
        ("dark", 37.80001, SignPoleReading(signs=[SignReading(sign_type="other", raw_text="[illegible]")], confidence_score=0.7)),
        ("parking", 37.8001, parking_reading()),
    ]:
        document = SignDocument(id=id, road_segment_id="37.8,-122.44,E", lat=lat, lng=-122.44,
                                location={"type":"Point", "coordinates":[-122.44, lat]}, pole_reading=reading)
        dedup.register(document)
    result = await dedup.find_rules_for_segment("37.8,-122.44,E", 37.8, -122.44)
    assert result == parking_reading()


@pytest.mark.asyncio
async def test_each_sign_on_pole_is_read_and_nearby_cached_street_plate_is_not_reused(memory, monkeypatch):
    from app.cv import pipeline as module
    pipeline = Pipeline()
    calls = []
    async def read(crop):
        calls.append(crop)
        return street_reading() if crop == b"street" else parking_reading()
    monkeypatch.setattr(module, "read_sign_pole", read)
    # Same pole location and direction; location-only dedup previously reused this.
    pipeline._sign_dedup.register(SignDocument(id="old-name", road_segment_id="37.8,-122.4399,E",
        lat=37.8, lng=-122.4399, pole_reading=street_reading()))
    signs = [SignDetection(bbox=[480, 10, 520, 50], confidence=0.99, crop_bytes=b"street"),
             SignDetection(bbox=[480, 60, 520, 160], confidence=0.8, crop_bytes=b"parking")]
    for _ in range(3):
        result = await pipeline.process_detections(vehicles=[], signs=signs, frame_width=1000,
            frame_height=600, lat=37.8, lng=-122.44, heading=90, session_id="walk")
    assert set(calls) == {b"street", b"parking"}
    assert result["frame_result"].sign_rules == parking_reading()
    assert len(cosmos._mem_signs) == 1
    assert next(iter(cosmos._mem_signs.values()))["pole_reading"]["signs"][0]["raw_text"] == TEXT
    assert pipeline._sign_dedup._cache["old-name"].pole_reading == street_reading()


@pytest.mark.asyncio
async def test_poor_reading_retries_with_better_crop_without_persisting_garbage(memory, monkeypatch):
    from app.cv import pipeline as module
    calls = []
    async def read(crop):
        calls.append(crop)
        if crop == b"dark":
            return SignPoleReading(combined_summary="Text is illegible", signs=[SignReading(raw_text="[illegible]")], confidence_score=0.7)
        return parking_reading()
    monkeypatch.setattr(module, "read_sign_pole", read)
    pipeline = Pipeline()
    for frame in range(6):
        detection = SignDetection(bbox=[480, 60, 520, 120] if frame < 3 else [460, 30, 540, 150],
                                  confidence=0.6 if frame < 3 else 0.85, crop_bytes=b"dark" if frame < 3 else b"clear")
        result = await pipeline.process_detections(vehicles=[], signs=[detection], frame_width=1000,
            frame_height=600, lat=37.8, lng=-122.44, heading=90, session_id="walk")
        if frame == 2:
            assert result["frame_result"].sign_feedback[0]["state"] == "uncertain"
            assert cosmos._mem_signs == {}
    assert calls == [b"dark", b"clear"]
    assert result["frame_result"].sign_feedback[0]["state"] == "read"


@pytest.mark.asyncio
async def test_rule_correction_and_time_change_do_not_refresh_availability(memory):
    pipeline = Pipeline()
    repository = InMemoryParkingRepository()
    pipeline.set_repository(repository)
    spot = await pipeline._spot_mgr.open_spot("37.8,-122.44,E", 37.8, -122.44, TrackedGap(1, 2, [200, 0, 600, 600]), "walk")
    observed_at = spot.last_seen_at
    before = datetime(2026, 11, 17, 10, 59, tzinfo=LA)
    await pipeline._spot_mgr.update_rules(spot, parking_reading(), now=before)
    zone = await repository.get_zone(spot.segment_id)
    assert zone.legal_status_now == "LEGAL"
    rule = await repository.get_rule(zone.sign_rule_id)
    assert "11 AM TO 1 PM" in rule.evidence_text
    assert rule.weekly_schedule == []
    await pipeline._spot_mgr.refresh_rule_times(datetime(2026, 11, 17, 11, 0, tzinfo=LA))
    zone = await repository.get_zone(spot.segment_id)
    assert zone.legal_status_now == "ILLEGAL"
    assert spot.last_seen_at == observed_at
    assert spot.version == 3
    assert pipeline._spot_mgr.transitions[-1]["reason"] == "rule_time_window_changed"


@pytest.mark.asyncio
async def test_polling_events_remain_newer_than_pre_restart_small_cursor(memory, monkeypatch):
    monkeypatch.setattr(signalr, "_event_seq", 1_800_000_000_000_000)
    await signalr.broadcast_realtime_event("space.opened", "spot", {}, 1)
    events = signalr.get_recent_events(31)
    assert len(events) == 1
    assert 31 < events[0]["seq"] < 2 ** 53


@pytest.mark.asyncio
async def test_repair_replaces_wrong_street_rule_and_retires_duplicate_without_refreshing_sighting(memory):
    from app.domain.scan_state import persist_spot
    from scripts.repair_scan_rules import repair_scan_rules
    from app.models.domain import InternalSpaceState
    repository = InMemoryParkingRepository()
    segment = "37.8,-122.44,E"
    for id, reading in [("street", street_reading()), ("parking", parking_reading())]:
        await cosmos.upsert_sign_document(SignDocument(id=id, road_segment_id=segment,
            lat=37.8, lng=-122.44, pole_reading=reading))
    observed = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=20)
    spot = SpotDocument(id="real-spot", segment_id=segment, lat=37.8, lng=-122.44,
        location={"type":"Point", "coordinates":[-122.44,37.8]}, sign_rules=street_reading(),
        last_seen_at=observed, version=2)
    await cosmos.upsert_spot(spot)
    await persist_spot(repository, spot)
    current = await repository.get_space(spot.id)
    await repository.upsert("spaces", current.model_copy(update={"id":segment}))
    counts = await repair_scan_rules(repository, 37.8, -122.44, 100)
    assert counts == {"signs_normalized": 1, "spaces_repaired": 1, "aliases_retired": 1, "skipped": 0}
    repaired = await repository.get_space(spot.id)
    assert repaired.last_observed_at.replace(tzinfo=None) == observed
    assert repaired.version == 3
    rule = await repository.get_rule((await repository.get_zone(segment)).sign_rule_id)
    assert "11 AM TO 1 PM" in rule.evidence_text
    assert rule.weekly_schedule == []
    assert (await repository.get_space(segment)).internal_state == InternalSpaceState.UNKNOWN
    again = await repair_scan_rules(repository, 37.8, -122.44, 100)
    assert all(value == 0 for value in again.values())


@pytest.mark.asyncio
async def test_nearby_queries_re_evaluate_the_recorded_time_window(memory):
    from app.domain.parking import ParkingService
    from app.domain.scan_state import persist_spot
    from app.models.domain import GeoPoint
    repository = InMemoryParkingRepository()
    before = datetime(2026, 11, 17, 10, 59, tzinfo=LA).astimezone(UTC)
    spot = SpotDocument(id="spot", segment_id="37.8,-122.44,E", lat=37.8, lng=-122.44,
        location={"type":"Point", "coordinates":[-122.44,37.8]}, confidence=0.9,
        last_seen_at=before.replace(tzinfo=None), sign_rules=parking_reading())
    await persist_spot(repository, spot, before)
    origin = GeoPoint(type="Point", coordinates=(-122.44,37.8))
    service = ParkingService(repository)
    allowed = await service.nearby(origin, 804.672, before)
    restricted = await service.nearby(origin, 804.672, before + timedelta(minutes=1))
    assert [space.id for space in allowed.spaces] == ["spot"]
    assert restricted.spaces == []
    assert restricted.zones[0].legal_status_now == "ILLEGAL"
    detail = await service.detail("spot", before)
    assert detail.current_rules == parking_reading().combined_summary
    assert "11 AM TO 1 PM" in detail.sign_rule.evidence_text
    assert detail.next_change_at == before + timedelta(minutes=1)


@pytest.mark.asyncio
async def test_rules_here_ignores_street_names_and_never_falls_back_to_opposite_curb(memory, monkeypatch):
    from app.routes.signs import rules_here, _evaluate_parking_now
    documents = [
        SignDocument(id="name", lat=37.8, lng=-122.44, road_segment_id="37.8,-122.44,E", pole_reading=street_reading()),
        SignDocument(id="parking", lat=37.8001, lng=-122.44, road_segment_id="37.8,-122.44,W", pole_reading=parking_reading()),
    ]
    for doc in documents:
        await cosmos.upsert_sign_document(doc)
    result = await rules_here(lat=37.8, lng=-122.44, heading=90, radius_m=50)
    assert result["rules"] is None
    assert result["signs_found"] == 0
    assert _evaluate_parking_now(parking_reading().model_dump(), datetime(2026,11,17,11,30,tzinfo=LA)) is False
    assert _evaluate_parking_now(parking_reading().model_dump(), datetime(2026,11,17,13,30,tzinfo=LA)) is True


def test_fenced_ocr_json_is_parsed_without_exposing_json_as_a_rule():
    reading = _parse_pole_reading("```json\n" + parking_reading().model_dump_json() + "\n```")
    assert has_curb_evidence(reading)
    assert reading.signs[0].raw_text == TEXT
    assert "```" not in _parse_pole_reading("```json\n{broken").combined_summary
