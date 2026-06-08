import crypto from 'node:crypto';

const OAUTH_ISSUER = 'https://auth.openai.com';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const OAUTH_ORIGINATOR = 'codex_vscode';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

export function prepareCodexOAuthLogin() {
  const state = crypto.randomUUID().replace(/-/g, '');
  const codeVerifier = `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const authUrl = new URL('/oauth/authorize', OAUTH_ISSUER);

  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
  authUrl.searchParams.set('scope', OAUTH_SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', OAUTH_ORIGINATOR);

  return {
    authUrl: authUrl.toString(),
    redirectUri: OAUTH_REDIRECT_URI,
    state,
    codeVerifier,
  };
}

export async function completeCodexOAuthCallback(pending, callbackUrl) {
  const parsed = new URL(String(callbackUrl || '').trim());
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(parsed.searchParams.get('error_description') || error);
  }

  const state = parsed.searchParams.get('state') || '';
  if (state !== pending.state) {
    throw new Error('OAuth 回调 state 不匹配，请重新生成登录链接。');
  }

  const code = parsed.searchParams.get('code') || '';
  if (!code) {
    throw new Error('OAuth 回调缺少 code。');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: pending.codeVerifier,
  });

  const response = await postTokenWithRetry(body);

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error_description || payload?.error || payload?.message || `OAuth token 交换失败：HTTP ${response.status}`);
  }

  return buildAuthJsonFromTokenResponse(payload);
}

async function postTokenWithRetry(body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(`${OAUTH_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildAuthJsonFromTokenResponse(tokenResponse) {
  const accessToken = String(tokenResponse?.access_token || '').trim();
  const refreshToken = String(tokenResponse?.refresh_token || '').trim();
  const idToken = String(tokenResponse?.id_token || '').trim();
  if (!accessToken || !refreshToken || !idToken) {
    throw new Error('OAuth token 响应缺少 access_token / refresh_token / id_token。');
  }

  const claims = decodeJwtPayload(idToken);
  const auth = claims?.['https://api.openai.com/auth'] || {};
  const accountId = String(auth?.chatgpt_account_id || tokenResponse?.account_id || '').trim();
  if (!accountId) {
    throw new Error('无法从 id_token 识别 chatgpt_account_id。');
  }

  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: accountId,
    },
  };
}

export function extractAuth(authJson) {
  const tokens = authJson?.tokens || authJson || {};
  const accessToken = String(tokens.access_token || '').trim();
  const idToken = String(tokens.id_token || '').trim();
  if (!accessToken || !idToken) {
    throw new Error('authJson 缺少 access_token 或 id_token。');
  }

  const claims = decodeJwtPayload(idToken);
  const auth = claims?.['https://api.openai.com/auth'] || {};
  const email = normalizeEmail(claims?.email);
  const accountId = String(tokens.account_id || auth?.chatgpt_account_id || '').trim();
  if (!accountId) {
    throw new Error('无法从 authJson 识别 chatgpt_account_id。');
  }

  const principalId = normalizePrincipal(
    email
    || auth?.chatgpt_user_id
    || auth?.user_id
    || claims?.sub
    || accountId
  );

  return {
    principalId,
    accountId,
    accessToken,
    email: email || null,
    planType: normalizeText(auth?.chatgpt_plan_type) || null,
  };
}

export function accountGroupKey(principalId, accountId) {
  return `${String(principalId || '').trim()}|${String(accountId || '').trim()}`;
}

export function accountVariantKey(principalId, accountId, planType) {
  return `${accountGroupKey(principalId, accountId)}|${normalizePlanTypeKey(planType)}`;
}

export function normalizePlanTypeKey(planType) {
  return normalizeText(planType)?.toLowerCase() || 'unknown';
}

export function decodeJwtPayload(token) {
  const segment = String(token || '').split('.')[1] || '';
  if (!segment) throw new Error('JWT 格式无效。');
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeEmail(value) {
  const normalized = normalizeText(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized.toLowerCase() : '';
}

function normalizePrincipal(value) {
  const normalized = normalizeText(value);
  return normalized.includes('@') ? normalized.toLowerCase() : normalized;
}

function normalizeText(value) {
  return String(value || '').trim();
}
