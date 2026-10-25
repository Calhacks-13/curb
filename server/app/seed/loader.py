from datetime import UTC, datetime
from pathlib import Path

from app.models.api import PublicSeedFixture
from app.repositories.protocols import ParkingRepository


async def load_seed(
    repository: ParkingRepository,
    fixture: PublicSeedFixture | None = None,
    *,
    refresh_observations: bool = False,
    now: datetime | None = None,
) -> None:
    if fixture is None:
        fixture = PublicSeedFixture.model_validate_json(
            Path(__file__).with_name("public.json").read_text()
        )
    if refresh_observations:
        reference = now or datetime.now(UTC)
        offset = reference - fixture.nearby.generated_at
        fixture = fixture.model_copy(
            update={
                "nearby": fixture.nearby.model_copy(
                    update={
                        "generated_at": reference,
                        "spaces": [
                            space.model_copy(update={"last_observed_at": space.last_observed_at + offset})
                            for space in fixture.nearby.spaces
                        ],
                    }
                )
            }
        )
    for collection, values in (
        ("users", [fixture.driver, fixture.owner, fixture.av]),
        ("zones", fixture.nearby.zones),
        ("spaces", fixture.nearby.spaces),
        ("rules", [fixture.sign_rule]),
        ("driveways", fixture.nearby.driveways),
    ):
        for value in values:
            await repository.add_if_absent(collection, value)
