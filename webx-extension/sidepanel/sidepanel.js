/* Webx side panel: UI, voice capture, and orchestration client. */
"use strict";

const $ = (id) => document.getElementById(id);
const PHASES = ["consent", "capture", "handoff", "fill", "verify"];
const QUICK_COMMANDS = {
  mission: "Get price and apply to target sheet",
  privacy: "Reject all cookies",
  capture: "Capture the price",
  fill: "Fill the target form",
  reset: "Reset the session",
};
const PHASE_COPY = {
  consent: {
    idle: "Waiting",
    active: "Rejecting non-essential cookies",
    done: "Rejected",
    skipped: "No banner found",
    error: "Failed",
  },
  capture: {
    idle: "Waiting",
    active: "Reading the product page",
    done: "Captured",
    skipped: "Skipped",
    error: "Failed",
  },
  handoff: {
    idle: "Waiting",
    active: "Moving the capture across tabs",
    done: "Target tab ready",
    skipped: "Skipped",
    error: "Failed",
  },
  fill: {
    idle: "Waiting",
    active: "Writing and verifying fields",
    done: "Fields verified",
    skipped: "Skipped",
    error: "Failed",
  },
  verify: {
    idle: "Waiting",
    active: "Checking the receipt",
    done: "Receipt verified",
    skipped: "Skipped",
    error: "Failed",
  },
};
const EMPTY_STATE = () => ({
  status: "idle",
  error: null,
  startedAt: null,
  phases: { consent: "idle", capture: "idle", handoff: "idle", fill: "idle", verify: "idle" },
  capture: null,
  metrics: { trackersBlocked: 0, tabs: 0, durationMs: 0 },
  aws: { status: "idle", detail: "Local only" },
  events: [],
});

const ui = {
  settings: null,
  lastState: EMPTY_STATE(),
  initialized: false,
  actionPending: false,
  recording: false,
  transcribing: false,
  mediaRecorder: null,
  mediaStream: null,
  chunks: [],
  recordTimer: null,
  autoStopTimer: null,
  recordStartedAt: 0,
  recognition: null,
  recognitionFinal: "",
  audio: null,
  audioUrl: "",
  lastSpokenRunId: null,
  clearedBefore: null,
  liveTimer: null,
  toastTimer: null,
};

function log(level, ...args) {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method]("[Webx :: SidePanel]", ...args);
}

function messageOf(error) {
  const raw = error && error.message ? error.message : String(error || "Something went wrong.");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function send(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ __webx: true, type, payload });
  } catch (error) {
    throw new Error(`The extension background is unavailable. Reload the extension. (${messageOf(error)})`);
  }
  if (!response) throw new Error("The extension background did not respond. Reload the extension.");
  if (response.ok === false) throw new Error(response.error || "The operation failed.");
  return response;
}

function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("is-error", Boolean(isError));
  toast.classList.add("is-visible");
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function formatClock(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_error) {
    return "—";
  }
}

function shortUrl(value) {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch (_error) {
    return String(value || "—");
  }
}

function syncControls() {
  const running = ui.actionPending || (ui.lastState && ui.lastState.status === "running");
  const lock = running || ui.recording || ui.transcribing;
  document.querySelectorAll(".quick-actions button").forEach((button) => {
    button.disabled = lock;
  });
  const input = $("command-input");
  const sendButton = $("command-form") && $("command-form").querySelector("button[type='submit']");
  if (input) input.disabled = lock;
  if (sendButton) sendButton.disabled = lock;
  const cloud = $("cloud-sync");
  const demo = $("open-demo");
  if (cloud) cloud.disabled = lock;
  if (demo) demo.disabled = lock;

  const mic = $("mic-button");
  if (mic) mic.disabled = ui.transcribing || (running && !ui.recording);
}

function setStatusError(message) {
  const pill = $("state-pill");
  const label = $("state-label");
  const copy = $("status-copy");
  if (pill) pill.className = "state-pill state-error";
  if (label) label.textContent = "Attention";
  if (copy) copy.textContent = message;
}

function updateEngineBadge() {
  const settings = ui.settings || {};
  const hasKey = Boolean(String(settings.elevenLabsApiKey || "").trim());
  const badge = $("engine-pill");
  if (badge) badge.textContent = hasKey ? "ElevenLabs voice" : "Browser voice";
  const note = $("voice-note");
  if (note) {
    note.textContent = hasKey
      ? "Tap the mic, speak, then tap again. ElevenLabs STT with browser fallback."
      : "Text commands always work. Add an ElevenLabs key for studio voice; browser speech is the fallback.";
  }
}

function renderPhases(phases) {
  for (const phase of PHASES) {
    const item = document.querySelector(`.step[data-phase="${phase}"]`);
    if (!item) continue;
    const status = (phases && phases[phase]) || "idle";
    item.dataset.state = status;
    const label = $(`phase-${phase}`);
    if (label) label.textContent = (PHASE_COPY[phase] && PHASE_COPY[phase][status]) || status;
  }
}

function renderCapture(capture) {
  const empty = $("capture-empty");
  const body = $("capture-body");
  const method = $("capture-method");
  if (!capture) {
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    if (method) method.textContent = "No data";
    return;
  }

  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
  if (method) method.textContent = capture.method || "captured";
  const price = $("capture-price");
  const product = $("capture-product");
  const source = $("capture-source");
  const meta = $("capture-meta");
  if (price) price.textContent = capture.price || "—";
  if (product) product.textContent = capture.name || "Featured product";
  if (source) {
    source.textContent = shortUrl(capture.url);
    source.href = capture.url || "#";
    source.title = capture.url || "";
  }
  if (meta) {
    meta.textContent = `${capture.currency || "USD"} · ${capture.method || "capture"} · ${formatClock(capture.capturedAt)}`;
  }
}

function renderCloud(aws) {
  const status = $("cloud-status");
  const button = $("cloud-sync");
  if (!status) return;
  const value = (aws && aws.status) || "idle";
  if (value === "synced") status.textContent = `Synced ${formatClock(aws.syncedAt)} · ${aws.runId || "run"}`;
  else if (value === "syncing") status.textContent = "Sending run summary to AWS…";
  else if (value === "offline") status.textContent = `Cloud offline — local memory kept. ${aws.detail || ""}`.trim();
  else if (value === "disabled") status.textContent = "No endpoint configured";
  else if (value === "skipped") status.textContent = aws.detail || "Cloud sync is off";
  else status.textContent = "Local only";
  if (button) button.textContent = value === "offline" ? "Retry" : "Sync";
}

function renderMetrics(metrics) {
  const value = metrics || {};
  const trackers = $("metric-trackers");
  const tabs = $("metric-tabs");
  const duration = $("metric-duration");
  if (trackers) trackers.textContent = String(value.trackersBlocked || 0);
  if (tabs) tabs.textContent = String(value.tabs || 0);
  if (duration) duration.textContent = value.durationMs ? formatDuration(value.durationMs) : "0.0s";
}

function renderLogs(events) {
  const list = $("log-list");
  const empty = $("log-empty");
  if (!list || !empty) return;
  const visible = (events || []).filter((event) => {
    if (!ui.clearedBefore) return true;
    const timestamp = Date.parse(event.ts || "");
    return Number.isFinite(timestamp) && timestamp > ui.clearedBefore;
  });

  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const previousScroll = list.scrollTop;
  list.textContent = "";
  if (!visible.length) {
    empty.hidden = false;
    empty.textContent = ui.clearedBefore
      ? "View cleared. New events will appear here."
      : "Events appear here as the agent works.";
    return;
  }
  empty.hidden = true;

  for (const event of visible) {
    const item = document.createElement("li");
    item.className = `log-item level-${event.level || "info"}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatClock(event.ts);

    const entry = document.createElement("div");
    entry.className = "log-entry";
    const tag = document.createElement("span");
    tag.className = "log-tag";
    tag.textContent = event.component || "Agent";
    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = event.message || "";
    entry.append(tag, message);
    item.append(time, entry);
    list.append(item);
  }

  if (wasNearBottom) list.scrollTop = list.scrollHeight;
  else list.scrollTop = previousScroll;
}

function statusTextFor(state) {
  if (state.status === "running") {
    const latest = (state.events || []).slice(-1)[0];
    return (latest && latest.message) || "Working through the runbook…";
  }
  if (state.status === "error") return state.error || "The mission stopped. Check the activity log.";
  if (state.status === "complete") {
    const price = (state.capture && state.capture.price) || (state.lastRun && state.lastRun.price);
    return price ? `Captured ${price} and verified the target form.` : "Mission complete. The target form was verified.";
  }
  return "Open a product page, then ask Webx to move the price into your target form.";
}

function renderRunTime() {
  const target = $("run-time");
  if (!target) return;
  const state = ui.lastState || {};
  if (state.status === "running" && state.startedAt) {
    const started = Date.parse(state.startedAt);
    if (Number.isFinite(started)) {
      target.textContent = formatDuration(Date.now() - started);
      return;
    }
  }
  if (state.metrics && state.metrics.durationMs) {
    target.textContent = formatDuration(state.metrics.durationMs);
    return;
  }
  target.textContent = "—";
}

function syncLiveTimer() {
  const running = ui.lastState && ui.lastState.status === "running";
  if (running && !ui.liveTimer) {
    ui.liveTimer = setInterval(renderRunTime, 250);
  } else if (!running && ui.liveTimer) {
    clearInterval(ui.liveTimer);
    ui.liveTimer = null;
  }
  renderRunTime();
}

function renderState(raw) {
  const state = raw && typeof raw === "object" ? raw : EMPTY_STATE();
  ui.lastState = state;

  const pill = $("state-pill");
  const label = $("state-label");
  if (pill && label) {
    const status = ["idle", "running", "complete", "error"].includes(state.status) ? state.status : "idle";
    pill.className = `state-pill state-${status}`;
    label.textContent =
      status === "running" ? "Running" : status === "complete" ? "Complete" : status === "error" ? "Attention" : "Idle";
  }

  const copy = $("status-copy");
  if (copy) copy.textContent = statusTextFor(state);

  renderPhases(state.phases || {});
  renderCapture(state.capture || null);
  renderMetrics(state.metrics || {});
  renderCloud(state.aws || {});
  renderLogs(state.events || []);
  syncLiveTimer();
  syncControls();

  const runId = state.lastRun && state.lastRun.id;
  if (!ui.initialized) {
    if (runId) ui.lastSpokenRunId = runId;
    return;
  }
  if (state.status === "complete" && runId && runId !== ui.lastSpokenRunId) {
    ui.lastSpokenRunId = runId;
    const price = state.lastRun.price || (state.capture && state.capture.price);
    const line = price
      ? `Price of ${price} has been captured and populated into the target form. Submission verified.`
      : "Mission complete. The target form was verified.";
    speak(line);
  }
}

async function loadSettings() {
  try {
    const response = await send("settings:get");
    ui.settings = response.settings || {};
  } catch (error) {
    log("warn", "Could not load settings", error);
    ui.settings = ui.settings || {
      elevenLabsApiKey: "",
      elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
      elevenLabsModel: "eleven_turbo_v2_5",
      elevenLabsSttModel: "scribe_v1",
      targetFormUrl: "http://127.0.0.1:4173/form/",
      autoConsent: true,
      speak: true,
      syncCloud: false,
    };
    showToast("Settings could not be loaded. Text commands still work.", true);
  }
  updateEngineBadge();
  if (!$("settings-dialog").open) populateSettingsForm();
}

async function loadState() {
  try {
    const stored = await chrome.storage.session.get("webxState");
    renderState((stored && stored.webxState) || EMPTY_STATE());
  } catch (error) {
    log("warn", "Could not read mission state", error);
    renderState(EMPTY_STATE());
  }
}

function populateSettingsForm() {
  const settings = ui.settings || {};
  const values = {
    "settings-key": settings.elevenLabsApiKey || "",
    "settings-voice": settings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM",
    "settings-tts-model": settings.elevenLabsModel || "eleven_turbo_v2_5",
    "settings-stt-model": settings.elevenLabsSttModel || "scribe_v1",
    "settings-target": settings.targetFormUrl || "http://127.0.0.1:4173/form/",
    "settings-cloud": settings.cloudUrl || "",
    "settings-token": settings.cloudToken || "",
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    if (input) input.value = value;
  }
  const speak = $("settings-speak");
  const consent = $("settings-auto-consent");
  const sync = $("settings-sync");
  if (speak) speak.checked = settings.speak !== false;
  if (consent) consent.checked = settings.autoConsent !== false;
  if (sync) sync.checked = Boolean(settings.syncCloud);
}

function openSettings() {
  populateSettingsForm();
  const dialog = $("settings-dialog");
  if (!dialog || dialog.open) return;
  try {
    dialog.showModal();
  } catch (error) {
    showToast(`Settings could not open. ${messageOf(error)}`, true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = $("settings-form");
  const submit = form && form.querySelector("button[type='submit']");
  const patch = {
    elevenLabsApiKey: ($("settings-key") && $("settings-key").value) || "",
    elevenLabsVoiceId: ($("settings-voice") && $("settings-voice").value) || "",
    elevenLabsModel: ($("settings-tts-model") && $("settings-tts-model").value) || "",
    elevenLabsSttModel: ($("settings-stt-model") && $("settings-stt-model").value) || "",
    targetFormUrl: ($("settings-target") && $("settings-target").value) || "",
    cloudUrl: ($("settings-cloud") && $("settings-cloud").value) || "",
    cloudToken: ($("settings-token") && $("settings-token").value) || "",
    speak: Boolean($("settings-speak") && $("settings-speak").checked),
    autoConsent: Boolean($("settings-auto-consent") && $("settings-auto-consent").checked),
    syncCloud: Boolean($("settings-sync") && $("settings-sync").checked),
  };

  if (submit) {
    submit.disabled = true;
    submit.textContent = "Saving…";
  }
  try {
    const response = await send("settings:save", patch);
    ui.settings = response.settings || { ...(ui.settings || {}), ...patch };
    updateEngineBadge();
    const dialog = $("settings-dialog");
    if (dialog && dialog.open) dialog.close();
    showToast("Settings saved.");
  } catch (error) {
    showToast(messageOf(error), true);
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Save settings";
    }
  }
}

function setRecordingUi(active) {
  const zone = $("voice-zone");
  const mic = $("mic-button");
  const note = $("voice-note");
  if (zone) zone.classList.toggle("is-recording", active);
  if (mic) {
    mic.setAttribute("aria-pressed", String(active));
    mic.setAttribute("aria-label", active ? "Stop voice command" : "Start voice command");
  }
  if (active) {
    if (note) note.textContent = "Recording 0:00 — tap the mic again to stop.";
  } else {
    updateEngineBadge();
    syncControls();
  }
  syncControls();
}

function startRecordingTicker() {
  clearInterval(ui.recordTimer);
  ui.recordStartedAt = Date.now();
  ui.recordTimer = setInterval(() => {
    if (!ui.recording) return;
    const seconds = Math.floor((Date.now() - ui.recordStartedAt) / 1000);
    const note = $("voice-note");
    if (note) note.textContent = `Recording 0:${String(seconds).padStart(2, "0")} — tap the mic again to stop.`;
  }, 300);
}

function stopRecordingTicker() {
  clearInterval(ui.recordTimer);
  ui.recordTimer = null;
  clearTimeout(ui.autoStopTimer);
  ui.autoStopTimer = null;
  updateEngineBadge();
}

function stopMediaStream() {
  if (ui.mediaStream) {
    for (const track of ui.mediaStream.getTracks()) {
      try {
        track.stop();
      } catch (_error) {
        // Track already ended.
      }
    }
  }
  ui.mediaStream = null;
}

function stopMediaRecording() {
  if (ui.mediaRecorder && ui.mediaRecorder.state !== "inactive") {
    try {
      ui.mediaRecorder.stop();
    } catch (error) {
      log("warn", "Recorder stop failed", error);
    }
  } else {
    ui.recording = false;
    stopRecordingTicker();
    stopMediaStream();
    setRecordingUi(false);
  }
}

async function transcribeAudio(blob) {
  const settings = ui.settings || {};
  const key = String(settings.elevenLabsApiKey || "").trim();
  if (!key) {
    startBrowserRecognition();
    return;
  }
  if (blob.size < 900) {
    showToast("That recording was too short. Try again and speak a full command.", true);
    return;
  }

  ui.transcribing = true;
  syncControls();
  const transcript = $("transcript");
  if (transcript) transcript.textContent = "Transcribing with ElevenLabs…";
  try {
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    const form = new FormData();
    form.append("file", blob, `webx-command.${extension}`);
    form.append("model_id", settings.elevenLabsSttModel || "scribe_v1");
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (!response.ok) throw new Error(`ElevenLabs STT returned ${response.status}.`);
    const data = await response.json();
    const text = String((data && data.text) || "").trim();
    if (!text) throw new Error("ElevenLabs returned an empty transcript.");
    if (transcript) transcript.textContent = `“${text}”`;
    await submitCommand(text, { source: "voice" });
  } catch (error) {
    log("warn", "ElevenLabs transcription failed", error);
    showToast(`ElevenLabs unavailable (${messageOf(error)}). Switching to browser voice.`, true);
    startBrowserRecognition();
  } finally {
    ui.transcribing = false;
    syncControls();
  }
}

async function startMediaRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    showToast("Microphone recording is unavailable here. Type a command instead.", true);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (_error) {
        return false;
      }
    });
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    ui.mediaStream = stream;
    ui.mediaRecorder = recorder;
    ui.chunks = [];
    ui.recording = true;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) ui.chunks.push(event.data);
    });
    recorder.addEventListener("stop", async () => {
      stopMediaStream();
      ui.recording = false;
      stopRecordingTicker();
      setRecordingUi(false);
      const type = recorder.mimeType || (ui.chunks[0] && ui.chunks[0].type) || "audio/webm";
      const blob = new Blob(ui.chunks, { type });
      ui.chunks = [];
      if (blob.size < 900) {
        showToast("That recording was too short. Try again and speak a full command.", true);
        return;
      }
      await transcribeAudio(blob);
    });
    recorder.addEventListener("error", (event) => {
      log("error", "MediaRecorder error", event.error || event);
      ui.recording = false;
      stopRecordingTicker();
      stopMediaStream();
      setRecordingUi(false);
      showToast("The microphone recording failed. Type a command instead.", true);
    });

    recorder.start(250);
    setRecordingUi(true);
    startRecordingTicker();
    const transcript = $("transcript");
    if (transcript) transcript.textContent = "Listening… tap the mic again when you finish speaking.";
    ui.autoStopTimer = setTimeout(() => {
      if (ui.recording) stopMediaRecording();
    }, 20000);
  } catch (error) {
    stopMediaStream();
    ui.recording = false;
    setRecordingUi(false);
    log("warn", "Microphone access failed", error);
    showToast("Microphone access was not granted. Type a command instead.", true);
    const input = $("command-input");
    if (input) input.focus();
  }
}

function startBrowserRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showToast("Browser speech recognition is unavailable. Type a command instead.", true);
    const input = $("command-input");
    if (input) input.focus();
    return;
  }

  try {
    const recognition = new Recognition();
    ui.recognition = recognition;
    ui.recognitionFinal = "";
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let finalText = "";
    let hadError = false;

    const transcript = $("transcript");
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      ui.recognitionFinal = `${finalText}${interim}`.trim();
      if (transcript) transcript.textContent = ui.recognitionFinal ? `“${ui.recognitionFinal}”` : "Listening…";
    };
    recognition.onerror = (event) => {
      hadError = true;
      const reason = (event && event.error) || "unknown error";
      log("warn", "Browser speech recognition error", reason);
      if (reason !== "aborted" && reason !== "no-speech") {
        showToast(`Browser voice unavailable (${reason}). Type the command instead.`, true);
      }
    };
    recognition.onend = () => {
      ui.recognition = null;
      ui.recording = false;
      stopRecordingTicker();
      setRecordingUi(false);
      const text = `${finalText}${ui.recognitionFinal && !finalText ? ui.recognitionFinal : ""}`.trim();
      if (text) {
        submitCommand(text, { source: "voice" });
      } else if (!hadError) {
        showToast("No speech detected. Try again or type a command.", true);
      }
    };

    ui.recording = true;
    setRecordingUi(true);
    startRecordingTicker();
    if (transcript) transcript.textContent = "Listening with browser speech…";
    recognition.start();
  } catch (error) {
    ui.recognition = null;
    ui.recording = false;
    setRecordingUi(false);
    log("warn", "Browser speech recognition could not start", error);
    showToast("Browser voice could not start. Type a command instead.", true);
  }
}

function stopBrowserRecognition() {
  if (ui.recognition) {
    try {
      ui.recognition.stop();
    } catch (_error) {
      ui.recognition = null;
      ui.recording = false;
      stopRecordingTicker();
      setRecordingUi(false);
    }
  }
}

async function toggleRecording() {
  if (ui.transcribing) {
    showToast("Wait for the current transcript to finish.", true);
    return;
  }
  if (ui.recording) {
    if (ui.recognition) stopBrowserRecognition();
    else stopMediaRecording();
    return;
  }
  if (ui.actionPending || (ui.lastState && ui.lastState.status === "running")) {
    showToast("A mission is already running. Wait for it to finish.", true);
    return;
  }

  const key = String((ui.settings && ui.settings.elevenLabsApiKey) || "").trim();
  if (key) await startMediaRecording();
  else startBrowserRecognition();
}

function speakWithBrowser(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 0.98;
    utterance.volume = 0.95;
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    log("warn", "Browser speech synthesis failed", error);
  }
}

function playAudioBlob(blob, fallbackText) {
  try {
    if (ui.audio) {
      ui.audio.pause();
      if (ui.audioUrl) URL.revokeObjectURL(ui.audioUrl);
    }
    ui.audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(ui.audioUrl);
    ui.audio = audio;
    audio.addEventListener("ended", () => {
      if (ui.audioUrl) URL.revokeObjectURL(ui.audioUrl);
      ui.audioUrl = "";
      ui.audio = null;
    });
    audio.addEventListener("error", () => {
      log("warn", "ElevenLabs audio playback failed; using browser speech");
      speakWithBrowser(fallbackText);
    });
    const playback = audio.play();
    if (playback && typeof playback.catch === "function") {
      playback.catch((error) => {
        log("warn", "Audio playback was blocked; using browser speech", error);
        speakWithBrowser(fallbackText);
      });
    }
  } catch (error) {
    log("warn", "Audio playback failed", error);
    speakWithBrowser(fallbackText);
  }
}

async function speak(text) {
  if (!text) return;
  if (ui.settings && ui.settings.speak === false) return;
  const settings = ui.settings || {};
  const key = String(settings.elevenLabsApiKey || "").trim();
  if (!key) {
    speakWithBrowser(text);
    return;
  }

  try {
    const voiceId = encodeURIComponent(settings.elevenLabsVoiceId || "21m00Tcm4TlvDq8ikWAM");
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: settings.elevenLabsModel || "eleven_turbo_v2_5",
        voice_settings: { stability: 0.48, similarity_boost: 0.78, style: 0.15, use_speaker_boost: true },
      }),
    });
    if (!response.ok) throw new Error(`ElevenLabs TTS returned ${response.status}.`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("ElevenLabs returned empty audio.");
    playAudioBlob(blob, text);
  } catch (error) {
    log("warn", "ElevenLabs speech failed", error);
    speakWithBrowser(text);
  }
}

async function submitCommand(text, options = {}) {
  const command = String(text || "").trim();
  if (!command) {
    showToast("Enter a command first.", true);
    return null;
  }
  if (ui.actionPending || (ui.lastState && ui.lastState.status === "running")) {
    showToast("A mission is already running. Wait for it to finish.", true);
    return null;
  }

  const transcript = $("transcript");
  if (transcript) transcript.textContent = `“${command}”`;
  ui.actionPending = true;
  syncControls();

  try {
    const response = await send("command:run", { text: command });
    const intent = response.intent || "mission";
    if (intent === "privacy" && response.consent && !response.consent.rejected) {
      showToast("No blocking consent banner found.");
    } else if (intent === "capture" && response.capture) {
      showToast(`Captured ${response.capture.price}.`);
    } else if (intent === "fill" || intent === "mission") {
      showToast("Mission complete. Receipt verified.");
    } else if (intent === "reset") {
      showToast("Session reset.");
      if (transcript) transcript.textContent = "Session reset. Ready for a new capture.";
    } else if (intent === "openDemo") {
      showToast("Opened the local storefront.");
    } else if (intent === "sync") {
      showToast("Run memory synced.");
    }
    const input = $("command-input");
    if (input) input.value = "";
    return response;
  } catch (error) {
    log("warn", `Command failed: ${command}`, error);
    setStatusError(messageOf(error));
    showToast(messageOf(error), true);
    return null;
  } finally {
    ui.actionPending = false;
    syncControls();
  }
}

async function syncCloud() {
  if (ui.actionPending) return;
  ui.actionPending = true;
  syncControls();
  try {
    await send("aws:sync");
    showToast("Run memory synced.");
  } catch (error) {
    showToast(`Cloud sync unavailable. ${messageOf(error)}`, true);
  } finally {
    ui.actionPending = false;
    syncControls();
  }
}

async function openDemo() {
  if (ui.actionPending) return;
  ui.actionPending = true;
  syncControls();
  try {
    await send("tab:openDemo");
    showToast("Opened the local storefront. Start ./run_demo.sh if it is not running.");
  } catch (error) {
    showToast(messageOf(error), true);
  } finally {
    ui.actionPending = false;
    syncControls();
  }
}

function bindEvents() {
  $("mic-button").addEventListener("click", toggleRecording);
  $("command-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("command-input");
    submitCommand(input ? input.value : "");
  });

  document.querySelector(".quick-actions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const command = QUICK_COMMANDS[button.dataset.action];
    if (command) submitCommand(command, { source: "quick" });
  });

  $("settings-button").addEventListener("click", openSettings);
  $("engine-pill").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  $("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
  $("settings-dialog").addEventListener("click", (event) => {
    if (event.target === $("settings-dialog")) $("settings-dialog").close();
  });
  $("settings-form").addEventListener("submit", saveSettings);
  $("settings-clear").addEventListener("click", () => {
    const key = $("settings-key");
    const token = $("settings-token");
    if (key) key.value = "";
    if (token) token.value = "";
    showToast("Keys cleared in the form. Save settings to apply.");
  });

  $("clear-log").addEventListener("click", () => {
    ui.clearedBefore = Date.now();
    renderLogs(ui.lastState.events || []);
  });
  $("cloud-sync").addEventListener("click", syncCloud);
  $("open-demo").addEventListener("click", openDemo);

  chrome.storage.session.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.webxState) return;
    renderState(changes.webxState.newValue || EMPTY_STATE());
  });

  chrome.storage.local.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.webxSettings) return;
    const settings = changes.webxSettings.newValue || {};
    ui.settings = { ...(ui.settings || {}), ...settings };
    updateEngineBadge();
    if (!$("settings-dialog").open) populateSettingsForm();
  });

  window.addEventListener("beforeunload", () => {
    stopMediaStream();
    if (ui.recognition) {
      try {
        ui.recognition.abort();
      } catch (_error) {
        // Already stopped.
      }
    }
    if (ui.audio) ui.audio.pause();
    if (ui.audioUrl) URL.revokeObjectURL(ui.audioUrl);
    clearInterval(ui.recordTimer);
    clearTimeout(ui.autoStopTimer);
    clearInterval(ui.liveTimer);
  });
}

async function init() {
  bindEvents();
  renderState(EMPTY_STATE());
  await loadSettings();
  await loadState();
  ui.initialized = true;
  log("info", "Side panel ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
