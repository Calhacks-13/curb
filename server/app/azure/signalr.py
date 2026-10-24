"""
Azure SignalR / Web PubSub publisher (serverless REST mode).

Two transports:
  - SignalR: legacy web client (broadcast_block / broadcast_block_expired)
  - Web PubSub: mobile app realtime (get_client_url / broadcast_realtime_event)

Graceful fallback: if connection strings are empty, all operations are no-ops.
"""

import hashlib
import hmac
import base64
import json
import time
import logging
from collections import deque
from datetime import datetime, timezone
from urllib.parse import quote

import httpx

from app.config import settings
from app.models import BlockObservation

logger = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None

# In-memory event ring buffer — always populated regardless of Web PubSub.
# Enables local-demo fallback: phones can poll /v1/realtime/events instead.
_event_log: deque[dict] = deque(maxlen=500)
_event_seq: int = 0


# ---------- shared ----------

def _is_configured() -> bool:
    return bool(settings.signalr_connection_string) or bool(settings.webpubsub_connection_string)


def _parse_connection_string(conn_str: str) -> dict:
    """Parse Azure-style connection strings (Key=Value;Key2=Value2;...).

    Uses split("=", 1) so base64 AccessKeys with trailing '==' padding
    are preserved intact — do NOT change to split("=") or similar.
    """
    parts = {}
    for segment in conn_str.split(";"):
        if "=" in segment:
            key, value = segment.split("=", 1)
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


# ---------- SignalR (legacy web client) ----------

async def broadcast_block(observation: BlockObservation) -> None:
    if _client is None or not settings.signalr_connection_string:
        return
    conn = _parse_connection_string(settings.signalr_connection_string)
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
        pass


async def broadcast_block_expired(segment_id: str) -> None:
    if _client is None or not settings.signalr_connection_string:
        return
    conn = _parse_connection_string(settings.signalr_connection_string)
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


# ---------- Web PubSub (mobile app) ----------

def _webpubsub_configured() -> bool:
    return bool(settings.webpubsub_connection_string)


def _generate_webpubsub_jwt(endpoint: str, key_bytes: bytes, hub: str, user_id: str = "", ttl_sec: int = 3600) -> str:
    """Generate a JWT for Web PubSub client access (no PyJWT dependency)."""
    audience = f"{endpoint}/client/hubs/{hub}"
    now = int(time.time())

    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"aud": audience, "iat": now, "exp": now + ttl_sec}
    if user_id:
        payload["sub"] = user_id

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    h = b64url(json.dumps(header, separators=(",", ":")).encode())
    p = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(key_bytes, f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{b64url(sig)}"


async def get_client_url(user_id: str = "mobile") -> str | None:
    """Generate a Web PubSub client WebSocket URL with JWT auth token."""
    if not _webpubsub_configured():
        return None

    conn = _parse_connection_string(settings.webpubsub_connection_string)
    endpoint = conn.get("Endpoint", "").rstrip("/")
    key_str = conn.get("AccessKey", "")
    if not endpoint or not key_str:
        return None

    key_bytes = base64.b64decode(key_str)
    hub = settings.webpubsub_hub
    token = _generate_webpubsub_jwt(endpoint, key_bytes, hub, user_id)

    # Convert https:// to wss://
    ws_endpoint = endpoint.replace("https://", "wss://").replace("http://", "ws://")
    return f"{ws_endpoint}/client/hubs/{hub}?access_token={token}"


def get_recent_events(since_seq: int = 0) -> list[dict]:
    """Return events with seq > since_seq. Used by the local-demo poll endpoint."""
    return [e for e in _event_log if e["seq"] > since_seq]


async def broadcast_realtime_event(
    event_type: str,
    entity_id: str,
    payload: dict,
    entity_version: int = 1,
) -> None:
    """Broadcast a RealtimeEvent to Web PubSub clients + in-memory log."""
    global _event_seq
    _event_seq += 1
    event = {
        "type": event_type,
        "entity_id": entity_id,
        "entity_version": entity_version,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
        "seq": _event_seq,
    }

    # Always store in-memory so local-demo polling works
    _event_log.append(event)

    # Push to Web PubSub if configured
    if _client and _webpubsub_configured():
        conn = _parse_connection_string(settings.webpubsub_connection_string)
        endpoint = conn.get("Endpoint", "").rstrip("/")
        key_str = conn.get("AccessKey", "")
        if endpoint and key_str:
            hub = settings.webpubsub_hub
            url = f"{endpoint}/api/hubs/{quote(hub)}/:send?api-version=2024-01-01"
            key_bytes = base64.b64decode(key_str)
            token = _generate_webpubsub_jwt(endpoint, key_bytes, hub, ttl_sec=60)
            try:
                await _client.post(
                    url,
                    json=event,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {token}",
                    },
                    timeout=5.0,
                )
            except httpx.HTTPError:
                logger.debug("Web PubSub broadcast failed", exc_info=True)
