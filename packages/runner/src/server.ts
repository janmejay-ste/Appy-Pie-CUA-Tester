import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { authMiddleware } from './middleware/auth.js';
import { zodErrorHandler } from './middleware/error-handler.js';
import testsRouter from './routes/tests.js';
import suitesRouter from './routes/suites.js';
import runsRouter from './routes/runs.js';
import configRouter from './routes/config.js';
import metricsRouter from './routes/metrics.js';

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
      if (!origin || allowedOrigins.some(o => origin === o || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://10.') || origin.startsWith('http://192.168.'))) {
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

  // Request logging — skip health checks, polling (304s), and screenshot/video serving
  app.use(pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => {
        const url = req.url || '';
        // Skip health, screenshot assets, and video files
        if (url === '/health' || url.includes('/screenshots/') || url.includes('/video')) return true;
        return false;
      },
    },
    // Suppress full headers — only log method, url, status, responseTime
    serializers: {
      req: (req: any) => ({ method: req.method, url: req.url }),
      res: (res: any) => ({ statusCode: res.statusCode }),
    },
    // Don't log 304 Not Modified responses (dashboard polling noise)
    customLogLevel: (_req: any, res: any) => {
      if (res.statusCode === 304) return 'silent';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }));

  // ── Health (outside auth) ───────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Apply auth to all /api routes
  app.use('/api', authMiddleware);

  // ── Mount routers ──────────────────────────────────────────
  app.use('/api/tests', testsRouter);
  app.use('/api/suites', suitesRouter);
  app.use('/api/runs', runsRouter);
  app.use('/api', configRouter);    // /api/config/account, /api/settings
  app.use('/api', metricsRouter);   // /api/metrics, /api/dlq, /api/cleanup, /api/reset, /api/report/latest

  // ── Zod error handler ──────────────────────────────────────
  app.use(zodErrorHandler);

  return app;
}
