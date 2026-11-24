# Hackathon runbook

A practical 3-minute script for demoing AegisWeb, plus the pitch, likely questions,
and recovery plans. Tested against the local demo; no network required.

## Before you present

- [ ] Chrome/Chromium installed and `python3 -m aegisweb doctor` says **READY**.
- [ ] `python3 -m pip install -r requirements-dev.txt` has completed.
- [ ] Run the demo once to warm caches and confirm the flow.
- [ ] Close notifications, Slack, email, and anything that can steal focus.
- [ ] Set display scaling so Mission Control and the browser fit side by side.
- [ ] If recording: 1440×900 or larger, cursor visible, voice toggle on.
- [ ] If using ElevenLabs, generate the pack before going on stage; do not rely on
      conference Wi-Fi.
- [ ] Keep a terminal with `python3 -m aegisweb demo --headless --pace 0` ready as a
      fallback.
- [ ] Copy a successful run to `artifacts/backup/` as pre-recorded evidence:
      `cp -r artifacts/latest artifacts/backup`.

Start Mission Control:

```bash
./run_demo.sh
# or: python3 -m aegisweb serve --no-open
```

Open **http://127.0.0.1:8000**.

## The 3-minute run sheet

### 0:00–0:20 — Hook

> "Every AI agent demo shows the same thing: a chatbot that says it booked your
> flight. The hard part isn't the chat. It's the web itself — cookie banners built to
> trick you, forms that fight you, and the same value stranded in three different
> tabs. AegisWeb is a browser agent that handles the hostile parts first."

### 0:20–0:40 — The mission

Point at Mission Control.

> "One brief: go to the storefront, reject the cookie banner, grab the price of the
> first item, and save it to the research form. I can type it or dictate it."

Optionally click the microphone and dictate, or press **⌘/Ctrl + Enter**. Leave
**Voice** on, **Headless** off for the visible-browser version.

> "Notice what I'm not doing: I'm not telling it which button to click. It has a
> runbook, but every step is a real browser action with a real verification."

### 0:40–2:00 — The run

Let the trace stream. Narrate only the moments that matter.

**Storefront + privacy (0:40–1:05).** The browser opens Nimbus Supply Co. with the
consent overlay.

> "The easy path is 'Accept all'. AegisWeb finds 'Reject all', clicks it, and verifies
> the banner is actually gone. Meanwhile it aborted three tracker requests at the
> network layer before they loaded. That's the privacy sentinel — not a policy page,
> an enforced action."

Point at **Trackers blocked: 3** and the `cookies-rejected` screenshot in the live view.

**Extraction (1:05–1:25).** The trace shows `Captured $149.00`.

> "It reads the first featured product — Ridgeline Field Lantern, $149. It prefers
> stable data attributes, then structured JSON-LD, then visible text. The trace records
> which method succeeded, so the result is auditable."

**Cross-tab handoff (1:25–1:45).** Tab 2 opens.

> "Now the part that usually becomes copy-paste: the value moves across tabs through
> agent memory, not the clipboard. There's an explicit handoff record: storefront to
> research-form."

**Form + verification (1:45–2:00).** The form fills and the receipt appears.

> "It types the price into the first field, fills the product and source, submits, and
> waits for the receipt. The mission only succeeds if the confirmation is visible.
> That's the bureaucracy buster."

### 2:00–2:40 — Evidence and architecture

Open the report (`Report` link or `/artifacts/latest/report.md`).

> "Every run produces a report, a JSON result, a JSONL trace, and six screenshots. The
> same event stream powers the terminal, the dashboard, and this evidence package."

Show the architecture briefly (README diagram or one slide):

> "Python plus Playwright. A FastAPI dashboard streams events over SSE. Consent and
> extraction are deterministic on the local demo, with a graceful fallback ladder:
> data attributes, ARIA, DOM walking, and an optional vision model. Cross-tab memory is
> local JSON, with an optional SAM path: API Gateway to Lambda to DynamoDB. Phantom
> mode is the same run headless. No API keys are required for anything you just saw."

### 2:40–3:00 — Close

> "AegisWeb isn't trying to be a general autonomous agent on day one. It's a trustworthy
> browser worker: it refuses the dark patterns, verifies its own work, and leaves
> evidence behind. Give it a brief, and it returns a result you can check. That's the
> foundation for agents we'd actually let near our accounts."

## 30-second elevator pitch

> "The web was built for humans and dark patterns, not agents. AegisWeb is a
> browser agent that rejects non-essential tracking, extracts what you asked for, moves
> it across tabs, and proves the result with screenshots and a trace. It runs locally
> with Python and Playwright — no API keys needed for the demo — and has an optional
> AWS memory path for scale."

## Why this is different

| Typical agent demo | AegisWeb |
| --- | --- |
| Chat transcript claims success | Browser actions plus visible receipt verification |
| Ignores consent UI | Rejects it and verifies the state |
| Copies values between tabs | Explicit cross-tab memory and handoff record |
| Needs a cloud LLM to function | Deterministic local runbook; vision is optional |
| "Trust me" output | Report, run.json, trace.jsonl, six screenshots |
| Fragile selector demo | Layered fallbacks and last-resort intervention |

## Likely questions

**Is this actually AI, or a script?**
It's an agent with a bounded planner and tool skills, not a chat wrapper. The mission
brief is parsed for URLs and intent, and the runbook plans and verifies each step. A
vision-language model is available as a fallback for unfamiliar controls, but the demo
deliberately doesn't depend on it. We chose reliability and auditability over
pretending a prompt is a product.

**Why not use browser-use or an existing framework?**
We evaluated it. For a recorded demo on Python 3.14 with a hard reliability bar, a
small Playwright layer with explicit skills and verification was simpler to reason
about. The architecture leaves room to swap in a planner: the event contract and
verification layer stay.

**What happens on a real site with a different banner?**
The consent skill tries stable attributes, common banner IDs, accessible role/text,
a DOM text walker, then optional vision. If a banner still won't close, the agent
records that it intervened locally rather than silently continuing. On a real site,
the equivalent of that last resort would be a scoped content script, not a fake click.

**Does it actually block trackers?**
Yes — Playwright route interception aborts matching requests before they reach the
network. The demo includes three local tracker requests so the count is real. It is not
a full content blocker or a privacy browser; it's a policy layer for the agent's own
session.

**How do you know the form was submitted?**
The demo sets an explicit submitted flag and renders a receipt. The agent waits for
either that signal or recognizable confirmation text, reads the receipt price, and
raises an error if it doesn't match. It never reports success just because it clicked.

**What about credentials, payments, or personal data?**
The demo form is local and contains no personal data. The agent has a single-run lock,
no credential vault, and no payment skill. Before using this pattern for real accounts,
you'd need scoped permissions, human approval gates for irreversible actions, secret
isolation, and an audit log — which is exactly the roadmap, not something we pretend is
already solved.

**Why local pages? Is that cheating?**
The browser, extraction, consent handling, form interaction, and verification are real.
Local pages make the demo reproducible on bad Wi-Fi, which matters for a live
presentation. The same skills have fallbacks for external pages, and the repo is
explicit about the boundary.

**What's "phantom mode"?**
The Headless toggle runs the exact same mission without a visible browser window while
still streaming screenshots and events. It's useful for CI and for showing only the
agent's view.

**How would this scale?**
The local JSON memory is the source of truth for one machine. The optional AWS stack
mirrors run records to DynamoDB; the next step is a queue/worker per session, encrypted
credential references, and per-domain policy packs.

**What was the hardest part?**
Making the demo reliable without lying about autonomy: consent banners that don't
close, form fields that trim currency symbols, browser detection, and keeping the UI
truthful when an optional service is down. The verification ladder is the answer.

**What's next?**
A real planner behind the same event contract, a policy editor for tracker/consent
rules, human approval for high-stakes actions, and a hosted run history. The demo is
the trustworthy substrate, not the finished product.

## Failure recovery

| Symptom | Recovery |
| --- | --- |
| Mission Control won't start | Port in use: `python3 -m aegisweb serve --port 8010`. The demo server itself falls back to a free port. |
| Browser doesn't open | Run `python3 -m aegisweb doctor`. Set `AEGIS_CHROME_PATH` or install Chromium. |
| Mission fails mid-run | The trace shows the failing step. Re-run headless: `python3 -m aegisweb demo --headless --pace 0`. A new run replaces `artifacts/latest`, so keep a backup of a successful run if you need it. |
| Voice is silent | Browser speech needs a user gesture; click once in the dashboard. For studio audio, use local clips with `--audio`. |
| ElevenLabs/OpenAI is down | Nothing on the critical path uses them. The demo continues silently/local-only. |
| Projector eats the cursor | Use headless mode and the live screenshot panel; the agent's cursor overlay still appears in shots. |
| Wi-Fi dies | The entire demo is local. AWS sync is optional and fails soft. |
| You need a guaranteed ending | Play the pre-recorded successful run, then show your backed-up `report.md` and screenshots. |

## Judging map

| Criterion | Where to point |
| --- | --- |
| Technical execution | Real Playwright actions, network interception, layered selectors, verification, tests |
| Demo quality | One-click mission, live SSE trace, voice, visible browser, six screenshots, receipt |
| Originality | Privacy-first agent behavior plus explicit cross-tab handoffs and audit evidence |
| Real-world impact | Consent fatigue, repeated research entry, multi-tab workflows, auditable automation |
| Completeness | CLI, dashboard, tests, docs, optional voice, optional AWS, honest scope |
| Feasibility | Runs offline on a laptop; no paid API required; clear extension path |

## Copy-paste commands

```bash
# Main demo
./run_demo.sh

# CLI fallback
python3 -m aegisweb demo --headless --slowmo 0 --pace 0 --no-narration

# Standalone proof
python3 scripts/happy_path.py --headless

# Tests
python3 -m pytest -q

# Health check
python3 -m aegisweb doctor
```
