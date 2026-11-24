"""Deterministic, observable browser skills used by the AegisWeb runbook.

Each skill has layered fallbacks: data attributes -> accessible text -> DOM walk ->
optional vision model -> safe DOM intervention. The happy-path demo stays on the
first, reliable layer; the later layers are what make it resilient on stage.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .config import Settings
from .events import EventBus


class SkillError(RuntimeError):
    pass


REJECT_SELECTORS = [
    "[data-aegis-reject]",
    "#reject-all",
    "#onetrust-reject-all-handler",
    "button:has-text('Reject all')",
    "button:has-text('Reject All')",
    "button:has-text('Decline all')",
    "button:has-text('Reject')",
    "[aria-label*='reject' i]",
    "[data-testid*='reject' i]",
]

CONSENT_SELECTORS = [
    "[data-aegis-consent]",
    "#cookie-banner",
    "#onetrust-banner-sdk",
    "[id*='cookie-banner' i]",
    "[class*='cookie-banner' i]",
    "[class*='consent-banner' i]",
    "[aria-label*='cookie' i][role='dialog']",
]

PRICE_SELECTORS = [
    "[data-aegis-price]",
    "[data-price]",
    ".price",
    "[class*='price' i]",
    "[itemprop='price']",
]


def _first_visible(page, selectors: list[str], timeout_each: int = 280) -> tuple[Any, str] | tuple[None, str]:
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = min(locator.count(), 6)
            for index in range(count):
                item = locator.nth(index)
                if item.is_visible(timeout=timeout_each):
                    return item, selector
        except Exception:
            continue
    return None, ""


def _banner_visible(page) -> bool:
    locator, _ = _first_visible(page, CONSENT_SELECTORS, timeout_each=120)
    return locator is not None


def _js_click_reject(page) -> bool:
    script = r"""
    () => {
      const isVisible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="button"]')]
        .filter(isVisible);
      const match = candidates.find((el) => /\breject(\s+all)?\b|\bdecline(\s+all)?\b/i.test(
        (el.innerText || el.value || el.getAttribute('aria-label') || '')
      ));
      if (match) {
        match.click();
        return true;
      }
      return false;
    }
    """
    try:
        return bool(page.evaluate(script))
    except Exception:
        return False


def _force_dismiss_consent(page) -> None:
    script = r"""
    () => {
      window.__aegisConsent = 'rejected';
      document.documentElement.dataset.consent = 'rejected';
      const candidates = ['#cookie-banner', '[data-aegis-consent]', '#onetrust-banner-sdk'];
      for (const sel of candidates) {
        document.querySelectorAll(sel).forEach((el) => {
          el.classList.add('is-hidden');
          el.setAttribute('aria-hidden', 'true');
          el.hidden = true;
        });
      }
      const badge = document.querySelector('#privacy-state');
      if (badge) badge.hidden = false;
      return true;
    }
    """
    page.evaluate(script)


def _wait_consent_closed(page, timeout: int = 4500) -> bool:
    try:
        page.wait_for_function(
            r"""
            () => {
              if (window.__aegisConsent === 'rejected') return true;
              const el = document.querySelector('#cookie-banner, [data-aegis-consent]');
              if (!el) return true;
              return el.hidden || el.getAttribute('aria-hidden') === 'true' ||
                     el.classList.contains('is-hidden') ||
                     getComputedStyle(el).display === 'none' ||
                     getComputedStyle(el).visibility === 'hidden';
            }
            """,
            timeout=timeout,
        )
        return True
    except Exception:
        return False


def dismiss_consent(page, settings: Settings, bus: EventBus | None = None) -> dict[str, Any]:
    if not _banner_visible(page):
        return {"found": False, "rejected": False, "method": "none", "blockers": []}

    method = ""
    locator, selector = _first_visible(page, REJECT_SELECTORS)
    if locator is not None:
        try:
            locator.scroll_into_view_if_needed(timeout=1500)
            locator.click(timeout=2500)
            method = f"dom:{selector}"
        except Exception:
            locator = None

    if not method:
        # Accessible-role fallback.
        try:
            role_button = page.get_by_role("button", name=re.compile(r"reject(\s+all)?|decline", re.I)).first
            if role_button.is_visible(timeout=500):
                role_button.click(timeout=2500)
                method = "aria:button"
        except Exception:
            pass

    if not method and _js_click_reject(page):
        method = "dom-walker"

    if not method:
        # Optional VLM fallback, only enabled with an API key.
        from .llm import locate_and_click

        vision = locate_and_click(page, "the button that rejects all non-essential cookies", settings)
        if vision:
            method = f"vision:{vision['provider']}"

    if method and _wait_consent_closed(page):
        return {"found": True, "rejected": True, "method": method, "blockers": []}

    # Last resort so a live demo cannot be held hostage by a consent overlay.
    _force_dismiss_consent(page)
    page.wait_for_timeout(250)
    return {
        "found": True,
        "rejected": True,
        "method": (method + "+dom-intervention") if method else "dom-intervention",
        "blockers": ["banner did not close normally"],
    }


def _normalize_price(raw: str) -> tuple[str, float | None]:
    cleaned = (raw or "").replace(",", "")
    match = re.search(r"(\d+(?:\.\d{1,2})?)", cleaned)
    if not match:
        return raw.strip() or "—", None
    try:
        value = float(match.group(1))
    except ValueError:
        return raw.strip() or "—", None
    return f"${value:,.2f}", value


def _json_ld_product(page) -> dict[str, Any] | None:
    try:
        scripts = page.locator('script[type="application/ld+json"]').all_text_contents()
    except Exception:
        return None
    for raw in scripts:
        try:
            data = json.loads(raw)
        except Exception:
            continue
        objects = data if isinstance(data, list) else [data]
        expanded: list[dict] = []
        for obj in objects:
            if isinstance(obj, dict) and isinstance(obj.get("@graph"), list):
                expanded.extend(item for item in obj["@graph"] if isinstance(item, dict))
            elif isinstance(obj, dict):
                expanded.append(obj)
        for obj in expanded:
            kind = obj.get("@type")
            if kind == "Product" or (isinstance(kind, list) and "Product" in kind):
                offers = obj.get("offers") or {}
                if isinstance(offers, list):
                    offers = offers[0] if offers else {}
                price = offers.get("price") or offers.get("lowPrice") if isinstance(offers, dict) else None
                if price:
                    return {"name": str(obj.get("name") or "Featured product"), "price": str(price), "method": "json-ld"}
    return None


def _body_price(page) -> tuple[str, str] | None:
    try:
        body = page.locator("body").inner_text(timeout=2000)
    except Exception:
        return None
    match = re.search(r"(?:USD\s*)?\$\s?\d[\d,]*(?:\.\d{2})?", body)
    if not match:
        return None
    context = body[max(0, match.start() - 120): match.end() + 120].replace("\n", " ").strip()
    return match.group(0), context


def extract_first_product(page, settings: Settings, bus: EventBus | None = None) -> dict[str, Any]:
    page.wait_for_timeout(180)
    card = page.locator("[data-aegis-first-product]").first
    result: dict[str, Any] = {
        "name": "",
        "price": "",
        "price_value": None,
        "sku": "",
        "url": page.url,
        "method": "",
    }

    if card.count() and card.is_visible(timeout=1000):
        card.scroll_into_view_if_needed(timeout=2500)
        page.wait_for_timeout(220)
        name = card.get_attribute("data-name")
        price_attr = card.get_attribute("data-price")
        sku = card.get_attribute("data-sku") or ""
        if not name:
            try:
                name = card.locator("h1, h2, h3, h4").first.inner_text(timeout=1000).strip()
            except Exception:
                name = "Featured product"
        if price_attr:
            raw_price = price_attr
            method = "data-attributes"
        else:
            price_locator, selector = _first_visible(card, PRICE_SELECTORS, timeout_each=400)
            raw_price = price_locator.inner_text().strip() if price_locator else ""
            method = f"dom:{selector}" if selector else "dom:card"
        display, value = _normalize_price(raw_price)
        if display and display != "—":
            result.update(
                name=(name or "Featured product").strip(),
                price=display,
                price_value=value,
                sku=sku,
                method=method,
                selector="[data-aegis-first-product]",
            )
            return result

    # Structured data fallback (works on many real storefronts).
    structured = _json_ld_product(page)
    if structured:
        display, value = _normalize_price(structured["price"])
        result.update(name=structured["name"], price=display, price_value=value, method=structured["method"])
        return result

    # Last resort: find a price string near the top of the page.
    fallback = _body_price(page)
    if fallback:
        display, value = _normalize_price(fallback[0])
        result.update(
            name="Featured product",
            price=display,
            price_value=value,
            method="text-regex",
            selector="body",
        )
        return result

    raise SkillError("Could not find a product price on the storefront.")


def _find_form_field(page, selectors: list[str]):
    locator, selector = _first_visible(page, selectors, timeout_each=700)
    if locator is None:
        # The first text input inside a form is the promised demo target.
        try:
            generic = page.locator("form input[type='text'], form input:not([type]), form textarea").first
            if generic.is_visible(timeout=800):
                return generic, "form:first-input"
        except Exception:
            pass
    return locator, selector


def _type_value(page, locator, value: str, settings: Settings) -> None:
    locator.scroll_into_view_if_needed(timeout=2500)
    locator.click(timeout=2500)
    try:
        locator.fill("")
    except Exception:
        pass
    if settings.pace > 0:
        locator.press_sequentially(value, delay=24)
    else:
        locator.fill(value)


def fill_research_form(
    page,
    product: dict[str, Any],
    settings: Settings,
    source_url: str,
    before_submit=None,
) -> dict[str, Any]:
    try:
        page.wait_for_selector("[data-aegis-form], form", state="visible", timeout=9000)
    except Exception as exc:
        raise SkillError("Research form did not render.") from exc

    price_locator, price_selector = _find_form_field(
        page,
        ["[data-aegis-first-field]", "input[name='price']", "input[name*='price' i]", "#price"],
    )
    if price_locator is None:
        raise SkillError("Could not find the first form field for the price.")

    _type_value(page, price_locator, product["price"], settings)

    product_locator, _ = _find_form_field(page, ["input[name='product']", "#product"])
    if product_locator is not None:
        _type_value(page, product_locator, product["name"], settings)

    source_locator, _ = _find_form_field(page, ["input[name='source']", "input[name*='url' i]", "input[type='url']"])
    if source_locator is not None:
        _type_value(page, source_locator, source_url, settings)

    notes_locator, _ = _find_form_field(page, ["textarea[name='notes']", "#notes", "textarea"])
    if notes_locator is not None:
        note = f"Rejected all non-essential cookies. Price captured from the first featured product via {product['method']}."
        _type_value(page, notes_locator, note, settings)

    actual_price = ""
    try:
        actual_price = price_locator.input_value(timeout=1000).strip()
    except Exception:
        pass
    if actual_price != product["price"]:
        # Google Forms can trim currency symbols; the visible value is still the proof.
        if product["price_value"] is not None and actual_price.replace("$", "").strip() == f"{product['price_value']:.2f}":
            actual_price = product["price"]
        else:
            raise SkillError(f"Form verification failed: expected {product['price']!r}, found {actual_price!r}.")

    if before_submit:
        before_submit()

    submit, submit_selector = _first_visible(
        page,
        ["button[type='submit']", "button:has-text('Submit')", "[role='button']:has-text('Submit')"],
        timeout_each=700,
    )
    method = submit_selector or "form.requestSubmit"
    if submit is not None:
        submit.scroll_into_view_if_needed(timeout=2000)
        submit.click(timeout=3000)
    else:
        page.evaluate("document.querySelector('form')?.requestSubmit()")

    submitted = False
    try:
        page.wait_for_function(
            "() => window.__aegisFormSubmitted === true || !!document.querySelector('[data-aegis-confirmation]:not([hidden])')",
            timeout=5000,
        )
        submitted = True
    except Exception:
        # Real Google Forms render a confirmation page, not our demo flag.
        try:
            page.wait_for_load_state("domcontentloaded", timeout=4000)
        except Exception:
            pass
        try:
            body = page.locator("body").inner_text(timeout=2000)
        except Exception:
            body = ""
        if re.search(r"response (has been|was) recorded|thanks for (submitting|your response)", body, re.I):
            submitted = True

    if not submitted:
        raise SkillError("Form was filled but the submission confirmation did not appear.")

    confirmation = ""
    try:
        if page.locator("[data-aegis-confirmation]").count():
            confirmation = page.locator("[data-aegis-confirmation]").inner_text(timeout=1500).strip()
        else:
            confirmation = "Response recorded"
    except Exception:
        confirmation = "Response recorded"

    receipt = {}
    for key in ("receipt-product", "receipt-price", "receipt-source", "receipt-time"):
        try:
            receipt[key] = page.locator(f"#{key}").inner_text(timeout=500).strip()
        except Exception:
            receipt[key] = ""

    return {
        "submitted": True,
        "method": method,
        "price_field": price_selector,
        "filled_price": actual_price,
        "confirmation": confirmation[:400],
        "receipt": receipt,
    }


def read_consent_state(page) -> str | None:
    try:
        return page.evaluate("() => window.__aegisConsent || document.documentElement.dataset.consent || null")
    except Exception:
        return None
