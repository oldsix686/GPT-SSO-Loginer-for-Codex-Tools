import fs from 'node:fs/promises';
import path from 'node:path';
import { completeCodexOAuthCallback, extractAuth, prepareCodexOAuthLogin } from './codex-oauth.js';
import { requestOAuthUrl, submitOAuthCallback } from './cpa-api.js';
import { findCodexToolsAccountByEmail, upsertCodexToolsAccount } from './codex-tools-store.js';
import { resolveIdpSsoStartUrl } from './idp-sso.js';
import { AddPhoneRetryError, runSsoLogin } from './login-flow.js';
import { markEmailUsed } from './used-emails.js';

export async function runBatch(config) {
  await fs.mkdir(config.artifactsDir, { recursive: true });
  const results = [];

  for (let index = 0; index < config.emailList.length; index += 1) {
    const email = config.emailList[index];
    const runConfig = buildPerEmailConfig(config, email, index);
    console.log(`[gpt-sso-loginer] [${index + 1}/${config.emailList.length}] start: ${email}`);

    const result = await runOneWithRetries(runConfig);
    results.push(result);
    await appendJsonl(path.join(config.artifactsDir, 'batch-results.jsonl'), result);

    if (!result.ok && config.stopOnFailure) {
      const summary = summarizeResults(results);
      await writeCsv(path.join(config.artifactsDir, 'batch-results.csv'), results);
      console.error(`[gpt-sso-loginer] stop on failure: ${email}. ok ${summary.ok}, failed ${summary.failed}`);
      throw new Error(`stopped after failed login/callback for ${email}: ${result.error || 'unknown error'}`);
    }

    if (index < config.emailList.length - 1 && config.batchDelayMs > 0) {
      await sleep(config.batchDelayMs);
    }
  }

  const summary = summarizeResults(results);
  await writeCsv(path.join(config.artifactsDir, 'batch-results.csv'), results);
  console.log(`[gpt-sso-loginer] batch done: ok ${summary.ok}, failed ${summary.failed}, result ${path.join(config.artifactsDir, 'batch-results.csv')}`);
  return { results, summary };
}

async function runOneWithRetries(config) {
  let lastError = null;
  const attempts = Math.max(1, Math.floor(Number(config.maxRetries) || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptConfig = buildAttemptConfig(config, attempt, attempts);
    try {
      if (attempt > 1) {
        console.log(`[gpt-sso-loginer] ${config.email} retry ${attempt}/${attempts}`);
      }
      const result = await runOne(attemptConfig);
      return {
        ok: true,
        email: config.email,
        attempt,
        target: config.target,
        ...result,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      if (shouldStopRetrying(error)) {
        console.error(`[gpt-sso-loginer] ${config.email} reached Codex auth/callback and was marked used; not retrying this email.`);
      } else if (isFreshOauthRetry(error)) {
        console.error(`[gpt-sso-loginer] ${config.email} hit add-phone; retrying this account with a fresh OAuth URL.`);
      } else {
        console.error(`[gpt-sso-loginer] ${config.email} failed: ${error?.message || error}`);
      }
      if (shouldStopRetrying(error)) {
        break;
      }
      if (attempt < attempts) {
        await sleep(2000 * attempt);
      }
    }
  }

  return {
    ok: false,
    email: config.email,
    target: config.target,
    error: lastError?.message || String(lastError || 'unknown error'),
    flowState: lastError?.flowState || null,
    finishedAt: new Date().toISOString(),
  };
}

async function runOne(config) {
  if (config.target === 'codex-tools') {
    const existing = await findCodexToolsAccountByEmail(config.email, config);
    if (existing?.account) {
      await markUsedEmail(config, 'already-imported-by-codex-tools-preflight', {
        accountId: existing.account.accountId,
        importedEmail: existing.account.email,
        storePath: existing.storePath,
      });
      console.log(`[gpt-sso-loginer] ${config.email} already exists in codex-tools; skip OAuth and continue.`);
      return {
        action: 'already-imported-by-codex-tools',
        accountId: existing.account.accountId,
        importedEmail: existing.account.email,
        storePath: existing.storePath,
        flowState: { preflightExistingCodexTools: true },
      };
    }

    const pending = prepareCodexOAuthLogin();
    console.log(`[gpt-sso-loginer] fresh Codex OAuth state for ${config.email}: ${pending.state}`);
    const idpStartUrl = await resolveIdpSsoStartUrl(config);
    const codexAuthUrl = buildCodexAuthUrl(config, pending.authUrl);
    const loginResult = await runSsoLogin({
      ...config,
      oauthUrl: codexAuthUrl,
      oauthExpectedState: pending.state,
      idpStartUrl,
      onCodexAuthReached: async (event) => {
        await markUsedEmail(config, event.reason, {
          oauthState: pending.state,
          pageUrl: event.pageUrl,
          callbackUrl: event.callbackUrl,
        });
      },
    });
    let authJson = null;
    let importResult = null;
    try {
      authJson = await completeCodexOAuthCallback(pending, loginResult.callbackUrl);
      assertEmailMatches(config, authJson);
      importResult = await upsertCodexToolsAccount(authJson, {
        codexToolsDataDir: config.codexToolsDataDir,
        label: config.email,
      });
    } catch (error) {
      const existing = await findCodexToolsAccountByEmail(config.email, config).catch(() => null);
      if (existing?.account) {
        return {
          action: 'already-imported-by-codex-tools',
          accountId: existing.account.accountId,
          importedEmail: existing.account.email,
          storePath: existing.storePath,
          callbackUrl: loginResult.callbackUrl,
          flowState: loginResult.flowState,
          tokenExchangeError: error?.message || String(error),
        };
      }

      error.doNotRetry = true;
      error.emailMarkedUsed = true;
      error.flowState = loginResult.flowState;
      throw error;
    }
    return {
      action: importResult.imported ? 'imported' : 'updated',
      accountId: importResult.account.accountId,
      importedEmail: importResult.account.email,
      storePath: importResult.storePath,
      callbackUrl: loginResult.callbackUrl,
      flowState: loginResult.flowState,
    };
  }

  let oauthUrl = config.oauthUrl;
  if (!oauthUrl) {
    const result = await requestOAuthUrl({
      cpaUrl: config.cpaUrl,
      cpaKey: config.cpaKey,
    });
    oauthUrl = result.oauthUrl;
  }

  const idpStartUrl = await resolveIdpSsoStartUrl(config);
  const loginResult = await runSsoLogin({ ...config, oauthUrl, idpStartUrl });
  if (config.submitCallback) {
    await submitOAuthCallback({
      cpaUrl: config.cpaUrl,
      cpaKey: config.cpaKey,
      callbackUrl: loginResult.callbackUrl,
    });
  }
  return {
    action: config.submitCallback ? 'callback-submitted' : 'callback-captured',
    callbackUrl: loginResult.callbackUrl,
    flowState: loginResult.flowState,
  };
}

function isFreshOauthRetry(error) {
  return error instanceof AddPhoneRetryError
    || error?.code === 'ADD_PHONE_RETRY'
    || error?.retryWithFreshOAuth === true;
}

function shouldStopRetrying(error) {
  return error?.doNotRetry === true || error?.emailMarkedUsed === true;
}

async function markUsedEmail(config, reason, metadata = {}) {
  const result = await markEmailUsed(config, config.email, reason, {
    target: config.target,
    ...metadata,
  });
  const state = result.alreadyUsed ? 'already used' : 'marked used';
  console.log(`[gpt-sso-loginer] ${config.email} ${state}: ${reason}`);
  return result;
}

function assertEmailMatches(config, authJson) {
  if (!config.strictEmailMatch) return;
  const extracted = extractAuth(authJson);
  if (!extracted.email) return;
  if (extracted.email.toLowerCase() !== config.email.toLowerCase()) {
    throw new Error(`login result email mismatch: expected ${config.email}, actual ${extracted.email}`);
  }
}

function buildPerEmailConfig(config, email, index) {
  const safeEmail = sanitizeFileSegment(email);
  const prefix = `${String(index + 1).padStart(4, '0')}-${safeEmail}`;
  return {
    ...config,
    email,
    oauthUrl: '',
    profileDir: config.sharedBrowserProfile ? config.profileDir : path.join(config.profileDir, prefix),
    artifactsDir: path.join(config.artifactsDir, prefix),
  };
}

function buildAttemptConfig(config, attempt, attempts) {
  if (attempts <= 1) return { ...config };
  return {
    ...config,
    oauthUrl: '',
    artifactsDir: path.join(config.artifactsDir, `attempt-${attempt}`),
  };
}

function buildCodexAuthUrl(config, authUrl) {
  if (!config.forceOpenAiLogin && !config.email) return authUrl;
  const url = new URL(authUrl);
  if (config.forceOpenAiLogin) {
    url.searchParams.set('prompt', 'login');
  }
  if (config.email) {
    url.searchParams.set('login_hint', config.email);
  }
  return url.toString();
}

function summarizeResults(results) {
  return results.reduce((summary, result) => {
    if (result.ok) summary.ok += 1;
    else summary.failed += 1;
    return summary;
  }, { ok: 0, failed: 0 });
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeCsv(filePath, results) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const fields = ['ok', 'email', 'target', 'action', 'accountId', 'importedEmail', 'storePath', 'error', 'finishedAt'];
  const lines = [
    fields.join(','),
    ...results.map((result) => fields.map((field) => csvCell(result[field])).join(',')),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function sanitizeFileSegment(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'email';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
