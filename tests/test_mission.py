"""Mission parsing stays deterministic and offline."""

from __future__ import annotations

from aegisweb.mission import parse_mission

SHOP = "http://127.0.0.1:4173/shop/"
FORM = "http://127.0.0.1:4173/form/"


def test_default_demo_brief_uses_local_urls_and_all_skills():
    mission = parse_mission(
        "Navigate to the demo storefront, reject the cookie banner, grab the price "
        "of the first item, and save it to the research form.",
        SHOP,
        FORM,
    )

    assert mission.shop_url == SHOP
    assert mission.form_url == FORM
    assert mission.custom_urls is False
    assert mission.wants_privacy is True
    assert mission.wants_price is True
    assert mission.wants_form is True
    assert mission.notes == []
    assert mission.as_dict()["task"].startswith("Navigate")


def test_two_urls_are_assigned_in_order_and_cleaned():
    mission = parse_mission(
        "Compare https://shop.example.com/deal?ref=aegis, then record it at "
        "https://forms.example.com/watch.",
        SHOP,
        FORM,
    )

    assert mission.shop_url == "https://shop.example.com/deal?ref=aegis"
    assert mission.form_url == "https://forms.example.com/watch"
    assert mission.custom_urls is True
    assert mission.notes == ["Using the two URLs found in the mission brief."]


def test_single_shop_url_keeps_the_local_form():
    mission = parse_mission(
        "Open https://shop.example.com and capture the price of the first product.",
        SHOP,
        FORM,
    )

    assert mission.shop_url == "https://shop.example.com"
    assert mission.form_url == FORM
    assert mission.wants_price is True
    assert mission.wants_privacy is False
    assert mission.wants_form is False


def test_single_form_url_keeps_the_local_shop():
    mission = parse_mission(
        "Save the price to https://forms.example.com/research-form",
        SHOP,
        FORM,
    )

    assert mission.shop_url == SHOP
    assert mission.form_url == "https://forms.example.com/research-form"
    assert mission.notes == ["Using the provided form URL with the local demo shop."]


def test_explicit_intent_is_detected_alongside_custom_urls():
    mission = parse_mission(
        "Go to https://shop.example.com, reject cookies, read the price, and fill the form",
        SHOP,
        FORM,
    )

    assert mission.wants_privacy is True
    assert mission.wants_price is True
    assert mission.wants_form is True


def test_one_form_url_with_no_keywords_still_works():
    mission = parse_mission("https://example.com/form", SHOP, FORM)

    assert mission.form_url == "https://example.com/form"
    assert mission.shop_url == SHOP
    assert mission.custom_urls is True


def test_task_whitespace_is_trimmed_in_mission():
    mission = parse_mission("   inspect the shop   ", SHOP, FORM)
    assert mission.task == "inspect the shop"
