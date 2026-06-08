import { openBrowserSession } from './browser-session.js';
import { buildConfig } from './config.js';

const PLATFORM_URL = 'https://invite.kyl23333.xyz/';

async function main() {
  const config = buildConfig({ allowEmptyEmailList: true });
  console.log(`[gpt-sso-loginer] open platform login with browser mode: ${config.browserMode}`);
  const browserSession = await openBrowserSession({ ...config, headless: false });
  const { page } = browserSession;
  page.setDefaultTimeout(20000);
  await page.goto(PLATFORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((error) => {
    console.error(`[gpt-sso-loginer] initial open failed: ${error?.message || error}`);
  });

  console.log('[gpt-sso-loginer] finish login in the opened Chrome window. Press Ctrl+C here after the platform account page is logged in.');
  let last = '';
  while (true) {
    const url = page.url();
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const emails = Array.from(new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []));
    const status = emails.length
      ? `logged-in/account-list likely ready, visible emails: ${emails.slice(0, 5).join(', ')}`
      : `waiting, url: ${url}`;
    if (status !== last) {
      console.log(`[gpt-sso-loginer] ${status}`);
      last = status;
    }
    await page.waitForTimeout(3000);
  }
}

main().catch((error) => {
  console.error(`[gpt-sso-loginer] failed: ${error?.message || error}`);
  process.exitCode = 1;
});
