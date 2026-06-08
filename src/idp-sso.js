export async function resolveIdpSsoStartUrl(config) {
  const mode = normalizeIdpSsoMode(config.idpSsoMode);
  if (mode === 'off') return '';

  if (mode === 'start-url') {
    const raw = config.idpStartUrlTemplate || config.idpStartUrl;
    if (!raw) {
      throw new Error('IDP_SSO_MODE=start-url requires IDP_START_URL or IDP_START_URL_TEMPLATE.');
    }
    return expandTemplate(raw, {
      email: config.email,
      accountId: config.idpAccountId,
    });
  }

  const accountId = await resolveIdpAccountId(config);
  const payload = await requestIdpJson(config, 'POST', '/api/user/start-sso', {
    token: config.idpToken,
    account_id: accountId,
  });
  const startUrl = String(payload?.start_url || payload?.startUrl || '').trim();
  if (!startUrl) {
    throw new Error(`IDP start-sso did not return start_url for ${config.email}.`);
  }
  return startUrl;
}

export function normalizeIdpSsoMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || ['0', 'false', 'no', 'off', 'none', 'disabled'].includes(mode)) return 'off';
  if (['url', 'start', 'start-url', 'start_url'].includes(mode)) return 'start-url';
  if (['api', 'idp', 'idp-api', 'idp_api'].includes(mode)) return 'api';
  throw new Error(`Unsupported IDP_SSO_MODE: ${value}. Use off, api, or start-url.`);
}

async function resolveIdpAccountId(config) {
  const configured = expandTemplate(config.idpAccountId, {
    email: config.email,
    accountId: config.idpAccountId,
  }).trim();
  if (configured) return configured;

  const payload = await requestIdpJson(config, 'POST', '/api/user/me', {
    token: config.idpToken,
    page: 1,
    page_size: config.idpMePageSize,
    client_id: config.idpClientId,
    q: config.email,
  });

  const candidates = collectAccountCandidates(payload);
  const expected = normalizeEmail(config.email);
  const exact = candidates.find((candidate) => normalizeEmail(candidate.email) === expected);
  if (exact?.id) return String(exact.id);

  const visible = candidates
    .map((candidate) => candidate.email)
    .filter(Boolean)
    .slice(0, 15);
  const suffix = visible.length ? ` Visible IDP emails: ${visible.join(', ')}` : '';
  throw new Error(`IDP account not found for ${config.email}.${suffix}`);
}

async function requestIdpJson(config, method, path, body = null) {
  const url = path.startsWith('http')
    ? path
    : `${String(config.idpBase || '').replace(/\/+$/g, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(config.idpTimeoutMs) || 30000));

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': 'gpt-sso-loginer/0.1',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      const message = payload?.message || payload?.error || payload?.raw || `HTTP ${response.status}`;
      throw new Error(`IDP request failed: ${method} ${url} -> ${message}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function collectAccountCandidates(value, out = [], depth = 0, seen = new Set()) {
  if (!value || depth > 8) return out;

  if (Array.isArray(value)) {
    for (const item of value) collectAccountCandidates(item, out, depth + 1, seen);
    return out;
  }

  if (typeof value !== 'object') return out;
  const email = firstText(value, ['email', 'mail', 'user_email', 'account_email', 'username']);
  const id = firstText(value, ['id', 'account_id', 'accountId', 'sso_account_id']);
  const key = `${id}|${email}`;
  if ((email || id) && !seen.has(key)) {
    seen.add(key);
    out.push({ id, email, raw: value });
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectAccountCandidates(child, out, depth + 1, seen);
  }
  return out;
}

function firstText(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function expandTemplate(value, data) {
  return String(value || '')
    .replaceAll('{email}', data.email || '')
    .replaceAll('{email_encoded}', encodeURIComponent(data.email || ''))
    .replaceAll('{account_id}', data.accountId || '')
    .replaceAll('{account_id_encoded}', encodeURIComponent(data.accountId || ''));
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}
