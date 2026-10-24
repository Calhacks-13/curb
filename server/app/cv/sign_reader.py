"""
Claude Vision sign interpreter.

Async client with confidence scoring. Takes a cropped sign image,
sends to Claude Vision API, returns structured SignRules or SignPoleReading.
"""

import base64
import json
import anthropic

from app.config import settings
from app.models import SignRules, SignPoleReading, SignReading

_client: anthropic.AsyncAnthropic | None = None

SIGN_PROMPT = (
    "This is a photo of a parking sign. Read every line of text "
    "and return a JSON object with these fields:\n"
    '- "summary": plain English one-liner of the rules\n'
    '- "price": hourly price or null if free\n'
    '- "max_duration_min": max parking minutes or null\n'
    '- "hours": when rules apply\n'
    '- "restrictions": array of special restrictions\n'
    '- "raw_text": exact text on the sign\n'
    "Return ONLY the JSON, no markdown."
)


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        kwargs = {}
        if settings.anthropic_api_key:
            kwargs["api_key"] = settings.anthropic_api_key
        _client = anthropic.AsyncAnthropic(**kwargs)
    return _client


async def read_sign(image_bytes: bytes) -> SignRules:
    """
    Send cropped sign image to Claude Vision.
    Returns SignRules with confidence scoring.
    """
    client = get_client()
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=512,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": SIGN_PROMPT},
                    ],
                }
            ],
        )
    except anthropic.APIError:
        return SignRules(
            summary="API error reading sign",
            confidence_score=0.0,
            flagged=True,
        )

    raw_text = response.content[0].text
    return _parse_and_score(raw_text)


def _parse_and_score(raw_text: str) -> SignRules:
    """Parse Claude response and compute confidence score."""
    try:
        data = json.loads(raw_text)
        json_parsed = True
    except json.JSONDecodeError:
        data = {}
        json_parsed = False

    rules = SignRules(
        summary=data.get("summary", raw_text),
        price=data.get("price"),
        max_duration_min=data.get("max_duration_min"),
        hours=data.get("hours"),
        restrictions=data.get("restrictions", []),
        raw_text=data.get("raw_text", raw_text),
    )

    # Confidence scoring: 0.0-1.0 based on completeness
    score = 0.0
    if json_parsed:
        score += 0.3
    if rules.summary and len(rules.summary) > 10:
        score += 0.2
    if rules.raw_text and rules.raw_text != rules.summary:
        score += 0.2
    if rules.hours:
        score += 0.15
    if rules.price or rules.max_duration_min:
        score += 0.15

    rules.confidence_score = round(score, 2)
    rules.flagged = score < settings.sign_read_confidence_threshold
    return rules


SIGN_POLE_PROMPT = (
    "This image shows one or more parking/traffic signs, possibly stacked on a single pole. "
    "For EACH individual sign visible, extract a JSON object with these fields:\n"
    '- "sign_type": one of "parking", "no_parking", "street_cleaning", "meter", '
    '"time_limit", "permit", "loading_zone", "other"\n'
    '- "raw_text": exact text on this sign\n'
    '- "hours": when this sign\'s rules apply (e.g. "Mon-Sat 8am-6pm") or null\n'
    '- "max_duration_min": max parking minutes or null\n'
    '- "price_per_hour": hourly price string or null\n'
    '- "permit_zone": permit zone identifier or null\n'
    '- "restrictions": array of special restrictions\n'
    '- "arrow_direction": "left", "right", "both", or null\n\n'
    "Then synthesize ALL signs into a combined rule set. Return a JSON object:\n"
    "{\n"
    '  "signs": [<array of individual sign objects above>],\n'
    '  "combined_summary": "<plain English one-liner of the combined parking rules>",\n'
    '  "combined_hours": "<when rules apply overall>",\n'
    '  "combined_max_duration_min": <int or null>,\n'
    '  "combined_price": "<price string or null>",\n'
    '  "combined_restrictions": [<merged restrictions>],\n'
    '  "arrow_direction": "<left/right/both/null>"\n'
    "}\n"
    "Return ONLY the JSON, no markdown."
)


async def read_sign_pole(image_bytes: bytes) -> SignPoleReading:
    """
    Send cropped pole image (one or more signs) to Claude Vision.
    Returns SignPoleReading with per-sign structured rules.
    """
    client = get_client()
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": b64,
                            },
                        },
                        {"type": "text", "text": SIGN_POLE_PROMPT},
                    ],
                }
            ],
        )
    except anthropic.APIError:
        return SignPoleReading(
            combined_summary="API error reading sign pole",
            confidence_score=0.0,
            flagged=True,
        )

    raw_text = response.content[0].text
    return _parse_pole_reading(raw_text)


def _parse_pole_reading(raw_text: str) -> SignPoleReading:
    """Parse Claude response into SignPoleReading with confidence scoring."""
    try:
        data = json.loads(raw_text)
        json_parsed = True
    except json.JSONDecodeError:
        data = {}
        json_parsed = False

    signs = []
    for s in data.get("signs", []):
        signs.append(SignReading(
            sign_type=s.get("sign_type", "other"),
            raw_text=s.get("raw_text", ""),
            hours=s.get("hours"),
            max_duration_min=s.get("max_duration_min"),
            price_per_hour=s.get("price_per_hour"),
            permit_zone=s.get("permit_zone"),
            restrictions=s.get("restrictions", []),
            arrow_direction=s.get("arrow_direction"),
        ))

    reading = SignPoleReading(
        signs=signs,
        combined_summary=data.get("combined_summary", raw_text[:200] if not json_parsed else ""),
        combined_hours=data.get("combined_hours"),
        combined_max_duration_min=data.get("combined_max_duration_min"),
        combined_price=data.get("combined_price"),
        combined_restrictions=data.get("combined_restrictions", []),
        arrow_direction=data.get("arrow_direction"),
    )

    # Confidence scoring
    score = 0.0
    if json_parsed:
        score += 0.3
    if signs:
        score += 0.2
    if reading.combined_summary and len(reading.combined_summary) > 10:
        score += 0.2
    if reading.combined_hours:
        score += 0.15
    if reading.combined_price or reading.combined_max_duration_min:
        score += 0.15

    reading.confidence_score = round(score, 2)
    reading.flagged = score < settings.sign_read_confidence_threshold
    return reading


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None
