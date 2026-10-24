"""
Claude Vision sign interpreter.

Takes a cropped sign image, sends to Claude Vision API,
returns structured parking rules.
"""

import base64
import anthropic

_client = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY env var
    return _client


def read_sign(image_bytes: bytes) -> dict:
    """
    Send cropped sign image to Claude Vision.

    Returns:
        {
            "summary": "2hr parking Mon-Sat 8am-6pm, metered $2/hr",
            "price": "$2/hr" | null,
            "max_duration_min": 120 | null,
            "hours": "Mon-Sat 8am-6pm" | null,
            "restrictions": ["no parking Sunday", "street cleaning Thu 10am-12pm"],
            "raw_text": "the literal text on the sign"
        }
    """
    client = get_client()
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    response = client.messages.create(
        model="claude-sonnet-4-6-20250514",
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
                    {
                        "type": "text",
                        "text": (
                            "This is a photo of a parking sign. Read every line of text "
                            "and return a JSON object with these fields:\n"
                            '- "summary": plain English one-liner of the rules\n'
                            '- "price": hourly price or null if free\n'
                            '- "max_duration_min": max parking minutes or null\n'
                            '- "hours": when rules apply\n'
                            '- "restrictions": array of special restrictions\n'
                            '- "raw_text": exact text on the sign\n'
                            "Return ONLY the JSON, no markdown."
                        ),
                    },
                ],
            }
        ],
    )

    import json
    try:
        return json.loads(response.content[0].text)
    except (json.JSONDecodeError, IndexError):
        return {
            "summary": response.content[0].text,
            "price": None,
            "max_duration_min": None,
            "hours": None,
            "restrictions": [],
            "raw_text": response.content[0].text,
        }
