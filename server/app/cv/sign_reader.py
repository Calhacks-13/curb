"""
Claude Vision sign interpreter.

Async client with confidence scoring. Takes a cropped sign image,
sends to Claude Vision API, returns structured SignRules.
"""

import base64
import json
import anthropic

from app.config import settings
from app.models import SignRules

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
            model="claude-sonnet-4-20250514",
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


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None
