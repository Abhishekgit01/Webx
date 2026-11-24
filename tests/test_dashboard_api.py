"""Mission Control API smoke test: health, validation, and a real headless run."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from webx.browser import find_browser
from webx.config import Settings
from webx.dashboard import create_app
from webx.demo_server import DemoServer


@pytest.fixture()
def client(tmp_path):
    with DemoServer(port=0) as demo:
        settings = Settings(
            demo_base_url=demo.base_url,
            headless=True,
            slow_mo=0,
            pace=0.0,
            hold_seconds=0.0,
            narration=False,
            audio=False,
            vision_fallback=False,
            artifacts_dir=tmp_path / "artifacts",
            assets_dir=tmp_path / "assets",
        )
        app = create_app(settings, demo)
        with TestClient(app) as test_client:
            yield test_client, settings


def test_health_state_and_validation(client):
    test_client, _settings = client

    health = test_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True
    assert health.json()["running"] is False

    state = test_client.get("/api/state").json()
    assert state["shop_url"].endswith("/shop/")
    assert state["form_url"].endswith("/form/")
    assert state["last_result"] is None
    assert state["integrations"]["openai"] is False

    config = test_client.get("/api/config").json()
    assert config["max_task_length"] == 1400
    assert "reject the cookie banner" in config["default_task"]

    assert test_client.get("/").status_code == 200
    assert test_client.get("/static/app.js").status_code == 200

    too_short = test_client.post("/api/run", json={"task": "x", "headless": True, "pace": 0})
    assert too_short.status_code == 422


@pytest.mark.skipif(
    find_browser(Settings()) is None,
    reason="Chrome/Chromium is required for the dashboard run",
)
def test_dashboard_runs_the_mission(client):
    test_client, settings = client

    started = test_client.post(
        "/api/run",
        json={
            "task": "Reject the cookie banner, capture the first price, and save it to the form.",
            "headless": True,
            "pace": 0,
        },
    )
    assert started.status_code == 202
    assert started.json()["ok"] is True

    deadline = time.monotonic() + 90
    state: dict = {}
    while time.monotonic() < deadline:
        state = test_client.get("/api/state").json()
        if not state["running"]:
            break
        time.sleep(0.25)

    assert state["running"] is False, "dashboard mission did not finish in 90s"
    assert state["last_error"] is None
    result = state["last_result"]
    assert result is not None
    assert result["success"] is True
    assert result["price"] == "$149.00"
    assert result["tabs"] == 2
    assert result["form_submitted"] is True
    assert result["trackers_blocked"] >= 3

    report = Path(settings.artifacts_dir) / "latest" / "report.md"
    assert report.exists()
    assert "$149.00" in report.read_text(encoding="utf-8")
