"""Turn a natural-language mission into a bounded, executable brief.

The recorded demo runs a guarded runbook. This parser lets the same runbook accept
new URLs and confirm which skills the user asked for, without pretending an LLM is
required for the happy path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

URL_RE = re.compile(r"https?://[^\s<>\"']+")
PRICE_RE = re.compile(r"(?:price|cost|amount|\$|usd)", re.IGNORECASE)
PRIVACY_RE = re.compile(r"(?:cookie|consent|privacy|tracker|reject)", re.IGNORECASE)
FORM_RE = re.compile(r"(?:form|save|submit|log|record|spreadsheet|sheet)", re.IGNORECASE)
PRODUCT_WORDS = re.compile(r"(?:first|top|featured|cheapest|most expensive|product|item)", re.IGNORECASE)


def _clean_url(url: str) -> str:
    return url.rstrip(".,;:!?)'\"]")


@dataclass
class Mission:
    task: str
    shop_url: str
    form_url: str
    wants_privacy: bool = True
    wants_price: bool = True
    wants_form: bool = True
    custom_urls: bool = False
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "task": self.task,
            "shop_url": self.shop_url,
            "form_url": self.form_url,
            "wants_privacy": self.wants_privacy,
            "wants_price": self.wants_price,
            "wants_form": self.wants_form,
            "custom_urls": self.custom_urls,
        }


def parse_mission(task: str, default_shop: str, default_form: str) -> Mission:
    """Extract URLs and intent. Uses defaults for the local, offline demo."""
    urls = []
    for raw in URL_RE.findall(task):
        cleaned = _clean_url(raw)
        if cleaned not in urls:
            urls.append(cleaned)

    notes: list[str] = []
    if len(urls) >= 2:
        shop_url, form_url = urls[0], urls[1]
        notes.append("Using the two URLs found in the mission brief.")
    elif len(urls) == 1:
        only = urls[0]
        path = urlparse(only).path.lower()
        if "form" in path or "form" in only.lower():
            shop_url, form_url = default_shop, only
            notes.append("Using the provided form URL with the local demo shop.")
        else:
            shop_url, form_url = only, default_form
            notes.append("Using the provided shop URL with the local research form.")
    else:
        shop_url, form_url = default_shop, default_form

    custom_urls = bool(urls)
    wants_privacy = bool(PRIVACY_RE.search(task)) or not custom_urls
    wants_price = bool(PRICE_RE.search(task)) or bool(PRODUCT_WORDS.search(task)) or not custom_urls
    wants_form = bool(FORM_RE.search(task)) or not custom_urls

    return Mission(
        task=task.strip(),
        shop_url=shop_url,
        form_url=form_url,
        wants_privacy=wants_privacy,
        wants_price=wants_price,
        wants_form=wants_form,
        custom_urls=custom_urls,
        notes=notes,
    )
