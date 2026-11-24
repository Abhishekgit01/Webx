# Webx

A local-first browser agent with a Python/Playwright reference implementation and a
Manifest V3 Chrome extension. Both run the same storefront-to-form workflow: reject a
cookie banner, block tracker requests, extract the first product price, carry the
value across tabs, and verify a form submission.

The extension also works on live pages: it rejects cookie banners with a fuzzy
text pass, reads live product prices, and injects the value into a Google Form when
you switch tabs. The Python demo stays deterministic and offline. No API keys or
cloud account are required.

## Features

- Browser automation with Playwright
- Manifest V3 Chrome extension with a voice-controlled side panel
- Voice commands through ElevenLabs or browser speech, with a typed fallback
- Cookie-consent rejection with verified state
- Network-level tracker blocking
- Product extraction with data-attribute, JSON-LD, and text fallbacks
- Live-site extension path: fuzzy `Reject`/`Decline`/`Necessary Only` matching,
  live price selectors, Google Forms injection, and tab-switch auto-fill
- Cross-tab memory with explicit handoffs
- Form fill, submission, and receipt verification
- FastAPI dashboard with a live SSE event trace and screenshots
- Optional OpenAI/Anthropic vision fallback for unfamiliar controls
- Optional ElevenLabs narration and local audio playback
- Optional AWS run-memory stack: API Gateway, Lambda, and DynamoDB

## Requirements

- Python 3.10+
- Google Chrome, Chromium, or Brave (auto-detected)
- Linux, macOS, or Windows

## Setup

```bash
cd webx
python3 -m pip install -r requirements-dev.txt
./run_demo.sh
```

`run_demo.sh` installs any missing Python packages, starts the local demo server, and
opens <http://127.0.0.1:8000>. Click **Run mission** in the dashboard.

If no system browser is available, install Playwright's Chromium once:

```bash
python3 -m playwright install chromium
```

You can also set `WEBX_CHROME_PATH` to a specific browser binary.

## Usage

Run the agent from the terminal:

```bash
python3 -m webx doctor
python3 -m webx demo
python3 -m webx demo --headless --slowmo 0 --pace 0 --no-narration
```

Run the standalone Playwright flow:

```bash
python3 scripts/happy_path.py
python3 scripts/happy_path.py --headless
```

`scripts/happy_path.py` is a single-file script that starts its own server and does
not import the `webx` package.

## Chrome extension

`webx-extension/` is a Manifest V3 side-panel agent with no build step. It defaults
to live pages and the provided Google Form; the deterministic local storefront
remains a fallback.

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select the `webx-extension/` directory.
3. Open a live product page with a visible price and click the Webx toolbar icon.
4. Click **Capture the price**, then open the target Google Form. Switching to the
   form tab injects the stored value automatically.
5. For a full run, click **Run mission** or type
   `Get price and apply to target form`. Webx rejects consent, captures the price,
   fills and submits the form, and verifies Google's response page.

The target form URL is configurable in panel settings. Voice uses ElevenLabs when a
key is configured; browser speech and typed commands are the fallbacks. The optional
AWS run-memory endpoint is configured in the same panel, and a failed sync never
blocks a mission.

For the offline fallback, start `./run_demo.sh`, open
<http://127.0.0.1:4173/shop/>, and set the target form URL to
`http://127.0.0.1:4173/form/`. The mission then captures `$149.00` from the demo
storefront and verifies the local receipt.

See [`webx-extension/README.md`](webx-extension/README.md) for load steps,
commands, settings, permissions, and troubleshooting.

## Demo flow

1. Opens the local Nimbus Supply Co. storefront in tab 1.
2. Rejects all non-essential cookies and verifies the consent state.
3. Blocks tracker requests at the network layer.
4. Captures the first product's name and price ($149.00).
5. Opens the research form in tab 2 and moves the price through agent memory.
6. Fills the first field, submits the form, and verifies the receipt.

## Outputs

Each run replaces `artifacts/latest/` with:

| File | Contents |
| --- | --- |
| `report.md` | Outcome, trace table, and screenshot references |
| `run.json` | Mission, result, and structured events |
| `trace.jsonl` | Append-only event stream |
| `memory.json` | Cross-tab facts and handoff records |
| `01-*.png` … `06-*.png` | Six screenshots of the verified flow |

Artifacts are git-ignored. The dashboard serves them from `/artifacts/latest/`.

## How it works

Webx uses a bounded five-phase runbook: open, privacy, extract, handoff, and form.
Every phase performs a real browser action followed by a real verification. Events are
published to the terminal, the dashboard's SSE stream, `trace.jsonl`, and the final
report from a single event bus.

Each skill tries reliable selectors first and falls back only when necessary:

| Step | Fallback order |
| --- | --- |
| Consent | Demo attributes → common banner IDs → accessible role/text → DOM walker → optional vision |
| Price | Product data attributes → price selectors → JSON-LD → body text |
| Form | Labelled fields → first form input → submit button → `requestSubmit()` |
| Verification | Page state and visible receipt, not an assumed delay |

The vision fallback is optional and requires an OpenAI or Anthropic API key.

## Configuration

All integrations are optional and fail without affecting the core demo. Copy
`.env.example` to `.env` only if you need them.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI vision fallback for unfamiliar controls |
| `ANTHROPIC_API_KEY` | Anthropic vision fallback |
| `ELEVENLABS_API_KEY` | ElevenLabs narration |
| `WEBX_COMPLETION_AUDIO` | Path to a custom completion audio clip |
| `WEBX_CLOUD_URL` | AWS run-memory endpoint |
| `WEBX_CLOUD_TOKEN` | Optional bearer token for the AWS endpoint |
| `WEBX_CHROME_PATH` | Explicit Chrome/Chromium binary |

### Voice

The dashboard uses the browser's `SpeechSynthesis` API by default. For ElevenLabs
audio, generate the voice pack and run with `--audio`:

```bash
export ELEVENLABS_API_KEY=...
python3 scripts/generate_tts.py
python3 -m webx demo --audio
```

### AWS run memory

The optional SAM stack stores run summaries in DynamoDB:

```bash
cd infra
sam build
sam deploy --guided
```

Set `WEBX_CLOUD_URL` to the `RunsEndpoint` output. Deployment details, the API
contract, and cleanup steps are in [`infra/README.md`](infra/README.md).

## Commands

| Command | Purpose |
| --- | --- |
| `python3 -m webx serve` | Start Mission Control and the demo server |
| `python3 -m webx demo` | Run the headed agent in the terminal |
| `python3 -m webx demo --headless --pace 0` | Run without pacing |
| `python3 -m webx doctor` | Check dependencies, browser, and optional keys |
| `python3 -m webx tts --dry-run` | Preview the ElevenLabs lines |
| `python3 scripts/happy_path.py` | Run the standalone end-to-end flow |
| `make test` | Run the test suite |

Demo flags: `--task`, `--base-url`, `--port`, `--slowmo`, `--pace`, `--hold`,
`--audio`, `--no-narration`.

## Tests

```bash
python3 -m pytest -q
```

The suite covers mission parsing, a headless end-to-end run with artifact and memory
assertions, and the dashboard API. Browser tests skip if Chrome or Chromium is not
available.

## Project structure

```
webx/
  agent.py          Runbook and mission lifecycle
  browser.py        Playwright session, tracker blocking, screenshots
  skills.py         Consent, extraction, form fill, verification
  memory.py         Cross-tab facts and handoffs
  events.py         Event bus for terminal, SSE, and trace
  dashboard.py      FastAPI API, SSE stream, run runner
  dashboard/        Mission Control UI
  demo_server.py    Local static server
  voice.py          ElevenLabs and local audio
  llm.py            Optional vision fallback
  report.py         report.md and run.json
demo/
  shop/             Demo storefront
  form/             Demo research form
webx-extension/     Manifest V3 Chrome extension (side panel, no build step)
scripts/
  happy_path.py     Standalone single-file demo
  generate_tts.py   ElevenLabs voice pack
tests/
docs/
infra/              SAM, Lambda, and DynamoDB run memory
```

## Scope

The included flow is a guarded runbook tuned to the local storefront and form. It does
not attempt arbitrary purchases, authentication, or CAPTCHA solving. The optional
vision model can click unfamiliar controls, but it is not part of the critical path.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Hackathon runbook](docs/HACKATHON.md)
- [AWS run memory](infra/README.md)

## License

MIT. See [LICENSE](LICENSE).
