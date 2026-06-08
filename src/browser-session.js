import { chromium } from 'playwright';

export async function openBrowserSession(config) {
  if (config.browserMode === 'cdp') {
    return openCdpBrowserSession(config);
  }
  return openPersistentBrowserSession(config);
}

export function buildChromeLaunchArgs(config) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (config.stealthLaunchArgs) {
    args.unshift('--disable-blink-features=AutomationControlled');
  }
  if (config.chromeProfileDirectory) {
    args.push(`--profile-directory=${config.chromeProfileDirectory}`);
  }
  return args;
}

async function openPersistentBrowserSession(config) {
  const launchOptions = {
    headless: config.headless,
    slowMo: config.slowMoMs,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    args: buildChromeLaunchArgs(config),
  };
  if (config.chromeExecutablePath) {
    launchOptions.executablePath = config.chromeExecutablePath;
  }

  const context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  return {
    context,
    page,
    close: async () => context.close(),
    mode: 'persistent',
  };
}

async function openCdpBrowserSession(config) {
  const browser = await chromium.connectOverCDP(config.browserCdpUrl).catch((error) => {
    throw new Error(
      `cannot connect to Chrome CDP at ${config.browserCdpUrl}. Start real Chrome first with: npm run real-chrome. ${error?.message || error}`
    );
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(`Chrome CDP connected but no browser context was available: ${config.browserCdpUrl}`);
  }
  const page = await context.newPage();
  return {
    context,
    page,
    close: async () => {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    },
    mode: 'cdp',
  };
}
