# AppyPie CUA Tester — System Design Document v10

> AI-powered QA testing platform for [Appy Pie Automate](https://www.appypieautomate.ai). OpenAI GPT-5.4 autonomously navigates and tests web applications via Playwright. The agent reads the DOM as structured text (with screenshot fallback), decides actions as JSON, executes them through an adapter, and iterates until PASS / FAIL / TIMEOUT.
>
> This document describes every component — major or minor — that participates in the CUA agent's operation.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Monorepo Layout](#3-monorepo-layout)
4. [Core Concepts & Vocabulary](#4-core-concepts--vocabulary)
5. [Runner — CUA Agent Core](#5-runner--cua-agent-core)
6. [Adapter Layer](#6-adapter-layer)
7. [Action Cache (v2)](#7-action-cache-v2)
8. [Queue + Worker](#8-queue--worker)
9. [Persistence (Turso / SQLite)](#9-persistence-turso--sqlite)
10. [HTTP API Surface](#10-http-api-surface)
11. [Services](#11-services)
12. [Middleware & Validation](#12-middleware--validation)
13. [Dashboard](#13-dashboard)
14. [Shared Package](#14-shared-package)
15. [Test Definitions (YAML)](#15-test-definitions-yaml)
16. [Cross-Cutting Behaviors](#16-cross-cutting-behaviors)
17. [Special Handling for Appy Pie UI](#17-special-handling-for-appy-pie-ui)
18. [Data Directory Layout](#18-data-directory-layout)
19. [Environment Configuration](#19-environment-configuration)
20. [Operational Runbook](#20-operational-runbook)

---

## 1. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           AppyPie CUA Tester                                   │
│                                                                                │
│  ┌──────────────────────┐          ┌───────────────────────────────────────┐   │
│  │  Dashboard            │  HTTP    │  API Server (Express)                 │   │
│  │  Next.js 15 + React19 │ ◄──────► │  Port 3001                            │   │
│  │  Port 3002            │  + SSE   │  Helmet · CORS · rate-limit · API-key │   │
│  │                       │          │                                       │   │
│  │  6 Tabs               │          │  Routes: tests · suites · runs ·      │   │
│  │  Run Detail view      │          │          config · metrics             │   │
│  │  Live SSE log         │          │  SSE: /api/runs/:id/events            │   │
│  └──────────────────────┘          │        /api/suites/:id/events         │   │
│                                     └───────┬──────────────┬──────────────┘   │
│                                             │              │                   │
│                                     ┌───────▼────────┐ ┌───▼─────────────┐   │
│                                     │   Turso (libsql)│ │    Redis        │   │
│                                     │   file: local.db│ │    :6379        │   │
│                                     │   OR cloud URL  │ │                 │   │
│                                     │                 │ │  • BullMQ Queue │   │
│                                     │  Tables:        │ │    test-execution│   │
│                                     │  • test_runs    │ │  • DLQ          │   │
│                                     │  • steps        │ │  • Pub/Sub      │   │
│                                     │  • sessions     │ │    (event chan  │   │
│                                     │  • events       │ │     per runId)  │   │
│                                     │  • turn_tokens  │ └─────┬───────────┘   │
│                                     │  • test_defs    │       │                │
│                                     │  • settings     │       ▼                │
│                                     └─────────────────┘  ┌──────────────────┐  │
│                                                          │  BullMQ Worker   │  │
│                                                          │  Playwright      │  │
│                                                          │  Chromium        │  │
│                                                          │  + CUA Loop      │  │
│                                                          │  + OpenAI GPT-5.4│  │
│                                                          │  + FFmpeg        │  │
│                                                          └────────┬─────────┘  │
│                                                                   │             │
│  ┌──────────────────────────────────────────────────────────────▼──────────┐  │
│  │  File Storage: packages/runner/data/                                    │  │
│  │    ├── screenshots/{testId}/{runId}/NNN-turn.png + replay.mp4          │  │
│  │    ├── logs/{testId}/{runId}.md                                         │  │
│  │    ├── cache/action-cache-v2.json                                       │  │
│  │    ├── config.json                                                      │  │
│  │    └── local.db   (Turso SQLite)                                        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Test Definitions: packages/runner/tests/{category}/*.yaml                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technology Stack

| Layer          | Technology                                                     |
|----------------|----------------------------------------------------------------|
| Frontend       | Next.js 15, React 19, Tailwind CSS 4                           |
| API Server     | Express.js, TypeScript (ESM)                                   |
| Database       | Turso / libSQL (local file `file:local.db` or Turso cloud)      |
| Queue          | BullMQ + Redis (Memurai on Windows)                            |
| Browser        | Playwright (Chromium)                                          |
| AI Model       | OpenAI GPT-5.4 (DOM-first text, Vision fallback)               |
| Video          | FFmpeg (subprocess, 1 fps, H.264, scale 1280)                  |
| Validation     | Zod                                                            |
| Logging        | Pino (structured JSON, pretty in dev)                          |
| Security       | Helmet, express-rate-limit, CORS, API-key middleware           |
| Package Mgr    | pnpm workspaces                                                |
| Dev Runtime    | `tsx --env-file=../../.env` (ESM TypeScript watch)             |

---

## 3. Monorepo Layout

```
appypie-cua-tester/
├── package.json                  # Workspace root, scripts: dev, build, test
├── pnpm-workspace.yaml           # Declares packages/*
├── .env                          # Single config source (loaded via tsx)
├── SYSTEM-DESIGN.md              # This document
├── CLAUDE.md                     # Claude Code guidance
├── skills.md                     # Recurring skills / learned patterns
├── IMPROVEMENTS.md               # Backlog of known improvements
└── packages/
    ├── runner/                   # Backend: API + BullMQ worker + CUA loops
    ├── dashboard/                # Frontend: Next.js app
    └── shared/                   # Shared TypeScript types (API contracts)
```

### Root `package.json` scripts

| Script          | Purpose                                                 |
|-----------------|---------------------------------------------------------|
| `pnpm dev`      | Runs runner + dashboard concurrently                    |
| `pnpm build`    | Builds both packages                                    |
| `pnpm test`     | Vitest suite (unit + adapter/vision-decision tests)     |
| `pnpm --filter runner dev` | Just runner (Express + worker)               |
| `pnpm --filter dashboard dev` | Just dashboard (Next.js)                  |

---

## 4. Core Concepts & Vocabulary

| Concept         | Description                                                                                                    |
|-----------------|----------------------------------------------------------------------------------------------------------------|
| **Session**     | Groups multiple test runs from a single "Run Tests" invocation.                                                |
| **TestRun**     | One execution of a test definition. Lifecycle: `queued → running → passed | failed | error | timeout | aborted`. |
| **Step** / Turn | One CUA turn — prompt-to-model → JSON action → execute → validate → screenshot → memory. Stored in `steps`.     |
| **Event**       | Timestamped log entry. Published via Redis pub/sub, streamed via SSE to dashboard.                             |
| **BrowserState**| Snapshot of the page: URL, title, top-N indexed elements, form values, DOM fingerprint, error messages.         |
| **IndexedElement** | An interactable DOM node tagged with a stable 8-char hash ID that survives re-extraction.                   |
| **ActionStep**  | JSON the model returns: `{ action, target, value, reason, expected, memory, next_goal, confidence, ... }`.     |
| **Action Cache**| Two-tier (singles + sequences) per-page-key cache. Replays proven actions with 0ms API cost.                   |
| **Vision Burst**| Temporary switch to screenshot-driven loop (`cua-loop-vision.ts`) when DOM loop is stuck.                       |
| **Mode FSM**    | `DOM_NORMAL` → `DOM_WITH_VISION` (image attached, DOM still authoritative) → `VISION_BURST` (vision loop takes over). |

---

## 5. Runner — CUA Agent Core

### 5.1 Entry: `packages/runner/src/index.ts`

Boot order:

1. `connectDb()` — initialize Turso connection, run migrations.
2. `startWorker()` — register BullMQ worker on the `test-execution` queue.
3. `startCleanupScheduler()` — cron-style cleanup of old runs.
4. `startMetricsScheduler()` — queue depth / failure rate / latency snapshots.
5. `createServer().listen(RUNNER_PORT)` — Express starts on `:3001`.

### 5.2 HTTP Server: `packages/runner/src/server.ts`

- **Middleware stack**:
  1. `helmet()` (CSP disabled to allow screenshot serving).
  2. CORS — allow `localhost:3001`, `localhost:3002`, `127.0.0.1:*`, `10.*.*.*`, `192.168.*.*` (for network-IP dashboard access), plus `DASHBOARD_URL`.
  3. `express.json({ limit: '2mb' })`.
  4. `pino-http` logger with 304 / `/health` / `/screenshots` / `/video` suppression.
  5. `express-rate-limit` — 100 req / 60 s / IP on `/api/*`.
  6. `authMiddleware` — validates `x-api-key` header against `INTERNAL_API_KEY` when configured (pass-through in dev if unset).
- **Routes mounted**: `/api/tests`, `/api/suites`, `/api/runs`, `/api/config`, `/api/metrics`.
- **Error handler** — Zod error formatter at end of chain.
- `GET /health` — unauthenticated readiness check.

### 5.3 DOM-First CUA Loop — `src/cua-loop.ts`

The primary agent. ~1400 lines, orchestrates one turn at a time.

#### 5.3.1 System Prompt

Loaded into every turn. Key directives:

- Follow TEST STEPS exactly, in order.
- Respond with a single JSON object (or a short batch).
- Use stable `elementId`s emitted by the DOM extractor.
- Never guess IDs — if an element isn't in the list, describe it via `value` (text) or `target=none`.
- Login flow rules: click email field → type email → click/tab away → click password field → type password → click "Log In". Never click "Forgot password" / "Sign in with Google".
- Appy Pie custom dropdowns (`.menu_icon-box`): click the icon to open, wait ~3 s, then click the target option.
- Never click expand / fullscreen / maximize icons — they break the side panel layout.
- Never click the WhatsApp widget.
- Fill all required fields before clicking Continue.
- Verdict format:
  ```
  VERDICT: PASS | FAIL
  SUMMARY: ...
  STEPS_COMPLETED: ...
  STEPS_FAILED: ...
  ISSUES: ...
  ```

#### 5.3.2 Mode State Machine

| Mode             | Inputs sent to GPT-5.4                              | When entered                                                                 |
|------------------|------------------------------------------------------|------------------------------------------------------------------------------|
| `DOM_NORMAL`     | Structured text only (~2,500 tokens/turn)            | Default starting state.                                                      |
| `DOM_WITH_VISION`| DOM text + one JPEG screenshot                       | `VisionDecisionEngine` signals low confidence / duplicate text / stuck.       |
| `VISION_BURST`   | Screenshot only, handled by `cua-loop-vision.ts`     | Hard rule fires: consecutive failures, stuck counter maxed, <5 DOM elements. |

Transitions are tracked via `consecutiveFailures`, `consecutiveNonMeaningful`, `consecutiveScrolls`, `sameUrlTurns`, and the vision engine's signals.

#### 5.3.3 Stuck Detection

- **Action-repeat guard**: `lastActionSig` + `consecutiveSameAction`. Hard abort at 5 identical actions.
- **Same-DOM guard**: DOM fingerprint unchanged across 4 turns → flag and consider vision burst.
- **URL watchdog**: `lastUrlPath` + `sameUrlTurns`. At 25 turns on one URL the test auto-FAILs with "Stuck on same URL for 25 turns".
- **`MAX_NO_PROGRESS_TURNS`** = 30 — global hard cap for a test with no visible progress.

#### 5.3.4 Action Cache Integration

- On loop start, `getCacheStats()` logs the current cache size.
- Before every GPT call, the loop queries `getCachedAction(pageKey, elementText)` and `getCachedSequence(pageKey)`.
- Cache hit → emit a pseudo-turn with 0 ms API latency, execute the cached action, continue.
- Cache is skipped when any of these are true:
  - `consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS` (2) — prevents blind replay chains.
  - `lastTurnWasGPT === true` — GPT just acted, let it observe its own result before cache takes over.
  - `stuckContext` is active (we're recovering).
  - `consecutiveFailures > 0`.
  - URL is the homepage (`/` or empty) — homepages are too generic to cache safely.
- On success, the action is recorded via `recordSuccessfulAction()` / `recordSequence()`.

#### 5.3.5 Vision Burst Invocation

```ts
const visionResult = await runCUALoopVision(
  openai, page, visionInstructions, expectedOutcome,
  screenshotDir, runId, callbacks, testAccount, abortSignal,
  VISION_BURST_TURNS, tokenBudget - used, testUrl
);
totalTokens.input    += visionResult.totalTokens.input;
totalTokens.output   += visionResult.totalTokens.output;
totalTokens.reasoning += visionResult.totalTokens.reasoning;
turn += visionResult.turns;
```

`MAX_VISION_BURSTS = 3` per run. Each burst may add up to `VISION_BURST_TURNS` (~40) turns.

#### 5.3.6 Token Tracking Callbacks

The loop emits the following through its `CUALoopCallbacks`:

| Callback            | Fired when                                                          |
|---------------------|---------------------------------------------------------------------|
| `onTurnStart(turn)` | About to call OpenAI for this turn.                                  |
| `onTurnComplete(turn, apiLatencyMs, tokensSoFar)` | After response parsed. Writes `run.input_tokens / output_tokens / reasoning_tokens` to DB. |
| `onTurnTokens(TurnTokenUsage)` | Per-turn row: input, output, reasoning, apiLatencyMs, cumulative_*, mode. Written to `turn_tokens` table. |
| `onActionsExecuted(turn, actions[])` | After adapter runs the decided actions.                     |
| `onScreenshot(turn, screenshot, actionMeta)` | After screenshot is captured. Persists `steps` row.        |

### 5.4 Vision-Burst Loop — `src/cua-loop-vision.ts`

```ts
export async function runCUALoop(
  openai, page, testInstructions, expectedOutcome,
  screenshotDir, runId, callbacks,
  testAccount?, abortSignal?,
  maxTurns, tokenBudget, testUrl?
): Promise<CUALoopResult>
```

- **Executor**: uses `executeAction()` from `src/actions.ts` (legacy path — direct Playwright calls, not the adapter). Kept because the OpenAI Vision model emits primitive `computer_call` actions (`click`, `keypress`, `type`, `scroll`, `wait`, `screenshot`, `move`, `double_click`, `drag`) that are simplest to run raw.
- Sends base-64 JPEG screenshots via `captureScreenshotBase64(page)`.
- Emits the same callbacks as the DOM loop; mode is tagged `'vision'`.
- Returns `{ verdict, modelMessage, turns, totalTokens, pageState? }`.

### 5.5 DOM Extractor — `src/dom-extractor.ts` + embedded JS in `PlaywrightAdapter.getState()`

- Runs inside `page.evaluate()` to scan the live DOM.
- **Selector set** includes: `input, textarea, select, button, a, label, form-checkbox, [role="button"|"link"|"option"|"menuitem"], [data-testid], .dropdown-item, .mat-option, .menu_icon-box, .menu_icon, .selected_value, .menu_dropdown li/a/div, [data-track="continue"|"continue with event"|"select trigger event"|"select action event"]`.
- Produces top-N (`BASE_MAX_ELEMENTS = 30`, scaling with viewport) entries of:
  - `elementId` — 8-char MD5 hash of `tag|id|name|data-testid|aria-label|text[:20]`. Stable across re-extractions.
  - `index`, `tag`, `type`, `text` (trimmed, max 80 chars), `value`, `placeholder`.
  - `attributes` — id, name, data-testid, aria-*, href, role.
  - `boundingBox { x, y, w, h }`.
  - `isInteractable`, `isVisible`.
- Also returns `keyText[]` (headings, labels, error banners), `formValues`, `domFingerprint` (hash of the extracted set), `hasOverlay`, `hasCanvas`, `duplicateTextCount`, `errorMessages[]`.

### 5.6 Vision Decision Engine — `src/vision-decision.ts`

A parallel, logging-only scoring system inside the DOM loop. It **does not itself change mode** — it publishes a recommendation, and the DOM loop's FSM consumes it.

| Signal           | Computation                                                    |
|------------------|----------------------------------------------------------------|
| `sameDOM`        | Count of turns with identical DOM fingerprint.                  |
| `failureScore`   | Weighted sum of recent failure types; decays with turns.        |
| `lowElements`    | True if fewer than 5 interactable elements returned.            |
| `dupText`        | Count of elements sharing identical visible text.               |
| `lowConfidence`  | Last model action's `confidence < 0.60`.                        |
| `intentMismatch` | Parsed `expected` doesn't match post-action DOM changes.        |
| `stuckDuration`  | Turns since last progress event.                                |
| `progressBoost`  | Negative score if URL changed or new elements appeared.         |

Weighted into a `visionScore`. Modes: `dom`, `hybrid`, `full-vision`. A `cooldown` prevents oscillation.

### 5.7 Browser Launch — `src/browser.ts`

- `launchBrowser(headless, viewport, storageStatePath?)` — Chromium, `--disable-blink-features=AutomationControlled`, optional stored `storageState` for resume runs.

### 5.8 Test Account & Config — `src/config.ts`

- Reads / writes `data/config.json` — `{ email, password }`.
- `getTestAccount()` — returns object with `passwordMasked` (first 3 + last 1 chars) for API responses.
- Defaults pulled from `DEFAULT_TEST_EMAIL` / `DEFAULT_TEST_PASSWORD` env vars on first boot.

### 5.9 Test Loader — `src/test-loader.ts`

- `loadAllTests()` — recursively scans `packages/runner/tests/`, parses YAML, infers `page` from parent folder, hydrates into `TestDefinition`.
- `loadTestById(testId)` — single lookup by `id` / file basename.

### 5.10 Legacy Action Executor — `src/actions.ts`

Raw Playwright wrappers used by the vision-burst loop:
- `click(x, y)`, `doubleClick(x, y)`, `keypress(key)`, `type(text)`, `scroll(x, y, dx, dy)`, `wait(ms)`, `screenshot()`, `move(x, y)`, `drag(path)`.

---

## 6. Adapter Layer

Decouples CUA action decisions from Playwright specifics. All DOM-loop actions flow through here.

### 6.1 `src/adapter/types.ts`

```ts
interface ExecutionAdapter {
  // State
  getState(): Promise<BrowserState>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;

  // Clicks
  clickBySelector(selector: string): Promise<ActionResult>;
  clickByText(text: string, role?: string): Promise<ActionResult>;
  clickByCoordinates(x: number, y: number): Promise<ActionResult>;
  doubleClickByCoordinates(x: number, y: number): Promise<ActionResult>;
  doubleClickByText(text: string): Promise<ActionResult>;
  clickByPanelText(text: string): Promise<ActionResult>;

  // Appy Pie-specific
  selectAppyPieEvent(eventText: string): Promise<ActionResult>;
  openAndSelectDropdown(label: string, optionText: string): Promise<ActionResult>;
  insertVariableToken(fieldLabel: string, tokenText: string): Promise<ActionResult>;
  autoFillActionFields(): Promise<{ filled: number; fields: string[] }>;
  clickContinueRunTest(): Promise<ActionResult>;

  // Type / select
  typeBySelector(selector: string, text: string): Promise<ActionResult>;
  typeByContentEditable(selector: string, text: string): Promise<ActionResult>;
  typeByCoordinates(x: number, y: number, text: string): Promise<ActionResult>;
  selectBySelector(selector: string, value: string): Promise<ActionResult>;

  // Navigation / input
  scroll(direction: 'up' | 'down', amount?: number): Promise<ActionResult>;
  navigate(url: string): Promise<ActionResult>;
  keypress(key: string): Promise<ActionResult>;
  wait(ms: number): Promise<ActionResult>;

  // Artifacts
  screenshot(path: string): Promise<void>;
  screenshotJPEG(): Promise<string>;

  // Lifecycle
  close(): Promise<void>;
}
```

### 6.2 `PlaywrightAdapter` — `src/adapter/playwright-adapter.ts`

Raw-execution implementation. Key behaviors:

- **Stable element hashing** — MD5 of `tag|id|name|data-testid|aria-label|text[:20]`.
- **On every `getState()`**:
  - Injects a persistent `<style id="__cua_hide_style">` that hides WhatsApp / chat widgets.
  - Removes expand / fullscreen / maximize buttons smaller than 60×60 px.
  - Auto-login heuristic if `testAccount` was passed in constructor and a login form is detected.
  - Auto-selects an account on `/account/` routes when a linked account chip is visible.
  - On `/options` URLs, calls `autoFillActionFields()` to populate empty `+ Add or Select` fields.
- **`autoFillOnOptionsPage()`** — multi-pass scroll + fill. Up to 5 scroll passes, each followed by `autoFillActionFields()` + direct numeric fill for `quantity / amount`-type fields. Breaks when a pass yields 0 new fills or scroll returns ineffective.
- **`clickByCoordinates(x, y)`** — pure `page.mouse.click(x, y)`. No frills. (A dropdown-option JS-click specialization is the first fix that gets toggled on/off when the Appy Pie `.menu_dropdown-option` race manifests.)
- **`scroll(direction, amount)`** — two strategies:
  1. Find the tallest scrollable right-panel container; set its `scrollTop`.
  2. Move the mouse to the right panel area and dispatch `page.mouse.wheel()`.
- **`clickByPanelText(text)`** — ordered selector walk (label → form-checkbox → a → li → button → div → span → p) with text match, blocklist (`forgot`, `sign up`, `sign in with google`, ...), visibility + size filters. If the hit is a `<label>` with `for` attribute, toggles the referenced checkbox via JS dispatch.
- **`selectAppyPieEvent(eventText)`** — scans `.form-checkbox`, checks the matching box, then clicks "Continue".
- **`openAndSelectDropdown(label, optionText)`** — locates the `<label>` text, finds the sibling `.menu_icon-box` opener, clicks, waits for options, then clicks the matching `.menu_dropdown` item.
- **`autoFillCustomDropdowns()`** — scans `.menu_icon-box` that are required and empty, opens each, picks the first non-placeholder option, and memoizes `_filledDropdowns` + `_failedAutoFills` to avoid retry loops.
- **`clickContinueRunTest()`** — retries up to 10 times (1 s apart) waiting for the button to become enabled.
- **`insertVariableToken(fieldLabel, tokenText)`** — clicks the `+ Add or Select` link next to a field, waits for the picker modal, selects the matching token.
- **`screenshotJPEG()`** — base64 JPEG for vision loops.

### 6.3 Action Engine — `src/adapter/action-engine.ts`

Chooses a strategy chain for each action and validates its effect.

#### 6.3.1 Strategy types

```ts
type ExecutionStrategy = 'selector' | 'text' | 'role' | 'coordinates';
```

#### 6.3.2 Per-action chains

| Action    | Chain order                                                                                   |
|-----------|-----------------------------------------------------------------------------------------------|
| `click`   | Stable selector (`data-testid` → `id` → `_cssSelector`) → unique text → role → coordinates.   |
| `type`    | Click target via same chain → `typeBySelector` / `typeByContentEditable` / `typeByCoordinates`.|
| `select`  | `selectBySelector` (native `<select>`); for custom dropdowns, model is expected to call `click` twice. |
| `scroll`  | Adapter `scroll(direction)` (internally tries panel then wheel).                               |
| `navigate`| Adapter `navigate(url)` with 3 retries + 2 s backoff.                                          |
| `keypress`| Adapter `keypress(key)` with KEY_MAP normalization (`ENTER → Enter`, `PAGEDOWN → PageDown`, …).|
| `wait`    | `setTimeout`.                                                                                  |
| `done`    | Parses verdict from the model's final message and terminates.                                  |

#### 6.3.3 Fallbacks for `target` not in indexed DOM

1. **Panel text search** (`clickByPanelText`) if `value` looks like clickable text.
2. **Fuzzy-text fallback** — find any indexed element whose `text` contains `target` as a substring (case-insensitive).
3. Otherwise: `{ success: false, error: 'Element <target> not found in DOM' }`.

#### 6.3.4 Validation

After execution, a second `getState()` runs. Effectiveness signals:

- `urlChanged` — URL differs from pre-action.
- `domChanged` — DOM fingerprint differs.
- `valueChanged` — any `formValues[id]` contains the typed substring.
- `errorAppeared` — new error message banner.
- `elementStillExists` — target element still present post-action.
- `intentMatch` — heuristic match between `step.expected` keywords and observed changes.

Composite `effective = urlChanged || domChanged || valueChanged || errorAppeared`. Appended to description as `[no effect]` when `success && !effective`.

#### 6.3.5 Retry Strategy Enum

Returned as `retryStrategy` for the loop to consume:

| Value            | Trigger                                                   |
|------------------|-----------------------------------------------------------|
| `none`           | Success + effective.                                      |
| `rescan_dom`     | Element not found / vanished post-action.                 |
| `change_target`  | Found element but click had no effect.                    |
| `fix_input`      | Error banner appeared.                                    |
| `scroll`         | Fields below viewport.                                    |

---

## 7. Action Cache (v2)

### 7.1 File & Schema

- **Location**: `packages/runner/data/cache/action-cache-v2.json`.
- **Shape**:

```jsonc
{
  "version": 2,
  "singles":   { "<pageKey>": CachedSingleAction, ... },
  "sequences": { "<pageKey>": CachedSequence,     ... }
}
```

```ts
interface CachedAction { action; targetText; targetTag; value; confidence; }

interface CachedSingleAction extends CachedAction {
  successCount; lastUsed; urlPattern; description;
}

interface CachedSequence {
  actions: CachedAction[];
  successCount; lastUsed; urlPattern; pageTitle; description;
}
```

### 7.2 URL Normalization

Before deriving the `pageKey`, URLs are normalized to collapse stable paths:

- MongoDB-style IDs (`/[a-f0-9]{24,}/`) → `/*`.
- Generic long IDs (`/[a-z0-9]{20,}/`) → `/*`.
- Numeric IDs (`/\d+/`) → `/#`.
- Trailing slash trimmed.

`pageKey = sha1(normalizedUrlPattern + '|' + pageTitle).slice(0, 12)`.

### 7.3 Match / Resolve

1. Exact match on (normalized) `targetText` + `targetTag`.
2. `includes` / contained-in match on `targetText`.
3. Fuzzy (case-insensitive, whitespace-trimmed).

### 7.4 Recording Rules

- `MIN_CONFIDENCE = 0.80` — only confident actions enter the cache.
- `MIN_SUCCESS_TO_USE_SINGLE = 1`, `MIN_SUCCESS_TO_USE_SEQUENCE = 1` — first success makes it eligible.
- `MAX_SEQUENCE_LENGTH = 8`.
- `STALE_DAYS = 30` — entries older than this are purged on load.
- Homepage (`pathname === '/' || ''`) is excluded unconditionally.

### 7.5 Persistence

- Lazy save every 10 s when `dirty`.
- Synchronous flush on process exit signal.

---

## 8. Queue + Worker

### 8.1 `src/queue/queue.ts`

- **Queue**: `testExecutionQueue` on channel `test-execution`.
- **Retries**: up to 2 with 5 s exponential backoff.
- **Retention**: keep 200 completed, 100 failed.
- **Dead Letter Queue**: `deadLetterQueue` for jobs that exhaust retries.
- **QueueEvents**: shared for observability.

### 8.2 `TestJobData` (payload)

```ts
interface TestJobData {
  sessionId; testRunId; testId; testName; testUrl;
  testInstructions; expectedOutcome;
  headless; requiresAuth;
  maxTurns?; timeout?; viewport?;
  // Resume path
  resumeFromUrl?; resumeContext?; resumeStorageStatePath?; attempt?;
}
```

### 8.3 Worker Lifecycle — `src/queue/worker.ts`

1. **Pick up job** → resolve test definition.
2. **Mark `running`**, initialize `activeAbortControllers[runId]`.
3. **Launch browser** via `launchBrowser()`.
4. **Emit `run_started`** SSE event.
5. **Run `runCUALoopDOM()`** with callbacks (see §5.3.6).
6. **Per turn**:
   - `onTurnComplete` → `updateTestRunStatus` with running totals + `lastHeartbeat`.
   - `checkTokenBudget()` against `settings.maxTokensPerSession`. Aborts job if exceeded.
   - `persistStep` writes the `steps` row.
   - Events are published to Redis per-runId channel.
7. **On finish** — update status + final totals, emit `run_completed`.
8. **Background**: `generateRunLog(testRunId, testId)` writes a Markdown replay to `data/logs/{testId}/{runId}.md`.
9. **Background**: `generateReplayVideo(screenshotDir)` invokes FFmpeg. If it was a resume run, `mergeScreenshotsAndGenerateVideo()` concatenates old + new screenshots into a single video first.
10. **Catch**:
    - If `abortController.signal.aborted` → mark `aborted`, throw `UnrecoverableError` so BullMQ doesn't retry. **The video still gets generated by the happy-path block above because the abort is caught by cua-loop returning `FAIL`, not by a throw.**
    - If error matches `INFRA_PATTERNS` (ECONNREFUSED, Target closed, Navigation timeout, …) → mark `error` and let BullMQ retry.
    - If error matches test-fail patterns (`CUA API error`, `Safety check`, `Token budget exceeded`) → mark `error`, no retry.

### 8.4 FFmpeg Invocation

```
ffmpeg -y -framerate 1 -i <dir>/%03d-turn.png \
       -vf scale=1280:-2 -c:v libx264 -pix_fmt yuv420p -preset fast \
       <dir>/replay.mp4
```

Timeout 60 s. Emits `video_ready` SSE event on success.

---

## 9. Persistence (Turso / SQLite)

### 9.1 `src/db/turso.ts`

- Client: `@libsql/client` — supports both `file:local.db` (default) and `libsql://` cloud URLs (with `TURSO_AUTH_TOKEN`).
- Auto-runs migrations on connect (SQL in-file).

### 9.2 `src/db/repo.ts` — Tables

| Table          | Key Columns                                                                                                          |
|----------------|----------------------------------------------------------------------------------------------------------------------|
| `sessions`     | `id`, `started_at`, `completed_at`, `total`, `passed`, `failed`, `errors`, `timeouts`                                 |
| `test_runs`    | `id`, `session_id`, `test_id`, `test_name`, `status`, `started_at`, `completed_at`, `duration_ms`, `turn_count`, `screenshot_count`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `model_verdict`, `error`, `page_state`, `last_heartbeat` |
| `steps`        | `id`, `test_run_id`, `turn_number`, `file_path`, `captured_at`, `page_url`, `page_title`, `action`, `result`, `validation`, `effective`, `retry_strategy`, `memory`, `next_goal`, `dom_fingerprint`, `confidence`, `vision_used`, `mode`, token cols, api_latency_ms, cumulative cols |
| `turn_tokens`  | `id`, `test_run_id`, `turn_number`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `api_latency_ms`, `cumulative_*`, `mode`, `timestamp` |
| `events`       | `id`, `test_run_id`, `sequence`, `type`, `message`, `detail`, `timestamp`                                             |
| `test_defs`    | `id`, `name`, `url`, `instructions`, `expected_outcome`, `category`, `tags`, `requires_auth`, `max_turns`, `timeout`, `is_active`, `version`, `page` |
| `settings`     | single-row: `maxConcurrency`, `maxTurnsDefault`, `maxTokensPerSession`, `defaultTimeout`, `defaultHeadless`, `allowedDomains`, `cuaMode` |

### 9.3 Repository Functions

- TestRun: `createTestRun`, `getTestRun`, `updateTestRun`, `findRunningTestRuns`, `findPreviousTimeoutRun`, `getLatestRunPerTest`.
- Session: `createSession`, `getSession`, `updateSession`.
- Events: `createEvent`, `getEventsByRun`.
- Steps / screenshots: `createStep`, `getStepScreenshotsByRun`.
- Turn tokens: `createTurnToken`, `getStepTurnTokensByRun`.
- Test defs: `createTestDef`, `getTestDef`, `listActiveTestDefs`, `updateTestDef`.
- Settings: `getSettings`, `updateSettings`.
- Helpers: `jsonParse`, `toSql`, `inClause`, `setClause`.

---

## 10. HTTP API Surface

All routes live under `/api/*` and require the `x-api-key` header when `INTERNAL_API_KEY` is set.

### 10.1 Tests — `src/routes/tests.ts`

| Method | Path                       | Description                                           |
|--------|----------------------------|-------------------------------------------------------|
| GET    | `/api/tests`               | List tests (DB first, YAML fallback, `is_active=1`).   |
| POST   | `/api/tests`               | Create test (Zod validated, auto-generate ID).         |
| GET    | `/api/tests/:testId`       | Fetch test detail.                                     |
| PUT    | `/api/tests/:testId`       | Update test.                                           |
| DELETE | `/api/tests/:testId`       | Soft delete — marks `is_active=0`.                     |
| POST   | `/api/tests/:testId/run`   | Enqueue a single-test run. Returns `{ runId, sessionId }`. |
| POST   | `/api/tests/sync-yaml`     | Re-scan `tests/` and upsert YAML → DB; reactivates `is_active=0` entries that still exist on disk. |

### 10.2 Suites — `src/routes/suites.ts`

| Method | Path                           | Description                                 |
|--------|--------------------------------|---------------------------------------------|
| POST   | `/api/suites`                  | Run full suite (backpressure + dedup).      |
| GET    | `/api/suites`                  | Recent suite runs (`?limit=`).              |
| GET    | `/api/suites/:suiteId`         | Suite detail + child test runs.             |
| POST   | `/api/suites/:suiteId/abort`   | Abort all child runs.                       |
| GET    | `/api/suites/:suiteId/events`  | SSE stream of suite-level events.           |

### 10.3 Runs — `src/routes/runs.ts`

| Method | Path                                      | Description                                                  |
|--------|-------------------------------------------|--------------------------------------------------------------|
| GET    | `/api/runs/latest`                        | Most recent run per test.                                    |
| GET    | `/api/runs/:runId`                        | Run detail: run row, screenshots, events, turn_tokens.        |
| GET    | `/api/runs/:runId/events`                 | SSE stream for live run events. Supports `Last-Event-ID` replay. |
| POST   | `/api/runs/:runId/abort`                  | Abort a single run.                                          |
| GET    | `/api/runs/:runId/screenshots/:filename`  | Serve PNG (path-traversal protected, .png only).              |
| GET    | `/api/runs/:runId/video`                  | Serve `replay.mp4`.                                          |

### 10.4 Config — `src/routes/config.ts`

| Method | Path                        | Description                                |
|--------|-----------------------------|--------------------------------------------|
| GET    | `/api/config/account`       | Returns `{ email, passwordMasked }`.        |
| PUT    | `/api/config/account`       | Update test account credentials.           |
| GET    | `/api/settings`             | System settings row.                       |
| PUT    | `/api/settings`             | Update system settings.                    |
| POST   | `/api/reset`                | Wipe all runs / screenshots / settings.    |

### 10.5 Metrics — `src/routes/metrics.ts`

| Method | Path                  | Description                                         |
|--------|-----------------------|-----------------------------------------------------|
| GET    | `/api/metrics`        | Queue depth, totals, failure rate, avg latency.      |
| GET    | `/api/dlq`            | Dead-letter queue entries.                          |
| POST   | `/api/cleanup`        | Trigger manual retention cleanup.                   |
| POST   | `/api/report/latest`  | Generate latest-run report markdown.                |

---

## 11. Services

- `src/services/test.service.ts` — test-run orchestration: `createTestRun`, `getTestRun`, `getTestRunDetail`, `getLatestRuns`, `updateTestRunStatus`, `persistStep`, `recordTurnTokens`, `updateStepTokens`.
- `src/services/session.service.ts` — session lifecycle: `createSession`, `getSession`, `updateSession`, `completeSession`.
- `src/services/cleanup.service.ts` — cron-style retention: removes runs older than `RETENTION_DAYS` (default 7), preserves last `KEEP_FAILED_RUNS` (default 50) failed runs for triage.
- `src/services/metrics.service.ts` — polled metrics collector. Triggers alert thresholds (`ALERT_FAILURE_RATE`, `ALERT_QUEUE_SIZE`, `ALERT_AVG_LATENCY_MS`).
- `src/services/runlog.service.ts` — generates per-run Markdown log with turn-by-turn action trace, validation outcomes, token usage, and the final event timeline.

---

## 12. Middleware & Validation

- `src/middleware/auth.ts` — `x-api-key` validation. In dev (no `INTERNAL_API_KEY`): pass-through + warn-once log line.
- `src/middleware/error-handler.ts` — `ZodError` → readable `400 { errors: [...] }`.
- `src/middleware/utils.ts` — `escapeHtml()` used on any event message served to SSE.
- `src/validation/test.validation.ts` — Zod schemas: `createTestSchema`, `updateTestSchema` (validates name, URL, instructions, expected outcome, category, tags, maxTurns, timeout, requiresAuth).

---

## 13. Dashboard

Next.js 15 App Router. Client-first: no SSR of run data.

### 13.1 Pages

| Route                          | File                                | Purpose                                      |
|--------------------------------|-------------------------------------|----------------------------------------------|
| `/`                            | `src/app/page.tsx`                  | Main dashboard with 6 tabs.                   |
| `/runs/[runId]`                | `src/app/runs/[runId]/page.tsx`     | Run detail with screenshots, video, logs.     |
| `/history`                     | `src/app/history/page.tsx`          | Past suite runs browser.                      |
| (layout)                       | `src/app/layout.tsx`                | Root layout, theme toggle, nav.               |

### 13.2 Dashboard Tabs (`/`)

1. **Overview** — test list, filters (search, status, category, tag), run-selected / run-all buttons, inline timers.
2. **Results** — pass/fail breakdown, run history, drill-down.
3. **Failures** — failed runs only.
4. **Logs** — live SSE event feed for the active run.
5. **Test Manager** — CRUD for test defs, YAML import, reactivate inactive.
6. **Settings** — system settings, test account, reset-all-data button.

### 13.3 Run Detail Page

- **Stats row**: Duration · Turns · Screenshots · Input Tokens · Output Tokens · Reasoning (all live-updating while `isActive`).
- **Screenshot gallery**: thumbnail strip + large preview, auto-scrolls to the latest screenshot on new turn.
- **Replay video**: appears once `hasVideo` resolves. Polled every 2 s for up to 60 s after the run leaves `running/queued` state; also triggered by the `video_ready` SSE event.
- **Token Usage Breakdown**: Total Input / Total Output / Reasoning / DOM Tokens (dom-mode turns) / Vision Tokens (vision/vision-burst turns) / Avg per Turn. Expandable per-turn table.
- **Live SSE log**: streamed from `/api/runs/:runId/events`, with per-event type badges.
- **Agent memory panel**: the last `memory` / `next_goal` / `confidence` / `stepsCompleted` emitted by the model.
- **Stop button** visible while `isActive`.

### 13.4 Dashboard Library Modules

| File                         | Purpose                                                                                       |
|------------------------------|-----------------------------------------------------------------------------------------------|
| `src/lib/api.ts`             | Fetch wrappers: `fetchTests`, `fetchSuites`, `fetchSuiteDetail`, `fetchRunDetail`, `startSuite`, `abortRun`, `updateSettings`, `createTest`, `updateTest`, `deleteTest`, `importTests`, etc. |
| `src/lib/use-sse.ts`         | `useSSE(url)` React hook — opens EventSource, accumulates events, handles reconnect via `Last-Event-ID`, detects `stream_end`. |
| `src/lib/use-quick-test.ts`  | Inline "Run now" helper that wraps `startSingleTest`.                                          |

### 13.5 Dashboard Polling & SSE

- **Run state poll**: every 3 s while `isActive`.
- **Video poll**: independent effect — triggers when run transitions to any terminal state (`aborted`, `failed`, `timeout`, `error`, `passed`). Polls HEAD `/video` every 2 s up to 30 attempts.
- **SSE refresh**: any new live event re-fetches `/api/runs/:runId`.
- **video_ready event**: immediate HEAD re-check.

---

## 14. Shared Package

`packages/shared/src/index.ts` exports API contract types consumed by both runner and dashboard:

- `TestDefinition`, `TestRun`, `TestStatus`, `SuiteRun`.
- `Screenshot`, `RunEvent`, `TurnToken`, `RunDetail`.
- `SystemSettings`, `TestAccount`.
- `TabId` (dashboard-specific enum).

---

## 15. Test Definitions (YAML)

### 15.1 Directory Structure

```
packages/runner/tests/
├── auth/
├── connect/          # 4 YAML files (Create Connect flows)
├── help/
├── homepage/         # 4 YAML files (Pricing, header nav, logo home, Features)
├── navigation/       # error-page-handling etc.
├── pricing/
├── search/
└── <runtime tests>.test.ts   # Vitest unit tests for action-engine / vision-decision
```

### 15.2 Test YAML Schema

```yaml
name: "Create Connect - Google Sheets to Gmail Draft"  # required
url: "https://connectcloud.appypie.com/connects"      # required
category: "regression"                                # smoke | sanity | regression | e2e
requires_auth: true                                   # default false
max_turns: 80                                         # override default
timeout: 900000                                       # ms, default 120000
viewport: { width: 1440, height: 900 }                # optional
tags: ["connect", "google-sheets", "gmail"]
expected_outcome: "Connect is created and Active"
instructions: |
  1. Step 1 ...
  2. Step 2 ...
```

`page` is inferred from the parent directory name.

---

## 16. Cross-Cutting Behaviors

### 16.1 SSE Event Flow

```
worker.ts  ──►  Redis publisher  ──►  channel "run:<runId>"  ──►  /api/runs/:runId/events  ──►  useSSE()
```

Event types emitted:

| Type                | Emitted by                                           |
|---------------------|------------------------------------------------------|
| `run_started`       | Worker on pickup.                                    |
| `auth_info`         | Worker before first navigation when auth is required.|
| `turn_completed`    | DOM loop / vision loop (`started` and `complete`).    |
| `actions_executed`  | After adapter runs decided actions.                   |
| `screenshot_captured` | After each screenshot write.                       |
| `run_completed`     | Final verdict (passed/failed/aborted/timeout/error). |
| `run_failed`        | Abort path / unrecoverable error.                    |
| `video_ready`       | Background FFmpeg finished.                          |
| `log_generated`     | Background Markdown log written.                     |
| `stream_end`        | Sentinel when the SSE route closes.                  |

### 16.2 Token Budget Enforcement

- Source: `settings.maxTokensPerSession` (default 500,000).
- Checked in `onTurnComplete` via `checkTokenBudget(testRunId, tokensSoFar, abortController, emitEvent)`.
- At 80% → warning event.
- At 100% → abort + `run_failed` event with message "Token budget exceeded".

### 16.3 Abort Flow

1. Dashboard "Stop" button → `POST /api/runs/:runId/abort`.
2. Route calls `abortTestRun(runId)` which does `activeAbortControllers.get(runId)?.abort()`.
3. CUA loop checks `abortSignal.aborted` before every OpenAI call and action execution.
4. On abort mid-loop, cua-loop returns `{ verdict: 'FAIL', modelMessage: 'Test was aborted by user' }`.
5. Worker's happy path updates status → `aborted`, emits `run_completed`, still fires background video + log.
6. Dashboard's video poll detects the new `replay.mp4` within 60 s.

### 16.4 Auth Flow (Test Credentials)

1. Credentials stored in `data/config.json` (plain text; protected by OS file perms).
2. `getTestAccount()` returns them on test enqueue; passed through `TestJobData` into the worker.
3. Worker constructs `PlaywrightAdapter` with `{ email, password }`.
4. On each `getState()`, the adapter's `autoLogin()` sub-routine detects an email field and runs: click email → type → click/tab → password → type → click "Log In".
5. Storage state (cookies / localStorage) is snapshotted after successful auth to `data/storage-state/{runId}.json` for resume reuse.

### 16.5 Video Generation Exact Path

```
data/screenshots/{testId}/{runId}/000-turn.png
                                  001-turn.png
                                  ...
                                  NNN-turn.png
                                  replay.mp4
```

Fires for **every** terminal state (passed, failed, aborted, timeout, error) because it lives inside the worker's happy-path `try` block, which is reached whenever cua-loop returns gracefully — including when the loop detects `abortSignal` and returns FAIL.

### 16.6 Resume Flow (Timeouts / Transient 503s)

- `findPreviousTimeoutRun(testId, excludeRunId)` locates the last timed-out run for the same test.
- If found, worker launches browser with its `storageStatePath` and re-navigates to `resumeFromUrl` with the `resumeContext` text appended to the instructions.
- Screenshots from the old run are copied (renumbered) into a `_merged/` dir, then `mergeScreenshotsAndGenerateVideo()` produces one continuous video.

---

## 17. Special Handling for Appy Pie UI

### 17.1 Custom Dropdowns (`.menu_icon-box` + `.menu_dropdown`)

Structure:

```html
<div class="menu" id="menu-drop0">
  <input id="spreadsheetId" hidden>
  <div class="selected_value"></div>
  <div class="menu_icon-box"><div class="menu_icon"></div></div>
  <div class="menu_dropdown open-up">
    <input placeholder="Search...">
    <ul>
      <li class="menu_dropdown-option" id="single-dropdown" value="0">Test sheet</li>
      <li class="menu_dropdown-option" id="single-dropdown" value="0">Demand Genration</li>
      ...
    </ul>
  </div>
</div>
```

Gotchas:

- All `<li>` options share `id="single-dropdown"` and `value="0"` — uniqueness comes from `textContent` only.
- When the dropdown opens, Angular may swap its container to `.custom-editor-mobile-menu` and re-render the `<ul>`, invalidating any `data-*` tags set before the swap.
- The outside-click handler on `.menu_dropdown` can race the option's own click handler when the click is dispatched as a raw `mouse.click(x, y)` — causing the panel to close *without* committing the selection.

Handled by:

- `openAndSelectDropdown()` — label-based open + pick.
- `autoFillCustomDropdowns()` — proactive fill of empty required dropdowns on options pages.
- A dropdown-option JS-click specialization may be layered into `clickByCoordinates` when the race manifests (detects option via `elementFromPoint()` → dispatches `mousedown` / `mouseup` / `.click()` synchronously inside one `page.evaluate` so the commit precedes the Angular re-render). Enabled/disabled depending on whether the reverted-or-restored fix is currently in the file.

### 17.2 Variable Token Pickers (`+ Add or Select`)

- Each variable-enabled field shows a `+ Add or Select` button next to it.
- Clicking opens a modal with variables from the trigger output (e.g. `{{SpreadsheetRow.A}}`).
- `insertVariableToken(fieldLabel, tokenText)` encapsulates the flow.

### 17.3 Auto-Fill on Options Page

- Triggered on URLs containing `/options/`.
- Multi-pass scroll-and-fill:
  1. Scan for empty `+ Add or Select` fields.
  2. Fill each with the first viable variable token.
  3. Direct-fill numeric fields (`quantity`, `amount`) with sensible defaults.
  4. Scroll 400 px down.
  5. Repeat until two consecutive empty passes or scroll becomes ineffective.

### 17.4 Layout Hazards

- Expand / fullscreen / maximize icons on side panels break the layout — the adapter removes them on every `getState()`.
- WhatsApp widget (green circle) is hidden via persistent CSS.
- Clicking the connect title/name at the top activates a text input that hides the "Add Action App" button — system prompt forbids it.

---

## 18. Data Directory Layout

```
packages/runner/data/
├── config.json                            # { email, password } for test account
├── local.db                               # SQLite when TURSO_DATABASE_URL=file:local.db
├── cache/
│   └── action-cache-v2.json               # Two-tier action cache
├── logs/
│   └── {testId}/{runId}.md                # Generated run log
├── screenshots/
│   └── {testId}/{runId}/
│       ├── 000-turn.png
│       ├── 001-turn.png
│       ├── ...
│       ├── replay.mp4
│       └── _merged/                       # Temporary, for resume video merge
└── storage-state/
    └── {runId}.json                       # Playwright storage snapshot (cookies/localStorage)
```

---

## 19. Environment Configuration

Loaded by `tsx --env-file=../../.env` on the runner. Dashboard reads `NEXT_PUBLIC_*` via Next.

| Variable                     | Default                        | Purpose                                           |
|------------------------------|--------------------------------|---------------------------------------------------|
| `OPENAI_API_KEY`             | *(required)*                   | GPT-5.4 calls.                                    |
| `TURSO_DATABASE_URL`         | `file:local.db`                | libSQL connection (local file or cloud URL).       |
| `TURSO_AUTH_TOKEN`           | —                              | Required only for Turso cloud.                    |
| `REDIS_URL`                  | `redis://127.0.0.1:6379`       | BullMQ + pub/sub.                                 |
| `RUNNER_PORT`                | `3001`                         | Express bind port.                                |
| `NEXT_PUBLIC_API_URL`        | `http://localhost:3001`        | Dashboard → runner.                               |
| `DASHBOARD_URL`              | `http://localhost:3002`        | CORS allow-list entry.                            |
| `INTERNAL_API_KEY`           | — (dev: unset)                 | `x-api-key` required in production.                |
| `ALLOWED_DOMAINS`            | `appypieautomate.ai,connectcloud.appypie.com,appypie.com` | Navigation guard (future use). |
| `DEFAULT_TEST_EMAIL`         | —                              | Bootstrap test account on first run.              |
| `DEFAULT_TEST_PASSWORD`      | —                              | Bootstrap test account on first run.              |
| `LOG_LEVEL`                  | `info`                         | Pino level.                                       |
| `RETENTION_DAYS`             | `7`                            | Cleanup threshold.                                |
| `KEEP_FAILED_RUNS`           | `50`                           | Preserve N failed runs globally.                  |
| `ALERT_FAILURE_RATE`         | `0.30`                         | Metrics scheduler threshold.                      |
| `ALERT_QUEUE_SIZE`           | `10`                           | Metrics scheduler threshold.                      |
| `ALERT_AVG_LATENCY_MS`       | `300000`                       | Metrics scheduler threshold.                      |
| `NODE_ENV`                   | `development`                  | Production toggles stricter auth.                 |

---

## 20. Operational Runbook

### 20.1 Prerequisites

1. **Node.js** ≥ 20, **pnpm** ≥ 9.
2. **Redis** on `:6379` (Memurai on Windows).
3. **FFmpeg** in PATH.
4. `OPENAI_API_KEY` in root `.env`.

### 20.2 First-time setup

```bash
pnpm install
cp .env.example .env   # fill in OPENAI_API_KEY etc.
pnpm dev               # runs runner + dashboard
```

Dashboard → `http://localhost:3002`. API → `http://localhost:3001/health`.

### 20.3 Running a test

- Via Dashboard → Overview tab → select → Run.
- Via API:
  ```bash
  curl -X POST http://localhost:3001/api/tests/<testId>/run \
       -H 'x-api-key: ...'
  ```

### 20.4 Troubleshooting

| Symptom                                      | Check                                                              |
|----------------------------------------------|--------------------------------------------------------------------|
| `EADDRINUSE :3001`                           | Previous runner still running. `netstat -ano \| findstr :3001` + `taskkill /PID <pid> /F`. |
| `ECONNREFUSED 127.0.0.1:6379`                | Redis/Memurai not started. `memurai --service-start`.              |
| Dashboard CORS error on network IP            | IP prefix not in `server.ts` allow-list — extend the OR chain.      |
| Replay video missing for aborted run         | Dashboard polls HEAD /video for 60 s — if still missing, check `data/screenshots/.../replay.mp4` exists. If present, check the video-ready SSE event. |
| Dropdown selections don't stick               | See §17.1. The JS-click specialization in `clickByCoordinates` may need to be re-applied. |
| Action cache loops                           | Delete `data/cache/action-cache-v2.json` to reset. Loop guards: `consecutiveCacheHits`, `lastTurnWasGPT`. |

### 20.5 Reset state

- `POST /api/reset` wipes all runs / screenshots / settings (keeps test definitions).
- `rm -r packages/runner/data/local.db packages/runner/data/cache packages/runner/data/screenshots` for a nuclear reset.

---

## Appendix A — Verdict Parsing

The final model message is expected to contain:

```
VERDICT: PASS | FAIL
SUMMARY: <one-line>
STEPS_COMPLETED: ...
STEPS_FAILED: ...
ISSUES: ...
```

A simple regex extracts `VERDICT:` and maps the token to `TestStatus`. Transient-network issues (`503`, `502`, `timeout`) in `ISSUES` do *not* flip a PASS to FAIL — they are recorded as warnings only.

## Appendix B — Key Source Files

| Purpose                      | Path                                                                      |
|------------------------------|---------------------------------------------------------------------------|
| Entry                        | `packages/runner/src/index.ts`                                            |
| HTTP server                  | `packages/runner/src/server.ts`                                           |
| DOM CUA loop                 | `packages/runner/src/cua-loop.ts`                                         |
| Vision burst loop            | `packages/runner/src/cua-loop-vision.ts`                                  |
| Vision decision engine       | `packages/runner/src/vision-decision.ts`                                  |
| DOM extractor                | `packages/runner/src/dom-extractor.ts`                                    |
| Browser launcher             | `packages/runner/src/browser.ts`                                          |
| Legacy action executor       | `packages/runner/src/actions.ts`                                          |
| Action cache                 | `packages/runner/src/action-cache.ts`                                     |
| Adapter interface            | `packages/runner/src/adapter/types.ts`                                    |
| Playwright adapter           | `packages/runner/src/adapter/playwright-adapter.ts`                       |
| Action engine                | `packages/runner/src/adapter/action-engine.ts`                            |
| BullMQ queue                 | `packages/runner/src/queue/queue.ts`                                      |
| BullMQ worker                | `packages/runner/src/queue/worker.ts`                                     |
| Turso connection             | `packages/runner/src/db/turso.ts`                                         |
| Repository                   | `packages/runner/src/db/repo.ts`                                          |
| Test loader                  | `packages/runner/src/test-loader.ts`                                      |
| Config (test account)        | `packages/runner/src/config.ts`                                           |
| Logger                       | `packages/runner/src/logger.ts`                                           |
| Dashboard — main             | `packages/dashboard/src/app/page.tsx`                                     |
| Dashboard — run detail       | `packages/dashboard/src/app/runs/[runId]/page.tsx`                        |
| Dashboard — API client       | `packages/dashboard/src/lib/api.ts`                                       |
| Dashboard — SSE hook         | `packages/dashboard/src/lib/use-sse.ts`                                   |
| Shared types                 | `packages/shared/src/index.ts`                                            |

---

*End of document. Version 10 — reflects Turso-based persistence, Adapter pattern, DOM-first / Vision-burst FSM, per-turn token tracking, Action Cache v2 (singles + sequences), and Appy Pie-specific handlers.*
