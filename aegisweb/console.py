"""Small dependency-free terminal renderer for agent events."""

from __future__ import annotations

import os
import sys
from typing import Any

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
GREEN = "\033[38;5;154m"
FOREST = "\033[38;5;114m"
AMBER = "\033[38;5;214m"
RED = "\033[38;5;203m"
BLUE = "\033[38;5;117m"
MUTED = "\033[38;5;245m"
WHITE = "\033[97m"

_KIND_STYLE = {
    "run": ("●", WHITE),
    "plan": ("◇", BLUE),
    "action": ("→", AMBER),
    "observe": ("◉", MUTED),
    "success": ("✓", GREEN),
    "warn": ("!", AMBER),
    "error": ("✗", RED),
    "extract": ("⌁", GREEN),
    "handoff": ("⇄", BLUE),
    "verify": ("✓", GREEN),
    "voice": ("♪", MUTED),
    "screenshot": ("▣", MUTED),
    "cloud": ("☁", BLUE),
}


def supports_color() -> bool:
    return sys.stdout.isatty() and os.getenv("NO_COLOR") is None


def paint(text: str, color: str) -> str:
    return f"{color}{text}{RESET}" if supports_color() else text


def render_event(event: dict[str, Any]) -> str:
    icon, color = _KIND_STYLE.get(event.get("kind", ""), ("·", MUTED))
    kind = event.get("kind", "event").upper()
    elapsed = event.get("elapsed", 0)
    stamp = paint(f"+{elapsed:05.1f}s", DIM)
    label = paint(f"{icon} {kind:<10}", color)
    title = paint(event.get("title", ""), BOLD if event.get("status") != "info" else "")
    line = f"{stamp}  {label}  {title}"
    detail = event.get("detail")
    if detail:
        line += "\n" + " " * 17 + paint(detail, MUTED)
    return line


def print_banner(mission: str, mode: str = "GUARDED AUTONOMY") -> None:
    rule = "─" * 66
    print()
    print(paint("  A E G I S W E B", GREEN) + paint("   /   AI BROWSER AGENT", MUTED))
    print(paint(f"  {rule}", DIM))
    print(paint(f"  MODE   {mode}", FOREST))
    print(paint(f"  TASK   {mission}", MUTED))
    print(paint(f"  {rule}", DIM))
    print()


def print_summary(result: dict[str, Any], report_path: str | None = None) -> None:
    ok = result.get("success", False)
    header = paint("  MISSION COMPLETE", GREEN) if ok else paint("  MISSION FAILED", RED)
    print()
    print(paint("  " + "─" * 66, DIM))
    print(header)
    if ok:
        print(
            f"  price {paint(str(result.get('price', '—')), WHITE)}"
            f"   ·   {result.get('trackers_blocked', 0)} trackers blocked"
            f"   ·   {result.get('tabs', 0)} tabs orchestrated"
            f"   ·   form {paint('recorded', GREEN)}"
        )
    else:
        print(f"  {result.get('error', 'The run stopped before completion.')}")
    if report_path:
        print(paint(f"  report  {report_path}", MUTED))
    print(paint("  " + "─" * 66, DIM))
    print()
