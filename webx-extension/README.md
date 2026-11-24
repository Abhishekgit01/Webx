# Webx Chrome extension

A Manifest V3 side-panel agent for the browser you are already using. It rejects
cookie banners, extracts a product price, carries the value across tabs, fills a
target form, and verifies the receipt. The extension is vanilla HTML, CSS, and
JavaScript with no build step.

The Python/Playwright agent in the repository root remains the reference
implementation and test fixture. This extension is the interactive product surface.

## Features

- Side Panel UI with voice capture, live runbook, logs, and captured data
- Privacy sentinel for common consent selectors, text heuristics, and CMP frames
- Price extraction from data attributes, JSON-LD, microdata, meta tags, price
  selectors, and a text fallback
- Cross-tab handoff using `chrome.storage.session`, `chrome.tabs`, and content scripts
- Native input setters with input/change events, fill verification, submit, and receipt check
- ElevenLabs speech-to-text and text-to-speech, with browser speech and typed-command fallbacks
- Static `declarativeNetRequest` rules for common tracker hosts and the local demo tracker path
- Optional AWS API Gateway/run-memory sync with an offline-safe local state
- `[Webx :: <Component>]` console logs and retrying DOM operations

## Requirements

- Chrome 116 or newer (Side Panel API)
- For the local happy path: the demo server from the repository root
- Optional: an ElevenLabs API key
- Optional: a deployed Webx run-memory endpoint

## Load the extension

1. Start the local demo server from the repository root:

   ```bash
   ./run_demo.sh
   ```

   The storefront is at `http://127.0.0.1:4173/shop/` and the target form is at
   `http://127.0.0.1:4173/form/`.

2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `webx-extension/` directory.
5. Pin Webx to the toolbar. Click the icon, or press `Ctrl+Shift+Y`
   (`Command+Shift+Y` on macOS), to open the side panel.

Reload the extension from `chrome://extensions` after changing a file. Tabs that
were already open receive the content script on the next action, or after a reload.

## Demo path

1. Open `http://127.0.0.1:4173/shop/` in a normal tab.
2. Open the Webx side panel. The privacy sentinel rejects the demo banner.
3. Click **Listen** and say:

   > Get price and apply to target sheet

   or type the same command in the command bar. Text commands work without a
   microphone, network, or API key.
4. Webx captures `$149.00` for the Ridgeline Field Lantern.
5. It opens or focuses the research form at `http://127.0.0.1:4173/form/`.
6. It fills the price, product, source URL, and notes, then submits the form.
7. The receipt is verified. With ElevenLabs configured, the side panel speaks:

   > Price of $149.00 has been captured and populated into the target form.

The runbook shows each phase as it happens. **Captured data** keeps the last value
even if the mission stops, so **Fill form** can retry the handoff.

## Commands

| Command | Action |
| --- | --- |
| `Get price and apply to target sheet` | Full mission: consent, extract, handoff, fill, verify |
| `Reject all cookies` | Run the privacy sentinel on the active tab |
| `Capture the price` | Extract and store a price without opening the target form |
| `Fill the target form` | Apply the stored capture to the target form |
| `Open the local storefront` | Focus or open the demo storefront |
| `Sync to AWS` | Send the last verified run summary to the configured endpoint |
| `Reset the session` | Clear session state and the captured value |

Quick-action chips use the same command parser. The command bar is the fallback
for environments where microphone capture or speech recognition is unavailable.

## Settings

Open settings from the gear icon or the voice-engine pill. Settings live in
`chrome.storage.local` on this browser profile. API keys are never sent to content
scripts, pages, or the activity log.

| Setting | Default | Purpose |
| --- | --- | --- |
| ElevenLabs API key | empty | Enables ElevenLabs STT/TTS |
| Voice ID | `21m00Tcm4TlvDq8ikWAM` | ElevenLabs TTS voice |
| TTS model | `eleven_turbo_v2_5` | ElevenLabs speech synthesis model |
| STT model | `scribe_v1` | ElevenLabs speech-to-text model |
| Speak confirmations | on | Play verified-mission audio |
| Target form URL | `http://127.0.0.1:4173/form/` | Page the agent fills |
| Reject consent automatically | on | Run the sentinel without waiting for a command |
| AWS endpoint | empty | API Gateway `POST /runs` endpoint |
| Bearer token | empty | Optional shared secret for the endpoint |
| Sync run summaries | off | Send verified runs after completion |

### Voice fallback behavior

- With an ElevenLabs key, **Listen** records audio and sends it to
  `POST https://api.elevenlabs.io/v1/speech-to-text`.
- Without a key, it uses `SpeechRecognition` / `webkitSpeechRecognition`.
- If ElevenLabs STT fails, the panel falls back to browser recognition.
- TTS uses the ElevenLabs `text-to-speech` endpoint when a key is configured;
  otherwise it uses `speechSynthesis`.
- If both voice paths fail, the transcript and command bar still work.

Microphone permission is requested by Chrome the first time you record.

## AWS run memory

The optional AWS path mirrors verified run summaries to the stack in
[`../infra/README.md`](../infra/README.md). Set the API Gateway endpoint and,
if configured, the bearer token in settings, then enable **Sync run summaries**.
The payload matches the `POST /runs` contract:

```json
{
  "runId": "run-...",
  "task": "Capture a product price and populate the target form",
  "status": "complete",
  "price": "$149.00",
  "product": "Ridgeline Field Lantern",
  "trackersBlocked": 3,
  "tabs": 2,
  "createdAt": "2026-11-24T20:00:00.000Z",
  "result": {
    "success": true,
    "form_submitted": true,
    "duration_seconds": 8.4,
    "receipt": {}
  }
}
```

Cloud sync is best-effort. A failure shows `Cloud offline — local memory kept` and
the mission remains complete. Only run summaries are sent; page content, form
values, browsing history, and credentials stay local.

## Permissions

| Permission | Reason |
| --- | --- |
| `sidePanel` | Host the agent UI |
| `storage` | Session state and local settings |
| `tabs` | Find the active product page and the target form tab |
| `scripting` | Inject the content script into tabs opened before install |
| `activeTab` | Act on the current tab after a user action |
| `declarativeNetRequest` | Apply the static tracker rules |
| `<all_urls>` | Run the sentinel on product pages and attach to the local demo |

The content script declares `all_frames` so consent forms rendered inside CMP
iframes can dismiss themselves. Only the top frame answers agent commands.

## Structure

```
webx-extension/
├── manifest.json
├── background.js        Message router, mission state, tab orchestration, AWS sync
├── content.js           Consent sentinel, price extraction, form fill and receipt
├── rules/trackers.json  Declarative Net Request tracker rules
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js     Voice capture, TTS, state rendering, settings
└── assets/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Troubleshooting

- **"This page cannot be automated"** — Chrome internal pages and the Web Store are
  off limits. Open a normal `http(s)` page.
- **"The target form did not load"** — run `./run_demo.sh` from the repository root,
  or change the target URL in settings.
- **No content script response** — reload the tab, then run the action again. The
  background injects `content.js` when needed but cannot attach to restricted pages.
- **Microphone unavailable** — grant microphone permission to the extension, or type
  the command. Text commands are the deterministic fallback.
- **ElevenLabs 401 or quota error** — replace the key in settings. The panel falls
  back to browser voice or text.
- **No tracker count on a real site** — the metric counts declared tracker nodes
  that did not load. Rules still apply at the network layer; dynamically injected
  trackers are not visible to the content script.
- **Consent banner not dismissed** — the sentinel handles common selectors, buttons,
  and accessible text. Shadow-DOM-only CMPs and unusual consent flows may need a
  selector addition.

## Scope

The included flow is tuned for the local Nimbus storefront and research form. It
does not attempt purchases, authentication, or CAPTCHA solving. The form filler
supports standard inputs and textareas with label/name/placeholder matching; it does
not handle canvas forms or cross-origin form iframes.
