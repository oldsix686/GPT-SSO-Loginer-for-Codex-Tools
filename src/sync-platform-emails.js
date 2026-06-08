import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectPageCdp, evaluateOnPage } from './cdp-client.js';
import { buildConfig } from './config.js';

const PLATFORM_HOST = 'invite.kyl23333.xyz';

export async function syncPlatformEmails(config) {
  const outputPath = path.resolve(process.cwd(), config.emailsFile || 'emails.txt');
  const client = await connectPageCdp(config.browserCdpUrl, (target) => {
    try {
      return new URL(target.url).hostname === PLATFORM_HOST;
    } catch {
      return false;
    }
  });

  try {
    await ensurePlatformPage(client);
    const emails = await collectEmails(client);
    if (!emails.length) {
      throw new Error('no emails found on invite.kyl23333.xyz. Open the logged-in account list page first.');
    }

    const backupPath = await backupIfExists(outputPath);
    await fs.writeFile(outputPath, `${emails.join('\n')}\n`, 'utf8');
    console.log(`[gpt-sso-loginer] synced ${emails.length} platform emails to ${outputPath}`);
    if (backupPath) {
      console.log(`[gpt-sso-loginer] previous emails backed up to ${backupPath}`);
    }
    console.log(`[gpt-sso-loginer] first: ${emails[0]}`);
    console.log(`[gpt-sso-loginer] last: ${emails[emails.length - 1]}`);
    return emails;
  } finally {
    client.close();
  }
}

async function main() {
  const config = buildConfig({ allowEmptyEmailList: true });
  await syncPlatformEmails(config);
}

async function ensurePlatformPage(client) {
  const href = await evaluateOnPage(client, 'location.href');
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {}
  if (host === PLATFORM_HOST) return;

  await client.send('Page.navigate', { url: `https://${PLATFORM_HOST}/` });
  await sleep(3000);
}

async function collectEmails(client) {
  const all = new Set();
  let stableRounds = 0;
  let previousCount = 0;

  for (let round = 0; round < 80; round += 1) {
    const batch = await evaluateOnPage(client, `
      (() => {
        const text = document.body?.innerText || '';
        const emails = Array.from(new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig) || []));
        const scrollers = Array.from(document.querySelectorAll('main, section, div, ul, ol'))
          .filter((el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect.width > 0
              && rect.height > 0
              && el.scrollHeight > el.clientHeight + 50;
          })
          .map((el) => {
            const text = el.innerText || '';
            const score = (text.match(/@/g) || []).length * 100 + Math.min(el.clientHeight, 1000);
            return { el, score };
          })
          .sort((a, b) => b.score - a.score);
        const target = scrollers[0]?.el || document.scrollingElement || document.documentElement;
        const before = target.scrollTop || scrollY || 0;
        if (target === document.scrollingElement || target === document.documentElement) {
          scrollBy(0, Math.max(500, innerHeight * 0.8));
          return { emails, before, after: scrollY || 0, height: document.documentElement.scrollHeight };
        }
        target.scrollTop = before + Math.max(500, target.clientHeight * 0.8);
        return { emails, before, after: target.scrollTop, height: target.scrollHeight };
      })()
    `);

    for (const email of batch?.emails || []) {
      all.add(String(email).trim().toLowerCase());
    }

    if (all.size === previousCount) stableRounds += 1;
    else stableRounds = 0;
    previousCount = all.size;

    if (stableRounds >= 5) break;
    await sleep(350);
  }

  return Array.from(all).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

async function backupIfExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    return '';
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.${stamp}.bak`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[gpt-sso-loginer] failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
