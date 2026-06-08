import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WORKSPACE_LABEL = 'JUNGUI \u5de5\u4f5c\u7a7a\u95f4';
const DEFAULT_CASDOOR_LOGIN_LABEL = '\u767b\u5f55';

export function loadDotEnv(filePath = '.env') {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const values = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const raw = token.slice(2);
    if (raw.startsWith('no-')) {
      args[toCamelCase(raw.slice(3))] = false;
      continue;
    }

    const inlineEqualsAt = raw.indexOf('=');
    if (inlineEqualsAt >= 0) {
      args[toCamelCase(raw.slice(0, inlineEqualsAt))] = raw.slice(inlineEqualsAt + 1);
      continue;
    }

    const key = toCamelCase(raw);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

export function buildConfig(options = {}) {
  const env = {
    ...loadDotEnv(path.resolve(process.cwd(), '.env')),
    ...process.env,
  };
  const args = parseArgs();

  const config = {
    target: firstValue(args.target, env.TARGET, 'codex-tools'),
    email: firstValue(args.email, env.GPT_SSO_EMAIL),
    emails: firstValue(args.emails, env.GPT_SSO_EMAILS),
    emailsFile: firstValue(args.emailsFile, env.EMAILS_FILE),
    cpaUrl: firstValue(args.cpaUrl, env.CPA_URL),
    cpaKey: firstValue(args.cpaKey, args.cpaManagementKey, env.CPA_MANAGEMENT_KEY),
    codexToolsDataDir: firstValue(args.codexToolsDataDir, env.CODEX_TOOLS_DATA_DIR),
    oauthUrl: firstValue(args.oauthUrl, env.OAUTH_URL),
    idpSsoMode: firstValue(args.idpSsoMode, env.IDP_SSO_MODE, 'off'),
    idpBase: firstValue(args.idpBase, env.IDP_BASE, 'https://idp.example.com'),
    idpToken: firstValue(args.idpToken, env.IDP_TOKEN),
    idpClientId: firstValue(args.idpClientId, env.IDP_CLIENT_ID),
    idpAccountId: firstValue(args.idpAccountId, env.IDP_ACCOUNT_ID),
    idpStartUrl: firstValue(args.idpStartUrl, env.IDP_START_URL),
    idpStartUrlTemplate: firstValue(args.idpStartUrlTemplate, env.IDP_START_URL_TEMPLATE),
    workspaceLabel: firstValue(args.workspaceLabel, env.WORKSPACE_LABEL, DEFAULT_WORKSPACE_LABEL),
    casdoorLoginLabel: firstValue(args.casdoorLoginLabel, env.CASDOOR_LOGIN_LABEL, DEFAULT_CASDOOR_LOGIN_LABEL),
    dogAvatarSelector: firstValue(args.dogAvatarSelector, env.DOG_AVATAR_SELECTOR),
    browserMode: firstValue(args.browserMode, env.BROWSER_MODE, 'persistent'),
    browserCdpUrl: firstValue(args.browserCdpUrl, env.BROWSER_CDP_URL),
    chromeExecutablePath: firstValue(args.chromeExecutablePath, env.CHROME_EXECUTABLE_PATH),
    chromeUserDataDir: firstValue(args.chromeUserDataDir, env.CHROME_USER_DATA_DIR),
    chromeDebugUserDataDir: firstValue(args.chromeDebugUserDataDir, env.CHROME_DEBUG_USER_DATA_DIR),
    chromeProfileDirectory: firstValue(args.chromeProfileDirectory, env.CHROME_PROFILE_DIRECTORY),
    remoteDebuggingPort: numberValue(firstValue(args.remoteDebuggingPort, env.REMOTE_DEBUGGING_PORT), 9222),
    headless: booleanValue(firstValue(args.headless, env.BROWSER_HEADLESS), false),
    slowMoMs: numberValue(firstValue(args.slowMoMs, env.BROWSER_SLOW_MO_MS), 120),
    profileDir: firstValue(args.profileDir, env.PROFILE_DIR, 'profiles/default'),
    artifactsDir: firstValue(args.artifactsDir, env.ARTIFACTS_DIR, 'artifacts'),
    usedEmailsFile: firstValue(args.usedEmailsFile, env.USED_EMAILS_FILE, 'used-emails.txt'),
    usedEmailsAuditFile: firstValue(args.usedEmailsAuditFile, env.USED_EMAILS_AUDIT_FILE),
    skipUsedEmails: booleanValue(firstValue(args.skipUsedEmails, env.SKIP_USED_EMAILS), true),
    trackUsedEmails: booleanValue(firstValue(args.trackUsedEmails, env.TRACK_USED_EMAILS), true),
    submitCallback: booleanValue(firstValue(args.submitCallback, env.SUBMIT_CALLBACK), true),
    strictEmailMatch: booleanValue(firstValue(args.strictEmailMatch, env.STRICT_EMAIL_MATCH), true),
    freshProfile: booleanValue(firstValue(args.freshProfile, env.FRESH_PROFILE), true),
    sharedBrowserProfile: booleanValue(firstValue(args.sharedBrowserProfile, env.SHARED_BROWSER_PROFILE), false),
    clearAuthState: booleanValue(firstValue(args.clearAuthState, env.CLEAR_AUTH_STATE), false),
    clearOauthOrigin: booleanValue(firstValue(args.clearOauthOrigin, env.CLEAR_OAUTH_ORIGIN), false),
    resetOpenAiSessionBeforeLogin: booleanValue(firstValue(args.resetOpenAiSessionBeforeLogin, env.RESET_OPENAI_SESSION_BEFORE_LOGIN), false),
    forceOpenAiLogin: booleanValue(firstValue(args.forceOpenAiLogin, env.FORCE_OPENAI_LOGIN), true),
    requireLoginInteraction: booleanValue(firstValue(args.requireLoginInteraction, env.REQUIRE_LOGIN_INTERACTION), true),
    stopOnFailure: booleanValue(firstValue(args.stopOnFailure, env.STOP_ON_FAILURE), true),
    pauseForPlatformLogin: booleanValue(firstValue(args.pauseForPlatformLogin, env.PAUSE_FOR_PLATFORM_LOGIN), true),
    pauseForCloudflare: booleanValue(firstValue(args.pauseForCloudflare, env.PAUSE_FOR_CLOUDFLARE), true),
    syncPlatformEmailsBeforeLogin: booleanValue(firstValue(args.syncPlatformEmailsBeforeLogin, env.SYNC_PLATFORM_EMAILS_BEFORE_LOGIN), true),
    stealthLaunchArgs: booleanValue(firstValue(args.stealthLaunchArgs, env.STEALTH_LAUNCH_ARGS), false),
    maxRetries: numberValue(firstValue(args.maxRetries, env.MAX_RETRIES), 1),
    batchDelayMs: numberValue(firstValue(args.batchDelayMs, env.BATCH_DELAY_MS), 2500),
    callbackTimeoutMs: numberValue(firstValue(args.callbackTimeoutMs, env.CALLBACK_TIMEOUT_MS), 240000),
    platformLoginTimeoutMs: numberValue(firstValue(args.platformLoginTimeoutMs, env.PLATFORM_LOGIN_TIMEOUT_MS), 600000),
    cloudflareTimeoutMs: numberValue(firstValue(args.cloudflareTimeoutMs, env.CLOUDFLARE_TIMEOUT_MS), 600000),
    idpTimeoutMs: numberValue(firstValue(args.idpTimeoutMs, env.IDP_TIMEOUT_MS), 30000),
    idpPrimeTimeoutMs: numberValue(firstValue(args.idpPrimeTimeoutMs, env.IDP_PRIME_TIMEOUT_MS), 15000),
    idpMePageSize: numberValue(firstValue(args.idpMePageSize, env.IDP_ME_PAGE_SIZE), 50),
  };

  config.email = String(config.email || '').trim();
  config.emails = String(config.emails || '').trim();
  config.emailsFile = String(config.emailsFile || '').trim();
  config.target = String(config.target || '').trim().toLowerCase();
  config.cpaUrl = String(config.cpaUrl || '').trim();
  config.cpaKey = String(config.cpaKey || '').trim();
  config.codexToolsDataDir = String(config.codexToolsDataDir || '').trim();
  config.oauthUrl = String(config.oauthUrl || '').trim();
  config.idpSsoMode = normalizeIdpSsoMode(String(config.idpSsoMode || '').trim());
  config.idpBase = String(config.idpBase || '').trim().replace(/\/+$/g, '');
  config.idpToken = String(config.idpToken || '').trim();
  config.idpClientId = String(config.idpClientId || '').trim();
  config.idpAccountId = String(config.idpAccountId || '').trim();
  config.idpStartUrl = String(config.idpStartUrl || '').trim();
  config.idpStartUrlTemplate = String(config.idpStartUrlTemplate || '').trim();
  config.workspaceLabel = normalizeKnownLabel(String(config.workspaceLabel || '').trim(), DEFAULT_WORKSPACE_LABEL);
  config.casdoorLoginLabel = normalizeKnownLabel(String(config.casdoorLoginLabel || '').trim(), DEFAULT_CASDOOR_LOGIN_LABEL);
  config.dogAvatarSelector = String(config.dogAvatarSelector || '').trim();
  config.browserMode = normalizeBrowserMode(config.browserMode);
  config.browserCdpUrl = String(config.browserCdpUrl || '').trim() || `http://127.0.0.1:${config.remoteDebuggingPort}`;
  config.chromeExecutablePath = String(config.chromeExecutablePath || '').trim();
  config.chromeUserDataDir = String(config.chromeUserDataDir || '').trim()
    || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  config.chromeDebugUserDataDir = path.resolve(process.cwd(), String(config.chromeDebugUserDataDir || '').trim() || 'profiles/real-chrome-cdp');
  config.chromeProfileDirectory = String(config.chromeProfileDirectory || '').trim();
  config.profileDir = path.resolve(process.cwd(), config.profileDir);
  config.artifactsDir = path.resolve(process.cwd(), config.artifactsDir);
  config.usedEmailsFile = String(config.usedEmailsFile || '').trim() || 'used-emails.txt';
  config.usedEmailsAuditFile = String(config.usedEmailsAuditFile || '').trim();
  config.emailList = resolveEmailList(config);

  validateConfig(config, options);
  return config;
}

function validateConfig(config, options = {}) {
  if (!config.emailList.length && !config.syncPlatformEmailsBeforeLogin && !options.allowEmptyEmailList) {
    throw new Error('No valid email found. Use --email, --emails, --emails-file, or GPT_SSO_EMAIL.');
  }

  if (!['codex-tools', 'cpa'].includes(config.target)) {
    throw new Error('TARGET must be codex-tools or cpa.');
  }

  if (!['persistent', 'cdp'].includes(config.browserMode)) {
    throw new Error('BROWSER_MODE must be persistent or cdp.');
  }

  if (config.browserMode === 'cdp' && !config.browserCdpUrl) {
    throw new Error('BROWSER_MODE=cdp requires BROWSER_CDP_URL or REMOTE_DEBUGGING_PORT.');
  }

  if (!['off', 'api', 'start-url'].includes(config.idpSsoMode)) {
    throw new Error('IDP_SSO_MODE must be off, api, or start-url.');
  }

  if (config.idpSsoMode === 'api' && (!config.idpBase || !config.idpToken)) {
    throw new Error('IDP_SSO_MODE=api requires IDP_BASE and IDP_TOKEN.');
  }

  if (config.idpSsoMode === 'start-url' && !config.idpStartUrl && !config.idpStartUrlTemplate) {
    throw new Error('IDP_SSO_MODE=start-url requires IDP_START_URL or IDP_START_URL_TEMPLATE.');
  }

  if (config.target === 'codex-tools') {
    return;
  }

  if (!config.oauthUrl) {
    if (!config.cpaUrl) {
      throw new Error('CPA_URL is required unless OAUTH_URL is provided.');
    }
    if (!config.cpaKey) {
      throw new Error('CPA_MANAGEMENT_KEY is required unless OAUTH_URL is provided.');
    }
  }

  if (config.submitCallback && (!config.cpaUrl || !config.cpaKey)) {
    throw new Error('Submitting OAuth callback requires CPA_URL and CPA_MANAGEMENT_KEY. Use --no-submit-callback to only capture callback.');
  }
}

function resolveEmailList(config) {
  const values = [];

  const hasEmailsFile = Boolean(config.emailsFile);
  const argv = process.argv.slice(2);
  const hasExplicitEmailArgs = argv.some((arg) => arg === '--email' || arg.startsWith('--email='));
  const hasExplicitEmailsArgs = argv.some((arg) => arg === '--emails' || arg.startsWith('--emails='));

  if (hasEmailsFile) {
    const filePath = path.resolve(process.cwd(), config.emailsFile);
    const raw = fs.readFileSync(filePath, 'utf8');
    values.push(...raw.split(/\r?\n|,|;|\s+/g));
  }

  if (config.emails && (!hasEmailsFile || hasExplicitEmailsArgs)) {
    values.push(...config.emails.split(/,|;|\s+/g));
  }

  if (config.email && (!hasEmailsFile || hasExplicitEmailArgs)) {
    values.push(config.email);
  }

  const seen = new Set();
  const emails = [];
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized.startsWith('#')) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    emails.push(normalized);
  }

  return emails;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function numberValue(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toCamelCase(value) {
  return String(value || '').replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function normalizeKnownLabel(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  if (
    fallback === DEFAULT_WORKSPACE_LABEL
    && /^JUNGUI\b/i.test(trimmed)
    && !trimmed.includes(DEFAULT_WORKSPACE_LABEL)
  ) {
    return DEFAULT_WORKSPACE_LABEL;
  }
  if (
    fallback === DEFAULT_CASDOOR_LOGIN_LABEL
    && trimmed.length > 2
    && /[^\x00-\x7f]/.test(trimmed)
  ) {
    return DEFAULT_CASDOOR_LOGIN_LABEL;
  }
  return trimmed;
}

function normalizeIdpSsoMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || ['0', 'false', 'no', 'off', 'none', 'disabled'].includes(mode)) return 'off';
  if (['url', 'start', 'start-url', 'start_url'].includes(mode)) return 'start-url';
  if (['api', 'idp', 'idp-api', 'idp_api'].includes(mode)) return 'api';
  return mode;
}

function normalizeBrowserMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || ['profile', 'persistent', 'playwright'].includes(mode)) return 'persistent';
  if (['cdp', 'real-chrome', 'real_chrome', 'chrome'].includes(mode)) return 'cdp';
  return mode;
}
