# AppyPie CUA Tester — System Design Document

## 1. Architecture Overview

A **Computer Use Agent (CUA) testing framework** that uses OpenAI's GPT-5.4 model to automatically test web applications by simulating real user interactions through a browser.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Monorepo Structure                       │
│                                                                 │
│  ┌──────────────────────┐       ┌────────────────────────────┐  │
│  │   Runner (Port 3001) │       │   Dashboard (Port 3002)    │  │
│  │                      │       │                            │  │
│  │  Express + Playwright │◄─────│  Next.js 15 + React 19     │  │
│  │  + OpenAI CUA API    │ REST  │  + Tailwind CSS 4          │  │
│  │  + sql.js (SQLite)   │ + SSE │                            │  │
│  └──────────┬───────────┘       └────────────────────────────┘  │
│             │                                                    │
│  ┌──────────▼───────────┐       ┌────────────────────────────┐  │
│  │  data/               │       │  tests/ (YAML)             │  │
│  │  ├─ test-results.db  │       │  ├─ homepage/ (5 tests)    │  │
│  │  ├─ config.json      │       │  ├─ connect/  (4 tests)    │  │
│  │  └─ screenshots/     │       │  ├─ auth/     (3 tests)    │  │
│  │     └─ {testId}/     │       │  ├─ search/   (2 tests)    │  │
│  │        └─ {runId}/   │       │  ├─ navigation/(2 tests)   │  │
│  │           ├─ 000.png │       │  ├─ pricing/  (1 test)     │  │
│  │           └─ replay  │       │  └─ help/     (1 test)     │  │
│  └──────────────────────┘       └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer      | Technology                                      |
|------------|------------------------------------------------|
| Backend    | Node.js (ESM), Express, TypeScript             |
| Frontend   | Next.js 15, React 19, Tailwind CSS 4           |
| Database   | sql.js (in-memory SQLite with file persistence)|
| Browser    | Playwright (Chromium)                           |
| AI Model   | OpenAI GPT-5.4 (Computer Use API)              |
| Video      | FFmpeg (subprocess)                             |
| Package    | pnpm workspaces                                |

---

## 2. Core CUA Loop Flow

The heart of the system — an iterative loop that sends screenshots to OpenAI and executes the returned browser actions.

```
┌─────────────────────────────────────────────────────────┐
│                    CUA Loop (per test)                   │
│                                                         │
│  ┌─────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Capture  │───►│ Send to      │───►│ Parse Response│  │
│  │ Screenshot│   │ OpenAI API   │    │               │  │
│  │ (base64) │   │ (gpt-5.4)    │    │ Actions?      │  │
│  └─────────┘    └──────────────┘    └───┬───────┬───┘  │
│       ▲                                 │       │       │
│       │                              YES│    NO │       │
│       │                                 ▼       ▼       │
│       │                          ┌──────────┐ ┌──────┐  │
│       │                          │ Execute  │ │Extract│  │
│       └──────────────────────────│ Actions  │ │Verdict│  │
│                                  │(Playwright│ │PASS/  │  │
│                                  │ click,    │ │FAIL   │  │
│                                  │ type,     │ └──────┘  │
│                                  │ scroll...)│           │
│                                  └──────────┘           │
│                                                         │
│  Repeats up to maxTurns (default: 40)                   │
│  Inter-action delay: 120ms                              │
│  Action timeout: 20s per batch                          │
└─────────────────────────────────────────────────────────┘
```

### OpenAI API Call

```typescript
openai.responses.create({
  model: "gpt-5.4",
  instructions: SYSTEM_INSTRUCTIONS,
  input: [{ role: "user", content: [
    { type: "input_text", text: testInstructions },
    { type: "input_image", image_url: screenshotBase64 }
  ]}],
  tools: [{ type: "computer" }],
  reasoning: { effort: "low" },
  truncation: "auto",
  previous_response_id: previousId,
})
```

### Supported Browser Actions

| Action       | Description                          |
|-------------|--------------------------------------|
| click        | Click at (x, y) with button          |
| double_click | Double-click at (x, y)              |
| type         | Type text string                     |
| keypress     | Press key(s) with normalization      |
| scroll       | Scroll by delta at position          |
| move         | Move cursor to (x, y)               |
| drag         | Drag from start to end coordinates   |
| wait         | Pause for specified milliseconds     |
| screenshot   | No-op (handled by loop)             |

---

## 3. Database Schema

**Engine:** sql.js (in-memory SQLite, persisted to `data/test-results.db`)
**Persistence:** Debounced write every 200ms + on process exit

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  suite_runs  │     │  test_runs   │     │  screenshots │
│──────────────│     │──────────────│     │──────────────│
│ id (PK)      │◄────│ suite_run_id │     │ id (PK)      │
│ started_at   │     │ id (PK)      │◄────│ test_run_id  │
│ completed_at │     │ test_id      │     │ turn_number  │
│ total        │     │ test_name    │     │ file_path    │
│ passed       │     │ status       │     │ captured_at  │
│ failed       │     │ started_at   │     │ page_url     │
│ errors       │     │ completed_at │     │ page_title   │
│ timeouts     │     │ duration_ms  │     └──────────────┘
└──────────────┘     │ turn_count   │
                     │ screenshot_# │     ┌──────────────┐
                     │ input_tokens │     │  run_events  │
                     │ output_tokens│     │──────────────│
                     │ reasoning_tk │     │ id (PK)      │
                     │ model_verdict│◄────│ test_run_id  │
                     │ error        │     │ sequence     │
                     └──────────────┘     │ type         │
                            ▲             │ message      │
                            │             │ detail       │
                     ┌──────┴───────┐     │ timestamp    │
                     │ turn_tokens  │     └──────────────┘
                     │──────────────│
                     │ id (PK)      │
                     │ test_run_id  │
                     │ turn_number  │
                     │ input_tokens │
                     │ output_tokens│
                     │ reasoning_tk │
                     │ api_latency  │
                     │ cumulative_* │
                     │ timestamp    │
                     └──────────────┘
```

### Test Run Status Flow

```
queued → running → passed
                 → failed
                 → error
                 → timeout
```

---

## 4. API Endpoints

### Test Management

| Method | Endpoint                        | Description                              |
|--------|--------------------------------|------------------------------------------|
| GET    | /api/tests                     | List all test definitions from YAML      |
| POST   | /api/tests/:testId/run         | Run a single test (async, returns 202)   |
| GET    | /api/config/account            | Get test account credentials             |
| PUT    | /api/config/account            | Update test account credentials          |

### Suite Operations

| Method | Endpoint                        | Description                              |
|--------|--------------------------------|------------------------------------------|
| POST   | /api/suites                    | Start a suite run (async, returns 202)   |
| GET    | /api/suites?limit=N            | List recent suite runs                   |
| GET    | /api/suites/:suiteId           | Suite detail with test runs              |
| POST   | /api/suites/:suiteId/abort     | Abort all running tests in suite         |

### Run Details

| Method | Endpoint                        | Description                              |
|--------|--------------------------------|------------------------------------------|
| GET    | /api/runs/latest               | Latest run per test (aggregated)         |
| GET    | /api/runs/:runId               | Run detail + screenshots + events + tokens|
| POST   | /api/runs/:runId/abort         | Abort a specific running test            |
| GET    | /api/runs/:runId/events        | SSE stream of live events                |
| GET    | /api/runs/:runId/screenshots/* | Serve screenshot PNG files               |
| GET    | /api/runs/:runId/video         | Serve replay MP4 video                   |

### Reporting & Data

| Method | Endpoint                        | Description                              |
|--------|--------------------------------|------------------------------------------|
| GET    | /api/runs/:runId/report        | HTML report for single test run          |
| GET    | /api/suites/:suiteId/report    | HTML report for suite                    |
| GET    | /api/report/latest             | Aggregated HTML report (all latest runs) |
| POST   | /api/reset                     | Delete all data + screenshots            |

---

## 5. Dashboard Architecture

### Page Structure

```
/ (Dashboard)
├── Overview Tab      → Test cards grid with status badges
├── Test Results Tab  → Filterable table of all runs
├── Failures Tab      → Expanded failed test details
├── Logs Tab          → Live event stream
└── Config Tab        → Account settings, suite info, tags

/runs/[runId] (Run Detail)
├── Stats Row         → Duration, Turns, Screenshots, Tokens
├── Token Breakdown   → Collapsible per-turn token table
├── Screenshot Viewer → Gallery with thumbnail strip
├── Video Player      → Replay video (if available)
├── Model Verdict     → Full model response
├── Error Display     → Error message (if any)
└── Event Log         → Sidebar with timestamped events

/history (History)
└── Suite list        → Expandable past runs with details
```

### State Management (Main Dashboard)

```
┌─────────────────────────────────────────────────────┐
│ Dashboard State                                      │
│                                                      │
│ Data:                                                │
│   tests[]          ← GET /api/tests                  │
│   testRuns[]       ← GET /api/runs/latest (polled)   │
│   latestSuite      ← GET /api/suites?limit=1         │
│   activeSuiteId    ← Set on run, cleared on complete │
│   logEvents[]      ← From active run events          │
│                                                      │
│ UI:                                                  │
│   activeTab        ← overview|results|failures|...   │
│   searchFilter     ← Global search string            │
│   categoryFilter   ← all|smoke|sanity|regression|e2e │
│   headless         ← Boolean toggle                  │
│   running          ← Boolean (test in progress)      │
│                                                      │
│ Polling: Every 2 seconds                             │
│   1. Fetch /api/runs/latest + /api/suites?limit=1    │
│   2. If active suite → fetch suite detail             │
│   3. Merge runs (never lose data)                    │
│   4. Auto-detect active suite on page load           │
└─────────────────────────────────────────────────────┘
```

### Theme System

```
CSS Variables (globals.css)
├── :root (Light Mode - Default)
│   gray-900 → #ffffff (card surface)
│   gray-950 → #f9fafb (page background)
│   gray-50  → #111827 (headings)
│
└── .dark (Dark Mode)
    gray-900 → #111827
    gray-950 → #030712
    gray-50  → #f9fafb

Toggle: localStorage('theme') + html.classList.toggle('dark')
```

---

## 6. Token Tracking System

### Collection Points

```
OpenAI Response
    │
    ├── response.usage.input_tokens
    ├── response.usage.output_tokens
    └── response.usage.output_tokens_details.reasoning_tokens
            │
            ▼
    Per-Turn: turn_tokens table (granular)
    Per-Run:  test_runs table (totals, updated live)
```

### Dashboard Display

```
┌─────────────────────────────────────────────────────┐
│ Token Usage Breakdown                    [▼ expand] │
│                                                     │
│ Total Input   Total Output   Reasoning   Avg/Turn   │
│ 84.5k         1.4k           910         2.1k       │
│                                                     │
│ Turn │ Input  │ Output │ Reasoning │ Total │ Latency│
│ T1   │ 12.3k  │ 0.2k   │ 0.1k      │ 12.5k │ 7.1s  │
│ T2   │ 14.1k  │ 0.1k   │ 0.1k      │ 14.2k │ 6.8s  │
│ T3*  │ 28.4k  │ 0.3k   │ 0.2k      │ 28.7k │ 14.2s │
│ ...  │        │        │           │       │        │
│ * = expensive turn (>2x average)                    │
└─────────────────────────────────────────────────────┘
```

---

## 7. Screenshot & Video Pipeline

```
Browser (Playwright)
    │
    ├── page.screenshot({ type: 'png' })
    │   ├── Save to disk: data/screenshots/{testId}/{runId}/NNN-turn.png
    │   ├── Convert to base64 for OpenAI API input
    │   └── Record metadata in screenshots table
    │
    └── On test completion:
        └── FFmpeg (background, non-blocking)
            ├── Input:  %03d-turn.png (glob pattern)
            ├── Output: replay.mp4
            ├── Settings: 1fps, 1280px width, H.264, fast preset
            └── Timeout: 60 seconds
```

---

## 8. Test Lifecycle

```
1. DEFINE          2. SELECT           3. EXECUTE
   YAML files         Dashboard UI        Runner + OpenAI
   ─────────         ──────────          ──────────────
   name              Category chips      Launch browser
   url               Search bar          Navigate to URL
   instructions      Individual "Run"    CUA loop starts
   expected_outcome  "Run Tests" (all)     │
   category                                ▼
   max_turns                          ┌─────────────┐
   requires_auth                      │ Screenshot   │
                                      │      ↓       │
4. OBSERVE         5. REPORT          │ OpenAI API   │
   Dashboard          Export           │      ↓       │
   ──────────         ──────           │ Parse actions│
   Live stats         HTML reports     │      ↓       │
   Event log          Per-run          │ Execute      │
   Screenshots        Per-suite        │      ↓       │
   Token usage        Aggregated       │ Loop/Done    │
   Video replay       (no screenshots) └─────────────┘
```

---

## 9. YAML Test Definition Schema

```yaml
name: "Test Display Name"
url: "https://target-url.com"
requires_auth: false              # Use test account credentials
category: sanity                  # smoke | sanity | regression | e2e
max_turns: 40                     # Override default turn limit
timeout: 120000                   # Milliseconds (default 2 min)

instructions: |
  1. Step-by-step instructions for the AI agent
  2. What to click, verify, navigate to
  3. What to check and report

expected_outcome: "Description of what success looks like"

viewport:                         # Optional, default 1440x900
  width: 1440
  height: 900

tags:                             # For filtering and search
  - navigation
  - homepage
  - smoke
```

### Test Organization (by page)

```
tests/
├── homepage/           # Homepage UI tests
│   ├── homepage-navigation.yaml
│   ├── header-navigation.yaml
│   ├── logo-home-navigation.yaml
│   ├── cta-buttons.yaml
│   └── footer-links.yaml
├── search/             # Search & discovery
│   ├── search-functionality.yaml
│   └── integrations-explorer.yaml
├── pricing/            # Pricing page
│   └── pricing-page.yaml
├── auth/               # Login & authentication
│   ├── automate-login-auth.yaml
│   ├── logged-in-dashboard.yaml
│   └── signup-flow.yaml
├── connect/            # Connect editor & workflows
│   ├── automate-create-connect.yaml
│   ├── connect-setup-auth.yaml
│   ├── gohighlevel-mindbody-integration.yaml
│   └── ai-connect-generator.yaml
├── navigation/         # Cross-page & error handling
│   ├── cross-page-navigation.yaml
│   └── error-page-handling.yaml
└── help/               # Help & documentation
    └── help-docs.yaml
```

---

## 10. Error Handling & Abort

| Scenario                | Handling                                           |
|------------------------|----------------------------------------------------|
| OpenAI API error       | Thrown → test marked "error"                        |
| Action execution error | Logged, continues (model can recover from next screenshot) |
| Max turns reached      | Returns TIMEOUT verdict                            |
| User abort             | AbortController signal checked at 3 points per turn|
| Browser crash          | Caught in finally block, browser cleaned up        |
| DB write failure       | Logged, continues in-memory                        |
| FFmpeg failure         | Logged, no video generated (non-blocking)          |

### Abort Flow

```
Dashboard "Stop Test" → POST /api/runs/:runId/abort
    → AbortController.abort()
        → CUA loop checks signal.aborted at:
            1. Start of turn
            2. After API response
            3. After action execution
        → Returns FAIL + "manually aborted" message
```

---

## 11. Environment & Configuration

```bash
# Required
OPENAI_API_KEY=sk-...          # OpenAI API key for GPT-5.4

# Optional (with defaults)
RUNNER_PORT=3001               # Backend server port
NEXT_PUBLIC_API_URL=http://localhost:3001  # Frontend API target
DEFAULT_TEST_EMAIL=...         # Fallback test account email
DEFAULT_TEST_PASSWORD=...      # Fallback test account password
```

### File Structure

```
appypie-cua-tester/
├── package.json               # Root workspace config
├── pnpm-workspace.yaml        # pnpm workspace definition
├── packages/
│   ├── runner/
│   │   ├── src/
│   │   │   ├── server.ts      # Express API server
│   │   │   ├── test-runner.ts # Test orchestration
│   │   │   ├── cua-loop.ts    # Core CUA interaction loop
│   │   │   ├── actions.ts     # Playwright action execution
│   │   │   ├── browser.ts     # Browser launch/config
│   │   │   ├── db.ts          # sql.js database layer
│   │   │   ├── config.ts      # Account config management
│   │   │   ├── test-loader.ts # YAML test file loader
│   │   │   └── types.ts       # Shared TypeScript types
│   │   ├── tests/             # YAML test definitions (7 folders)
│   │   └── data/              # Runtime data (DB, screenshots)
│   │
│   └── dashboard/
│       └── src/
│           ├── app/
│           │   ├── layout.tsx        # Root layout + header
│           │   ├── globals.css       # Theme CSS variables
│           │   ├── page.tsx          # Main dashboard (5 tabs)
│           │   ├── history/page.tsx  # Suite history
│           │   └── runs/[runId]/page.tsx  # Run detail
│           ├── components/
│           │   └── ThemeToggle.tsx    # Dark/light mode toggle
│           └── lib/
│               ├── api.ts            # API helper functions
│               └── use-sse.ts        # SSE React hook
```

---

## 12. Performance Characteristics

| Metric                    | Typical Value              |
|--------------------------|---------------------------|
| API latency per turn     | 5–30 seconds              |
| Inter-action delay       | 120ms                     |
| Screenshot capture       | <100ms                    |
| Total test duration      | 60–360 seconds            |
| Tokens per test          | 50k–1.5M                  |
| Screenshots per test     | 10–60 PNG files (~100KB each) |
| Dashboard poll interval  | 2 seconds                 |
| DB save debounce         | 200ms                     |
| FFmpeg video generation  | 5–30 seconds              |
