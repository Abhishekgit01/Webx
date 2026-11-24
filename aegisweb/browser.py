"""Playwright browser session with tracking protection and demo affordances."""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from .config import Settings

TRACKER_PATTERNS = [
    re.compile(r"/track/", re.I),
    re.compile(r"googletagmanager\.com", re.I),
    re.compile(r"google-analytics\.com", re.I),
    re.compile(r"doubleclick\.net", re.I),
    re.compile(r"facebook\.net/tr", re.I),
    re.compile(r"hotjar\.com", re.I),
    re.compile(r"segment\.(io|com)", re.I),
    re.compile(r"amplitude\.com", re.I),
    re.compile(r"mixpanel\.com", re.I),
]

CURSOR_SCRIPT = r"""
(() => {
  if (window.top !== window.self) return;
  const install = () => {
    if (!document.documentElement || document.getElementById('__aegis_cursor')) return;
    const style = document.createElement('style');
    style.id = '__aegis_cursor_style';
    style.textContent = `
      #__aegis_cursor, #__aegis_cursor_ring {
        position: fixed; left: 0; top: 0; z-index: 2147483647;
        pointer-events: none; opacity: 0; will-change: transform;
        transform: translate3d(-60px, -60px, 0);
        transition: opacity 120ms ease;
      }
      #__aegis_cursor {
        width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
        background: #d8ff63; border: 2px solid #0e2a1e;
        box-shadow: 0 0 0 2px rgba(255,255,255,.7), 0 3px 12px rgba(0,0,0,.35);
      }
      #__aegis_cursor_ring {
        width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 1.5px solid rgba(20,36,28,.75); background: rgba(216,255,99,.10);
        transition: opacity 120ms ease, transform 90ms linear, width 180ms ease, height 180ms ease;
      }
      #__aegis_cursor_ring.pulse {
        width: 52px; height: 52px; margin: -26px 0 0 -26px;
        border-color: rgba(216,255,99,.95); background: rgba(216,255,99,.26);
      }
      .__aegis_clicked {
        outline: 3px solid #d8ff63 !important;
        outline-offset: 3px !important;
        transition: outline-color 120ms ease !important;
      }
    `;
    document.documentElement.appendChild(style);

    const dot = document.createElement('div');
    dot.id = '__aegis_cursor';
    const ring = document.createElement('div');
    ring.id = '__aegis_cursor_ring';
    document.documentElement.appendChild(ring);
    document.documentElement.appendChild(dot);

    let raf = 0, rx = -60, ry = -60;
    const paint = () => {
      raf = 0;
      const t = `translate3d(${rx}px, ${ry}px, 0)`;
      dot.style.transform = t;
      ring.style.transform = t;
    };
    const onMove = (event) => {
      if (!event.isTrusted && event.pointerType === undefined) return;
      rx = event.clientX; ry = event.clientY;
      dot.style.opacity = '1'; ring.style.opacity = '1';
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onClick = (event) => {
      ring.classList.add('pulse');
      setTimeout(() => ring.classList.remove('pulse'), 240);
      const hit = event.target && event.target.closest ? event.target.closest('button, a, input, textarea, [role="button"]') : null;
      if (hit) {
        hit.classList.add('__aegis_clicked');
        setTimeout(() => hit.classList.remove('__aegis_clicked'), 360);
      }
    };
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('mousemove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onClick, { capture: true, passive: true });
    window.addEventListener('mousedown', onClick, { capture: true, passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
"""


def candidate_browsers() -> list[str]:
    values: list[str] = []
    env_path = os.getenv("AEGIS_CHROME_PATH")
    if env_path:
        values.append(env_path)
    if sys.platform.startswith("win"):
        values.extend(
            [
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            ]
        )
    elif sys.platform == "darwin":
        values.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    else:
        values.extend(
            [
                "/opt/google/chrome/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/usr/bin/brave-browser",
                "/snap/bin/chromium",
            ]
        )
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave"):
        found = shutil.which(name)
        if found:
            values.append(found)
    seen: set[str] = set()
    return [p for p in values if p and not (p in seen or seen.add(p))]


def find_browser(settings: Settings) -> str | None:
    if settings.chrome_path and Path(settings.chrome_path).exists():
        return settings.chrome_path
    for path in candidate_browsers():
        if Path(path).exists():
            return path
    return None


class BrowserSession:
    """Owns the Playwright context. Create and use it on the same thread."""

    def __init__(self, settings: Settings, bus=None) -> None:
        self.settings = settings
        self.bus = bus
        self._pw = None
        self.browser = None
        self.context = None
        self.blocked_trackers: list[str] = []
        self._shot_index = 0
        self.artifacts = Path(settings.artifacts_dir) / "latest"
        self.artifacts.mkdir(parents=True, exist_ok=True)

    def __enter__(self) -> "BrowserSession":
        self.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def start(self) -> None:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        launch_args = [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            "--disable-features=Translate,MediaRouter",
            "--hide-crash-restore-bubble",
        ]
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            launch_args.append("--no-sandbox")

        exec_path = find_browser(self.settings)
        errors: list[str] = []
        launch_kwargs: dict[str, Any] = dict(
            headless=self.settings.headless,
            slow_mo=max(0, self.settings.slow_mo),
            args=launch_args,
            ignore_default_args=["--enable-automation"],
        )
        if exec_path:
            try:
                self.browser = self._pw.chromium.launch(executable_path=exec_path, **launch_kwargs)
            except PlaywrightError as exc:
                errors.append(f"{exec_path}: {exc}")
        if self.browser is None:
            try:
                self.browser = self._pw.chromium.launch(**launch_kwargs)
            except PlaywrightError as exc:
                errors.append(str(exc))
        if self.browser is None:
            self._pw.stop()
            hint = (
                "No usable Chrome/Chromium found. Install Google Chrome, set AEGIS_CHROME_PATH, "
                "or run: python -m playwright install chromium"
            )
            raise RuntimeError(hint + ("\n" + "\n".join(errors) if errors else ""))

        self.context = self.browser.new_context(
            viewport={"width": self.settings.viewport_width, "height": self.settings.viewport_height},
            screen={"width": self.settings.viewport_width, "height": self.settings.viewport_height},
            locale="en-US",
            timezone_id="America/Los_Angeles",
            color_scheme="light",
            reduced_motion="no-preference",
        )
        self.context.set_default_timeout(9000)
        self.context.set_default_navigation_timeout(25000)
        self.context.add_init_script(CURSOR_SCRIPT)
        self.context.route("**/*", self._route)

    def _route(self, route) -> None:
        url = route.request.url
        if any(pattern.search(url) for pattern in TRACKER_PATTERNS):
            if url not in self.blocked_trackers:
                self.blocked_trackers.append(url)
            try:
                route.abort("blockedbyclient")
            except Exception:
                pass
            return
        try:
            route.continue_()
        except Exception:
            pass

    def open_tab(self, url: str, *, wait_until: str = "domcontentloaded") -> Any:
        if not self.context:
            raise RuntimeError("BrowserSession.start() must be called first")
        page = self.context.new_page()
        page.on("dialog", lambda dialog: dialog.dismiss())
        page.goto(url, wait_until=wait_until)
        return page

    def pause(self, milliseconds: int) -> None:
        if not self.context or self.settings.pace <= 0:
            return
        from playwright.sync_api import Error as PlaywrightError

        try:
            if self.context.pages:
                self.context.pages[0].wait_for_timeout(max(0, int(milliseconds * self.settings.pace)))
        except PlaywrightError:
            pass

    def activate(self, page) -> None:
        page.bring_to_front()
        page.wait_for_timeout(max(80, int(160 * self.settings.pace)))

    def shot(self, page, label: str, *, hide_cursor: bool = False) -> str:
        """Save a viewport screenshot and return an artifacts-relative path."""
        self._shot_index += 1
        safe = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:48] or "shot"
        filename = f"{self._shot_index:02d}-{safe}.png"
        path = self.artifacts / filename
        try:
            # Let CSS transitions settle even in instant/pace-0 runs, then capture
            # with finite animations fast-forwarded for crisp documentation shots.
            page.wait_for_timeout(160)
            try:
                page.evaluate("document.querySelectorAll('.__aegis_clicked').forEach((el) => el.classList.remove('__aegis_clicked'))")
            except Exception:
                pass
            if hide_cursor:
                try:
                    page.evaluate(
                        "document.querySelectorAll('#__aegis_cursor, #__aegis_cursor_ring').forEach((el) => { el.style.visibility = 'hidden'; })"
                    )
                except Exception:
                    pass
            page.screenshot(path=str(path), full_page=False, animations="disabled")
        except Exception:
            return ""
        finally:
            if hide_cursor:
                try:
                    page.evaluate(
                        "document.querySelectorAll('#__aegis_cursor, #__aegis_cursor_ring').forEach((el) => { el.style.visibility = 'visible'; })"
                    )
                except Exception:
                    pass
        return f"latest/{filename}"

    def close(self) -> None:
        try:
            if self.context:
                self.context.close()
        except Exception:
            pass
        try:
            if self.browser:
                self.browser.close()
        except Exception:
            pass
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass
        self.context = None
        self.browser = None
        self._pw = None
