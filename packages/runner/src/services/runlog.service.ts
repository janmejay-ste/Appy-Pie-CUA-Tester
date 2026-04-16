import fs from 'fs';
import path from 'path';
import * as repo from '../db/repo.js';
import { logger } from '../logger.js';

/**
 * Generate a detailed markdown log file for a completed test run.
 * Includes every step, screenshot paths, action results, and auto-improvement suggestions.
 */
export async function generateRunLog(testRunId: string, testId: string): Promise<string | null> {
  try {
    const run = await repo.getTestRun(testRunId);
    if (!run) return null;

    const steps = await repo.getStepsByRun(testRunId);
    const events = await repo.getEventsByRun(testRunId);

    const screenshotDir = path.resolve(process.cwd(), 'data', 'screenshots', testId, testRunId);
    const logDir = path.resolve(process.cwd(), 'data', 'logs', testId);
    fs.mkdirSync(logDir, { recursive: true });

    const logPath = path.join(logDir, `${testRunId}.md`);
    const lines: string[] = [];

    // ── Header ─────────────────────────────────────────────────
    lines.push(`# Test Run Log: ${run.test_name}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Run ID** | \`${run.id}\` |`);
    lines.push(`| **Test ID** | \`${run.test_id}\` |`);
    lines.push(`| **Status** | ${run.status?.toUpperCase()} |`);
    lines.push(`| **Started** | ${run.started_at || 'N/A'} |`);
    lines.push(`| **Completed** | ${run.completed_at || 'N/A'} |`);
    lines.push(`| **Duration** | ${run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : 'N/A'} |`);
    lines.push(`| **Turns** | ${run.turn_count} |`);
    lines.push(`| **Input Tokens** | ${run.input_tokens?.toLocaleString()} |`);
    lines.push(`| **Output Tokens** | ${run.output_tokens?.toLocaleString()} |`);
    lines.push(`| **Reasoning Tokens** | ${run.reasoning_tokens?.toLocaleString()} |`);
    lines.push(`| **Total Tokens** | ${((run.input_tokens || 0) + (run.output_tokens || 0) + (run.reasoning_tokens || 0)).toLocaleString()} |`);
    lines.push('');

    // ── Model Verdict ──────────────────────────────────────────
    if (run.model_verdict) {
      lines.push('## Model Verdict');
      lines.push('```');
      lines.push(run.model_verdict);
      lines.push('```');
      lines.push('');
    }

    if (run.error) {
      lines.push('## Error');
      lines.push(`> ${run.error}`);
      lines.push('');
    }

    // ── Step-by-Step Log ───────────────────────────────────────
    lines.push('## Step-by-Step Execution');
    lines.push('');

    // Track patterns for analysis
    const failedActions: Array<{ turn: number; action: string; target: string; error: string }> = [];
    const noEffectActions: Array<{ turn: number; action: string; target: string }> = [];
    const visionBurstTurns: number[] = [];
    let totalApiTime = 0;
    let slowestTurn = { turn: 0, ms: 0 };

    for (const step of steps) {
      const turnNum = step.turn_number ?? 0;
      const screenshotPath = step.file_path
        ? path.join(screenshotDir, step.file_path)
        : null;

      // Parse JSON fields
      const action = typeof step.action === 'string' ? safeJson(step.action) : step.action;
      const result = typeof step.result === 'string' ? safeJson(step.result) : step.result;
      const validation = typeof step.validation === 'string' ? safeJson(step.validation) : step.validation;

      lines.push(`### Turn ${turnNum}`);
      lines.push('');

      // Screenshot reference
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        lines.push(`**Screenshot:** \`${step.file_path}\``);
      }

      // Page info
      if (step.page_url) lines.push(`**URL:** ${step.page_url}`);
      if (step.page_title) lines.push(`**Page:** ${step.page_title}`);

      // Action details — target may be a string (new writes) OR object (legacy rows).
      const renderTarget = (t: unknown): string => {
        if (t == null) return 'none';
        if (typeof t === 'string') return t || 'none';
        if (typeof t === 'object') {
          const o = t as Record<string, unknown>;
          if (typeof o.elementId === 'string' && o.elementId) return o.elementId;
          if (typeof o.text === 'string' && o.text) return String(o.text).slice(0, 40);
          if (typeof o.domPath === 'string' && o.domPath) return String(o.domPath).slice(0, 60);
          if (typeof o.index === 'number') return `#${o.index}`;
        }
        return 'none';
      };
      const actionTargetStr = action ? renderTarget(action.target) : 'none';

      if (action) {
        lines.push(`**Action:** \`${action.type || 'unknown'}\` target=\`${actionTargetStr}\` value=\`${action.value || ''}\``);
      }

      // Result
      if (result) {
        const successStr = result.success ? 'OK' : 'FAILED';
        lines.push(`**Result:** ${successStr} — ${result.description || result.error || 'no details'}`);

        if (!result.success && action) {
          failedActions.push({
            turn: turnNum,
            action: action.type || '',
            target: actionTargetStr,
            error: result.error || result.description || '',
          });
        }
      }

      // Validation
      if (validation) {
        const flags = [];
        if (validation.urlChanged) flags.push('URL changed');
        if (validation.domChanged) flags.push('DOM changed');
        if (validation.valueChanged) flags.push('value changed');
        if (validation.errorAppeared) flags.push(`error: ${validation.errorMessage || 'unknown'}`);
        const effective = validation.urlChanged || validation.domChanged || validation.valueChanged;
        if (!effective && action?.type && !['wait', 'done'].includes(action.type)) {
          noEffectActions.push({ turn: turnNum, action: action.type, target: actionTargetStr });
          flags.push('**NO EFFECT**');
        }
        if (flags.length > 0) lines.push(`**Validation:** ${flags.join(', ')}`);
      }

      // Mode + tokens
      const mode = step.mode || 'dom';
      if (mode === 'vision' || mode === 'vision-burst') visionBurstTurns.push(turnNum);
      const apiMs = step.api_latency_ms || 0;
      totalApiTime += apiMs;
      if (apiMs > slowestTurn.ms) slowestTurn = { turn: turnNum, ms: apiMs };

      lines.push(`**Mode:** ${mode} | **API:** ${apiMs}ms | **Tokens:** in=${step.input_tokens || 0} out=${step.output_tokens || 0} reason=${step.reasoning_tokens || 0}`);

      // Agent state
      if (step.memory) lines.push(`**Memory:** ${step.memory}`);
      if (step.next_goal) lines.push(`**Next Goal:** ${step.next_goal}`);
      if (step.confidence != null) lines.push(`**Confidence:** ${step.confidence}`);

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // ── Event Timeline ─────────────────────────────────────────
    lines.push('## Event Timeline');
    lines.push('');
    for (const event of events) {
      lines.push(`- **${event.timestamp}** [${event.type}] ${event.message}`);
    }
    lines.push('');

    // ── Analysis & Improvement Suggestions ─────────────────────
    lines.push('## Analysis & Improvement Suggestions');
    lines.push('');

    const suggestions: string[] = [];

    // 1. Failed actions
    if (failedActions.length > 0) {
      lines.push('### Failed Actions');
      lines.push('');
      lines.push('| Turn | Action | Target | Error |');
      lines.push('|------|--------|--------|-------|');
      for (const f of failedActions) {
        lines.push(`| T${f.turn} | ${f.action} | \`${f.target}\` | ${f.error.slice(0, 80)} |`);
      }
      lines.push('');

      // Suggestions based on failure patterns
      const elementNotFound = failedActions.filter(f => f.error.includes('not found'));
      const timeout = failedActions.filter(f => f.error.includes('Timeout'));
      if (elementNotFound.length > 2) {
        suggestions.push(`**DOM extraction issue:** ${elementNotFound.length} actions failed with "element not found". Consider adding more selectors to the DOM extractor or increasing max elements.`);
      }
      if (timeout.length > 0) {
        suggestions.push(`**Timeout on actions:** ${timeout.length} actions timed out. Consider increasing ACTION_TIMEOUT or adding wait steps before these actions.`);
      }
    }

    // 2. No-effect actions
    if (noEffectActions.length > 0) {
      lines.push('### No-Effect Actions (wasted turns)');
      lines.push('');
      lines.push('| Turn | Action | Target |');
      lines.push('|------|--------|--------|');
      for (const n of noEffectActions) {
        lines.push(`| T${n.turn} | ${n.action} | \`${n.target}\` |`);
      }
      lines.push('');

      const clickNoEffect = noEffectActions.filter(n => n.action === 'click');
      const scrollNoEffect = noEffectActions.filter(n => n.action === 'scroll');
      if (clickNoEffect.length > 3) {
        suggestions.push(`**Click inefficiency:** ${clickNoEffect.length} clicks had no effect. The model may be targeting labels instead of interactive elements. Consider improving DOM extraction to prioritize clickable elements.`);
      }
      if (scrollNoEffect.length > 2) {
        suggestions.push(`**Scroll not working:** ${scrollNoEffect.length} scrolls had no effect. The side panel scroll fix may not be finding the right overflow container. Check adapter scroll() method.`);
      }
    }

    // 3. Vision burst analysis
    if (visionBurstTurns.length > 0) {
      lines.push(`### Vision Mode Turns: ${visionBurstTurns.length}`);
      lines.push(`Turns: ${visionBurstTurns.join(', ')}`);
      lines.push('');
      if (visionBurstTurns.length > steps.length * 0.3) {
        suggestions.push(`**Excessive vision mode:** ${visionBurstTurns.length}/${steps.length} turns used vision mode (>${Math.round(visionBurstTurns.length / steps.length * 100)}%). This is expensive (~15k tokens/turn vs ~2.5k DOM). Investigate why DOM mode keeps failing.`);
      }
    }

    // 4. Speed analysis
    const avgApiTime = steps.length > 0 ? Math.round(totalApiTime / steps.length) : 0;
    lines.push(`### Performance`);
    lines.push(`- **Avg API latency:** ${avgApiTime}ms/turn`);
    lines.push(`- **Slowest turn:** T${slowestTurn.turn} (${slowestTurn.ms}ms)`);
    lines.push(`- **Total API time:** ${Math.round(totalApiTime / 1000)}s of ${run.duration_ms ? Math.round(run.duration_ms / 1000) : '?'}s total`);
    lines.push('');

    if (slowestTurn.ms > 30000) {
      suggestions.push(`**Slow API turn T${slowestTurn.turn}:** ${Math.round(slowestTurn.ms / 1000)}s. The model spent excessive time reasoning. Consider reducing prompt size or lowering reasoning effort for less complex steps.`);
    }
    if (avgApiTime > 15000) {
      suggestions.push(`**High average API latency:** ${Math.round(avgApiTime / 1000)}s/turn. Consider reducing prompt token count by trimming action history or page state.`);
    }

    // 5. Status-based suggestions
    if (run.status === 'timeout') {
      suggestions.push(`**Test timed out at turn ${run.turn_count}.** Consider: increasing max_turns in the YAML, simplifying the test steps, or improving adapter auto-actions to reduce turns.`);
    }
    if (run.status === 'failed' && run.model_verdict) {
      if (run.model_verdict.includes('account') && run.model_verdict.includes('not linked')) {
        suggestions.push(`**Account linking failure.** The test requires pre-linked accounts. Ensure the test account has Google Sheets/Gmail/GoHighLevel/Mindbody already connected in Appy Pie.`);
      }
      if (run.model_verdict.includes('Add an Account')) {
        suggestions.push(`**Model clicked "Add an Account" instead of using existing account.** The auto-select account feature may not have detected the dropdown. Check autoSelectAccount logic in playwright-adapter.ts.`);
      }
    }

    // 6. Turn efficiency
    const effectiveTurns = steps.length - noEffectActions.length - failedActions.length;
    const efficiency = steps.length > 0 ? Math.round(effectiveTurns / steps.length * 100) : 0;
    lines.push(`### Turn Efficiency: ${efficiency}%`);
    lines.push(`- Effective turns: ${effectiveTurns}/${steps.length}`);
    lines.push(`- Wasted (no effect): ${noEffectActions.length}`);
    lines.push(`- Failed: ${failedActions.length}`);
    lines.push('');

    if (efficiency < 60) {
      suggestions.push(`**Low turn efficiency (${efficiency}%).** More than 40% of turns were wasted. Review the test YAML instructions for clarity and the adapter auto-actions for completeness.`);
    }

    // ── Suggestions summary ────────────────────────────────────
    if (suggestions.length > 0) {
      lines.push('### Actionable Improvements');
      lines.push('');
      for (let i = 0; i < suggestions.length; i++) {
        lines.push(`${i + 1}. ${suggestions[i]}`);
      }
      lines.push('');
    } else {
      lines.push('### No critical issues detected.');
      lines.push('');
    }

    // Write log file
    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
    logger.info({ logPath, testRunId, turns: steps.length, suggestions: suggestions.length }, '[runlog] Log file generated');

    return logPath;
  } catch (err) {
    logger.warn({ err: (err as Error).message, testRunId }, '[runlog] Failed to generate log');
    return null;
  }
}

function safeJson(s: unknown): any {
  if (!s) return null;
  if (typeof s === 'object') return s; // already parsed by formatStep()
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}
