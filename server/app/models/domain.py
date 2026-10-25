from datetime import datetime, timedelta
from enum import Enum
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    field_validator,
    model_validator,
)


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def _utc_datetime(value: datetime) -> datetime:
    if value.utcoffset() != timedelta(0):
        raise ValueError("timestamp must use UTC")
    return value


UtcDateTime = Annotated[datetime, AfterValidator(_utc_datetime)]
LngLat = tuple[float, float]


def _validate_lng_lat(coordinate: LngLat) -> LngLat:
    longitude, latitude = coordinate
    if not -180 <= longitude <= 180:
        raise ValueError("longitude must be between -180 and 180")
    if not -90 <= latitude <= 90:
        raise ValueError("latitude must be between -90 and 90")
    return coordinate


class GeoPoint(ContractModel):
    type: Literal["Point"]
    coordinates: LngLat

    _coordinates_valid = field_validator("coordinates")(_validate_lng_lat)


class GeoLineString(ContractModel):
    type: Literal["LineString"]
    coordinates: list[LngLat] = Field(min_length=2)

    @field_validator("coordinates")
    @classmethod
    def coordinates_are_lng_lat(cls, value: list[LngLat]) -> list[LngLat]:
        return [_validate_lng_lat(coordinate) for coordinate in value]


class GeoPolygon(ContractModel):
    type: Literal["Polygon"]
    coordinates: list[list[LngLat]] = Field(min_length=1)

    @field_validator("coordinates")
    @classmethod
    def rings_are_valid(cls, value: list[list[LngLat]]) -> list[list[LngLat]]:
        for ring in value:
            if len(ring) < 4:
                raise ValueError("polygon rings require at least four coordinates")
            for coordinate in ring:
                _validate_lng_lat(coordinate)
        return value


class DemoProfile(str, Enum):
    DRIVER = "driver"
    OWNER = "owner"


class LegalStatus(str, Enum):
    LEGAL = "LEGAL"
    ILLEGAL = "ILLEGAL"
    UNKNOWN = "UNKNOWN"


class InternalSpaceState(str, Enum):
    UNKNOWN = "UNKNOWN"
    OPEN = "OPEN"
    OCCUPIED = "OCCUPIED"


class Occupancy(str, Enum):
    OPEN = "OPEN"
    OCCUPIED = "OCCUPIED"
    UNKNOWN = "UNKNOWN"


class Freshness(str, Enum):
    FRESH = "FRESH"
    AGING = "AGING"
    STALE = "STALE"


class DrivewayState(str, Enum):
    UNAVAILABLE = "UNAVAILABLE"
    AVAILABLE = "AVAILABLE"
    HELD = "HELD"
    BOOKED = "BOOKED"


class BookingState(str, Enum):
    PENDING_PAYMENT = "PENDING_PAYMENT"
    PROCESSING = "PROCESSING"
    RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"


class PaymentStatus(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    PROCESSING = "PROCESSING"
    FAILED = "FAILED"
    SETTLED = "SETTLED"


class DayOfWeek(str, Enum):
    MONDAY = "MONDAY"
    TUESDAY = "TUESDAY"
    WEDNESDAY = "WEDNESDAY"
    THURSDAY = "THURSDAY"
    FRIDAY = "FRIDAY"
    SATURDAY = "SATURDAY"
    SUNDAY = "SUNDAY"


class RuleKind(str, Enum):
    ALLOWED = "ALLOWED"
    NO_PARKING = "NO_PARKING"
    STREET_CLEANING = "STREET_CLEANING"
    PERMIT_ONLY = "PERMIT_ONLY"
    METERED = "METERED"


class WeeklyRuleWindow(ContractModel):
    days: list[DayOfWeek] = Field(min_length=1)
    start_local: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_local: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    kind: RuleKind


class PaymentRules(ContractModel):
    required: bool
    price_text: str | None


class PermitRules(ContractModel):
    required: bool
    permitted_labels: list[str]


class UserView(ContractModel):
    id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    demo_profile: DemoProfile


class SignRuleView(ContractModel):
    id: str = Field(min_length=1)
    zone_id: str = Field(min_length=1)
    weekly_schedule: list[WeeklyRuleWindow]
    max_minutes: int | None = Field(gt=0)
    payment_rules: PaymentRules
    permit_rules: PermitRules
    exceptions: list[str]
    evidence_text: str = Field(min_length=1)
    interpretation_confidence: float = Field(ge=0, le=1)
    last_validated_at: UtcDateTime
    version: int = Field(gt=0)


class CurbZoneView(ContractModel):
    id: str = Field(min_length=1)
    geometry: GeoLineString
    sign_rule_id: str | None
    legal_status_now: LegalStatus
    current_rules: str = Field(min_length=1)
    next_change_at: UtcDateTime | None
    version: int = Field(gt=0)


class ParkingSpaceView(ContractModel):
    id: str = Field(min_length=1)
    zone_id: str = Field(min_length=1)
    location: GeoPoint
    stall_geometry: GeoPolygon
    internal_state: InternalSpaceState
    last_observed_at: UtcDateTime | None
    base_confidence: float = Field(ge=0, le=1)
    detection_confidence: float = Field(default=0, ge=0, le=1)
    freshness: Freshness | None
    status_label: str = Field(min_length=1)
    distance_m: float = Field(ge=0)
    version: int = Field(gt=0)


class SpaceDetail(ParkingSpaceView):
    sign_rule: SignRuleView
    current_rules: str = Field(min_length=1)
    max_minutes: int | None = Field(gt=0)
    next_change_at: UtcDateTime | None


class ActiveBookingSummary(ContractModel):
    id: str = Field(min_length=1)
    state: BookingState
    payment_status: PaymentStatus


class DrivewayView(ContractModel):
    id: str = Field(min_length=1)
    owner_id: str = Field(min_length=1)
    location: GeoPoint
    photo_url: HttpUrl
    price_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    availability_start: UtcDateTime
    availability_end: UtcDateTime
    availability_timezone: Literal["America/Los_Angeles"]
    state: DrivewayState
    held_by_user_id: str | None
    active_booking: ActiveBookingSummary | None
    available_now: bool
    distance_m: float = Field(ge=0)
    version: int = Field(gt=0)

    @model_validator(mode="after")
    def active_booking_matches_state(self):
        if self.state == DrivewayState.HELD and self.active_booking is None:
            raise ValueError("held driveways require an active booking")
        if self.state in {DrivewayState.UNAVAILABLE, DrivewayState.AVAILABLE} and self.active_booking:
            raise ValueError("unheld driveways cannot expose an active booking")
        return self


class BookingView(ContractModel):
    id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    driveway_id: str = Field(min_length=1)
    driver_id: str = Field(min_length=1)
    state: BookingState
    payment_status: PaymentStatus
    amount_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    network: Literal["base-sepolia"]
    transaction_hash: str | None = Field(min_length=1)
    created_at: UtcDateTime
    confirmed_at: UtcDateTime | None
    version: int = Field(gt=0)


class NearbyParkingResponse(ContractModel):
    generated_at: UtcDateTime
    zones: list[CurbZoneView]
    spaces: list[ParkingSpaceView]
    driveways: list[DrivewayView]


class ParkingOptionType(str, Enum):
    CURB = "CURB"
    DRIVEWAY = "DRIVEWAY"


class AgentParkingOption(ContractModel):
    id: str = Field(min_length=1)
    type: ParkingOptionType
    location: GeoPoint
    distance_m: float = Field(ge=0)
    price_usdc: str | None = Field(pattern=r"^\d+(\.\d{1,6})?$")
    current_rules: str = Field(min_length=1)
    confidence: float | None = Field(ge=0, le=1)
    freshness: Freshness | None
    availability: str = Field(min_length=1)
    reservation_supported: bool


class Observation(ContractModel):
    id: str = Field(min_length=1)
    space_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    observed_at: UtcDateTime
    occupancy: Occupancy
    detection_confidence: float = Field(ge=0, le=1)
    location_accuracy: float = Field(ge=0)
    heading: float = Field(ge=0, lt=360)
    model_version: str = Field(min_length=1)


class SpacePayload(ContractModel):
    space: ParkingSpaceView


class SpaceIdPayload(ContractModel):
    space_id: str = Field(min_length=1)


class SignRulePayload(ContractModel):
    zone_id: str = Field(min_length=1)
    sign_rule: SignRuleView


class DrivewayPayload(ContractModel):
    driveway: DrivewayView


class BookingConfirmedPayload(ContractModel):
    booking: BookingView
    driveway: DrivewayView


class PaymentFailedPayload(ContractModel):
    booking_id: str = Field(min_length=1)
    code: str = Field(min_length=1)
    retryable: bool


class RealtimeEventBase(ContractModel):
    entity_id: str = Field(min_length=1)
    entity_version: int = Field(gt=0)
    occurred_at: UtcDateTime


class SpaceOpenedEvent(RealtimeEventBase):
    type: Literal["space.opened"]
    payload: SpacePayload


class SpaceRefreshedEvent(RealtimeEventBase):
    type: Literal["space.refreshed"]
    payload: SpacePayload


class SpaceOccupiedEvent(RealtimeEventBase):
    type: Literal["space.occupied"]
    payload: SpaceIdPayload


class SpaceExpiredEvent(RealtimeEventBase):
    type: Literal["space.expired"]
    payload: SpaceIdPayload


class SignRuleUpdatedEvent(RealtimeEventBase):
    type: Literal["sign_rule.updated"]
    payload: SignRulePayload


class DrivewayUpdatedEvent(RealtimeEventBase):
    type: Literal["driveway.updated"]
    payload: DrivewayPayload


class DrivewayHeldEvent(RealtimeEventBase):
    type: Literal["driveway.held"]
    payload: DrivewayPayload


class DrivewayReleasedEvent(RealtimeEventBase):
    type: Literal["driveway.released"]
    payload: DrivewayPayload


class BookingConfirmedEvent(RealtimeEventBase):
    type: Literal["booking.confirmed"]
    payload: BookingConfirmedPayload


class PaymentFailedEvent(RealtimeEventBase):
    type: Literal["payment.failed"]
    payload: PaymentFailedPayload


RealtimeEvent = Annotated[
    SpaceOpenedEvent
    | SpaceRefreshedEvent
    | SpaceOccupiedEvent
    | SpaceExpiredEvent
    | SignRuleUpdatedEvent
    | DrivewayUpdatedEvent
    | DrivewayHeldEvent
    | DrivewayReleasedEvent
    | BookingConfirmedEvent
    | PaymentFailedEvent,
    Field(discriminator="type"),
]
