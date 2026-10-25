"""One-shot autonomous-vehicle driveway demo orchestration."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.azure import signalr
from app.domain.driveways import Actor, DrivewayService
from app.routes.driveways import get_actor


logger = logging.getLogger(__name__)

AV_ID = "av_demo"
TARGET_DRIVEWAY_ID = "driveway_av_1"
AV_TOKEN = f"demo-token-{AV_ID}"

# Six points over roughly 220 metres, terminating at the seeded driveway.
AV_ROUTE: tuple[tuple[tuple[float, float], float], ...] = (
    ((-122.42015, 37.77475), 67.0),
    ((-122.41968, 37.77491), 67.0),
    ((-122.41920, 37.77507), 67.0),
    ((-122.41872, 37.77523), 67.0),
    ((-122.41825, 37.77539), 67.0),
    ((-122.41780, 37.77555), 67.0),
)

PositionPublisher = Callable[
    [tuple[float, float], float, int], Awaitable[None]
]
Sleeper = Callable[[float], Awaitable[None]]


class PaymentExecutor(Protocol):
    async def execute(self, booking_id: str, caller_token: str) -> dict: ...


class HttpPaymentExecutor:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def execute(self, booking_id: str, caller_token: str) -> dict:
        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(
                f"{self.base_url}/v1/payments/{booking_id}/execute",
                headers={"Authorization": f"Bearer {caller_token}"},
            )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict) or not isinstance(result.get("booking"), dict):
            raise ValueError("payment service returned an invalid booking response")
        return result


async def publish_agent_position(
    position: tuple[float, float], heading: float, version: int
) -> None:
    await signalr.broadcast_realtime_event(
        "agent.position",
        AV_ID,
        {"position": list(position), "heading": heading},
        version,
    )


class AgentDemoRunner:
    def __init__(
        self,
        service: DrivewayService,
        payment: PaymentExecutor,
        *,
        publish_position: PositionPublisher = publish_agent_position,
        sleep: Sleeper = asyncio.sleep,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self.service = service
        self.payment = payment
        self.publish_position = publish_position
        self.sleep = sleep
        self.clock = clock
        self.task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def start(self) -> bool:
        if self.running:
            return False
        self.task = asyncio.create_task(self._run_guarded())
        return True

    async def _run_guarded(self) -> None:
        try:
            await self.run_once()
        except Exception as error:
            logger.exception("[AV x402] Demo failed: %s", error)

    async def run_once(self) -> None:
        for version, (position, heading) in enumerate(AV_ROUTE, 1):
            await self.publish_position(position, heading, version)
            if version < len(AV_ROUTE):
                await self.sleep(0.5)

        now = self.clock()
        target = await self.service.get_driveway(TARGET_DRIVEWAY_ID, now)
        booking = await self.service.start_hold(
            TARGET_DRIVEWAY_ID, AV_ID, target.version, now
        )
        await self.sleep(2.0)

        result = await self.payment.execute(booking.id, AV_TOKEN)
        paid = result["booking"]
        if paid.get("state") != "CONFIRMED":
            raise RuntimeError(
                f"payment is {paid.get('state', 'UNKNOWN')}; awaiting reconciliation"
            )
        transaction_hash = paid.get("transaction_hash")
        if not transaction_hash:
            raise ValueError("payment service did not return a transaction hash")
        logger.info(
            "[AV x402] Booked %s — $%s USDC — tx: %s",
            TARGET_DRIVEWAY_ID,
            paid.get("amount_usdc", booking.amount_usdc),
            transaction_hash,
        )

    async def close(self) -> None:
        if self.running and self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass


router = APIRouter(prefix="/v1/agent", tags=["agent"])


def get_agent_demo_runner(request: Request) -> AgentDemoRunner:
    runner = getattr(request.app.state, "agent_demo_runner", None)
    if runner is None:
        raise HTTPException(status_code=503, detail="agent demo is not configured")
    return runner


@router.post("/run-demo", status_code=status.HTTP_202_ACCEPTED)
async def run_demo(
    _actor: Actor = Depends(get_actor),
    runner: AgentDemoRunner = Depends(get_agent_demo_runner),
):
    if not runner.start():
        raise HTTPException(status_code=409, detail="agent demo is already running")
    return {"status": "started", "agent_id": AV_ID}
