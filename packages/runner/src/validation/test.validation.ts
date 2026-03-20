import { z } from 'zod';

export const createTestSchema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters'),
  url: z.string().url('Must be a valid URL'),
  instructions: z.string().min(10, 'Instructions must be at least 10 characters'),
  expectedOutcome: z.string().min(5, 'Expected outcome must be at least 5 characters'),
  category: z.enum(['smoke', 'sanity', 'regression', 'e2e']).default('sanity'),
  tags: z.array(z.string()).default([]),
  requiresAuth: z.boolean().default(false),
  maxTurns: z.number().min(1).max(100).default(40),
  timeout: z.number().min(10000).max(600000).default(120000),
  viewport: z.object({
    width: z.number().min(320).max(3840),
    height: z.number().min(240).max(2160),
  }).default({ width: 1440, height: 900 }),
  page: z.string().default(''),
});

export const updateTestSchema = createTestSchema.partial();

export const settingsSchema = z.object({
  maxConcurrency: z.number().min(1).max(10).optional(),
  maxTurnsDefault: z.number().min(1).max(100).optional(),
  maxTokensPerSession: z.number().min(10000).optional(),
  defaultTimeout: z.number().min(10000).max(600000).optional(),
  defaultHeadless: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional(),
});
