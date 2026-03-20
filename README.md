# AppyPie CUA Tester

AI-powered QA testing platform that uses OpenAI's GPT-5.4 to autonomously test web applications through browser interaction.

Built for [Appy Pie Automate](https://www.appypieautomate.ai) — tests login flows, integration builders, pricing pages, navigation, and complex multi-step workflows like creating Connect automations.

---

## How It Works

```
Test Definition → Queue Job → Worker picks up → Launch Browser
                                                      ↓
                                              Extract DOM (25 elements)
                                                      ↓
                                              Send to GPT-5.4 (structured text)
                                                      ↓
                                              Model returns JSON action
                                                      ↓
                                              Execute via Playwright
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
| Frontend | Next.js 15, React 19, Tailwind CSS |
| API Server | Express.js, TypeScript (ESM) |
| Database | MongoDB 8 (Mongoose) |
| Queue | BullMQ + Redis/Memurai |
| Browser | Playwright (Chromium) |
| AI Model | OpenAI GPT-5.4 |
| Video | FFmpeg |
| Validation | Zod |

---

## Quick Start

### Prerequisites

- Node.js 20+
- MongoDB (running on port 27017)
- Redis or Memurai (running on port 6379)
- FFmpeg (for replay videos)
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
# Edit .env → add your OPENAI_API_KEY
```

### Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-...

# Optional (with defaults)
RUNNER_PORT=3001
MONGO_URI=mongodb://127.0.0.1:27017/cua-tester
REDIS_URL=redis://127.0.0.1:6379
DEFAULT_TEST_EMAIL=your-test@email.com
DEFAULT_TEST_PASSWORD=your-test-password
```

### Run

```bash
# Terminal 1 — Runner (API + Worker)
pnpm --filter runner dev

# Terminal 2 — Dashboard
pnpm --filter dashboard dev
```

Open http://localhost:3002

---

## Project Structure

```
appypie-cua-tester/
├── packages/
│   ├── runner/                    # Backend
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point
│   │   │   ├── server.ts          # Express API (25 endpoints)
│   │   │   ├── cua-loop.ts        # DOM-first AI loop + mode dispatch
│   │   │   ├── cua-loop-vision.ts # Vision mode (screenshot-based)
│   │   │   ├── dom-extractor.ts   # DOM extraction + formatting
│   │   │   ├── actions.ts         # Playwright actions (4-layer fallback)
│   │   │   ├── browser.ts         # Chromium launch config
│   │   │   ├── db/models/         # MongoDB models (6 collections)
│   │   │   ├── queue/             # BullMQ queue + worker
│   │   │   ├── services/          # Business logic
│   │   │   └── validation/        # Zod schemas
│   │   └── tests/                 # YAML test definitions
│   │       ├── homepage/          # Homepage tests (5)
│   │       ├── connect/           # Connect builder tests (5)
│   │       ├── auth/              # Authentication tests (3)
│   │       ├── search/            # Search & integrations (2)
│   │       ├── navigation/        # Cross-page navigation (2)
│   │       ├── pricing/           # Pricing page (1)
│   │       └── help/              # Help & docs (1)
│   │
│   └── dashboard/                 # Frontend
│       └── src/app/
│           ├── page.tsx           # Main dashboard (6 tabs)
│           ├── runs/[runId]/      # Run detail page
│           └── history/           # Suite history
│
├── SYSTEM-DESIGN.md               # Detailed architecture document
└── .env                           # Configuration (not committed)
```

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
- Token usage breakdown (per-turn table)
- Live event log
- Re-test and retry (+20 turns) buttons

---

## Test Definitions

Tests can be created via dashboard or YAML files:

```yaml
name: "Homepage Navigation"
url: "https://www.appypieautomate.ai"
category: smoke
max_turns: 40
requires_auth: false
instructions: |
  1. Verify the homepage loads completely
  2. Check navigation links are present
  3. Click the primary CTA button
  4. Verify it navigates to signup
expected_outcome: "Homepage loads with navigation, CTA leads to signup"
tags:
  - homepage
  - navigation
```

### Categories

| Category | Purpose | Color |
|----------|---------|-------|
| Smoke | Critical path validation | Cyan |
| Sanity | Feature-level checks | Violet |
| Regression | Prevent regressions | Orange |
| E2E | Full user journey flows | Pink |

---

## API

### Key Endpoints

```
GET    /api/tests                    # List all tests
POST   /api/tests                    # Create test
POST   /api/suites                   # Run all tests
POST   /api/tests/:id/run            # Run single test
GET    /api/runs/:id                 # Run detail
GET    /api/runs/:id/screenshots/:f  # Serve screenshot
GET    /api/runs/:id/video           # Serve replay video
GET    /api/settings                 # Get settings
PUT    /api/settings                 # Update settings
GET    /api/runs/:id/events          # SSE live stream
```

---

## Token Optimization

The DOM-first approach reduces token consumption by 65-85%:

| Scenario | Vision Mode | DOM Mode | Savings |
|----------|-------------|----------|---------|
| 15-turn test | ~220K tokens | ~40K tokens | 82% |
| 40-turn test | ~600K tokens | ~100K tokens | 83% |
| Cost per test | $0.30-$0.90 | $0.05-$0.15 | 80%+ |

The system automatically falls back to vision mode when:
- DOM has < 5 interactive elements
- Same state detected for 2+ turns
- Model confidence drops below 0.4

---

## Network Sharing

Share the dashboard with teammates using ngrok:

```bash
npx ngrok http 3002
```

Share the generated URL — the dashboard proxies API calls through Next.js rewrites, so only one tunnel is needed.

---

## Architecture

For the complete system design including MongoDB schemas, queue architecture, security model, resume/retry flow, and token tracking pipeline, see [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md).

---

## License

Internal use — Appy Pie LLP
