import playwright from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

const { chromium } = playwright;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

// Realistic Chrome user-agent string so servers that fingerprint by UA don't
// flag us as HeadlessChrome. Matches stable Chrome on Windows 10 (common).
const REAL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Stealth init script — runs before every page-script on every navigation.
 * Patches the three most common anti-bot detection signals:
 *   1. navigator.webdriver === true  → most reliable automation tell
 *   2. navigator.plugins.length === 0 → headless Chrome has no plugins by default
 *   3. navigator.languages === []     → headless often has empty languages
 *   4. navigator.permissions misreport → some detectors probe this
 *
 * Intentionally MINIMAL — not a full stealth suite (playwright-extra-plugin-stealth
 * does much more). These three + a realistic UA fix the common "blank page on
 * accounts.appypie.com" symptom without breaking legitimate pages.
 */
const STEALTH_INIT_SCRIPT = `
  (() => {
    // 1. navigator.webdriver — must be undefined, not true
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (e) {}

    // 2. navigator.plugins — fake a few entries so length > 0
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const fake = [1, 2, 3, 4, 5];
          Object.setPrototypeOf(fake, PluginArray.prototype);
          return fake;
        },
      });
    } catch (e) {}

    // 3. navigator.languages — non-empty array
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    } catch (e) {}

    // 4. permissions — anti-bot checks for "notifications" permission mismatch
    try {
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => (
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
        );
      }
    } catch (e) {}

    // 5. chrome.runtime — some fingerprints check this exists
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) window.chrome.runtime = {};
    } catch (e) {}
  })();
`;

export async function launchBrowser(
  url: string,
  viewport = DEFAULT_VIEWPORT,
  headless = true,
  storageStatePath?: string,
): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless,
    args: [
      '--start-maximized',
      '--disable-extensions',
      '--disable-file-system',
      // Stealth flags — remove obvious automation fingerprints.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      '--no-first-run',
      '--disable-infobars',
      '--disable-dev-shm-usage',
    ],
  });

  const contextOptions: any = {
    viewport: headless ? viewport : null,
    ...(headless ? {} : { noDefaultViewport: true }),
    // Realistic user-agent so servers that fingerprint by UA don't flag us.
    userAgent: REAL_USER_AGENT,
    // Locale + timezone match the UA's implied origin (Windows/EN-US).
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };

  // Restore browser storage state (cookies + localStorage) for resumed runs
  if (storageStatePath) {
    const fs = await import('fs');
    if (fs.existsSync(storageStatePath)) {
      contextOptions.storageState = storageStatePath;
      console.log('[browser] Restored storage state from:', storageStatePath);
    }
  }

  const context = await browser.newContext(contextOptions);
  // Inject stealth script into every page in this context BEFORE any site JS runs.
  await context.addInitScript(STEALTH_INIT_SCRIPT);

  const page = await context.newPage();
  // Use domcontentloaded — faster than 'load' on SPAs, retried up to 2x on timeout
  let lastGotoErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      lastGotoErr = null;
      break;
    } catch (err) {
      lastGotoErr = err as Error;
      console.warn(`[browser] page.goto attempt ${attempt + 1} failed: ${(err as Error).message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastGotoErr) throw lastGotoErr;

  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
