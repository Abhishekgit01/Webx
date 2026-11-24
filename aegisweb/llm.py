"""Optional vision-language fallback.

The recorded demo never depends on this module: DOM/ARIA selectors are tried first
and the local site is deterministic. When a selector fails and an OpenAI/Anthropic
key is configured, AegisWeb can look at the screenshot and click the described
control. That is the "self-healing" escape hatch for redesigned external sites.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any

from .config import Settings

_PROMPT = """You are a browser automation vision model.
Find the UI control described below in this screenshot and return its click point.
Return ONLY compact JSON: {"found": true, "x": <css pixels from left>, "y": <css pixels from top>, "reason": "..."}.
If it is not visible, return {"found": false, "x": 0, "y": 0, "reason": "..."}.
Never guess wildly. The screenshot is WIDTHxHEIGHT CSS pixels."""


def _build_prompt(description: str, width: int, height: int) -> str:
    prompt = _PROMPT.replace("WIDTH", str(width)).replace("HEIGHT", str(height))
    return prompt + f"\n\nTarget control: {description}"


def vision_available(settings: Settings) -> bool:
    return bool(settings.openai_api_key or settings.anthropic_api_key)


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON in model response")
    return json.loads(match.group(0))


def _openai_locate(image_b64: str, description: str, width: int, height: int, settings: Settings) -> dict:
    import httpx

    prompt = _build_prompt(description, width, height)
    response = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {settings.openai_api_key}"},
        json={
            "model": settings.openai_model,
            "temperature": 0,
            "max_tokens": 200,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                    ],
                }
            ],
        },
        timeout=30,
    )
    response.raise_for_status()
    return _extract_json(response.json()["choices"][0]["message"]["content"])


def _anthropic_locate(image_b64: str, description: str, width: int, height: int, settings: Settings) -> dict:
    import httpx

    prompt = _build_prompt(description, width, height)
    response = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": settings.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": settings.anthropic_model,
            "max_tokens": 300,
            "temperature": 0,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/png", "data": image_b64},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return _extract_json(data["content"][0]["text"])


def locate_and_click(page, description: str, settings: Settings) -> dict[str, Any] | None:
    """Ask a vision model where a control is, then click it. Returns metadata or None."""
    if not vision_available(settings):
        return None
    shot = Path(settings.artifacts_dir) / "latest" / "vision-request.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(shot), full_page=False)
        image_b64 = base64.b64encode(shot.read_bytes()).decode("ascii")
        viewport = page.viewport_size or {"width": settings.viewport_width, "height": settings.viewport_height}
        if settings.openai_api_key:
            result = _openai_locate(image_b64, description, viewport["width"], viewport["height"], settings)
            provider = "openai"
        else:
            result = _anthropic_locate(image_b64, description, viewport["width"], viewport["height"], settings)
            provider = "anthropic"
        if not result.get("found"):
            return None
        x = max(1, min(float(result["x"]), viewport["width"] - 1))
        y = max(1, min(float(result["y"]), viewport["height"] - 1))
        page.mouse.click(x, y)
        return {"provider": provider, "x": x, "y": y, "reason": str(result.get("reason", ""))[:240]}
    except Exception:
        return None
