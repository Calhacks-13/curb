from app.models.domain import ContractModel, CurbZoneView, DrivewayView, ParkingSpaceView, SignRuleView, UserView
from app.repositories.protocols import Collection


class InMemoryParkingRepository:
    def __init__(self):
        self._data: dict[str, dict[str, ContractModel]] = {
            name: {} for name in ("users", "zones", "spaces", "rules", "driveways")
        }

    async def add_if_absent(self, collection: Collection, value: ContractModel) -> None:
        self._data[collection].setdefault(value.id, value.model_copy(deep=True))

    def _get(self, collection, id):
        value = self._data[collection].get(id)
        return value.model_copy(deep=True) if value else None

    async def get_user(self, user_id: str) -> UserView | None:
        return self._get("users", user_id)

    async def get_zone(self, zone_id: str) -> CurbZoneView | None:
        return self._get("zones", zone_id)

    async def get_space(self, space_id: str) -> ParkingSpaceView | None:
        return self._get("spaces", space_id)

    async def get_rule(self, rule_id: str) -> SignRuleView | None:
        return self._get("rules", rule_id)

    async def list_zones(self) -> list[CurbZoneView]:
        return [v.model_copy(deep=True) for v in self._data["zones"].values()]

    async def list_spaces(self) -> list[ParkingSpaceView]:
        return [v.model_copy(deep=True) for v in self._data["spaces"].values()]

    async def list_driveways(self) -> list[DrivewayView]:
        return [v.model_copy(deep=True) for v in self._data["driveways"].values()]
