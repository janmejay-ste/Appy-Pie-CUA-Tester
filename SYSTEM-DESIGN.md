# AppyPie CUA Tester — System Design Document v4

> Production-capable AI-powered QA testing platform with MongoDB, BullMQ, session-based execution, test CRUD, system settings, resume/retry with screenshot merging, and network sharing via ngrok.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          AppyPie CUA Tester                                  │
│                                                                              │
│  ┌─────────────────────┐          ┌──────────────────────────────────────┐   │
│  │  Dashboard           │          │  API Server (Express)                │   │
│  │  Next.js 15          │  REST    │  Port 3001 (0.0.0.0)                │   │
│  │  Port 3002           │◄────────►│                                      │   │
│  │                      │  + SSE   │  Security: Helmet + CORS + Rate     │   │
│  │  6 Tabs:             │          │  Limit + API Key Auth               │   │
│  │  • Overview          │          │                                      │   │
│  │  • Test Results      │          │  Test CRUD + Settings + Reports     │   │
│  │  • Failures          │          └────────┬─────────────┬──────────────┘   │
│  │  • Logs              │                   │             │                   │
│  │  • Test Manager      │          ┌────────▼──────┐ ┌────▼─────────────┐   │
│  │  • Settings          │          │   MongoDB     │ │   Redis          │   │
│  └─────────────────────┘          │   27017       │ │   6379           │   │
│                                    │               │ │                   │   │
│  ┌─────────────────────┐          │  Collections: │ │  • BullMQ Queue  │   │
│  │  ngrok (optional)    │          │  • sessions   │ │    (test-exec)   │   │
│  │  Public tunnel       │          │  • testruns   │ │  • Pub/Sub       │   │
│  │  for sharing         │          │  • steps      │ │    (events/abort)│   │
│  └─────────────────────┘          │  • events     │ └────┬─────────────┘   │
│                                    │  • testdefs   │      │                  │
│                                    │  • settings   │      ▼                  │
│  ┌─────────────────────┐          └───────────────┘ ┌──────────────────┐   │
│  │  Test Definitions    │                            │  BullMQ Worker   │   │
│  │  tests/              │                            │  Concurrency: 2  │   │
│  │  ├─ homepage/ (5)    │                            │                  │   │
│  │  ├─ connect/  (6)    │                            │  Playwright      │   │
│  │  ├─ auth/     (3)    │                            │  + CUA Loop      │   │
│  │  ├─ search/   (2)    │                            │  + OpenAI GPT5.4 │   │
│  │  ├─ navigation/(2)   │                            │  + FFmpeg Video  │   │
│  │  ├─ pricing/  (1)    │                            └──────────────────┘   │
│  │  └─ help/     (1)    │                                                    │
│  └─────────────────────┘          ┌──────────────────────────────────────┐   │
│                                    │  File Storage                        │   │
│                                    │  data/                               │   │
│                                    │  ├─ config.json                      │   │
│                                    │  └─ screenshots/{testId}/{runId}/    │   │
│                                    │     ├─ 000-turn.png ... NNN-turn.png │   │
│                                    │     └─ replay.mp4                    │   │
│                                    └──────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer          | Technology                                       |
|----------------|--------------------------------------------------|
| Frontend       | Next.js 15, React 19, Tailwind CSS 4             |
| API Server     | Express.js, TypeScript (ESM)                     |
| Database       | MongoDB 8 (Mongoose ODM)                         |
| Queue          | BullMQ + Redis/Memurai                           |
| Browser        | Playwright (Chromium)                            |
| AI Model       | OpenAI GPT-5.4 (DOM-first + Vision fallback)     |
| Video          | FFmpeg (subprocess)                              |
| Validation     | Zod v3                                           |
| Security       | Helmet, express-rate-limit, CORS                 |
| Tunnel         | ngrok (optional, for network sharing)            |
| Package Mgr    | pnpm workspaces                                  |

---

## 2. Core Concepts

| Concept    | Description                                                          |
|------------|----------------------------------------------------------------------|
| **Session**    | Groups multiple test runs. Created per "Run Tests" click.        |
| **TestRun**    | One execution of a test definition. States: queued → running → passed/failed/error/timeout |
| **Step**       | One CUA turn — screenshot + token usage + page URL. Merges old screenshots + turn_tokens. |
| **Event**      | Timestamped log entry. Published to Redis pub/sub for SSE.       |
| **TestDef**    | Test definition stored in MongoDB (with versioning + soft delete). YAML fallback. |
| **Settings**   | Global singleton config (concurrency, maxTurns, etc.).           |

---

## 3. CUA Loop — Dual-Mode AI Engine

The CUA loop supports two execution modes, switchable via Settings:

| Mode | Primary Input | Tokens/Turn | Best For |
|------|--------------|-------------|----------|
| **DOM** (default) | Structured DOM text | 1,800–3,500 | Most tests — 65-85% cheaper |
| **Vision** (fallback) | Base64 PNG screenshot | 12,000–15,000 | Canvas/WebGL, complex visual layouts |

### Mode Selection
```
Settings.cuaMode = 'dom' | 'vision'    (global default)
Per-test override: testDef.mode         (overrides global)
Instant rollback: change setting        (no code changes)
```

### 3a. DOM-First Mode (Default)

```
┌────────────────────────────────────────────────────────────────────┐
│                  DOM-First CUA Loop (per test)                      │
│                                                                    │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐        │
│  │ Extract DOM   │──►│ Send DOM text│──►│ Parse JSON      │        │
│  │ (25 elements) │   │ to GPT-5.4   │   │ Response         │        │
│  │ + key text    │   │ (stateless)  │   │                  │        │
│  │ + form state  │   │              │   │ Action? ──┐     │        │
│  └──────────────┘   └──────────────┘   └───────────┼─────┘        │
│       ▲                                        YES │  "done"       │
│       │                                            ▼   ▼           │
│       │                                     ┌────────┐ ┌──────┐   │
│       │  ┌──────────┐                       │Execute │ │Extract│   │
│       │  │ Save PNG  │  (replay only,       │Action  │ │Verdict│   │
│       │  │ to disk   │   NOT sent to model) │4-layer │ │PASS/  │   │
│       │  └──────────┘                       │fallback│ │FAIL   │   │
│       │                                     └────────┘ └──────┘   │
│       └─────────────────────────────────────────┘                  │
│                                                                    │
│  ⚡ Key difference: Screenshots saved to disk but NOT sent to      │
│     model. Model receives only structured DOM text (~2K tokens).   │
│                                                                    │
│  Stuck? → Vision fallback (compressed JPEG, max 3 turns)          │
└────────────────────────────────────────────────────────────────────┘
```

#### DOM Extraction (`dom-extractor.ts`)
```
page.evaluate() extracts:
  • Interactive elements: inputs, buttons, links, selects, ARIA roles
  • Hard cap: 25 elements (ranked: inputs > buttons > CTAs > links)
  • Filter: visible, enabled, non-zero size, in/near viewport
  • Per element: tag, type, text, value, placeholder, rect, selector
  • Key text: headings (h1-h3), labels, errors — max 200 chars
  • Form state: { e2: "john@email.com", e5: "Professional" }
```

#### Model Prompt (stateless — no history accumulation)
```
Each turn sends ONE self-contained message (no previous_response_id):

  CREDENTIALS: email=... password=...
  GOAL: {test instructions}
  EXPECTED OUTCOME: {expected outcome}

  CURRENT PAGE STATE:
  URL: https://www.appypieautomate.ai/pricing
  Title: Pricing Plans

  Elements:
  e1: <button> "Try Now" [450,560]
  e2: <input type="text" placeholder="Email"> value="" [400,300]
  e3: <select> "Plan" options=["Free","Pro","Business"] value="Free" [400,400]

  Key text: Choose the plan that's right for you | Standard | Professional
  Form: e2="" e3="Free"

  LAST ACTION: clicked e1 "Try Now" → success
  PROGRESS: Verified pricing page loads, Checked plan cards
  STATE: page="Pricing" filled=[] pending=["click CTA"] errors=[]
  TURN: 6/40
```

#### Model Response (structured JSON only)
```json
{
  "action": "click",
  "target": "e1",
  "value": "",
  "reason": "Click Try Now to verify signup redirect",
  "confidence": 0.9,
  "stepsCompleted": ["Verified pricing page", "Checked plan cards"]
}
```

#### Action Execution (4-Layer Fallback)
```
Element ID → Playwright execution:
  1. CSS selector   (fastest: #id, [name], [data-testid])
  2. Text match      (page.getByText() / page.getByRole())
  3. Role-based      ([role="button"], [role="tab"])
  4. Coordinates     (page.mouse.click(rect.x + w/2, rect.y + h/2))

If all 4 fail → return { success: false, error: "Element not found" }
```

#### Stuck Detection & Vision Fallback
```
isStuck triggers when ANY of:
  • Same DOM fingerprint ≥ 2 consecutive turns
  • Same action signature repeated ≥ 2 times
  • Last 2 actions both failed
  • Model confidence < 0.4
  • DOM has < 5 interactive elements (overlay/canvas)

Vision fallback:
  • Budget: min(3, ceil(maxTurns × 0.2)) turns — adaptive
  • Sends compressed JPEG (quality 50, ~5K tokens) + DOM text
  • Returns to DOM-only when: DOM changes or action succeeds
  • Hard abort: stuck for (STUCK_THRESHOLD + VISION_BUDGET + 2) turns
```

#### Loop Intervention (Escalating)
```
Action repeats:
  1-2 repeats → normal
  3-4 repeats → inject: "This approach is NOT working. Try different strategy."
  5+ repeats  → hard abort → FAIL verdict
```

### 3b. Vision Mode (Legacy/Fallback)

```
┌────────────────────────────────────────────────────────────────────┐
│                  Vision CUA Loop (cua-loop-vision.ts)               │
│                                                                    │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────┐            │
│  │ Capture   │──►│ Send to      │──►│ Parse Response  │            │
│  │ Screenshot│   │ OpenAI GPT5.4│   │                  │            │
│  │ (base64)  │   │ (chained via │   │ computer_call?   │            │
│  └──────────┘   │ prev_resp_id)│   └────────┬────────┘            │
│       ▲         └──────────────┘        YES │  NO                  │
│       │                                     ▼   ▼                  │
│       └────────────────────────────  Execute │ Extract             │
│                                     Actions  │ Verdict             │
│                                     (x,y)    │                     │
│                                                                    │
│  Uses: computer tool type, previous_response_id chain              │
│  Cost: ~15K tokens/turn (screenshots accumulate in context)        │
└────────────────────────────────────────────────────────────────────┘
```

### Supported Browser Actions

| Action | DOM Mode | Vision Mode |
|--------|----------|-------------|
| click | Element ID → 4-layer fallback | (x, y) coordinates |
| type | Element ID → focus + type | Keyboard type |
| select | Element ID → selectOption | Not available |
| scroll | Element/viewport scroll | (x, y) + delta |
| keypress | Key press | Key press |
| navigate | page.goto(url) | Not available |
| wait | Pause ms | Pause ms |
| double_click | N/A | (x, y) double-click |
| move | N/A | Mouse move |
| drag | N/A | Path-based drag |

### Safety Mechanisms (Both Modes)

| Mechanism | Description |
|-----------|-------------|
| URL Watchdog | Auto-bounce from off-domain + external traps (login.live.com, etc.) |
| Credential Security | Block typing passwords on unknown domains |
| Multi-tab Handling | Auto-switch to popups, switch back on close |
| Network Detection | Track 4xx/5xx responses, feed to model context |
| Token Budget | 80% warning, 100% abort via AbortController |
| Goal Validation | Model must list STEPS_COMPLETED + STEPS_FAILED; PASS overridden to FAIL if failed steps listed |

---

## 4. MongoDB Collections (6 total)

### `sessions`
```javascript
{
  _id: "uuid",
  startedAt: ISODate,
  completedAt: ISODate | null,
  total: 5, passed: 2, failed: 3, errors: 0, timeouts: 0
}
```

### `testruns`
```javascript
{
  _id: "uuid",
  sessionId: "uuid",           // → sessions._id
  testId: "error-page-handling",
  testName: "Error Page Handling (404)",
  status: "passed",            // queued|running|passed|failed|error|timeout
  startedAt: ISODate,
  completedAt: ISODate,
  durationMs: 18200,
  turnCount: 3,
  screenshotCount: 3,
  inputTokens: 12843,
  outputTokens: 171,
  reasoningTokens: 44,
  modelVerdict: "VERDICT: PASS\nSUMMARY: ...",
  error: null
}
// Indexes: {sessionId:1}, {testId:1, startedAt:-1}
```

### `steps` (merges screenshots + token tracking)
```javascript
{
  _id: "uuid",
  testRunId: "uuid",           // → testruns._id
  turnNumber: 3,
  filePath: "003-turn.png",
  capturedAt: ISODate,
  pageUrl: "https://...",
  pageTitle: "Page Title",
  inputTokens: 4200,           // per-turn token usage
  outputTokens: 85,
  reasoningTokens: 22,
  apiLatencyMs: 7095,
  cumulativeInput: 12843,      // running totals
  cumulativeOutput: 171,
  cumulativeReasoning: 44
}
// Indexes: {testRunId:1}, {testRunId:1, turnNumber:1}
```

### `events`
```javascript
{
  _id: "uuid",
  testRunId: "uuid",
  sequence: 1,
  type: "run_started",         // 8 event types
  message: "Starting test: Error Page Handling (404)",
  detail: null,
  timestamp: ISODate
}
// Indexes: {testRunId:1}, {testRunId:1, sequence:1}
```

### `testdefs` (test definitions with CRUD)
```javascript
{
  _id: "error-page-handling",   // slug from name
  name: "Error Page Handling (404)",
  url: "https://www.appypieautomate.ai/this-page-does-not-exist-12345",
  instructions: "1. Verify the page loads...",
  expectedOutcome: "Invalid URL shows a branded error page...",
  category: "regression",       // smoke|sanity|regression|e2e
  tags: ["error", "404"],
  requiresAuth: false,
  maxTurns: 20,
  timeout: 90000,
  viewport: { width: 1440, height: 900 },
  page: "navigation",
  version: 1,                   // incremented on each edit
  isActive: true,               // soft delete
  createdAt: ISODate,
  updatedAt: ISODate
}
// Indexes: {isActive:1, name:1}
```

### `settings` (singleton)
```javascript
{
  _id: "global",
  maxConcurrency: 2,
  maxTurnsDefault: 100,         // fallback when test has no max_turns
  maxTokensPerSession: 200000,
  defaultTimeout: 120000,
  defaultHeadless: true,
  allowedDomains: ["appypieautomate.ai", "connectcloud.appypie.com"],
  cuaMode: "dom",               // "dom" (default, 80% cheaper) | "vision" (screenshot-based)
  updatedAt: ISODate
}
```

### Relationships
```
Session (1) ──► (N) TestRun
TestRun (1) ──► (N) Step
TestRun (1) ──► (N) Event
TestDef (1) ──► (N) TestRun (via testId)
Settings (1)    singleton
```

---

## 5. BullMQ Queue Architecture

```
 API Server                  Redis Queue              Worker (×2)
    │                            │                        │
    │  queue.add(jobData)        │                        │
    │───────────────────────────►│                        │
    │                            │  Pick job              │
    │                            │───────────────────────►│
    │                            │                        │
    │                            │  Launch Playwright     │
    │                            │  Run CUA Loop          │
    │                            │  Save Steps/Events     │
    │                            │                        │
    │  SSE via Redis pub/sub     │  publish(events:{id})  │
    │◄───────────────────────────│◄───────────────────────│
    │                            │                        │
    │                            │  Update TestRun        │
    │                            │  Update Session stats  │
    │                            │  Generate video        │
```

### Job Data
```typescript
{
  sessionId, testRunId, testId, testName, testUrl,
  testInstructions, expectedOutcome, headless,
  requiresAuth, maxTurns, timeout, viewport,
  resumeFromUrl?, resumeContext?   // for retry
}
```

### Config
| Setting          | Value | Rationale                           |
|-----------------|-------|--------------------------------------|
| Concurrency     | 2     | Each test runs a full browser        |
| Attempts        | 1     | No auto-retry (CUA tests)           |
| removeOnComplete| 100   | Keep last 100 for debugging          |

---

## 6. API Endpoints (25 total)

### Health & Config
| Method | Endpoint               | Description                  |
|--------|------------------------|------------------------------|
| GET    | /health                | Health check                 |
| GET    | /api/config/account    | Get test account (masked pw) |
| PUT    | /api/config/account    | Update test account          |

### Test CRUD
| Method | Endpoint                  | Description                     |
|--------|---------------------------|---------------------------------|
| GET    | /api/tests                | List tests (DB → YAML fallback) |
| POST   | /api/tests                | Create test (Zod validated)     |
| PUT    | /api/tests/:id            | Update test (version++)         |
| DELETE | /api/tests/:id            | Soft delete (isActive: false)   |
| POST   | /api/tests/import-yaml    | Import YAML → DB (new only)     |
| POST   | /api/tests/sync-yaml      | Sync YAML → DB (create+update)  |
| POST   | /api/tests/import-file    | Upload YAML file → DB           |

### System Settings
| Method | Endpoint        | Description                   |
|--------|-----------------|-------------------------------|
| GET    | /api/settings   | Get global settings           |
| PUT    | /api/settings   | Update settings (Zod)         |

### Execution
| Method | Endpoint                     | Description                          |
|--------|------------------------------|--------------------------------------|
| POST   | /api/suites                  | Run suite (queue all tests)          |
| POST   | /api/tests/:testId/run       | Run single test (with retry support) |
| POST   | /api/runs/:runId/abort       | Abort test (Redis pub/sub signal)    |
| POST   | /api/suites/:suiteId/abort   | Abort all tests in session           |

### Data & History
| Method | Endpoint                          | Description                     |
|--------|-----------------------------------|---------------------------------|
| GET    | /api/suites                       | List sessions (paginated)       |
| GET    | /api/suites/:suiteId              | Session detail + test runs      |
| GET    | /api/suites/:suiteId/runs         | All runs in session             |
| GET    | /api/runs/latest                  | Latest run per test (aggregated)|
| GET    | /api/runs/:runId                  | Run detail + steps + events     |
| POST   | /api/reset                        | Delete all data + screenshots   |

### Media & Reports
| Method | Endpoint                              | Description                |
|--------|---------------------------------------|----------------------------|
| GET    | /api/runs/:runId/screenshots/:file    | Serve PNG (path protected) |
| GET    | /api/runs/:runId/video                | Serve replay MP4           |
| GET    | /api/runs/:runId/events               | SSE live event stream      |
| GET    | /api/runs/:runId/report               | HTML report (single test)  |
| GET    | /api/suites/:suiteId/report           | HTML report (suite)        |
| GET    | /api/report/latest                    | Aggregated HTML report     |

---

## 7. Security

| Layer              | Implementation                                           |
|--------------------|----------------------------------------------------------|
| **Auth**           | X-API-Key header middleware (optional — skips in dev)     |
| **CORS**           | Restricted origins (localhost + 10.* ranges)              |
| **Rate Limiting**  | 100 req/min per IP on /api                               |
| **Headers**        | Helmet (CSP disabled, cross-origin: cross-origin)        |
| **Path Traversal** | `path.basename()` + `.startsWith(baseDir)` + `.png` only |
| **Password**       | Never returned in API — only masked version              |
| **Soft Delete**    | Tests deactivated, never hard deleted                    |
| **Input Validation**| Zod schemas on all create/update endpoints              |
| **HTML Escaping**  | `escapeHtml()` in all report generation                  |

---

## 8. Dashboard (6 Tabs)

### Tab Structure
```
┌─────────────────────────────────────────────────────────────────┐
│ QA Dashboard                    [Headless] [Run] [Export] [Reset]│
├─────────────────────────────────────────────────────────────────┤
│ [🔍 Search...]  [All 19] [Smoke 3] [Sanity 5] [Regression 3]   │
│                 [E2e 8]                                          │
├─────────────────────────────────────────────────────────────────┤
│ [Passed: 2] [Failed: 3] [Errors: 0] [Status: Completed]        │
├─────────────────────────────────────────────────────────────────┤
│ Overview | Test Results | Failures 3 | Logs | Test Manager |    │
│                                              Settings           │
├─────────────────────────────────────────────────────────────────┤
│                     Tab Content Area                             │
└─────────────────────────────────────────────────────────────────┘
```

| Tab            | Content                                              |
|----------------|------------------------------------------------------|
| **Overview**   | Test cards grid with status, category badges, run/details buttons |
| **Test Results**| Sortable table with all runs, filters, export per run |
| **Failures**   | Expanded cards for failed/error runs with verdict     |
| **Logs**       | Live SSE event stream from running test               |
| **Test Manager**| CRUD table + Create/Edit modal + Import YAML (file upload) + Sync from YAML |
| **Settings**   | System settings form + Test account config            |

### Run Detail Page (`/runs/[runId]`)
```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back  Test Name  [PASSED]        [↻] [Re-Test] [+20] [Export]│
│                                                                  │
│ [↻] = Refresh button (reloads run data + checks video)          │
│ [+20] = Retry with +20 turns (only shown on TIMEOUT status)    │
│         sends resumeFromRunId for context-aware continuation    │
├─────────────────────────────────────────────────────────────────┤
│ 18.2s | 3 Turns | 3 Screenshots | 12.8k In | 171 Out | 44 Rsn │
├─────────────────────────────────────────────────────────────────┤
│ Token Usage Breakdown (collapsible per-turn table)        [▼]   │
├──────────────────────────────────┬──────────────────────────────┤
│ [Screenshots] [Replay Video]    │ Event Log                    │
│                                  │ 9:02:18 Starting test...     │
│ ┌─────────────────────────────┐ │ 9:02:25 Browser launched...  │
│ │  Screenshot Viewer          │ │ 9:02:25 Turn 1 started...    │
│ │  (full-size with turn info) │ │ 9:02:28 Turn 1 complete...   │
│ └─────────────────────────────┘ │ 9:02:28 Screenshot captured  │
│                                  │ ...                          │
│ [T0] [T1] [T2] [Final]          │                              │
│ (thumbnail strip)                │                              │
├──────────────────────────────────┴──────────────────────────────┤
│ Model Verdict                                                    │
│ VERDICT: PASS                                                    │
│ SUMMARY: Tested the invalid URL error page...                   │
│ ISSUES: None                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### UI Components
- **Toast Notifications** — bottom-right, auto-dismiss 4s (success/error/info), replaces all browser alerts
- **Confirmation Modals** — styled popups for reset + delete (no browser `alert()` or `confirm()` anywhere)
- **Theme Toggle** — light (default) / dark mode via CSS variables
- **Category Chips** — color-coded filters (cyan/violet/orange/pink)
- **Status Badges** — light/dark aware (emerald/red/blue/orange/yellow)
- **Refresh Button** — on run detail page, reloads data + checks video availability
- **File Upload** — "Import YAML" opens file picker to upload .yaml/.yml from system

---

## 9. Resume/Retry for Timed-Out Tests

```
Test times out (60 turns)
        │
        ▼
Dashboard shows [Retry +20 Turns (80)] button (amber)
        │
        ▼
POST /api/tests/:testId/run
  { maxTurnsOverride: 80, resumeFromRunId: "prev-run-id" }
        │
        ▼
Server extracts from previous run:
  • Last Step pageUrl + pageTitle
  • Model verdict (what was accomplished)
  • Turn count + duration
        │
        ▼
Worker receives job with resumeContext
        │
        ▼
Resume Instructions prepended (context-aware):
  "Look at the current page:
   - If already on the editor/form → continue directly, don't navigate away
   - If on login page → login quickly, then navigate to last URL
   - If previous work is visible (trigger configured, fields filled) → skip to incomplete part
   - Do NOT re-create connects, re-select apps, or re-fill configured fields
   - If there was a specific error → fix that error and retry"
        │
        ▼
After completion: Screenshots from old + new run merged → one replay video
```

### maxTurns Priority Chain
```
maxTurnsOverride (retry button)
    → testDef.max_turns (per-test YAML/DB)
        → settings.maxTurnsDefault (global settings)
            → 40 (hardcoded fallback)
```

---

## 10. Token Consumption & Optimization

### How Tokens Flow
```
OpenAI Response (per turn)
    ├── response.usage.input_tokens      ← what we SEND (prompt + DOM/image)
    ├── response.usage.output_tokens     ← what model RETURNS (actions/verdict)
    └── response.usage.output_tokens_details.reasoning_tokens  ← internal reasoning
            │
            ▼
    Step document in MongoDB (per-turn + cumulative totals)
            │
            ▼
    TestRun document (grand totals — updated live each turn via callback)
```

### Token Consumption by Mode

#### DOM Mode (Default) — Per Turn Breakdown
```
┌─────────────────────────────────────────────────────────┐
│ WHAT WE SEND TO MODEL (input_tokens):                   │
│                                                         │
│ Component              │ Tokens    │ Notes               │
│ ──────────────────────-┤───────────┤──────────────────── │
│ System prompt           │ ~300      │ sent every turn     │
│ Goal + Expected outcome │ ~200-500  │ test instructions   │
│ DOM elements (25 × 40)  │ ~1,000    │ structured text     │
│ Key text (labels/headings│ ~200-400 │ max 200 chars       │
│ State + Progress + Memory│ ~100-300 │ 1-2 lines each      │
│ ──────────────────────-──┤───────────┤                    │
│ TOTAL INPUT PER TURN     │ 1,800-3,500                   │
│                                                         │
│ WHAT MODEL RETURNS (output_tokens):                      │
│ JSON action response     │ ~50-150   │ structured JSON    │
│ Reasoning (internal)     │ ~5-20     │ effort: 'low'      │
│                                                         │
│ TOTAL PER TURN           │ ~2,000-3,700                  │
└─────────────────────────────────────────────────────────┘
```

#### Vision Mode — Per Turn Breakdown
```
┌─────────────────────────────────────────────────────────┐
│ WHAT WE SEND (input_tokens):                            │
│                                                         │
│ Component              │ Tokens    │ Notes               │
│ ──────────────────────-┤───────────┤──────────────────── │
│ System prompt (instructions)│ ~500  │ sent via API param  │
│ Test instructions + outcome │ ~300-600│ first turn only   │
│ Screenshot (base64 PNG)     │ ~12,000-15,000│ EVERY TURN │
│ Previous context (chain)    │ accumulates   │ via prev_id│
│ ──────────────────────-──────┤──────────────┤            │
│                                                         │
│ Turn 1:  ~15,000 tokens (1 screenshot + prompt)         │
│ Turn 5:  ~75,000 tokens (context chain grows)           │
│ Turn 10: ~150,000 tokens (10 screenshots accumulated)   │
│ Turn 15: ~220,000 tokens (BUDGET HIT)                   │
│                                                         │
│ ⚠ previous_response_id chains ALL prior screenshots    │
│   in context — this is WHY vision mode is expensive     │
└─────────────────────────────────────────────────────────┘
```

#### Side-by-Side Comparison
```
┌───────────────┬──────────────┬──────────────┬──────────┐
│ Scenario      │ Vision Mode  │ DOM Mode     │ Savings  │
├───────────────┼──────────────┼──────────────┼──────────┤
│ Per turn      │ ~15,000      │ ~2,500       │ 83%      │
│ 15-turn test  │ ~220,000     │ ~40,000      │ 82%      │
│ 40-turn test  │ ~600,000     │ ~100,000     │ 83%      │
│ With 3 vision │ N/A          │ +15,000      │ Still 80%│
│ fallbacks     │              │              │          │
├───────────────┼──────────────┼──────────────┼──────────┤
│ Cost/test*    │ $0.33-$0.90  │ $0.06-$0.15  │ 80-83%   │
│ *(at $1.5/1M input tokens)                             │
└───────────────┴──────────────┴──────────────┴──────────┘
```

### Token Budget Enforcement
```
Settings.maxTokensPerSession = 200,000 (configurable)

Per turn:
  totalUsed = input_tokens + output_tokens (cumulative)

  At 70%: DOM mode switches image detail to 'low' (vision mode)
  At 80%: WARNING logged + emitted as event
  At 100%: AbortController.abort() → test ends with budget message

Worker callback checks budget after each turn:
  onTurnComplete → fetches Settings → checks totalUsed vs limit
```

### Where Tokens Are Tracked
```
1. CUA Loop (cua-loop.ts / cua-loop-vision.ts)
   → per-turn: turnInput, turnOutput, turnReasoning
   → cumulative: totalTokens.input/output/reasoning
   → emitted via callbacks.onTurnTokens()

2. Worker (worker.ts)
   → receives callback → updates TestRun in MongoDB
   → creates Step document with per-turn + cumulative
   → checks budget → aborts if exceeded

3. MongoDB (steps collection)
   → inputTokens, outputTokens, reasoningTokens (per turn)
   → cumulativeInput, cumulativeOutput, cumulativeReasoning

4. Dashboard (run detail page)
   → Token Usage Breakdown (collapsible per-turn table)
   → Stats bar: Input | Output | Reasoning totals
   → Expensive turn markers (>2× average)
```

### Dashboard Display
```
┌─────────────────────────────────────────────────────────┐
│ Token Usage Breakdown         Total: 5.2k tokens    [▼] │
│                                                         │
│ Total Input   Total Output   Reasoning   Avg/Turn       │
│ 4.8k          320            82          0.8k           │
│                                                         │
│ Turn │ Input  │ Output │ Reasoning │ Total │ Latency    │
│ T1   │ 2.1k   │ 0.08k  │ 18        │ 2.2k  │ 1.8s      │
│ T2   │ 1.4k   │ 0.06k  │ 12        │ 1.5k  │ 1.2s      │
│ T3   │ 1.3k   │ 0.05k  │ 11        │ 1.4k  │ 1.1s      │
│ T4*  │ 4.8k   │ 0.13k  │ 41        │ 4.9k  │ 3.2s      │
│ * = vision fallback turn (JPEG sent)                    │
└─────────────────────────────────────────────────────────┘
```

---

## 11. Screenshot & Video Pipeline

### Storage Architecture
```
Files on DISK (not in database):
  data/screenshots/{testId}/{runId}/
  ├── 000-turn.png        ← initial state
  ├── 001-turn.png        ← after turn 1 actions
  ├── ...
  ├── NNN-turn.png        ← final state
  └── replay.mp4          ← generated video

Metadata in MongoDB (steps collection):
  { filePath: "003-turn.png", pageUrl: "...", pageTitle: "..." }
  (only filename + metadata, NO binary data)

Served via API:
  GET /api/runs/:runId/screenshots/:filename → reads PNG from disk
  GET /api/runs/:runId/video                 → reads MP4 from disk
```

### Video Generation Flow
```
Playwright Browser
    │
    ├── page.screenshot({ type: 'png' })
    │   ├── Save to disk: data/screenshots/{testId}/{runId}/{NNN}-turn.png
    │   ├── DOM mode: saved for replay video ONLY (NOT sent to model)
    │   ├── Vision mode: convert to base64 → send to OpenAI as next turn input
    │   └── Create Step document in MongoDB (metadata only)
    │
    └── On test completion (background, non-blocking):
        │
        ├── Normal run:
        │   └── FFmpeg: {dir}/%03d-turn.png → replay.mp4 (1fps, H.264)
        │
        └── Resumed run (screenshot merge):
            ├── Copy old run's PNGs (000-059) → _merged/ folder
            ├── Copy new run's PNGs (000-019) → _merged/ (renumbered 060-079)
            ├── FFmpeg: _merged/%03d-turn.png → replay.mp4 (all 80 frames)
            ├── Move replay.mp4 to new run's folder
            └── Cleanup _merged/ folder
```

---

## 12. Real-Time Updates (SSE + Redis Pub/Sub)

```
Worker                     Redis                   Dashboard
  │                          │                        │
  │ persistEvent(MongoDB)    │                        │
  │ publish('events:{id}')   │                        │
  │─────────────────────────►│                        │
  │                          │ subscriber.on('msg')   │
  │                          │───────────────────────►│
  │                          │                        │ res.write(SSE)
  │                          │                        │──────► Browser
```

### Abort Flow
```
Dashboard → POST /api/runs/:id/abort
         → redis.publish('abort:{id}', '1')
         → Worker subscribes → AbortController.abort()
         → CUA loop checks signal (3 points per turn)
         → Returns FAIL + "manually aborted"
```

---

## 13. Test Definition Lifecycle

```
YAML Files (disk)              MongoDB (testdefs)         Dashboard
     │                              │                        │
     │  POST /api/tests/import-yaml │                        │
     │─────────────────────────────►│ (new only, skip exist) │
     │                              │                        │
     │  POST /api/tests/sync-yaml   │                        │
     │─────────────────────────────►│ (create + update,      │
     │                              │  version++ on change)  │
     │                              │                        │
     │                              │  POST /api/tests/      │
     │                              │  import-file           │
     │                              │◄───────────────────────│ (file picker
     │                              │                        │  upload .yaml)
     │                              │                        │
     │                              │◄── POST /api/tests     │ (create form)
     │                              │◄── PUT /api/tests/:id  │ (edit modal)
     │                              │◄── DELETE /api/tests/:id│(soft delete)
     │                              │                        │
     │  GET /api/tests              │                        │
     │  (fallback if DB empty) ◄────│ (DB-first)────────────►│
```

### Data Storage Principle
```
Binary files (screenshots, videos) → DISK only (data/screenshots/)
Metadata (filenames, URLs, tokens) → MongoDB only (steps collection)
Test definitions                   → MongoDB (testdefs) with YAML fallback
Configuration                     → MongoDB (settings) + file (config.json)
```

---

## 14. File Structure

```
appypie-cua-tester/
├── .env                            # OpenAI key + config
├── .gitignore                      # node_modules, .next, data, .env
├── SYSTEM-DESIGN.md                # This document
├── pnpm-workspace.yaml
│
├── packages/runner/
│   ├── package.json                # mongoose, bullmq, express, playwright, openai, zod
│   ├── src/
│   │   ├── index.ts                # Entry: MongoDB → Worker → Express (0.0.0.0)
│   │   ├── server.ts               # 25 API endpoints + security middleware
│   │   ├── cua-loop.ts             # DOM-first AI loop + mode dispatch
│   │   ├── cua-loop-vision.ts     # Vision mode (screenshot-based, legacy)
│   │   ├── dom-extractor.ts       # DOM extraction + formatting + fingerprint
│   │   ├── actions.ts              # Playwright actions + executeModelAction (4-layer)
│   │   ├── browser.ts              # Chromium launch config
│   │   ├── config.ts               # Account config (config.json)
│   │   ├── test-loader.ts          # YAML recursive loader (fallback)
│   │   ├── types.ts                # TypeScript interfaces
│   │   ├── db/
│   │   │   ├── mongo.ts            # MongoDB connection
│   │   │   └── models/             # 6 Mongoose models
│   │   │       ├── Session.ts
│   │   │       ├── TestRun.ts
│   │   │       ├── Step.ts
│   │   │       ├── Event.ts
│   │   │       ├── TestDef.ts
│   │   │       └── Settings.ts
│   │   ├── services/
│   │   │   ├── session.service.ts  # Session CRUD + stats
│   │   │   └── test.service.ts     # TestRun/Step/Event CRUD
│   │   ├── queue/
│   │   │   ├── queue.ts            # BullMQ queue + Redis config
│   │   │   └── worker.ts           # CUA execution + video + resume
│   │   └── validation/
│   │       └── test.validation.ts  # Zod schemas
│   ├── tests/                      # 20 YAML test definitions (7 folders)
│   └── data/                       # Runtime (screenshots, config)
│
└── packages/dashboard/
    ├── .env.local                  # NEXT_PUBLIC_API_URL
    ├── next.config.ts              # Rewrites + CORS + ngrok origins
    └── src/
        ├── app/
        │   ├── layout.tsx          # Header + theme + nav
        │   ├── globals.css         # CSS variable theme system
        │   ├── page.tsx            # Main dashboard (6 tabs, 1300+ lines)
        │   ├── history/page.tsx    # Suite history
        │   └── runs/[runId]/page.tsx # Run detail + screenshots + tokens
        ├── components/
        │   └── ThemeToggle.tsx     # Dark/light toggle
        └── lib/
            └── use-sse.ts          # SSE React hook
```

---

## 15. Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-...

# Runner (optional, with defaults)
RUNNER_PORT=3001
MONGO_URI=mongodb://127.0.0.1:27017/cua-tester
REDIS_URL=redis://127.0.0.1:6379
INTERNAL_API_KEY=                    # empty = skip auth (dev mode)
DASHBOARD_URL=http://localhost:3002
ALLOWED_DOMAINS=appypieautomate.ai,connectcloud.appypie.com
DEFAULT_TEST_EMAIL=...
DEFAULT_TEST_PASSWORD=...

# Dashboard (optional)
NEXT_PUBLIC_API_URL=                 # empty = use Next.js rewrite proxy
```

---

## 16. Startup Sequence

```
1. mongod (MongoDB server — running as Windows service)
2. memurai / redis-server (Redis — running as Windows service)
3. pnpm --filter runner dev
   → connectMongo()
   → startWorker() [BullMQ, concurrency: 2]
   → Express.listen(0.0.0.0:3001)
4. pnpm --filter dashboard dev
   → Next.js dev server on :3002
   → Rewrites /api/* → localhost:3001
5. (Optional) npx ngrok http 3002
   → Public URL for network sharing
   → Dashboard uses Next.js rewrites (/api/* → localhost:3001)
   → Only ONE tunnel needed (free plan limit)
   → Set NEXT_PUBLIC_API_URL="" in .env.local (relative URLs)
   → Add ngrok domain to allowedDevOrigins in next.config.ts
```

---

## 17. Performance

| Metric                    | DOM Mode            | Vision Mode          |
|--------------------------|---------------------|----------------------|
| API latency per turn     | 1–5 seconds         | 2–30 seconds         |
| Tokens per turn          | 1,800–3,500         | 12,000–15,000        |
| Tokens per test (15 turns)| 30k–55k            | 180k–220k            |
| Tokens per test (40 turns)| 80k–140k           | 500k–600k            |
| Cost per test*           | $0.05–$0.15         | $0.30–$0.90          |
| Inter-action delay       | 150ms               | 120ms                |
| DOM extraction time      | ~50ms               | N/A                  |
| Screenshot capture       | <100ms (disk only)  | <100ms (disk + API)  |
| Total test duration      | 15–200 seconds      | 30–360 seconds       |
| Screenshots per test     | 3–60 PNG (~100KB)   | 3–60 PNG (~100KB)    |
| Dashboard poll interval  | 2 seconds           | 2 seconds            |
| Worker concurrency       | 2 (configurable)    | 2 (configurable)     |
| FFmpeg video generation  | 5–30 seconds        | 5–30 seconds         |
| MongoDB write latency    | <5ms (local)        | <5ms (local)         |
| Redis pub/sub latency    | <1ms (local)        | <1ms (local)         |
| *at $1.5/1M input tokens |                     |                      |
