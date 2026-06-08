import { buildConfig } from './config.js';
import { applyUsedEmailFilter } from './email-selection.js';
import { runBatch } from './batch.js';
import { syncPlatformEmails } from './sync-platform-emails.js';

async function main() {
  const config = buildConfig();
  let emails = config.emailList;
  if (config.syncPlatformEmailsBeforeLogin) {
    emails = await syncPlatformEmails(config);
  }
  const filtered = await applyUsedEmailFilter(config, emails);
  emails = filtered.emails;
  const email = emails[0];
  if (!email) {
    throw new Error('no unused platform email found for one-account login test.');
  }
  config.emailList = [email];
  config.maxRetries = Math.max(3, Number(config.maxRetries) || 1);
  config.stopOnFailure = true;
  console.log(`[gpt-sso-loginer] one-account test email: ${email}`);
  await runBatch(config);
}

main()
  .catch((error) => {
    console.error(`[gpt-sso-loginer] failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
