# Skills Reference — AppyPie CUA Tester

Quick-reference for navigating, understanding, and working on this codebase.

---

## 1. Project Identity

| Field | Value |
|-------|-------|
| **What** | AI-powered QA testing platform for [Appy Pie Automate](https://www.appypieautomate.ai) |
| **How** | GPT-5.4 reads DOM (or screenshots), decides JSON actions, executes via Playwright, repeats until pass/fail/timeout |
| **Monorepo** | pnpm workspaces — `packages/runner` (backend) + `packages/dashboard` (frontend) + `packages/shared` (types) |
| **Tech** | Express + TypeScript ESM, Next.js 15, React 19, Tailwind v4, MongoDB, BullMQ + Redis, Playwright, OpenAI, FFmpeg, Pino, Vitest |

---

## 2. Quick Commands

```bash
pnpm install                    # Install all dependencies
pnpm dev                        # Run both runner (:3001) + dashboard (:3002)
pnpm --filter runner dev        # Backend only
pnpm --filter dashboard dev     # Frontend only
pnpm build                      # Build both packages
pnpm test                       # Run vitest (50 tests)
docker compose up -d            # Start MongoDB + Redis
```

**Prerequisites:** MongoDB :27017, Redis :6379, FFmpeg in PATH, `OPENAI_API_KEY` in root `.env` (see `.env.example`)

---

## 3. Architecture Map

```
                     ┌─────────────────────────────────────┐
                     │  Dashboard (Next.js 15, :3002)       │
                     │  src/app/page.tsx  — 6-tab dashboard │
                     │  src/app/runs/[runId] — run detail   │
                     │  src/app/history — suite history      │
                     │  src/lib/api.ts — API client          │
                     │  src/lib/use-sse.ts — live events     │
                     └────────────┬────────────────────────┘
                                  │ /api/* proxied via next.config.ts
                     ┌────────────▼────────────────────────┐
                     │  Runner API (Express, :3001)          │
                     │  src/server.ts — ~25 endpoints        │
                     └────────────┬────────────────────────┘
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                  ▼
         ┌────────────┐  ┌──────────────┐  ┌──────────────┐
         │  BullMQ     │  │  MongoDB     │  │  Redis       │
         │  Queue +    │  │  7 models    │  │  Pub/Sub     │
         │  Worker     │  │  TestRun,    │  │  SSE events  │
         │             │  │  Step, Event │  │  Job queue   │
         └──────┬──────┘  └──────────────┘  └──────────────┘
                ▼
         ┌──────────────────────────────────────┐
         │  CUA Loop (DOM-first)                 │
         │  src/cua-loop.ts — main loop          │
         │  src/cua-loop-vision.ts — fallback    │
         │  src/vision-decision.ts — mode switch │
         │                                       │
         │  DOM Extract → GPT-5.4 → JSON Action  │
         │       ↓                                │
         │  Adapter Layer (src/adapter/)          │
         │  action-engine.ts — 4-layer fallback   │
         │  playwright-adapter.ts — browser ops   │
         │       ↓                                │
         │  Playwright (Chromium)                 │
         └──────────────────────────────────────┘
```

---

## 4. Key File Index

### Runner (`packages/runner/src/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `index.ts` | Entry: boots Mongo, worker, schedulers, Express | 50 |
| `server.ts` | Express setup — mounts routers + middleware | 96 |
| `logger.ts` | Pino structured logger (pretty in dev, JSON in prod) | 15 |
| `cua-loop.ts` | **Core**: DOM-first AI loop, state machine, stuck detection | 1400 |
| `cua-loop-vision.ts` | Vision-based loop (screenshot input, higher token cost) | 700 |
| `vision-decision.ts` | 3-layer decision engine: hard rules → failure classify → vision score | 580 |
| `dom-extractor.ts` | Extract top interactive elements, stable hash IDs, fingerprinting | 300 |
| `actions.ts` | Legacy action execution (pre-adapter) | 400 |
| `browser.ts` | Playwright browser launch + session management | 100 |
| `config.ts` | Test account email/password management | 50 |
| `types.ts` | Core types: TestRun, DOMElement, ModelAction, CUALoopResult | 200 |
| `test-loader.ts` | YAML test definition loader from tests/ directory | 50 |

#### Routes (`src/routes/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `routes/tests.ts` | Test CRUD, YAML import/sync, single-test run | ~200 |
| `routes/suites.ts` | Suite run, abort, list, detail, reports | ~200 |
| `routes/runs.ts` | Run detail, screenshots, video, SSE events, abort | ~200 |
| `routes/config.ts` | Account config + system settings | ~80 |
| `routes/metrics.ts` | Metrics, DLQ, cleanup, reset, reports | ~200 |

#### Middleware (`src/middleware/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `middleware/auth.ts` | API key auth (skips in dev, blocks in production) | 15 |
| `middleware/error-handler.ts` | Zod validation error → 400 response | 15 |
| `middleware/utils.ts` | `escapeHtml` utility for HTML reports | 5 |

#### Adapter (`src/adapter/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `types.ts` | `ExecutionAdapter` interface, `BrowserState`, `ActionStep`, strategies | 150 |
| `action-engine.ts` | Multi-strategy execution: selector → text → role → coordinates | 600 |
| `playwright-adapter.ts` | Playwright implementation — DOM extraction, auto-click, cleanup | 900 |
| `index.ts` | Barrel exports | 5 |

#### Queue (`src/queue/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `queue.ts` | BullMQ queue config, `TestJobData` interface | 50 |
| `worker.ts` | Job processor: browser → CUA loop → video → cleanup | 510 |

#### DB Models (`src/db/models/`)

| Model | Key Fields |
|-------|-----------|
| `TestRun` | sessionId, testId, status, turnCount, tokens, modelVerdict, lastHeartbeat |
| `Step` | testRunId, turnNumber, filePath, action, result, validation, tokens, mode |
| `Session` | total, passed, failed, errors, timeouts |
| `Event` | testRunId, type, message, sequence |
| `Settings` | maxConcurrency, maxTurns, tokenBudget, cuaMode |
| `TestDef` | name, url, instructions, category, tags, requiresAuth |
| `MetricSnapshot` | activeRuns, totalRuns, avgTokens, failureRate |

#### Services (`src/services/`)

| File | Purpose |
|------|---------|
| `test.service.ts` | CRUD for runs, steps, events |
| `session.service.ts` | Session stats aggregation |
| `metrics.service.ts` | Hourly metrics scheduler |
| `cleanup.service.ts` | Data retention (30d, 100 runs/test) |

#### Validation (`src/validation/`)

| File | Purpose |
|------|---------|
| `test.validation.ts` | Zod schemas for API input |

---

### Dashboard (`packages/dashboard/src/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `app/layout.tsx` | Root layout, header, nav, theme script | 80 |
| `app/page.tsx` | **Main dashboard** — 6 tabs, polling, run controls, CRUD | 2000 |
| `app/runs/[runId]/page.tsx` | Run detail — screenshots, video, tokens, events | 590 |
| `app/history/page.tsx` | Suite history — expandable cards | 125 |
| `app/globals.css` | Theme CSS variables, Tailwind import | 40 |
| `components/ThemeToggle.tsx` | Dark/light mode toggle | 40 |
| `lib/api.ts` | API client (fetch wrappers for all endpoints) | 72 |
| `lib/use-sse.ts` | SSE hook for live event streaming | 55 |

---

### Shared Types (`packages/shared/src/`)

| File | Purpose | ~Lines |
|------|---------|--------|
| `index.ts` | Single source of truth: TestDefinition, TestRun, SuiteRun, RunDetail, Screenshot, RunEvent, TurnToken, SystemSettings, TestAccount, TabId | 120 |

### Tests (`packages/runner/tests/`)

| File | Purpose | Tests |
|------|---------|-------|
| `vision-decision.test.ts` | VisionDecisionEngine scoring, hard rules, cooldown, feedback | 24 |
| `action-engine.test.ts` | Action execution, validation, strategy tracking | 26 |

### Root Config

| File | Purpose |
|------|---------|
| `package.json` | Workspace scripts (`dev`, `build`, `test`) |
| `pnpm-workspace.yaml` | Workspace: `packages/*` |
| `tsconfig.base.json` | Shared TS config (ES2022, strict) |
| `vitest.config.ts` | Test config (globals, include pattern) |
| `.env` | `OPENAI_API_KEY` (loaded via `tsx --env-file`) |
| `.env.example` | Template for all 17 env vars |
| `docker-compose.yml` | Redis 7 for local dev (DB is Turso/SQLite) |
| `.github/workflows/ci.yml` | CI: typecheck + build on push/PR |
| `CLAUDE.md` | AI assistant instructions |
| `SYSTEM-DESIGN.md` | 1300-line architecture document |
| `IMPROVEMENTS.md` | Audit fixes + improvement tracker |
| `skills.md` | This file — codebase quick-reference |
| `README.md` | Setup, usage, API docs |

---

## 5. Core Concepts

### CUA Loop (DOM-first)
1. Extract DOM via adapter → top 30-70 interactive elements with stable hash IDs
2. Format as structured text (~2,500 tokens) with test instructions, progress, action history
3. Send to GPT-5.4 → receive JSON action (`click`, `type`, `select`, `scroll`, `navigate`, `keypress`, `wait`, `done`)
4. Execute via adapter with 4-layer fallback: selector → text → role → coordinates
5. Validate result (URL change, DOM change, value change, error appearance)
6. Screenshot, persist step, emit events
7. Repeat until `done` verdict, timeout, stuck, or token budget exceeded

### Vision Fallback
- Activates when DOM mode gets stuck (5+ failures, same DOM, canvas detected, external auth)
- Sends base64 screenshot instead of text DOM (~15,000 tokens/turn)
- 3-state FSM: `DOM_NORMAL` → `DOM_WITH_VISION` → `VISION_BURST` (max 3 vision turns)
- Vision decision engine uses weighted signal scoring (threshold 0.80 for full vision)

### Adapter Pattern
- `ExecutionAdapter` interface decouples AI actions from Playwright
- `PlaywrightAdapter` implements all browser ops + Appy Pie automations:
  - **Auto-login**: Detects login form, fills email+password+submits (saves ~4 turns)
  - **Auto-click Continue**: On account steps, clicks Continue when account is already linked
  - **Auto-fill custom dropdowns**: Fills `.menu_icon-box` dropdowns (Spreadsheet, Worksheet) on options pages
  - **Auto-fill action fields**: Fills "+ Add or Select" token pickers on action config pages
  - **DOM cleanup**: Removes expand buttons, OAuth traps, guide buttons, social login links
- `ActionEngine` provides multi-strategy execution with validation
  - `select value="first"` treated as "pick first available option" for custom dropdowns
  - 800ms settle delay after click/select for AJAX transitions

### Stuck Detection (Multi-Layer)
- Action repeat: 5+ identical actions → abort
- Same DOM state: 4+ turns identical URL + DOM → abort
- URL watchdog: auto-bounce from external traps (Google, Facebook)
- No-progress: 30 turns without DOM change → abort
- Token budget: hard cap at `maxTokensPerSession`

### Queue & Worker
- BullMQ queue with Redis backend
- Worker: launch browser → run CUA loop → generate FFmpeg video → cleanup
- Resume: restore cookies/localStorage, prepend completed-steps context
- Retry: 2x with 5s backoff for infra errors; `UnrecoverableError` for test failures
- Crash recovery: detect stale heartbeats on startup

---

## 6. API Endpoints (Runner :3001)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/api/tests` | List all test definitions |
| GET | `/api/tests/:id` | Get single test |
| POST | `/api/sessions` | Create test session (suite) |
| GET | `/api/sessions/:id` | Get session with runs |
| GET | `/api/sessions/:id/runs` | Get runs in session |
| POST | `/api/runs` | Queue a test run |
| GET | `/api/runs/:id` | Get run detail |
| POST | `/api/runs/:id/abort` | Cancel running test |
| GET | `/api/metrics` | Overall metrics |
| GET | `/api/queue/metrics` | Queue status |
| POST | `/api/settings` | Update settings |
| GET | `/api/settings` | Get settings |
| GET | `/runs/:runId/events` | SSE event stream |

---

## 7. Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| **Overview** | Category-grouped test cards with status, duration, run buttons |
| **Results** | Filterable table of all runs (status, turns, tokens) |
| **Failures** | Failed/error runs with error messages and verdicts |
| **Logs** | Live SSE event log from active run |
| **Test Manager** | Full CRUD: create, edit, delete, duplicate, bulk run, import/export YAML |
| **Settings** | System config (concurrency, tokens, timeout) + test account management |

---

## 8. Token Economics

| Mode | Cost/Turn | When Used |
|------|-----------|-----------|
| **DOM** | ~2,500 tokens | Default — structured text extraction |
| **Vision** | ~15,000 tokens | Fallback — base64 screenshot when DOM fails |

Token budget enforced per session (`maxTokensPerSession`, default 500,000). Warning at 80%, hard abort at limit.

---

## 9. Test YAML Format

```yaml
name: "Test Name"
url: "https://www.appypieautomate.ai"
requires_auth: true|false
category: smoke|sanity|regression|e2e
timeout: 120000          # ms
max_turns: 40
instructions: |
  1. Step one
  2. Step two
expected_outcome: "What success looks like"
tags: [tag1, tag2]
```

Tests live in `packages/runner/tests/` organized by category: `auth/`, `connect/`, `homepage/`, `navigation/`, `pricing/`, `search/`, `help/`.

---

## 10. Common Development Tasks

### Add a new test
Create a YAML file in `packages/runner/tests/<category>/` following the format in section 9.

### Add a new API endpoint
1. Add route in `packages/runner/src/routes/<module>.ts`
2. Add Zod schema in `src/validation/test.validation.ts` (if input needed)
3. Add query functions in `src/db/repo.ts`
4. Add service method in `src/services/` (if business logic needed)
5. Add API client function in `packages/dashboard/src/lib/api.ts`

### Add a new DB table
1. Add CREATE TABLE in `src/db/turso.ts` migrations
2. Add query functions in `src/db/repo.ts` (format helpers + CRUD)
3. Create service in `src/services/` for business logic

### Modify CUA loop behavior
- DOM extraction: `src/adapter/playwright-adapter.ts` (`getState()`)
- Action execution: `src/adapter/action-engine.ts`
- Loop logic/prompts: `src/cua-loop.ts`
- Vision mode: `src/cua-loop-vision.ts`
- Mode switching: `src/vision-decision.ts`

### Modify dashboard UI
- Main dashboard: `packages/dashboard/src/app/page.tsx` (2000 lines, 6 tabs)
- Run detail: `src/app/runs/[runId]/page.tsx`
- API calls: `src/lib/api.ts`
- Styling: Tailwind v4 utility classes + `globals.css` theme variables

---

## 11. Skill: Mapping Fields in Connect Builder Edit Options

**Context:** The Connect builder action options page (`/customeditor/.../options/...`) renders a long form in a side panel. Required fields are stacked vertically and many sit **below the fold**. Without scrolling, the AI can only see the top 3-5 fields, so tests fail with "X is a required parameter" errors for unseen fields like `Location`, `Send Email`, `Payments Type`, `Item Type`, etc.

### How field mapping works on this page

| Field type | UI pattern | How to fill |
|------------|-----------|-------------|
| **Token-mapped fields** (e.g. ClientId, EmailFrom) | Has a `+ Add or Select` button that opens a token picker showing trigger output values | Click the button → wait → click first available token in the picker |
| **Plain dropdowns** (e.g. Site List, Location, Item Type) | `.menu_icon-box` custom dropdown OR a native `<select>` | Click → wait for options → click first non-placeholder option |
| **Numeric fields** (e.g. Quantity, Amount, Price) | Plain `<input type="text">` or `<input type="number">` | Type a default value (`1` for quantity, `20` for amount) |
| **Mapped+enum fields** (e.g. Payments Type) | `+ Add or Select` button BUT picker shows enum values not trigger output | Same as token-mapped — click first available |

### Where the auto-fill logic lives

| File | Function | What it does |
|------|----------|--------------|
| `playwright-adapter.ts` | `autoFillOnOptionsPage(url)` | Entry point — called from `getState()` after every DOM read on `/options/`/`/actionoptions`/`/config` URLs |
| `playwright-adapter.ts` | `autoFillActionFields()` | Finds all visible `+ Add or Select` buttons → opens picker → clicks first item |
| `playwright-adapter.ts` | `autoFillCustomDropdowns()` | Fills `.menu_icon-box` dropdowns (skipped on complex action pages) |
| `playwright-adapter.ts` | `scroll('down', amount)` | Scrolls side panel: tries panel selectors first (`.halfcolume`, `[class*="action-detail"]`), falls back to mouse wheel on right side |

### Multi-pass scroll-and-fill (the scroll fix)

`autoFillOnOptionsPage` runs **up to 5 passes** of `[fill visible fields → scroll panel down 400px → wait 600ms → repeat]`. Stops early when 2 consecutive passes find nothing new OR the panel can't scroll further. Each pass also re-runs the numeric direct-fill so newly-revealed Quantity/Amount inputs get a `1`.

This means tests written for the Connect builder do NOT need to manually instruct "scroll down to reveal fields" — the adapter handles it. The test YAML can list fields in any order.

### Field dependencies (prerequisite fields)

Some fields are disabled until upstream fields are filled. Common chains:
- **ClientId** depends on **site_list** + **username** + **password** — fill site first or you get `"Please fill site_list,username,password before select client id"`
- **Items** is required — must select Product OR Service OR Package via `+ Add or Select`
- **PaymentMethodId** requires **Payments Type** to be selected first

The auto-fill loop handles this naturally because each pass re-scans the form state — once a prerequisite is filled, the dependent field's `+ Add or Select` becomes visible/clickable on the next pass.

### When the AI must take over

Auto-fill won't handle these — the test's `instructions` block must:
- **Explicitly map a token** (e.g. ClientId from `email` not first option) — auto-fill picks the first token, which may not be the right semantic match
- **Choose specific dropdown values** (e.g. "Cash" not first payment type) — auto-fill picks first
- **Fields without `+ Add or Select` and no `.menu_icon-box`** — plain selects or text inputs without numeric labels
- **Conditional fields** that only appear after a specific upstream value (e.g. recurring options when "Subscription" type is selected)

### How to write an editoptions test step

```yaml
9. Configure the Create Sale fields. The adapter auto-fills fields top-to-bottom
   with first-available options. You only need to instruct overrides:
   a. Site List — auto-filled (first available)
   b. ClientId — REQUIRED MANUAL: open mapping dropdown, select email or contact_id from trigger
   c. Product — auto-filled (first available) — satisfies "Items" requirement
   d. Quantity — auto-filled to "1"
   e. Amount — auto-filled to "1"
   f. Location — auto-filled (first available)
   g. Send Email — auto-filled (first available, usually "True")
   h. Payments Type — auto-filled (first available, usually "Cash")
   i. Item Type — auto-filled (first available, usually "product")
   j. Optional fields (Service, Package, Staff, Sale Date, Notes) — skip
10. Click "Continue & Run Test"
11. If error "X is a required parameter" → manually fill X from the dropdown shown
```

### Debugging field-mapping failures

- Check console logs for `[adapter] Pass N: filled M action fields` — confirms multi-pass ran
- Check for `[adapter] Auto-fill "FieldName" failed: picker not found` — picker selector needs updating
- Check for `[adapter] Multi-pass auto-fill complete: X field(s) filled` — final summary
- If 0 fields filled: the buttons aren't matching `+ Add or Select` text — check page DOM in vision mode

---

## 12. Key Design Decisions

1. **DOM-first, vision-fallback** — 65-85% token savings vs pure vision
2. **Stable element IDs** — MD5 hash of tag+id+name+testid+ariaLabel+text survives re-extraction
3. **4-layer action fallback** — selector → text → role → coordinates before failing
4. **Adapter pattern** — `ExecutionAdapter` interface decouples AI from Playwright
5. **SSE for live updates** — Redis pub/sub → SSE (not WebSocket)
6. **Turso/SQLite for persistence** — zero-config local dev (`file:local.db`), Turso cloud for production. Single `repo.ts` repository layer
7. **All config in `.env` at root** — runtime settings in Turso `settings` table
8. **Vitest for testing** — 50 unit tests for vision-decision + action-engine. `pnpm test`
9. **Pino structured logging** — JSON in production, pretty in dev. Suppresses polling noise
10. **Adapter auto-actions** — auto-login, auto-click Continue, auto-fill dropdowns, auto-fill token pickers — reduces model turns by ~40%
11. **Resume capability** — cookies + localStorage + completed-step context for interrupted runs
