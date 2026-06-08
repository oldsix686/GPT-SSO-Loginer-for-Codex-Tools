import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  accountGroupKey,
  accountVariantKey,
  extractAuth,
  normalizePlanTypeKey,
} from './codex-oauth.js';
import { normalizeEmail } from './used-emails.js';

export function resolveCodexToolsDataDir(config = {}) {
  const explicit = String(config.codexToolsDataDir || '').trim();
  if (explicit) return path.resolve(explicit);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error('无法读取 APPDATA，不能定位 codex-tools 数据目录。');
    return path.join(appData, 'com.carry.codex-tools');
  }

  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'com.carry.codex-tools');
  }

  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'), 'com.carry.codex-tools');
}

export async function upsertCodexToolsAccount(authJson, config = {}) {
  const dataDir = resolveCodexToolsDataDir(config);
  const storePath = path.join(dataDir, 'accounts.json');
  const extracted = extractAuth(authJson);
  const now = Math.floor(Date.now() / 1000);
  const store = await loadStore(storePath);
  const label = String(config.label || extracted.email || `Codex ${shortAccount(extracted.accountId)}`).trim();
  const resolvedPlanType = extracted.planType || null;
  const resolvedVariantKey = accountVariantKey(extracted.principalId, extracted.accountId, resolvedPlanType);
  const resolvedAccountKey = accountGroupKey(extracted.principalId, extracted.accountId);
  const resolvedPlanKey = normalizePlanTypeKey(resolvedPlanType);

  let account = store.accounts.find((item) => variantKeyOf(item) === resolvedVariantKey);
  let updatedExisting = true;

  if (!account && resolvedPlanKey !== 'unknown') {
    account = store.accounts.find((item) => (
      accountKeyOf(item) === resolvedAccountKey
      && normalizePlanTypeKey(item.planType || planTypeFromAuth(item.authJson)) === 'unknown'
    ));
  }

  if (!account) {
    account = {
      id: crypto.randomUUID(),
      label,
      sourceKind: 'chatgpt',
      principalId: extracted.principalId,
      email: extracted.email,
      accountId: extracted.accountId,
      planType: resolvedPlanType,
      authJson,
      apiBaseUrl: null,
      apiKey: null,
      modelName: null,
      balanceText: null,
      profileAuthPath: null,
      profileConfigPath: null,
      profileAuthReady: false,
      profileConfigReady: false,
      profileIntegrityError: null,
      profileLastValidatedAt: null,
      profileLastValidationError: null,
      addedAt: now,
      updatedAt: now,
      usage: null,
      usageError: null,
      authRefreshBlocked: false,
      authRefreshError: null,
      apiProxyEnabled: true,
      codexKeepaliveLastAt: null,
    };
    store.accounts.push(account);
    updatedExisting = false;
  } else {
    account.label = label;
    account.sourceKind = 'chatgpt';
    account.principalId = extracted.principalId;
    account.email = extracted.email;
    account.accountId = extracted.accountId;
    account.planType = resolvedPlanType || account.planType || null;
    account.authJson = authJson;
    account.apiBaseUrl = null;
    account.apiKey = null;
    account.modelName = null;
    account.balanceText = null;
    account.updatedAt = now;
    account.usageError = null;
    account.authRefreshBlocked = false;
    account.authRefreshError = null;
    account.apiProxyEnabled = true;
  }

  dedupeByVariant(store);
  await saveStore(storePath, store);

  return {
    dataDir,
    storePath,
    imported: !updatedExisting,
    updated: updatedExisting,
    account: {
      id: account.id,
      label: account.label,
      email: account.email,
      accountId: account.accountId,
      planType: account.planType,
      accountKey: accountKeyOf(account),
    },
  };
}

export async function listCodexToolsKnownEmails(config = {}) {
  const dataDir = resolveCodexToolsDataDir(config);
  const storePath = path.join(dataDir, 'accounts.json');
  const store = await loadStore(storePath);
  const emails = new Set();

  for (const account of store.accounts) {
    for (const email of emailCandidatesOf(account)) {
      emails.add(email);
    }
  }

  return [...emails];
}

export async function findCodexToolsAccountByEmail(email, config = {}) {
  const expected = normalizeEmail(email);
  if (!expected) return null;

  const dataDir = resolveCodexToolsDataDir(config);
  const storePath = path.join(dataDir, 'accounts.json');
  const store = await loadStore(storePath);

  const account = store.accounts.find((item) => emailCandidatesOf(item).includes(expected));
  if (!account) return null;

  return {
    storePath,
    account: {
      id: account.id,
      label: account.label,
      email: account.email,
      accountId: account.accountId || account.account_id || '',
      planType: account.planType || account.plan_type || planTypeFromAuth(account.authJson || account.auth_json),
    },
  };
}

async function loadStore(storePath) {
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeStore(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultStore();
    throw new Error(`读取 codex-tools accounts.json 失败：${error.message}`);
  }
}

async function saveStore(storePath, store) {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });

  const serialized = JSON.stringify(store, null, 2);
  const tempPath = path.join(dir, `.accounts.json.tmp-${crypto.randomUUID()}`);
  await fs.writeFile(tempPath, serialized, { mode: 0o600 });

  try {
    await fs.rename(tempPath, storePath);
  } catch (error) {
    if (process.platform === 'win32') {
      await fs.rm(storePath, { force: true }).catch(() => {});
      await fs.rename(tempPath, storePath);
    } else {
      throw error;
    }
  }

  await fs.writeFile(path.join(dir, 'accounts.json.last-good.json'), serialized, { mode: 0o600 }).catch(() => {});
}

function normalizeStore(value) {
  const store = value && typeof value === 'object' && !Array.isArray(value) ? value : defaultStore();
  if (!Number.isFinite(Number(store.version))) store.version = 2;
  if (!Array.isArray(store.accounts)) store.accounts = [];
  if (!store.settings || typeof store.settings !== 'object' || Array.isArray(store.settings)) {
    store.settings = {};
  }
  return store;
}

function defaultStore() {
  return {
    version: 2,
    accounts: [],
    settings: {},
  };
}

function accountKeyOf(account) {
  return accountGroupKey(principalOf(account), account.accountId || account.account_id || '');
}

function variantKeyOf(account) {
  return accountVariantKey(
    principalOf(account),
    account.accountId || account.account_id || '',
    account.planType || account.plan_type || planTypeFromAuth(account.authJson || account.auth_json),
  );
}

function principalOf(account) {
  const value = account.principalId || account.principal_id || account.email || '';
  return String(value || '').includes('@') ? String(value).trim().toLowerCase() : String(value || '').trim();
}

function planTypeFromAuth(authJson) {
  try {
    return extractAuth(authJson).planType;
  } catch {
    return null;
  }
}

function emailCandidatesOf(account) {
  const candidates = [
    account.email,
    account.label,
    account.principalId,
    account.principal_id,
  ];

  try {
    candidates.push(extractAuth(account.authJson || account.auth_json).email);
  } catch {}

  return [...new Set(candidates.map(normalizeEmail).filter(Boolean))];
}

function dedupeByVariant(store) {
  const seen = new Map();
  const merged = [];

  for (const account of store.accounts) {
    const key = variantKeyOf(account);
    if (!seen.has(key)) {
      seen.set(key, account);
      merged.push(account);
      continue;
    }

    const existing = seen.get(key);
    if (Number(account.updatedAt || account.updated_at || 0) >= Number(existing.updatedAt || existing.updated_at || 0)) {
      Object.assign(existing, {
        ...account,
        addedAt: Math.min(Number(existing.addedAt || existing.added_at || 0) || Number(account.addedAt || account.added_at || 0), Number(account.addedAt || account.added_at || 0) || Date.now()),
      });
    }
  }

  store.accounts = merged;
}

function shortAccount(accountId) {
  const normalized = String(accountId || '').trim();
  return normalized.length > 8 ? `${normalized.slice(0, 4)}...${normalized.slice(-4)}` : normalized;
}
