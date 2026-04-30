import { Router } from 'express';
import * as repo from '../db/repo.js';
import { loadAllTests, loadTestById } from '../test-loader.js';
import { createTestSchema, updateTestSchema } from '../validation/test.validation.js';
import { testExecutionQueue } from '../queue/queue.js';
import { abortTestRun } from '../queue/worker.js';
import * as sessionService from '../services/session.service.js';
import * as testService from '../services/test.service.js';

const router = Router();

// ── Helper: create session + test run + enqueue ─────────────
async function createAndEnqueueTestJob(opts: {
  testId: string; testName: string; testUrl: string;
  testInstructions: string; expectedOutcome: string;
  headless: boolean; requiresAuth: boolean;
  maxTurns: number; timeout: number;
  viewport?: { width: number; height: number };
  cuaMode?: string;
  /** Optional declarative validation rules (forwarded to the worker). */
  validation?: Array<{ type: 'url' | 'text' | 'element' | 'not_text'; value: string; label?: string }>;
}): Promise<{ suiteRunId: string; testRunId: string }> {
  const session = await sessionService.createSession(1);
  if (!session) throw new Error('Failed to create session');
  const testRun = await testService.createTestRun(session.id, opts.testId, opts.testName);
  if (!testRun) throw new Error('Failed to create test run');

  await testExecutionQueue.add(`test-${opts.testId}`, {
    sessionId: session.id, testRunId: testRun.id,
    ...opts,
  }, { priority: 2 });

  return { suiteRunId: session.id, testRunId: testRun.id };
}

// ── Test Definitions (DB-first, YAML fallback) ──────────────
router.get('/', async (_req, res) => {
  const dbTests = await repo.listActiveTestDefs();
  if (dbTests.length > 0) {
    return res.json(dbTests);
  }
  // Fallback to YAML if DB is empty
  const yamlTests = loadAllTests();
  res.json(yamlTests);
});

// ── Create test ──────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const parsed = createTestSchema.parse(req.body);
    const id = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await repo.getTestDef(id);
    if (existing && existing.isActive) {
      return res.status(409).json({ error: `Test with id "${id}" already exists` });
    }
    await repo.createTestDef({
      id,
      name: parsed.name,
      url: parsed.url,
      instructions: parsed.instructions,
      expected_outcome: (parsed as any).expectedOutcome ?? '',
      category: (parsed as any).category ?? 'sanity',
      tags: (parsed as any).tags ?? [],
      requires_auth: (parsed as any).requiresAuth ?? false,
      max_turns: (parsed as any).maxTurns,
      timeout: (parsed as any).timeout ?? 120000,
      viewport: (parsed as any).viewport ?? { width: 1440, height: 900 },
      page: (parsed as any).page ?? '',
    });
    const created = await repo.getTestDef(id);
    res.status(201).json(created);
  } catch (err: any) {
    next(err);
  }
});

// ── Update test ──────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const parsed = updateTestSchema.parse(req.body);
    const test = await repo.getTestDef(req.params.id);
    if (!test || !test.isActive) {
      return res.status(404).json({ error: 'Test not found' });
    }
    // Increment version on edit — map camelCase fields to snake_case
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'expectedOutcome') updates['expected_outcome'] = v;
      else if (k === 'requiresAuth') updates['requires_auth'] = v;
      else if (k === 'maxTurns') updates['max_turns'] = v;
      else updates[k] = v;
    }
    await repo.incrementTestDefVersion(req.params.id, updates);
    const updated = await repo.getTestDef(req.params.id);
    res.json(updated);
  } catch (err: any) {
    next(err);
  }
});

// ── Delete test (soft delete) ────────────────────────────────
router.delete('/:id', async (req, res) => {
  const test = await repo.getTestDef(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found' });
  await repo.softDeleteTestDef(req.params.id);
  res.json({ success: true, message: `Test "${test.name}" deactivated` });
});

// ── Import tests from YAML → DB (creates new, skips existing) ─
router.post('/import-yaml', async (_req, res) => {
  try {
    const yamlTests = loadAllTests();
    let imported = 0;
    let skipped = 0;
    for (const t of yamlTests) {
      const existing = await repo.getTestDef(t.id);
      if (existing) { skipped++; continue; }
      await repo.createTestDef({
        id: t.id,
        name: t.name,
        url: t.url,
        instructions: t.instructions,
        expected_outcome: t.expected_outcome ?? '',
        category: t.category ?? 'sanity',
        tags: t.tags ?? [],
        requires_auth: t.requires_auth ?? false,
        max_turns: t.max_turns,
        timeout: t.timeout ?? 120000,
        viewport: t.viewport ?? { width: 1440, height: 900 },
        page: t.page ?? '',
      });
      imported++;
    }
    res.json({ success: true, imported, skipped, total: yamlTests.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync YAML → DB (updates existing + creates new) ──────────
router.post('/sync-yaml', async (_req, res) => {
  try {
    const yamlTests = loadAllTests();
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const t of yamlTests) {
      const data = {
        name: t.name,
        url: t.url,
        instructions: t.instructions,
        expected_outcome: t.expected_outcome ?? '',
        category: t.category ?? 'sanity',
        tags: t.tags ?? [],
        requires_auth: t.requires_auth ?? false,
        max_turns: t.max_turns,
        timeout: t.timeout ?? 120000,
        viewport: t.viewport ?? { width: 1440, height: 900 },
        page: t.page ?? '',
      };
      const existing = await repo.getTestDef(t.id);
      if (!existing) {
        await repo.createTestDef({ id: t.id, ...data });
        created++;
      } else {
        // Check if content changed or if test was deactivated
        const changed = existing.instructions !== data.instructions ||
          existing.expected_outcome !== data.expected_outcome ||
          existing.name !== data.name ||
          existing.url !== data.url ||
          !existing.isActive;
        if (changed) {
          await repo.incrementTestDefVersion(t.id, { ...data, is_active: true });
          updated++;
        } else {
          unchanged++;
        }
      }
    }

    // Deactivate DB entries whose YAML files no longer exist (handles renames/deletes)
    const yamlIds = new Set(yamlTests.map(t => t.id));
    const allDbTests = await repo.listActiveTestDefs();
    let deactivated = 0;
    for (const dbTest of allDbTests) {
      if (!yamlIds.has(dbTest.id)) {
        await repo.softDeleteTestDef(dbTest.id);
        deactivated++;
      }
    }

    res.json({ success: true, created, updated, unchanged, deactivated, total: yamlTests.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Import YAML file upload → DB ────────────────────────────
router.post('/import-file', async (req, res) => {
  try {
    const { filename, content } = req.body ?? {};
    if (!filename || !content) {
      return res.status(400).json({ error: 'filename and content are required' });
    }
    const { parse: parseYaml } = await import('yaml');
    const parsed = parseYaml(content);
    if (!parsed?.name || !parsed?.url || !parsed?.instructions) {
      return res.status(400).json({ error: 'YAML must have name, url, and instructions fields' });
    }
    const id = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
      filename.replace(/\.(yaml|yml)$/, '');

    const data = {
      name: parsed.name,
      url: parsed.url,
      instructions: parsed.instructions,
      expected_outcome: parsed.expected_outcome ?? '',
      category: parsed.category ?? 'sanity',
      tags: parsed.tags ?? [],
      requires_auth: parsed.requires_auth ?? false,
      max_turns: parsed.max_turns,
      timeout: parsed.timeout ?? 120000,
      viewport: parsed.viewport ?? { width: 1440, height: 900 },
      page: parsed.page ?? '',
    };

    const existing = await repo.getTestDef(id);
    if (existing) {
      await repo.incrementTestDefVersion(id, { ...data, is_active: true });
      const updatedDef = await repo.getTestDef(id);
      res.json({ ...updatedDef, action: 'updated' });
    } else {
      await repo.createTestDef({ id, ...data });
      const createdDef = await repo.getTestDef(id);
      res.status(201).json({ ...createdDef, action: 'created' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run from free-form prompt (ephemeral, no DB test def) ────
router.post('/prompt-run', async (req, res) => {
  try {
    const { prompt, url, headless = true } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
    }

    // Smart match: check if prompt matches an existing test definition
    // This way "test GHL and mindbody" runs the full YAML test instead of a raw prompt
    const promptLower = prompt.trim().toLowerCase();
    const allTests = loadAllTests();
    const matchedTest = allTests.find(t => {
      const name = t.name.toLowerCase();
      const tags = (t.tags || []).map((tag: string) => tag.toLowerCase());
      const words = promptLower.split(/\s+/);
      // Match if prompt contains significant words from test name or tags
      const nameWords = name.split(/[\s\-_]+/);
      const matchCount = words.filter(w =>
        w.length > 2 && (nameWords.some(nw => nw.includes(w) || w.includes(nw)) || tags.some(tag => tag.includes(w) || w.includes(tag)))
      ).length;
      return matchCount >= 2; // At least 2 meaningful words match
    });

    if (matchedTest) {
      // Run the matched YAML test directly — much more reliable than raw prompt
      console.log(`[prompt-run] Matched prompt "${prompt.slice(0, 40)}" to test: ${matchedTest.name}`);
      const sysSettings = await repo.getSettings();
      const result = await createAndEnqueueTestJob({
        testId: matchedTest.id,
        testName: matchedTest.name,
        testUrl: matchedTest.url,
        testInstructions: matchedTest.instructions,
        expectedOutcome: matchedTest.expected_outcome,
        headless,
        requiresAuth: matchedTest.requires_auth ?? true,
        maxTurns: matchedTest.max_turns || sysSettings.maxTurnsDefault,
        timeout: matchedTest.timeout || sysSettings.defaultTimeout,
        viewport: matchedTest.viewport,
      });
      return res.status(202).json({ ...result, matched: matchedTest.name });
    }

    // No match — run as free-form prompt
    const testUrl = (url && typeof url === 'string' && url.trim()) ? url.trim() : 'https://connectcloud.appypie.com/connects';
    const testName = `Prompt: ${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}`;
    const testId = `prompt-${Date.now()}`;

    // Load system settings for defaults
    const sysSettings = await repo.getSettings();

    // Wrap the user prompt with context so the model knows the environment
    const wrappedInstructions = `You are testing on Appy Pie Automate (connectcloud.appypie.com). If a login page appears, log in with the provided credentials.

USER TASK: ${prompt.trim()}

IMPORTANT CONTEXT:
- This is the Appy Pie Connect/Automate platform for creating workflow integrations
- The UI uses a canvas + side panel layout. Click cards to open their configuration panel on the right
- For account steps: if a Continue button is visible, click it (account is linked). If a dropdown exists, select the first account. Only click "Add an Account" as last resort
- For dropdowns with a small arrow icon (.menu_icon-box): click the icon, wait for options, select the first available
- For fields with "+ Add or Select": click to open the token picker, select the first available item
- If the page shows a loading spinner, wait 3 seconds
- NEVER click expand/fullscreen buttons, Guide icons, or "Forgot password"`;

    const result = await createAndEnqueueTestJob({
      testId,
      testName,
      testUrl,
      testInstructions: wrappedInstructions,
      expectedOutcome: 'Complete the described task successfully without errors. Report PASS if the task is done, FAIL if blocked.',
      headless,
      requiresAuth: true,  // Always require auth — Appy Pie tests need login
      maxTurns: Math.min(sysSettings.maxTurnsDefault, 50),
      timeout: sysSettings.defaultTimeout,
      viewport: { width: 1440, height: 900 },
    });

    res.status(202).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Run single test ───────────────────────────────────────────
router.post('/:testId/run', async (req, res) => {
  try {
    const { headless = true, maxTurnsOverride, resumeFromRunId } = req.body ?? {};

    // Validate maxTurnsOverride if provided
    if (maxTurnsOverride !== undefined) {
      const n = Number(maxTurnsOverride);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return res.status(400).json({ error: 'maxTurnsOverride must be an integer between 1 and 500' });
      }
    }

    // Load from DB first, fallback to YAML
    let testDef: any;
    const dbTest = await repo.getActiveTestDef(req.params.testId);
    if (dbTest) {
      testDef = dbTest;
    } else {
      testDef = loadTestById(req.params.testId);
    }
    if (!testDef) return res.status(404).json({ error: `Test not found: ${req.params.testId}` });

    // Load system settings for defaults
    const sysSettings = await repo.getSettings();

    // Create session with 1 test
    const session = await sessionService.createSession(1);
    if (!session) throw new Error('Failed to create session');
    const testRun = await testService.createTestRun(session.id, testDef.id, testDef.name);
    if (!testRun) throw new Error('Failed to create test run');

    const jobData: any = {
      sessionId: session.id,
      testRunId: testRun.id,
      testId: testDef.id,
      testName: testDef.name,
      testUrl: testDef.url,
      testInstructions: testDef.instructions,
      expectedOutcome: testDef.expected_outcome,
      headless,
      requiresAuth: testDef.requires_auth ?? false,
      maxTurns: maxTurnsOverride ?? (testDef.max_turns || sysSettings.maxTurnsDefault),
      timeout: testDef.timeout || sysSettings.defaultTimeout,
      viewport: testDef.viewport,
      cuaMode: testDef.cuaMode || undefined,
      // Forward declarative validation rules (if any) to the worker. The
      // CUA loop runs them after the model emits a verdict and overrides
      // PASS→FAIL when the system can't independently verify the outcome.
      validation: Array.isArray(testDef.validation) ? testDef.validation : undefined,
    };

    // If resuming from a timed-out run, attach page state + context
    if (resumeFromRunId) {
      const prevRun = await repo.getTestRun(resumeFromRunId) as any;
      if (prevRun && (prevRun.status === 'timeout' || prevRun.status === 'error')) {
        // Use captured pageState if available, fallback to last Step
        let lastUrl = prevRun.page_state?.url || '';
        let lastTitle = prevRun.page_state?.title || '';

        if (!lastUrl) {
          const lastStep = await repo.getLastStepForRun(resumeFromRunId);
          lastUrl = lastStep?.page_url || 'unknown';
          lastTitle = lastStep?.page_title || '';
        }

        const verdict = prevRun.model_verdict || '';

        let context = `Previous run used ${prevRun.turn_count} turns over ${Math.round((prevRun.duration_ms || 0) / 1000)}s before timing out.\n`;
        context += `Last page URL: ${lastUrl}\n`;
        if (lastTitle) context += `Last page title: ${lastTitle}\n`;
        if (verdict && !verdict.includes('Reached maximum turn limit')) {
          context += `\nModel's summary of what was accomplished:\n${verdict}`;
        }

        jobData.resumeFromUrl = lastUrl;
        jobData.resumeContext = context;

        // Pass storage state path for auth restoration
        if (prevRun.page_state?.storageStatePath) {
          jobData.resumeStorageStatePath = prevRun.page_state.storageStatePath;
        }
      }
    }

    const priorityMap: Record<string, number> = { smoke: 1, e2e: 2, regression: 3, sanity: 4 };
    const priority = priorityMap[testDef.category ?? 'sanity'] ?? 4;
    await testExecutionQueue.add(`test-${testDef.id}`, jobData, { priority });

    res.status(202).json({ suiteRunId: session.id, testRunId: testRun.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
