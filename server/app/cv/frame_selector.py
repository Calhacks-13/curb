"""
Frame rate limiter.

Caps processing to target_fps. Every accepted frame is processed —
no similarity filtering, since the tracker needs temporal continuity.
"""

import time

from app.config import settings


class FrameSelector:
    def __init__(self):
        self._last_time: dict[str, float] = {}

    def should_process(self, session_id: str, image_bytes: bytes) -> bool:
        now = time.monotonic()
        min_interval = 1.0 / settings.target_fps

        if session_id in self._last_time:
            if now - self._last_time[session_id] < min_interval:
                return False

        self._last_time[session_id] = now
        return True

    def cleanup_session(self, session_id: str) -> None:
        self._last_time.pop(session_id, None)
