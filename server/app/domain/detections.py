"""Validated JSON boundary for detections produced by a phone camera."""

import base64
import binascii
from datetime import datetime
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, RootModel, field_validator, model_validator

from app.models.cv import SignDetection, VehicleDetection


FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Confidence = Annotated[FiniteNumber, Field(ge=0, le=1)]

# Conservative post-NMS street-scene budgets bound tracker matching and crop work.
# Frame ceilings allow hardware to exceed VisionCamera's 1280×720 *target*.
MAX_VEHICLES = 64
MAX_SIGNS = 16
MAX_CROP_BYTES = 256 * 1024
MAX_CROP_ENCODED = 4 * ((MAX_CROP_BYTES + 2) // 3)
MAX_TOTAL_CROP_BYTES = 1024 * 1024
# Allow independent base64 padding for all 16 crops, then check exact decoded sum.
MAX_TOTAL_CROP_ENCODED = 4 * ((MAX_TOTAL_CROP_BYTES + 2) // 3) + 4 * MAX_SIGNS
MAX_FRAME_AXIS = 4096
MAX_FRAME_PIXELS = 16_000_000
MAX_CROP_AXIS = 2048
MAX_CROP_PIXELS = 4_000_000


def validate_jpeg(data: bytes) -> None:
    """Bounded structural validation of self-contained 8-bit JPEGs, without decoding pixels.

    Check common 8-bit Huffman JPEG structure, including CoreImage output.
    Walk segments and entropy scan boundaries; never trust a header offset.
    This checks framing/tables/dimensions, not entropy-code or visual correctness.
    """
    error = "crop_b64 must contain a complete JPEG with bounded positive dimensions"
    if not data.startswith(b"\xff\xd8"):
        raise ValueError(error)
    pos = 2
    components = set()
    quantization_tables = set()
    huffman_tables = set()
    frame_quantization = set()
    saw_scan = False
    while pos < len(data):
        if data[pos] != 0xFF:
            raise ValueError(error)
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            raise ValueError(error)
        marker = data[pos]
        pos += 1
        if marker == 0xD9:
            if not saw_scan or pos != len(data):
                raise ValueError(error)
            return
        if marker not in {0xC0, 0xC1, 0xC2, 0xC4, 0xDA, 0xDB, 0xDD, 0xFE, *range(0xE0, 0xF0)}:
            raise ValueError(error)
        if pos + 2 > len(data):
            raise ValueError(error)
        length = int.from_bytes(data[pos:pos + 2], "big")
        end = pos + length
        if length < 2 or end > len(data):
            raise ValueError(error)
        segment = memoryview(data)[pos + 2:end]
        if marker in {0xC0, 0xC1, 0xC2}:
            if components or len(segment) < 6:
                raise ValueError(error)
            height, width = int.from_bytes(segment[1:3], "big"), int.from_bytes(segment[3:5], "big")
            count = segment[5]
            if (segment[0] != 8 or not 1 <= count <= 4 or len(segment) != 6 + 3 * count
                    or not 0 < width <= MAX_CROP_AXIS or not 0 < height <= MAX_CROP_AXIS
                    or width * height > MAX_CROP_PIXELS):
                raise ValueError(error)
            for offset in range(6, len(segment), 3):
                component, sampling, table = segment[offset:offset + 3]
                if component in components or not (1 <= sampling >> 4 <= 4 and 1 <= sampling & 15 <= 4) or table > 3:
                    raise ValueError(error)
                components.add(component)
                frame_quantization.add(table)
        elif marker in {0xDB, 0xC4}:
            offset = 0
            if not segment:
                raise ValueError(error)
            while offset < len(segment):
                table = segment[offset]
                offset += 1
                if table >> 4 > 1 or table & 15 > 3:
                    raise ValueError(error)
                if marker == 0xDB:
                    offset += 64 * (1 + (table >> 4))
                    quantization_tables.add(table & 15)
                else:
                    if offset + 16 > len(segment):
                        raise ValueError(error)
                    symbols = sum(segment[offset:offset + 16])
                    if not 1 <= symbols <= 256:
                        raise ValueError(error)
                    offset += 16 + symbols
                    huffman_tables.add(table)
                if offset > len(segment):
                    raise ValueError(error)
        elif marker == 0xDD and len(segment) != 2:
            raise ValueError(error)
        elif marker == 0xDA:
            if not components or not frame_quantization <= quantization_tables or len(segment) < 6:
                raise ValueError(error)
            count = segment[0]
            if not 1 <= count <= len(components) or len(segment) != 4 + 2 * count:
                raise ValueError(error)
            scan_components = set()
            for offset in range(1, 1 + 2 * count, 2):
                component, tables = segment[offset:offset + 2]
                if (component not in components or component in scan_components
                        or tables >> 4 not in huffman_tables or 0x10 | (tables & 15) not in huffman_tables):
                    raise ValueError(error)
                scan_components.add(component)
            if not 0 <= segment[-3] <= segment[-2] <= 63 or segment[-1] >> 4 > 13 or segment[-1] & 15 > 13:
                raise ValueError(error)
            # Skip bounded entropy bytes, honoring stuffed FF bytes and restart markers.
            pos = end
            while True:
                boundary = data.find(b"\xff", pos)
                if boundary < 0 or boundary + 1 >= len(data):
                    raise ValueError(error)
                following = boundary + 1
                while following < len(data) and data[following] == 0xFF:
                    following += 1
                if following >= len(data):
                    raise ValueError(error)
                if data[following] == 0 or 0xD0 <= data[following] <= 0xD7:
                    pos = following + 1
                    continue
                if boundary == end:
                    raise ValueError(error)
                saw_scan = True
                pos = boundary
                break
            continue
        pos = end
    raise ValueError(error)


class DetectionBox(RootModel[tuple[FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]]):
    """Top-left-origin pixel coordinates: [x1, y1, x2, y2]."""

    @model_validator(mode="after")
    def validate_extents(self) -> Self:
        x1, y1, x2, y2 = self.root
        if not (0 <= x1 < x2 and 0 <= y1 < y2):
            raise ValueError("box must have nonnegative coordinates and positive area")
        return self


class VehicleDetectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bbox: DetectionBox
    cls: str = Field(min_length=1, max_length=32, strict=True)
    confidence: Confidence


class SignDetectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bbox: DetectionBox
    confidence: Confidence
    crop_b64: str = Field(min_length=1, max_length=MAX_CROP_ENCODED, strict=True)
    _crop_bytes: bytes = PrivateAttr()

    @model_validator(mode="after")
    def validate_crop(self) -> Self:
        try:
            crop = base64.b64decode(self.crop_b64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("crop_b64 must contain valid base64") from exc
        if len(crop) > MAX_CROP_BYTES:
            raise ValueError("crop exceeds the 256 KiB decoded budget")
        validate_jpeg(crop)
        self._crop_bytes = crop
        return self


class DetectionSubmission(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")

    session_id: str = Field(min_length=1, max_length=128, strict=True)
    device_id: str = Field(min_length=1, max_length=128, strict=True)
    preview_status: str | None = Field(default=None, max_length=160)
    captured_at: datetime
    lat: Annotated[FiniteNumber, Field(ge=-90, le=90)]
    lng: Annotated[FiniteNumber, Field(ge=-180, le=180)]
    accuracy_m: Annotated[FiniteNumber, Field(ge=0)] | None
    heading: FiniteNumber = 0.0
    vehicles: list[VehicleDetectionInput] = Field(max_length=MAX_VEHICLES)
    signs: list[SignDetectionInput] = Field(max_length=MAX_SIGNS)
    frame_width: int = Field(gt=0, le=MAX_FRAME_AXIS, strict=True)
    frame_height: int = Field(gt=0, le=MAX_FRAME_AXIS, strict=True)

    @field_validator("captured_at", mode="before")
    @classmethod
    def validate_timestamp_length(cls, value):
        if isinstance(value, str) and len(value) > 64:
            raise ValueError("captured_at must be at most 64 characters")
        return value

    @model_validator(mode="before")
    @classmethod
    def validate_submission_budget(cls, value):
        # Preflight raw list/encoded sizes before constructing nested models or decoding.
        if isinstance(value, dict):
            for name, limit in (("vehicles", MAX_VEHICLES), ("signs", MAX_SIGNS)):
                entries = value.get(name)
                if isinstance(entries, (list, tuple)) and len(entries) > limit:
                    raise ValueError(f"{name} exceeds the {limit}-detection budget")
            signs = value.get("signs")
            if isinstance(signs, (list, tuple)):
                total = sum(len(sign["crop_b64"]) for sign in signs
                            if isinstance(sign, dict) and isinstance(sign.get("crop_b64"), str))
                if total > MAX_TOTAL_CROP_ENCODED:
                    raise ValueError("submission exceeds the aggregate encoded crop budget")
        return value

    @model_validator(mode="after")
    def validate_frame_bounds(self) -> Self:
        if self.frame_width * self.frame_height > MAX_FRAME_PIXELS:
            raise ValueError("frame exceeds the 16 MP pixel budget")
        if sum(len(sign._crop_bytes) for sign in self.signs) > MAX_TOTAL_CROP_BYTES:
            raise ValueError("submission exceeds the 1 MiB decoded crop budget")
        for detection in [*self.vehicles, *self.signs]:
            _, _, x2, y2 = detection.bbox.root
            if x2 > self.frame_width or y2 > self.frame_height:
                raise ValueError("box must fit inside the frame")
        return self

    def to_pipeline_input(self) -> tuple[list[VehicleDetection], list[SignDetection]]:
        vehicles = [VehicleDetection(
            bbox=list(vehicle.bbox.root), cls=vehicle.cls, confidence=vehicle.confidence,
        ) for vehicle in self.vehicles]
        signs = [SignDetection(
            bbox=list(sign.bbox.root), confidence=sign.confidence,
            crop_bytes=sign._crop_bytes,
        ) for sign in self.signs]
        return vehicles, signs
