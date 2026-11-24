"""End-to-end proof of the recorded happy path, headless and offline."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aegisweb.agent import run_agent
from aegisweb.browser import find_browser
from aegisweb.config import Settings
from aegisweb.demo_server import DemoServer
from aegisweb.events import EventBus

TASK = (
    "Navigate to the demo storefront, reject the cookie banner, grab the price of "
    "the first item, and save it to the research form."
)

pytestmark = pytest.mark.skipif(
    find_browser(Settings()) is None,
    reason="Chrome/Chromium is required for the browser flow",
)


@pytest.fixture(scope="module")
def demo_server():
    with DemoServer(port=0) as server:
        yield server


def test_headless_storefront_to_form_flow(demo_server, tmp_path):
    settings = Settings(
        demo_base_url=demo_server.base_url,
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
    bus = EventBus()

    result = run_agent(TASK, settings, bus)

    # ---------------------------------------------------------------- outcome
    assert result["error"] is None
    assert result["success"] is True
    assert result["price"] == "$149.00"
    assert result["price_value"] == 149.0
    assert result["product"] == "Ridgeline Field Lantern"
    assert result["cookies_rejected"] == 1
    assert result["consent_method"].startswith("dom:")
    assert result["trackers_blocked"] >= 3
    assert result["tabs"] == 2
    assert result["form_submitted"] is True
    assert result["final_url"].endswith("/form/")
    assert result["duration_seconds"] > 0

    # ------------------------------------------------------------- artifacts
    latest = Path(settings.artifacts_dir) / "latest"
    assert (latest / "report.md").exists()
    assert (latest / "run.json").exists()
    assert (latest / "trace.jsonl").exists()

    report = (latest / "report.md").read_text(encoding="utf-8")
    assert "**Status:** `SUCCESS`" in report
    assert "$149.00" in report
    assert "Ridgeline Field Lantern" in report
    assert "01-storefront-loaded.png" in report

    run_json = json.loads((latest / "run.json").read_text(encoding="utf-8"))
    assert run_json["result"]["success"] is True
    assert run_json["mission"]["wants_privacy"] is True
    assert len(run_json["events"]) >= 10

    for name in (
        "01-storefront-loaded.png",
        "02-cookies-rejected.png",
        "03-price-captured.png",
        "04-research-tab-ready.png",
        "05-form-populated.png",
        "06-submission-verified.png",
    ):
        shot = latest / name
        assert shot.exists(), f"missing screenshot {name}"
        assert shot.stat().st_size > 10_000, f"suspiciously small screenshot {name}"

    # --------------------------------------------------------------- memory
    memory = json.loads((latest / "memory.json").read_text(encoding="utf-8"))
    assert memory["facts"]["consent"]["value"] == "rejected"
    assert memory["facts"]["product_price"]["value"] == "$149.00"
    assert memory["facts"]["form_submitted"]["value"] is True
    assert memory["facts"]["status"]["value"] == "complete"
    assert len(memory["handoffs"]) == 1
    handoff = memory["handoffs"][0]
    assert handoff["from"] == "storefront"
    assert handoff["to"] == "research-form"
    assert handoff["value"] == "$149.00"

    # ---------------------------------------------------------------- trace
    events = bus.history
    phases = {event.get("phase") for event in events}
    assert {"open", "privacy", "extract", "handoff", "form"}.issubset(phases)

    verify = next(event for event in events if event["kind"] == "verify")
    assert verify["data"]["form_submitted"] is True
    assert verify["data"]["filled_price"] == "$149.00"
    assert verify["data"]["receipt"]["receipt-price"] == "$149.00"
    assert verify["shot"].endswith("06-submission-verified.png")

    privacy = next(event for event in events if event["title"] == "Rejected all non-essential cookies")
    assert privacy["data"]["cookies_rejected"] == 1
    assert privacy["data"]["trackers_blocked"] >= 3
    assert all("/track/" in url for url in privacy["data"]["tracker_urls"])

    trace_lines = (latest / "trace.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(trace_lines) == len(events)
    assert json.loads(trace_lines[-1])["title"] in {"Mission complete", "Evidence package written"}
