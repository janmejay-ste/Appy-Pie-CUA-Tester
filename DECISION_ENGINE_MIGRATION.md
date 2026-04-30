# DecisionEngine Migration — Handoff Notes

Status as of this commit. Intended audience: the next coder (codex) picking up the refactor.

**TL;DR for codex**: Everything from PR 1 through PR 7b is landed. The one big remaining structural change is **PR 5b — pull the GPT call into `DecisionEngine`**. Concrete extraction plan is in the "PR 5b — step-by-step" section below.

---

## What's already done

### ✅ PR 2 — First-class `signals` on `ActionExecutionResult`
File: `packages/runner/src/adapter/action-engine.ts`
- `ActionSignals = { urlChanged, domChanged, valueChanged }` is the source of truth.
- `ValidationDetails = { errorAppeared, errorMessage?, elementStillExists, intentMatch }` for non-signal observations.
- `deriveValidation(signals, details)` → frozen merged object, assigned to `validation` for backward compat only.

### ✅ PR 1 — Structured `ActionStep.target`
File: `packages/runner/src/adapter/target.ts` (new).
- `ActionTarget = { elementId?, text?, domPath?, index? }`, `ActionTargetLike = ActionTarget | string`.
- `coerceLegacyTarget()` normalizes at the parser boundary in `cua-loop.ts parseModelResponse`.
- Helpers: `targetToDisplay`, `targetElementId`, `resolveTargetElement`, `targetsEqual`.
- System prompt in `cua-loop.ts` documents both shapes; LLM may emit either string or object.

### ✅ PR 3 — Cache thresholds + `failureCount`
File: `packages/runner/src/action-cache.ts`
- `MIN_SUCCESS_TO_USE_SINGLE = 3` (was 1).
- `MAX_FAILURES_BEFORE_DELETE = 2` (new).
- `CachedSingleAction.failureCount` field (additive, auto-backfilled on load).
- `recordFailedAction` increments → deletes at cap (replaces `successCount -= 2` heuristic).
- `recordSuccessfulAction` resets `failureCount = 0` on streak.

### ✅ PR 4 — `DecisionEngine` skeleton
File: `packages/runner/src/decision-engine.ts` (new).
- `Perception`, `CacheDecision`, `NeedsGPTDecision`, `Decision` types.
- `DecisionEngine.decide(perception): Decision` — **single entry point** for every turn.
  - Returns CacheDecision if batch queue / sequence cache / single cache resolves.
  - Returns `{ action: null, source: 'gpt-needed', reason }` otherwise.
- `decideFromCache(p)` exposed for tests.

### ✅ PR 6 — Derive `validation` from signals
- `validation` is now `Object.freeze(...)` merged from `signals + details` via `deriveValidation()`.
- Any attempt to mutate the legacy field now throws in dev — ghost bugs surface immediately.

### ✅ PR 7 — Cache observability
File: `packages/runner/src/action-cache.ts`
- `getCacheHealth()` → `{ total, usable, rejectedLowSuccess, rejectedTooManyFailures, rejectedStale, sequences, lifetimeHits }`. Called on loop start.
- Per-run counters: `resetRunCacheCounters()`, `getRunCacheCounters()`, `incrementCacheHit()`, `incrementCacheReject()`, `incrementCacheRecord()`.
- `getCachedAction` / `recordSuccessfulAction` / `recordFailedAction` update counters.
- cua-loop.ts emits stats on start AND on (at least) the TIMEOUT exit path.

### ✅ PR 5 (scoped) — Unified `decide()` entry point
- `DecisionEngine.decide()` is the public API. `decideFromCache` is internal.
- GPT call + prompt building still live in `cua-loop.ts`. When `decide()` returns `source: 'gpt-needed'`, loop runs its existing GPT path.
- **This is intentional partial migration.** See next section.

### ✅ PR 5c — Constraint-aware GPT prompt
- `DecisionConstraints = { avoidTargets, avoidActionTargets, avoidUrlPaths, goal }` on `Perception`.
- `buildConstraints()` derives them from recent history + stuckContext + visited URLs.
- `formatConstraintsForPrompt()` emits a compact `CONSTRAINTS:` block that goes into every GPT prompt.
- The model now sees explicit "AVOID (already tried, no effect): click a1b2c3 | type 5d6e7f" instead of having to infer from action history.

### ✅ History upgrade — structured entries
- `HistoryEntry` now has `step: ActionStep`, `signals: { urlChanged, domChanged, valueChanged }`, `source: 'cache-single' | 'cache-sequence' | 'batch-queue' | 'gpt'`, and `mode` alongside the legacy flat fields.
- Legacy fields preserved so existing readers (prompt builder, runlog) keep working unchanged.
- Picker & learning layer in PR 8 can now consume a clean, typed history without another migration.

### ✅ PR 7b — Adaptive cache (graded + per-page)
- `maybeDisableCacheForRun()` runs at loop start, sets the global tier (`full` / `cautious` / `strict` / `disabled`) based on aggregate health.
- **Per-page tier** (PR D): `tierForPage(pageKey, url)` lazy-computes a tier per page from peer entries that share the same urlPattern. Pages with healthy local cache stay `full` even when global health is `strict` — eliminates cross-page contamination.
- Effective `successCount` floor scales by tier (`MIN + 0/2/5/∞`).
- `getCachedSequence` requires per-page tier `full` (sequences are higher risk).
- Observation + action: metrics aren't just logged, they now *change behavior*.

### ✅ Constraint hardening (B/E/A/F)

**B — Probation re-enable** ([constraint-metrics.ts](packages/runner/src/constraint-metrics.ts))
- Three-state machine: `active` → `disabled` → `probation` → `active|disabled`
- Cooldown: 3 days after disable, the constraint enters `probation`
- During probation: 5 trial uses tracked separately (`probationUses`, `probationProgressed`)
- After trials: ≥40% progress rate → re-activate; otherwise re-disable + reset cooldown
- Prevents permanent dead zones when UI conditions change

**E — Diversity-aware cap** ([decision-engine.ts](packages/runner/src/decision-engine.ts) `capByCategory`)
- Two-pass: first guarantee `MIN_PER_TYPE = 2` from each constraint type, then fill remaining global slots by priority
- Total cap `MAX_GLOBAL = 12`
- Prevents one category (e.g., dropdown failures) from crowding out others

**A — Bucket baseline attribution** ([constraint-metrics.ts](packages/runner/src/constraint-metrics.ts))
- Buckets formed by `bucketIdForConstraints(ids)` = `b{hash % 16}`
- `recordBucketOutcome(ids, progressed)` once per turn (NOT per constraint)
- `getConstraintLift(id)` returns relative lift = own progress rate − bucket baseline
- `autoDisableBadConstraints` now requires BOTH stallRate > 70% AND non-positive lift before disabling — prevents demoting constraints that look bad in absolute terms but outperform their co-emission peers
- v1→v2 metrics file migration handled in `load()`

**F — Composite system health** ([system-health.ts](packages/runner/src/system-health.ts) — new)
- Single per-run number: `0.4 * progressRate + 0.3 * cacheHitRate + 0.3 * constraintEffectiveness`
- Logged at run end: `[cua] Health: 0.72 (progress=60% cache=80% constraints=70%)`
- Single trajectory line for degradation detection across runs

---

## What's NOT done (for codex to pick up)

### 🟡 PR 5b — Finish DecisionEngine: own the GPT call (PARTIAL — scoped landing complete)

**Scoped step landed:** `decide()` is now `async` and accepts an optional `DecideDeps` containing a `callGPT` callback. When deps are provided, `decide()` orchestrates the retry loop inside the engine and returns `GPTDecision` with `action`, `queuedBatch`, `tokens`, and `meta`. When deps are NOT provided (current caller), it returns the legacy `NeedsGPTDecision` so nothing breaks.

The engine now OWNS: cache lookup, batch queue, GPT retry loop, token aggregation across retries.
The loop still owns: prompt building, the OpenAI SDK call, SSE callback emission.

**Next step for codex — wire the loop's GPT block into `deps.callGPT`:**

1. Extract the ~200 lines of prompt-part assembly in `cua-loop.ts` (after `if (!action) {`) into a closure. This closure captures the per-turn state the prompt needs: `credentials`, `autoLoginFired`, `actionHistory`, `visitedUrlPaths`, `state`, `cacheLoopWarning`, the DOM extractor output, the vision image (when mode != DOM_NORMAL), etc.

2. Pass the closure as `deps.callGPT`:
   ```ts
   const decision = await engine.decide(perception, {
     callGPT: async ({ perception, attempt, previousResponseText }) => {
       const { instructions, content } = buildPrompt(perception, attempt, previousResponseText);
       const apiStart = Date.now();
       const resp = await openai.responses.create({
         model: MODEL, instructions, input: content,
         tools: [{ type: 'computer' as any }],
         reasoning: { effort: 'low' as any },
         previous_response_id: previousResponseId,
       }, { signal: abortSignal } as any);
       const responseText = extractResponseText(resp);
       const parsed = parseModelResponse(responseText);
       return {
         responseText,
         parsed: parsed ? { actions: parsed.actions, meta: parsed.meta as any } : null,
         tokens: {
           input: resp.usage?.input_tokens ?? 0,
           output: resp.usage?.output_tokens ?? 0,
           reasoning: resp.usage?.output_tokens_details?.reasoning_tokens ?? 0,
           latencyMs: Date.now() - apiStart,
         },
       };
     },
   });
   ```

3. Handle the returned `GPTDecision`:
   ```ts
   if (decision.source === 'gpt') {
     action = decision.action;
     totalTokens.input += decision.tokens.input;
     totalTokens.output += decision.tokens.output;
     totalTokens.reasoning += decision.tokens.reasoning;
     callbacks.onTurnComplete(turn, decision.tokens.latencyMs, { ...totalTokens });
     callbacks.onTurnTokens({
       turn, input: decision.tokens.input, ...,  // per-turn breakdown
     });
     pendingBatchActions = decision.queuedBatch;
     // Meta fields (memory, next_goal, ...) read from decision.meta
   }
   ```

4. Delete the legacy inline retry loop. All retries now happen inside `engine.decide()`.

**Step-by-step staging (safe revert at each step):**

- **Stage 1 (done):** async `decide()` + typed `GPTDecision`. No caller changes.
- **Stage 2 (next):** Loop wires `deps.callGPT` but keeps legacy `if (!action)` as a guard branch. Verify parity on one real run before removing the guard.
- **Stage 3:** Remove the legacy `if (!action)` block. Loop is now fully engine-driven.
- **Stage 4 (optional):** Extract prompt building into a pure function + unit test it.

Estimated effort for Stages 2–4: **6–8 h** — down from the original 10h because Stage 1 is already done.

### 🔴 PR 5b original context (for reference)

**Goal:** The loop calls `engine.decide(perception)` and receives an executable action, regardless of whether it came from cache or GPT. The loop NEVER calls OpenAI directly.

**Current state after this batch:** Stage 1 landed. `decide()` is async and can orchestrate GPT when wired. Loop still runs its own GPT block (`cua-loop.ts` `if (!action) { ... }` starting at the line after batch-fast-path, approximately line 630 in the current commit). That block contains all prompt building, the OpenAI call, JSON parse retries, and token bookkeeping.

#### Step-by-step extraction plan

**Step 1 — Turn the synchronous `decide()` into async**
File: `packages/runner/src/decision-engine.ts`
```ts
async decide(p: Perception, deps: DecideDeps): Promise<Decision> { ... }
```
Where `DecideDeps` is:
```ts
export interface DecideDeps {
  /** Called when cache misses. Returns the model's parsed response + token usage. */
  callGPT: (ctx: GPTCallContext) => Promise<GPTCallResult>;
}
export interface GPTCallContext {
  perception: Perception;
  attempt: number;         // 0 = first, 1..N = retries on JSON parse failure
  previousResponseText?: string;  // feedback for retries
}
export interface GPTCallResult {
  parsed: ParsedResponse | null;   // reuse the shape already in cua-loop.ts
  responseText: string;
  tokens: { input: number; output: number; reasoning: number; latencyMs: number };
}
```
Why this shape: `callGPT` is injected by the loop. The loop keeps ownership of prompt building (it needs credentials, allowed domains, stuckContext — all per-turn state) and the actual `openai.responses.create()` call. The engine orchestrates retries and packages the final decision.

**Step 2 — Move retry logic into `decide()`**
Current retry lives in `cua-loop.ts` as the two `parseModelJSON(extractResponseText(retryResp))` attempts. Move the loop:
```ts
async decide(p, deps) {
  const cache = this.decideFromCache(p);
  if (cache) return cache;

  for (let attempt = 0; attempt < MAX_GPT_ATTEMPTS; attempt++) {
    const { parsed, responseText, tokens } = await deps.callGPT({ perception: p, attempt });
    if (parsed) {
      const action = parsed.actions[0];
      return { action, source: 'gpt', confidence: action.confidence ?? 0.9, tokens, parsed };
    }
    // log parse failure, loop retries
  }
  throw new Error('GPT returned invalid JSON after 3 attempts');
}
```

**Step 3 — Extend `Decision` union**
```ts
export interface GPTDecision {
  action: ActionStep;
  source: 'gpt';
  confidence: number;
  parsed: ParsedResponse;   // full response for batch queue extraction
  tokens: { input: number; output: number; reasoning: number; latencyMs: number };
}
export type Decision = CacheDecision | GPTDecision | NeedsGPTDecision;
```
Keep `NeedsGPTDecision` as the return when `deps.callGPT` isn't provided (backward compat during migration). Once all loop call sites migrate, delete `NeedsGPTDecision`.

**Step 4 — Collapse the loop's GPT block**
In `cua-loop.ts`, replace the entire `if (!action) { ... }` block (from `lastTurnWasGPT = true` through the final `action = parseModelJSON(...)`) with:
```ts
const decision = await engine.decide(perception, {
  callGPT: async ({ perception, attempt }) => {
    const { content, instructions } = buildPrompt(perception, attempt);
    const apiStart = Date.now();
    const resp = await openai.responses.create({ model, instructions, input: content, ... });
    const responseText = extractResponseText(resp);
    const parsed = parseModelResponse(responseText);
    return {
      parsed,
      responseText,
      tokens: {
        input: resp.usage?.input_tokens ?? 0,
        output: resp.usage?.output_tokens ?? 0,
        reasoning: resp.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        latencyMs: Date.now() - apiStart,
      },
    };
  },
});
if (decision.source === 'gpt') {
  action = decision.action;
  totalTokens.input += decision.tokens.input;
  totalTokens.output += decision.tokens.output;
  totalTokens.reasoning += decision.tokens.reasoning;
  callbacks.onTurnTokens({ ... });
  pendingBatchActions = decision.parsed.actions.slice(1);
} else if (decision.source.startsWith('cache')) {
  action = decision.action;
} else if (decision.source === 'batch-queue') {
  action = decision.action;
}
```

**Step 5 — Factor prompt building into a pure function**
Extract the 200 lines of `promptParts.push(...)` (currently inline after "// ── Build prompt //") into:
```ts
function buildPrompt(p: Perception, attempt: number): { instructions: string; content: any[] } { ... }
```
This function is pure — given a Perception, returns the same prompt. That makes it unit-testable for the first time.

**Step 6 — Callbacks stay loop-side**
Do NOT move `callbacks.onTurnStart` / `onTurnComplete` / `onTurnTokens` / `onScreenshot` into the engine. Engine returns tokens as data; loop emits SSE. Clean separation.

**Step 7 — Retry count**
Current code hardcodes 2 retries. Parameterize via `DecideDeps.maxAttempts ?? 3`.

#### Estimated effort
- Step 1 + 2 + 3: **2 h** (type scaffolding)
- Step 4 + 6: **3 h** (careful call-site replacement, SSE preservation)
- Step 5: **3 h** (the fiddly one — the prompt touches ~20 per-turn state variables)
- Step 7 + testing: **2 h**
- **Total: 10 h**, landing in one PR. Can be revertible if you keep the old `if (!action) { ... }` block behind a feature flag for one release cycle.

#### Test strategy
- Mock `deps.callGPT` to return hand-crafted responses. Unit-test `decide()` covers:
  - Cache hit → returns CacheDecision, callGPT never invoked.
  - Single GPT attempt → returns GPTDecision.
  - Parse failure then success → retry counter increments, returns GPTDecision.
  - 3 parse failures → throws.
- Integration: one real run per test category (homepage / connect) before merge. Check that screenshot count, turn count, token totals match the previous commit within ±5%.

### 🔴 PR 8 — Multi-candidate + minimal ranking

Only after PR 5b. The order matters — without a unified `decide()`, multi-candidate scoring has two places to live.

**Implementation:**
1. Prompt change: ask for `{"actions": [candidate1, candidate2]}` top-level (when `mode === 'DOM_NORMAL'` — keep vision-burst single-candidate).
2. Parser returns all candidates.
3. Simple picker (no ML):
   ```ts
   function pickCandidate(candidates: ActionStep[], history: TurnHistory[]): ActionStep {
     const last5 = history.slice(-5);
     const nonRepeating = candidates.filter(c =>
       !last5.some(h => targetsEqual(h.action.target, c.target) && h.action.action === c.action)
     );
     return nonRepeating[0] ?? candidates[0];
   }
   ```
4. Telemetry: track which candidate index was picked, candidate count. Include in run-log service.

**Cost awareness:** 2× output tokens per GPT turn. If avg turn is 400 output tokens and a run has 40 turns, that's ~16k extra tokens per run. At $15/M output for GPT-5.4 that's ~$0.24/run. Acceptable IF we can show it reduces failure rate by >20% (fewer retry turns). **Measure first.**

### ✅ TurnHistory quality — now landed (enabler for PR 8)

`HistoryEntry` in `cua-loop.ts` now has:
```ts
{
  turn,
  action, target, value?, effective, description,   // legacy flat fields
  step: ActionStep,                                  // structured action
  signals: { urlChanged, domChanged, valueChanged }, // first-class signals
  source: 'cache-single' | 'cache-sequence' | 'batch-queue' | 'gpt',
  mode,
}
```
Picker and learning layer can consume this directly.

### 🟡 C — Adaptive severity weights (DEFERRED with rationale)

**The proposal:** Let constraint severity (`strong` / `medium` / `weak`) be learned from observed effectiveness rather than hard-coded as `failure→strong`, `no_effect→medium`, `visited→weak`.

**Why I did NOT implement this:**

1. **Feedback loop risk.** A constraint that starts `strong` but gets downweighted to `weak` emits weaker signals → GPT pays less attention → action repeats fail more often → metric looks even worse → further downweight. Self-reinforcing decay.

2. **Insufficient data.** Conservative thresholds (10 uses min, 5 respected min) mean per-constraint data accumulates slowly. ~5–10 turns per constraint per run; need 50+ runs for meaningful adjustment.

3. **Bucket baseline first.** PR A added `getConstraintLift()`. That's the right substrate to build adaptive severity on top of — not raw stall rate. Wait until lift data accumulates.

**When to revisit:** After 50+ runs with stable schemas. Check via `getBucketMetrics().filter(b => b.uses >= 5).length`. Once that's ≥8, the math becomes meaningful:

```ts
function adaptiveSeverityWeight(c: ConstraintRecord): number {
  const lift = getConstraintLift(c.id, { globalProgressRate: currentHealth.progressRate });
  if (lift === null) return BASE_WEIGHT[c.severity];
  return clamp(BASE_WEIGHT[c.severity] + lift * 0.3, 0.1, 1.0);
}
```

**Hard rules for codex (ALL must hold before adaptive weights land):**

1. `getBucketMetrics().filter(b => b.uses >= 5).length >= 8` — meaningful sample count.
2. `globalProgressRate` is passed through (not null). Lift without global context hides "good in a bad system" illusions. **Use `getSmoothedGlobalProgressRate()` — never raw single-run progress.**
3. **Variance guardrail**: compute the standard deviation of `getConstraintLift()` across all constraints with `respected >= 5`. If `stdev > 0.25`, DO NOT adapt — the signal is too noisy to act on.
4. **Mean-near-zero guardrail**: if `|mean(lifts)| < 0.05`, DO NOT adapt — low variance alone isn't evidence of usefulness; the distribution may be uniformly useless. Require the mean to show non-trivial magnitude in either direction.

```ts
// Pseudocode for the combined variance + mean guard.
// Thresholds are ADAPTIVE — stricter when the system is stable, more tolerant
// when the system is genuinely noisy. Prevents a stable-system threshold
// blocking legitimate adaptation in a noisy environment (and vice versa).
function canAdaptWeights(): boolean {
  const smoothedGlobal = getSmoothedGlobalProgressRate();
  const noiseLevel = 1 - smoothedGlobal;          // 0..1 — higher = noisier system
  const stdevThreshold = 0.25 * (1 + noiseLevel); // 0.25 (clean) → 0.50 (fully noisy)
  const meanThreshold  = 0.05 * (1 - noiseLevel); // 0.05 (clean) → 0.00 (noisy: any signal OK)

  const lifts = getConstraintMetrics()
    .filter(c => c.respected >= 5)
    .map(c => getConstraintLift(c.id, { globalProgressRate: smoothedGlobal }))
    .filter((x): x is number => x !== null);
  if (lifts.length < 8) return false;
  const mean = lifts.reduce((s, x) => s + x, 0) / lifts.length;
  const variance = lifts.reduce((s, x) => s + (x - mean) ** 2, 0) / lifts.length;
  const stdev = Math.sqrt(variance);
  if (stdev > stdevThreshold) return false;       // too noisy even for this regime
  if (Math.abs(mean) < meanThreshold) return false; // no directional signal
  return true;
}
```

Below either floor, adapting weights introduces oscillation or adapts to noise. The adaptive thresholds ensure the gate matches the system's current stability — not an arbitrary fixed cutoff.

### 🟡 E — Constraint interaction awareness / pair tracking (DEFERRED)

**The proposal:** Track constraint co-occurrence pairs to detect negative interactions — two constraints that individually look fine but together produce stalls.

**Why I did NOT implement this:**

1. **Combinatorial sparsity.** With N active constraints, N² pairs exist. At current run volumes (~10–20 runs/day), pair-level samples accumulate at 1/N the rate of single-constraint samples. A single constraint takes ~50 runs to produce actionable data; a pair takes ~50×N runs. We're not there.

2. **Premature subsystem.** Pair statistics require their own storage, eviction, and staleness handling. Adding that before the single-constraint metrics are validated multiplies the surface area without a proportionate benefit.

3. **Covered by single-constraint adaptivity.** A "conflicting pair" where both constraints individually look positive but collapse in combination is already partially captured by `getConstraintLift()` against the bucket baseline — buckets ARE defined by co-occurrence sets.

**When to revisit:** After 200+ runs with stable schemas AND the adaptive-severity feature (C) is in production. Check via `getBucketMetrics().filter(b => b.uses >= 20).length`. Once that's ≥30, per-pair data becomes tractable.

**Hard rule for codex:** Do NOT implement pair tracking until `getBucketMetrics().filter(b => b.uses >= 20).length >= 30` AND adaptive severity (C) has shipped and stabilized for ≥20 runs. Below that you're modeling noise.

### ✅ Interaction Abstraction Layer (IAL) landed

**The problem:** cua-loop.ts had ~12 scattered post-hoc fixup blocks that detected "Continue & Run Test", "+ Add or Select", event checkboxes, custom dropdowns AFTER a generic action wasted a turn. The recent Email Body picker failure is exactly this class — model emitted `click "+ Add or Select"`, generic click did nothing, no fixup matched in time.

**The fix:** Proactive classification in [packages/runner/src/interaction/](packages/runner/src/interaction/) — three new files:

- `types.ts` — `InteractionType` enum (`CONTINUE_RUN_TEST`, `VARIABLE_PICKER`, `CUSTOM_DROPDOWN`, `CHECKBOX_EVENT`, `AUTO_FILL_FIELDS`, `PANEL_TEXT_FALLBACK`, generic primitives). `InteractionPlan` carries type + target + value + hints + reason.
- `classifier.ts` — `classifyInteraction({ step, state, resolvedElement, url })` → `InteractionPlan`. Pure function, unit-testable. Decision priority: action-type fast paths → click specializations → type specializations → generic.
- `executor.ts` — `executeInteraction(plan, adapter)` → `{ handled, result, handlerName }`. Dispatch-only. Returns `handled: false` for generic primitives, letting the engine's strategy chain take over.

**Wired into `action-engine.ts`:** classifier + executor run BEFORE the strategy chain. If a specialized handler runs successfully, the strategy chain is skipped. Logged as `[ial] VARIABLE_PICKER via insertVariableToken — click on + Add or Select token picker`.

**For the Email Body failure:** model emits `click value="+ Add or Select"` → `classifyInteraction` returns `{ type: 'VARIABLE_PICKER', hints: { fieldLabel: ... } }` → `executeInteraction` calls `adapter.insertVariableToken(label, value)` → picker opens, first item selected. No more wasted-turn cycle.

### ✅ `waitUntil(predicate, timeout)` adapter helper landed

[adapter/types.ts](packages/runner/src/adapter/types.ts) + [adapter/playwright-adapter.ts](packages/runner/src/adapter/playwright-adapter.ts):

```ts
await adapter.waitUntil('document.querySelectorAll("input").length > 0');
await adapter.waitUntil('!document.querySelector(".loader")', { timeoutMs: 8000 });
```

Returns `effective: false` when the predicate was already true (no actual wait happened). Replaces `wait(3000)` blind sleeps with deterministic "wait for X to be true". Codex can swap the loop's existing blind waits to this helper as a follow-up.

### 🔴 Step 3 — Interaction Memory Persistence Layer (IMPL) — DEFERRED

**The proposal:** Memoize IAL classifications. After IAL runs, store `(pageKey, targetSignature) → { interactionType, success/failure }`. Next time the same target appears on the same page, skip classification — go straight to the proven handler.

**Why DEFERRED for now:**
1. **IAL needs validation first.** We just built classifier + executor; no production runs have proved the classifier picks the right type ≥90% of the time. Memoizing wrong classifications would entrench mistakes.
2. **Action cache already exists.** `data/cache/action-cache-v2.json` already memoizes successful actions per page. Adding a second memory layer would create attribution ambiguity (which one decided?).

**When to revisit:** After 10+ runs with IAL in production AND classification accuracy is observed ≥90% (track via a `[ial]` log frequency analyzer). Then implement:

```ts
// packages/runner/src/interaction/memory.ts
interface InteractionMemoryEntry {
  pageKey: string;
  targetSignature: string;     // e.g. "click:+ Add or Select" or "type:Subject"
  interactionType: InteractionType;
  successCount: number;
  failureCount: number;
  lastUsed: number;
}

export function findPattern(pageKey: string, sig: string): InteractionMemoryEntry | null;
export function recordInteraction(pageKey: string, sig: string, type: InteractionType, succeeded: boolean): void;
```

Wire into `classifyInteraction`: check memory first → if `success >= 2 && failure < success` use memoized type → otherwise classify normally. Persist to `data/cache/interaction-memory.json` with the same v1 schema versioning we use for constraint-metrics.json.

**Hard rule for codex:** Do NOT implement IMPL until classifier accuracy is observed ≥90% on at least 10 runs. Below that you're memoizing noise.

### 🔴 Step 4 — Multi-candidate scorer — DEFERRED (same reasoning as before)

Already detailed in the PR 8 section above. The bucket-baseline + lift metrics in `data/cache/constraint-metrics.json` are still accumulating; need ≥10 more runs with IAL active to set a baseline failure rate before justifying the 2× output token cost of multi-candidate.

### ✅ Hard-verification layer landed

**The problem:** Until now, `verdict: PASS` came from the LLM alone. The model could hallucinate success — claiming the page reached a state it actually didn't.

**The fix:** Optional declarative `validation:` rules per test, checked against actual `BrowserState` after the model emits `done`. Final verdict = model PASS **AND** validator PASS.

**New file:** [packages/runner/src/validation/validator.ts](packages/runner/src/validation/validator.ts)
- `ValidationRule = { type: 'url' | 'text' | 'element' | 'not_text', value, label? }`
- `validateState(state, rules)` → `{ passed, score, checks[] }`
- `inferValidationRules(expectedOutcome, finalUrl)` — auto-generates 1–2 rules when test has none, parsing phrases like "should see Welcome" or URL hints from the expected outcome
- Soft matching (case-insensitive `includes`); searches both `state.elements[].text` AND `state.keyText[]`

**Wired into cua-loop:**
- New `validationRules` param threaded through `runCUALoop` → `runCUALoopDOM`
- After model emits `done`: re-fetch state if `elements.length < 5` (partial UI load → wait 2s, retry once), then `validateState`
- If model says PASS but validation fails → override to FAIL with `[validation] OVERRIDE` warning
- `CUALoopResult` now includes `modelVerdict` (raw) + `systemValidation` (rule-by-rule breakdown)
- Model message expanded to include `MODEL VERDICT: …` and `SYSTEM VALIDATION: PASS/FAIL (NN%)` lines

**Plumbing:**
- `TestDefinition.validation?` added to both shared types and runner local types
- YAML loader picks up the `validation:` block (silently drops malformed entries)
- `TestJobData.validation` carries rules through Redis to the worker
- Worker passes them to `runCUALoop`
- Single + suite enqueue paths both forward rules

**YAML usage example** (add to any test):
```yaml
validation:
  - type: url
    value: /connects
    label: "Reached Connect dashboard"
  - type: text
    value: "Create Connect"
  - type: text
    value: "My Connects"
  - type: not_text
    value: "Sign in"        # Should NOT see login form
```

**For tests without rules:** `inferValidationRules` produces 1–2 weak signals from `expected_outcome`. If even those can't be inferred (empty outcome), system falls back to model verdict (current behavior preserved).

### 🔴 Dashboard UI for systemValidation (DEFERRED)

Backend now writes the validation breakdown into the `model_verdict` text column with structured headers (`SYSTEM VALIDATION:` line). Dashboard can:
- Quick win: surface the new lines from `model_verdict` text in the run-detail panel.
- Proper fix: add a `system_validation` JSON column to `test_runs`, write `result.systemValidation` into it from worker.ts, and render a per-rule check table in [packages/dashboard/src/app/runs/[runId]/page.tsx](packages/dashboard/src/app/runs/%5BrunId%5D/page.tsx).

Estimated effort for the proper fix: **2–3 h**. Schema additive (new nullable JSON column), no migration risk.

### ✅ Fourth-round invariant locks (A–D, all landed)

These address *scale + distribution shift*:

- **A — EMA shock detection** — `|observed − smoothed| > 0.3` snaps baseline to observed instead of smoothing. Regime change (sudden UI break, backend outage) no longer trails reality by 5+ runs.
- **B — CTA-hash cache discriminator** — `primaryCTAHash` (hash of top-2 button texts) added to `PageKeyState`. Prevents the "step 1 (20 elements)" vs "step 3 (28 elements)" collision where bucket rounding collapsed distinct states.
- **C — DOM similarity preserves SPA constraints** — when URL changes but `overlap(prevTopTexts, currentTopTexts) >= 0.7`, `lastUrlChangeTurn` is NOT bumped. Constraints from before the URL change survive because the UI context survived.
- **D — Self-correcting stagnation** — early-stagnation signal now BYPASSES cache for `STAGNATION_RECOVERY_TURNS = 2` turns, giving GPT fresh control. System acts on the signal, not just logs it.

### ✅ Third-round statistical-invariant fixes (A–D, all landed)

These address *signal integrity under scale*:

- **A — EMA-smoothed global progress baseline** — `getSmoothedGlobalProgressRate()` in [system-health.ts](packages/runner/src/system-health.ts), persisted to `data/cache/health-baseline.json`. α=0.7, ~3-run half-life. Single-run jitter no longer flips constraint lifecycle decisions.
- **B — Coarser cache bucket + transient-overlay filter** — element-count bucket now `round(count/10)*10` (was /5). Overlays are only treated as state-changing after `OVERLAY_PERSISTENCE_THRESHOLD = 2` consecutive turns. `resetOverlayStreak()` called at loop start. Avoids cache fragmentation from render blips.
- **C — Context validity filter** — `buildConstraints({ ..., lastUrlChangeTurn })` drops constraints whose `turn < lastUrlChangeTurn` (except `avoid_url` which is inherently cross-page). Prevents stale cross-page constraints from polluting current-page decisions.
- **D — Early stagnation warning** — the loop fires `[cua] EARLY STAGNATION` once per run the first time 3 consecutive no-progress turns occur. Predictive, not reactive. Includes the last 3 attempted actions for quick triage.

### ✅ Second-round entropy fixes (P1–P5, all landed)

These address *statistical stability* rather than first-order bugs:

- **P1 Normalize bucket lift against global progress** — `getConstraintLift(id, { globalProgressRate })` multiplies raw lift by `min(1, baseline/globalRate)`. Prevents "good in a failing system" false positives. Called at end-of-run via `autoDisableBadConstraints({ globalProgressRate: health.progressRate })`.
- **P2 Confidence-weighted probation** — `effectiveScore = progressRate × (trials / (trials + 5))`. Probation reactivation now requires sustained signal, not a lucky 3-of-5 streak.
- **P3 State-aware cache key** — `generatePageKey(url, title, { elementCount, hasOverlay })`. Same URL in different states (logged-in vs not, modal open vs not) produces different keys. Backward-compat: lookups fall back to the state-agnostic key for legacy entries.
- **P4 Health guardrails** — `systemHealth.composite` is penalized ×0.7 when `progressRate < 0.4` and ≥5 turns ran. Also emits `[cua] Health WARNING: progress ...` log. Stops cache/constraint wins from papering over a stuck system.
- **P5 Temporal diversity in constraint cap** — `capByCategory` now has three passes: type-coverage (min 2 per type), temporal-coverage (one each from recent ≤2 turns, mid ≤5 turns, older ≤10 turns), priority fill. Prevents overfitting to the last two turns.

### 🟡 PR 6b — Purge legacy `validation` reads

Files still reading `result.validation.*`:
- `packages/runner/src/services/runlog.service.ts` (reads from persisted DB rows, mostly safe to leave)
- Any dashboard code that consumes the persisted `validation` blob

Once all live code reads `signals`/`details`, the `validation` field can be dropped from `ValidatedResult` entirely. DB rows remain untouched (JSON column tolerates missing keys on read).

Estimated effort: 2–3 h (plus one release cycle for DB writers to migrate).

---

## Files touched in this batch

| File | Change |
|---|---|
| `packages/runner/src/adapter/action-engine.ts` | `signals`, `details`, `deriveValidation()`; legacy `validation` derived + frozen |
| `packages/runner/src/adapter/target.ts` (new) | `ActionTarget`, `coerceLegacyTarget`, display/resolve/equality helpers |
| `packages/runner/src/adapter/types.ts` | `ActionStep.target: ActionTargetLike`; `ActionTarget` exported |
| `packages/runner/src/cua-loop.ts` | ~25 call sites migrated; cache-skip counters; system prompt doc |
| `packages/runner/src/action-cache.ts` | `failureCount`, thresholds, health snapshot, per-run counters |
| `packages/runner/src/decision-engine.ts` (new) | `DecisionEngine.decide(perception)` — unified entry point |
| `packages/runner/src/services/runlog.service.ts` | Defensive target rendering for legacy object-shape rows |

---

## Risk map

| Risk | Severity | Mitigation |
|---|---|---|
| Legacy object-shape targets in old DB rows | Low | `runlog.service.ts` renders defensively; read paths use `coerceLegacyTarget` |
| Cache threshold bump (1 → 3) drops hit rate short-term | Medium | PR 7 observability will quantify the impact within 1–2 runs |
| `DecisionEngine.decide()` vs inline GPT path split | Medium | Flagged in "PR 5b". Loop still works correctly — split is a code-ergonomics issue, not a behavior one |
| Multi-candidate 2× token cost | High (if PR 8 lands without measurement) | DO NOT ship PR 8 without baseline failure-rate telemetry |

---

## How to verify the next run

Look for these log lines on loop start:
```
[cua] Action cache: N singles (U usable, L lowSuccess, F tooManyFailures, S stale), M sequences, T lifetime hits
```

And on loop end (TIMEOUT path at least):
```
[cua] Run cache stats: X singleHits, Y sequenceHits, rejects={...}, recorded={ success:A, failure:B }
```

If `usable` is low but `total` is high, the new stricter thresholds are filtering out entries that should be rebuilt organically. Give it 5–10 runs before deciding the thresholds need tuning.
