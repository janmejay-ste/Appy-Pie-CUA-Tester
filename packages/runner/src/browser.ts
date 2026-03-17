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
): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless,
    args: [
      '--start-maximized',
      '--disable-extensions',
      '--disable-file-system',
    ],
  });

  const context = await browser.newContext({
    viewport: headless ? viewport : null,
    ...(headless ? {} : { noDefaultViewport: true }),
  });
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
