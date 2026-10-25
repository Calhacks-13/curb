import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.azure import cosmos, signalr
from app.config import settings
from app.routes.bookings import router as bookings_router
from app.routes.driveways import router as driveways_router
from app.routes.parking import router as parking_router
from app.routes.sessions import router as sessions_router
from app.repositories.cosmos import CosmosParkingRepository
from app.repositories.memory import InMemoryParkingRepository
from app.seed.loader import load_seed
from app.wiring import build_driveway_service, resolve_actor

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    repository = getattr(app.state, "parking_repository", None)
    if repository is None:
        repository = (
            await CosmosParkingRepository.connect(
                settings.cosmos_endpoint, settings.cosmos_key, settings.cosmos_database
            ) if cosmos._is_configured() else InMemoryParkingRepository()
        )
        app.state.parking_repository = repository
    # Local in-memory startup uses a clearly demo-only, fresh observation window
    # so the seeded curb spaces remain visible while developing on a phone.
    await load_seed(repository, refresh_observations=isinstance(repository, InMemoryParkingRepository))
    # Startup: initialize persistence and realtime clients.
    await cosmos.init()
    await signalr.init()
    app.state.driveway_service = build_driveway_service(cosmos._mem_driveways, datetime.now(UTC))
    from app.cv.pipeline import get_pipeline
    pipeline = get_pipeline()
    pipeline.set_repository(repository)

    async def maintain_spots():
        while True:
            try:
                await pipeline.maintain()
            except Exception:
                logging.getLogger("uvicorn.error").exception("Curb spot maintenance failed")
            await asyncio.sleep(1)

    maintenance = asyncio.create_task(maintain_spots())
    try:
        yield
    finally:
        maintenance.cancel()
        with suppress(asyncio.CancelledError):
            await maintenance
        # Shutdown
        from app.cv.sign_reader import close_client

        await close_client()
        await cosmos.close()
        await signalr.close()
        if isinstance(repository, CosmosParkingRepository):
            await repository.close()



app = FastAPI(title="Curb API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def attach_actor(request: Request, call_next):
    actor = resolve_actor(request.headers.get("authorization"), settings.payment_service_token)
    if actor is not None:
        request.state.actor = actor
    return await call_next(request)


# Wire routers
from app.routes.signs import router as signs_router
from app.routes.v1 import router as v1_router

app.include_router(v1_router)
app.include_router(sessions_router)
app.include_router(parking_router)
app.include_router(signs_router)
app.include_router(driveways_router)
app.include_router(bookings_router)

# Serve static files
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "client.html")


@app.get("/viewer")
async def viewer_page():
    return FileResponse(STATIC_DIR / "viewer.html")


@app.get("/health")
async def health():
    from app.cv.pipeline import get_pipeline

    pipeline = get_pipeline()
    return {
        "status": "ok",
        "cosmos_configured": cosmos._is_configured(),
        "signalr_configured": signalr._is_configured(),
        "webpubsub_configured": signalr._webpubsub_configured(),
        "spots_in_memory": pipeline.spots_in_memory,
    }
