"""Cross-tab and cross-run agent memory.

The demo uses a local JSON file so it is reliable on stage. The same interface is
used by the optional AWS/DynamoDB sync in :mod:`aegisweb.cloud`.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AgentMemory:
    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else None
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {
            "run_id": datetime.now().strftime("%Y%m%d-%H%M%S"),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "facts": {},
            "handoffs": [],
        }
        if self.path and self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._data.update(loaded)
            except (OSError, json.JSONDecodeError):
                pass

    @property
    def run_id(self) -> str:
        return str(self._data.get("run_id", "run"))

    def set(self, key: str, value: Any, *, source: str = "") -> None:
        with self._lock:
            self._data.setdefault("facts", {})[key] = {
                "value": value,
                "source": source,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        self.save()

    def get(self, key: str, default: Any = None) -> Any:
        entry = self._data.get("facts", {}).get(key)
        if isinstance(entry, dict) and "value" in entry:
            return entry["value"]
        return default

    def handoff(self, key: str, from_tab: str, to_tab: str) -> Any:
        value = self.get(key)
        with self._lock:
            self._data.setdefault("handoffs", []).append(
                {
                    "key": key,
                    "value": value,
                    "from": from_tab,
                    "to": to_tab,
                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            )
        self.save()
        return value

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data, default=str))

    def save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.snapshot(), indent=2, default=str), encoding="utf-8")
        except OSError:
            pass
