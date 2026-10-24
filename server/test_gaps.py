"""
Smoke test for gap detection + tracking pipeline.
Tests the tracker with synthetic, precomputed detections.
End-to-end pipeline checks live in tests/cv/test_detection_pipeline.py.

Run from server/: python test_gaps.py
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(__file__))

from app.config import settings
from app.cv.tracker import VehicleTracker, GapTracker, Track


def test_vehicle_tracker():
    print("=" * 50)
    print("VEHICLE TRACKER")
    print("=" * 50)

    tracker = VehicleTracker()

    # Frame 1: two cars with a gap between them
    dets = [
        {"bbox": [50, 200, 250, 500], "cls": "car", "confidence": 0.9},
        {"bbox": [500, 200, 700, 500], "cls": "car", "confidence": 0.85},
    ]
    confirmed = tracker.update(dets)
    print(f"  Frame 1: {len(dets)} detections, {len(confirmed)} confirmed tracks")

    # Frame 2: same cars, slightly shifted (IoU match)
    dets2 = [
        {"bbox": [55, 200, 255, 500], "cls": "car", "confidence": 0.91},
        {"bbox": [505, 200, 705, 500], "cls": "car", "confidence": 0.86},
    ]
    confirmed = tracker.update(dets2)
    print(f"  Frame 2: {len(confirmed)} confirmed tracks (need {settings.track_confirm_hits} hits)")

    for t in confirmed:
        print(f"    Track T{t.id}: {t.cls} conf={t.confidence:.2f} hits={t.hits}")

    assert len(confirmed) == 2, f"Expected 2 confirmed tracks, got {len(confirmed)}"
    print("  PASSED")
    return True


def test_gap_tracker():
    print("\n" + "=" * 50)
    print("GAP TRACKER (2s confirmation)")
    print("=" * 50)

    vt = VehicleTracker()
    gt = GapTracker()

    frame_w, frame_h = 1280, 720

    # Simulate vehicles with a gap between them
    car_left = {"bbox": [50, 200, 300, 500], "cls": "car", "confidence": 0.9}
    car_right = {"bbox": [600, 200, 900, 500], "cls": "car", "confidence": 0.85}

    print(f"  Gap between cars: x={300} to x={600} = {300}px")
    print(f"  Min gap threshold: {frame_w * settings.min_gap_fraction:.0f}px ({settings.min_gap_fraction*100}% of {frame_w})")
    print(f"  Confirmation time: {settings.gap_confirm_sec}s")
    print()

    # Simulate frames over 3 seconds at ~2fps
    n_frames = 8
    frame_interval = 0.4  # 400ms between frames
    newly_confirmed_frame = None

    for i in range(n_frames):
        # Slight bbox jitter to simulate real tracking
        jitter = (i % 3) * 2
        dets = [
            {"bbox": [50+jitter, 200, 300+jitter, 500], "cls": "car", "confidence": 0.9},
            {"bbox": [600-jitter, 200, 900-jitter, 500], "cls": "car", "confidence": 0.85},
        ]
        confirmed_tracks = vt.update(dets)
        all_gaps, newly_confirmed, expired = gt.update(confirmed_tracks, frame_w, frame_h)

        elapsed = i * frame_interval
        gap_str = ""
        for g in all_gaps:
            is_conf = g.gap_key in gt._confirmed
            gap_str += f" T{g.left_track_id}-T{g.right_track_id}:{g.duration:.1f}s{'*' if is_conf else ''}"

        status = "CONFIRMED!" if newly_confirmed else "tracking"
        print(f"  Frame {i+1} (t={elapsed:.1f}s): {len(confirmed_tracks)} tracks, "
              f"{len(all_gaps)} gaps{gap_str} [{status}]")

        if newly_confirmed and newly_confirmed_frame is None:
            newly_confirmed_frame = i + 1
            for g in newly_confirmed:
                print(f"    >>> GAP CONFIRMED: T{g.left_track_id}-T{g.right_track_id} "
                      f"duration={g.duration:.1f}s width={g.median_width_meters}")

        # Simulate real time passing
        time.sleep(frame_interval)

    assert newly_confirmed_frame is not None, "Gap was never confirmed!"
    print(f"\n  Gap confirmed on frame {newly_confirmed_frame}")
    print("  PASSED")
    return True


def test_gap_expire():
    print("\n" + "=" * 50)
    print("GAP EXPIRY (car fills gap -> space.occupied)")
    print("=" * 50)

    vt = VehicleTracker()
    gt = GapTracker()
    frame_w, frame_h = 1280, 720

    # Build up a confirmed gap
    for _ in range(8):
        dets = [
            {"bbox": [50, 200, 300, 500], "cls": "car", "confidence": 0.9},
            {"bbox": [600, 200, 900, 500], "cls": "car", "confidence": 0.85},
        ]
        confirmed_tracks = vt.update(dets)
        gt.update(confirmed_tracks, frame_w, frame_h)
        time.sleep(0.4)

    print(f"  Confirmed gaps: {len(gt._confirmed)}")
    assert len(gt._confirmed) > 0, "No gaps were confirmed"

    # Now a third car parks in the gap
    print("  Car parks in gap...")
    for i in range(5):
        dets = [
            {"bbox": [50, 200, 300, 500], "cls": "car", "confidence": 0.9},
            {"bbox": [350, 200, 550, 500], "cls": "car", "confidence": 0.8},  # new car!
            {"bbox": [600, 200, 900, 500], "cls": "car", "confidence": 0.85},
        ]
        confirmed_tracks = vt.update(dets)
        all_gaps, newly_confirmed, expired = gt.update(confirmed_tracks, frame_w, frame_h)

        if expired:
            for g in expired:
                print(f"    >>> GAP EXPIRED (occupied): T{g.left_track_id}-T{g.right_track_id}")
            break
        time.sleep(0.4)

    print(f"  Remaining confirmed gaps: {len(gt._confirmed)}")
    print("  PASSED")
    return True


def main():
    print("\nCurb Gap Pipeline Smoke Tests")
    print(f"Settings: min_gap_fraction={settings.min_gap_fraction}, "
          f"gap_confirm_sec={settings.gap_confirm_sec}s, "
          f"gap_expire_sec={settings.gap_expire_sec}s")
    print()

    r1 = test_vehicle_tracker()
    r2 = test_gap_tracker()
    r3 = test_gap_expire()

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"  Vehicle tracker:    {'PASS' if r1 else 'FAIL'}")
    print(f"  Gap confirmation:   {'PASS' if r2 else 'FAIL'}")
    print(f"  Gap expiry:         {'PASS' if r3 else 'FAIL'}")
    print()


if __name__ == "__main__":
    main()
