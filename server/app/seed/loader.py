from pathlib import Path

from app.models.api import PublicSeedFixture
from app.repositories.protocols import ParkingRepository


async def load_seed(repository: ParkingRepository, fixture: PublicSeedFixture | None = None) -> None:
    if fixture is None:
        fixture = PublicSeedFixture.model_validate_json(
            Path(__file__).with_name("public.json").read_text()
        )
    for collection, values in (
        ("users", [fixture.driver, fixture.owner]),
        ("zones", fixture.nearby.zones),
        ("spaces", fixture.nearby.spaces),
        ("rules", [fixture.sign_rule]),
        ("driveways", fixture.nearby.driveways),
    ):
        for value in values:
            await repository.add_if_absent(collection, value)
