export function deriveOrigin(rawUrl) {
  const normalized = String(rawUrl || '').trim();
  if (!normalized) throw new Error('CPA 地址为空。');

  try {
    return new URL(normalized).origin;
  } catch {
    throw new Error(`CPA 地址格式无效：${normalized}`);
  }
}

export async function requestOAuthUrl({ cpaUrl, cpaKey, timeoutMs = 30000 }) {
  const origin = deriveOrigin(cpaUrl);
  const payload = await requestJson(`${origin}/v0/management/codex-auth-url`, {
    method: 'GET',
    cpaKey,
    timeoutMs,
  });

  const oauthUrl = firstNonEmpty(
    payload?.url,
    payload?.auth_url,
    payload?.authUrl,
    payload?.data?.url,
    payload?.data?.auth_url,
    payload?.data?.authUrl,
  );

  if (!oauthUrl || !/^https?:\/\//i.test(oauthUrl)) {
    throw new Error('CPA 管理接口没有返回有效的 OAuth URL。');
  }

  return {
    oauthUrl,
    state: firstNonEmpty(
      payload?.state,
      payload?.auth_state,
      payload?.authState,
      payload?.data?.state,
      payload?.data?.auth_state,
      payload?.data?.authState,
      extractState(oauthUrl),
    ),
    origin,
  };
}

export async function submitOAuthCallback({ cpaUrl, cpaKey, callbackUrl, timeoutMs = 30000 }) {
  const origin = deriveOrigin(cpaUrl);
  const payload = await requestJson(`${origin}/v0/management/oauth-callback`, {
    method: 'POST',
    cpaKey,
    timeoutMs,
    body: {
      provider: 'codex',
      redirect_url: String(callbackUrl || '').trim(),
    },
  });

  return {
    status: firstNonEmpty(payload?.message, payload?.status_message, payload?.status, 'CPA OAuth 回调已提交'),
    raw: payload,
  };
}

async function requestJson(url, { method = 'GET', cpaKey, timeoutMs = 30000, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const key = String(cpaKey || '').trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers['X-Management-Key'] = key;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

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
      const message = firstNonEmpty(payload?.error, payload?.message, payload?.detail, payload?.reason);
      throw new Error(message || `CPA 请求失败：HTTP ${response.status}`);
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`CPA 请求超时：${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractState(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get('state') || '';
  } catch {
    return '';
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}
