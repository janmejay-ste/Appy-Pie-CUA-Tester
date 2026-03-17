import fs from 'fs';
import path from 'path';
import type { AppConfig, TestAccountConfig } from './types.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'data', 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  defaultTestAccount: {
    email: process.env.DEFAULT_TEST_EMAIL || 'vexelsadas993221312dsada@yopmail.com',
    password: process.env.DEFAULT_TEST_PASSWORD || 'Hancock1!',
  },
};

export function getConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        defaultTestAccount: {
          ...DEFAULT_CONFIG.defaultTestAccount,
          ...parsed.defaultTestAccount,
        },
      };
    }
  } catch (err) {
    console.error('[config] Error reading config, using defaults:', err);
  }

  // Create default config file
  saveConfig(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function getTestAccount(): TestAccountConfig {
  return getConfig().defaultTestAccount;
}

export function updateTestAccount(email: string, password: string): TestAccountConfig {
  const config = getConfig();
  config.defaultTestAccount = { email, password };
  saveConfig(config);
  return config.defaultTestAccount;
}

function saveConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/** Mask a password for display: show first 3 + last 1 chars */
export function maskPassword(pw: string): string {
  if (pw.length <= 4) return '****';
  return pw.slice(0, 3) + '*'.repeat(pw.length - 4) + pw.slice(-1);
}
