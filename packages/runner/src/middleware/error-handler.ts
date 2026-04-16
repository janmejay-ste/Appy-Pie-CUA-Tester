import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/**
 * Express error-handling middleware that catches ZodError instances
 * and returns a 400 response with formatted validation issues.
 */
export function zodErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }
  next(err);
}
