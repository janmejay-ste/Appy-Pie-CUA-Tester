// ── State-Aware Execution Engine — Runner ───────────────────────
//
// Executes an InteractionConfig as a state-driven sequence. Core loop:
//
//   for each step:
//     for each attempt:
//       1. refresh state (single page.evaluate snapshot)
//       2. evaluate step.condition → skip if false
//       3. run step.action
//       4. poll step.waitFor via adapter.waitUntil → break on success
//
// Replaces every setTimeout(...) in legacy handlers with predicate-driven
// waits. Caller wraps in try/catch; engine returns handled=false on any
// unrecoverable failure so the IAL executor can fall back to the legacy
// handler.
//
// Logs `[ENGINE:step]` per step so stalled runs surface the exact failing
// predicate in terminal stdout.

import type { ExecutionAdapter } from '../../adapter/types.js';
import type {
  InteractionConfig,
  StepContext,
  PickerState,
  EngineResult,
} from './types.js';

const DEFAULT_STEP_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 2;

async function readState(
  adapter: ExecutionAdapter,
  probe: string,
): Promise<PickerState> {
  const raw = await adapter.evaluateExpr<PickerState>(probe);
  // Fallback to an all-false snapshot if the probe throws — step conditions
  // will see "nothing open yet" and issue the opening action.
  return raw ?? {
    overlayOpen: false,
    dropdownOpen: false,
    searchReady: false,
    optionsReady: false,
    optionCount: 0,
  };
}

export async function runInteraction(
  config: InteractionConfig,
  ctx: Omit<StepContext, 'state'>,
): Promise<EngineResult> {
  const log = (msg: string) => console.log(`[ENGINE:${config.type}] ${msg}`);

  for (const step of config.steps) {
    const retries = step.retries ?? DEFAULT_RETRIES;
    let attempt = 0;
    let lastError: string | undefined;

    while (attempt < retries) {
      attempt++;
      // Refresh state at the top of every attempt so stale conditions
      // don't cause us to re-run an action that already landed.
      const state = await readState(ctx.adapter, config.stateProbe);
      const stepCtx: StepContext = { ...ctx, state };

      if (step.condition && !step.condition(stepCtx)) {
        log(`skip "${step.name}" (condition=false) state=${JSON.stringify(state)}`);
        break;
      }

      log(`run "${step.name}" attempt=${attempt}/${retries} state=${JSON.stringify(state)}`);

      try {
        const actionResult = await step.action(stepCtx);
        if (actionResult && actionResult.success === false) {
          lastError = actionResult.error || `action returned success=false`;
          log(`  action failed: ${lastError}`);
          // Retry the same step; state refresh at top of next iter.
          continue;
        }
      } catch (err) {
        lastError = (err as Error).message;
        log(`  action threw: ${lastError}`);
        continue;
      }

      // No waitFor → step is done after action.
      if (!step.waitFor) {
        log(`  ✓ "${step.name}" (no waitFor)`);
        break;
      }

      const waitRes = await ctx.adapter.waitUntil(step.waitFor, {
        timeoutMs: step.waitForTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      });
      if (waitRes.success) {
        log(`  ✓ "${step.name}" waitFor satisfied (effective=${waitRes.effective})`);
        break;
      }
      lastError = waitRes.error || `waitFor timed out: ${step.waitFor}`;
      log(`  ✗ "${step.name}" waitFor failed: ${lastError}`);
      // Fall through → retry loop will refresh state and try again.
    }

    if (attempt >= retries && lastError) {
      log(`STOP at "${step.name}" after ${attempt} attempts — ${lastError}`);
      return {
        handled: false,
        lastStep: step.name,
        error: lastError,
      };
    }
  }

  log(`COMPLETE all ${config.steps.length} steps`);
  return {
    handled: true,
    result: { success: true, effective: true },
    lastStep: config.steps[config.steps.length - 1]?.name,
  };
}
