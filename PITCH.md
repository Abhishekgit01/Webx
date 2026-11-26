# Webx — Project Pitch & Chrome Extension Operational Guide

A quick-reference guide covering the project pitch, demo script, architecture story, and an exhaustive breakdown of the Webx Chrome Extension.

---

## Part 1: How to Pitch Webx (Hackathon / Judge Pitch)

### 1. The Core Hook (The Problem)
> *"Most AI agent demos show the same thing: a chatbot pretending it booked your flight. In reality, the modern web is hostile to autonomous agents: manipulative cookie consent walls designed to trap users, tracker bloat, dynamic anti-bot DOMs, and context stranded across different browser tabs. **Webx** is an open-source, local-first browser agent engineered to solve the hostile web first."*

### 2. The 3 Value Pillars
1. **Guarded Autonomy (No Hallucinations)**:
   - Instead of letting an unpredictable LLM wander and click aimlessly, Webx executes a **deterministic 5-phase runbook**: *Navigate → Privacy Defense → Price Extraction → Cross-Tab Memory Handoff → Form Fill & Verified Submission*.
   - Uses an intelligent fallback ladder: stable data attributes → semantic ARIA → DOM walker → optional vision model.
2. **Built-in Privacy Sentinel**:
   - Rejects cookie banners using fuzzy matching (*"Reject all"*, *"Decline"*, *"Necessary Only"*) and **aborts tracker requests at the network layer** (`declarativeNetRequest` in the extension, Playwright network route aborts in Python).
3. **Cross-Tab Memory without Clipboard Leakage**:
   - Moves data between tabs via an isolated memory bus (`memory.json` in Python, `chrome.storage.session` in the extension), preventing OS clipboard hijacking and guaranteeing verifiable data provenance.

### 3. The 3-Minute Demo Run Sheet

| Timestamp | Phase | What to Say / Show |
|---|---|---|
| **0:00–0:30** | **Hook & Brief** | Open Mission Control (`http://127.0.0.1:8000`) or the Chrome Side Panel. Explain the brief: *"Reject the cookie wall, find the product price, carry it into our research form, and verify submission."* Show that no API keys or cloud setup are required. |
| **0:30–1:15** | **Privacy & Extraction** | Watch the browser navigate to the storefront. Point out the privacy sentinel rejecting non-essential cookies and blocking 3 tracker network requests. Show the audit tag capturing `$149.00` via structured data attributes. |
| **1:15–2:00** | **Cross-Tab Handoff & Auto-Fill** | Tab 2 opens. The value moves through agent memory into the form input, submits, and waits for a receipt confirmation. |
| **2:00–3:00** | **Evidence Package & Architecture** | Open `report.md`, show the 6 step-by-step screenshots, and explain that the entire flow runs completely offline with 0 cloud dependencies, while supporting optional AWS SAM sync. |

---

## Part 2: Operating the Webx Chrome Extension

### 1. Installation
1. Open Google Chrome and go to `chrome://extensions`.
2. Toggle on **Developer mode** (top-right corner).
3. Click **Load unpacked** (top-left) and select `C:\Projects\Webx\webx-extension`.
4. Click the puzzle icon on the Chrome toolbar and pin **Webx**.

### 2. Opening the Side Panel
* Click the **Webx shield icon** on the toolbar, OR
* Press keyboard shortcut **`Ctrl + Shift + Y`** (macOS: `Cmd + Shift + Y`).

---

### 3. The Three Operating Modes

#### Mode A: Full Autonomous Mission (1-Click or Voice)
1. In your browser tab, open any product page with a visible price (e.g. `http://127.0.0.1:4173/shop/` or any live e-commerce site).
2. Open the Webx side panel.
3. Click the blue **"Run mission"** quick-action chip, OR tap the microphone button and say:  
   > *"Get price and apply to target form"*
4. **Execution flow:**
   - **Step 1 (Privacy):** Scans for and declines any cookie banner.
   - **Step 2 (Capture):** Extracts product name and price.
   - **Step 3 (Handoff):** Opens or focuses the target form tab.
   - **Step 4 (Form Fill):** Injects the extracted price into the input field.
   - **Step 5 (Verify):** Submits the form and verifies Google's `/formResponse` or local receipt.

#### Mode B: Interactive Step-by-Step (Tab-Switch Auto-Fill)
1. Open a product page and click **"Capture price"** (or say *"Capture the price"*).
2. The captured price (e.g. `$149.00`) is stored in session memory and displayed under **Captured data**.
3. Switch tabs to the target form.
4. **Auto-Fill Magic:** The background service worker detects the tab change and immediately types the captured price into the form field, leaving the final submission for you to review.

#### Mode C: Offline Local Demo Fallback
1. Start the local server:
   ```powershell
   .\.venv\Scripts\python.exe -m webx serve
   ```
2. In Chrome, open `http://127.0.0.1:4173/shop/`.
3. In side panel Settings (gear icon), set **Target form URL** to `http://127.0.0.1:4173/form/`.
4. Click **"Run mission"**.

---

## Part 3: Deep Dive into Extension Architecture & Codebase

### File Structure
```text
webx-extension/
├── manifest.json            # Manifest V3 permissions, declarativeNetRequest rules
├── background.js            # Service worker: orchestration, session memory, tab listeners
├── content.js               # Injected DOM script: consent rejecting, price capture, form fill
├── rules/
│   └── trackers.json        # DeclarativeNetRequest rules blocking tracking endpoints
├── sidepanel/
│   ├── sidepanel.html       # Side Panel UI: voice zone, command bar, runbook, metrics
│   ├── sidepanel.css        # Responsive dark-theme styling
│   └── sidepanel.js         # Side panel state management, speech synthesis/STT, AWS trigger
└── assets/                  # 16px, 48px, 128px extension icons
```

### Component Details

#### 1. `manifest.json` (The Blueprint)
* **Manifest V3** with zero build steps.
* Key permissions:
  * `sidePanel`: Persistent sidebar alongside browsing tabs.
  * `declarativeNetRequest`: Network-level tracker blocking before requests touch the network.
  * `scripting` & `activeTab`: Dynamic injection of content scripts across live web pages.
  * `storage`: `chrome.storage.local` for settings, `chrome.storage.session` for transient agent facts.
* Shortcut: `Ctrl+Shift+Y` (`Cmd+Shift+Y` on Mac).

#### 2. `content.js` (In-Page Execution Engine)
* **Privacy Sentinel (`looksLikeConsent`, `dismissConsent`)**:
  - Detects CMPs: OneTrust, Cookiebot, standard `role="dialog"` banners.
  - Regex matcher for rejection buttons: `/(reject|decline|necessary only|only essential|do not sell)/i`.
  - Clicks rejection button and verifies the dialog actually closed.
* **Price Extraction (`extractPrice`)**:
  - Tries DOM selectors: `[data-price]`, `.product-price`, `.price`, `[itemprop='price']`.
  - Fallbacks: `JSON-LD` schemas, microdata, OpenGraph tags, regex currency symbols (`$`, `€`, `£`).
* **Form Fill & Verification (`fillForm`, `injectGoogleForm`)**:
  - Injects values into inputs (including Google Forms `input[type="text"].whsOnd.zHQkBf`).
  - Dispatches native `input`, `change`, and `blur` events so framework-bound inputs (React/Angular) sync properly.
  - Verifies value presence and monitors navigation to confirmation pages (`/formResponse`).

#### 3. `background.js` (Service Worker & Orchestration)
* **State Manager**: Manages run phases `["consent", "capture", "handoff", "fill", "verify"]`.
* **Tab-Switch Listener**: Hooks into `chrome.tabs.onActivated` to automatically inject stored prices when transitioning to a form tab.
* **Message Router**: Bridges messages between `sidepanel.js` (UI) and `content.js` (DOM).

#### 4. `rules/trackers.json` (Network Blocker)
* Declarative rules blocking Google Analytics, GTM, DoubleClick, Facebook Pixel, Hotjar, Segment, and Mixpanel requests.

#### 5. `sidepanel/` (User Interface)
* **Voice Integration**: Web Speech API native recognition + ElevenLabs neural voice synthesis.
* **Command Bar**: Text command fallback with quick-action chips.
* **Live Runbook**: Visual stepper displaying each phase's live execution state.
* **Captured Data Drawer**: Displays extracted price, product name, extraction method tag, and source link.
* **Telemetry Metrics**: Real-time counter of trackers blocked, tabs orchestrated, and duration.
* **Run Memory (AWS Sync)**: Status indicator for AWS cloud sync (`Local only` vs `Synced to AWS`).

---

## Part 4: Frequently Asked Questions & Pitch Handling

### Q: Why does the side panel say *"Run memory: No endpoint configured / not synced"*?
> *"Webx is strictly local-first: all evidence, memories, and reports are saved locally on your device in `artifacts/latest/`. The AWS sync is an optional enterprise feature using the SAM template in `infra/` (API Gateway → Lambda → DynamoDB). If no cloud endpoint is configured, Webx runs 100% offline and never fails a mission."*

### Q: How does Webx handle websites with hostile anti-bot controls or unexpected UI?
> *"Webx uses a tiered resilience ladder. It checks stable structured data attributes and JSON-LD first. If standard selectors fail, it falls back to semantic ARIA attributes and DOM walking. For unfamiliar custom controls, Webx can optionally invoke an LLM vision fallback to calculate click coordinates without placing an LLM on the critical path."*
