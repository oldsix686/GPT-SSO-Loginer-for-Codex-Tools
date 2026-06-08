import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildConfig } from './config.js';

const START_URL = 'https://invite.kyl23333.xyz/';

async function main() {
  const config = buildConfig({ allowEmptyEmailList: true });
  await fs.mkdir(config.chromeDebugUserDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${config.remoteDebuggingPort}`,
    `--user-data-dir=${config.chromeDebugUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (config.chromeProfileDirectory) {
    args.push(`--profile-directory=${config.chromeProfileDirectory}`);
  }
  args.push('--new-window', START_URL);

  console.log(`[gpt-sso-loginer] launching Chrome: ${config.chromeExecutablePath}`);
  console.log(`[gpt-sso-loginer] debug profile: ${config.chromeDebugUserDataDir}`);
  console.log(`[gpt-sso-loginer] CDP url: ${config.browserCdpUrl}`);

  const child = spawn(config.chromeExecutablePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const ok = await waitForCdp(config.browserCdpUrl, 10000);
  if (!ok) {
    console.error('[gpt-sso-loginer] Chrome opened, but CDP port is not reachable.');
    console.error('[gpt-sso-loginer] Close all Chrome windows, then run npm run real-chrome again.');
    process.exitCode = 1;
    return;
  }

  console.log('[gpt-sso-loginer] real Chrome is ready. Finish platform login / Cloudflare in that window, keep it open, then run npm run login.');
}

async function waitForCdp(cdpUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${String(cdpUrl).replace(/\/+$/g, '')}/json/version`);
      if (response.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`[gpt-sso-loginer] failed: ${error?.message || error}`);
  process.exitCode = 1;
});
