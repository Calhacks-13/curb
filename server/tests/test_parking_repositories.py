import asyncio
import json
from pathlib import Path

import pytest

from app.models.api import PublicSeedFixture


class StorageError(Exception):
    def __init__(self, status_code):
        self.status_code = status_code


class Container:
    """Small async state-container emulator; storage metadata must stay private."""
    def __init__(self):
        self.items = {}

    async def create_item(self, body):
        key = (body["partition_key"], body["id"])
        if key in self.items:
            raise StorageError(409)
        self.items[key] = {**body, "_etag": "version-1", "_ts": 1}

    async def read_item(self, item, partition_key):
        try:
            return self.items[(partition_key, item)]
        except KeyError:
            raise StorageError(404)

    def query_items(self, query, *, partition_key):
        async def iterate():
            for (partition, _), value in self.items.items():
                if partition == partition_key:
                    yield value
        return iterate()


@pytest.mark.parametrize("adapter", ["memory", "cosmos"])
def test_repository_round_trips_seed_without_storage_metadata_or_overwriting(adapter):
    from app.repositories.cosmos import CosmosParkingRepository
    from app.repositories.memory import InMemoryParkingRepository
    from app.seed.loader import load_seed

    async def run():
        repository = CosmosParkingRepository(Container()) if adapter == "cosmos" else InMemoryParkingRepository()
        raw = json.loads(Path("server/app/seed/public.json").read_text())
        fixture = PublicSeedFixture.model_validate(raw)
        await load_seed(repository, fixture)
        fixture.nearby.spaces[0].version = 9
        await load_seed(repository, fixture)
        space = await repository.get_space("space_demo_1")
        assert space.version == 1
        space.version = 100
        assert (await repository.get_space("space_demo_1")).version == 1
        assert len(await repository.list_spaces()) == 3
        assert len(await repository.list_zones()) == 1
        assert len(await repository.list_driveways()) == 2
        assert (await repository.get_user("owner_demo")).display_name == "Driveway Owner"
        assert (await repository.get_user("av_demo")).display_name == "Autonomous Vehicle"
        assert (await repository.get_zone("zone_demo_1")).sign_rule_id == "sign_rule_demo_1"
        assert (await repository.get_rule("sign_rule_demo_1")).max_minutes == 120
        assert await repository.get_space("missing") is None
    asyncio.run(run())


@pytest.mark.parametrize("status,paths", [(None, ["/partition_key"]), (404, None), (403, None), (None, ["/segment_id"])])
def test_cosmos_connection_checks_required_container_and_closes_on_failure(monkeypatch, status, paths):
    from unittest.mock import AsyncMock, Mock
    import azure.cosmos.aio
    from app.repositories.cosmos import CosmosParkingRepository, RepositoryError

    container = Mock()
    container.read = AsyncMock(return_value={"partitionKey": {"paths": paths}})
    if status:
        container.read.side_effect = StorageError(status)
    client = Mock()
    client.close = AsyncMock()
    client.get_database_client.return_value.get_container_client.return_value = container
    monkeypatch.setattr(azure.cosmos.aio, "CosmosClient", Mock(return_value=client))

    async def run():
        if status or paths != ["/partition_key"]:
            with pytest.raises(RepositoryError) as failure:
                await CosmosParkingRepository.connect("endpoint", "secret", "curb")
            assert "secret" not in str(failure.value)
            assert "state" in str(failure.value)
            if status == 404:
                assert "Provision it with partition key /partition_key" in str(failure.value)
            client.close.assert_awaited_once()
        else:
            repository = await CosmosParkingRepository.connect("endpoint", "secret", "curb")
            assert repository._container is container
            await repository.close()
            client.close.assert_awaited_once()
    asyncio.run(run())


def test_committed_server_seed_matches_contract_fixture():
    import subprocess

    raw = subprocess.run(
        ["npm", "run", "export-fixture", "--workspace", "@curb/contracts", "--silent"],
        check=True, capture_output=True, text=True,
    ).stdout
    assert json.loads(Path("server/app/seed/public.json").read_text()) == json.loads(raw)
