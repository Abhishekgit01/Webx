/* Webx content script: consent sentinel, price extraction, form automation. */
(() => {
  "use strict";

  if (window.__webxContentLoaded) return;
  window.__webxContentLoaded = true;

  let TOP = true;
  try {
    TOP = window.top === window;
  } catch (_error) {
    TOP = false;
  }

  const COMPONENT = TOP ? "Content" : "ConsentFrame";
  const MAX_EVENT_TEXT = 220;
  const CONSENT_SELECTORS = [
    "[data-webx-consent]",
    "#cookie-banner",
    "#onetrust-banner-sdk",
    "#CybotCookiebotDialog",
    "[id*='cookie-banner' i]",
    "[class*='cookie-banner' i]",
    "[class*='consent-banner' i]",
    "[id*='consent-banner' i]",
    "[data-testid*='cookie' i]",
    "[aria-label*='cookie' i][role='dialog']",
    "[aria-label*='consent' i][role='dialog']",
  ];
  const REJECT_BUTTON_SELECTORS = [
    "[data-webx-reject]",
    "#reject-all",
    "#onetrust-reject-all-handler",
    "[data-testid*='reject' i]",
    "[aria-label*='reject' i]",
    "[aria-label*='decline' i]",
    "[title*='reject' i]",
  ];
  const REJECT_TEXT = /\b(reject|decline|refuse|deny|necessary only|essential only|only necessary|only essential|do not sell|do not share)\b/i;
  const FUZZY_REJECT_TEXT = /\b(reject|decline|necessary only|only necessary)\b/i;
  const GOOGLE_FORMS_INPUT_SELECTOR = 'input[type="text"].whsOnd.zHQkBf';
  const LIVE_PRICE_SELECTORS = [
    ".product-price",
    ".price",
    "[data-price]",
    "[data-testid*='price' i]",
    "[itemprop='price']",
    "[class*='sale-price' i]",
    "[class*='current-price' i]",
  ];
  const TRACKER_URL = /(google-analytics|googletagmanager|doubleclick|facebook\.net\/tr|hotjar|segment\.(?:io|com)|amplitude|mixpanel|\/shop\/track\/)/i;

  let autoConsent = true;
  let consentResult = null;
  let consentInFlight = null;
  let autoTimer = null;
  let observer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(level, ...args) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[method](`[Webx :: ${COMPONENT}]`, ...args);
  }

  function clampText(value, limit = MAX_EVENT_TEXT) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function messageOf(error) {
    if (!error) return "Unknown content-script error.";
    return clampText(error.message || String(error), 320);
  }

  function isVisible(element) {
    if (!element || !element.isConnected || !(element instanceof Element)) return false;
    if (element.hidden) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function labelText(element) {
    const parts = [];
    try {
      if (element.labels) {
        for (const label of element.labels) parts.push(label.innerText || label.textContent || "");
      }
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const label = document.getElementById(id);
          if (label) parts.push(label.innerText || label.textContent || "");
        }
      }
      const wrappingLabel = element.closest("label");
      if (wrappingLabel) parts.push(wrappingLabel.innerText || wrappingLabel.textContent || "");
    } catch (_error) {
      // Labels are a nice-to-have, never a blocker.
    }
    return clampText(parts.join(" "), 400);
  }

  function buttonText(element) {
    const values = [
      element.innerText,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent,
    ]
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return clampText(values[0] || "", 160);
  }

  function looksLikeConsent(element) {
    if (!isVisible(element)) return false;
    const text = clampText(element.innerText || element.textContent || "", 1800);
    if (!text) return false;
    return /cookie|consent|privacy choices|gdpr|tracking technologies|legitimate interest/i.test(text);
  }

  function rejectScore(element) {
    const text = buttonText(element);
    if (!text) return 0;
    if (/\b(accept|allow all|agree|got it|manage|preferences|settings)\b/i.test(text) && !/\b(reject|decline|necessary|essential)\b/i.test(text)) {
      return 0;
    }
    if (/\breject\s+all\b/i.test(text)) return 10;
    if (/\bdecline\s+all\b/i.test(text)) return 9;
    if (/\breject\b/i.test(text)) return 8;
    if (/\bdecline\b/i.test(text)) return 7;
    if (/\b(only\s+)?(necessary|essential)\b/i.test(text)) return 6;
    if (/\b(do not|don't)\s+(sell|share)\b/i.test(text)) return 5;
    if (REJECT_TEXT.test(text)) return 4;
    return 0;
  }

  function findRejectButton(banner) {
    for (const selector of REJECT_BUTTON_SELECTORS) {
      try {
        for (const element of banner.querySelectorAll(selector)) {
          if (isVisible(element) && !element.disabled) return element;
        }
      } catch (_error) {
        continue;
      }
    }

    let best = null;
    let bestScore = 0;
    try {
      for (const element of banner.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")) {
        if (!isVisible(element) || element.disabled) continue;
        if (element.closest("[hidden], [aria-hidden='true']")) continue;
        const score = rejectScore(element);
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
    } catch (_error) {
      return null;
    }
    return best;
  }

  function findFuzzyRejectControl(root = document) {
    try {
      const controls = root.querySelectorAll("button, a");
      for (const element of controls) {
        if (!isVisible(element) || element.disabled) continue;
        if (element.getAttribute("aria-disabled") === "true") continue;
        if (element.closest("[hidden], [aria-hidden='true']")) continue;
        const text = clampText(element.innerText || element.textContent || "", 180);
        if (!text || !FUZZY_REJECT_TEXT.test(text)) continue;
        if (
          /\b(accept|allow all|agree|got it|manage|preferences|settings)\b/i.test(text) &&
          !/\b(reject|decline|necessary)\b/i.test(text)
        ) {
          continue;
        }
        return element;
      }
    } catch (error) {
      log("warn", "Fuzzy reject-control scan failed", error);
    }
    return null;
  }

  function pageHasConsentLanguage() {
    try {
      const text = clampText((document.body && document.body.innerText) || "", 30000);
      return /cookie|consent|privacy choices|gdpr|tracking technologies|legitimate interest/i.test(text);
    } catch (error) {
      log("warn", "Consent language check failed", error);
      return false;
    }
  }

  function findConsentBanner() {
    for (const selector of CONSENT_SELECTORS) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (!looksLikeConsent(element)) continue;
          if (findRejectButton(element)) return element;
        }
      } catch (_error) {
        continue;
      }
    }

    const candidates = document.querySelectorAll(
      "[role='dialog'], [aria-modal='true'], [class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i], [class*='cmp' i], [id*='cmp' i], [class*='gdpr' i], [id*='gdpr' i], section, aside"
    );
    let best = null;
    let bestScore = -1;
    for (const element of candidates) {
      if (!looksLikeConsent(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 36) continue;
      if (!findRejectButton(element)) continue;
      const style = getComputedStyle(element);
      let score = 0;
      if (style.position === "fixed" || style.position === "sticky") score += 5;
      if (Number(style.zIndex) > 10) score += 3;
      if (rect.bottom > window.innerHeight * 0.55) score += 2;
      if (element.getAttribute("role") === "dialog") score += 3;
      if (element.id === "cookie-banner") score += 8;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  async function waitForConsentClosed(banner, timeout = 2600) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!banner || !banner.isConnected) return true;
      if (banner.hidden) return true;
      if (!isVisible(banner)) return true;
      await sleep(100);
    }
    return false;
  }

  function forceHideBanner(banner) {
    if (!banner) return;
    try {
      banner.hidden = true;
      banner.setAttribute("aria-hidden", "true");
      banner.style.setProperty("display", "none", "important");
      banner.style.setProperty("visibility", "hidden", "important");
      banner.style.setProperty("pointer-events", "none", "important");
    } catch (_error) {
      // If the banner cannot be hidden, the caller reports the blocker.
    }
  }

  function notifyBackground(event) {
    try {
      const result = chrome.runtime.sendMessage({ __webx: true, type: "content:event", event });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_error) {
      // The extension may have been reloaded while this page stayed open.
    }
  }

  async function rejectConsent({ auto = false } = {}) {
    if (consentInFlight) return consentInFlight;

    consentInFlight = (async () => {
      let banner = findConsentBanner();
      let button = banner ? findRejectButton(banner) : null;
      let fuzzy = false;

      if (!button) {
        const pageControl = findFuzzyRejectControl();
        if (pageControl) {
          button = pageControl;
          fuzzy = true;
          if (!banner) {
            try {
              banner = pageControl.closest(
                "[role='dialog'], [aria-modal='true'], [class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i]"
              );
            } catch (error) {
              log("warn", "Fuzzy reject-control container lookup failed", error);
              banner = null;
            }
          }
        }
      }

      if (!banner && !button) {
        if (!auto) {
          consentResult = {
            found: false,
            rejected: false,
            method: "none",
            blockers: [],
            at: new Date().toISOString(),
            url: location.href,
          };
        }
        return consentResult || { found: false, rejected: false, method: "none", blockers: [] };
      }

      let method = "none";
      const blockers = [];
      if (button) {
        try {
          button.scrollIntoView({ block: "center", behavior: "instant" });
          button.click();
          method = `${fuzzy ? "fuzzy" : "dom"}:${clampText(buttonText(button), 80) || button.tagName.toLowerCase()}`;
        } catch (error) {
          blockers.push(`click failed: ${messageOf(error)}`);
        }
      }

      if (method !== "none" && banner) {
        const closed = await waitForConsentClosed(banner);
        if (!closed) blockers.push("banner did not close normally");
      }

      if (banner) {
        const stillVisible = findConsentBanner();
        if (method === "none" || (stillVisible && isVisible(stillVisible))) {
          forceHideBanner(stillVisible || banner);
          method = method === "none" ? "dom-intervention" : `${method}+dom-intervention`;
          if (!blockers.length) blockers.push("banner removed without a native reject control");
          await sleep(120);
        }
      }

      const result = {
        found: Boolean(banner || button),
        rejected: method !== "none",
        method,
        blockers,
        at: new Date().toISOString(),
        url: location.href,
        text: clampText((banner || button) ? (banner || button).innerText || (banner || button).textContent || "" : "", 180),
      };
      consentResult = result;
      if (result.rejected) log("info", `Consent banner rejected via ${method}`);
      if (auto && result.rejected) notifyBackground({ kind: "consent", ...result });
      return result;
    })().finally(() => {
      consentInFlight = null;
    });

    return consentInFlight;
  }

  function nodeHasConsentSignal(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const attributes = [node.id, node.className, node.getAttribute("role"), node.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ");
    if (/cookie|consent|gdpr|cmp|onetrust|trustarc|didomi|privacy/i.test(attributes)) return true;
    try {
      return Boolean(
        node.querySelector(
          "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [id*='onetrust' i], [class*='onetrust' i]"
        )
      );
    } catch (_error) {
      return false;
    }
  }

  function scheduleAutoConsent(delay = 700) {
    if (!autoConsent) return;
    if (!TOP && (window.innerWidth < 200 || window.innerHeight < 100)) return;
    if (consentResult && consentResult.rejected && consentResult.url === location.href) return;
    if (autoTimer) return;
    autoTimer = setTimeout(async () => {
      autoTimer = null;
      if (!autoConsent) return;
      if (consentResult && consentResult.rejected && consentResult.url === location.href) return;
      try {
        const banner = findConsentBanner();
        const fuzzy = banner ? null : pageHasConsentLanguage() ? findFuzzyRejectControl() : null;
        if (banner || fuzzy) await rejectConsent({ auto: true });
      } catch (error) {
        log("warn", "Automatic consent check failed", error);
      }
    }, Math.max(80, delay));
  }

  function startConsentSentinel() {
    const beginObserver = () => {
      try {
        const root = document.documentElement || document.body;
        if (!root) return false;
        observer = new MutationObserver((mutations) => {
          if (!autoConsent) return;
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (nodeHasConsentSignal(node)) {
                scheduleAutoConsent(450);
                return;
              }
            }
          }
        });
        observer.observe(root, { childList: true, subtree: true });
        return true;
      } catch (error) {
        log("warn", "Consent observer could not start", error);
        return false;
      }
    };

    if (!beginObserver()) {
      document.addEventListener("DOMContentLoaded", beginObserver, { once: true });
    }

    scheduleAutoConsent(900);
    window.addEventListener("load", () => scheduleAutoConsent(350), { once: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleAutoConsent(250);
    });
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get("webxSettings");
      const settings = stored && stored.webxSettings;
      if (settings && typeof settings.autoConsent === "boolean") autoConsent = settings.autoConsent;
      if (!autoConsent && autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
    } catch (_error) {
      // Default to the sentinel being on.
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.webxSettings) return;
      const settings = changes.webxSettings.newValue || {};
      if (typeof settings.autoConsent === "boolean") autoConsent = settings.autoConsent;
      if (!autoConsent && autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
    });
  } catch (_error) {
    // Storage changes are optional.
  }

  function formatPrice(value, currency) {
    const code = String(currency || "USD").toUpperCase();
    const symbols = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$", INR: "₹", JPY: "¥" };
    const symbol = symbols[code] || "$";
    return `${symbol}${value.toFixed(2)}`;
  }

  function parsePrice(raw, currencyHint) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).replace(/\u00a0|\u202f/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return null;

    let match = text.match(
      /(?:US\$|USD|CAD|AUD|EUR|GBP|INR|JPY|\$|€|£|¥|₹)\s*(\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i
    );
    if (!match) match = text.match(/\b(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2}))\b/);
    if (!match) return null;

    let numberText = match[1].trim();
    if (numberText.includes(",") && numberText.includes(".")) {
      numberText = numberText.replace(/,/g, "");
    } else if (/^\d+,\d{2}$/.test(numberText)) {
      numberText = numberText.replace(",", ".");
    } else {
      numberText = numberText.replace(/[,\s]/g, "");
    }

    const value = Number.parseFloat(numberText);
    if (!Number.isFinite(value) || value <= 0 || value > 100000000) return null;

    let currency = String(currencyHint || "").toUpperCase();
    if (!currency) {
      if (/€|EUR/i.test(text)) currency = "EUR";
      else if (/£|GBP/i.test(text)) currency = "GBP";
      else if (/₹|INR/i.test(text)) currency = "INR";
      else if (/¥|JPY/i.test(text)) currency = "JPY";
      else if (/CAD/i.test(text)) currency = "CAD";
      else if (/AUD/i.test(text)) currency = "AUD";
      else currency = "USD";
    }

    return { value, currency, display: formatPrice(value, currency) };
  }

  function metaContent(selector) {
    const meta = document.querySelector(selector);
    return meta ? meta.getAttribute("content") : null;
  }

  function metaCurrency() {
    return (
      metaContent('meta[property="product:price:currency"]') ||
      metaContent('meta[property="og:price:currency"]') ||
      metaContent('meta[itemprop="priceCurrency"]') ||
      ""
    );
  }

  function productNameNear(element) {
    try {
      const card = element && element.closest("[data-name], [data-product], article, li, section");
      if (card) {
        const attr = card.getAttribute("data-name") || card.getAttribute("data-product");
        if (attr) return clampText(attr, 180);
        const heading = card.querySelector("h1, h2, h3, h4, [itemprop='name']");
        if (heading) return clampText(heading.textContent, 180);
      }
    } catch (_error) {
      // Fall through to document-level names.
    }
    const itemprop = document.querySelector("[itemprop='name']");
    if (itemprop) return clampText(itemprop.textContent, 180);
    const heading = document.querySelector("h1");
    if (heading) return clampText(heading.textContent, 180);
    const ogTitle = metaContent('meta[property="og:title"]');
    if (ogTitle) return clampText(ogTitle, 180);
    return clampText(document.title.split(/\s[|—–-]\s/)[0] || document.title, 180) || "Featured product";
  }

  function makeCapture(name, rawPrice, currency, method, selector, extra = {}) {
    const parsed = parsePrice(rawPrice, currency);
    if (!parsed) return null;
    return {
      name: clampText(name, 180) || "Featured product",
      price: parsed.display,
      priceValue: Number(parsed.value.toFixed(2)),
      currency: parsed.currency,
      url: location.href,
      method,
      selector: selector || "",
      capturedAt: new Date().toISOString(),
      pageTitle: clampText(document.title, 180),
      ...extra,
    };
  }

  function extractFromDemoCard() {
    const first = document.querySelector("[data-webx-first-product]");
    if (!first || !isVisible(first)) return null;
    const name = first.getAttribute("data-name") || productNameNear(first);
    const priceNode = first.querySelector("[data-webx-price], [data-price]");
    const raw =
      first.getAttribute("data-price") ||
      (priceNode ? priceNode.getAttribute("data-price") || priceNode.textContent : "");
    const currency = first.getAttribute("data-currency") || metaCurrency();
    return makeCapture(name, raw, currency, "data-attributes", "[data-webx-first-product]", { sku: first.getAttribute("data-sku") || "" });
  }

  function extractFromDataPrices() {
    const nodes = document.querySelectorAll("[data-webx-price], [data-price]");
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const raw = node.getAttribute("data-price") || node.textContent;
      const capture = makeCapture(
        productNameNear(node),
        raw,
        node.getAttribute("data-currency") || metaCurrency(),
        "data-attributes",
        node.matches("[data-webx-price]") ? "[data-webx-price]" : "[data-price]"
      );
      if (capture) return capture;
    }
    return null;
  }

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const seen = new WeakSet();
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent || "null");
      } catch (_error) {
        continue;
      }
      const queue = Array.isArray(data) ? [...data] : [data];
      let guard = 0;
      while (queue.length && guard++ < 250) {
        const item = queue.shift();
        if (!item || typeof item !== "object" || seen.has(item)) continue;
        seen.add(item);
        if (Array.isArray(item)) {
          queue.push(...item);
          continue;
        }
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (types.some((type) => String(type).toLowerCase() === "product")) {
          const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          const specification = offers && offers.priceSpecification;
          const rawPrice =
            (offers && (offers.price || offers.lowPrice)) ||
            (specification && specification.price) ||
            item.price;
          const currency =
            (offers && offers.priceCurrency) ||
            (specification && specification.priceCurrency) ||
            metaCurrency();
          if (rawPrice !== undefined && rawPrice !== null && rawPrice !== "") {
            const capture = makeCapture(item.name || productNameNear(null), rawPrice, currency, "json-ld", "application/ld+json");
            if (capture) return capture;
          }
        }
        for (const value of Object.values(item)) {
          if (value && typeof value === "object") queue.push(value);
        }
      }
    }
    return null;
  }

  function extractFromMicrodata() {
    const nodes = document.querySelectorAll("[itemprop='price'], [itemprop='lowPrice']");
    for (const node of nodes) {
      if (!isVisible(node) && !node.getAttribute("content")) continue;
      const raw = node.getAttribute("content") || node.textContent;
      const product = node.closest("[itemtype*='Product']") || document;
      const currencyNode = product.querySelector && product.querySelector("[itemprop='priceCurrency']");
      const currency = currencyNode ? currencyNode.getAttribute("content") || currencyNode.textContent : metaCurrency();
      const capture = makeCapture(productNameNear(node), raw, currency, "microdata", `[itemprop='${node.getAttribute("itemprop")}']`);
      if (capture) return capture;
    }
    return null;
  }

  function extractFromMeta() {
    const selectors = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]',
      'meta[property="product:sale_price:amount"]',
    ];
    for (const selector of selectors) {
      const raw = metaContent(selector);
      if (!raw) continue;
      const name = metaContent('meta[property="og:title"]') || productNameNear(null);
      const capture = makeCapture(name, raw, metaCurrency(), "meta-tags", selector);
      if (capture) return capture;
    }
    return null;
  }

  function extractFromSelectors() {
    const selectors = [
      ...LIVE_PRICE_SELECTORS,
      ".a-price .a-offscreen",
      "[class*='price' i]",
      "[id*='price' i]",
    ];
    let best = null;
    let bestScore = -1;
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        log("warn", `Price selector failed: ${selector}`, error);
        continue;
      }
      let seen = 0;
      for (const node of nodes) {
        if (seen++ > 80) break;
        if (!isVisible(node)) continue;
        if (
          node.closest(
            "[data-webx-consent], #cookie-banner, [id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i]"
          )
        ) {
          continue;
        }
        const text = clampText(node.getAttribute("data-price") || node.getAttribute("content") || node.textContent, 120);
        if (!text || text.length > 90) continue;
        const parsed = parsePrice(text, node.getAttribute("data-currency") || metaCurrency());
        if (!parsed) continue;
        let score = 1;
        if (LIVE_PRICE_SELECTORS.includes(selector)) score += 4;
        if (selector === ".price" || selector === ".product-price") score += 3;
        if (selector.includes("itemprop")) score += 5;
        if (selector.includes("data-testid")) score += 3;
        if (/^[\s$€£¥₹]?[\d.,]+[\sA-Z]{0,4}$/i.test(text)) score += 4;
        if (node.closest("[data-webx-first-product], main, article, [itemtype*='Product']")) score += 2;
        if (node.closest("header, footer, nav")) score -= 2;
        if (score > bestScore) {
          bestScore = score;
          best = makeCapture(productNameNear(node), text, parsed.currency, "dom-selector", selector);
        }
      }
    }
    return best;
  }

  function extractFromBodyText() {
    const root = document.querySelector("main") || document.body;
    if (!root) return null;
    let text = "";
    try {
      text = clampText(root.innerText || root.textContent || "", 160000);
    } catch (error) {
      log("warn", "Could not read page text for the price fallback", error);
      return null;
    }
    if (!text) return null;
    const patterns = [
      /(?:US\$|\$|€|£|₹|¥)\s?\d+(?:,\d{3})*(?:\.\d{2})/,
      /\b\d+(?:,\d{3})*(?:\.\d{2})\s?(?:USD|EUR|GBP|CAD|AUD|INR)\b/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return makeCapture(
          productNameNear(null),
          match[0],
          metaCurrency(),
          "text-regex",
          root === document.body ? "body" : "main"
        );
      }
    }
    return null;
  }

  function extractPrice() {
    const extractors = [
      extractFromDemoCard,
      extractFromDataPrices,
      extractFromJsonLd,
      extractFromMicrodata,
      extractFromMeta,
      extractFromSelectors,
      extractFromBodyText,
    ];
    for (const extractor of extractors) {
      try {
        const capture = extractor();
        if (capture) return capture;
      } catch (error) {
        log("warn", "Price extractor failed", error);
      }
    }
    return null;
  }

  function findForm() {
    const candidates = document.querySelectorAll("[data-webx-form], form");
    for (const form of candidates) {
      if (!isVisible(form)) continue;
      if (form.querySelector("input, textarea, select, [contenteditable='true']")) return form;
    }
    return null;
  }

  function isGoogleFormsPage() {
    try {
      const host = location.hostname.toLowerCase();
      if (host === "docs.google.com" && location.pathname.startsWith("/forms")) return true;
      return host === "forms.gle";
    } catch (error) {
      log("warn", "Google Forms URL check failed", error);
      return false;
    }
  }

  function findGoogleFormInput() {
    const selectors = [
      GOOGLE_FORMS_INPUT_SELECTOR,
      "input.whsOnd.zHQkBf",
      "input[type='text'][jsname='YPqjbf']",
      "input[type='text'][aria-labelledby]",
    ];
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (!isVisible(element) || element.disabled || element.readOnly) continue;
          if (element.getAttribute("aria-disabled") === "true") continue;
          return element;
        }
      } catch (error) {
        log("warn", `Google Forms selector failed: ${selector}`, error);
      }
    }

    try {
      const form = document.querySelector("form");
      const fields = (form || document).querySelectorAll("input[type='text']");
      for (const field of fields) {
        if (!isVisible(field) || field.disabled || field.readOnly) continue;
        if (field.getAttribute("aria-disabled") === "true") continue;
        return field;
      }
    } catch (error) {
      log("warn", "Google Forms input fallback failed", error);
    }
    return null;
  }

  function isConfirmationVisible() {
    const confirmation = document.querySelector("[data-webx-confirmation], #confirmation, [data-webx-form-confirmation]");
    if (confirmation && isVisible(confirmation)) return true;
    const dataset = document.documentElement && document.documentElement.dataset;
    if (dataset && dataset.webxFormSubmitted === "true") return true;
    const text = clampText((document.body && document.body.innerText) || "", 6000);
    return /response (?:has been|was) recorded|thanks for (?:submitting|your response)|price logged|successfully submitted/i.test(text);
  }

  function fieldHaystack(element) {
    return [
      element.name,
      element.id,
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("autocomplete"),
      labelText(element),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function findField(form, selectors, tokens) {
    for (const selector of selectors) {
      try {
        for (const element of form.querySelectorAll(selector)) {
          if (isVisible(element) && !element.disabled) return element;
        }
      } catch (_error) {
        continue;
      }
    }
    if (tokens && tokens.length) {
      const fields = form.querySelectorAll("input, textarea, [contenteditable='true']");
      for (const field of fields) {
        if (!isVisible(field) || field.disabled || field.readOnly) continue;
        const type = (field.getAttribute("type") || "").toLowerCase();
        if (["hidden", "submit", "button", "checkbox", "radio", "file"].includes(type)) continue;
        const haystack = fieldHaystack(field);
        if (tokens.some((token) => haystack.includes(token))) return field;
      }
    }
    return null;
  }

  function findPriceField(form) {
    const specific = findField(
      form,
      [
        "[data-webx-first-field]",
        "input[name='price']",
        "input[name*='price' i]",
        "input[id*='price' i]",
        "input[placeholder*='price' i]",
        "input[aria-label*='price' i]",
      ],
      ["price", "cost", "amount", "budget"]
    );
    if (specific) return specific;
    const fields = form.querySelectorAll("input, textarea");
    for (const field of fields) {
      const type = (field.getAttribute("type") || "text").toLowerCase();
      if (!isVisible(field) || field.disabled || field.readOnly) continue;
      if (["hidden", "submit", "button", "checkbox", "radio", "file", "search"].includes(type)) continue;
      return field;
    }
    return null;
  }

  function findProductField(form) {
    return findField(
      form,
      ["input[name='product']", "#product", "input[name*='product' i]", "input[id*='product' i]"],
      ["product", "item", "title", "name"]
    );
  }

  function findSourceField(form) {
    return findField(
      form,
      ["input[name='source']", "#source", "input[type='url']", "input[name*='source' i]", "input[name*='url' i]"],
      ["source", "url", "link", "website", "page"]
    );
  }

  function findNotesField(form) {
    return findField(form, ["textarea[name='notes']", "#notes", "textarea"], ["notes", "note", "comment", "remark", "description"]);
  }

  function setFieldValue(field, value) {
    if (!field) return false;
    const text = String(value == null ? "" : value);
    try {
      field.focus({ preventScroll: true });
      if (field instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(field, text);
      } else if (field instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(field, text);
      } else {
        field.textContent = text;
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.blur();
      return true;
    } catch (error) {
      log("warn", "Native value injection failed; trying direct assignment", error);
      try {
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (_fallbackError) {
        return false;
      }
    }
  }

  function numericValue(value) {
    const cleaned = String(value || "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function valueMatches(actual, capture) {
    if (!actual) return false;
    if (capture.priceValue !== null && capture.priceValue !== undefined) {
      const parsed = numericValue(actual);
      if (parsed !== null && Math.abs(parsed - Number(capture.priceValue)) < 0.005) return true;
    }
    return String(actual).replace(/\s+/g, "").toLowerCase() === String(capture.price || "").replace(/\s+/g, "").toLowerCase();
  }

  async function waitFor(predicate, timeout = 4000, interval = 120) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = predicate();
        if (result) return result;
      } catch (_error) {
        // Retry until the timeout.
      }
      await sleep(interval);
    }
    return null;
  }

  async function prepareForm() {
    if (isGoogleFormsPage()) {
      const googleField = await waitFor(findGoogleFormInput, 9000, 180);
      return {
        ok: true,
        ready: Boolean(googleField),
        reset: false,
        googleForms: true,
        confirmation: googleField ? false : isConfirmationVisible(),
      };
    }

    let form = findForm();
    if (form) return { ok: true, ready: true, reset: false };

    if (isConfirmationVisible()) {
      const reset = document.querySelector("#new-response, [data-webx-new-response], [data-webx-reset-form]");
      if (reset && isVisible(reset)) {
        reset.click();
        form = await waitFor(findForm, 2500);
        if (form) return { ok: true, ready: true, reset: true };
      }
    }

    return { ok: true, ready: false, reset: false, confirmation: isConfirmationVisible() };
  }

  async function fillGoogleForm(payload = {}) {
    const capture = payload.capture;
    if (!capture || !capture.price) {
      return { ok: false, googleForms: true, error: "No captured price was provided to the Google Forms filler." };
    }

    const field = await waitFor(findGoogleFormInput, 9000, 180);
    if (!field) {
      return {
        ok: false,
        googleForms: true,
        error: "The live Google Form short-answer field (input.whsOnd.zHQkBf) was not found or was still disabled.",
      };
    }

    if (!setFieldValue(field, capture.price)) {
      return { ok: false, googleForms: true, error: "The Google Forms field rejected the injected value." };
    }
    await sleep(180);

    let actual = field.value;
    let verified = valueMatches(actual, capture);
    if (!verified) {
      log("warn", "Google Forms did not register the first injection; retrying with input/change events");
      setFieldValue(field, capture.price);
      await sleep(220);
      actual = field.value;
      verified = valueMatches(actual, capture);
    }

    return {
      ok: verified,
      verified,
      googleForms: true,
      filled: { price: actual },
      filledPrice: actual,
      expectedPrice: capture.price,
      field: GOOGLE_FORMS_INPUT_SELECTOR,
      error: verified
        ? undefined
        : `Google Forms verification failed: expected ${capture.price}, found ${actual || "an empty value"}.`,
    };
  }

  async function fillForm(payload = {}) {
    const capture = payload.capture;
    if (!capture || !capture.price) {
      return { ok: false, error: "No captured price was provided to the form filler." };
    }

    if (isGoogleFormsPage()) {
      try {
        return await fillGoogleForm(payload);
      } catch (error) {
        log("error", "Google Forms injection failed", error);
        return { ok: false, googleForms: true, error: messageOf(error) };
      }
    }

    const form = await waitFor(findForm, 4500);
    if (!form) {
      return {
        ok: false,
        error: "No visible form was found on the target page. Check the target URL in settings.",
      };
    }

    const priceField = findPriceField(form);
    if (!priceField) {
      return { ok: false, error: "The target form has no fillable price field." };
    }

    const notes =
      payload.notes ||
      `Captured ${capture.price} from ${capture.name} via ${capture.method}. Filled by Webx.`;

    const priceValue =
      (priceField.getAttribute("type") || "").toLowerCase() === "number" && capture.priceValue != null
        ? String(capture.priceValue)
        : capture.price;

    const filled = {};
    if (!setFieldValue(priceField, priceValue)) {
      return { ok: false, error: "The price field rejected the injected value." };
    }
    filled.price = priceField.value;

    const productField = findProductField(form);
    if (productField && setFieldValue(productField, capture.name)) filled.product = productField.value;

    const sourceField = findSourceField(form);
    if (sourceField && setFieldValue(sourceField, payload.sourceUrl || capture.url)) {
      filled.source = sourceField.value;
    }

    const notesField = findNotesField(form);
    if (notesField && setFieldValue(notesField, notes)) filled.notes = notesField.value;

    await sleep(120);
    const actual = priceField.value;
    const verified = valueMatches(actual, capture);

    return {
      ok: verified,
      verified,
      filled,
      filledPrice: actual,
      expectedPrice: capture.price,
      formAction: form.getAttribute("action") || "",
      field: priceField.id || priceField.name || priceField.getAttribute("placeholder") || "first-price-field",
      error: verified ? undefined : `Form verification failed: expected ${capture.price}, found ${actual || "an empty value"}.`,
    };
  }

  function findSubmitButton(form) {
    const candidates = form.querySelectorAll(
      "button[type='submit'], input[type='submit'], button, [role='button']"
    );
    for (const button of candidates) {
      if (!isVisible(button) || button.disabled) continue;
      const type = (button.getAttribute("type") || "").toLowerCase();
      if (type === "button" || type === "reset") continue;
      if (type === "submit") return button;
    }
    for (const button of candidates) {
      if (!isVisible(button) || button.disabled) continue;
      if (button.closest("a")) continue;
      if (/\b(submit|send|log|save|record|continue)\b/i.test(buttonText(button))) return button;
    }
    return null;
  }

  function collectReceipt() {
    const receipt = {};
    for (const key of ["receipt-product", "receipt-price", "receipt-source", "receipt-time"]) {
      const element = document.getElementById(key);
      receipt[key] = element ? clampText(element.innerText || element.textContent, 220) : "";
    }
    return receipt;
  }

  function findGoogleSubmitButton() {
    const selectors = [
      "[role='button'][aria-label='Submit']",
      "[role='button']",
      "button[type='submit']",
      "input[type='submit']",
    ];
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (!isVisible(element) || element.disabled) continue;
          if (element.getAttribute("aria-disabled") === "true") continue;
          const text = buttonText(element);
          if (!text || /\bclear\b/i.test(text)) continue;
          if (/\bsubmit\b/i.test(text)) return element;
        }
      } catch (error) {
        log("warn", `Google Forms submit selector failed: ${selector}`, error);
      }
    }
    return null;
  }

  async function submitGoogleForm() {
    const button = findGoogleSubmitButton();
    if (!button) {
      return {
        ok: false,
        googleForms: true,
        error: "The live Google Form Submit control was not found.",
      };
    }

    const method = `google-form:${clampText(buttonText(button), 60) || "submit"}`;
    try {
      button.scrollIntoView({ block: "center", behavior: "instant" });
      button.click();
    } catch (error) {
      return { ok: false, googleForms: true, method, error: `The Google Forms Submit control failed: ${messageOf(error)}` };
    }

    // Google Forms posts to /formResponse and replaces the page, which destroys
    // this content-script context. Reply now; the service worker verifies the
    // navigated response page.
    return {
      ok: true,
      submitted: true,
      googleForms: true,
      navigated: true,
      method,
      receipt: {},
      confirmation: "Google Forms accepted the Submit click.",
      url: location.href,
    };
  }

  async function submitForm() {
    if (isConfirmationVisible()) {
      return {
        ok: true,
        submitted: true,
        already: true,
        method: "existing-confirmation",
        receipt: collectReceipt(),
        confirmation: clampText((document.querySelector("[data-webx-confirmation], #confirmation") || {}).innerText || "", 320),
        url: location.href,
      };
    }

    if (isGoogleFormsPage()) {
      try {
        return await submitGoogleForm();
      } catch (error) {
        log("error", "Google Forms submit failed", error);
        return { ok: false, googleForms: true, error: messageOf(error) };
      }
    }

    const form = findForm();
    if (!form) return { ok: false, error: "No fillable form was found to submit." };

    const button = findSubmitButton(form);
    let method = "form.requestSubmit";
    try {
      if (button) {
        method = `button:${clampText(buttonText(button), 60) || "submit"}`;
        button.scrollIntoView({ block: "center", behavior: "instant" });
        button.click();
      } else if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        method = "form.submit";
        form.submit();
      }
    } catch (error) {
      return { ok: false, error: `The form submit control failed: ${messageOf(error)}` };
    }

    const submitted = await waitFor(() => {
      if (isConfirmationVisible()) return true;
      const dataset = document.documentElement && document.documentElement.dataset;
      return Boolean(dataset && dataset.webxFormSubmitted === "true");
    }, 6500);

    if (!submitted) {
      return {
        ok: false,
        submitted: false,
        method,
        error: "The form was clicked but no confirmation appeared. Check the page and try again.",
        url: location.href,
      };
    }

    const confirmationNode =
      document.querySelector("[data-webx-confirmation], #confirmation, [data-webx-form-confirmation]") ||
      document.querySelector("[role='status'], [aria-live='polite']");
    return {
      ok: true,
      submitted: true,
      method,
      receipt: collectReceipt(),
      confirmation: clampText(confirmationNode ? confirmationNode.innerText || confirmationNode.textContent : "Confirmation visible", 400),
      url: location.href,
    };
  }

  async function fillAndSubmit(payload = {}) {
    const fill = await fillForm(payload);
    if (!fill.ok) return { ok: false, fill, error: fill.error };
    const submit = await submitForm();
    return { ok: Boolean(submit.ok && submit.submitted), fill, submit, error: submit.error };
  }

  function trackerFootprint() {
    const nodes = [];
    for (const selector of ["script[src]", "img[src]", "iframe[src]"]) {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch (_error) {
        continue;
      }
      for (const node of matches) {
        const url = node.src || node.getAttribute("src") || "";
        if (!TRACKER_URL.test(url)) continue;
        nodes.push(node);
      }
    }

    let loaded = 0;
    if (typeof performance !== "undefined" && typeof performance.getEntriesByName === "function") {
      for (const node of nodes) {
        const url = node.src || node.getAttribute("src") || "";
        if (node.tagName === "IMG") {
          if (node.complete && node.naturalWidth > 0) loaded += 1;
          continue;
        }
        const entries = performance.getEntriesByName(url);
        const entry = entries.length ? entries[entries.length - 1] : null;
        if (
          entry &&
          ((entry.responseStatus && entry.responseStatus > 0) ||
            entry.transferSize > 0 ||
            entry.encodedBodySize > 0 ||
            entry.decodedBodySize > 0)
        ) {
          loaded += 1;
        }
      }
    }

    const blocked = Math.max(0, nodes.length - loaded);
    return {
      declared: nodes.length,
      loaded,
      blocked,
      sample: nodes.slice(0, 8).map((node) => clampText(node.src || node.getAttribute("src"), 160)),
    };
  }

  function scanPage() {
    const banner = findConsentBanner();
    return {
      ok: true,
      page: {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
      },
      consent: consentResult
        ? { ...consentResult, currentlyVisible: Boolean(banner) }
        : { found: Boolean(banner), rejected: false, method: "none", currentlyVisible: Boolean(banner), blockers: [] },
      trackers: trackerFootprint(),
      form: {
        found: Boolean(findForm()),
        confirmationVisible: isConfirmationVisible(),
        googleForms: isGoogleFormsPage(),
        googleFormReady: isGoogleFormsPage() ? Boolean(findGoogleFormInput()) : false,
      },
      autoConsent,
    };
  }

  async function handleMessage(type, payload) {
    switch (type) {
      case "ping":
        return { ok: true, pong: true, url: location.href, top: TOP };
      case "page:scan":
        return scanPage();
      case "consent:reject": {
        const consent = await rejectConsent({ auto: false });
        return { ok: true, consent, url: location.href };
      }
      case "price:extract": {
        const capture = extractPrice();
        if (!capture) {
          return {
            ok: false,
            error: "No product price was found on this page. Open a product page with a visible price and try again.",
          };
        }
        return { ok: true, capture };
      }
      case "form:prepare":
        return prepareForm();
      case "form:fill": {
        const result = await fillForm(payload || {});
        return result;
      }
      case "form:submit": {
        const result = await submitForm();
        return result;
      }
      case "form:fillAndSubmit":
        return fillAndSubmit(payload || {});
      default:
        return { ok: false, error: `Unknown content command: ${type}` };
    }
  }

  if (TOP) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.__webx !== true) return false;
        Promise.resolve()
          .then(() => handleMessage(message.type, message.payload || {}))
          .then((result) => sendResponse(result || { ok: true }))
          .catch((error) => {
            log("error", `Command ${message.type} failed`, error);
            sendResponse({ ok: false, error: messageOf(error) });
          });
        return true;
      });
    } catch (error) {
      log("error", "Message listener could not start", error);
    }
  }

  (async () => {
    await loadSettings();
    startConsentSentinel();
    log("info", `Ready on ${location.href}`);
  })();
})();
