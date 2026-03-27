import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { executeAction } from './actions.js';
import type { CUAResponse, ComputerAction, ScreenshotRecord, TestAccountConfig, TurnTokenUsage, CUALoopCallbacks, PageState, CUALoopResult } from './types.js';

// ── Performance config ──────────────────────────────────────────
const INTER_ACTION_DELAY_MS = 120;
const DEFAULT_maxTurns = 40;
const ACTION_TIMEOUT_MS = 20_000;
const MODEL = 'gpt-5.4';

// ── System instructions ─────────────────────────────────────────
const SYSTEM_INSTRUCTIONS = `You are a UI usability testing agent. You are testing a live website by interacting with it through a browser.

Your job:
1. Follow the test instructions precisely
2. Interact with the page naturally (click, type, scroll, navigate)
3. After each action, verify the action had the intended effect before proceeding
4. Stay focused on the test objective — do NOT explore unrelated pages or features
5. When you are done, respond with a structured summary

CRITICAL RULES:
- When filling out forms, ALWAYS scroll down to check for hidden fields BEFORE clicking submit
- If you see "Advanced Mapping" / "Advanced Mode" buttons, ALWAYS click them first
- Do NOT click submit until all required fields are filled
- If an action doesn't produce the expected result, try a DIFFERENT approach — do NOT repeat the same action
- If you are stuck on a page, try: (1) scrolling, (2) clicking elsewhere, (3) using keyboard navigation, (4) navigating back
- Stay on task — if you navigate to an unrelated page, return to the test flow immediately
- NEVER click expand/fullscreen/maximize buttons (diagonal arrows ↗↙ icon) on side panels or right panels — they break the layout and make the page unusable
- NEVER click the WhatsApp chat widget (green circle at bottom-right)
- LOGIN FLOW: Click email field → type email → click email field again or press TAB → password field appears → type password → click LOGIN. Never click "Forgot password" or "Sign in with Google"

GOAL VERIFICATION:
- Before giving your final verdict, verify each step of the test objective was actually achieved
- A PASS requires that ALL expected outcomes are confirmed visible/functional
- If you cannot confirm an expected outcome, mark it as FAIL with specific reason
- Do NOT guess — if you're unsure whether something worked, it's a FAIL

Format your final message EXACTLY like this:
VERDICT: PASS or FAIL
SUMMARY: <brief summary of what was tested>
STEPS_COMPLETED: <numbered list of which test steps succeeded>
STEPS_FAILED: <numbered list of which steps failed and why, or "None">
ISSUES: <list any issues found, or "None">`;

// Re-export types for backward compatibility
export type { TurnTokenUsage, CUALoopCallbacks, PageState, CUALoopResult };

// ── Small helpers ───────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function captureScreenshotBase64(page: Page): Promise<string> {
  // Hide distracting UI + block expand/fullscreen clicks programmatically
  await page.evaluate(`(() => {
    // CSS: hide expand buttons and WhatsApp widget
    var style = document.getElementById('__cua_hide_style');
    if (!style) {
      style = document.createElement('style');
      style.id = '__cua_hide_style';
      style.textContent = [
        '[class*="whatsapp"], [class*="wa-widget"], [id*="whatsapp"] { display: none !important; }',
      ].join('\\n');
      document.head.appendChild(style);
    }

    // Remove expand/fullscreen buttons from DOM entirely
    var expandBtns = document.querySelectorAll('[class*="expand"], [class*="fullscreen"], [class*="maximize"], [class*="full-screen"]');
    expandBtns.forEach(function(btn) {
      if (btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.tagName === 'SPAN' || btn.tagName === 'DIV') {
        var rect = btn.getBoundingClientRect();
        if (rect.width < 60 && rect.height < 60) {
          btn.remove();
        }
      }
    });

    // Also remove the specific Appy Pie panel resize icons (SVG with diagonal arrows)
    document.querySelectorAll('.halfcolume svg, section svg').forEach(function(svg) {
      var rect = svg.getBoundingClientRect();
      if (rect.width < 30 && rect.height < 30 && rect.width > 10) {
        var parent = svg.parentElement;
        if (parent && (parent.tagName === 'BUTTON' || parent.tagName === 'A' || parent.tagName === 'SPAN')) {
          parent.remove();
        }
      }
    });
  })()`).catch(() => {});
  const buffer = await page.screenshot({ type: 'png' });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function saveScreenshotToDisk(
  page: Page,
  dir: string,
  turn: number,
  runId: string,
): Promise<ScreenshotRecord> {
  await fs.mkdir(dir, { recursive: true });
  const filename = `${String(turn).padStart(3, '0')}-turn.png`;
  const filePath = path.join(dir, filename);
  await page.screenshot({ path: filePath });
  const pageTitle = await page.title().catch(() => undefined);

  return {
    id: uuid(),
    test_run_id: runId,
    turn_number: turn,
    file_path: filename,
    captured_at: new Date().toISOString(),
    page_url: page.url(),
    page_title: pageTitle ?? null,
  };
}

function extractMessage(response: CUAResponse): string {
  return (response.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => (item.content as Array<{ text?: string; type?: string }>) ?? [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text?.trim())
    .filter(Boolean)
    .join('\n\n');
}

function parseVerdict(message: string): 'PASS' | 'FAIL' | 'UNKNOWN' {
  const upper = message.toUpperCase();
  // If model says PASS but also lists failed steps, override to FAIL
  if (upper.includes('VERDICT: PASS') || upper.includes('VERDICT:PASS')) {
    // Goal validation: check if STEPS_FAILED contains actual failures
    const failedMatch = message.match(/STEPS_FAILED:\s*(.+?)(?=\n[A-Z]|\n$|$)/s);
    if (failedMatch) {
      const failedText = failedMatch[1].trim().toLowerCase();
      if (failedText !== 'none' && failedText !== 'n/a' && failedText.length > 5) {
        console.warn('[cua-loop] Model said PASS but listed failed steps — overriding to FAIL');
        return 'FAIL';
      }
    }
    return 'PASS';
  }
  if (upper.includes('VERDICT: FAIL') || upper.includes('VERDICT:FAIL')) return 'FAIL';
  return 'UNKNOWN';
}

// ── THE CORE CUA LOOP ───────────────────────────────────────────
export async function runCUALoop(
  openai: OpenAI,
  page: Page,
  testInstructions: string,
  expectedOutcome: string,
  screenshotDir: string,
  runId: string,
  callbacks: CUALoopCallbacks,
  testAccount?: TestAccountConfig,
  abortSignal?: AbortSignal,
  maxTurns: number = DEFAULT_maxTurns,
  tokenBudget: number = 200000,
  testUrl?: string,
): Promise<CUALoopResult> {
  let previousResponseId: string | undefined;
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // Adaptive token control — reduce image detail when approaching budget
  const getImageDetail = (): string => {
    const used = totalTokens.input + totalTokens.output;
    if (used > tokenBudget * 0.7) return 'low';
    return 'auto';
  };

  // Stuck detection — track consecutive same-state turns (URL + DOM)
  const STUCK_THRESHOLD = 4;
  let lastStateFingerprint = '';
  let sameStateCount = 0;

  // URL Watchdog — allowed domains derived from test URL + known auth domains
  const allowedDomains: string[] = [];
  if (testUrl) {
    try {
      const origin = new URL(testUrl).hostname;
      // Allow the test domain + common related domains
      const baseDomain = origin.split('.').slice(-2).join('.');
      allowedDomains.push(baseDomain);
    } catch { /* ignore */ }
  }
  // Always allow known Appy Pie auth domains (login is expected)
  allowedDomains.push('appypie.com', 'appypieautomate.ai', 'connectcloud.appypie.com');

  // Check if a URL is within allowed scope
  const isUrlAllowed = (url: string): boolean => {
    if (allowedDomains.length === 0) return true; // no restriction if no test URL
    try {
      const hostname = new URL(url).hostname;
      return allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    } catch {
      return true; // can't parse = allow
    }
  };

  // List of known external trap domains the model should never interact with
  const EXTERNAL_TRAPS = ['login.live.com', 'accounts.google.com', 'github.com', 'facebook.com', 'calendly.com'];
  const isExternalTrap = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname;
      return EXTERNAL_TRAPS.some(d => hostname === d || hostname.endsWith('.' + d));
    } catch {
      return false;
    }
  };

  // ── Multi-tab / popup handling ─────────────────────────────
  let activePage = page;
  const context = page.context();
  const networkErrors: string[] = [];

  // Listen for new tabs/popups — auto-switch to them
  context.on('page', (newPage) => {
    console.log(`[cua-loop] New tab/popup opened: ${newPage.url()}`);
    activePage = newPage;
    // Listen for close — switch back to original
    newPage.on('close', () => {
      console.log('[cua-loop] Popup closed, switching back to main page');
      activePage = page;
    });
  });

  // ── Network failure detection ──────────────────────────────
  activePage.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      const msg = `${res.status()} ${res.url().slice(0, 80)}`;
      networkErrors.push(msg);
      if (networkErrors.length > 20) networkErrors.shift(); // keep last 20
    }
  });

  // ── Action budgeting ───────────────────────────────────────
  const MAX_ACTIONS_PER_TURN = 5;
  let lastActionSig = '';
  let repeatCount = 0;

  // Capture initial screenshot
  const initialScreenshot = await captureScreenshotBase64(activePage);
  const initialSaved = await saveScreenshotToDisk(activePage, screenshotDir, 0, runId);
  callbacks.onScreenshot(0, initialSaved);

  // Build first turn input
  let prompt = '';
  if (testAccount) {
    prompt += `TEST ACCOUNT CREDENTIALS (use these to log in when the test instructions require authentication):\nEmail: ${testAccount.email}\nPassword: ${testAccount.password}\n\n`;
    console.log(`[cua-vision] Credentials INCLUDED in prompt (email: ${testAccount.email})`);
  } else {
    console.log(`[cua-vision] No credentials — test does not require auth`);
  }
  prompt += `TEST INSTRUCTIONS:\n${testInstructions}\n\nEXPECTED OUTCOME:\n${expectedOutcome}`;
  let nextInput: unknown = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: initialScreenshot, detail: getImageDetail() },
      ],
    },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Check if the run has been aborted
    if (abortSignal?.aborted) {
      return {
        verdict: 'FAIL',
        modelMessage: 'Test was aborted (token budget exceeded or manual stop).',
        turns: turn - 1,
        totalTokens,
      };
    }

    callbacks.onTurnStart(turn);

    // ── Call the CUA model ──────────────────────────────────────
    const apiStart = Date.now();
    let response: CUAResponse;

    // Debug: log what we're sending to the vision model
    const inputSummary = Array.isArray(nextInput)
      ? (nextInput as any[]).map((item: any) => {
          if (item.role) {
            const parts = Array.isArray(item.content) ? item.content : [item.content];
            return parts.map((p: any) => {
              if (typeof p === 'string') return `text(${p.length} chars)`;
              if (p.type === 'input_text') return `text(${p.text?.length ?? 0} chars)`;
              if (p.type === 'input_image') return 'image';
              return p.type || 'unknown';
            }).join(', ');
          }
          return item.type || 'continuation';
        }).join(' | ')
      : 'continuation';
    console.log(`[cua-vision-debug] T${turn} → model | ${inputSummary} | prevId: ${previousResponseId ? 'yes' : 'no'}`);

    try {
      response = await openai.responses.create({
        model: MODEL,
        instructions: SYSTEM_INSTRUCTIONS,
        input: nextInput as any,
        tools: [{ type: 'computer' as any }],
        reasoning: { effort: 'low' as any },
        parallel_tool_calls: false,
        truncation: 'auto',
        previous_response_id: previousResponseId,
      } as any, { signal: abortSignal } as any) as unknown as CUAResponse;
    } catch (err: any) {
      // If aborted during API call, return gracefully
      if (abortSignal?.aborted) {
        return {
          verdict: 'FAIL',
          modelMessage: 'Test was manually aborted by user.',
          turns: turn - 1,
          totalTokens,
        };
      }
      console.error(`[cua-vision-debug] T${turn} API ERROR:`, err.message || err);
      throw err;
    }
    const apiLatency = Date.now() - apiStart;

    // Check abort after API call returns
    if (abortSignal?.aborted) {
      return {
        verdict: 'FAIL',
        modelMessage: 'Test was manually aborted by user.',
        turns: turn,
        totalTokens,
      };
    }

    // Per-turn token usage
    const turnInput = response.usage?.input_tokens ?? 0;
    const turnOutput = response.usage?.output_tokens ?? 0;
    const turnReasoning = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;

    // Accumulate tokens
    totalTokens.input += turnInput;
    totalTokens.output += turnOutput;
    totalTokens.reasoning += turnReasoning;

    // Debug: log vision model response
    const outputTypes = response.output?.map((o: any) => o.type).join(', ') || 'none';
    console.log(`[cua-vision-debug] T${turn} ← model | ${apiLatency}ms | in=${turnInput} out=${turnOutput} reason=${turnReasoning} | outputs: [${outputTypes}]`);

    // Validate
    if (response.error?.message) throw new Error(`CUA API error: ${response.error.message}`);
    if (response.status === 'failed') throw new Error('CUA API request failed');

    previousResponseId = response.id;
    callbacks.onTurnComplete(turn, apiLatency, { ...totalTokens });

    // Emit per-turn token breakdown
    callbacks.onTurnTokens({
      turn,
      input: turnInput,
      output: turnOutput,
      reasoning: turnReasoning,
      apiLatencyMs: apiLatency,
      cumulativeInput: totalTokens.input,
      cumulativeOutput: totalTokens.output,
      cumulativeReasoning: totalTokens.reasoning,
    });

    // ── Check for computer_call items ───────────────────────────
    const computerCalls = (response.output ?? []).filter(item => item.type === 'computer_call');

    if (computerCalls.length === 0) {
      // Model finished — extract verdict
      const message = extractMessage(response);
      const verdict = parseVerdict(message);
      return { verdict, modelMessage: message, turns: turn, totalTokens };
    }

    // ── Execute actions from each computer_call ─────────────────
    const toolOutputs: unknown[] = [];

    for (const call of computerCalls) {
      const actions = (call.actions ?? []) as ComputerAction[];

      // Safety check
      if (call.pending_safety_checks?.length) {
        throw new Error(`Safety check required: ${call.pending_safety_checks.map(c => c.message).join(', ')}`);
      }

      // ── Per-action execution + verification ───────────────────
      const currentPage = activePage; // use the active page (may be popup)
      const preUrl = currentPage.url();
      const preTitle = await currentPage.title().catch(() => '');
      const actionResults: string[] = [];
      let criticalFailure = false;

      // Action budgeting — cap actions per turn + detect repeats
      const cappedActions = actions.slice(0, MAX_ACTIONS_PER_TURN);
      if (actions.length > MAX_ACTIONS_PER_TURN) {
        console.warn(`[cua-loop] Turn ${turn}: ${actions.length} actions capped to ${MAX_ACTIONS_PER_TURN}`);
        actionResults.push(`[${actions.length - MAX_ACTIONS_PER_TURN} actions dropped — turn budget exceeded]`);
      }
      const actionSig = cappedActions.map(a => `${a.type}:${(a as any).x ?? ''}:${(a as any).y ?? ''}:${(a as any).text?.slice(0, 10) ?? ''}`).join('|');
      if (actionSig === lastActionSig) {
        repeatCount++;
        if (repeatCount >= 5) {
          // Hard intervention — abort, this is an infinite loop
          console.warn(`[cua-loop] Action loop detected (${repeatCount} repeats). Aborting.`);
          return {
            verdict: 'FAIL' as const,
            modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — model repeated the same actions ${repeatCount} times.\nSTEPS_COMPLETED: Unknown — model was stuck in a loop\nSTEPS_FAILED: Could not progress past current state\nISSUES: Infinite action loop on: ${currentPage.url()}`,
            turns: turn,
            totalTokens,
          };
        } else if (repeatCount >= 3) {
          // Soft intervention — inject strategy change instruction
          actionResults.push(`[WARNING: You have repeated the same actions ${repeatCount} times. This approach is NOT working. Try a completely different strategy: scroll, click a different element, use keyboard navigation, or navigate to a different page.]`);
        }
      } else {
        lastActionSig = actionSig;
        repeatCount = 1;
      }

      // Credential security — block typing credentials on unknown domains
      const currentDomain = (() => { try { return new URL(currentPage.url()).hostname; } catch { return ''; } })();
      const isKnownDomain = allowedDomains.some(d => currentDomain === d || currentDomain.endsWith('.' + d));

      // Actions that don't require visible DOM change
      const NO_CHANGE_EXPECTED = new Set(['wait', 'screenshot', 'move', 'scroll']);
      const isFocusClick = (a: ComputerAction): boolean => {
        const idx = cappedActions.indexOf(a);
        return idx < cappedActions.length - 1 && cappedActions[idx + 1]?.type === 'type';
      };

      for (let i = 0; i < cappedActions.length; i++) {
        const action = cappedActions[i];

        // Credential security — block typing passwords on unknown domains
        if (action.type === 'type' && testAccount && !isKnownDomain) {
          const text = (action as any).text ?? '';
          if (text === testAccount.password || text === testAccount.email) {
            console.warn(`[cua-loop] BLOCKED: credential typing on unknown domain ${currentDomain}`);
            actionResults.push(`[BLOCKED: credential input on unknown domain ${currentDomain}]`);
            continue; // skip this action
          }
        }

        // Capture lightweight pre-action state
        let preActionState: { url: string; inputValue?: string; activeTag?: string; sig: string } | null = null;
        try {
          preActionState = await currentPage.evaluate((actionType: string) => {
            const el = document.activeElement;
            const activeTag = el?.tagName?.toLowerCase() ?? '';
            let inputValue: string | undefined;
            if (actionType === 'type') {
              inputValue = (el as HTMLInputElement)?.value ?? undefined;
            }
            // Lightweight DOM signature: text sample + interactive element counts
            const textSample = document.body?.innerText?.slice(0, 300) ?? '';
            const clickables = document.querySelectorAll('button,a,[role="button"]').length;
            const inputs = document.querySelectorAll('input,textarea,select').length;
            const sig = `${textSample.length}|${clickables}|${inputs}`;
            return { url: location.href, inputValue, activeTag, sig };
          }, action.type).catch(() => null);
        } catch { /* ignore */ }

        // Execute single action
        try {
          await withTimeout(
            executeAction(currentPage, action),
            ACTION_TIMEOUT_MS,
            `Action ${action.type}`,
          );
          if (action.type !== 'wait' && action.type !== 'screenshot') {
            await delay(INTER_ACTION_DELAY_MS);
          }
        } catch (err) {
          const errMsg = (err as Error).message;
          console.error(`[cua-loop] Action ${i} (${action.type}) failed (turn ${turn}):`, errMsg);
          actionResults.push(`[${action.type} FAILED: ${errMsg}]`);

          if (errMsg.includes('Target closed') || errMsg.includes('Session closed') || errMsg.includes('Browser closed')) {
            criticalFailure = true;
            break;
          }
          continue;
        }

        // Skip verification for actions that don't need it
        if (NO_CHANGE_EXPECTED.has(action.type)) continue;

        // ── Action-specific verification ──────────────────────
        try {
          // Small delay for React/framework state updates
          if (action.type === 'type') await delay(100);

          const postActionState = await currentPage.evaluate((actionType: string) => {
            const el = document.activeElement;
            const activeTag = el?.tagName?.toLowerCase() ?? '';
            let inputValue: string | undefined;
            if (actionType === 'type') {
              inputValue = (el as HTMLInputElement)?.value ?? undefined;
            }
            const textSample = document.body?.innerText?.slice(0, 300) ?? '';
            const clickables = document.querySelectorAll('button,a,[role="button"]').length;
            const inputs = document.querySelectorAll('input,textarea,select').length;
            const sig = `${textSample.length}|${clickables}|${inputs}`;
            // Check for visible validation errors
            const errorEl = document.querySelector('[role="alert"], .error-message, [class*="alert-danger"]');
            const visibleError = errorEl && (errorEl as HTMLElement).offsetParent
              ? (errorEl as HTMLElement).innerText?.trim()?.slice(0, 100) : null;
            return { url: location.href, inputValue, activeTag, sig, visibleError };
          }, action.type).catch(() => null);

          if (postActionState && preActionState) {
            // Click verification — only for non-focus clicks
            if ((action.type === 'click' || action.type === 'double_click') && !isFocusClick(action)) {
              const sigChanged = postActionState.sig !== preActionState.sig;
              const urlChanged = postActionState.url !== preActionState.url;
              const focusChanged = postActionState.activeTag !== preActionState.activeTag;
              if (!sigChanged && !urlChanged && !focusChanged) {
                actionResults.push(`[click (${(action as any).x},${(action as any).y}): no effect detected]`);
              }
            }

            // Type verification
            if (action.type === 'type' && (action as any).text) {
              const typed = (action as any).text;
              if (postActionState.inputValue !== undefined &&
                  !postActionState.inputValue.includes(typed) &&
                  postActionState.activeTag !== 'body') {
                actionResults.push(`[type "${typed.slice(0, 20)}": value mismatch — may be wrong field]`);
              }
            }

            // Keypress verification for Enter/Submit
            if (action.type === 'keypress') {
              const key = ((action as any).key || '').toLowerCase();
              if (key === 'enter' || key === 'return') {
                const sigChanged = postActionState.sig !== preActionState.sig;
                const urlChanged = postActionState.url !== preActionState.url;
                if (!sigChanged && !urlChanged) {
                  actionResults.push(`[keypress Enter: no form submission detected]`);
                }
              }
            }

            // Validation error after any action
            if (postActionState.visibleError) {
              actionResults.push(`[error after ${action.type}: ${postActionState.visibleError}]`);
            }
          }
        } catch { /* verification failed silently, continue */ }
      }

      // ── Post-batch page health check ────────────────────────
      let pageHealthy = !criticalFailure;
      if (pageHealthy) {
        try {
          await currentPage.evaluate(() => document.readyState);
        } catch {
          pageHealthy = false;
        }
      }

      const postUrl = currentPage.url();
      const postTitle = await currentPage.title().catch(() => '');

      // URL Watchdog — auto-bounce back from external trap domains
      if (isExternalTrap(postUrl)) {
        console.warn(`[cua-loop] External trap detected: ${postUrl}. Auto-navigating back to ${testUrl || preUrl}`);
        try {
          await currentPage.goto(testUrl || preUrl, { waitUntil: 'load', timeout: 15000 });
        } catch { /* ignore */ }
      } else if (!isUrlAllowed(postUrl) && testUrl) {
        console.warn(`[cua-loop] Off-domain navigation: ${postUrl}. Auto-navigating back to ${testUrl}`);
        try {
          await currentPage.goto(testUrl, { waitUntil: 'load', timeout: 15000 });
        } catch { /* ignore */ }
      }

      const finalUrl = currentPage.url();
      const finalTitle = await currentPage.title().catch(() => postTitle);
      const urlChanged = finalUrl !== preUrl;
      const titleChanged = finalTitle !== preTitle;

      // Build verification summary
      let verificationNote = '';
      if (actionResults.length > 0) {
        verificationNote += '\n' + actionResults.join('\n');
      }
      if (!pageHealthy) {
        verificationNote += '\n[PAGE CRASHED: Browser became unresponsive]';
      }
      if (urlChanged) {
        verificationNote += `\n[NAVIGATION: ${preUrl} → ${finalUrl}]`;
      }
      if (titleChanged && !urlChanged) {
        verificationNote += `\n[PAGE CHANGED: "${preTitle}" → "${finalTitle}"]`;
      }
      // Network errors detected during this turn
      if (networkErrors.length > 0) {
        verificationNote += `\n[NETWORK ERRORS: ${networkErrors.slice(-3).join(' | ')}]`;
      }

      callbacks.onActionsExecuted(turn, actions);

      // Capture screenshot after actions (from active page — may be popup)
      const screenshotDataUrl = await captureScreenshotBase64(currentPage);
      const savedScreenshot = await saveScreenshotToDisk(currentPage, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, savedScreenshot);

      // Structured verification logging
      if (verificationNote || actionResults.length > 0) {
        const structured = {
          turn,
          url: finalUrl,
          title: finalTitle,
          pageHealthy,
          urlChanged,
          actionIssues: actionResults.filter(r => r.includes('FAILED') || r.includes('no effect') || r.includes('mismatch')),
          warnings: actionResults.filter(r => r.includes('WARNING') || r.includes('dropped')),
          networkErrors: networkErrors.slice(-3),
        };
        console.log(`[cua-loop] Turn ${turn} verification:`, JSON.stringify(structured));
      }

      // Stuck detection — uses URL + DOM signature (text length + interactive counts)
      let domSig = '0|0|0';
      try {
        domSig = await currentPage.evaluate(() => {
          const textLen = document.body?.innerText?.length ?? 0;
          const clickables = document.querySelectorAll('button,a,[role="button"]').length;
          const inputs = document.querySelectorAll('input,textarea,select').length;
          return `${textLen}|${clickables}|${inputs}`;
        });
      } catch { /* ignore */ }
      const stateFingerprint = `${finalUrl}|${domSig}`;
      if (stateFingerprint === lastStateFingerprint) {
        sameStateCount++;
        if (sameStateCount >= STUCK_THRESHOLD) {
          console.warn(`[cua-loop] Stuck detected: same state for ${sameStateCount} turns (${finalUrl}). Aborting.`);
          return {
            verdict: 'FAIL' as const,
            modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — stuck on the same page state for ${sameStateCount} consecutive turns.\nISSUES: Browser was stuck on: ${finalUrl} (page title: "${finalTitle}"). No DOM changes detected — the model's actions had no visible effect.`,
            turns: turn,
            totalTokens,
          };
        }
      } else {
        lastStateFingerprint = stateFingerprint;
        sameStateCount = 1;
      }

      toolOutputs.push({
        type: 'computer_call_output',
        call_id: call.call_id,
        output: {
          type: 'computer_screenshot',
          image_url: screenshotDataUrl,
        },
      });
    }

    nextInput = toolOutputs;
  }

  // Turn budget exhausted — capture full page state for resume
  let storageStatePath: string | undefined;
  try {
    const storageFile = path.join(screenshotDir, 'storage-state.json');
    await activePage.context().storageState({ path: storageFile });
    storageStatePath = storageFile;
    console.log('[cua-loop] Saved browser storage state for resume:', storageFile);
  } catch (e) {
    console.warn('[cua-loop] Failed to save storage state:', (e as Error).message);
  }

  const timeoutPageState: PageState = {
    url: activePage.url(),
    title: await activePage.title().catch(() => ''),
    lastActions: [],
    storageStatePath,
  };

  return {
    verdict: 'TIMEOUT',
    modelMessage: `Reached maximum turn limit (${maxTurns}) without completing the test. Want to continue then increase maxturns!`,
    turns: maxTurns,
    totalTokens,
    pageState: timeoutPageState,
  };
}
