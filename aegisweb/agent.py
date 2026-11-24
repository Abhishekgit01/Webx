"""AegisWeb's Plan → Act → Observe runbook.

The recorded demo uses a guarded, deterministic runbook: each step is a real
browser action followed by a real verification, so nothing is faked. Optional LLM
vision provides an escape hatch when a DOM selector fails on a redesigned site.
"""

from __future__ import annotations

import shutil
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .browser import BrowserSession
from .cloud import CloudMemory
from .config import Settings
from .events import EventBus
from .memory import AgentMemory
from .mission import parse_mission
from .report import write_run_outputs
from .skills import dismiss_consent, extract_first_product, fill_research_form, read_consent_state
from .voice import VoiceEngine


class AegisAgent:
    def __init__(self, settings: Settings, bus: EventBus | None = None) -> None:
        self.settings = settings
        self.bus = bus or EventBus()
        self.voice = VoiceEngine(settings, self.bus)

    # ------------------------------------------------------------------ helpers
    def _narrate(self, text: str) -> str:
        return text if self.settings.narration else ""

    def _say(self, key: str, text: str) -> None:
        if self.settings.audio:
            self.voice.say(key, text)

    def _prepare_artifacts(self) -> Path:
        latest = Path(self.settings.artifacts_dir) / "latest"
        shutil.rmtree(latest, ignore_errors=True)
        latest.mkdir(parents=True, exist_ok=True)
        return latest

    def _emit(self, kind: str, title: str, detail: str = "", **kwargs) -> dict:
        return self.bus.emit(kind, title, detail, **kwargs)

    @staticmethod
    def _error_text(exc: Exception) -> str:
        text = str(exc).strip()
        return text or exc.__class__.__name__

    # --------------------------------------------------------------------- run
    def run(self, task: str) -> dict[str, Any]:
        latest = self._prepare_artifacts()
        self.bus.reset(trace_path=latest / "trace.jsonl")
        mission = parse_mission(task, self.settings.shop_url, self.settings.form_url)
        started = datetime.now(timezone.utc)
        memory = AgentMemory(latest / "memory.json")
        memory.set("mission", mission.task, source="user")
        memory.set("status", "running", source="agent")

        self._emit(
            "run",
            "AegisWeb online",
            "Browser agent ready. Guarded autonomy engaged.",
            status="info",
            data={
                "mode": "guarded-runbook",
                "headless": self.settings.headless,
                "shop_url": mission.shop_url,
                "form_url": mission.form_url,
                "integrations": self.settings.integration_status(),
            },
        )
        self._emit(
            "plan",
            "Mission brief accepted",
            "Open storefront → reject non-essential cookies → capture first price → hand off across tabs → verify the research form.",
            status="info",
            data={"mission": mission.as_dict(), "steps": mission.notes},
            narration=self._narrate(
                "AegisWeb online. I’ll handle the cookie banner, capture the first price, and carry it across to your research form."
            ),
        )
        self._say("intro", "AegisWeb online. Starting the guarded demo runbook.")
        if mission.notes:
            for note in mission.notes:
                self._emit("observe", "Mission resolution", note, status="info")

        session: BrowserSession | None = None
        current_page = None
        result: dict[str, Any] = {
            "success": False,
            "run_id": memory.run_id,
            "task": mission.task,
            "mission": mission.as_dict(),
            "price": None,
            "product": None,
            "price_value": None,
            "trackers_blocked": 0,
            "tabs": 0,
            "cookies_rejected": 0,
            "form_submitted": False,
            "consent_method": None,
            "duration_seconds": 0.0,
            "error": None,
        }

        try:
            session = BrowserSession(self.settings, self.bus)
            session.start()

            # ---------------------------------------------------------- storefront
            current_page = session.open_tab(mission.shop_url)
            self._emit(
                "action",
                "Opening the storefront",
                mission.shop_url,
                status="active",
                phase="open",
                narration=self._narrate("Opening the demo storefront in the first tab."),
            )
            try:
                current_page.wait_for_selector("[data-aegis-catalog], body", state="visible", timeout=9000)
            except Exception:
                pass
            current_page.wait_for_timeout(int(500 * self.settings.pace))
            shot = session.shot(current_page, "storefront-loaded")
            self._emit(
                "observe",
                "Storefront loaded",
                "Nimbus Supply Co. is live in tab 1.",
                status="info",
                phase="open",
                shot=shot,
                data={"tab": 1, "title": current_page.title(), "url": current_page.url},
                narration=self._narrate("Storefront ready. Scanning for privacy friction."),
            )
            session.pause(650)

            # --------------------------------------------------------------- privacy
            self._emit(
                "action",
                "Scanning for hostile consent overlays",
                "Looking for cookie banners, consent walls, and hidden trackers.",
                status="active",
                phase="privacy",
                narration=self._narrate("Cookie banner detected. Rejecting all non-essential tracking."),
            )
            session.pause(850)
            consent = dismiss_consent(current_page, self.settings, self.bus)
            session.pause(300)
            trackers = list(session.blocked_trackers)
            consent_state = read_consent_state(current_page)
            if consent.get("rejected"):
                result["cookies_rejected"] = 1
                result["consent_method"] = consent.get("method")
                result["trackers_blocked"] = len(trackers)
                memory.set("consent", "rejected", source="privacy-sentinel")
                memory.set("trackers_blocked", len(trackers), source="privacy-sentinel")
                shot = session.shot(current_page, "cookies-rejected")
                self._emit(
                    "success",
                    "Rejected all non-essential cookies",
                    f"Consent closed via {consent.get('method')}. {len(trackers)} tracker request{'s' if len(trackers) != 1 else ''} blocked at the network layer.",
                    status="success",
                    phase="privacy",
                    shot=shot,
                    data={
                        "cookies_rejected": 1,
                        "trackers_blocked": len(trackers),
                        "tracker_urls": trackers,
                        "method": consent.get("method"),
                        "consent_state": consent_state,
                        "blockers": consent.get("blockers", []),
                    },
                    narration=self._narrate(
                        f"Privacy shield engaged. {len(trackers)} trackers blocked and the banner is gone."
                    ),
                )
                self._say("privacy", "Privacy shield engaged. All non-essential cookies rejected.")
            else:
                shot = session.shot(current_page, "no-consent-banner")
                self._emit(
                    "warn",
                    "No consent overlay detected",
                    "Continuing — this storefront may already be clean.",
                    status="warn",
                    phase="privacy",
                    shot=shot,
                    data={"trackers_blocked": len(trackers)},
                    narration=self._narrate("No cookie banner on this site. Continuing to the product."),
                )
            session.pause(800)

            # -------------------------------------------------------------- extraction
            self._emit(
                "action",
                "Locating the first featured product",
                "Reading structured data and the visible price.",
                status="active",
                phase="extract",
                narration=self._narrate("Extracting the first product price."),
            )
            session.pause(350)
            product = extract_first_product(current_page, self.settings, self.bus)
            session.pause(650)
            shot = session.shot(current_page, "price-captured")
            result.update(
                price=product["price"],
                product=product["name"],
                price_value=product.get("price_value"),
            )
            memory.set("product_name", product["name"], source="storefront")
            memory.set("product_price", product["price"], source="storefront")
            memory.set("product_sku", product.get("sku", ""), source="storefront")
            memory.set("source_url", mission.shop_url, source="storefront")
            self._emit(
                "extract",
                f"Captured {product['price']}",
                f"{product['name']} · extraction method: {product['method']}",
                status="success",
                phase="extract",
                shot=shot,
                data={**product, "tab": 1},
                narration=self._narrate(
                    f"Captured {product['price']} for the {product['name']}. Handing it to the research tab."
                ),
            )
            self._say("extract", f"Captured {product['price']} for the {product['name']}.")
            session.pause(750)

            # ------------------------------------------------------------- cross-tab
            self._emit(
                "action",
                "Opening the research form in a second tab",
                mission.form_url,
                status="active",
                phase="handoff",
                narration=self._narrate("Opening tab two: the research form."),
            )
            form_page = session.open_tab(mission.form_url)
            current_page = form_page
            try:
                form_page.wait_for_selector("[data-aegis-form], form", state="visible", timeout=9000)
            except Exception:
                pass
            session.activate(form_page)
            session.pause(700)
            handoff_value = memory.handoff("product_price", "storefront", "research-form")
            shot = session.shot(form_page, "research-tab-ready")
            self._emit(
                "handoff",
                "Cross-tab handoff complete",
                f"{product['name']} · {handoff_value} moved from tab 1 → tab 2. Two tabs live.",
                status="success",
                phase="handoff",
                shot=shot,
                data={
                    "from": "storefront",
                    "to": "research-form",
                    "price": handoff_value,
                    "product": product["name"],
                    "tabs": 2,
                },
                narration=self._narrate(
                    f"Memory synchronized across tabs. Now filling the form with {product['price']}."
                ),
            )
            self._say("handoff", "Cross tab handoff complete. Filling the research form now.")
            session.pause(550)

            # ------------------------------------------------------------------ form
            self._emit(
                "action",
                "Typing the captured price into the first field",
                "The value came from cross-tab memory, not the clipboard.",
                status="active",
                phase="form",
                narration=self._narrate("Typing the captured price into the form."),
            )
            session.pause(500)

            def before_submit() -> None:
                session.pause(500)
                filled_shot = session.shot(form_page, "form-populated")
                self._emit(
                    "observe",
                    "Form populated from agent memory",
                    f"First field = {product['price']} · {product['name']} · source attached.",
                    status="info",
                    phase="form",
                    shot=filled_shot,
                    data={"price": product["price"], "product": product["name"]},
                )

            form = fill_research_form(
                form_page,
                product,
                self.settings,
                mission.shop_url,
                before_submit=before_submit,
            )
            session.pause(900)
            shot = session.shot(form_page, "submission-verified", hide_cursor=True)
            result["form_submitted"] = True
            memory.set("form_submitted", True, source="research-form")
            memory.set("confirmation", form["receipt"].get("receipt-price") or product["price"], source="research-form")
            self._emit(
                "verify",
                "Form submitted and verified",
                f"Receipt visible: {form.get('filled_price') or product['price']} logged for {product['name']} on tab 2.",
                status="success",
                phase="form",
                shot=shot,
                data={
                    "form_submitted": True,
                    "price_field": form.get("price_field"),
                    "filled_price": form.get("filled_price"),
                    "receipt": form.get("receipt", {}),
                    "confirmation": form.get("confirmation", "")[:500],
                    "tab": 2,
                },
                narration=self._narrate(
                    f"Form verified. {product['price']} is saved and the mission is complete."
                ),
            )
            self._say("complete", f"Mission complete. {product['price']} saved to the research form.")
            session.pause(700)

            result["success"] = True
            result["tabs"] = 2
            result["trackers_blocked"] = len(session.blocked_trackers)
            result["consent_method"] = consent.get("method")
            result["final_url"] = form_page.url

        except Exception as exc:  # noqa: BLE001 - report everything to the operator
            message = self._error_text(exc)
            result["error"] = message
            result["traceback"] = traceback.format_exc()
            if session and current_page is not None:
                try:
                    shot = session.shot(current_page, "mission-error")
                except Exception:
                    shot = None
            else:
                shot = None
            self._emit(
                "error",
                "Mission stopped",
                message,
                status="error",
                shot=shot,
                data={"error": message},
                narration=self._narrate("Mission stopped. The trace has been saved for review."),
            )
            memory.set("status", "failed", source="agent")
        finally:
            try:
                if session:
                    result["tabs"] = len([p for p in (session.context.pages if session.context else []) if not p.is_closed()])
            except Exception:
                pass
            if (
                session
                and current_page is not None
                and result.get("success")
                and not self.settings.headless
                and self.settings.hold_seconds > 0
            ):
                hold = max(0.0, min(float(self.settings.hold_seconds), 15.0))
                self._emit(
                    "observe",
                    "Holding the verified result",
                    f"Keeping the final tab on screen for {hold:.1f}s — good for a live recording.",
                    status="info",
                    phase="done",
                )
                try:
                    current_page.wait_for_timeout(int(hold * 1000))
                except Exception:
                    pass
            if session:
                session.close()
            self.voice.close()

        ended = datetime.now(timezone.utc)
        result["duration_seconds"] = round((ended - started).total_seconds(), 2)
        result["finished_at"] = ended.isoformat(timespec="seconds")
        result["trackers_blocked"] = int(result.get("trackers_blocked") or 0)
        result["tabs"] = max(2, int(result.get("tabs") or 0)) if result.get("success") else int(result.get("tabs") or 0)
        memory.set("status", "complete" if result["success"] else "failed", source="agent")
        memory.set("duration_seconds", result["duration_seconds"], source="agent")

        cloud_status = None
        cloud = CloudMemory(self.settings)
        if cloud.enabled:
            self._emit(
                "cloud",
                "Syncing run memory to AWS",
                "POST /runs → API Gateway → Lambda → DynamoDB",
                status="active",
                phase="done",
            )
            sync = cloud.sync(mission.task, result)
            cloud_status = "synced" if sync.get("ok") else f"failed ({sync.get('error') or sync.get('status')})"
            result["cloud_sync"] = sync
            result["cloud_status"] = cloud_status
            self._emit(
                "cloud",
                "Cloud memory " + ("synced" if sync.get("ok") else "unavailable"),
                "DynamoDB now holds this run's cross-tab record." if sync.get("ok") else str(sync.get("error") or sync.get("status")),
                status="success" if sync.get("ok") else "warn",
                phase="done",
            )

        summary_title = "Mission complete" if result["success"] else "Mission failed"
        summary_detail = (
            f"{result.get('price') or '—'} captured · {result['trackers_blocked']} trackers blocked · "
            f"{result['tabs']} tabs orchestrated · form {'recorded' if result['form_submitted'] else 'not submitted'}"
            if result["success"]
            else str(result.get("error"))
        )
        self._emit(
            "run",
            summary_title,
            summary_detail,
            status="success" if result["success"] else "error",
            phase="done",
            data={key: result.get(key) for key in (
                "success", "price", "product", "trackers_blocked", "tabs", "form_submitted",
                "cookies_rejected", "consent_method", "duration_seconds", "cloud_status",
            )},
            narration=self._narrate(
                "Mission complete. The price is logged. AegisWeb is standing by."
                if result["success"]
                else "The mission could not be completed. Review the trace."
            ),
        )
        self._say(
            "complete",
            "Mission complete. The price is logged. AegisWeb is standing by."
            if result["success"]
            else "The mission could not be completed.",
        )

        completion_audio = self.voice.play_completion()
        if completion_audio:
            result["completion_audio"] = completion_audio

        report_path = Path(self.settings.artifacts_dir) / "latest" / "report.md"
        written: Path | None = None
        try:
            written = write_run_outputs(self.settings, mission.as_dict(), result, self.bus, report_path)
            result["report_path"] = str(written)
        except Exception:
            result["report_path"] = None
        if written:
            self._emit(
                "success" if result["success"] else "warn",
                "Evidence package written",
                f"artifacts/latest · {result['duration_seconds']:.1f}s",
                status="success" if result["success"] else "warn",
                phase="done",
                data={"report_url": "/artifacts/latest/report.md", "run_json": "/artifacts/latest/run.json"},
            )
        else:
            self._emit(
                "warn",
                "Evidence package could not be written",
                "The mission result is still available in the terminal.",
                status="warn",
                phase="done",
            )

        return result


def run_agent(task: str, settings: Settings, bus: EventBus | None = None) -> dict[str, Any]:
    return AegisAgent(settings, bus).run(task)
