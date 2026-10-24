"""
Pre-cache sign readings for demo blocks.

Usage:
    python -m scripts.seed_signs ./demo_signs/

Reads all .jpg/.png files from the given directory.
If filenames contain GPS (e.g. 37.7749_-122.4194_sign.jpg), uses that.
Otherwise falls back to 0,0.
Runs Claude Vision on each, upserts to Cosmos (or in-memory if unconfigured).
"""

import asyncio
import re
import sys
from pathlib import Path

from app.azure import cosmos
from app.cv.sign_reader import read_sign, close_client
from app.cv.pipeline import _snap_to_grid


GPS_PATTERN = re.compile(r"(-?\d+\.\d+)_(-?\d+\.\d+)")


def extract_gps(filename: str) -> tuple[float, float]:
    m = GPS_PATTERN.search(filename)
    if m:
        return float(m.group(1)), float(m.group(2))
    return 0.0, 0.0


async def main(sign_dir: str) -> None:
    await cosmos.init()

    p = Path(sign_dir)
    files = sorted(p.glob("*.jpg")) + sorted(p.glob("*.png"))
    if not files:
        print(f"No .jpg/.png files found in {sign_dir}")
        return

    print(f"Found {len(files)} sign images")

    for f in files:
        lat, lng = extract_gps(f.stem)
        grid_key = _snap_to_grid(lat, lng)
        print(f"  {f.name} -> grid_key={grid_key} ({lat}, {lng})")

        image_bytes = f.read_bytes()
        rules = await read_sign(image_bytes)
        print(f"    summary: {rules.summary}")
        print(f"    confidence: {rules.confidence_score}")

        await cosmos.upsert_sign(grid_key, rules, lat=lat, lng=lng)
        print(f"    upserted to store")

    await close_client()
    await cosmos.close()
    print("Done.")


if __name__ == "__main__":
    sign_dir = sys.argv[1] if len(sys.argv) > 1 else "./demo_signs"
    asyncio.run(main(sign_dir))
