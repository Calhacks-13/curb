"""
WebSocket endpoint for dashcam frame streaming.

Protocol (interleaved text + binary):
  1. Client sends text JSON (WSMetadata: lat, lng, heading, speed, timestamp)
  2. Client sends binary (JPEG frame bytes)
  3. Server responds text JSON (FrameResult or {"status": "skipped"})
"""

import uuid
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.models import WSMetadata
from app.cv.frame_selector import FrameSelector
from app.cv.pipeline import get_pipeline

router = APIRouter()
_frame_selector = FrameSelector()
viewers: set[WebSocket] = set()


@router.websocket("/ws/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    session_id = str(uuid.uuid4())

    try:
        while True:
            # 1. Receive metadata (text)
            meta_raw = await ws.receive_text()
            metadata = WSMetadata.model_validate_json(meta_raw)

            # 2. Receive frame (binary)
            frame_bytes = await ws.receive_bytes()

            # 3. Frame selection
            if not _frame_selector.should_process(session_id, frame_bytes):
                await ws.send_text(json.dumps({"status": "skipped"}))
                continue

            # 4. Process
            pipeline = get_pipeline()
            result = await pipeline.process_frame(
                image_bytes=frame_bytes,
                lat=metadata.lat,
                lng=metadata.lng,
                session_id=session_id,
                camera_pitch=metadata.camera_pitch,
                heading=metadata.heading,
                hfov=metadata.hfov,
            )

            # 5. Respond
            response = result["frame_result"].model_dump(mode="json")
            if result["confirmed_block"]:
                response["confirmed_block"] = result["confirmed_block"].model_dump(
                    mode="json"
                )
            response_json = json.dumps(response)
            await ws.send_text(response_json)

            # 6. Relay to viewers
            if viewers:
                dead = []
                for v in viewers:
                    try:
                        await v.send_bytes(frame_bytes)
                        await v.send_text(response_json)
                    except Exception:
                        dead.append(v)
                for v in dead:
                    viewers.discard(v)

    except WebSocketDisconnect:
        pass
    finally:
        _frame_selector.cleanup_session(session_id)
        get_pipeline().cleanup_session(session_id)


@router.websocket("/ws/viewer")
async def viewer(ws: WebSocket):
    await ws.accept()
    viewers.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        viewers.discard(ws)
