from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.bookings import router as bookings_router
from app.routes.driveways import router as driveways_router

app = FastAPI(title="Curb API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(driveways_router)
app.include_router(bookings_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
