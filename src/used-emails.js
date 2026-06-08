import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeEmail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

export function resolveUsedEmailsFile(config = {}) {
  const file = String(config.usedEmailsFile || 'used-emails.txt').trim() || 'used-emails.txt';
  return path.resolve(process.cwd(), file);
}

export function resolveUsedEmailsAuditFile(config = {}) {
  const file = String(config.usedEmailsAuditFile || '').trim();
  if (file) return path.resolve(process.cwd(), file);
  return path.join(config.artifactsDir || path.resolve(process.cwd(), 'artifacts'), 'used-emails.jsonl');
}

export async function readUsedEmails(config = {}) {
  const used = new Set();
  const filePath = resolveUsedEmailsFile(config);

  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return used;
    throw error;
  }

  for (const token of raw.split(/\r?\n|,|;|\s+/g)) {
    const email = normalizeEmail(token.replace(/^#.*$/g, ''));
    if (email) used.add(email);
  }

  return used;
}

export async function filterUnusedEmails(config = {}, emails = [], extraUsedEmails = []) {
  const normalizedEmails = dedupeEmails(emails);
  if (config.skipUsedEmails === false) {
    return {
      emails: normalizedEmails,
      skipped: [],
      usedCount: 0,
    };
  }

  const used = await readUsedEmails(config);
  for (const email of extraUsedEmails) {
    const normalized = normalizeEmail(email);
    if (normalized) used.add(normalized);
  }

  const unused = [];
  const skipped = [];
  for (const email of normalizedEmails) {
    if (used.has(email)) {
      skipped.push(email);
    } else {
      unused.push(email);
    }
  }

  return {
    emails: unused,
    skipped,
    usedCount: used.size,
  };
}

export async function markEmailUsed(config = {}, email, reason, metadata = {}) {
  if (config.trackUsedEmails === false) {
    return { marked: false, skipped: true, reason: 'tracking-disabled' };
  }

  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error(`cannot mark invalid email as used: ${email || ''}`);
  }

  const usedFile = resolveUsedEmailsFile(config);
  const auditFile = resolveUsedEmailsAuditFile(config);
  await fs.mkdir(path.dirname(usedFile), { recursive: true });
  await fs.mkdir(path.dirname(auditFile), { recursive: true });

  const used = await readUsedEmails(config);
  const alreadyUsed = used.has(normalized);
  if (!alreadyUsed) {
    await fs.appendFile(usedFile, `${normalized}\n`, 'utf8');
  }

  await fs.appendFile(auditFile, `${JSON.stringify({
    email: normalized,
    reason: String(reason || 'used'),
    alreadyUsed,
    markedAt: new Date().toISOString(),
    ...metadata,
  })}\n`, 'utf8');

  return {
    marked: !alreadyUsed,
    alreadyUsed,
    usedFile,
    auditFile,
  };
}

function dedupeEmails(emails) {
  const seen = new Set();
  const result = [];
  for (const item of emails || []) {
    const email = normalizeEmail(item);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}
