from typing import Literal

from pydantic import Field, HttpUrl, WebsocketUrl, field_validator, model_validator

from app.models.domain import (
    AgentParkingOption,
    BookingView,
    ContractModel,
    DemoProfile,
    DrivewayView,
    GeoPoint,
    NearbyParkingResponse,
    SpaceDetail,
    SignRuleView,
    UserView,
    UtcDateTime,
)


class DemoSessionRequest(ContractModel):
    profile: DemoProfile


class DemoSessionResponse(ContractModel):
    user: UserView
    token: str = Field(min_length=1)


class NearbyParkingQuery(ContractModel):
    lat: float = Field(ge=-90, le=90, strict=True)
    lng: float = Field(ge=-180, le=180, strict=True)
    radius_m: float = Field(strict=True)

    @field_validator("radius_m")
    @classmethod
    def radius_is_fixed_half_mile(cls, value: float) -> float:
        if value != 804.672:
            raise ValueError("mobile nearby radius must be 804.672 meters")
        return value


class RealtimeNegotiateResponse(ContractModel):
    url: WebsocketUrl

    @field_validator("url")
    @classmethod
    def url_uses_secure_websocket(cls, value: WebsocketUrl) -> WebsocketUrl:
        if value.scheme != "wss":
            raise ValueError("URL must use wss://")
        return value


class VisionFrameMetadata(ContractModel):
    timestamp: UtcDateTime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    location_accuracy: float = Field(ge=0)
    heading: float = Field(ge=0, lt=360)
    device_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)


class VisionFrameAccepted(ContractModel):
    frame_id: str = Field(min_length=1)
    accepted: bool


class DrivewayUpdateRequest(ContractModel):
    expected_version: int = Field(gt=0, strict=True)
    available: bool
    price_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    availability_start: UtcDateTime
    availability_end: UtcDateTime

    @model_validator(mode="after")
    def availability_window_is_ordered(self):
        if self.availability_start >= self.availability_end:
            raise ValueError("availability_start must precede availability_end")
        return self


class CreateHoldRequest(ContractModel):
    expected_version: int = Field(gt=0, strict=True)


class ReleaseHoldRequest(ContractModel):
    pass


class RecoverDrivewayRequest(CreateHoldRequest):
    pass


class PaymentProcessingRequest(ContractModel):
    expected_booking_version: int = Field(gt=0, strict=True)


class FinalizeBookingRequest(ContractModel):
    idempotency_key: str = Field(min_length=1)
    transaction_hash: str = Field(min_length=1)
    expected_booking_version: int = Field(gt=0, strict=True)


class PaymentFailedRequest(ContractModel):
    expected_booking_version: int = Field(gt=0, strict=True)
    code: str = Field(min_length=1)
    retryable: bool


class BookingAndDrivewayResponse(ContractModel):
    booking: BookingView
    driveway: DrivewayView


class ExecutePaymentResponse(BookingAndDrivewayResponse):
    explorer_url: HttpUrl


class X402BookingReceipt(ContractModel):
    booking_id: str = Field(min_length=1)
    driveway_id: str = Field(min_length=1)
    amount_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    network: Literal["base-sepolia"]
    payee_address: str = Field(min_length=1)


class AgentParkingSearchRequest(ContractModel):
    lat: float = Field(ge=-90, le=90, strict=True)
    lng: float = Field(ge=-180, le=180, strict=True)
    radius_m: float = Field(gt=0, strict=True, allow_inf_nan=False)


class AgentParkingSearchResponse(ContractModel):
    generated_at: UtcDateTime
    options: list[AgentParkingOption] = Field(max_length=3)


class RouteDestination(ContractModel):
    destination: GeoPoint


class PublicSeedFixture(ContractModel):
    driver: UserView
    owner: UserView
    sign_rule: SignRuleView
    driveway: DrivewayView
    booking: BookingView
    nearby: NearbyParkingResponse
    agent_option: AgentParkingOption


__all__ = [
    "AgentParkingSearchRequest",
    "AgentParkingSearchResponse",
    "BookingAndDrivewayResponse",
    "CreateHoldRequest",
    "DemoSessionRequest",
    "DemoSessionResponse",
    "DrivewayUpdateRequest",
    "ExecutePaymentResponse",
    "FinalizeBookingRequest",
    "NearbyParkingQuery",
    "NearbyParkingResponse",
    "PaymentFailedRequest",
    "PaymentProcessingRequest",
    "PublicSeedFixture",
    "RealtimeNegotiateResponse",
    "RecoverDrivewayRequest",
    "ReleaseHoldRequest",
    "RouteDestination",
    "SpaceDetail",
    "VisionFrameAccepted",
    "VisionFrameMetadata",
    "X402BookingReceipt",
]
