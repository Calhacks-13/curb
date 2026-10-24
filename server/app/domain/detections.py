"""Validated JSON boundary for detections produced by a phone camera."""

import base64
import binascii
from datetime import datetime
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator

from app.models.cv import SignDetection, VehicleDetection


FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Confidence = Annotated[FiniteNumber, Field(ge=0, le=1)]


class DetectionBox(RootModel[tuple[FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]]):
    """Top-left-origin pixel coordinates: [x1, y1, x2, y2]."""

    @model_validator(mode="after")
    def validate_extents(self) -> Self:
        x1, y1, x2, y2 = self.root
        if not (0 <= x1 < x2 and 0 <= y1 < y2):
            raise ValueError("box must have nonnegative coordinates and positive area")
        return self


class VehicleDetectionInput(BaseModel):
    bbox: DetectionBox
    cls: str = Field(min_length=1, strict=True)
    confidence: Confidence


class SignDetectionInput(BaseModel):
    bbox: DetectionBox
    confidence: Confidence
    crop_b64: str = Field(min_length=1, strict=True)

    @field_validator("crop_b64")
    @classmethod
    def validate_crop(cls, value: str) -> str:
        try:
            base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("crop_b64 must contain valid base64") from exc
        return value


class DetectionSubmission(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    session_id: str = Field(min_length=1, strict=True)
    device_id: str = Field(min_length=1, strict=True)
    captured_at: datetime
    lat: Annotated[FiniteNumber, Field(ge=-90, le=90)]
    lng: Annotated[FiniteNumber, Field(ge=-180, le=180)]
    accuracy_m: Annotated[FiniteNumber, Field(ge=0)] | None
    heading: FiniteNumber = 0.0
    vehicles: list[VehicleDetectionInput]
    signs: list[SignDetectionInput]
    frame_width: int = Field(gt=0, strict=True)
    frame_height: int = Field(gt=0, strict=True)

    @model_validator(mode="after")
    def validate_frame_bounds(self) -> Self:
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
            crop_bytes=base64.b64decode(sign.crop_b64, validate=True),
        ) for sign in self.signs]
        return vehicles, signs
