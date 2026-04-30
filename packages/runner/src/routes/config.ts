import { Router } from 'express';
import { getTestAccount, updateTestAccount, maskPassword } from '../config.js';
import * as repo from '../db/repo.js';
import { settingsSchema } from '../validation/test.validation.js';

const router = Router();

// ── Test Account Config ──────────────────────────────────────
router.get('/config/account', (_req, res) => {
  const account = getTestAccount();
  res.json({
    email: account.email,
    passwordMasked: maskPassword(account.password),
  });
});

router.put('/config/account', (req, res) => {
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

// ── System Settings ──────────────────────────────────────────
router.get('/settings', async (_req, res) => {
  const settings = await repo.getSettings();
  res.json(settings);
});

router.put('/settings', async (req, res, next) => {
  try {
    const parsed = settingsSchema.parse(req.body);
    await repo.updateSettings(parsed);
    const updated = await repo.getSettings();
    res.json(updated);
  } catch (err: any) {
    next(err);
  }
});

export default router;
