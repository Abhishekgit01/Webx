#!/usr/bin/env python3
"""Generate the Webx studio voice pack with ElevenLabs.

Usage:
  export ELEVENLABS_API_KEY=...
  python scripts/generate_tts.py                 # full 5-line pack
  python scripts/generate_tts.py --force         # re-render existing clips
  python scripts/generate_tts.py --text "..." --out assets/voice/complete.mp3

The agent looks for these keys in assets/voice/:
  intro.mp3, privacy.mp3, extract.mp3, handoff.mp3, complete.mp3

You can also drop any ElevenLabs export into assets/voice/complete.mp3 and run
`python -m webx demo --audio`. No API key is needed for playback.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"  # Rachel
DEFAULT_MODEL = "eleven_turbo_v2_5"

LINES = {
    "intro": "Webx online. Mission accepted. I’ll handle the cookie banner, capture the first price, and carry it across your tabs.",
    "privacy": "Privacy shield engaged. All non-essential cookies rejected. Three tracker requests blocked at the network layer.",
    "extract": "Captured one hundred forty-nine dollars for the Ridgeline Field Lantern.",
    "handoff": "Cross tab handoff complete. Filling the research form now.",
    "complete": "Mission complete. The price is logged. Webx is standing by.",
}


def synthesize(text: str, out: Path, voice_id: str, model: str, api_key: str) -> None:
    try:
        import httpx
    except ImportError:
        print("httpx is required. Install it with: python -m pip install httpx", file=sys.stderr)
        raise SystemExit(2)

    out.parent.mkdir(parents=True, exist_ok=True)
    response = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
        json={
            "text": text,
            "model_id": model,
            "voice_settings": {
                "stability": 0.48,
                "similarity_boost": 0.78,
                "style": 0.18,
                "use_speaker_boost": True,
            },
        },
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"ElevenLabs {response.status_code}: {response.text[:300]}")
    out.write_bytes(response.content)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Webx ElevenLabs voice clips")
    parser.add_argument("--text", help="Generate one custom line instead of the full pack")
    parser.add_argument("--out", default="", help="Output path for --text")
    parser.add_argument("--voice-id", default=os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE))
    parser.add_argument("--model", default=os.getenv("WEBX_ELEVENLABS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--out-dir", default=str(PROJECT_ROOT / "assets" / "voice"))
    parser.add_argument("--force", action="store_true", help="Overwrite existing clips")
    parser.add_argument("--dry-run", action="store_true", help="Print lines without calling the API")
    args = parser.parse_args()

    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    out_dir = Path(args.out_dir)

    if args.text:
        target = Path(args.out) if args.out else out_dir / "complete.mp3"
        if args.dry_run or not api_key:
            print(f"[dry-run] {target} :: {args.text}")
            if not api_key:
                print("Set ELEVENLABS_API_KEY to generate the clip.", file=sys.stderr)
                return 2
            return 0
        if target.exists() and not args.force:
            print(f"exists: {target} (use --force to overwrite)")
            return 0
        synthesize(args.text, target, args.voice_id, args.model, api_key)
        print(f"wrote {target} ({target.stat().st_size // 1024} KB)")
        return 0

    if args.dry_run:
        for key, line in LINES.items():
            print(f"{key:9s} {line}")
        return 0

    if not api_key:
        print("ELEVENLABS_API_KEY is not set.\n", file=sys.stderr)
        print("Option A: export ELEVENLABS_API_KEY=... and rerun this script.", file=sys.stderr)
        print("Option B: record/export your own clips and drop them in assets/voice/.", file=sys.stderr)
        print("Expected keys: intro, privacy, extract, handoff, complete (mp3).", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "provider": "elevenlabs",
        "voiceId": args.voice_id,
        "model": args.model,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "clips": {},
    }

    for key, line in LINES.items():
        target = out_dir / f"{key}.mp3"
        if target.exists() and not args.force and target.stat().st_size > 200:
            print(f"skip   {target.name} (use --force to overwrite)")
        else:
            print(f"render {key:9s} …", end="", flush=True)
            synthesize(line, target, args.voice_id, args.model, api_key)
            print(f" {target.stat().st_size // 1024} KB")
        manifest["clips"][key] = {"file": target.name, "text": line}

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print()
    print(f"Voice pack ready in {out_dir}")
    print("Run the demo with studio audio:")
    print("  python -m webx demo --audio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
