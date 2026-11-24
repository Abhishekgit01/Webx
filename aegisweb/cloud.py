"""Optional AWS-backed run memory.

The local JSON memory is the source of truth for the demo. When AEGIS_CLOUD_URL is
set, the final run record is also POSTed to the SAM API in infra/template.yaml.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from .config import Settings


class CloudMemory:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.url = settings.cloud_url.strip()
        self.enabled = bool(self.url)

    def sync(self, task: str, result: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "skipped": True}
        payload = {
            "runId": result.get("run_id") or datetime.now().strftime("%Y%m%d-%H%M%S"),
            "task": task,
            "status": "complete" if result.get("success") else "failed",
            "price": result.get("price"),
            "product": result.get("product"),
            "trackersBlocked": result.get("trackers_blocked", 0),
            "tabs": result.get("tabs", 0),
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "result": {
                key: value
                for key, value in result.items()
                if key in {"success", "price", "product", "trackers_blocked", "tabs", "duration_seconds", "form_submitted"}
            },
        }
        data = json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json", "user-agent": "AegisWeb/0.1"}
        if self.settings.cloud_token:
            headers["authorization"] = f"Bearer {self.settings.cloud_token}"
        request = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                body = response.read().decode("utf-8", errors="replace")
                return {"ok": 200 <= response.status < 300, "status": response.status, "body": body[:300]}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "status": exc.code, "error": exc.reason}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}
