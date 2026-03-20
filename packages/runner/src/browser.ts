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
    ],
  });

  const contextOptions: any = {
    viewport: headless ? viewport : null,
    ...(headless ? {} : { noDefaultViewport: true }),
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
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

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
