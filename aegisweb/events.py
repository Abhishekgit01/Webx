"""Structured agent telemetry.

Every action the agent takes emits one JSON-serializable event. The same bus feeds
the terminal, the live dashboard, the trace file, and the final run report.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class EventBus:
    """Thread-safe append-only event log with optional live callback."""

    def __init__(
        self,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        trace_path: Path | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._history: list[dict[str, Any]] = []
        self._seq = 0
        self._started = time.monotonic()
        self._on_event = on_event
        self._trace_path = Path(trace_path) if trace_path else None

    def reset(self, trace_path: Path | None = None) -> None:
        with self._lock:
            self._history.clear()
            self._seq = 0
            self._started = time.monotonic()
            self._trace_path = Path(trace_path) if trace_path else None

    def configure_trace(self, path: Path) -> None:
        with self._lock:
            self._trace_path = Path(path)
            self._trace_path.parent.mkdir(parents=True, exist_ok=True)
            self._trace_path.write_text("", encoding="utf-8")

    @property
    def history(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._history)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self._started

    def emit(
        self,
        kind: str,
        title: str,
        detail: str = "",
        *,
        status: str = "info",
        phase: str = "",
        data: dict[str, Any] | None = None,
        narration: str = "",
        shot: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            elapsed = time.monotonic() - self._started
            event: dict[str, Any] = {
                "seq": self._seq,
                "type": "agent.event",
                "kind": kind,
                "status": status,
                "phase": phase,
                "title": title,
                "detail": detail,
                "data": data or {},
                "narration": narration,
                "shot": shot,
                "ts": _now_iso(),
                "clock": datetime.now().strftime("%H:%M:%S"),
                "elapsed": round(elapsed, 2),
            }
            self._history.append(event)
            trace = self._trace_path
            if trace:
                try:
                    trace.parent.mkdir(parents=True, exist_ok=True)
                    with trace.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(event, default=str) + "\n")
                except OSError:
                    pass
        if self._on_event:
            try:
                self._on_event(event)
            except Exception:
                # Telemetry must never take down the agent.
                pass
        return event


def file_url(relative_path: str) -> str:
    return f"/artifacts/{relative_path.lstrip('/')}"
