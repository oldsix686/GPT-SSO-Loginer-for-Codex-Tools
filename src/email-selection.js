import { listCodexToolsKnownEmails } from './codex-tools-store.js';
import { filterUnusedEmails } from './used-emails.js';

export async function applyUsedEmailFilter(config, emails) {
  let extraUsedEmails = [];
  if (config.target === 'codex-tools') {
    try {
      extraUsedEmails = await listCodexToolsKnownEmails(config);
    } catch (error) {
      console.error(`[gpt-sso-loginer] could not read codex-tools existing accounts for skip check: ${error?.message || error}`);
    }
  }

  const result = await filterUnusedEmails(config, emails, extraUsedEmails);
  if (config.skipUsedEmails !== false) {
    console.log(
      `[gpt-sso-loginer] used-email filter: skipped ${result.skipped.length}, remaining ${result.emails.length}`
    );
  }
  return result;
}
