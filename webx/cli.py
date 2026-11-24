"""Webx command line: demo, mission control, doctor."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import shutil
import sys

from . import __version__
from .agent import WebxAgent
from .browser import find_browser
from .config import PROJECT_ROOT, load_settings
from .console import print_banner, print_summary, render_event
from .demo_server import DemoServer
from .events import EventBus

DEFAULT_TASK = (
    "Navigate to the demo storefront, reject the cookie banner, grab the price of "
    "the first item, and save it to the research form."
)


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "not installed"


def cmd_demo(args: argparse.Namespace) -> int:
    settings = load_settings(
        headless=args.headless,
        slow_mo=args.slowmo,
        pace=args.pace,
        audio=args.audio,
        narration=not args.no_narration,
        hold_seconds=args.hold,
    )
    if args.headless:
        settings = settings.with_overrides(headless=True)

    server: DemoServer | None = None
    if args.base_url:
        settings = settings.with_overrides(demo_base_url=args.base_url)
    else:
        server = DemoServer(settings.host, args.port).start()
        settings = settings.with_overrides(demo_base_url=server.base_url)

    bus = EventBus(on_event=lambda event: print(render_event(event), flush=True))
    print_banner(args.task, mode="GUARDED RUNBOOK")
    if server:
        print(f"  demo  {server.base_url}/shop/  →  {server.base_url}/form/")
        print()

    try:
        agent = WebxAgent(settings, bus)
        result = agent.run(args.task)
    except KeyboardInterrupt:
        print("\n  Mission interrupted.")
        return 130
    finally:
        if server:
            server.stop()

    print_summary(result, result.get("report_path"))
    if settings.audio:
        print("  audio  enabled (ElevenLabs / local voice pack)")
    return 0 if result.get("success") else 1


def cmd_serve(args: argparse.Namespace) -> int:
    from .dashboard import serve

    settings = load_settings(
        dashboard_port=args.port,
        demo_port=args.demo_port,
        headless=False,
    )
    try:
        serve(settings, open_browser=not args.no_open)
    except KeyboardInterrupt:
        print("\n  Mission control stopped.")
        return 0
    except OSError as exc:
        print(f"  Could not start mission control: {exc}", file=sys.stderr)
        print(f"  Is port {args.port} already in use?", file=sys.stderr)
        return 1
    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    settings = load_settings()
    python = sys.version.split()[0]
    browser = find_browser(settings)
    print()
    print("  WEBX / DOCTOR")
    print("  " + "─" * 58)
    print(f"  python        {python}")
    print(f"  project       {PROJECT_ROOT}")
    print(f"  playwright    {_package_version('playwright')}")
    print(f"  fastapi       {_package_version('fastapi')}")
    print(f"  uvicorn       {_package_version('uvicorn')}")
    print(f"  browser       {browser or 'NOT FOUND'}")
    print(f"  ffplay        {shutil.which('ffplay') or 'not found (server-side audio disabled)'}")
    print(f"  demo pages    {PROJECT_ROOT / 'demo'}")
    print(f"  artifacts     {settings.artifacts_dir}")
    print()
    print("  keys")
    print(f"    OPENAI_API_KEY       {'set' if settings.openai_api_key else 'not set (optional)'}")
    print(f"    ANTHROPIC_API_KEY    {'set' if settings.anthropic_api_key else 'not set (optional)'}")
    print(f"    ELEVENLABS_API_KEY   {'set' if settings.elevenlabs_api_key else 'not set (optional)'}")
    print(f"    WEBX_CLOUD_URL       {'set' if settings.cloud_url else 'not set (optional)'}")
    print()
    voice_files = list((PROJECT_ROOT / "assets" / "voice").glob("*.mp3"))
    print(f"  voice pack    {len(voice_files)} file(s) in assets/voice/")
    print()
    ok = bool(browser)
    print("  " + ("READY — run `python -m webx demo` or `python -m webx serve`" if ok else
                  "MISSING BROWSER — install Chrome or run: python -m playwright install chromium"))
    print()
    return 0 if ok else 1


def cmd_tts(tts_args: list[str]) -> int:
    script = PROJECT_ROOT / "scripts" / "generate_tts.py"
    os.execv(sys.executable, [sys.executable, str(script), *tts_args])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="webx",
        description="Webx — AI browser agent for privacy, navigation, and cross-tab work.",
    )
    parser.add_argument("--version", action="version", version=f"Webx {__version__}")
    sub = parser.add_subparsers(dest="command")

    demo = sub.add_parser("demo", help="Run the deterministic storefront → form mission")
    demo.add_argument("--task", default=DEFAULT_TASK, help="Natural-language mission brief")
    demo.add_argument("--base-url", default="", help="Use an already-running demo server")
    demo.add_argument("--port", type=int, default=4173, help="Local demo server port")
    demo.add_argument("--headless", action="store_true", help="Run without a visible browser")
    demo.add_argument("--slowmo", type=int, default=280, help="Playwright slow-motion in ms")
    demo.add_argument("--pace", type=float, default=1.0, help="Scale narration pauses (0 = instant)")
    demo.add_argument("--audio", action="store_true", help="Play ElevenLabs/local voice clips")
    demo.add_argument("--no-narration", action="store_true", help="Disable narration text")
    demo.add_argument("--hold", type=float, default=3.0, help="Keep final tab open for N seconds (headed)")
    demo.set_defaults(func=cmd_demo)

    serve = sub.add_parser("serve", help="Launch the Mission Control dashboard and local demo")
    serve.add_argument("--port", type=int, default=8000, help="Dashboard port")
    serve.add_argument("--demo-port", type=int, default=4173, help="Storefront/form port")
    serve.add_argument("--no-open", action="store_true", help="Do not auto-open the dashboard")
    serve.set_defaults(func=cmd_serve)

    doctor = sub.add_parser("doctor", help="Check browser, dependencies, and optional integrations")
    doctor.set_defaults(func=cmd_doctor)

    tts = sub.add_parser(
        "tts",
        help="Generate the ElevenLabs voice pack (passes all remaining args to the script)",
        add_help=False,
    )
    tts.add_argument("tts_args", nargs=argparse.REMAINDER)
    tts.set_defaults(func=lambda _args: 0)

    return parser


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # `tts` options belong to scripts/generate_tts.py, not to this parser.
    if raw and raw[0] == "tts":
        return cmd_tts(raw[1:])

    parser = build_parser()
    args = parser.parse_args(raw)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
