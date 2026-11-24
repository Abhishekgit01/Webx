"""FastAPI mission-control dashboard and live event stream."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agent import AegisAgent
from .config import PROJECT_ROOT, Settings
from .demo_server import DemoServer
from .events import EventBus

DASHBOARD_DIR = Path(__file__).resolve().parent / "dashboard"
DEFAULT_TASK = (
    "Navigate to the demo storefront, reject the cookie banner, grab the price of "
    "the first item, and save it to the research form."
)


class RunRequest(BaseModel):
    task: str = Field(default=DEFAULT_TASK, min_length=3, max_length=1400)
    headless: bool = False
    pace: float = Field(default=1.0, ge=0, le=4)


class DashboardState:
    def __init__(self, settings: Settings, demo: DemoServer) -> None:
        self.settings = settings
        self.demo = demo
        self.bus = EventBus()
        self.lock = threading.Lock()
        self.running = False
        self.last_result: dict[str, Any] | None = None
        self.last_error: str | None = None
        self.started_at: float | None = None

    def start_run(self, request: RunRequest) -> None:
        with self.lock:
            if self.running:
                raise RuntimeError("A mission is already running.")
            self.running = True
            self.last_error = None
            self.started_at = time.time()
            self.bus.reset()
        thread = threading.Thread(target=self._run, args=(request,), name="aegis-run", daemon=True)
        thread.start()

    def _run(self, request: RunRequest) -> None:
        try:
            run_settings = self.settings.with_overrides(
                headless=request.headless,
                pace=request.pace,
                audio=False,
                demo_base_url=self.demo.base_url,
            )
            agent = AegisAgent(run_settings, self.bus)
            result = agent.run(request.task)
            self.last_result = result
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self.bus.emit(
                "error",
                "Dashboard runner crashed",
                str(exc),
                status="error",
                narration="The mission runner crashed. Check the dashboard trace.",
            )
        finally:
            with self.lock:
                self.running = False

    def snapshot(self) -> dict[str, Any]:
        result = self.last_result or {}
        return {
            "running": self.running,
            "last_result": {
                key: result.get(key)
                for key in (
                    "success", "price", "product", "trackers_blocked", "tabs",
                    "form_submitted", "cookies_rejected", "duration_seconds", "report_path",
                    "run_id", "error",
                )
            }
            if result
            else None,
            "last_error": self.last_error,
            "integrations": self.settings.integration_status(),
            "demo_origin": self.demo.base_url,
            "shop_url": self.demo.base_url + "/shop/",
            "form_url": self.demo.base_url + "/form/",
            "dashboard_url": f"http://{self.settings.host}:{self.settings.dashboard_port}",
            "report_url": "/artifacts/latest/report.md",
            "voice_pack": bool(any((Path(self.settings.voice_dir)).glob("*.mp3"))),
        }


def create_app(settings: Settings, demo: DemoServer) -> FastAPI:
    state = DashboardState(settings, demo)
    artifacts = Path(settings.artifacts_dir)
    artifacts.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="AegisWeb Mission Control", docs_url=None, redoc_url=None)
    app.state.aegis = state
    app.mount("/artifacts", StaticFiles(directory=str(artifacts)), name="artifacts")
    app.mount("/static", StaticFiles(directory=str(DASHBOARD_DIR)), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(DASHBOARD_DIR / "index.html")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "aegisweb-dashboard", "running": state.running}

    @app.get("/api/state")
    def get_state() -> dict[str, Any]:
        return state.snapshot()

    @app.post("/api/run")
    def start_run(payload: RunRequest) -> JSONResponse:
        try:
            state.start_run(payload)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return JSONResponse({"ok": True, "task": payload.task, "headless": payload.headless}, status_code=202)

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        async def stream():
            last_seq = 0
            last_ping = time.monotonic()
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                history = state.bus.history
                for event in history:
                    if event.get("seq", 0) > last_seq:
                        last_seq = event["seq"]
                        yield "data: " + json.dumps(event, default=str) + "\n\n"
                if time.monotonic() - last_ping > 12:
                    last_ping = time.monotonic()
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.3)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/config")
    def config() -> dict[str, Any]:
        return {
            "project_root": str(PROJECT_ROOT),
            "max_task_length": 1400,
            "default_task": DEFAULT_TASK,
        }

    return app


def serve(settings: Settings, *, open_browser: bool = True) -> None:
    import uvicorn

    demo = DemoServer(settings.host, settings.demo_port).start()
    url = f"http://{settings.host}:{settings.dashboard_port}"
    app = create_app(settings, demo)

    print()
    print("  AEGISWEB / MISSION CONTROL")
    print(f"  dashboard  {url}")
    print(f"  storefront {demo.base_url}/shop/")
    print(f"  form       {demo.base_url}/form/")
    print("  Ctrl+C to stop")
    print()

    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    config = uvicorn.Config(
        app,
        host=settings.host,
        port=settings.dashboard_port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    try:
        server.run()
    finally:
        demo.stop()
