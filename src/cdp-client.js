export async function getPageTargets(cdpUrl) {
  const response = await fetch(`${trimSlash(cdpUrl)}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP target list failed: HTTP ${response.status}`);
  }
  return response.json();
}

export async function connectPageCdp(cdpUrl, predicate = () => true) {
  const targets = await getPageTargets(cdpUrl);
  const target = targets.find((entry) => entry.type === 'page' && predicate(entry))
    || targets.find((entry) => entry.type === 'page');
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`no page target found at ${cdpUrl}`);
  }
  return connectWebSocketCdp(target.webSocketDebuggerUrl, target);
}

export async function connectWebSocketCdp(webSocketUrl, target = null) {
  const ws = new WebSocket(webSocketUrl);
  const pending = new Map();
  let seq = 0;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket timeout: ${webSocketUrl}`)), 8000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket failed: ${webSocketUrl}`));
    };
  });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  return {
    target,
    send,
    close: () => ws.close(),
  };
}

export async function evaluateOnPage(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.text || 'CDP evaluate failed');
  }
  return result.result?.result?.value;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/g, '');
}
