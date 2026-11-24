/* Webx service worker: orchestration, cross-tab state, and run memory. */
"use strict";

const SETTINGS_KEY = "webxSettings";
const STATE_KEY = "webxState";
const CAPTURE_KEY = "webxCapture";
const AUTOFILL_KEY = "webxAutoFill";
const PHASES = ["consent", "capture", "handoff", "fill", "verify"];
const MAX_EVENTS = 90;
const MESSAGE_TIMEOUT = 20000;
const DEFAULT_TARGET_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSc9BSPi3ZV4spfwYqeCKf9SGB5ievSGG8xrU7oYlAMoIdXDDA/viewform";

const DEFAULT_SETTINGS = Object.freeze({
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModel: "eleven_turbo_v2_5",
  elevenLabsSttModel: "scribe_v1",
  cloudUrl: "",
  cloudToken: "",
  targetFormUrl: DEFAULT_TARGET_FORM_URL,
  demoUrl: "http://127.0.0.1:4173/shop/",
  autoConsent: true,
  speak: true,
  syncCloud: false,
});

let settingsCache = null;
let stateCache = null;
let persistChain = Promise.resolve();
let missionInFlight = false;
let autoFillInFlight = false;

function log(level, ...args) {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method]("[Webx :: Background]", ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error, limit = 360) {
  const raw = error && error.message ? error.message : String(error || "Unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

function clampNumber(value, max = 9999) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.round(number)));
}

function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultState() {
  return {
    version: 1,
    status: "idle",
    error: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    phases: { consent: "idle", capture: "idle", handoff: "idle", fill: "idle", verify: "idle" },
    capture: null,
    lastFill: null,
    lastRun: null,
    metrics: { trackersBlocked: 0, tabs: 0, durationMs: 0 },
    aws: { status: "idle", detail: "Local only", runId: null, syncedAt: null },
    autoConsent: null,
    events: [],
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    phases: { ...base.phases, ...(raw.phases || {}) },
    metrics: { ...base.metrics, ...(raw.metrics || {}) },
    aws: { ...base.aws, ...(raw.aws || {}) },
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
  };
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  let stored = {};
  try {
    stored = await chrome.storage.local.get(SETTINGS_KEY);
  } catch (error) {
    log("warn", "Could not read settings", error);
  }
  const raw = stored && stored[SETTINGS_KEY];
  settingsCache = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!raw) {
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
    } catch (error) {
      log("warn", "Could not persist default settings", error);
    }
  }
  return settingsCache;
}

function validateHttpUrl(value, label) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
    return parsed.href;
  } catch (_error) {
    throw new Error(`${label} must be a full http(s) URL.`);
  }
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current };
  const stringKeys = [
    "elevenLabsApiKey",
    "elevenLabsVoiceId",
    "elevenLabsModel",
    "elevenLabsSttModel",
    "cloudUrl",
    "cloudToken",
    "targetFormUrl",
  ];
  for (const key of stringKeys) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      next[key] = String(patch[key] == null ? "" : patch[key]).trim();
    }
  }
  for (const key of ["autoConsent", "speak", "syncCloud"]) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) next[key] = Boolean(patch[key]);
  }
  if (!next.targetFormUrl) next.targetFormUrl = DEFAULT_SETTINGS.targetFormUrl;
  next.targetFormUrl = validateHttpUrl(next.targetFormUrl, "Target form URL");
  if (next.cloudUrl) next.cloudUrl = validateHttpUrl(next.cloudUrl, "Cloud endpoint");
  if (!next.elevenLabsVoiceId) next.elevenLabsVoiceId = DEFAULT_SETTINGS.elevenLabsVoiceId;
  if (!next.elevenLabsModel) next.elevenLabsModel = DEFAULT_SETTINGS.elevenLabsModel;
  if (!next.elevenLabsSttModel) next.elevenLabsSttModel = DEFAULT_SETTINGS.elevenLabsSttModel;

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  settingsCache = next;
  await emit("Settings", "Settings saved", {
    data: {
      voice: Boolean(next.elevenLabsApiKey),
      cloud: Boolean(next.cloudUrl),
      autoConsent: next.autoConsent,
      speak: next.speak,
    },
  });
  return next;
}

async function getState() {
  if (stateCache) return stateCache;
  let stored = {};
  try {
    stored = await chrome.storage.session.get(STATE_KEY);
  } catch (error) {
    log("warn", "Could not read session state", error);
  }
  stateCache = normalizeState(stored && stored[STATE_KEY]);
  return stateCache;
}

function persistState() {
  const snapshot = JSON.parse(JSON.stringify(stateCache || defaultState()));
  persistChain = persistChain
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [STATE_KEY]: snapshot }))
    .catch((error) => log("warn", "Could not persist session state", error));
  return persistChain;
}

async function updateState(mutator) {
  const state = await getState();
  mutator(state);
  state.updatedAt = new Date().toISOString();
  await persistState();
  return state;
}

async function readSessionValue(key) {
  try {
    if (!chrome.storage.session || typeof chrome.storage.session.get !== "function") return null;
    const stored = await chrome.storage.session.get(key);
    return stored ? stored[key] : null;
  } catch (error) {
    log("warn", `Could not read ${key} from session storage`, error);
    return null;
  }
}

async function writeSessionValue(key, value) {
  try {
    if (!chrome.storage.session || typeof chrome.storage.session.set !== "function") return false;
    await chrome.storage.session.set({ [key]: value });
    return true;
  } catch (error) {
    log("warn", `Could not write ${key} to session storage`, error);
    return false;
  }
}

async function removeSessionValue(key) {
  try {
    if (chrome.storage.session && typeof chrome.storage.session.remove === "function") {
      await chrome.storage.session.remove(key);
    }
  } catch (error) {
    log("warn", `Could not clear ${key} from session storage`, error);
  }
}

async function saveCapture(capture, sourceUrl) {
  if (!capture || !capture.price) return null;
  const record = {
    capture,
    sourceUrl: sourceUrl || capture.url || "",
    savedAt: new Date().toISOString(),
  };
  await writeSessionValue(CAPTURE_KEY, record);
  log("info", `Stored ${capture.price} in ${CAPTURE_KEY}`);
  return record;
}

async function loadCapture() {
  const record = await readSessionValue(CAPTURE_KEY);
  if (record && record.capture && record.capture.price) return record;

  const state = await getState();
  if (state.capture && state.capture.price) {
    return {
      capture: state.capture,
      sourceUrl: state.capture.url || "",
      savedAt: state.capture.capturedAt || null,
      recovered: true,
    };
  }
  return null;
}

async function clearCapture() {
  await removeSessionValue(CAPTURE_KEY);
}

function captureSignature(capture) {
  return `${capture.capturedAt || capture.at || ""}|${capture.price || ""}|${capture.url || ""}`;
}

async function getAutoFillRecords() {
  const records = await readSessionValue(AUTOFILL_KEY);
  return records && typeof records === "object" ? records : {};
}

async function wasAutoFilled(tabId, capture) {
  const records = await getAutoFillRecords();
  const record = records[String(tabId)];
  return Boolean(record && record.signature === captureSignature(capture));
}

async function noteAutoFill(tabId, capture) {
  const records = await getAutoFillRecords();
  records[String(tabId)] = {
    signature: captureSignature(capture),
    at: new Date().toISOString(),
    price: capture.price,
  };
  const keys = Object.keys(records);
  if (keys.length > 25) {
    for (const key of keys.slice(0, keys.length - 25)) delete records[key];
  }
  await writeSessionValue(AUTOFILL_KEY, records);
}

async function clearAutoFillRecords() {
  await removeSessionValue(AUTOFILL_KEY);
}

async function emit(component, message, options = {}) {
  const state = await getState();
  const level = options.level || "info";
  const phase = PHASES.includes(options.phase) ? options.phase : null;
  const phaseStatus = options.phaseStatus || null;
  if (phase && phaseStatus) state.phases[phase] = phaseStatus;

  const event = {
    id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    component: String(component || "Agent").slice(0, 40),
    level,
    message: String(message || "").replace(/\s+/g, " ").trim().slice(0, 400),
    phase,
    phaseStatus,
    data: options.data || null,
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  state.updatedAt = event.ts;
  await persistState();

  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](`[Webx :: ${event.component}] ${event.message}`, options.data || "");
  return event;
}

function withTimeout(promise, timeout, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || "The page did not respond in time.")), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function isGoogleFormsUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "docs.google.com" && parsed.pathname.startsWith("/forms")) return true;
    return host === "forms.gle";
  } catch (_error) {
    return false;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_error) {
    return url || "the target page";
  }
}

function documentsMatch(a, b) {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    const leftPath = left.pathname.replace(/\/+$/, "") || "/";
    const rightPath = right.pathname.replace(/\/+$/, "") || "/";
    return left.origin === right.origin && (leftPath === rightPath || leftPath.startsWith(`${rightPath}/`));
  } catch (_error) {
    return a === b;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_error) {
    return null;
  }
}

async function allTabs() {
  try {
    return await chrome.tabs.query({});
  } catch (_error) {
    return [];
  }
}

async function findMatchingTab(url) {
  const tabs = await allTabs();
  return tabs.find((tab) => documentsMatch(tab.url, url)) || null;
}

async function openOrFocus(url) {
  const existing = await findMatchingTab(url);
  if (existing && existing.id) {
    await chrome.tabs.update(existing.id, { active: true });
    try {
      await chrome.windows.update(existing.windowId, { focused: true });
    } catch (_error) {
      // The tab is active even if the window cannot be focused.
    }
    return existing;
  }
  return chrome.tabs.create({ url, active: true });
}

async function resolveSourceTab(preferredId) {
  const settings = await getSettings();
  let tab = preferredId ? await getTab(preferredId) : null;
  if (!tab) tab = await getActiveTab();

  if (!tab || !tab.id) {
    throw new Error("No active tab. Open a live product page, then try again.");
  }
  if (!isHttpUrl(tab.url)) {
    throw new Error("This page cannot be automated. Open a regular http(s) product page first.");
  }

  if (documentsMatch(tab.url, settings.targetFormUrl)) {
    const tabs = await allTabs();
    const alternative = tabs.find(
      (candidate) =>
        candidate.id !== tab.id &&
        candidate.id &&
        isHttpUrl(candidate.url) &&
        !documentsMatch(candidate.url, settings.targetFormUrl)
    );
    if (alternative) return alternative;
    throw new Error("The active tab is the target form. Open a product page first.");
  }

  return tab;
}

async function tabMessage(tabId, type, payload, timeout = MESSAGE_TIMEOUT) {
  const message = { __webx: true, type, payload: payload || {} };
  return withTimeout(chrome.tabs.sendMessage(tabId, message), timeout, `The page did not answer "${type}" in time.`);
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    throw new Error(`Could not attach to this page. Reload the tab and try again. (${messageOf(error, 160)})`);
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await tabMessage(tabId, "ping", null, 3500);
    if (response && response.ok) return response;
  } catch (_error) {
    // Inject below, then retry the ping.
  }

  await injectContentScript(tabId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(attempt === 0 ? 120 : 240);
    try {
      const response = await tabMessage(tabId, "ping", null, 3000);
      if (response && response.ok) return response;
    } catch (_error) {
      // Keep retrying for partly rendered tabs.
    }
  }
  throw new Error("The page did not accept the Webx content script. Reload the tab and try again.");
}

async function sendToTab(tabId, type, payload, timeout = MESSAGE_TIMEOUT) {
  try {
    return await tabMessage(tabId, type, payload, timeout);
  } catch (error) {
    log("warn", `Message ${type} failed; injecting the content script and retrying`, messageOf(error, 120));
    await ensureContentScript(tabId);
    return tabMessage(tabId, type, payload, timeout);
  }
}

async function waitForTabReady(tabId, timeout = 16000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await getTab(tabId);
    if (tab && tab.status === "complete" && isHttpUrl(tab.url)) return tab;
    if (tab && typeof tab.url === "string" && tab.url.startsWith("chrome-error")) break;
    await sleep(220);
  }
  throw new Error(
    "The target page did not load. Check the target form URL in settings and try again."
  );
}

async function ensureTargetTab() {
  const settings = await getSettings();
  let tab = await findMatchingTab(settings.targetFormUrl);
  if (tab && tab.id) {
    await chrome.tabs.update(tab.id, { active: true });
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_error) {
      // The side panel does not need a focused window.
    }
  } else {
    tab = await chrome.tabs.create({ url: settings.targetFormUrl, active: true });
  }
  if (!tab || !tab.id) throw new Error("The target form tab could not be opened.");
  await waitForTabReady(tab.id);
  await ensureContentScript(tab.id);
  return tab;
}

async function prepareTarget(tabId) {
  const prepared = await sendToTab(tabId, "form:prepare", null, 12000);
  if (prepared && prepared.ok && prepared.ready) return;

  await emit("Handoff", "The target was showing a prior receipt; reloading the form", {
    phase: "handoff",
    phaseStatus: "active",
  });
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    throw new Error(`The target form could not be reloaded. (${messageOf(error, 120)})`);
  }
  await sleep(350);
  await waitForTabReady(tabId);
  await ensureContentScript(tabId);
  const retry = await sendToTab(tabId, "form:prepare", null, 12000);
  if (!retry || !retry.ok || !retry.ready) {
    const error = new Error("The target page did not show a fillable form. Check the target URL in settings.");
    error.phase = "fill";
    throw error;
  }
}

async function confirmGoogleSubmission(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await getTab(tabId);
    if (!tab || !tab.id) {
      return {
        ok: false,
        submitted: false,
        googleForms: true,
        error: "The Google Form tab closed before confirmation.",
      };
    }
    const url = tab.url || "";
    if (/\/formResponse\b/i.test(url)) {
      if (tab.status && tab.status !== "complete") {
        await sleep(250);
        continue;
      }
      let confirmation = "Your response has been recorded.";
      try {
        await ensureContentScript(tabId);
        const scan = await sendToTab(tabId, "page:scan", null, 8000);
        if (scan && scan.form && scan.form.confirmationVisible) {
          confirmation = "Your response has been recorded.";
        }
      } catch (error) {
        log("warn", "Could not re-inspect the Google Forms response page", messageOf(error, 160));
      }
      return {
        ok: true,
        submitted: true,
        googleForms: true,
        method: "google-form:formResponse",
        receipt: {},
        confirmation,
        url,
      };
    }
    await sleep(300);
  }
  return {
    ok: false,
    submitted: false,
    googleForms: true,
    error: "Google Forms did not reach its response page. Check the form and try again.",
  };
}

async function deliverToTarget({ capture, sourceUrl }) {
  const settings = await getSettings();
  const target = await ensureTargetTab();
  const targetUrl = target.url || settings.targetFormUrl;
  await updateState((state) => {
    state.metrics.tabs = 2;
    state.phases.handoff = "done";
  });
  await emit("Handoff", `Target form ready on ${hostOf(targetUrl)}`, {
    phase: "handoff",
    phaseStatus: "done",
  });

  await prepareTarget(target.id);

  await emit("Fill", "Filling the price, product, and source fields", {
    phase: "fill",
    phaseStatus: "active",
  });
  const notes = `Captured ${capture.price} from ${capture.name} via ${capture.method}. Filled by Webx.`;
  const fill = await sendToTab(target.id, "form:fill", { capture, sourceUrl, notes }, 12000);
  if (!fill || !fill.ok) {
    const error = new Error((fill && fill.error) || "The target form could not be filled.");
    error.phase = "fill";
    throw error;
  }
  await noteAutoFill(target.id, capture);
  await updateState((state) => {
    state.lastFill = fill;
    state.phases.fill = "done";
  });
  await emit("Fill", `Fields verified at ${fill.filledPrice || capture.price}`, {
    phase: "fill",
    phaseStatus: "done",
    data: { fields: Object.keys(fill.filled || {}), method: fill.field || null },
  });

  await emit("Verify", "Submitting the form and waiting for the receipt", {
    phase: "verify",
    phaseStatus: "active",
  });
  const googleTarget = isGoogleFormsUrl(target.url || settings.targetFormUrl);
  let submit;
  try {
    submit = await sendToTab(target.id, "form:submit", null, 12000);
  } catch (error) {
    if (!googleTarget) {
      const wrapped = new Error(messageOf(error));
      wrapped.phase = "verify";
      throw wrapped;
    }
    log("info", "Google Forms navigated before replying; waiting for the response page", messageOf(error, 160));
  }
  if (googleTarget) {
    const confirmed = await confirmGoogleSubmission(target.id);
    if (!confirmed.ok) {
      const error = new Error(confirmed.error || "The Google Form did not confirm the submission.");
      error.phase = "verify";
      throw error;
    }
    submit = { ...(submit || {}), ...confirmed };
  }
  if (!submit || !submit.ok || !submit.submitted) {
    const error = new Error((submit && submit.error) || "The form did not confirm the submission.");
    error.phase = "verify";
    throw error;
  }
  await updateState((state) => {
    state.phases.verify = "done";
  });
  await emit(
    "Verify",
    submit.receipt && submit.receipt["receipt-price"]
      ? `Receipt verified — ${submit.receipt["receipt-price"]}`
      : "Submission confirmation verified",
    { phase: "verify", phaseStatus: "done", data: { receipt: submit.receipt || {} } }
  );

  return {
    targetId: target.id,
    targetUrl,
    fill,
    submit,
  };
}

async function maybeAutoFillGoogleForm(tabId, url, trigger = "tab") {
  if (autoFillInFlight || missionInFlight) return { ok: false, skipped: true, reason: "busy" };
  if (!isGoogleFormsUrl(url)) return { ok: false, skipped: true, reason: "not-google-forms" };
  if (/\/formResponse\b/i.test(url)) return { ok: false, skipped: true, reason: "confirmation-page" };

  let tab = await getTab(tabId);
  if (!tab || !tab.id || !isGoogleFormsUrl(tab.url || url)) {
    return { ok: false, skipped: true, reason: "tab-changed" };
  }
  if (tab.status && tab.status !== "complete") {
    try {
      tab = await waitForTabReady(tabId, 15000);
    } catch (error) {
      log("warn", "Google Form tab was not ready for auto-fill", messageOf(error, 160));
      return { ok: false, error: messageOf(error, 200) };
    }
  }

  const record = await loadCapture();
  if (!record) {
    log("info", "Google Form detected, but no captured price is stored");
    return { ok: false, skipped: true, reason: "no-capture" };
  }

  const capture = record.capture;
  if (await wasAutoFilled(tabId, capture)) {
    log("info", "The stored capture is already in this Google Form tab");
    return { ok: false, skipped: true, reason: "already-filled" };
  }

  autoFillInFlight = true;
  try {
    await updateState((state) => {
      state.capture = capture;
      state.phases.capture = "done";
      state.phases.handoff = "active";
    });
    await emit("Handoff", `Google Form detected on ${trigger}; injecting ${capture.price}`, {
      phase: "handoff",
      phaseStatus: "active",
      data: { tabId, trigger, sourceUrl: record.sourceUrl || capture.url || "" },
    });

    await ensureContentScript(tabId);
    const fill = await sendToTab(
      tabId,
      "form:fill",
      {
        capture,
        sourceUrl: record.sourceUrl || capture.url || "",
        notes: `Captured ${capture.price} from ${capture.name} via ${capture.method}. Auto-filled by Webx on tab switch.`,
      },
      15000
    );
    if (!fill || !fill.ok) {
      throw new Error((fill && fill.error) || "The Google Form did not accept the injected value.");
    }

    await noteAutoFill(tabId, capture);
    await updateState((state) => {
      state.capture = capture;
      state.lastFill = fill;
      state.metrics.tabs = Math.max(2, state.metrics.tabs);
      state.phases.capture = "done";
      state.phases.handoff = "done";
      state.phases.fill = "done";
    });
    await emit("Fill", `Auto-filled the live Google Form with ${fill.filledPrice || capture.price}`, {
      phase: "fill",
      phaseStatus: "done",
      data: {
        tabId,
        trigger,
        field: fill.field || 'input[type="text"].whsOnd.zHQkBf',
        verified: Boolean(fill.verified),
      },
    });
    await emit("Handoff", "Google Form filled. Review the value and click Submit when ready.", {
      phase: "handoff",
      phaseStatus: "done",
    });
    return { ok: true, fill, capture, tabId, trigger };
  } catch (error) {
    const message = messageOf(error);
    log("warn", "Google Form auto-fill failed", message);
    await updateState((state) => {
      state.phases.handoff = state.phases.handoff === "done" ? "done" : "error";
      state.phases.fill = "error";
    });
    await emit("Fill", `Google Form auto-fill failed: ${message}`, {
      level: "warn",
      phase: "fill",
      phaseStatus: "error",
      data: { tabId, trigger },
    });
    return { ok: false, error: message };
  } finally {
    autoFillInFlight = false;
  }
}

async function resetRunState({ clearCapture: shouldClearCapture = false } = {}) {
  if (shouldClearCapture) await clearCapture();
  await updateState((state) => {
    state.status = "running";
    state.error = null;
    state.startedAt = new Date().toISOString();
    state.phases = { consent: "idle", capture: "idle", handoff: "idle", fill: "idle", verify: "idle" };
    state.metrics = { trackersBlocked: 0, tabs: 0, durationMs: 0 };
    state.aws = { status: "idle", detail: "Run in progress", runId: null, syncedAt: null };
    state.lastFill = null;
    state.lastRun = null;
    if (shouldClearCapture) state.capture = null;
  });
}

async function finalizeRun({ runId, started, capture, sourceUrl, delivery }) {
  const settings = await getSettings();
  const durationMs = Date.now() - started;
  const receipt = (delivery.submit && delivery.submit.receipt) || {};
  const state = await getState();

  state.status = "complete";
  state.error = null;
  state.metrics.durationMs = durationMs;
  state.metrics.tabs = 2;
  state.phases.consent = state.phases.consent === "idle" ? "skipped" : state.phases.consent;
  state.phases.capture = "done";
  state.phases.handoff = "done";
  state.phases.fill = "done";
  state.phases.verify = "done";
  state.lastFill = delivery.fill;
  state.lastRun = {
    id: runId,
    status: "complete",
    task: "Capture a product price and populate the target form",
    price: capture.price,
    product: capture.name,
    sourceUrl,
    targetUrl: delivery.targetUrl,
    trackersBlocked: state.metrics.trackersBlocked,
    tabs: 2,
    durationMs,
    createdAt: state.startedAt || new Date().toISOString(),
    capture,
    receipt,
    result: {
      success: true,
      form_submitted: true,
      confirmation: delivery.submit.confirmation || "",
      filled: delivery.fill.filled || {},
      receipt,
      duration_seconds: Number((durationMs / 1000).toFixed(1)),
    },
  };
  state.aws = settings.syncCloud
    ? { status: "syncing", detail: "Sending run summary", runId, syncedAt: null }
    : {
        status: settings.cloudUrl ? "skipped" : "disabled",
        detail: settings.cloudUrl ? "Cloud sync is off" : "No endpoint configured",
        runId: null,
        syncedAt: null,
      };
  await persistState();

  await emit("Mission", `Mission complete — ${capture.price} verified in the target form`, {
    phase: "verify",
    phaseStatus: "done",
    data: {
      price: capture.price,
      product: capture.name,
      trackersBlocked: state.metrics.trackersBlocked,
      tabs: 2,
      durationMs,
    },
  });

  if (settings.syncCloud) await syncCloud(state.lastRun);
  const latest = await getState();
  return {
    ok: true,
    capture,
    run: state.lastRun,
    result: state.lastRun.result,
    receipt,
    metrics: { ...latest.metrics },
    aws: { ...latest.aws },
  };
}

async function failRun({ runId, started, error, phase }) {
  const durationMs = Date.now() - started;
  const message = messageOf(error);
  const state = await getState();
  state.status = "error";
  state.error = message;
  state.metrics.durationMs = durationMs;
  if (phase && PHASES.includes(phase) && state.phases[phase] !== "done") state.phases[phase] = "error";
  for (const key of PHASES) {
    if (state.phases[key] === "active") state.phases[key] = "error";
  }
  state.lastRun = {
    id: runId,
    status: "error",
    error: message,
    price: state.capture ? state.capture.price : "",
    product: state.capture ? state.capture.name : "",
    trackersBlocked: state.metrics.trackersBlocked,
    tabs: state.metrics.tabs,
    durationMs,
    createdAt: state.startedAt,
    result: { success: false, error: message },
  };
  state.aws = { status: "skipped", detail: "Mission failed; not synced", runId: null, syncedAt: null };
  await persistState();
  await emit("Mission", `Mission stopped: ${message}`, {
    level: "error",
    phase: phase || null,
    phaseStatus: phase ? "error" : null,
    data: { error: message },
  });
  log("error", message);
  return { ok: false, error: message, run: state.lastRun };
}

async function runMission() {
  if (missionInFlight) return { ok: false, error: "A mission is already running." };
  missionInFlight = true;
  const started = Date.now();
  const runId = newRunId();
  let phase = "consent";
  let capture = null;
  let sourceTab = null;

  try {
    const settings = await getSettings();
    await resetRunState({ clearCapture: true });
    await emit("Mission", "Mission started", { phase: "consent", phaseStatus: "active" });

    sourceTab = await resolveSourceTab();
    try {
      await chrome.tabs.update(sourceTab.id, { active: true });
    } catch (_error) {
      // The tab may be in a background window; messaging still works.
    }
    await ensureContentScript(sourceTab.id);

    const scan = await sendToTab(sourceTab.id, "page:scan", null, 10000);
    let consent = (scan && scan.consent) || {
      found: false,
      rejected: false,
      method: "none",
      currentlyVisible: false,
    };
    let trackerCount = clampNumber(scan && scan.trackers && scan.trackers.blocked);

    if (settings.autoConsent) {
      if (!consent.rejected && consent.currentlyVisible) {
        await emit("Privacy", "Rejecting the consent banner", {
          phase: "consent",
          phaseStatus: "active",
        });
        const rejection = await sendToTab(sourceTab.id, "consent:reject", null, 10000);
        if (!rejection || !rejection.ok) {
          throw new Error((rejection && rejection.error) || "The consent banner could not be rejected.");
        }
        consent = rejection.consent || consent;
      }
    } else if (consent.currentlyVisible) {
      await emit("Privacy", "Automatic consent rejection is off; leaving the banner in place", {
        phase: "consent",
        phaseStatus: "skipped",
        level: "warn",
      });
    }

    const consentStatus = consent.rejected ? "done" : "skipped";
    await updateState((state) => {
      state.metrics.trackersBlocked = trackerCount;
      state.phases.consent = consentStatus;
    });
    await emit(
      "Privacy",
      consent.rejected
        ? `Consent banner rejected via ${consent.method || "heuristic"}`
        : "No blocking consent banner found",
      {
        phase: "consent",
        phaseStatus: consentStatus,
        data: {
          method: consent.method || "none",
          blockers: consent.blockers || [],
          trackersBlocked: trackerCount,
        },
      }
    );

    phase = "capture";
    await emit("Capture", "Reading the product page", { phase: "capture", phaseStatus: "active" });
    const priceResponse = await sendToTab(sourceTab.id, "price:extract", null, 10000);
    if (!priceResponse || !priceResponse.ok || !priceResponse.capture) {
      throw new Error((priceResponse && priceResponse.error) || "No product price was found on this page.");
    }
    capture = priceResponse.capture;
    await updateState((state) => {
      state.capture = capture;
      state.metrics.trackersBlocked = Math.max(state.metrics.trackersBlocked, trackerCount);
      state.phases.capture = "done";
    });
    await saveCapture(capture, sourceTab.url || capture.url);
    await emit("Capture", `Captured ${capture.price} — ${capture.name}`, {
      phase: "capture",
      phaseStatus: "done",
      data: {
        price: capture.price,
        product: capture.name,
        method: capture.method,
        selector: capture.selector,
      },
    });

    phase = "handoff";
    await emit("Handoff", `Moving the capture to ${hostOf(settings.targetFormUrl)}`, {
      phase: "handoff",
      phaseStatus: "active",
    });
    const delivery = await deliverToTarget({
      capture,
      sourceUrl: sourceTab.url || capture.url,
    });
    return await finalizeRun({
      runId,
      started,
      capture,
      sourceUrl: sourceTab.url || capture.url,
      delivery,
    });
  } catch (error) {
    return failRun({ runId, started, error, phase: error && error.phase ? error.phase : phase });
  } finally {
    missionInFlight = false;
  }
}

async function applyStoredCapture() {
  if (missionInFlight) return { ok: false, error: "A mission is already running." };
  const stored = await loadCapture();
  if (!stored || !stored.capture || !stored.capture.price) {
    return {
      ok: false,
      error: "No captured price yet. Open a product page and run a capture first.",
    };
  }

  missionInFlight = true;
  const started = Date.now();
  const runId = newRunId();
  const capture = stored.capture;
  const sourceUrl = stored.sourceUrl || capture.url || "";
  let phase = "handoff";

  try {
    const settings = await getSettings();
    await resetRunState({ clearCapture: false });
    await updateState((state) => {
      state.capture = capture;
      state.phases.consent = "skipped";
      state.phases.capture = "done";
      state.metrics.tabs = 2;
    });
    await emit("Handoff", `Applying the stored ${capture.price} capture`, {
      phase: "handoff",
      phaseStatus: "active",
    });
    const delivery = await deliverToTarget({ capture, sourceUrl });
    return await finalizeRun({
      runId,
      started,
      capture,
      sourceUrl,
      delivery,
    });
  } catch (error) {
    return failRun({ runId, started, error, phase: error && error.phase ? error.phase : phase });
  } finally {
    missionInFlight = false;
  }
}

async function rejectConsentOnActiveTab() {
  const tab = await resolveSourceTab();
  await ensureContentScript(tab.id);
  const response = await sendToTab(tab.id, "consent:reject", null, 10000);
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "The consent banner could not be rejected.");
  }
  const consent = response.consent || { found: false, rejected: false, method: "none" };
  const status = consent.rejected ? "done" : "skipped";
  await updateState((state) => {
    state.phases.consent = status;
  });
  await emit(
    "Privacy",
    consent.rejected
      ? `Consent banner rejected via ${consent.method || "heuristic"}`
      : "No blocking consent banner found",
    {
      phase: "consent",
      phaseStatus: status,
      data: { method: consent.method || "none", blockers: consent.blockers || [] },
    }
  );
  return { ok: true, consent, tabId: tab.id, url: tab.url };
}

async function captureFromActiveTab() {
  const settings = await getSettings();
  const tab = await resolveSourceTab();
  await ensureContentScript(tab.id);

  let scan = await sendToTab(tab.id, "page:scan", null, 10000);
  if (settings.autoConsent && scan && scan.consent && scan.consent.currentlyVisible && !scan.consent.rejected) {
    const rejection = await sendToTab(tab.id, "consent:reject", null, 10000);
    if (rejection && rejection.ok) {
      await emit("Privacy", `Consent banner rejected via ${(rejection.consent && rejection.consent.method) || "heuristic"}`, {
        phase: "consent",
        phaseStatus: "done",
        data: { method: rejection.consent && rejection.consent.method },
      });
    }
    scan = await sendToTab(tab.id, "page:scan", null, 10000);
  }

  const response = await sendToTab(tab.id, "price:extract", null, 10000);
  if (!response || !response.ok || !response.capture) {
    throw new Error((response && response.error) || "No product price was found on this page.");
  }
  const capture = response.capture;
  const trackers = clampNumber(scan && scan.trackers && scan.trackers.blocked);
  await updateState((state) => {
    state.capture = capture;
    state.metrics.trackersBlocked = trackers;
    state.metrics.tabs = 1;
    state.phases.capture = "done";
    state.phases.consent = state.phases.consent === "idle" ? "skipped" : state.phases.consent;
  });
  await saveCapture(capture, tab.url || capture.url);
  await emit("Capture", `Captured ${capture.price} — ${capture.name}`, {
    phase: "capture",
    phaseStatus: "done",
    data: {
      price: capture.price,
      product: capture.name,
      method: capture.method,
      trackersBlocked: trackers,
    },
  });
  return { ok: true, capture, trackers, tabId: tab.id, url: tab.url };
}

function toCloudPayload(run) {
  return {
    runId: String(run.id || newRunId()).slice(0, 80),
    task: String(run.task || "Capture a product price and populate the target form").slice(0, 1400),
    status: String(run.status || "complete").slice(0, 32),
    price: String(run.price || "").slice(0, 64),
    product: String(run.product || "").slice(0, 200),
    trackersBlocked: clampNumber(run.trackersBlocked, 100000),
    tabs: clampNumber(run.tabs, 100),
    createdAt: run.createdAt || new Date().toISOString(),
    result: {
      success: Boolean(run.result && run.result.success),
      form_submitted: Boolean(run.result && run.result.form_submitted),
      duration_seconds: Number(run.result && run.result.duration_seconds),
      receipt: (run.result && run.result.receipt) || {},
    },
  };
}

async function setAwsState(next) {
  await updateState((state) => {
    state.aws = { ...state.aws, ...next };
  });
}

async function syncCloud(run) {
  const settings = await getSettings();
  if (!settings.cloudUrl) {
    await setAwsState({ status: "disabled", detail: "No endpoint configured", runId: null, syncedAt: null });
    return { ok: false, status: "disabled", error: "No cloud endpoint is configured." };
  }
  if (!run || !run.id) {
    return { ok: false, status: "skipped", error: "No completed run is available to sync." };
  }

  await setAwsState({ status: "syncing", detail: "Sending run summary", runId: run.id, syncedAt: null });
  await emit("Cloud", "Syncing run memory to AWS", { data: { runId: run.id } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { "content-type": "application/json" };
    if (settings.cloudToken) headers.authorization = `Bearer ${settings.cloudToken}`;
    const response = await fetch(settings.cloudUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(toCloudPayload(run)),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        if (body && body.error) detail = `: ${String(body.error).slice(0, 140)}`;
      } catch (_error) {
        // The status code is enough.
      }
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    let body = {};
    try {
      body = await response.json();
    } catch (_error) {
      body = {};
    }
    await setAwsState({
      status: "synced",
      detail: "Run memory synced",
      runId: body.runId || run.id,
      syncedAt: new Date().toISOString(),
    });
    await emit("Cloud", `Run ${body.runId || run.id} synced to run memory`);
    return { ok: true, status: "synced", runId: body.runId || run.id };
  } catch (error) {
    const message = error && error.name === "AbortError" ? "Request timed out" : messageOf(error, 200);
    await setAwsState({ status: "offline", detail: message, runId: run.id, syncedAt: null });
    await emit("Cloud", `Cloud sync unavailable: ${message}`, { level: "warn" });
    return { ok: false, status: "offline", error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function syncLastRun() {
  const state = await getState();
  if (!state.lastRun) {
    return { ok: false, error: "No completed run is available. Run a mission first." };
  }
  if (state.lastRun.status !== "complete") {
    return { ok: false, error: "The last run failed; only verified runs are synced." };
  }
  return syncCloud(state.lastRun);
}

function parseIntent(raw) {
  const text = String(raw || "").toLowerCase().trim();
  if (!text) return "unknown";
  if (/\b(reset|clear|start over|new session)\b/.test(text)) return "reset";
  if (/\b(sync|aws|cloud|run memory)\b/.test(text)) return "sync";
  if (/\b(open|show|launch|go to)\b/.test(text) && /\b(demo|storefront|shop|nimbus)\b/.test(text)) return "openDemo";
  if (
    /\b(reject|decline|dismiss|refuse)\b/.test(text) &&
    /\b(cookies?|consent|banners?|privacy|trackers?|tracking)\b/.test(text)
  ) {
    return "privacy";
  }
  if (/\b(fill|populate|apply|put)\b/.test(text) && /\b(form|sheet|document|target|price watch)\b/.test(text)) {
    return "fill";
  }
  if (
    /\b(price|scrape|capture|extract|read|get)\b/.test(text) &&
    /\b(apply|fill|populate|form|sheet|target|document)\b/.test(text)
  ) {
    return "mission";
  }
  if (/\b(run|mission|agent|go ahead|do it)\b/.test(text)) return "mission";
  if (/\b(price|scrape|capture|extract|read|get)\b/.test(text)) return "capture";
  if (/\b(cookies?|consent|privacy|banners?)\b/.test(text)) return "privacy";
  return "unknown";
}

async function resetState() {
  if (missionInFlight) return { ok: false, error: "Wait for the current mission to finish before resetting." };
  stateCache = defaultState();
  await clearCapture();
  await clearAutoFillRecords();
  await persistState();
  await emit("Mission", "Session reset", { phase: null });
  return { ok: true, state: stateCache };
}

async function runCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "Enter a command first." };
  const intent = parseIntent(raw);
  await emit("Command", `Heard: “${raw.slice(0, 180)}”`, { data: { intent } });

  let result;
  try {
    switch (intent) {
      case "reset":
        result = await resetState();
        break;
      case "sync":
        result = await syncLastRun();
        break;
      case "openDemo": {
        const settings = await getSettings();
        const tab = await openOrFocus(settings.demoUrl);
        await emit("Navigation", `Opened ${settings.demoUrl}`);
        result = { ok: true, tabId: tab.id, url: settings.demoUrl };
        break;
      }
      case "privacy":
        result = await rejectConsentOnActiveTab();
        break;
      case "capture":
        result = await captureFromActiveTab();
        break;
      case "fill":
        result = await applyStoredCapture();
        break;
      case "mission":
        result = await runMission();
        break;
      default:
        result = {
          ok: false,
          error:
            "I did not catch a known intent. Try “get price and apply to target form”, “reject cookies”, “capture price”, or “fill form”.",
        };
        await emit("Command", "No actionable intent found", { level: "warn" });
    }
  } catch (error) {
    result = { ok: false, error: messageOf(error) };
  }
  return { ...result, intent };
}

async function handleContentEvent(event, sender) {
  if (!sender.tab || !event || event.kind !== "consent" || !event.rejected) return { ok: true };
  await getState();
  stateCache.autoConsent = {
    tabId: sender.tab.id,
    url: event.url || sender.tab.url || "",
    method: event.method || "auto",
    at: event.at || new Date().toISOString(),
  };
  await emit("Sentinel", `Consent banner rejected automatically via ${event.method || "heuristic"}`, {
    data: { tabId: sender.tab.id, url: event.url || sender.tab.url || "" },
  });
  return { ok: true };
}

async function handleMessage(message, sender) {
  const type = message.type;
  const payload = message.payload || {};
  const fromContentScript = Boolean(sender.tab);

  if (fromContentScript && type !== "content:event") {
    return { ok: false, error: "Control messages are only accepted from the Webx side panel." };
  }
  if (!fromContentScript && type === "content:event") {
    return { ok: false, error: "Content events must come from a web page." };
  }

  switch (type) {
    case "state:get": {
      const state = await getState();
      return { ok: true, state: JSON.parse(JSON.stringify(state)) };
    }
    case "settings:get": {
      const settings = await getSettings();
      return { ok: true, settings: { ...settings } };
    }
    case "settings:save":
      return { ok: true, settings: await saveSettings(payload) };
    case "mission:run":
      return runMission();
    case "command:run":
      return runCommand(payload.text);
    case "privacy:reject":
      return rejectConsentOnActiveTab();
    case "price:capture":
      return captureFromActiveTab();
    case "form:apply":
      return applyStoredCapture();
    case "form:autoFill": {
      const tab = payload.tabId ? await getTab(payload.tabId) : await getActiveTab();
      if (!tab || !tab.id) return { ok: false, error: "No active tab is available for auto-fill." };
      return maybeAutoFillGoogleForm(tab.id, tab.url, "manual");
    }
    case "state:reset":
      return resetState();
    case "aws:sync":
      return syncLastRun();
    case "tab:openTarget": {
      const tab = await ensureTargetTab();
      await emit("Navigation", `Opened ${tab.url || DEFAULT_TARGET_FORM_URL}`);
      return { ok: true, tabId: tab.id, url: tab.url || DEFAULT_TARGET_FORM_URL };
    }
    case "tab:openDemo": {
      const settings = await getSettings();
      const tab = await openOrFocus(settings.demoUrl);
      await emit("Navigation", `Opened ${settings.demoUrl}`);
      return { ok: true, tabId: tab.id, url: settings.demoUrl };
    }
    case "content:event":
      return handleContentEvent(message.event, sender);
    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.__webx !== true) return false;
  handleMessage(message, sender)
    .then((result) => sendResponse(result || { ok: true }))
    .catch((error) => {
      log("error", `Message ${message.type} failed`, error);
      sendResponse({ ok: false, error: messageOf(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  getSettings().catch((error) => log("warn", "Settings initialization failed", error));
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  getSettings().catch((error) => log("warn", "Settings initialization failed", error));
});

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const tabId = activeInfo && activeInfo.tabId;
    if (!tabId) return;
    getTab(tabId)
      .then((tab) => {
        if (tab && isGoogleFormsUrl(tab.url)) return maybeAutoFillGoogleForm(tabId, tab.url, "activated");
        return null;
      })
      .catch((error) => log("warn", "Tab activation handling failed", error));
  });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab || !tab.active) return;
    const url = (changeInfo && changeInfo.url) || tab.url;
    if (!isGoogleFormsUrl(url)) return;
    if (changeInfo && changeInfo.status && changeInfo.status !== "complete") return;
    maybeAutoFillGoogleForm(tabId, url, "updated").catch((error) =>
      log("warn", "Tab update handling failed", error)
    );
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    getAutoFillRecords()
      .then((records) => {
        if (!records[String(tabId)]) return false;
        delete records[String(tabId)];
        return writeSessionValue(AUTOFILL_KEY, records);
      })
      .catch(() => {});
  });
}

if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

log("info", "Service worker ready");
