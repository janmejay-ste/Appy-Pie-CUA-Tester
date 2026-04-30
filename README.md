# AppyPie CUA Tester

AI-powered QA testing platform that uses OpenAI's GPT-5.4 to autonomously test web applications through browser interaction.

Built for [Appy Pie Automate](https://www.appypieautomate.ai) — tests login flows, integration builders, pricing pages, navigation, and complex multi-step workflows like creating Connect automations.

---

## How It Works

```
Test Definition → Queue Job → Worker picks up → Launch Browser
                                                      ↓
                                              Auto-login (fills credentials)
                                                      ↓
                                              Extract DOM (25 elements)
                                                      ↓
                                         ┌────────────┴─────────────┐
                                         ↓                          ↓
                                   Action Cache              Send to GPT-5.4
                                  (replay known              (structured text)
                                   sequences)                       ↓
                                         └────────────┬─────────────┘
                                                      ↓
                                              Step Engine validates action
                                              (TRIGGER_SETUP → TRIGGER_COMPLETED
                                               → ACTION_SETUP → ACTION_CONFIG
                                               → FLOW_COMPLETE)
                                                      ↓
                                              Execute via Playwright adapter
                                              (elementId → text → coords → panel)
                                                      ↓
                                              Save screenshot → Re-extract DOM
                                                      ↓
                                              Repeat until PASS/FAIL/TIMEOUT
                                                      ↓
                                              Generate replay video (FFmpeg)
```

The system operates in two modes:

| Mode | Input to Model | Tokens/Turn | Use Case |
|------|---------------|-------------|----------|
| **DOM** (default) | Structured DOM text | ~2,500 | Most tests — 80% cheaper |
| **Vision** (fallback) | Base64 PNG screenshot | ~15,000 | Canvas, complex visual layouts |

---

## Features

- **Autonomous browser testing** — AI navigates, fills forms, clicks buttons, verifies outcomes
- **DOM-first architecture** — 80% token reduction vs screenshot-based approaches
- **Vision fallback** — auto-switches to screenshots when stuck (adaptive budget)
- **Step engine** — deterministic authority layer that enforces correct workflow progression (TRIGGER_SETUP → TRIGGER_COMPLETED → ACTION_SETUP → FLOW_COMPLETE); overrides and blocks illegal model actions
- **State machine** — gates actions to legal operations for the current UI state; prevents acting on modals, overlays, or loading canvases
- **Two-tier action cache** — single-action cache (per page state) + sequence cache (multi-action flows); replays proven sequences without GPT calls; `wait`/`scroll` actions are never cached to prevent replay loops
- **Canvas dual-loader** — absorbs Appy Pie's silent second canvas loader by polling for the "+" circle button up to 1500ms after first stability
- **Auto-login adapter** — fills credentials and clicks login automatically on login pages, saving ~4 model turns per run
- **Session-based execution** — group multiple tests, track pass/fail/error rates
- **Live dashboard** — real-time SSE updates, screenshot gallery, replay video
- **Token tracking** — per-turn breakdown, budget enforcement, cost visibility
- **Resume/retry** — timed-out tests can continue from last state with +N turns
- **Test CRUD** — create, edit, delete tests from dashboard or import YAML
- **System settings** — configurable concurrency, turn limits, token budgets, CUA mode
- **Security** — API key auth, rate limiting, CORS, credential protection, path traversal prevention

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, Tailwind CSS v4 |
| API Server | Express.js, TypeScript (ESM) |
| Database | Turso / libSQL (SQLite) |
| Queue | BullMQ + Redis |
| Browser | Playwright (Chromium) |
| AI Model | OpenAI GPT-5.4 |
| Video | FFmpeg |
| Validation | Zod |
| Logging | Pino |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Redis (running on port 6379)
- FFmpeg (in PATH, for replay videos)
- OpenAI API key with GPT-5.4 access

### Setup

```bash
# Clone
git clone https://github.com/janmejay-ste/Appy-Pie-CUA-Tester.git
cd Appy-Pie-CUA-Tester

# Install
pnpm install

# Configure
cp .env.example .env
# Edit .env → add your OPENAI_API_KEY and test account credentials
```

### Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-...

# Test account (used by auto-login adapter)
DEFAULT_TEST_EMAIL=your-test@email.com
DEFAULT_TEST_PASSWORD=your-test-password

# Optional (with defaults)
RUNNER_PORT=3001

# Database — local SQLite by default (zero config)
# For Turso cloud:
# TURSO_DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your-token

# Redis
REDIS_URL=redis://127.0.0.1:6379
```

### Run

```bash
# Both packages together
pnpm dev

# Or individually:
pnpm --filter runner dev      # API + worker on :3001
pnpm --filter dashboard dev   # Next.js dashboard on :3002
```

Open http://localhost:3002

---

## Project Structure

```
appypie-cua-tester/
├── packages/
│   ├── runner/                         # Backend
│   │   ├── src/
│   │   │   ├── index.ts                # Entry point — boots DB, queue, server
│   │   │   ├── server.ts               # Express API
│   │   │   ├── cua-loop.ts             # Core DOM-first AI loop
│   │   │   ├── cua-loop-vision.ts      # Vision mode (screenshot-based)
│   │   │   ├── dom-extractor.ts        # DOM extraction + stable hash IDs
│   │   │   ├── action-cache.ts         # Two-tier cache (singles + sequences)
│   │   │   ├── step-engine.ts          # Deterministic step progression authority
│   │   │   ├── state-machine.ts        # UI state gating (legal action validator)
│   │   │   ├── transition-engine.ts    # Step transition validity guard
│   │   │   ├── expected-state-engine.ts# Post-action state contract enforcement
│   │   │   ├── decision-engine.ts      # Model decision + constraint system
│   │   │   ├── adapter/
│   │   │   │   ├── types.ts            # ExecutionAdapter interface
│   │   │   │   ├── action-engine.ts    # 4-layer action fallback + dual-loader buffer
│   │   │   │   ├── playwright-adapter.ts # Browser implementation (auto-login, etc.)
│   │   │   │   └── target.ts           # Element resolution strategies
│   │   │   ├── db/
│   │   │   │   ├── turso.ts            # Turso/libSQL connection + migrations
│   │   │   │   └── repo.ts             # Repository layer (7 tables)
│   │   │   ├── queue/                  # BullMQ queue + worker
│   │   │   ├── routes/                 # Express route modules
│   │   │   ├── services/               # Business logic
│   │   │   ├── middleware/             # Auth, error handler
│   │   │   └── validation/             # Zod schemas
│   │   ├── data/
│   │   │   ├── cache/                  # Action cache (action-cache-v2.json)
│   │   │   └── logs/                   # Per-run markdown logs
│   │   └── tests/                      # YAML test definitions
│   │       ├── connect/                # Connect builder e2e tests
│   │       ├── auth/                   # Authentication tests
│   │       ├── navigation/             # Cross-page navigation
│   │       ├── search/                 # Search & integrations
│   │       ├── homepage/               # Homepage smoke tests
│   │       └── pricing/                # Pricing page tests
│   │
│   └── dashboard/                      # Frontend (Next.js 15)
│       └── src/app/
│           ├── page.tsx                # Main dashboard (6 tabs)
│           ├── runs/[runId]/           # Run detail — gallery, video, tokens, SSE log
│           └── history/                # Suite history
│
├── SYSTEM-DESIGN.md                    # Detailed architecture document
├── CLAUDE.md                           # AI assistant guidance
└── .env                                # Configuration (not committed)
```

---

## Authority Hierarchy

Actions flow through four layers before browser execution:

```
  STEP ENGINE        (top) — enforces workflow step progression
       ↓
  STATE MACHINE             — blocks illegal actions in current UI state
       ↓
  EXPECTED-STATE ENGINE     — verifies UI contracts after action
       ↓
  ACTION ENGINE      (exec) — 4-layer fallback: elementId → text → coords → panel
```

### Step Engine — Flow States

| State | Description | Enforcement |
|-------|-------------|-------------|
| `TRIGGER_SETUP` | Trigger app/event being configured | Allow |
| `TRIGGER_COMPLETED` | Test succeeded; panel shows results | Force Continue → then Add Action App |
| `ACTION_SETUP` | Action app chooser open | Block backward navigation |
| `ACTION_CONFIG` | Action form fields being filled | Allow |
| `FLOW_COMPLETE` | Workflow activated and live | Emit PASS immediately |

---

## Dashboard

### Tabs

| Tab | Description |
|-----|-------------|
| **Overview** | Test cards with status badges, category filters, search |
| **Test Results** | Sortable table of all test runs |
| **Failures** | Expanded cards for failed tests with error details |
| **Logs** | Live SSE event stream during test execution |
| **Test Manager** | CRUD for test definitions + YAML import |
| **Settings** | System config (concurrency, turns, tokens, CUA mode) |

### Run Detail Page

- Screenshot gallery with turn-by-turn navigation
- Replay video player
- Token usage breakdown (per-turn table with API latency)
- Live event log via SSE
- Re-test and resume (+20 turns) buttons

---

## Test Definitions

Tests are YAML files (or created via dashboard):

```yaml
name: "Create Connect - Google Sheets to Gmail Draft"
url: "https://connectcloud.appypie.com/connects"
requires_auth: true
category: e2e
max_turns: 40
timeout: 300000
instructions: |
  1. Navigate to /connects and click "Create Connect"
  2. Select Google Sheets as the trigger app
  3. Choose "New Spreadsheet Row" as the trigger event
  ...
expected_outcome: "Workflow created with Google Sheets trigger and Gmail action, status ON"
tags:
  - connect_creation
  - e2e
```

### Categories

| Category | Purpose |
|----------|---------|
| Smoke | Critical path validation |
| Sanity | Feature-level checks |
| Regression | Prevent regressions |
| E2E | Full user journey flows |

---

## Action Cache

The two-tier cache eliminates redundant GPT calls for known page actions:

| Tier | Key | Stores | Trust threshold |
|------|-----|--------|----------------|
| **Single** | URL pattern + page title + state hash | Best action for a page state | 3 successes |
| **Sequence** | URL pattern + page title | Multi-action flows (login, form fill) | 1 success |

**Cache safety rules:**
- `wait` and `scroll` actions are never stored in sequences — they are timing artifacts that cause replay loops
- Sensitive `type` actions (credentials, emails) are never replayed from cache
- Sequences disabled after 2 replay failures (exponential cooldown up to 24h)
- Per-page health tiers: `full → cautious → strict → disabled` based on success/failure ratio

---

## API

### Key Endpoints

```
GET    /api/tests                    # List all tests
POST   /api/tests                    # Create test
POST   /api/suites                   # Run all tests as a suite
POST   /api/tests/:id/run            # Run single test
GET    /api/runs/:id                 # Run detail + steps
GET    /api/runs/:id/screenshots/:f  # Serve screenshot
GET    /api/runs/:id/video           # Serve replay video
GET    /api/runs/:id/events          # SSE live stream
GET    /api/settings                 # Get runtime settings
PUT    /api/settings                 # Update settings
GET    /api/metrics                  # Aggregate pass/fail/token metrics
```

---

## Token Optimization

The DOM-first approach reduces token consumption by 65-85%:

| Scenario | Vision Mode | DOM Mode | Savings |
|----------|-------------|----------|---------|
| 15-turn test | ~220K tokens | ~40K tokens | 82% |
| 40-turn test | ~600K tokens | ~100K tokens | 83% |
| Cost per test | $0.30–$0.90 | $0.05–$0.15 | 80%+ |

The system automatically falls back to vision mode when:
- DOM has < 5 interactive elements (page still loading)
- Same state detected for 2+ turns without progress
- Model confidence drops below 0.4
- Expected-state contract fails twice on the same element

---

## Network Sharing

Share the dashboard with teammates using ngrok:

```bash
npx ngrok http 3002
```

Share the generated URL — the dashboard proxies API calls through Next.js rewrites, so only one tunnel is needed.

---

## Architecture

For the complete system design including database schema, queue architecture, security model, resume/retry flow, and token tracking pipeline, see [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md).

---

## License

Internal use — Appy Pie LLP
