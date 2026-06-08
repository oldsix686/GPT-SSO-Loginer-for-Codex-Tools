import fs from 'node:fs/promises';
import path from 'node:path';
import { buildConfig } from './config.js';
import { applyUsedEmailFilter } from './email-selection.js';
import { runBatch } from './batch.js';
import { syncPlatformEmails } from './sync-platform-emails.js';

async function main() {
  const config = buildConfig();
  const releaseLock = await acquireRunLock(config);
  try {
    if (config.syncPlatformEmailsBeforeLogin) {
      const emails = await syncPlatformEmails(config);
      config.emailList = emails;
    }
    const filtered = await applyUsedEmailFilter(config, config.emailList);
    config.emailList = filtered.emails;
    if (!config.emailList.length) {
      console.log('[gpt-sso-loginer] no unused email left; nothing to run.');
      return;
    }
    console.log(`[gpt-sso-loginer] target: ${config.target}, emails: ${config.emailList.length}`);
    await runBatch(config);
  } finally {
    await releaseLock();
  }
}

main()
  .catch((error) => {
    console.error(`[gpt-sso-loginer] failed: ${error?.message || error}`);
    process.exitCode = 1;
  });

async function acquireRunLock(config) {
  await fs.mkdir(config.artifactsDir, { recursive: true });
  const lockPath = path.join(config.artifactsDir, 'run.lock');
  let handle = null;
  try {
    handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`another login run is active or stale lock exists: ${lockPath}. Stop old node/npm login processes, then delete this lock if needed.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  return async () => {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  };
}
