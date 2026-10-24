from typing import Protocol

from app.models.domain import ContractModel, CurbZoneView, DrivewayView, ParkingSpaceView, SignRuleView, UserView
from app.repositories.protocols import Collection


class DocumentContainer(Protocol):
    async def create_item(self, body: dict) -> dict: ...
    async def read_item(self, item: str, partition_key: str) -> dict: ...
    def query_items(self, query: str, *, partition_key: str): ...


class RepositoryError(RuntimeError):
    """Storage failure exposed without a vendor-specific exception contract."""


class CosmosParkingRepository:
    """Canonical records in the state container (partition key /partition_key).

    This adapter deliberately does not interpret legacy CV block/spot documents
    as validated mapped stalls. Those need an explicit calibration/rule bridge.
    """
    def __init__(self, container: DocumentContainer):
        self._container = container
        self._client = None

    @classmethod
    async def connect(cls, endpoint: str, key: str, database: str, container: str = "state"):
        from azure.cosmos.aio import CosmosClient

        client = CosmosClient(endpoint, key)
        repository = cls(client.get_database_client(database).get_container_client(container))
        repository._client = client
        return repository

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

    async def add_if_absent(self, collection: Collection, value: ContractModel) -> None:
        try:
            await self._container.create_item({
                "id": value.id, "partition_key": f"parking:{collection}",
                "value": value.model_dump(mode="json"),
            })
        except Exception as error:
            if getattr(error, "status_code", None) != 409:
                raise RepositoryError("parking seed write failed") from None

    async def _get(self, collection, id, model):
        try:
            document = await self._container.read_item(id, partition_key=f"parking:{collection}")
        except Exception as error:
            if getattr(error, "status_code", None) == 404:
                return None
            raise RepositoryError("parking read failed") from None
        return model.model_validate(document["value"])

    async def _list(self, collection, model):
        try:
            return [model.model_validate(document["value"]) async for document in
                    self._container.query_items("SELECT * FROM c", partition_key=f"parking:{collection}")]
        except Exception:
            raise RepositoryError("parking query failed") from None

    async def get_user(self, user_id: str) -> UserView | None:
        return await self._get("users", user_id, UserView)

    async def get_zone(self, zone_id: str) -> CurbZoneView | None:
        return await self._get("zones", zone_id, CurbZoneView)

    async def get_space(self, space_id: str) -> ParkingSpaceView | None:
        return await self._get("spaces", space_id, ParkingSpaceView)

    async def get_rule(self, rule_id: str) -> SignRuleView | None:
        return await self._get("rules", rule_id, SignRuleView)

    async def list_zones(self) -> list[CurbZoneView]:
        return await self._list("zones", CurbZoneView)

    async def list_spaces(self) -> list[ParkingSpaceView]:
        return await self._list("spaces", ParkingSpaceView)

    async def list_driveways(self) -> list[DrivewayView]:
        return await self._list("driveways", DrivewayView)
