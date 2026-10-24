from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.azure import cosmos, signalr
from app.config import settings
from app.routes.bookings import router as bookings_router
from app.routes.driveways import router as driveways_router

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: preload models, init Azure clients
    from app.cv.detector import get_vehicle_model, get_sign_model, get_seg_model
    from app.cv.depth import load_depth_model

    get_seg_model()  # try segmentation first (preferred)
    get_vehicle_model()  # bbox fallback
    get_sign_model()
    load_depth_model()
    await cosmos.init()
    await signalr.init()
    yield
    # Shutdown
    from app.cv.sign_reader import close_client

    await close_client()
    await cosmos.close()
    await signalr.close()


app = FastAPI(title="Curb API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Wire routers
from app.routes.ws import router as ws_router
from app.routes.signs import router as signs_router
from app.routes.v1 import router as v1_router

app.include_router(v1_router)
app.include_router(ws_router)
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
    from app.cv.detector import _vehicle_model, _sign_model_available, _seg_model_available
    from app.cv.depth import is_available as depth_is_available, is_metric as depth_is_metric
    from app.cv.pipeline import get_pipeline

    from app.config import settings as _settings
    pipeline = get_pipeline()
    return {
        "status": "ok",
        "device": _settings.device,
        "seg_model": _settings.seg_model_path,
        "yolo_imgsz": _settings.yolo_imgsz,
        "yolo_half": _settings.yolo_half,
        "vehicle_model_loaded": _vehicle_model is not None,
        "seg_model_available": _seg_model_available or False,
        "sign_model_available": _sign_model_available or False,
        "depth_enabled": _settings.depth_enabled,
        "depth_model_available": depth_is_available(),
        "depth_metric": depth_is_metric(),
        "cosmos_configured": cosmos._is_configured(),
        "signalr_configured": signalr._is_configured(),
        "webpubsub_configured": signalr._webpubsub_configured(),
        "spots_in_memory": pipeline.spots_in_memory,
    }
