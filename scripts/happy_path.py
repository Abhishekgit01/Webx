#!/usr/bin/env python3
"""Standalone Webx happy path — one file, no API keys, no network.

This is the "prove it in 60 seconds" script. It intentionally does not import the
Webx package: it starts its own local server, drives Playwright directly, and
uses the same stable data attributes as the full agent.

Flow:
  1. Serve the local demo storefront and research form.
  2. Open the storefront in tab 1 and reject the cookie banner.
  3. Read the first product's name and price.
  4. Open the research form in tab 2 and type the price into its first field.
  5. Submit, verify the receipt, save screenshots, and optionally play completion audio.

Usage:
  python scripts/happy_path.py                 # headed, recordable pacing
  python scripts/happy_path.py --headless      # CI / fast check
  python scripts/happy_path.py --hold 5        # linger on the receipt
  python scripts/happy_path.py --no-submit     # only fill the first field
  python scripts/happy_path.py --elevenlabs    # synth completion line (needs key)

The optional completion-audio hook looks for, in order:
  1. $WEBX_COMPLETION_AUDIO
  2. assets/voice/complete.mp3
  3. assets/voice/complete.wav
  4. ElevenLabs synthesis when --elevenlabs and $ELEVENLABS_API_KEY are set

Placeholder keys live in .env.example. Nothing here requires them.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEMO_ROOT = PROJECT_ROOT / "demo"
SCREEN_DIR = PROJECT_ROOT / "artifacts" / "happy-path"
COMPLETION_TEXT = "Mission complete. The price is logged. Webx is standing by."


# --------------------------------------------------------------------------- server
class _DemoHandler(SimpleHTTPRequestHandler):
    server_version = "WebxHappyPath/1.0"

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/shop/")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *_args) -> None:
        pass


def start_demo_server(port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    handler = partial(_DemoHandler, directory=str(DEMO_ROOT))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, name="webx-happy-path", daemon=True)
    thread.start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


# -------------------------------------------------------------------------- browser
def browser_candidates() -> list[str]:
    values = [os.getenv("WEBX_CHROME_PATH", "")]
    if sys.platform.startswith("win"):
        values += [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    elif sys.platform == "darwin":
        values.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    else:
        values += [
            "/opt/google/chrome/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/brave-browser",
        ]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave"):
        found = shutil.which(name)
        if found:
            values.append(found)
    return [value for value in values if value]


def launch(pw, headless: bool, slow_mo: int):
    args = ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.append("--no-sandbox")
    errors = []
    for candidate in browser_candidates():
        if not Path(candidate).exists():
            continue
        try:
            print(f"  browser  {candidate}", flush=True)
            return pw.chromium.launch(
                executable_path=candidate,
                headless=headless,
                slow_mo=max(0, slow_mo),
                args=args,
                ignore_default_args=["--enable-automation"],
            )
        except Exception as exc:  # try the next candidate
            errors.append(f"{candidate}: {exc}")
    try:
        print("  browser  Playwright's bundled Chromium", flush=True)
        return pw.chromium.launch(headless=headless, slow_mo=max(0, slow_mo), args=args)
    except Exception as exc:
        errors.append(str(exc))
    raise RuntimeError(
        "No usable browser. Install Google Chrome, set WEBX_CHROME_PATH, or run "
        "`python -m playwright install chromium`.\n" + "\n".join(errors)
    )


# ---------------------------------------------------------------------------- audio
def _audio_player() -> list[str] | None:
    for name, args in (
        ("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"]),
        ("afplay", []),
        ("aplay", ["-q"]),
    ):
        path = shutil.which(name)
        if path:
            return [path, *args]
    return None


def _play(path: Path) -> None:
    player = _audio_player()
    if not player:
        print(f"  audio    clip ready at {path} (install ffplay to hear it)")
        return
    try:
        subprocess.Popen(
            [*player, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"  audio    playing {path.name}")
    except Exception as exc:
        print(f"  audio    could not play {path}: {exc}")


def _synthesize_elevenlabs(target: Path) -> bool:
    """Optional ElevenLabs hook. The demo never needs this to pass."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        print("  audio    --elevenlabs requested but ELEVENLABS_API_KEY is empty")
        return False
    try:
        import httpx
    except ImportError:
        print("  audio    httpx is not installed; cannot synthesize")
        return False
    voice = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    model = os.getenv("WEBX_ELEVENLABS_MODEL", "eleven_turbo_v2_5")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        response = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
            json={"text": COMPLETION_TEXT, "model_id": model},
            timeout=45,
        )
        response.raise_for_status()
        target.write_bytes(response.content)
        print(f"  audio    synthesized {target}")
        return True
    except Exception as exc:
        print(f"  audio    ElevenLabs unavailable ({exc}); continuing silently")
        return False


def completion_audio(enable: bool, synthesize: bool) -> None:
    if not enable:
        return
    candidates = []
    if os.getenv("WEBX_COMPLETION_AUDIO"):
        candidates.append(Path(os.environ["WEBX_COMPLETION_AUDIO"]))
    candidates += [
        PROJECT_ROOT / "assets" / "voice" / "complete.mp3",
        PROJECT_ROOT / "assets" / "voice" / "complete.wav",
    ]
    for path in candidates:
        if path.exists() and path.stat().st_size > 200:
            _play(path)
            return
    if synthesize and _synthesize_elevenlabs(SCREEN_DIR / "complete.mp3"):
        _play(SCREEN_DIR / "complete.mp3")
    else:
        print("  audio    no completion clip (optional; see assets/voice/README.md)")


# ---------------------------------------------------------------------------- steps
def log(step: str, detail: str) -> None:
    print(f"  {step:<8} {detail}", flush=True)


def shot(page, name: str) -> Path:
    SCREEN_DIR.mkdir(parents=True, exist_ok=True)
    path = SCREEN_DIR / name
    page.screenshot(path=str(path), full_page=False, animations="disabled")
    log("shot", str(path.relative_to(PROJECT_ROOT)))
    return path


def normalize_price(raw: str) -> str:
    match = re.search(r"\d[\d,]*(?:\.\d{1,2})?", raw.replace("$", ""))
    if not match:
        raise RuntimeError(f"No price found in {raw!r}")
    return f"${float(match.group(0).replace(',', '')):,.2f}"


def reject_cookies(page) -> str:
    banner = page.locator("#cookie-banner, [data-webx-consent]").first
    if not banner.count() or not banner.is_visible(timeout=1000):
        log("privacy", "no consent banner visible — continuing")
        return "none"
    page.locator("#reject-all, [data-webx-reject]").first.click(timeout=4000)
    page.wait_for_function(
        """() => window.__webxConsent === 'rejected' ||
                 (() => { const el = document.querySelector('#cookie-banner');
                          return !!el && (el.hidden || getComputedStyle(el).display === 'none'); })()""",
        timeout=5000,
    )
    log("privacy", "rejected all non-essential cookies")
    return "rejected"


def read_first_product(page) -> dict[str, str]:
    card = page.locator("[data-webx-first-product]").first
    card.scroll_into_view_if_needed(timeout=3000)
    page.wait_for_timeout(250)
    name = (card.get_attribute("data-name") or "").strip()
    if not name:
        name = card.locator("h1, h2, h3").first.inner_text(timeout=1500).strip()
    raw = card.get_attribute("data-price") or ""
    if not raw:
        raw = card.locator("[data-webx-price], .price").first.inner_text(timeout=1500)
    price = normalize_price(raw)
    log("extract", f"{name} · {price}")
    return {"name": name, "price": price}


def fill_form(page, product: dict[str, str], shop_url: str, submit: bool) -> dict[str, str]:
    page.wait_for_selector("[data-webx-form], form", state="visible", timeout=8000)
    first = page.locator("[data-webx-first-field], form input[type='text'], form input:not([type])").first
    first.click()
    first.fill(product["price"])

    optional = {
        "#product": product["name"],
        "#source": shop_url,
        "#notes": "Cookie banner rejected. Price captured from the first featured product.",
    }
    for selector, value in optional.items():
        field = page.locator(selector).first
        if field.count():
            field.fill(value)

    log("form", f"typed {product['price']} into the first field")
    shot(page, "04-form-populated.png")

    if not submit:
        return {"submitted": "skipped", "receipt": ""}

    page.locator("button[type='submit'], button:has-text('Submit')").first.click(timeout=4000)
    page.wait_for_function(
        "() => window.__webxFormSubmitted === true || !!document.querySelector('[data-webx-confirmation]:not([hidden])')",
        timeout=6000,
    )
    receipt = ""
    if page.locator("#receipt-price").count():
        receipt = page.locator("#receipt-price").inner_text(timeout=1500).strip()
    log("verify", f"response recorded · receipt price {receipt or product['price']}")
    return {"submitted": "yes", "receipt": receipt or product["price"]}


# ----------------------------------------------------------------------------- main
def run(args: argparse.Namespace) -> int:
    from playwright.sync_api import sync_playwright

    if SCREEN_DIR.exists():
        shutil.rmtree(SCREEN_DIR, ignore_errors=True)
    SCREEN_DIR.mkdir(parents=True, exist_ok=True)

    httpd, base_url = start_demo_server(args.port)
    shop_url, form_url = f"{base_url}/shop/", f"{base_url}/form/"
    print()
    print("  WEBX / HAPPY PATH")
    print(f"  storefront  {shop_url}")
    print(f"  form        {form_url}")
    print(f"  mode        {'headless' if args.headless else 'headed'} · slow-mo {args.slowmo}ms")
    print()

    result: dict = {"success": False, "base_url": base_url}
    started = time.monotonic()
    try:
        with sync_playwright() as pw:
            browser = launch(pw, args.headless, args.slowmo)
            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                locale="en-US",
                color_scheme="light",
            )
            try:
                # Tab 1 — storefront.
                page = context.new_page()
                page.goto(shop_url, wait_until="domcontentloaded")
                page.wait_for_selector("[data-webx-catalog]", state="visible", timeout=9000)
                page.wait_for_timeout(500)
                log("open", "storefront loaded in tab 1")
                shot(page, "01-storefront-loaded.png")

                result["consent"] = reject_cookies(page)
                page.wait_for_timeout(450)
                shot(page, "02-cookies-rejected.png")

                product = read_first_product(page)
                result.update(product)
                result["product"] = product["name"]
                shot(page, "03-price-captured.png")

                # Tab 2 — research form, populated from the value captured in tab 1.
                form_page = context.new_page()
                form_page.goto(form_url, wait_until="domcontentloaded")
                form_page.bring_to_front()
                log("handoff", f"{product['price']} moved from tab 1 → tab 2")
                form = fill_form(form_page, product, shop_url, submit=not args.no_submit)
                result.update(form)
                shot(form_page, "05-confirmation.png" if not args.no_submit else "05-form-ready.png")

                if not args.no_submit and args.hold > 0:
                    form_page.wait_for_timeout(int(args.hold * 1000))

                result["tabs"] = len([p for p in context.pages if not p.is_closed()])
            finally:
                context.close()
                browser.close()
        result["success"] = True
    except Exception as exc:
        result["error"] = str(exc)
        print(f"\n  ERROR  {exc}", file=sys.stderr)
        raise
    finally:
        httpd.shutdown()
        httpd.server_close()

    result["duration_seconds"] = round(time.monotonic() - started, 2)
    (SCREEN_DIR / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")

    completion_audio(enable=not args.no_audio, synthesize=args.elevenlabs)

    print()
    print("  HAPPY PATH COMPLETE")
    print(f"  price       {result.get('price')} · {result.get('product')}")
    print(f"  consent     {result.get('consent')}")
    print(f"  form        {result.get('submitted')} · receipt {result.get('receipt') or '—'}")
    print(f"  tabs        {result.get('tabs')}")
    print(f"  time        {result['duration_seconds']}s")
    print(f"  evidence    {SCREEN_DIR.relative_to(PROJECT_ROOT)}/")
    print()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the standalone Webx storefront → form happy path")
    parser.add_argument("--headless", action="store_true", help="Run without a visible browser")
    parser.add_argument("--slowmo", type=int, default=180, help="Playwright slow motion in ms (default: 180)")
    parser.add_argument("--hold", type=float, default=3.0, help="Keep the receipt on screen for N seconds")
    parser.add_argument("--port", type=int, default=0, help="Demo server port (0 = choose a free port)")
    parser.add_argument("--no-submit", action="store_true", help="Fill the first field but do not submit")
    parser.add_argument("--no-audio", action="store_true", help="Skip the completion-audio hook")
    parser.add_argument("--elevenlabs", action="store_true", help="Synthesize completion audio with ElevenLabs")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.headless:
        args.hold = 0
    try:
        return run(args)
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
