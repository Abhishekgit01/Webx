"""Runtime configuration for AegisWeb."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ARTIFACTS = PROJECT_ROOT / "artifacts"
DEFAULT_ASSETS = PROJECT_ROOT / "assets"


def _load_dotenv() -> None:
    """Load .env when python-dotenv is available (it is optional)."""
    env_file = PROJECT_ROOT / ".env"
    if not env_file.exists():
        return
    try:
        from dotenv import load_dotenv

        load_dotenv(env_file, override=False)
    except Exception:
        # A missing optional dependency must never break the demo.
        return


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """All tunables in one place. Override with environment variables or CLI flags."""

    # Demo surface
    demo_base_url: str | None = None
    shop_path: str = "/shop/"
    form_path: str = "/form/"
    host: str = "127.0.0.1"
    demo_port: int = 4173
    dashboard_port: int = 8000

    # Browser
    headless: bool = False
    slow_mo: int = 280
    pace: float = 1.0
    viewport_width: int = 1440
    viewport_height: int = 900
    chrome_path: str | None = None
    artifacts_dir: Path = DEFAULT_ARTIFACTS
    assets_dir: Path = DEFAULT_ASSETS

    # Personality
    audio: bool = False
    narration: bool = True
    hold_seconds: float = 3.0

    # Integrations (all optional)
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-5-sonnet-latest"
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"  # Rachel
    elevenlabs_model: str = "eleven_turbo_v2_5"
    cloud_url: str = ""
    cloud_token: str = ""

    # Agent behavior
    vision_fallback: bool = True
    max_retries: int = 3
    extra: dict = field(default_factory=dict, compare=False)

    @property
    def demo_origin(self) -> str:
        if self.demo_base_url:
            return self.demo_base_url.rstrip("/")
        return f"http://{self.host}:{self.demo_port}"

    @property
    def shop_url(self) -> str:
        return f"{self.demo_origin}{self.shop_path}"

    @property
    def form_url(self) -> str:
        return f"{self.demo_origin}{self.form_path}"

    @property
    def latest_dir(self) -> Path:
        return Path(self.artifacts_dir) / "latest"

    @property
    def voice_dir(self) -> Path:
        return Path(self.assets_dir) / "voice"

    def with_overrides(self, **kwargs) -> "Settings":
        return replace(self, **kwargs)

    def integration_status(self) -> dict[str, bool]:
        return {
            "openai": bool(self.openai_api_key),
            "anthropic": bool(self.anthropic_api_key),
            "elevenlabs": bool(self.elevenlabs_api_key),
            "cloud": bool(self.cloud_url),
        }

    def public_dict(self) -> dict:
        return {
            "demo_origin": self.demo_origin,
            "shop_url": self.shop_url,
            "form_url": self.form_url,
            "headless": self.headless,
            "slow_mo": self.slow_mo,
            "integrations": self.integration_status(),
        }


def load_settings(**overrides) -> Settings:
    """Build settings from .env + process environment, then apply explicit overrides."""
    _load_dotenv()
    settings = Settings(
        demo_base_url=os.getenv("AEGIS_DEMO_URL") or None,
        host=os.getenv("AEGIS_HOST", "127.0.0.1"),
        demo_port=_env_int("AEGIS_DEMO_PORT", 4173),
        dashboard_port=_env_int("AEGIS_DASHBOARD_PORT", 8000),
        headless=_env_bool("AEGIS_HEADLESS", False),
        slow_mo=_env_int("AEGIS_SLOWMO", 280),
        pace=_env_float("AEGIS_PACE", 1.0),
        viewport_width=_env_int("AEGIS_VIEWPORT_WIDTH", 1440),
        viewport_height=_env_int("AEGIS_VIEWPORT_HEIGHT", 900),
        chrome_path=os.getenv("AEGIS_CHROME_PATH") or None,
        artifacts_dir=Path(os.getenv("AEGIS_ARTIFACTS_DIR", str(DEFAULT_ARTIFACTS))),
        assets_dir=Path(os.getenv("AEGIS_ASSETS_DIR", str(DEFAULT_ASSETS))),
        audio=_env_bool("AEGIS_AUDIO", False),
        narration=_env_bool("AEGIS_NARRATION", True),
        hold_seconds=_env_float("AEGIS_HOLD", 3.0),
        openai_api_key=os.getenv("OPENAI_API_KEY", ""),
        openai_model=os.getenv("AEGIS_OPENAI_MODEL", "gpt-4o"),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        anthropic_model=os.getenv("AEGIS_ANTHROPIC_MODEL", "claude-3-5-sonnet-latest"),
        elevenlabs_api_key=os.getenv("ELEVENLABS_API_KEY", ""),
        elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
        elevenlabs_model=os.getenv("AEGIS_ELEVENLABS_MODEL", "eleven_turbo_v2_5"),
        cloud_url=os.getenv("AEGIS_CLOUD_URL", ""),
        cloud_token=os.getenv("AEGIS_CLOUD_TOKEN", ""),
        vision_fallback=_env_bool("AEGIS_VISION_FALLBACK", True),
        max_retries=_env_int("AEGIS_MAX_RETRIES", 3),
    )
    if overrides:
        settings = settings.with_overrides(**overrides)
    return settings
