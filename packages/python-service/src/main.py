from datetime import datetime, timezone
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


APP_NAME = "cua-python-service"
APP_VERSION = "0.1.0"
DEFAULT_ALLOWED_ORIGINS = "http://localhost:3002"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


app = FastAPI(
    title="AppyPie Python Service",
    version=APP_VERSION,
    description="Python companion service for the AppyPie CUA dashboard.",
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("PYTHON_SERVICE_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root() -> dict[str, str]:
    return {
        "service": APP_NAME,
        "message": "Python service is running.",
    }


@app.get("/health")
def read_health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": APP_NAME,
        "timestamp": utc_now_iso(),
    }


@app.get("/service-info")
def read_service_info() -> dict[str, object]:
    return {
        "name": APP_NAME,
        "version": APP_VERSION,
        "runtime": "python",
        "status": "ready",
        "port": int(os.getenv("PYTHON_SERVICE_PORT", "3003")),
        "capabilities": [
            "health checks",
            "dashboard-targeted API endpoints",
            "future Python automation hooks",
        ],
        "timestamp": utc_now_iso(),
    }
