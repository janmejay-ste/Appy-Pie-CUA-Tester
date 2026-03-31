# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AI-powered QA testing platform for [Appy Pie Automate](https://www.appypieautomate.ai). Uses OpenAI GPT-5.4 to autonomously navigate and test web applications via Playwright. The AI reads the DOM (or screenshots as fallback), decides actions as JSON, executes them, and repeats until pass/fail/timeout.

## Commands

```bash
# Install dependencies
pnpm install

# Run both runner + dashboard concurrently
pnpm dev

# Run individually
pnpm --filter runner dev     # API + worker on :3001
pnpm --filter dashboard dev  # Next.js dashboard on :3002

# Build
pnpm build                   # builds both packages
```

There are no automated tests (unit/integration). The "tests/" directory contains YAML test definitions for the AI to execute, not code tests.

## Prerequisites

MongoDB on :27017, Redis/Memurai on :6379, FFmpeg in PATH, `OPENAI_API_KEY` in root `.env`.

## Architecture

**Monorepo** (pnpm workspaces) with two packages:

### `packages/runner` — Backend (Express + TypeScript ESM)
- **Entry**: `src/index.ts` — boots MongoDB, BullMQ worker, cleanup/metrics schedulers, Express server
- **`src/server.ts`** — Express API (~25 endpoints). Dashboard proxies all `/api/*` calls here via Next.js rewrites
- **`src/cua-loop.ts`** — Core DOM-first AI loop. Extracts DOM → sends structured text to GPT-5.4 → gets JSON action → executes via adapter. Falls back to vision mode when DOM is insufficient (<5 elements, stuck detection, low confidence)
- **`src/cua-loop-vision.ts`** — Vision mode loop (screenshot-based, higher token cost)
- **`src/adapter/`** — Abstraction layer between AI decisions and Playwright. All browser interaction goes through `ExecutionAdapter` interface (in `types.ts`). `action-engine.ts` has 4-layer fallback: elementId → text search → coordinates → panel search
- **`src/dom-extractor.ts`** — Extracts top-25 interactive elements from page DOM with stable hash-based IDs
- **`src/actions.ts`** — Legacy action execution (pre-adapter)
- **`src/queue/`** — BullMQ queue (`queue.ts`) and worker (`worker.ts`). Worker launches browser, runs CUA loop, generates replay video via FFmpeg
- **`src/db/models/`** — Mongoose models: TestDef, TestRun, Session, Step, Event, Settings, MetricSnapshot
- **`src/services/`** — Business logic: test CRUD, session management, cleanup (data retention), metrics aggregation
- **`src/validation/`** — Zod schemas for API input validation

### `packages/dashboard` — Frontend (Next.js 15, React 19, Tailwind v4)
- **`src/app/page.tsx`** — Main dashboard with 6 tabs (Overview, Results, Failures, Logs, Test Manager, Settings)
- **`src/app/runs/[runId]/page.tsx`** — Run detail: screenshot gallery, replay video, token breakdown, live SSE log
- **`src/lib/api.ts`** — API client functions
- **`src/lib/use-sse.ts`** — SSE hook for live event streaming

## Key Design Decisions

- **DOM-first, vision-fallback**: The AI receives structured DOM text (~2,500 tokens/turn) instead of screenshots (~15,000 tokens/turn). Vision mode activates automatically when the DOM approach gets stuck.
- **Stable element IDs**: DOM elements get 8-char hash IDs that survive re-extraction, so the AI can reference the same element across turns.
- **Adapter pattern**: `ExecutionAdapter` interface decouples AI actions from Playwright. The action engine tries multiple strategies (ID lookup → text match → coordinates → full-page search) before failing.
- **SSE for live updates**: Test execution progress streams to dashboard via Redis pub/sub → SSE.
- **All config in `.env` at repo root** — runner loads it via `tsx --env-file=../../.env`. Runtime config (test account, concurrency, token budgets) stored in MongoDB Settings collection, editable from dashboard.
