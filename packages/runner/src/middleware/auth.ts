import type { Request, Response, NextFunction } from 'express';

/**
 * Auth middleware — validates x-api-key header against INTERNAL_API_KEY env var.
 * In dev mode (no key configured), requests pass through with a production warning.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.INTERNAL_API_KEY;
  // Skip auth if no key is configured (dev mode) — warn in production
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Server misconfigured: INTERNAL_API_KEY not set' });
    }
    return next();
  }
  const provided = req.headers['x-api-key'] as string;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
