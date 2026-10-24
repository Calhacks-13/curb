"""
Azure SignalR / Web PubSub publisher (serverless REST mode).

Graceful fallback: if connection string is empty, all operations are no-ops.
"""

import httpx

from app.config import settings
from app.models import BlockObservation

_client: httpx.AsyncClient | None = None


def _is_configured() -> bool:
    return bool(settings.signalr_connection_string)


def _parse_connection_string() -> dict:
    parts = {}
    for segment in settings.signalr_connection_string.split(";"):
        if "=" in segment:
            key, _, value = segment.partition("=")
            parts[key.strip()] = value.strip()
    return parts


async def init() -> None:
    global _client
    if not _is_configured():
        return
    _client = httpx.AsyncClient()


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def broadcast_block(observation: BlockObservation) -> None:
    if _client is None:
        return
    conn = _parse_connection_string()
    endpoint = conn.get("Endpoint", "")
    key = conn.get("AccessKey", "")
    if not endpoint or not key:
        return

    url = f"{endpoint}/api/v1/hubs/{settings.signalr_hub}"
    payload = {
        "target": "spotUpdate",
        "arguments": [observation.model_dump(mode="json")],
    }
    try:
        await _client.post(
            url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            timeout=5.0,
        )
    except httpx.HTTPError:
        pass  # Best-effort broadcast


async def broadcast_block_expired(segment_id: str) -> None:
    if _client is None:
        return
    conn = _parse_connection_string()
    endpoint = conn.get("Endpoint", "")
    key = conn.get("AccessKey", "")
    if not endpoint or not key:
        return

    url = f"{endpoint}/api/v1/hubs/{settings.signalr_hub}"
    payload = {
        "target": "spotExpired",
        "arguments": [{"segment_id": segment_id}],
    }
    try:
        await _client.post(
            url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            timeout=5.0,
        )
    except httpx.HTTPError:
        pass
