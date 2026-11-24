(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const runButton = $("run-button");
  const runLabel = $("run-label");
  const missionInput = $("mission-input");
  const micButton = $("mic-button");
  const voiceToggle = $("voice-toggle");
  const headlessToggle = $("headless-toggle");
  const liveShot = $("live-shot");
  const screenIdle = $("screen-idle");
  const narrationText = $("narration-text");
  const phaseBadge = $("phase-badge");
  const urlText = $("url-text");
  const timeline = $("timeline");
  const statusPill = $("status-pill");
  const timerEl = $("timer");
  const reportLink = $("report-link");
  const shopLink = $("shop-link");
  const formLink = $("form-link");
  const toastEl = $("toast");

  const state = {
    running: false,
    voiceOn: localStorage.getItem("webx-voice") !== "0",
    shopUrl: "",
    formUrl: "",
    lastSeq: 0,
    lastTs: 0,
    runStart: 0,
    timer: null,
    lastNarration: "",
    eventSource: null,
    recognition: null,
    listening: false,
    sourceReady: false,
    voices: [],
  };

  const PHASES = ["open", "privacy", "extract", "handoff", "form"];
  const STEP_INDEX = { open: 0, privacy: 1, extract: 2, handoff: 3, form: 4 };

  // ---------------------------------------------------------------- utilities

  const toast = (message) => {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => toastEl.classList.remove("show"), 3600);
  };

  const formatDuration = (seconds) => {
    const value = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  };

  const tickTimer = () => {
    if (!state.runStart) return;
    timerEl.textContent = formatDuration((Date.now() - state.runStart) / 1000);
  };

  const startTimer = () => {
    state.runStart = Date.now();
    window.clearInterval(state.timer);
    timerEl.textContent = "00:00";
    state.timer = window.setInterval(tickTimer, 500);
  };

  const stopTimer = (elapsed) => {
    window.clearInterval(state.timer);
    state.timer = null;
    if (typeof elapsed === "number") timerEl.textContent = formatDuration(elapsed);
  };

  const setStatus = (label, mode) => {
    statusPill.dataset.state = mode || "";
    statusPill.innerHTML = `<i></i> ${label}`;
  };

  const setConn = (online) => {
    const conn = $("conn");
    conn.classList.toggle("offline", !online);
    conn.innerHTML = online ? "<i></i> live" : "<i></i> reconnecting";
  };

  const setPhase = (phase) => {
    phaseBadge.textContent = phase && phase !== "done" ? phase : (phase === "done" ? "complete" : "standby");
    phaseBadge.classList.toggle("active", Boolean(phase && phase !== "done"));
    document.querySelectorAll("#runbook li").forEach((item) => {
      delete item.dataset.state;
      delete item.dataset.error;
    });
    if (!phase) return;
    if (phase === "done") {
      document.querySelectorAll("#runbook li").forEach((item) => { item.dataset.state = "done"; });
      return;
    }
    const active = STEP_INDEX[phase] ?? -1;
    document.querySelectorAll("#runbook li").forEach((item, index) => {
      if (index < active) item.dataset.state = "done";
      else if (index === active) item.dataset.state = "active";
    });
  };

  const setMetrics = (data = {}) => {
    if (typeof data.trackers_blocked === "number") {
      $("metric-trackers").textContent = String(data.trackers_blocked);
    }
    if (typeof data.tabs === "number" && data.tabs > 0) {
      $("metric-tabs").textContent = String(data.tabs);
    }
    if (data.price) {
      $("metric-price").textContent = data.price;
    }
    if (data.product) {
      $("metric-product").textContent = data.product;
    }
  };

  const resetMetrics = () => {
    $("metric-trackers").textContent = "0";
    $("metric-tabs").textContent = "0";
    $("metric-price").textContent = "—";
    $("metric-product").textContent = "no run yet";
  };

  const showShot = (relative) => {
    if (!relative) return;
    liveShot.hidden = false;
    screenIdle.style.display = "none";
    liveShot.src = `/artifacts/${relative}?v=${Date.now()}`;
    liveShot.onerror = () => {
      liveShot.hidden = true;
      screenIdle.style.display = "";
    };
  };

  const setUrlForPhase = (phase) => {
    if (!state.shopUrl || !state.formUrl) return;
    if (phase === "handoff" || phase === "form" || phase === "done") {
      urlText.textContent = state.formUrl;
    } else if (phase) {
      urlText.textContent = state.shopUrl;
    }
  };

  // ---------------------------------------------------------------- speech

  const pickVoice = () => {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    state.voices = voices;
    return (
      voices.find((v) => /en-GB/i.test(v.lang) && /female|serena|kate|sonia|libby/i.test(v.name)) ||
      voices.find((v) => /en-GB/i.test(v.lang)) ||
      voices.find((v) => /en-US/i.test(v.lang) && /female|samantha|ava|jenny/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      null
    );
  };

  const speak = (text) => {
    if (!state.voiceOn || !text || !window.speechSynthesis) return;
    if (text === state.lastNarration) return;
    state.lastNarration = text;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = 1.03;
      utterance.pitch = 0.92;
      utterance.volume = 0.95;
      window.speechSynthesis.speak(utterance);
    } catch (_) {}
  };

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => { pickVoice(); };
  }

  // ---------------------------------------------------------------- timeline

  const addEvent = (event) => {
    if (!event || event.kind === "screenshot") return;
    const empty = timeline.querySelector(".timeline-empty");
    if (empty) empty.remove();

    const row = document.createElement("div");
    row.className = "event";
    row.dataset.kind = event.kind || "info";

    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = `+${Number(event.elapsed || 0).toFixed(1)}s`;

    const dot = document.createElement("span");
    dot.className = "event-dot";

    const body = document.createElement("div");
    const title = document.createElement("p");
    title.className = "event-title";
    title.textContent = event.title || event.kind || "event";
    body.appendChild(title);
    if (event.detail) {
      const detail = document.createElement("p");
      detail.className = "event-detail";
      detail.textContent = event.detail;
      body.appendChild(detail);
    }

    row.append(time, dot, body);
    timeline.appendChild(row);
    while (timeline.children.length > 90) timeline.firstElementChild.remove();
    timeline.scrollTop = timeline.scrollHeight;

    if (event.shot) showShot(event.shot);
    if (event.phase) {
      setPhase(event.phase);
      setUrlForPhase(event.phase);
    }
    if (event.data) setMetrics(event.data);
    if (event.narration) {
      narrationText.textContent = `“${event.narration}”`;
      const eventAge = Date.now() - Date.parse(event.ts || 0);
      if (!Number.isFinite(eventAge) || eventAge < 6000) speak(event.narration);
    }
    if (event.kind === "error" && statusPill.dataset.state !== "error") {
      setStatus("error", "error");
    }

    if (event.kind === "run" && /mission complete/i.test(event.title || "")) finish(true, event);
    if (event.kind === "run" && /mission failed/i.test(event.title || "")) finish(false, event);
    if (event.kind === "run" && /webx online/i.test(event.title || "")) {
      enterRunning("Agent working");
    }
    if (event.kind === "success" && /evidence package/i.test(event.title || "")) {
      reportLink.hidden = false;
      reportLink.href = "/artifacts/latest/report.md";
    }
    if (event.data && event.data.report_url) {
      reportLink.hidden = false;
      reportLink.href = `${event.data.report_url}?v=${event.seq}`;
    }
  };

  const resetTimeline = () => {
    timeline.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.id = "timeline-empty";
    empty.innerHTML = '<span class="empty-mark">✳</span><div><strong>Mission queued.</strong><p>The trace begins as soon as the agent opens the storefront.</p></div>';
    timeline.appendChild(empty);
  };

  const enterRunning = (label) => {
    if (!state.running) {
      state.running = true;
      document.body.classList.add("is-running");
      runButton.disabled = true;
      runButton.classList.add("is-running");
      runLabel.textContent = label || "Agent working";
      setStatus("running", "running");
      startTimer();
    }
  };

  const finish = (ok, event) => {
    if (!state.running && !document.body.classList.contains("is-running")) return;
    state.running = false;
    document.body.classList.remove("is-running");
    runButton.disabled = false;
    runButton.classList.remove("is-running");
    runLabel.textContent = "Run again";
    setStatus(ok ? "complete" : "failed", ok ? "success" : "error");
    const data = (event && event.data) || {};
    if (data.duration_seconds) stopTimer(data.duration_seconds);
    else stopTimer();
    if (event && event.elapsed) timerEl.textContent = formatDuration(event.elapsed);
    if (ok) setPhase("done");
    if (window.speechSynthesis) {
      // Let queued narration finish; do not cut the final line.
    }
  };

  // ---------------------------------------------------------------- run flow

  const resetForRun = () => {
    state.lastSeq = 0;
    state.lastTs = 0;
    state.lastNarration = "";
    state.running = true;
    document.body.classList.add("is-running");
    runButton.disabled = true;
    runButton.classList.add("is-running");
    runLabel.textContent = "Agent working";
    setStatus("running", "running");
    setPhase("open");
    resetMetrics();
    resetTimeline();
    liveShot.hidden = true;
    liveShot.removeAttribute("src");
    screenIdle.style.display = "";
    narrationText.textContent = "“Mission accepted. Opening the first tab.”";
    urlText.textContent = state.shopUrl || "webx://mission-control";
    reportLink.hidden = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    startTimer();
  };

  const startRun = async () => {
    if (state.running) return;
    const task = missionInput.value.trim();
    if (task.length < 3) {
      toast("Give the agent a mission first.");
      missionInput.focus();
      return;
    }

    const payload = {
      task,
      headless: Boolean(headlessToggle.checked),
      pace: 1.0,
    };

    resetForRun();
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
        } catch (_) {}
        throw new Error(detail);
      }
    } catch (error) {
      state.running = false;
      document.body.classList.remove("is-running");
      runButton.disabled = false;
      runButton.classList.remove("is-running");
      runLabel.textContent = "Run mission";
      setStatus("error", "error");
      stopTimer(0);
      toast(`Could not start the mission: ${error.message}`);
    }
  };

  runButton.addEventListener("click", startRun);

  missionInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") startRun();
  });

  voiceToggle.checked = state.voiceOn;
  voiceToggle.addEventListener("change", () => {
    state.voiceOn = voiceToggle.checked;
    localStorage.setItem("webx-voice", state.voiceOn ? "1" : "0");
    if (!state.voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
    toast(state.voiceOn ? "Voice narration on." : "Voice narration muted.");
  });

  headlessToggle.addEventListener("change", () => {
    toast(headlessToggle.checked
      ? "Headless mode: Phantom-style run, no visible browser window."
      : "Headed mode: the browser window will be visible for the demo.");
  });

  // ---------------------------------------------------------------- mic

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    micButton.addEventListener("click", () => {
      toast("Voice input needs Chrome. Type the brief or use the mic in Chrome.");
    });
  } else {
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    state.recognition = recognition;

    recognition.onstart = () => {
      state.listening = true;
      micButton.classList.add("listening");
      micButton.setAttribute("aria-pressed", "true");
      toast("Listening… describe the mission.");
    };
    recognition.onend = () => {
      state.listening = false;
      micButton.classList.remove("listening");
      micButton.setAttribute("aria-pressed", "false");
    };
    recognition.onerror = (event) => {
      state.listening = false;
      micButton.classList.remove("listening");
      if (event.error !== "no-speech" && event.error !== "aborted") {
        toast(`Microphone error: ${event.error}. You can type the brief instead.`);
      }
    };
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join(" ").trim();
      if (transcript) {
        missionInput.value = transcript;
        missionInput.focus();
        toast("Mission dictated. Run it when ready.");
      }
    };

    micButton.addEventListener("click", () => {
      if (state.listening) {
        recognition.stop();
        return;
      }
      try {
        recognition.start();
      } catch (_) {
        toast("Microphone is busy. Try again in a moment.");
      }
    });
  }

  // ---------------------------------------------------------------- SSE

  const onEvent = (event) => {
    if (!event || typeof event.seq !== "number") return;
    const timestamp = Date.parse(event.ts || "") || 0;

    // A fresh run starts again at seq 1. Detect a new generation, but ignore the
    // same historical events replayed after an EventSource reconnect.
    if (
      event.seq === 1 &&
      event.kind === "run" &&
      /webx online/i.test(event.title || "") &&
      state.lastSeq > 1 &&
      timestamp > state.lastTs
    ) {
      state.lastSeq = 0;
      resetForRun();
    }

    if (event.seq <= state.lastSeq) return;
    state.lastSeq = event.seq;
    state.lastTs = Math.max(state.lastTs, timestamp);

    if (event.seq === 1) {
      if (!state.running) {
        resetForRun();
      } else {
        resetMetrics();
        resetTimeline();
      }
    }

    addEvent(event);
  };

  const connect = () => {
    if (state.eventSource) state.eventSource.close();
    const source = new EventSource("/api/events");
    state.eventSource = source;

    source.onopen = () => {
      setConn(true);
      state.sourceReady = true;
    };
    source.onerror = () => {
      setConn(false);
    };
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch (_) {}
    };
  };

  // ---------------------------------------------------------------- hydrate

  const hydrate = async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const snapshot = await response.json();
      state.shopUrl = snapshot.shop_url || "";
      state.formUrl = snapshot.form_url || "";
      if (state.shopUrl) {
        shopLink.href = state.shopUrl;
        formLink.href = snapshot.form_url || formLink.href;
        urlText.textContent = state.shopUrl;
      }
      if (snapshot.running) {
        state.running = true;
        document.body.classList.add("is-running");
        runButton.disabled = true;
        runButton.classList.add("is-running");
        runLabel.textContent = "Agent working";
        setStatus("running", "running");
        startTimer();
      } else if (snapshot.last_result) {
        const result = snapshot.last_result;
        setStatus(result.success ? "complete" : "failed", result.success ? "success" : "error");
        if (result.success) setPhase("done");
        setMetrics(result);
        if (result.duration_seconds) timerEl.textContent = formatDuration(result.duration_seconds);
        runLabel.textContent = "Run again";
        if (result.success) reportLink.hidden = false;
      }
      if (!snapshot.integrations || !snapshot.integrations.elevenlabs) {
        $("mission-note").textContent = "No API keys required · local demo";
      }
    } catch (_) {
      toast("Dashboard API is unavailable. Is the server running?");
    }

    // Restore the last screenshot only when this server actually remembers the
    // matching run. Stale artifacts from another port/run should not appear.
    try {
      const snapshot = await fetch("/api/state", { cache: "no-store" }).then((r) => r.json());
      if (!snapshot.last_result) return;
      const runResponse = await fetch("/artifacts/latest/run.json", { cache: "no-store" });
      if (runResponse.ok) {
        const run = await runResponse.json();
        const shots = (run.events || []).filter((event) => event.shot).map((event) => event.shot);
        if (shots.length) showShot(shots[shots.length - 1]);
      }
    } catch (_) {}
  };

  hydrate();
  connect();

  window.addEventListener("beforeunload", () => {
    if (state.eventSource) state.eventSource.close();
  });
})();
