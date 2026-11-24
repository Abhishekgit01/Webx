"""Voice hooks: ElevenLabs TTS with a local-file override and graceful silence.

The demo's primary voice layer is the browser's built-in speech synthesis in the
dashboard. This module is for the "studio voice" version: drop pre-rendered files
into assets/voice/ (see scripts/generate_tts.py), or set ELEVENLABS_API_KEY.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from .config import Settings


class VoiceEngine:
    def __init__(self, settings: Settings, bus=None) -> None:
        self.settings = settings
        self.bus = bus
        self.enabled = bool(settings.audio)
        self._cache_dir = Path(settings.artifacts_dir) / "latest" / "voice"
        self._procs: list[subprocess.Popen] = []
        self._warned = False

    def _candidate_paths(self, key: str) -> list[Path]:
        safe = re.sub(r"[^a-z0-9_-]+", "-", key.lower()).strip("-")
        env_key = f"AEGIS_VOICE_{safe.upper().replace('-', '_')}"
        paths: list[Path] = []
        env_path = os.getenv(env_key)
        if env_path:
            paths.append(Path(env_path))
        for ext in (".mp3", ".wav", ".m4a", ".ogg"):
            paths.append(Path(self.settings.voice_dir) / f"{safe}{ext}")
            paths.append(self._cache_dir / f"{safe}{ext}")
        return paths

    @property
    def has_local_pack(self) -> bool:
        try:
            return any(p.suffix.lower() in {".mp3", ".wav"} for p in Path(self.settings.voice_dir).glob("*"))
        except OSError:
            return False

    def say(self, key: str, text: str) -> str | None:
        """Play a cached clip or synthesize one. Returns the audio path if played."""
        if not self.enabled:
            return None
        for path in self._candidate_paths(key):
            if path.exists() and path.stat().st_size > 200:
                self._play(path)
                return str(path)
        if self.settings.elevenlabs_api_key:
            path = self._synthesize(key, text)
            if path:
                self._play(path)
                return str(path)
        return None

    def play_completion(self) -> str | None:
        """The explicit end-of-demo audio hook.

        Priority:
          1. AEGIS_COMPLETION_AUDIO environment variable
          2. assets/voice/complete.mp3
          3. assets/voice/complete.wav
        """
        paths = []
        env_path = os.getenv("AEGIS_COMPLETION_AUDIO")
        if env_path:
            paths.append(Path(env_path))
        paths.extend([Path(self.settings.voice_dir) / "complete.mp3", Path(self.settings.voice_dir) / "complete.wav"])
        for path in paths:
            if path.exists() and path.stat().st_size > 200:
                if self.enabled:
                    self._play(path)
                return str(path)
        return None

    def _synthesize(self, key: str, text: str) -> Path | None:
        try:
            import httpx
        except Exception:
            return None
        safe = re.sub(r"[^a-z0-9_-]+", "-", key.lower()).strip("-")
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        target = self._cache_dir / f"{safe}.mp3"
        if target.exists() and target.stat().st_size > 200:
            return target
        try:
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.settings.elevenlabs_voice_id}"
            response = httpx.post(
                url,
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": self.settings.elevenlabs_api_key, "accept": "audio/mpeg"},
                json={
                    "text": text,
                    "model_id": self.settings.elevenlabs_model,
                    "voice_settings": {"stability": 0.48, "similarity_boost": 0.78, "style": 0.15, "use_speaker_boost": True},
                },
                timeout=30,
            )
            response.raise_for_status()
            target.write_bytes(response.content)
            return target
        except Exception:
            return None

    def _play(self, path: Path) -> None:
        player = shutil.which("ffplay")
        command: list[str] | None = None
        if player:
            command = [player, "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)]
        elif path.suffix.lower() == ".wav" and shutil.which("aplay"):
            command = ["aplay", "-q", str(path)]
        elif path.suffix.lower() == ".mp3" and shutil.which("afplay"):
            command = ["afplay", str(path)]
        if not command:
            return
        try:
            proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self._procs.append(proc)
            self._procs = [p for p in self._procs if p.poll() is None]
        except Exception:
            pass

    def close(self) -> None:
        # Detach rather than kill: the final line should be allowed to finish.
        self._procs = []
