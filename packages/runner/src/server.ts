import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { getTestAccount, updateTestAccount, maskPassword } from './config.js';
import { loadAllTests, loadTestById } from './test-loader.js';
import { testExecutionQueue, createSubscriber, type TestJobData } from './queue/queue.js';
import { abortTestRun } from './queue/worker.js';
import { TestRun } from './db/models/TestRun.js';
import { Event } from './db/models/Event.js';
import { TestDef } from './db/models/TestDef.js';
import { Settings, getSettings } from './db/models/Settings.js';
import { createTestSchema, updateTestSchema, settingsSchema } from './validation/test.validation.js';
import * as sessionService from './services/session.service.js';
import * as testService from './services/test.service.js';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Auth middleware ─────────────────────────────────────────
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = process.env.INTERNAL_API_KEY;
  // Skip auth if no key is configured (dev mode)
  if (!apiKey) return next();
  const provided = req.headers['x-api-key'] as string;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Allowed domains for CUA navigation ──────────────────────
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'appypieautomate.ai,connectcloud.appypie.com,appypie.com').split(',');

export function createServer(): express.Express {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // CORS — restrict to dashboard origins
  const allowedOrigins = (process.env.DASHBOARD_URL || 'http://localhost:3002').split(',');
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin || allowedOrigins.some(o => origin === o || origin.startsWith('http://localhost:') || origin.startsWith('http://10.'))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  }));

  // Rate limiting — 100 requests per minute per IP
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.use(express.json());

  // Apply auth to all /api routes
  app.use('/api', authMiddleware);

  // ── Health ─────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Observability Metrics ────────────────────────────────────
  app.get('/api/metrics', async (_req, res) => {
    try {
      const { getQueueMetrics } = await import('./queue/queue.js');
      const queueMetrics = await getQueueMetrics();

      // DB stats
      const totalSessions = await (await import('./db/models/Session.js')).Session.countDocuments();
      const totalRuns = await TestRun.countDocuments();
      const runsByStatus = await TestRun.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);

      // Token totals
      const tokenTotals = await TestRun.aggregate([
        { $group: {
          _id: null,
          totalInput: { $sum: '$inputTokens' },
          totalOutput: { $sum: '$outputTokens' },
          totalReasoning: { $sum: '$reasoningTokens' },
        }},
      ]);

      // Average latency (from completed runs)
      const avgLatency = await TestRun.aggregate([
        { $match: { durationMs: { $ne: null } } },
        { $group: { _id: null, avgMs: { $avg: '$durationMs' }, maxMs: { $max: '$durationMs' }, minMs: { $min: '$durationMs' } } },
      ]);

      // Failure rate
      const totalCompleted = runsByStatus.reduce((sum, r) => sum + (r._id !== 'queued' && r._id !== 'running' ? r.count : 0), 0);
      const totalFailed = runsByStatus.reduce((sum, r) => sum + (r._id === 'failed' || r._id === 'error' ? r.count : 0), 0);
      const failureRate = totalCompleted > 0 ? Math.round((totalFailed / totalCompleted) * 100) : 0;

      // Per-test metrics: failure rate + avg duration per test
      const perTestMetrics = await TestRun.aggregate([
        { $match: { status: { $nin: ['queued', 'running'] } } },
        { $group: {
          _id: '$testId',
          testName: { $first: '$testName' },
          totalRuns: { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ['$status', 'passed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'error']] }, 1, 0] } },
          timeouts: { $sum: { $cond: [{ $eq: ['$status', 'timeout'] }, 1, 0] } },
          avgDurationMs: { $avg: '$durationMs' },
          totalTokens: { $sum: { $add: ['$inputTokens', '$outputTokens'] } },
          lastRun: { $max: '$startedAt' },
        }},
        { $addFields: {
          failureRate: { $cond: [{ $gt: ['$totalRuns', 0] }, { $round: [{ $multiply: [{ $divide: ['$failed', '$totalRuns'] }, 100] }, 1] }, 0] },
        }},
        { $sort: { failureRate: -1 } },
      ]);

      res.json({
        queue: queueMetrics,
        database: {
          sessions: totalSessions,
          totalRuns,
          runsByStatus: Object.fromEntries(runsByStatus.map(r => [r._id, r.count])),
        },
        tokens: tokenTotals[0] ?? { totalInput: 0, totalOutput: 0, totalReasoning: 0 },
        latency: avgLatency[0] ?? { avgMs: 0, maxMs: 0, minMs: 0 },
        failureRate: `${failureRate}%`,
        perTest: perTestMetrics,
        uptime: process.uptime(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Metrics time-series ──────────────────────────────────────
  app.get('/api/metrics/history', async (req, res) => {
    try {
      const hours = Number(req.query.hours) || 24;
      const { getMetricsTimeSeries } = await import('./services/metrics.service.js');
      const data = await getMetricsTimeSeries(hours);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cleanup old data ──────────────────────────────────────────
  app.post('/api/cleanup', async (req, res) => {
    try {
      const { retentionDays = 7 } = req.body ?? {};
      const { cleanupOldRuns } = await import('./services/cleanup.service.js');
      const result = await cleanupOldRuns(retentionDays);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DLQ: list failed jobs with grouping ────────────────────────
  app.get('/api/dlq', async (_req, res) => {
    try {
      const { deadLetterQueue: dlq } = await import('./queue/queue.js');
      const jobs = await dlq.getWaiting(0, 100);
      const items = jobs.map(j => {
        const d = j.data as any;
        const error = d.error || '';
        const errorType = error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT') ? 'infra'
          : error.includes('CUA API') || error.includes('Safety check') ? 'api'
          : error.includes('aborted') ? 'aborted'
          : 'unknown';
        return {
          id: j.id,
          testId: d.testId,
          testName: d.testName,
          sessionId: d.sessionId,
          testRunId: d.testRunId,
          failedAt: d.failedAt,
          error,
          errorType,
          attempts: d.attempts,
        };
      });

      // Group by error type
      const grouped: Record<string, typeof items> = {};
      for (const item of items) {
        if (!grouped[item.errorType]) grouped[item.errorType] = [];
        grouped[item.errorType].push(item);
      }

      res.json({ total: items.length, grouped, items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DLQ: requeue a failed job (max 3 total attempts) ────────────
  app.post('/api/dlq/:jobId/requeue', async (req, res) => {
    try {
      const MAX_TOTAL_ATTEMPTS = 3;
      const { deadLetterQueue: dlq, testExecutionQueue: queue } = await import('./queue/queue.js');
      const job = await dlq.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found in DLQ' });

      const jobData = job.data as any;
      const totalAttempts = (jobData.totalAttempts ?? jobData.attempts ?? 1) + 1;

      if (totalAttempts > MAX_TOTAL_ATTEMPTS) {
        return res.status(400).json({
          error: `Max retry limit reached (${MAX_TOTAL_ATTEMPTS} total attempts). This job cannot be requeued.`,
          testName: jobData.testName,
          totalAttempts: totalAttempts - 1,
        });
      }

      // Clean DLQ metadata, track total attempts
      delete jobData.failedAt;
      delete jobData.error;
      delete jobData.attempts;
      jobData.totalAttempts = totalAttempts;

      await queue.add(`retry-${jobData.testId}`, jobData);
      await job.remove();

      res.json({ success: true, message: `Requeued job for test: ${jobData.testName} (attempt ${totalAttempts}/${MAX_TOTAL_ATTEMPTS})` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DLQ: clear all ──────────────────────────────────────────────
  app.delete('/api/dlq', async (_req, res) => {
    try {
      const { deadLetterQueue: dlq } = await import('./queue/queue.js');
      await dlq.obliterate({ force: true });
      res.json({ success: true, message: 'DLQ cleared' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Test Account Config ──────────────────────────────────────
  app.get('/api/config/account', (_req, res) => {
    const account = getTestAccount();
    res.json({
      email: account.email,
      passwordMasked: maskPassword(account.password),
    });
  });

  app.put('/api/config/account', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Both email and password are required' });
    }
    const updated = updateTestAccount(email, password);
    res.json({
      email: updated.email,
      passwordMasked: maskPassword(updated.password),
    });
  });

  // ── Test Definitions (DB-first, YAML fallback) ──────────────
  app.get('/api/tests', async (_req, res) => {
    const dbTests = await TestDef.find({ isActive: true }).sort({ name: 1 });
    if (dbTests.length > 0) {
      return res.json(dbTests.map(t => t.toJSON()));
    }
    // Fallback to YAML if DB is empty
    const yamlTests = loadAllTests();
    res.json(yamlTests);
  });

  // ── Create test ──────────────────────────────────────────────
  app.post('/api/tests', async (req, res) => {
    try {
      const parsed = createTestSchema.parse(req.body);
      const id = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const existing = await TestDef.findById(id);
      if (existing && existing.isActive) {
        return res.status(409).json({ error: `Test with id "${id}" already exists` });
      }
      const test = await TestDef.create({ _id: id, ...parsed });
      res.status(201).json(test.toJSON());
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update test ──────────────────────────────────────────────
  app.put('/api/tests/:id', async (req, res) => {
    try {
      const parsed = updateTestSchema.parse(req.body);
      const test = await TestDef.findById(req.params.id);
      if (!test || !test.isActive) {
        return res.status(404).json({ error: 'Test not found' });
      }
      // Increment version on edit
      await TestDef.updateOne(
        { _id: req.params.id },
        { $set: parsed, $inc: { version: 1 } },
      );
      const updated = await TestDef.findById(req.params.id);
      res.json(updated!.toJSON());
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete test (soft delete) ────────────────────────────────
  app.delete('/api/tests/:id', async (req, res) => {
    const test = await TestDef.findById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    await TestDef.updateOne({ _id: req.params.id }, { $set: { isActive: false } });
    res.json({ success: true, message: `Test "${test.name}" deactivated` });
  });

  // ── Import tests from YAML → DB (creates new, skips existing) ─
  app.post('/api/tests/import-yaml', async (_req, res) => {
    try {
      const yamlTests = loadAllTests();
      let imported = 0;
      let skipped = 0;
      for (const t of yamlTests) {
        const existing = await TestDef.findById(t.id);
        if (existing) { skipped++; continue; }
        await TestDef.create({
          _id: t.id,
          name: t.name,
          url: t.url,
          instructions: t.instructions,
          expectedOutcome: t.expected_outcome,
          category: t.category ?? 'sanity',
          tags: t.tags ?? [],
          requiresAuth: t.requires_auth ?? false,
          ...(t.max_turns ? { maxTurns: t.max_turns } : {}),
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
  app.post('/api/tests/sync-yaml', async (_req, res) => {
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
          expectedOutcome: t.expected_outcome,
          category: t.category ?? 'sanity',
          tags: t.tags ?? [],
          requiresAuth: t.requires_auth ?? false,
          ...(t.max_turns ? { maxTurns: t.max_turns } : {}),
          timeout: t.timeout ?? 120000,
          viewport: t.viewport ?? { width: 1440, height: 900 },
          page: t.page ?? '',
        };
        const existing = await TestDef.findById(t.id);
        if (!existing) {
          await TestDef.create({ _id: t.id, ...data });
          created++;
        } else {
          // Check if content changed
          const changed = existing.instructions !== data.instructions ||
            existing.expectedOutcome !== data.expectedOutcome ||
            existing.name !== data.name ||
            existing.url !== data.url;
          if (changed) {
            await TestDef.updateOne({ _id: t.id }, { $set: data, $inc: { version: 1 } });
            updated++;
          } else {
            unchanged++;
          }
        }
      }

      // Deactivate DB entries whose YAML files no longer exist (handles renames/deletes)
      const yamlIds = new Set(yamlTests.map(t => t.id));
      const allDbTests = await TestDef.find({ isActive: true });
      let deactivated = 0;
      for (const dbTest of allDbTests) {
        if (!yamlIds.has(dbTest._id)) {
          await TestDef.updateOne({ _id: dbTest._id }, { $set: { isActive: false } });
          deactivated++;
        }
      }

      res.json({ success: true, created, updated, unchanged, deactivated, total: yamlTests.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Import YAML file upload → DB ────────────────────────────
  app.post('/api/tests/import-file', async (req, res) => {
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
        expectedOutcome: parsed.expected_outcome ?? '',
        category: parsed.category ?? 'sanity',
        tags: parsed.tags ?? [],
        requiresAuth: parsed.requires_auth ?? false,
        ...(parsed.max_turns ? { maxTurns: parsed.max_turns } : {}),
        timeout: parsed.timeout ?? 120000,
        viewport: parsed.viewport ?? { width: 1440, height: 900 },
        page: parsed.page ?? '',
      };

      const existing = await TestDef.findById(id);
      if (existing) {
        await TestDef.updateOne({ _id: id }, { $set: { ...data, isActive: true }, $inc: { version: 1 } });
        const updated = await TestDef.findById(id);
        res.json({ ...updated!.toJSON(), action: 'updated' });
      } else {
        const created = await TestDef.create({ _id: id, ...data });
        res.status(201).json({ ...created.toJSON(), action: 'created' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── System Settings ──────────────────────────────────────────
  app.get('/api/settings', async (_req, res) => {
    const settings = await getSettings();
    res.json(settings);
  });

  app.put('/api/settings', async (req, res) => {
    try {
      const parsed = settingsSchema.parse(req.body);
      await Settings.updateOne({ _id: 'global' }, { $set: parsed }, { upsert: true });
      const updated = await getSettings();
      res.json(updated);
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ── Run full suite ────────────────────────────────────────────
  app.post('/api/suites', async (req, res) => {
    try {
      // Backpressure — reject if queue is overloaded
      const MAX_QUEUE_SIZE = 50;
      const { getQueueMetrics } = await import('./queue/queue.js');
      const metrics = await getQueueMetrics();
      if (metrics.waiting + metrics.active > MAX_QUEUE_SIZE) {
        return res.status(429).json({
          error: `Queue is full (${metrics.waiting} waiting, ${metrics.active} active). Try again later.`,
        });
      }

      const { testIds, headless = true, skipDupeCheck = false } = req.body ?? {};

      // Deduplication — reject if any test already has an active run
      if (!skipDupeCheck) {
        const activeRuns = await TestRun.find({
          status: { $in: ['queued', 'running'] },
        }).lean();
        const activeTestIds = new Set(activeRuns.map(r => r.testId));
        const requestedIds = testIds ?? (await TestDef.find({ isActive: true }).lean()).map((t: any) => t._id);
        const dupes = requestedIds.filter((id: string) => activeTestIds.has(id));
        if (dupes.length > 0) {
          return res.status(409).json({
            error: `${dupes.length} test(s) already running/queued: ${dupes.slice(0, 5).join(', ')}`,
            duplicates: dupes,
          });
        }
      }

      // Load tests from DB first, fallback to YAML
      let allTests: any[];
      const dbTests = await TestDef.find({ isActive: true }).sort({ name: 1 }).lean();
      if (dbTests.length > 0) {
        allTests = dbTests.map(t => ({
          id: t._id,
          name: t.name,
          url: t.url,
          instructions: t.instructions,
          expected_outcome: t.expectedOutcome,
          category: t.category,
          tags: t.tags,
          requires_auth: t.requiresAuth,
          max_turns: t.maxTurns,
          timeout: t.timeout,
          viewport: t.viewport,
        }));
      } else {
        allTests = loadAllTests();
      }

      const tests = testIds
        ? allTests.filter((t: any) => testIds.includes(t.id))
        : allTests;

      if (tests.length === 0) return res.status(400).json({ error: 'No tests to run' });

      // Load system settings for defaults
      const sysSettings = await getSettings();

      // Create session
      const session = await sessionService.createSession(tests.length);

      // Create test runs and queue jobs
      for (const testDef of tests) {
        const testRun = await testService.createTestRun(session._id, testDef.id, testDef.name);

        const jobData: any = {
          sessionId: session._id,
          testRunId: testRun._id,
          testId: testDef.id,
          testName: testDef.name,
          testUrl: testDef.url,
          testInstructions: testDef.instructions,
          expectedOutcome: testDef.expected_outcome,
          headless,
          requiresAuth: testDef.requires_auth ?? false,
          maxTurns: testDef.max_turns || sysSettings.maxTurnsDefault,
          timeout: testDef.timeout || sysSettings.defaultTimeout,
          viewport: testDef.viewport,
          cuaMode: testDef.cuaMode || undefined,
        };
        // Priority: smoke=1 (highest), e2e=2, regression=3, sanity=4 (lowest)
        const priorityMap: Record<string, number> = { smoke: 1, e2e: 2, regression: 3, sanity: 4 };
        const priority = priorityMap[testDef.category ?? 'sanity'] ?? 4;
        await testExecutionQueue.add(`test-${testDef.id}`, jobData, { priority });
      }

      res.status(202).json({ suiteRunId: session._id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Run single test ───────────────────────────────────────────
  app.post('/api/tests/:testId/run', async (req, res) => {
    try {
      const { headless = true, maxTurnsOverride, resumeFromRunId } = req.body ?? {};

      // Load from DB first, fallback to YAML
      let testDef: any;
      const dbTest = await TestDef.findOne({ _id: req.params.testId, isActive: true }).lean();
      if (dbTest) {
        testDef = {
          id: dbTest._id,
          name: dbTest.name,
          url: dbTest.url,
          instructions: dbTest.instructions,
          expected_outcome: dbTest.expectedOutcome,
          category: dbTest.category,
          tags: dbTest.tags,
          requires_auth: dbTest.requiresAuth,
          max_turns: dbTest.maxTurns,
          timeout: dbTest.timeout,
          viewport: dbTest.viewport,
        };
      } else {
        testDef = loadTestById(req.params.testId);
      }
      if (!testDef) return res.status(404).json({ error: `Test not found: ${req.params.testId}` });

      // Load system settings for defaults
      const sysSettings = await getSettings();

      // Create session with 1 test
      const session = await sessionService.createSession(1);
      const testRun = await testService.createTestRun(session._id, testDef.id, testDef.name);

      const jobData: any = {
        sessionId: session._id,
        testRunId: testRun._id,
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
      };

      // If resuming from a timed-out run, attach page state + context
      if (resumeFromRunId) {
        const prevRun = await TestRun.findById(resumeFromRunId).lean() as any;
        if (prevRun) {
          // Use captured pageState if available, fallback to last Step
          let lastUrl = prevRun.pageState?.url || '';
          let lastTitle = prevRun.pageState?.title || '';

          if (!lastUrl) {
            const { Step } = await import('./db/models/Step.js');
            const lastStep = await Step.findOne({ testRunId: resumeFromRunId })
              .sort({ turnNumber: -1 }).lean();
            lastUrl = lastStep?.pageUrl || 'unknown';
            lastTitle = lastStep?.pageTitle || '';
          }

          const verdict = prevRun.modelVerdict || '';

          let context = `Previous run used ${prevRun.turnCount} turns over ${Math.round((prevRun.durationMs || 0) / 1000)}s before timing out.\n`;
          context += `Last page URL: ${lastUrl}\n`;
          if (lastTitle) context += `Last page title: ${lastTitle}\n`;
          if (verdict && !verdict.includes('Reached maximum turn limit')) {
            context += `\nModel's summary of what was accomplished:\n${verdict}`;
          }

          jobData.resumeFromUrl = lastUrl;
          jobData.resumeContext = context;

          // Pass storage state path for auth restoration
          if (prevRun.pageState?.storageStatePath) {
            jobData.resumeStorageStatePath = prevRun.pageState.storageStatePath;
          }
        }
      }

      const priorityMap: Record<string, number> = { smoke: 1, e2e: 2, regression: 3, sanity: 4 };
      const priority = priorityMap[testDef.category ?? 'sanity'] ?? 4;
      await testExecutionQueue.add(`test-${testDef.id}`, jobData, { priority });

      res.status(202).json({ suiteRunId: session._id, testRunId: testRun._id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Abort a running test ─────────────────────────────────────
  app.post('/api/runs/:runId/abort', async (_req, res) => {
    const runId = _req.params.runId;
    console.log(`[api] Abort requested for run: ${runId}`);
    abortTestRun(runId);

    // Also remove from queue if still queued (not yet picked up by worker)
    const waitingJobs = await testExecutionQueue.getJobs(['waiting', 'delayed']);
    for (const job of waitingJobs) {
      if (job.data?.testRunId === runId) {
        await job.remove();
        await TestRun.updateOne({ _id: runId }, { $set: { status: 'aborted', completedAt: new Date(), error: 'Aborted by user (removed from queue)' } });
        console.log(`[api] Removed queued job ${job.id} for run ${runId}`);
      }
    }

    res.json({ success: true, message: 'Run abort signal sent' });
  });

  // ── Abort all running tests in a suite/session ──────────────
  app.post('/api/suites/:suiteId/abort', async (req, res) => {
    const runs = await TestRun.find({
      sessionId: req.params.suiteId,
      status: { $in: ['running', 'queued'] },
    }).lean();

    let aborted = 0;
    for (const run of runs) {
      abortTestRun(run._id);
      aborted++;
    }
    res.json({ success: true, abortedCount: aborted });
  });

  // ── List suite runs (history) ─────────────────────────────────
  app.get('/api/suites', async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const sessions = await sessionService.listSessions(limit);
    res.json(sessions.map(s => s.toJSON()));
  });

  // ── Get suite/session detail ──────────────────────────────────
  app.get('/api/suites/:suiteId', async (req, res) => {
    const data = await sessionService.getSession(req.params.suiteId);
    if (!data) return res.status(404).json({ error: 'Suite not found' });
    // Transform session for backward compat
    const session = await (await import('./db/models/Session.js')).Session.findById(req.params.suiteId);
    res.json({ ...session!.toJSON(), testRuns: data.testRuns });
  });

  // ── Get latest run per test (aggregated across all suites) ────
  // IMPORTANT: must be before /api/runs/:runId to avoid :runId matching "latest"
  app.get('/api/runs/latest', async (_req, res) => {
    const runs = await testService.getLatestRuns();
    res.json(runs);
  });

  // ── Get test run detail ───────────────────────────────────────
  app.get('/api/runs/:runId', async (req, res) => {
    const detail = await testService.getTestRunDetail(req.params.runId);
    if (!detail) return res.status(404).json({ error: 'Run not found' });
    res.json(detail);
  });

  // ── Serve screenshot files (path traversal protected) ────────
  app.get('/api/runs/:runId/screenshots/:filename', async (req, res) => {
    const run = await TestRun.findById(req.params.runId).lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // Reject path traversal attempts
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.png')) return res.status(400).json({ error: 'Invalid file type' });

    const baseDir = path.resolve('data', 'screenshots');
    let filePath = path.resolve(baseDir, run.testId, req.params.runId, filename);
    if (!filePath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });

    if (!fs.existsSync(filePath)) {
      filePath = path.resolve(baseDir, req.params.runId, filename);
      if (!filePath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(filePath);
  });

  // ── Serve test run video (path traversal protected) ───────────
  app.get('/api/runs/:runId/video', async (req, res) => {
    const run = await TestRun.findById(req.params.runId).lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const baseDir = path.resolve('data', 'screenshots');
    const videoPath = path.resolve(baseDir, run.testId, req.params.runId, 'replay.mp4');
    if (!videoPath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    res.sendFile(videoPath);
  });

  // ── SSE: live events for a running test (via Redis pub/sub) ───
  // Supports Last-Event-ID for reconnection replay
  app.get('/api/runs/:runId/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Support reconnection — only send events after lastEventId
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    const lastSeq = lastEventId ? parseInt(lastEventId, 10) : 0;

    // Send existing events (all or only after lastSeq for reconnection)
    const query: any = { testRunId: req.params.runId };
    if (lastSeq > 0) query.sequence = { $gt: lastSeq };
    const existingEvents = await Event.find(query).sort({ sequence: 1 });
    for (const event of existingEvents) {
      const json = event.toJSON();
      res.write(`id: ${json.sequence}\ndata: ${JSON.stringify(json)}\n\n`);
    }

    // Check if run is still active
    const run = await TestRun.findById(req.params.runId).lean();
    if (!run || run.completedAt) {
      res.write(`data: ${JSON.stringify({ type: 'stream_end', message: 'Run is not active' })}\n\n`);
      return;
    }

    // Subscribe to Redis pub/sub for live events
    const subscriber = createSubscriber();
    const channel = `events:${req.params.runId}`;
    await subscriber.subscribe(channel);

    subscriber.on('message', (_ch: string, message: string) => {
      res.write(`data: ${message}\n\n`);
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'run_completed' || parsed.type === 'run_failed') {
          res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
          subscriber.unsubscribe(channel).catch(() => {});
          subscriber.disconnect();
        }
      } catch { /* ignore parse errors */ }
    });

    req.on('close', () => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    });
  });

  // ── Reset all data (clear MongoDB + delete screenshots) ──────
  app.post('/api/reset', async (_req, res) => {
    try {
      await sessionService.resetAll();
      res.json({ success: true, message: 'All test data and screenshots have been reset' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Generate HTML report for a single test run ─────────────────
  app.get('/api/runs/:runId/report', async (req, res) => {
    const detail = await testService.getTestRunDetail(req.params.runId);
    if (!detail) return res.status(404).json({ error: 'Run not found' });

    const run = detail as any;
    const screenshots = detail.screenshots as Array<Record<string, any>>;

    // Embed screenshots as base64
    const screenshotImages = screenshots.map((ss: Record<string, any>) => {
      const fname = ss.file_path?.replace(/\\/g, '/').split('/').pop();
      let filePath = path.resolve('data', 'screenshots', run.test_id, req.params.runId, fname);
      if (!fs.existsSync(filePath)) {
        filePath = path.resolve('data', 'screenshots', req.params.runId, fname);
      }
      let dataUri = '';
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        dataUri = `data:image/png;base64,${buf.toString('base64')}`;
      }
      return { turn_number: ss.turn_number, page_title: ss.page_title, page_url: ss.page_url, dataUri };
    });

    const statusColors: Record<string, string> = {
      passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308', running: '#3b82f6',
    };
    const statusColor = statusColors[run.status] || '#6b7280';
    const duration = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : 'N/A';
    const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : 'N/A';
    const completedAt = run.completed_at ? new Date(run.completed_at).toLocaleString() : 'N/A';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report - ${escapeHtml(run.test_name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; padding: 40px; }
  .container { max-width: 1000px; margin: 0 auto; }
  .header { background: #0f172a; color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { display: flex; gap: 24px; flex-wrap: wrap; font-size: 14px; color: #94a3b8; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; background: ${statusColor}; text-transform: uppercase; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: #0f172a; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .section { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
  .verdict { background: #f1f5f9; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; line-height: 1.7; }
  .error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #dc2626; white-space: pre-wrap; }
  .screenshot-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .screenshot-item { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .screenshot-item .info { padding: 8px 12px; background: #f8fafc; font-size: 12px; color: #64748b; display: flex; justify-content: space-between; }
  .screenshot-item img { width: 100%; display: block; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  @media print { body { padding: 20px; } .screenshot-item img { max-height: 400px; object-fit: contain; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <h1>${escapeHtml(run.test_name)}</h1>
      <span class="status-badge">${escapeHtml(run.status)}</span>
    </div>
    <div class="meta">
      <span>Run ID: ${escapeHtml(run.id)}</span>
      <span>Started: ${startedAt}</span>
      <span>Completed: ${completedAt}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value">${duration}</div><div class="label">Duration</div></div>
    <div class="stat-card"><div class="value">${run.turn_count}</div><div class="label">Turns</div></div>
    <div class="stat-card"><div class="value">${screenshots.length}</div><div class="label">Screenshots</div></div>
    <div class="stat-card"><div class="value">${run.input_tokens?.toLocaleString() ?? 0}</div><div class="label">Input Tokens</div></div>
    <div class="stat-card"><div class="value">${run.output_tokens?.toLocaleString() ?? 0}</div><div class="label">Output Tokens</div></div>
    <div class="stat-card"><div class="value">${run.reasoning_tokens?.toLocaleString() ?? 0}</div><div class="label">Reasoning Tokens</div></div>
  </div>

  ${run.model_verdict ? `
  <div class="section">
    <h2>Model Verdict</h2>
    <div class="verdict">${escapeHtml(run.model_verdict)}</div>
  </div>` : ''}

  ${run.error ? `
  <div class="section">
    <h2>Error</h2>
    <div class="error-box">${escapeHtml(run.error)}</div>
  </div>` : ''}

  ${screenshotImages.length > 0 ? `
  <div class="section">
    <h2>Screenshots (${screenshotImages.length})</h2>
    <div class="screenshot-grid">
      ${screenshotImages.map((ss, i) => `
      <div class="screenshot-item">
        <div class="info">
          <span>Turn ${ss.turn_number} ${i === 0 ? '(Initial)' : i === screenshotImages.length - 1 ? '(Final)' : ''}</span>
          <span>${ss.page_title ? escapeHtml(ss.page_title) : ''}${ss.page_url ? ' &mdash; ' + escapeHtml(ss.page_url) : ''}</span>
        </div>
        ${ss.dataUri ? `<img src="${ss.dataUri}" alt="Turn ${ss.turn_number}" />` : '<div style="padding:32px;text-align:center;color:#94a3b8;">Screenshot not available</div>'}
      </div>`).join('')}
    </div>
  </div>` : ''}

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner Report
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="report-${run.test_name.replace(/[^a-zA-Z0-9]/g, '-')}-${req.params.runId.slice(0, 8)}.html"`);
    res.send(html);
  });

  // ── Generate HTML report for a suite run ──────────────────────
  app.get('/api/suites/:suiteId/report', async (req, res) => {
    const data = await sessionService.getSession(req.params.suiteId);
    if (!data) return res.status(404).json({ error: 'Suite not found' });

    const session = await (await import('./db/models/Session.js')).Session.findById(req.params.suiteId);
    if (!session) return res.status(404).json({ error: 'Suite not found' });

    const suite = session.toJSON() as Record<string, any>;
    const testRuns = data.testRuns as Array<Record<string, any>>;

    const passRate = suite.total > 0 ? Math.round((suite.passed / suite.total) * 100) : 0;
    const startedAt = suite.started_at ? new Date(suite.started_at).toLocaleString() : 'N/A';
    const completedAt = suite.completed_at ? new Date(suite.completed_at).toLocaleString() : 'N/A';

    const statusColors: Record<string, string> = {
      passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308',
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Suite Report - ${escapeHtml(suite.id.slice(0, 8))}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; padding: 40px; }
  .container { max-width: 1000px; margin: 0 auto; }
  .header { background: #0f172a; color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { font-size: 14px; color: #94a3b8; display: flex; gap: 24px; flex-wrap: wrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .section { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
  .run-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .run-table th { text-align: left; padding: 10px 12px; background: #f8fafc; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; }
  .run-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
  .run-table tr:hover { background: #f8fafc; }
  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; color: white; text-transform: uppercase; }
  .verdict-preview { font-family: monospace; font-size: 12px; color: #64748b; max-height: 60px; overflow: hidden; margin-top: 8px; white-space: pre-wrap; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Test Suite Report</h1>
    <div class="meta">
      <span>Suite ID: ${escapeHtml(suite.id.slice(0, 8))}</span>
      <span>Started: ${startedAt}</span>
      <span>Completed: ${completedAt}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value" style="color:#0f172a">${suite.total}</div><div class="label">Total Tests</div></div>
    <div class="stat-card"><div class="value" style="color:#10b981">${suite.passed}</div><div class="label">Passed</div></div>
    <div class="stat-card"><div class="value" style="color:#ef4444">${suite.failed}</div><div class="label">Failed</div></div>
    <div class="stat-card"><div class="value" style="color:#f97316">${suite.errors}</div><div class="label">Errors</div></div>
    <div class="stat-card"><div class="value" style="color:#eab308">${suite.timeouts}</div><div class="label">Timeouts</div></div>
    <div class="stat-card"><div class="value" style="color:${passRate >= 80 ? '#10b981' : passRate >= 50 ? '#eab308' : '#ef4444'}">${passRate}%</div><div class="label">Pass Rate</div></div>
  </div>

  <div class="section">
    <h2>Test Results</h2>
    <table class="run-table">
      <thead><tr><th>Test Name</th><th>Status</th><th>Duration</th><th>Turns</th><th>Tokens</th></tr></thead>
      <tbody>
        ${testRuns.map(r => `<tr>
          <td style="font-weight:500;">${escapeHtml(r.test_name)}</td>
          <td><span class="status-badge" style="background:${statusColors[r.status] || '#6b7280'}">${escapeHtml(r.status)}</span></td>
          <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '--'}</td>
          <td>${r.turn_count}</td>
          <td style="font-size:12px;color:#64748b;">${r.input_tokens > 0 ? (r.input_tokens / 1000).toFixed(1) + 'k / ' + (r.output_tokens / 1000).toFixed(1) + 'k' : '--'}</td>
        </tr>
        ${r.model_verdict ? `<tr><td colspan="5"><div class="verdict-preview">${escapeHtml(r.model_verdict.slice(0, 300))}${r.model_verdict.length > 300 ? '...' : ''}</div></td></tr>` : ''}
        ${r.error ? `<tr><td colspan="5"><div style="color:#dc2626;font-size:12px;font-family:monospace;padding:4px 0;">${escapeHtml(r.error.slice(0, 200))}</div></td></tr>` : ''}`).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner Suite Report
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="suite-report-${req.params.suiteId.slice(0, 8)}.html"`);
    res.send(html);
  });

  // ── Get all test runs for a suite (polling alternative) ───────
  app.get('/api/suites/:suiteId/runs', async (req, res) => {
    const runs = await TestRun.find({ sessionId: req.params.suiteId }).sort({ startedAt: 1 });
    res.json(runs.map(r => r.toJSON()));
  });

  // ── Generate aggregated HTML report (matches dashboard view) ───
  app.get('/api/report/latest', async (_req, res) => {
    const testRuns = await testService.getLatestRuns();

    if (testRuns.length === 0) return res.status(404).json({ error: 'No test data available' });

    const total = testRuns.length;
    const passed = testRuns.filter(r => r.status === 'passed').length;
    const failed = testRuns.filter(r => r.status === 'failed').length;
    const errors = testRuns.filter(r => r.status === 'error').length;
    const timeouts = testRuns.filter(r => r.status === 'timeout').length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    const statusColors: Record<string, string> = {
      passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308',
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Dashboard Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; padding: 40px; }
  .container { max-width: 1000px; margin: 0 auto; }
  .header { background: #0f172a; color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { font-size: 14px; color: #94a3b8; display: flex; gap: 24px; flex-wrap: wrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .section { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
  .run-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .run-table th { text-align: left; padding: 10px 12px; background: #f8fafc; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; }
  .run-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
  .run-table tr:hover { background: #f8fafc; }
  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; color: white; text-transform: uppercase; }
  .verdict-preview { font-family: monospace; font-size: 12px; color: #64748b; max-height: 80px; overflow: hidden; margin-top: 8px; white-space: pre-wrap; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>QA Dashboard Report</h1>
    <div class="meta">
      <span>Latest results per test case (aggregated across all runs)</span>
      <span>Generated: ${new Date().toLocaleString()}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value" style="color:#0f172a">${total}</div><div class="label">Total Tests</div></div>
    <div class="stat-card"><div class="value" style="color:#10b981">${passed}</div><div class="label">Passed</div></div>
    <div class="stat-card"><div class="value" style="color:#ef4444">${failed}</div><div class="label">Failed</div></div>
    <div class="stat-card"><div class="value" style="color:#f97316">${errors}</div><div class="label">Errors</div></div>
    <div class="stat-card"><div class="value" style="color:#eab308">${timeouts}</div><div class="label">Timeouts</div></div>
    <div class="stat-card"><div class="value" style="color:${passRate >= 80 ? '#10b981' : passRate >= 50 ? '#eab308' : '#ef4444'}">${passRate}%</div><div class="label">Pass Rate</div></div>
  </div>

  <div class="section">
    <h2>Test Results</h2>
    <table class="run-table">
      <thead><tr><th>Test Name</th><th>Status</th><th>Duration</th><th>Turns</th><th>Tokens</th></tr></thead>
      <tbody>
        ${testRuns.map(r => `<tr>
          <td style="font-weight:500;">${escapeHtml(r.test_name)}</td>
          <td><span class="status-badge" style="background:${statusColors[r.status] || '#6b7280'}">${escapeHtml(r.status)}</span></td>
          <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '--'}</td>
          <td>${r.turn_count}</td>
          <td style="font-size:12px;color:#64748b;">${r.input_tokens > 0 ? (r.input_tokens / 1000).toFixed(1) + 'k / ' + (r.output_tokens / 1000).toFixed(1) + 'k' : '--'}</td>
        </tr>
        ${r.model_verdict ? `<tr><td colspan="5"><div class="verdict-preview">${escapeHtml(r.model_verdict.slice(0, 500))}${r.model_verdict.length > 500 ? '...' : ''}</div></td></tr>` : ''}
        ${r.error ? `<tr><td colspan="5"><div style="color:#dc2626;font-size:12px;font-family:monospace;padding:4px 0;">${escapeHtml(r.error.slice(0, 300))}</div></td></tr>` : ''}`).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner &mdash; QA Dashboard Report
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="qa-dashboard-report-${new Date().toISOString().slice(0, 10)}.html"`);
    res.send(html);
  });

  return app;
}
