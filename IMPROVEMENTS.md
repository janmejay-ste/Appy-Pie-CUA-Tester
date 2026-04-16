# Improvements Tracker

## Status Legend
- [x] Completed
- [ ] In Progress / Pending

---

## Audit Fixes (Round 1) — COMPLETED

- [x] **TS Error**: Required param after optional in `cua-loop-vision.ts:172` — changed to explicit `| undefined`
- [x] **Security**: CORS `http://10.*` wildcard replaced with `http://127.0.0.1:` in `server.ts`
- [x] **Security**: Auth middleware returns 500 in production if `INTERNAL_API_KEY` unset
- [x] **Security**: Removed hardcoded test credentials from `config.ts`
- [x] **Security**: Added `maxTurnsOverride` validation (1-500) in `server.ts`
- [x] **Runtime**: Video generation IIFE — added `void` prefix for unhandled rejection
- [x] **Runtime**: Redis abort subscriber — `.on()` changed to `.once()` to prevent leak
- [x] **Runtime**: PORT validation — exits on NaN `RUNNER_PORT`
- [x] **Runtime**: Schedulers — `await Promise.all()` instead of fire-and-forget
- [x] **Logic**: SSE endpoint — added `res.end()` on inactive run
- [x] **Logic**: `lastEventId` — validates digits-only before `parseInt`
- [x] **Logic**: Resume — only allows resume from `timeout` or `error` runs
- [x] **DB**: Added compound index `{ sessionId: 1, status: 1 }` on TestRun
- [x] **Worker**: Added `stalled` event handler

---

## Improvements (Round 2) — COMPLETED

### Phase 1: Shared Types Package — DONE
- [x] Created `packages/shared/` with `@cua/shared` workspace package
- [x] Centralized API types: `TestDefinition`, `TestRun`, `SuiteRun`, `RunDetail`, `Screenshot`, `RunEvent`, `TurnToken`, `SystemSettings`, `TestAccount`, `TabId`
- [x] Dashboard imports from `@cua/shared` (page.tsx, history/page.tsx, runs/[runId]/page.tsx)
- [x] Removed 65+ lines of duplicated type definitions across 3 dashboard files

### Phase 2: Split Dashboard page.tsx — DEFERRED
*Deferred to avoid breaking the 1,997-line component mid-session. The shared types and API client refactors prepare for this split.*

### Phase 3: Type-Safe API Client — DONE
- [x] Rewrote `packages/dashboard/src/lib/api.ts` with typed return values using `@cua/shared`
- [x] Added `ApiError` class with HTTP status codes
- [x] Generic `request<T>()` helper with status code + body context in errors
- [x] Added missing API functions: `fetchSettings`, `fetchAccount`, `updateSettings`, `updateAccount`, `abortRun`
- [x] All 15 functions now have explicit return type annotations

### Phase 4: Extract Domain Logic from Adapter — DEFERRED
*Deferred — requires careful testing with real Appy Pie flows. The adapter currently works; extracting guards is a refactor-only change with risk of regression.*

### Phase 5: Deduplicate CUA Loops — DEFERRED
*Deferred — the two loops (1,394 + 708 lines) have subtle differences in prompt construction, action execution, and verification. Extracting a shared core requires deep integration testing.*

### Phase 6: Split server.ts into Route Modules — DONE
- [x] Created `src/routes/tests.ts` — test CRUD, YAML import/sync, single-test run (7 endpoints)
- [x] Created `src/routes/suites.ts` — suite run, abort, list, detail, reports (6 endpoints)
- [x] Created `src/routes/runs.ts` — run detail, screenshots, video, SSE events, abort, reports (7 endpoints)
- [x] Created `src/routes/config.ts` — account config + system settings (4 endpoints)
- [x] Created `src/routes/metrics.ts` — metrics, DLQ, cleanup, reset, reports (8 endpoints)
- [x] Created `src/middleware/auth.ts` — extracted auth middleware
- [x] Created `src/middleware/error-handler.ts` — shared Zod error handler
- [x] Created `src/middleware/utils.ts` — `escapeHtml` utility
- [x] Slimmed `server.ts` from ~1,177 lines to ~96 lines (router mounting only)
- [x] All 34 original endpoints preserved

### Phase 7: Flatten Worker Callbacks — DONE
- [x] Extracted `checkTokenBudget()` helper function (replaces 26-line inline callback logic)
- [x] Extracted `buildStepData()` helper (replaces complex ternary spread in onScreenshot)
- [x] Pre-loaded settings once before `runCUALoop` (was imported 3 times inside callbacks)
- [x] Top-level imports for `getSettings` and types (eliminates dynamic `await import()` inside callbacks)

### Phase 8: Test Infrastructure (vitest) — DONE
- [x] Installed vitest v4.1.3 as workspace dev dependency
- [x] Created `vitest.config.ts` at root with globals and include pattern
- [x] Added `"test": "vitest run"` script to root package.json
- [x] Created `packages/runner/tests/vision-decision.test.ts` — 24 tests covering:
  - Hard rules (zero elements, canvas, external auth, unknown domain)
  - Score calculation (failure score, progress boost, low confidence, sameDOM, stuck duration)
  - Cooldown mechanics (DOM forced after vision burst)
  - Feedback loop (positive/negative adjustment, clamping)
  - Failure classification (timeout, missing element, intent mismatch, no-effect, network, wrong page)
- [x] Created `packages/runner/tests/action-engine.test.ts` — 26 tests covering:
  - All action types (click, type, select, scroll, navigate, keypress, wait, done)
  - Validation (URL change, DOM change, error detection, effective computation)
  - Strategy tracking and duration measurement
- [x] **50 tests passing** in 2.77s

### Phase 9: Structured Logging (pino) — DONE
- [x] Installed `pino`, `pino-http`, `pino-pretty`, `@types/pino-http`
- [x] Created `src/logger.ts` — central pino logger (pretty in dev, JSON in production)
- [x] Added `pino-http` middleware to Express (skips /health)
- [x] Replaced all `console.log/warn/error` in:
  - `index.ts` — 6 replacements
  - `queue/worker.ts` — 21 replacements (with structured context objects)
  - `db/mongo.ts` — 1 replacement

### Phase 10: DevOps — DONE
- [x] Created `.env.example` — template with all 11 env vars + comments
- [x] Created `docker-compose.yml` — MongoDB 7 + Redis 7 with named volumes
- [x] Created `.github/workflows/ci.yml` — Node 20 + pnpm 9, typecheck + build on push/PR to main

### Misc — DONE
- [x] Removed unused `recharts` dependency from dashboard package.json

---

## Database Migration: MongoDB → Turso (Round 3) — COMPLETED

### What Changed
- [x] Removed `mongoose` dependency, installed `@libsql/client`
- [x] Created `src/db/turso.ts` — Turso/libSQL connection + auto-migration (7 tables, 10 indexes)
- [x] Created `src/db/repo.ts` (~600 lines) — complete repository layer with 50+ query functions
- [x] Migrated all 4 services: test.service.ts, session.service.ts, cleanup.service.ts, metrics.service.ts
- [x] Migrated all 5 routes: tests.ts, suites.ts, runs.ts, config.ts, metrics.ts
- [x] Migrated worker.ts + index.ts
- [x] Deleted all 8 Mongoose model files + mongo.ts
- [x] Updated `.env.example` (MONGO_URI → TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
- [x] Updated `docker-compose.yml` (removed MongoDB container)
- [x] Updated `CLAUDE.md` with new DB architecture

### Tables Created (SQLite)
| Table | Replaces | Indexes |
|-------|----------|---------|
| `test_runs` | TestRun model | test_id+started_at, session_id+status |
| `steps` | Step model | test_run_id+turn_number |
| `sessions` | Session model | — |
| `events` | Event model | test_run_id+sequence |
| `settings` | Settings model (singleton) | — |
| `test_defs` | TestDef model | is_active+name |
| `metric_snapshots` | MetricSnapshot model | timestamp |

### Key Decisions
- Dates stored as ISO strings (SQLite has no native Date type)
- JSON columns (action, result, validation, viewport, tags, page_state) stored as TEXT with JSON.stringify/parse
- Booleans stored as INTEGER 0/1
- TTL (MetricSnapshot 30-day) replaced with scheduled cleanup in metrics service
- All MongoDB aggregation pipelines ($group, $sum, $avg) converted to SQL GROUP BY + aggregate functions

### Verification
- TypeScript: zero errors on both packages
- Tests: 50/50 passing
- Build: both packages build successfully

---

## Connect Flow Fixes (Round 4) — COMPLETED

### Adapter Fixes (`playwright-adapter.ts`)
- [x] **Auto-login**: Detects login form on allowed domains, fills email+password+clicks submit automatically. Saves ~4 model turns per test. Tracked via `autoLoginCompleted` flag
- [x] **autoClickContinue scope**: Restored to fire on all `/customeditor/` URLs (not just `/account`). The evaluate script checks for linked-account indicators before clicking, so it's safe on config pages
- [x] **autoFillActionFields URL broadened**: Now triggers on `/options`, `/actionoptions`, and `/config` paths
- [x] **autoFillCustomDropdowns**: New method — auto-fills Appy Pie's `.menu_icon-box` dropdowns (Spreadsheet, Worksheet, etc.) on options pages. Clicks icon → waits for AJAX → selects first option
- [x] **Picker detection expanded**: Added `tokenlist`, `variablelist`, `field-mapping-list` and 3 more class patterns
- [x] **Dropdown AJAX retry**: `openAndSelectDropdown` now retries 3x with 1.5s gaps for slow API responses
- [x] **Disabled button check**: Fixed `hasAttribute('disabled')` vs `getAttribute('disabled') !== null`
- [x] **OAuth trap removal**: Conditional — only removes "Add an Account" when Continue exists (account linked). Keeps it when account genuinely needs linking

### Action Engine Fixes (`action-engine.ts`)
- [x] **`select value="first"` handling**: Treated as "pick first available option" — routes to `openAndSelectDropdown(label, "")` instead of literally searching for text "first"
- [x] **Settle delay increased**: Click/select actions now wait 800ms (was 150ms) for AJAX state changes before checking `effective`

### CUA Loop Fixes (`cua-loop.ts`)
- [x] **Auto-login awareness**: Prompt includes `NOTE: Login was completed automatically` when adapter flag is set
- [x] **System prompt rules 12-14**: Updated for account linking (click "Add an Account" when Continue absent), connect workflow guidance, and dropdown AJAX handling

### Test YAML Fixes
- [x] **Google Sheets-Gmail connect test**: Updated account steps (4 and 8) to handle both linked and unlinked states instead of hard-failing

### Logging Fixes (`server.ts`)
- [x] **Suppressed 304 poll noise**: Dashboard polling (304 Not Modified) now silent in pino-http
- [x] **Stripped headers from logs**: Only logs method, url, statusCode — no more full request/response headers
- [x] **Skipped asset logging**: Screenshot and video serving requests excluded

---

## Remaining (Future Work)

### Phase 2: Split Dashboard page.tsx
- [ ] Extract `<DashboardHeader />`, `<OverviewTab />`, `<ResultsTab />`, `<FailuresTab />`
- [ ] Extract `<LogsPanel />`, `<TestManagerTab />`, `<SettingsTab />`, `<TestModal />`
- [ ] Extract utility functions to `lib/badges.ts`
- [ ] Move remaining inline `fetch()` calls to use `api.ts`

### Phase 4: Extract Domain Logic from Adapter
- [ ] Create `appypie-guards.ts` with Appy Pie specific selectors/auto-click/cleanup
- [ ] Make `playwright-adapter.ts` accept guard hooks (generic)

### Phase 5: Deduplicate CUA Loops
- [ ] Extract `cua-loop-core.ts` with shared stuck detection, token tracking, verification
- [ ] Refactor both `cua-loop.ts` and `cua-loop-vision.ts` to use core

### Additional
- [ ] Add more tests: dom-extractor, API integration tests with supertest
- [ ] Extend pino logging to route files and CUA loop
- [ ] Add request correlation IDs

---

## Skills & Patterns Applied

| Skill | Source | Applied In |
|-------|--------|-----------|
| Monorepo shared types (raw TS export) | [DEV Community](https://dev.to/lico/step-by-step-guide-sharing-types-and-values-between-react-esm-and-nestjs-cjs-in-a-pnpm-monorepo-2o2j) | `packages/shared/` with `workspace:*` |
| Express Router modular organization | [BrowserStack Guide](https://www.browserstack.com/guide/express-routes) | `src/routes/*.ts` + `src/middleware/*.ts` |
| Vitest monorepo setup | [Vitest Docs](https://vitest.dev/guide/projects) | `vitest.config.ts` at root |
| Pino structured logging | [Better Stack Guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) | `src/logger.ts` + `pino-http` middleware |
| Type-safe API client pattern | [Martin Fowler](https://martinfowler.com/articles/modularizing-react-apps.html) | `lib/api.ts` with `request<T>()` generic |
| GitHub Actions CI for monorepos | [Turborepo Docs](https://turborepo.dev/docs/guides/tools/vitest) | `.github/workflows/ci.yml` |
