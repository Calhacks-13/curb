from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.models.api import PublicSeedFixture
from app.repositories.protocols import ParkingRepository

DEMO_DRIVEWAY_WINDOW = timedelta(hours=24)


async def load_seed(
    repository: ParkingRepository,
    fixture: PublicSeedFixture | None = None,
    *,
    refresh_observations: bool = False,
    now: datetime | None = None,
) -> None:
    """Add the demo seed to the repository without overwriting existing records.

    With ``refresh_observations``, observation times are shifted to ``now`` and
    every driveway is opened from ``now`` until 24 hours later, so a local demo
    works on whatever day the server starts.
    """
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
                        "driveways": [
                            driveway.model_copy(
                                update={
                                    "availability_start": reference,
                                    "availability_end": reference + DEMO_DRIVEWAY_WINDOW,
                                }
                            )
                            for driveway in fixture.nearby.driveways
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
