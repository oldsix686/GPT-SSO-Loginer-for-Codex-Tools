import fs from 'node:fs/promises';
import path from 'node:path';
import { openBrowserSession } from './browser-session.js';

const KNOWN_AUTH_ORIGINS = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://accounts.openai.com',
  'https://openai.com',
];

const RE_CASDOOR_PAGE = /casdoor|\u6388\u6743\u767b\u5f55|\u9009\u62e9\u4e00\u4e2a.*\u8d26\u53f7|\u5ba2\u6237\u7aef\s*ID|openid|profile|email/i;
const RE_DOG_PAGE = /\u7acb\u5373\u6ce8\u518c|\u6ca1\u6709\u8d26\u53f7|OpenAI|WebAuthn|\u9762\u5bb9\s*ID|password|register|sign\s*up/i;
const RE_LUMINET_LOGIN_URL = /https:\/\/oauth\.luminet\.cn\/login\/saml\/authorize/i;
const RE_KYL_OAUTH_LOGIN_URL = /https:\/\/oauth\.kyl23333\.xyz\/login\/oauth\/authorize/i;
const RE_PLATFORM_URL = /https:\/\/invite\.kyl23333\.xyz/i;
const RE_PLATFORM_LOGIN_URL = /https:\/\/invite\.kyl23333\.xyz\/(?:\?|login|signin|sign-in|auth)/i;
const RE_CLOUDFLARE_TEXT = /Cloudflare|Verify you are human|Checking if the site connection is secure|Just a moment|cf-turnstile|challenge-platform|cdn-cgi\/challenge-platform|cf-browser-verification|\u9a8c\u8bc1.*\u771f\u4eba|\u8bf7\u7a0d\u5019|\u6b63\u5728\u68c0\u67e5/i;
const RE_OPENAI_SSO_CHOICE_TEXT = /\u4f60\u5e0c\u671b\u91c7\u7528\u4f55\u79cd\u65b9\u5f0f|\u767b\u5f55\?|single\s+sign|sso|sign\s+in\s+with/i;

export class AddPhoneRetryError extends Error {
  constructor(url) {
    super(`OpenAI add-phone page appeared; discard current OAuth and retry this account with a fresh OAuth URL. Current URL: ${url}`);
    this.name = 'AddPhoneRetryError';
    this.code = 'ADD_PHONE_RETRY';
    this.retryWithFreshOAuth = true;
  }
}

export async function runSsoLogin(config) {
  await fs.mkdir(config.artifactsDir, { recursive: true });

  if (config.browserMode !== 'cdp') {
    if (config.freshProfile) {
      await resetProfileDir(config.profileDir);
    } else {
      await fs.mkdir(config.profileDir, { recursive: true });
    }
  }

  const browserSession = await openBrowserSession(config);
  const { context, page } = browserSession;
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(60000);

  const flowState = {
    emailSubmitted: false,
    workspaceClicked: false,
    ssoOptionClicked: false,
    dogAvatarClicked: false,
    casdoorAccountClicked: false,
    idpSsoStarted: false,
    idpSsoPrimed: false,
    codexAuthReached: false,
    callbackCaptured: false,
    usedEmailMarked: false,
  };

  let callbackGate = null;

  try {
    await clearAuthState(context, page, config);
    await primeIdpSsoSessionIfConfigured(page, config, flowState);

    callbackGate = createOAuthCallbackGate(page, {
      timeoutMs: config.callbackTimeoutMs,
      requireInteraction: config.requireLoginInteraction,
      expectedState: config.oauthExpectedState,
      canAccept: () => flowState.casdoorAccountClicked || flowState.idpSsoPrimed,
    });

    await logStep(`open OAuth url: ${config.oauthUrl}`);
    await safeGoto(page, config.oauthUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCloudflareIfPresent(page, config, 'open OAuth url');
    callbackGate.throwIfFailed();

    await completeOpenAiSsoEntry(page, config, flowState, callbackGate);
    await completeIntermediateDogAvatarPage(page, config, flowState, callbackGate);
    await completeCasdoorAccountPick(page, config, flowState, callbackGate);
    await completeOpenAiConsentIfPresent(page, config, flowState, callbackGate);
    await throwIfProviderFlowStuck(page, flowState);

    const callbackUrl = await callbackGate.wait();
    flowState.callbackCaptured = true;
    await markCodexAuthReached(config, flowState, 'localhost-callback', { callbackUrl });
    await logStep(`captured OAuth callback: ${callbackUrl}`);
    return { callbackUrl, pageUrl: page.url(), flowState: { ...flowState } };
  } catch (error) {
    error.flowState = { ...flowState };
    if (flowState.codexAuthReached || flowState.callbackCaptured || flowState.usedEmailMarked) {
      error.doNotRetry = true;
      error.emailMarkedUsed = true;
    }
    await saveFailureArtifacts(page, config.artifactsDir, error, flowState);
    throw error;
  } finally {
    callbackGate?.dispose();
    await browserSession.close();
  }
}

async function primeIdpSsoSessionIfConfigured(page, config, flowState) {
  if (!config.idpStartUrl) return false;

  flowState.idpSsoStarted = true;
  await logStep(`prime IDP SSO session: ${shortUrl(config.idpStartUrl)}`);
  await safeGoto(page, config.idpStartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPageSettled(page, config, 'IDP SSO start');
  await waitForIdpPrimeWindow(page, config);
  flowState.idpSsoPrimed = true;
  await logStep(`IDP SSO prime finished; continue to Codex OAuth for ${config.email}.`);
  return true;
}

async function waitForIdpPrimeWindow(page, config) {
  const timeoutMs = Math.max(3000, Number(config.idpPrimeTimeoutMs) || 15000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await waitForCloudflareIfPresent(page, config, 'IDP SSO prime');
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});

    if (isOAuthCallbackUrl(page.url())) {
      return;
    }

    const pageText = await textSnapshot(page);
    if (isPlatformLoginPage(page, pageText)) {
      await waitForPlatformLoginAndAccountList(page, config);
      return;
    }

    await page.waitForTimeout(700);
  }
}

async function completeOpenAiSsoEntry(page, config, flowState, callbackGate) {
  await waitForPageSettled(page, config, 'OpenAI SSO entry');
  callbackGate.throwIfFailed();
  if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;

  const initialText = await textSnapshot(page);
  if (isExternalProviderEntryPage(page, initialText) || isPlatformAccountListText(initialText)) {
    await logStep('external SSO provider page is ready; skip OpenAI email entry.');
    return;
  }

  if (await clickOpenAiSsoOptionIfPresent(page, config, flowState, callbackGate, 'initial OpenAI SSO choice')) {
    return;
  }

  if (isOpenAiAuthPage(page) && await hasEmailInput(page)) {
    await logStep(`fill OpenAI email: ${config.email}`);
    await fillFirstVisibleInput(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="\u90ae\u7bb1"]',
      'input[placeholder*="\u7535\u5b50\u90ae\u4ef6"]',
    ], config.email);
    flowState.emailSubmitted = true;
    await clickFirstVisible(page, [
      page.getByRole('button', { name: /continue|log\s*in|sign\s*in|\u7ee7\u7eed|\u767b\u5f55/i }),
      page.getByRole('link', { name: /continue|log\s*in|sign\s*in|\u7ee7\u7eed|\u767b\u5f55/i }),
      'button[type="submit"]',
      '[role="button"]',
    ]);
    await waitForPageSettled(page, config, 'after OpenAI email submit');
    callbackGate.throwIfFailed();
    if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;

    const afterEmailText = await textSnapshot(page);
    if (isExternalProviderEntryPage(page, afterEmailText) || isPlatformAccountListText(afterEmailText)) {
      await logStep('email submit reached external SSO provider.');
      return;
    }

    if (await clickOpenAiSsoOptionIfPresent(page, config, flowState, callbackGate, 'after OpenAI email submit')) {
      return;
    }
  }

  const beforeWorkspaceText = await textSnapshot(page);
  if (isExternalProviderEntryPage(page, beforeWorkspaceText) || isPlatformAccountListText(beforeWorkspaceText)) {
    await logStep('external SSO provider page is ready; skip workspace selector.');
    return;
  }

  if (await clickOpenAiSsoOptionIfPresent(page, config, flowState, callbackGate, 'before workspace selector')) {
    return;
  }

  if (await clickByNormalizedText(page, config.workspaceLabel, { timeoutMs: 45000 })) {
    flowState.workspaceClicked = true;
    await logStep(`clicked workspace: ${config.workspaceLabel}`);
    await waitForPageSettled(page, config, 'after workspace click');
    callbackGate.throwIfFailed();
    if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;
    return;
  }

  const pageText = await textSnapshot(page);
  if (isExternalProviderEntryPage(page, pageText)) {
    await logStep('arrived at external SSO provider page; continue to provider OAuth.');
    return;
  }

  if (isPlatformAccountListText(pageText) || RE_CASDOOR_PAGE.test(pageText)) {
    await logStep('already on provider account page; workspace step was bypassed by redirect.');
    return;
  }

  throw new Error(`workspace entry not found: ${config.workspaceLabel}. Current URL: ${page.url()}`);
}

async function clickOpenAiSsoOptionIfPresent(page, config, flowState, callbackGate, stageLabel) {
  const pageText = await textSnapshot(page);
  if (!isOpenAiSsoChoicePage(page, pageText)) return false;

  await logStep(`OpenAI SSO choice page detected at ${stageLabel}; click SSO provider option.`);
  const clicked = await clickOpenAiSsoOption(page, config);
  if (!clicked) {
    throw new Error(`OpenAI SSO provider option not found. Current URL: ${page.url()}`);
  }

  flowState.ssoOptionClicked = true;
  await waitForPageSettled(page, config, 'after OpenAI SSO option click');
  const afterClickText = await textSnapshot(page);
  if (isOpenAiSsoChoicePage(page, afterClickText)) {
    throw new Error(`OpenAI SSO provider option clicked but page did not leave SSO choice. Current URL: ${page.url()}`);
  }
  callbackGate.throwIfFailed();
  return true;
}

async function completeIntermediateDogAvatarPage(page, config, flowState, callbackGate) {
  await waitForPageSettled(page, config, 'provider avatar page');
  callbackGate.throwIfFailed();
  if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;

  const pageText = await textSnapshot(page);
  if (isPlatformAccountListText(pageText) || (RE_CASDOOR_PAGE.test(pageText) && await pageContainsEmailLikeList(page))) {
    await logStep('already on provider account list; provider-avatar step was bypassed by redirect.');
    return;
  }

  if (isPlatformLoginPage(page, pageText)) {
    await waitForPlatformLoginAndAccountList(page, config);
    return;
  }

  if (!RE_DOG_PAGE.test(pageText) && !isExternalProviderEntryPage(page, pageText)) {
    await logStep('provider page text was not obvious; trying provider selector anyway.');
  }

  await logStep('open external provider OAuth entry.');
  const clicked = await clickDogAvatar(page, config);
  if (!clicked) {
    throw new Error(`provider OAuth entry not found. Current URL: ${page.url()}`);
  }

  flowState.dogAvatarClicked = true;
  await waitForPageSettled(page, config, 'after provider OAuth open');
  callbackGate.throwIfFailed();
  if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;
  await waitForPlatformLoginAndAccountList(page, config);
}

async function completeCasdoorAccountPick(page, config, flowState, callbackGate) {
  await waitForPageSettled(page, config, 'Casdoor account page');
  callbackGate.throwIfFailed();
  if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;
  await waitForPlatformLoginAndAccountList(page, config);
  if (callbackGate.isDone() || isOAuthCallbackUrl(page.url())) return;
  const postWaitText = await textSnapshot(page);
  if (isOpenAiCodexConsentPage(page, postWaitText)) {
    await logStep('provider flow already reached OpenAI Codex consent; skip account-list matching.');
    return;
  }
  await logStep(`match Casdoor account: ${config.email}`);

  const result = await findAndClickCasdoorAccount(page, config.email, config.casdoorLoginLabel, 60000);
  if (!result.ok) {
    const visible = result.visibleEmails?.length ? ` Visible emails: ${result.visibleEmails.join(', ')}` : '';
    throw new Error(`Casdoor account match failed: ${result.reason}.${visible} Current URL: ${page.url()}`);
  }

  flowState.casdoorAccountClicked = true;
  await logStep(`clicked Casdoor login for ${config.email}`);
  await waitForPageSettled(page, config, 'after Casdoor account click');
}

async function completeOpenAiConsentIfPresent(page, config, flowState, callbackGate) {
  const startedAt = Date.now();
  const maxWaitMs = 45000;

  while (Date.now() - startedAt < maxWaitMs) {
    callbackGate.throwIfFailed();
    if (callbackGate.isDone()) return;
    if (isOAuthCallbackUrl(page.url())) return;

    await waitForPageSettled(page, config, 'OpenAI consent page');
    const pageText = await textSnapshot(page);
    if (isOpenAiSignInConsentPage(page, pageText)) {
      const clicked = await clickConsentButton(page);
      if (clicked) {
        await logStep('clicked OpenAI sign-in consent button.');
        await waitForPageSettled(page, config, 'after OpenAI sign-in consent click');
        continue;
      }
    }

    if (!isOpenAiSignInConsentPage(page, pageText) && isOpenAiCodexConsentPage(page, pageText)) {
      await markCodexAuthReached(config, flowState, 'openai-codex-consent-page', { pageUrl: page.url() });
      const clicked = await clickConsentButton(page);
      if (clicked) {
        await logStep('clicked OpenAI OAuth consent button.');
        await waitForPageSettled(page, config, 'after OpenAI consent click');
        return;
      }
    }

    await page.waitForTimeout(500);
  }
}

async function throwIfProviderFlowStuck(page, flowState) {
  if (flowState.casdoorAccountClicked || flowState.codexAuthReached || flowState.callbackCaptured) return;
  const url = page.url();
  if (!/invite\.kyl23333\.xyz|oauth\.luminet\.cn|oauth\.kyl23333\.xyz/i.test(url)) return;
  const pageText = await textSnapshot(page);
  const emails = (pageText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []).slice(0, 8);
  throw new Error(
    `provider flow stuck before account login click. Current URL: ${url}. Visible emails: ${emails.join(', ') || 'none'}`
  );
}

async function waitForPlatformLoginAndAccountList(page, config) {
  const timeoutMs = Math.max(30000, Number(config.platformLoginTimeoutMs) || 600000);
  const deadline = Date.now() + timeoutMs;
  let manualPromptLogged = false;

  while (Date.now() < deadline) {
    await waitForCloudflareIfPresent(page, config, 'platform login/account list');
    const pageText = await textSnapshot(page);
    if (await continuePlatformOfferIfPresent(page, config, pageText)) {
      continue;
    }

    if (isPlatformAccountListText(pageText) || await pageContainsEmailLikeList(page)) {
      await logStep('provider account list is ready.');
      return true;
    }

    if (isOAuthCallbackUrl(page.url()) || isOpenAiCodexConsentPage(page, pageText)) {
      return true;
    }

    if (isPlatformLoginPage(page, pageText)) {
      if (!config.pauseForPlatformLogin || config.headless) {
        throw new Error(`platform account is not logged in for automation profile. Current URL: ${page.url()}`);
      }

      if (!manualPromptLogged) {
        manualPromptLogged = true;
        await logStep(`platform login required. Please finish login in the opened Chrome window, then the script will continue. Timeout: ${Math.round(timeoutMs / 1000)}s`);
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`platform account list did not appear within ${Math.round(timeoutMs / 1000)}s. Current URL: ${page.url()}`);
}

async function continuePlatformOfferIfPresent(page, config, pageText = '') {
  if (!/invite\.kyl23333\.xyz/i.test(page.url())) return false;
  if (!/前往领取优惠|领取优惠|continue|authorize/i.test(pageText)) return false;

  try {
    const parsed = new URL(page.url());
    const nextUrl = parsed.searchParams.get('next');
    if (nextUrl && /invite\.kyl23333\.xyz\/oauth\/authorize/i.test(nextUrl)) {
      await logStep(`open invite next authorize URL: ${shortUrl(nextUrl)}`);
      await safeGoto(page, nextUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForPageSettled(page, config, 'after invite next authorize open');
      return true;
    }
  } catch {}

  const button = page.getByRole('button', { name: /前往领取优惠|继续|continue|authorize/i }).first();
  if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
    await logStep('click invite continue/offer button.');
    await clickLocatorInBackground(button, 'invite continue/offer button');
    await waitForPageSettled(page, config, 'after invite continue click');
    return true;
  }

  return false;
}

function isLuminetLoginPage(page, pageText = '') {
  if (RE_LUMINET_LOGIN_URL.test(page.url())) return true;
  return /provider-link|kyl_challenge|No account|sign up now|\u6ca1\u6709\u8d26\u53f7|\u7acb\u5373\u6ce8\u518c/i.test(pageText)
    && /OpenAI|password|\u5bc6\u7801|WebAuthn/i.test(pageText);
}

function isKylOauthLoginPage(page, pageText = '') {
  if (RE_KYL_OAUTH_LOGIN_URL.test(page.url())) return true;
  return /oauth\.kyl23333\.xyz/i.test(page.url())
    || (/kyl_challenge|\u7b2c\u4e09\u65b9|\u6388\u6743/i.test(pageText) && /invite\.kyl23333|provider|oauth/i.test(pageText));
}

function isExternalProviderEntryPage(page, pageText = '') {
  return isLuminetLoginPage(page, pageText) || isKylOauthLoginPage(page, pageText);
}

function isOpenAiSsoChoicePage(page, pageText = '') {
  try {
    const parsed = new URL(page.url());
    if (parsed.hostname === 'auth.openai.com' && parsed.pathname === '/sso') return true;
  } catch {}
  return isOpenAiAuthPage(page) && RE_OPENAI_SSO_CHOICE_TEXT.test(pageText);
}

function isPlatformLoginPage(page, pageText = '') {
  const url = page.url();
  if (RE_PLATFORM_LOGIN_URL.test(url) && !isPlatformAccountListText(pageText)) return true;
  return RE_PLATFORM_URL.test(url)
    && !isPlatformAccountListText(pageText)
    && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(pageText);
}

function isPlatformAccountListText(pageText = '') {
  if (
    /授权登录|选择一个\s*KYL\s*账号|客户端\s*ID|授权范围|尚未使用|openid|profile|email/i.test(pageText)
    && /登录|login/i.test(pageText)
    && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(pageText)
  ) {
    return true;
  }
  return /授权登录|选择一个\s*KYL\s*账号|客户端\s*ID|授权范围|最近登录|尚未使用|openid|profile|email/i.test(pageText)
    && /登录|login/i.test(pageText)
    && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(pageText);
}

function isOpenAiSignInConsentPage(page, pageText = '') {
  try {
    const parsed = new URL(page.url());
    if (parsed.hostname.toLowerCase() === 'external.auth.openai.com' && /\/sso\/signin-consent/i.test(parsed.pathname)) {
      return true;
    }
  } catch {
    return false;
  }

  return /批准登录|验证是您本人|approve\s*sign\s*in/i.test(pageText)
    && /external\.auth\.openai\.com|来源|來源|source/i.test(`${page.url()}\n${pageText}`);
}

function isOpenAiCodexConsentPage(page, pageText = '') {
  try {
    const parsed = new URL(page.url());
    const host = parsed.hostname.toLowerCase();
    if (host === 'external.auth.openai.com' && /\/sso\/signin-consent/i.test(parsed.pathname)) {
      return true;
    }
    const isOpenAiHost = host === 'external.auth.openai.com'
      || host === 'auth.openai.com'
      || host.endsWith('.auth.openai.com');
    if (!isOpenAiHost) return false;
  } catch {
    return false;
  }

  return /Codex|api\.connectors|offline_access|approve\s*sign\s*in|\u6279\u51c6\u767b\u5f55|批准登录|验证是您本人/i.test(pageText);
}

function isOpenAiAuthPage(page) {
  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    return host === 'auth.openai.com'
      || host === 'accounts.openai.com'
      || host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com');
  } catch {
    return false;
  }
}

async function findAndClickCasdoorAccount(page, email, loginLabel, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastScrollTop = -1;
  let lastVisibleEmails = [];

  while (Date.now() < deadline) {
    const result = await page.evaluate(({ email, loginLabel }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const expected = normalize(email);
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
      const loginPattern = new RegExp(loginLabel || '\\u767b\\u5f55|login|continue|authorize', 'i');
      const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
      const emailsOf = (text) => Array.from(new Set(String(text || '').match(emailPattern) || []))
        .map((item) => normalize(item));
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        };
      };
      const buttonTextOf = (el) => textOf(el) || el.getAttribute('value') || el.getAttribute('aria-label') || '';
      const loginButtonsIn = (root) => Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(visible)
        .filter((el) => loginPattern.test(buttonTextOf(el)));
      const visibleEmails = Array.from(new Set((document.body?.innerText || '').match(emailPattern) || []))
        .slice(0, 12);

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!normalize(node.nodeValue).includes(expected)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || !visible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textMatches = [];
      let textNode = walker.nextNode();
      while (textNode) {
        const el = textNode.parentElement;
        const text = normalize(textNode.nodeValue);
        const rect = rectOf(el);
        textMatches.push({
          el,
          text,
          rect,
          score: (emailsOf(text).includes(expected) ? 300 : 0)
            - Math.abs(text.length - expected.length)
            - (rect.height > 120 ? rect.height : 0),
        });
        textNode = walker.nextNode();
      }

      const fallbackMatches = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const emails = emailsOf(text);
          const rect = rectOf(el);
          return { el, text, emails, rect };
        })
        .filter((entry) => entry.emails.includes(expected))
        .map((entry) => ({
          ...entry,
          score: 100
            - entry.emails.length * 80
            - Math.max(0, entry.rect.height - 80)
            - Math.max(0, entry.rect.width - 500) / 20,
        }));

      const emailNode = [...textMatches, ...fallbackMatches]
        .sort((a, b) => b.score - a.score)[0]?.el || null;
      if (!emailNode) {
        return { ok: false, reason: 'email-not-found', visibleEmails };
      }

      const ancestors = [];
      let current = emailNode;
      while (current && current !== document.body) {
        ancestors.push(current);
        current = current.parentElement;
      }

      const emailRect = rectOf(emailNode);
      const rowCandidates = ancestors
        .filter(visible)
        .map((el) => {
          const rect = rectOf(el);
          const text = normalize(textOf(el));
          const emails = emailsOf(text);
          const buttons = loginButtonsIn(el);
          const role = String(el.getAttribute('role') || '').toLowerCase();
          const tag = el.tagName.toLowerCase();
          const rowLike = ['tr', 'li'].includes(tag)
            || ['row', 'listitem'].includes(role)
            || /\b(row|item|card|account|list|table)\b/i.test(String(el.className || ''));
          return {
            el,
            rect,
            text,
            emails,
            buttons,
            score: (buttons.length ? 600 : 0)
              + (emails.length === 1 ? 240 : 0)
              + (rowLike ? 120 : 0)
              - emails.length * 35
              - Math.max(0, rect.height - 120) * 2
              - Math.max(0, rect.width - 900) / 10,
          };
        })
        .filter((entry) => {
          if (!entry.text.includes(expected)) return false;
          if (!entry.buttons.length) return false;
          if (entry.rect.height < 24 || entry.rect.height > 320) return false;
          if (!entry.emails.includes(expected)) return false;
          return true;
        })
        .sort((a, b) => b.score - a.score);

      const rowEntry = rowCandidates[0] || null;
      const row = rowEntry?.el || emailNode;
      const rowRect = rowEntry?.rect || rectOf(row);

      let button = loginButtonsIn(row)
        .map((el) => ({ el, rect: rectOf(el), text: buttonTextOf(el) }))
        .sort((a, b) => {
          const aDistance = Math.abs(a.rect.centerY - emailRect.centerY);
          const bDistance = Math.abs(b.rect.centerY - emailRect.centerY);
          if (aDistance !== bDistance) return aDistance - bDistance;
          return b.rect.centerX - a.rect.centerX;
        })[0]?.el || null;

      if (!button) {
        button = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
          .filter(visible)
          .map((el) => ({
            el,
            rect: rectOf(el),
            text: buttonTextOf(el),
          }))
          .filter((entry) => loginPattern.test(entry.text))
          .map((entry) => {
            const verticalDistance = Math.abs(entry.rect.centerY - emailRect.centerY);
            const rightOfEmail = entry.rect.centerX >= emailRect.centerX ? 0 : 80;
            const outsideRow = entry.rect.centerY < rowRect.top - 20 || entry.rect.centerY > rowRect.bottom + 20 ? 120 : 0;
            return { ...entry, score: verticalDistance + rightOfEmail + outsideRow };
          })
          .sort((a, b) => a.score - b.score)[0]?.el || null;
      }

      if (!button) return { ok: false, reason: 'login-button-not-found', visibleEmails };

      const buttonRectBefore = rectOf(button);
      const verticalDelta = Math.abs(buttonRectBefore.centerY - emailRect.centerY);
      const rowHasExpectedOnly = rowEntry ? rowEntry.emails.length === 1 && rowEntry.emails[0] === expected : false;
      if (!rowHasExpectedOnly && verticalDelta > Math.max(90, rowRect.height / 2 + 30)) {
        return {
          ok: false,
          reason: `matched-button-too-far:${Math.round(verticalDelta)}px`,
          visibleEmails,
        };
      }

      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      button.click();
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        clickedByDom: true,
        visibleEmails,
        matchedEmail: expected,
        matchedRowEmails: rowEntry?.emails || emailsOf(textOf(row)),
        emailRect,
        buttonText: buttonTextOf(button),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        },
      };
    }, { email, loginLabel });

    if (result.ok) {
      await logStep(`matched provider row email: ${result.matchedEmail}; row emails: ${(result.matchedRowEmails || []).join(', ') || 'unknown'}; button: ${result.buttonText || 'login'}`);
      if (!result.clickedByDom) {
        await clickRectInBackground(page, result.rect, `Casdoor login for ${email}`);
      }
      return result;
    }
    lastVisibleEmails = result.visibleEmails || lastVisibleEmails;

    const scroll = await scrollLikelyAccountList(page);
    if (!scroll.moved && scroll.top === lastScrollTop) {
      return { ...result, visibleEmails: lastVisibleEmails };
    }
    lastScrollTop = scroll.top;
    await page.waitForTimeout(450);
  }

  return { ok: false, reason: 'timeout', visibleEmails: lastVisibleEmails };
}

async function scrollLikelyAccountList(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };

    const candidates = Array.from(document.querySelectorAll('main, section, div, ul, ol'))
      .filter(visible)
      .filter((el) => el.scrollHeight > el.clientHeight + 30)
      .map((el) => {
        const text = String(el.textContent || '');
        const emailCount = (text.match(/@/g) || []).length;
        const rect = el.getBoundingClientRect();
        return { el, score: emailCount * 100 + Math.min(rect.height, 800) };
      })
      .sort((a, b) => b.score - a.score);

    const target = candidates[0]?.el || document.scrollingElement || document.documentElement;
    const before = target.scrollTop || window.scrollY || 0;
    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollBy(0, Math.max(450, window.innerHeight * 0.65));
      return { moved: Math.abs((window.scrollY || 0) - before) > 5, top: window.scrollY || 0 };
    }

    target.scrollTop = before + Math.max(450, target.clientHeight * 0.75);
    return { moved: Math.abs(target.scrollTop - before) > 5, top: target.scrollTop };
  });
}

async function clickOpenAiSsoOption(page, config = {}) {
  const direct = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .filter(visible)
      .map((el) => ({ href: el.href, text: String(el.textContent || '').replace(/\s+/g, ' ').trim() }));
    return anchors.find((entry) => /oauth\.kyl23333\.xyz\/login\/oauth\/authorize|external\.auth\.openai\.com|sso|oidc/i.test(entry.href)) || null;
  }).catch(() => null);

  if (direct?.href) {
    await logStep(`open OpenAI SSO provider link directly: ${shortUrl(direct.href)}`);
    await safeGoto(page, direct.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return true;
  }

  const roleMatched = await clickOpenAiSsoButtonByRole(page, config);
  if (roleMatched) return true;

  const target = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      };
    };
    const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex], div, span'))
      .filter(visible)
      .map((el) => {
        const clickable = el.closest('button, a, [role="button"], [tabindex]') || el;
        const rect = clickable.getBoundingClientRect();
        const text = textOf(clickable);
        const href = clickable.href || clickable.getAttribute?.('href') || '';
        const classText = `${clickable.className || ''} ${clickable.id || ''} ${clickable.getAttribute?.('aria-label') || ''}`;
        let score = 0;
        if (text && text.length <= 80) score += 40;
        if (/sso|single|sign|login|登录|方式|kyl|key|钥匙/i.test(`${text} ${classText} ${href}`)) score += 60;
        if (href) score += 30;
        if (rect.width >= 180 && rect.height >= 40 && rect.height <= 180) score += 45;
        if (rect.top > window.innerHeight * 0.25 && rect.top < window.innerHeight * 0.85) score += 20;
        score -= Math.max(0, rect.width * rect.height - 90000) / 2000;
        return { el: clickable, score, text, href, rect: rectOf(clickable) };
      })
      .filter((entry, index, entries) => entry.score > 45 && entries.findIndex((other) => other.el === entry.el) === index)
      .sort((a, b) => b.score - a.score);

    const target = clickables[0];
    if (!target) return { ok: false };
    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    return {
      ok: true,
      text: target.text,
      score: target.score,
      rect: rectOf(target.el),
    };
  }).catch(() => ({ ok: false }));

  if (!target.ok || !target.rect) return false;
  await logStep(`OpenAI SSO option target: ${target.text || 'button'}, score=${Math.round(target.score || 0)}`);
  return clickOpenAiSsoButtonByDom(page, target.text);
}

async function clickOpenAiSsoButtonByRole(page, config = {}) {
  const patterns = [];
  if (config.workspaceLabel) {
    patterns.push(escapedTextPattern(config.workspaceLabel));
  }
  patterns.push(/JUNGUI|工作空|工作間|工作空间|workspace/i);

  for (const pattern of patterns) {
    const locator = page.getByRole('button', { name: pattern }).first();
    if (!await locator.isVisible({ timeout: 1200 }).catch(() => false)) continue;
    await logStep(`OpenAI SSO button matched by role: ${String(pattern)}`);
    return clickLocatorInBackground(locator, 'OpenAI SSO provider option');
  }

  return false;
}

async function clickOpenAiSsoButtonByDom(page, targetText = '') {
  const clicked = await page.evaluate((targetText) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
      .filter(visible)
      .filter((el) => {
        const text = textOf(el);
        if (/google|microsoft|apple|password|使用密码|使用 Google|使用 Microsoft|使用 Apple/i.test(text)) return false;
        return /JUNGUI|工作空|工作間|工作空间|workspace|sso|single/i.test(text)
          || (targetText && text === targetText);
      });
    const button = candidates[0];
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    button.click();
    return true;
  }, targetText || '').catch(() => false);

  if (clicked) {
    await logStep('OpenAI SSO provider option clicked by DOM.');
  }
  return Boolean(clicked);
}

async function clickDogAvatar(page, config) {
  const providerOpened = await openLuminetProviderLink(page, config);
  if (providerOpened) return true;
  if (/oauth\.luminet\.cn\/login\/saml\/authorize/i.test(page.url())) {
    await saveLuminetProviderDebug(page, config.artifactsDir);
    throw new Error(`Luminet provider link not found on SAML login page. Current URL: ${page.url()}`);
  }

  if (config.dogAvatarSelector) {
    const locator = await findVisibleLocator(page, [config.dogAvatarSelector], 3000);
    if (locator) {
      await clickLocatorInBackground(locator, 'configured dog avatar selector');
      return true;
    }
  }

  const target = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };

    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      };
    };
    const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
    const allElements = Array.from(document.querySelectorAll('*')).filter(visible);
    const registerAnchor = allElements.find((el) => /\u6ca1\u6709\u8d26\u53f7|\u7acb\u5373\u6ce8\u518c|no\s+account|sign\s*up|register/i.test(textOf(el)));
    const anchorRect = registerAnchor?.getBoundingClientRect?.() || {
      top: window.innerHeight * 0.55,
      bottom: window.innerHeight * 0.65,
      left: 0,
      right: window.innerWidth,
    };

    const candidates = Array.from(document.querySelectorAll('img, svg, canvas, button, a, [role="button"], [tabindex], div, span'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = textOf(el);
        const bg = style.backgroundImage || '';
        const radius = Number.parseFloat(style.borderRadius || '0') || 0;
        const area = rect.width * rect.height;
        const imageHints = `${el.className || ''} ${el.id || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('src') || ''} ${bg}`;
        const isImageLike = ['IMG', 'SVG', 'CANVAS'].includes(el.tagName)
          || /avatar|dog|provider|social|oauth|login|casdoor|luminet|openai/i.test(imageHints)
          || bg.includes('url(');
        const isSmallAvatar = rect.width >= 16 && rect.width <= 120 && rect.height >= 16 && rect.height <= 120;
        const belowRegister = rect.top >= anchorRect.bottom - 16;
        const centered = Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2);
        let score = 0;
        if (belowRegister) score += 100;
        if (isSmallAvatar) score += 60;
        if (isImageLike) score += 45;
        if (radius >= Math.min(rect.width, rect.height) * 0.25) score += 20;
        if (!text) score += 10;
        if (text.length > 8) score -= 80;
        if (rect.top < anchorRect.bottom - 30) score -= 100;
        score -= Math.min(90, centered / 7);
        score -= Math.max(0, area - 12000) / 800;
        return { el, score, rect: rectOf(el), tag: el.tagName, text: text.slice(0, 40) };
      })
      .filter((entry) => entry.score > 25)
      .sort((a, b) => b.score - a.score);

    const target = candidates[0];
    if (target) {
      target.el.scrollIntoView({ block: 'center', inline: 'center' });
      return { ok: true, reason: `${target.tag}:${target.text || 'image-like'}`, rect: rectOf(target.el), score: target.score };
    }

    if (registerAnchor) {
      const rect = registerAnchor.getBoundingClientRect();
      return {
        ok: true,
        reason: 'fallback-under-signup-text',
        rect: {
          x: rect.left + rect.width / 2 - 20,
          y: rect.bottom + 48,
          width: 40,
          height: 40,
          centerX: rect.left + rect.width / 2,
          centerY: rect.bottom + 68,
        },
        score: 1,
      };
    }

    return { ok: false, reason: 'no-avatar-candidate' };
  });

  if (!target.ok || !target.rect) {
    await logStep(`dog avatar locate failed: ${target.reason || 'unknown'}`);
    return false;
  }

  await logStep(`dog avatar target: ${target.reason}, score=${Math.round(target.score || 0)}, x=${Math.round(target.rect.centerX)}, y=${Math.round(target.rect.centerY)}`);
  await clickRectInBackground(page, target.rect, target.reason);
  await page.waitForTimeout(900);
  return true;
}

async function saveLuminetProviderDebug(page, artifactsDir) {
  const data = await page.evaluate(() => Array.from(document.querySelectorAll('a[href], button, [role="button"], img'))
    .map((el) => ({
      tag: el.tagName,
      text: String(el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      href: el.href || el.getAttribute('href') || '',
      alt: el.getAttribute('alt') || '',
      src: el.getAttribute('src') || '',
      className: String(el.className || ''),
    }))).catch(() => []);
  const filePath = path.join(artifactsDir, `luminet-provider-debug-${Date.now()}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ url: page.url(), data }, null, 2), 'utf8').catch(() => {});
  await logStep(`saved Luminet provider debug: ${filePath}`);
}

async function openLuminetProviderLink(page, config) {
  const deadline = Date.now() + 30000;
  let provider = null;

  while (Date.now() < deadline && !provider?.href) {
    provider = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };

    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map((el) => ({
        href: el.href,
        text: String(el.textContent || '').replace(/\s+/g, ' ').trim(),
        cls: String(el.className || ''),
        visible: visible(el),
        rect: (() => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          };
        })(),
        imgAlt: Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('alt') || '').join(' '),
        imgSrc: Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('src') || '').join(' '),
      }));

    const matched = anchors.find((entry) => /invite\.kyl23333\.xyz\/oauth\/authorize/i.test(entry.href))
      || anchors.find((entry) => /provider=kyl_challenge/i.test(entry.href))
      || anchors.find((entry) => /kyl_challenge|sign\s+in\s+with/i.test(`${entry.text} ${entry.cls} ${entry.imgAlt} ${entry.imgSrc}`));

    if (!matched?.href) return null;
    return matched;
    }).catch(() => null);

    if (!provider?.href) {
      await page.waitForTimeout(500);
    }
  }

  if (!provider?.href) return false;

  await logStep(`open provider OAuth link directly: ${provider.text || provider.imgAlt || 'kyl_challenge'} -> ${shortUrl(provider.href)}`);
  await safeGoto(page, provider.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPageSettled(page, config, 'after provider OAuth open');
  return true;
}

async function humanMouseClick(page, rect, label = 'target') {
  const centerX = Number(rect.centerX ?? (rect.x + rect.width / 2));
  const centerY = Number(rect.centerY ?? (rect.y + rect.height / 2));
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    throw new Error(`invalid click rect for ${label}`);
  }

  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const startX = clamp(centerX + randomBetween(-180, -80), 8, viewport.width - 8);
  const startY = clamp(centerY + randomBetween(-120, -45), 8, viewport.height - 8);
  const clickX = clamp(centerX + randomBetween(-3, 3), 3, viewport.width - 3);
  const clickY = clamp(centerY + randomBetween(-3, 3), 3, viewport.height - 3);

  await page.mouse.move(startX, startY, { steps: 8 });
  await page.waitForTimeout(randomBetween(80, 180));
  await page.mouse.move(clickX, clickY, { steps: 18 });
  await page.waitForTimeout(randomBetween(120, 260));
  await page.mouse.down();
  await page.waitForTimeout(randomBetween(70, 140));
  await page.mouse.up();
  await logStep(`human mouse clicked ${label} at ${Math.round(clickX)},${Math.round(clickY)}`);
}

async function clickLocatorInBackground(locator, label = 'target') {
  try {
    await locator.click({ timeout: 5000 });
    await logStep(`clicked ${label} by locator.`);
    return true;
  } catch {}

  const clicked = await locator.evaluate((el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }).catch(() => false);

  if (clicked) {
    await logStep(`clicked ${label} by DOM.`);
  }
  return Boolean(clicked);
}

async function clickRectInBackground(page, rect, label = 'target') {
  const clicked = await page.evaluate((rect) => {
    const x = Number(rect.centerX ?? (rect.x + rect.width / 2));
    const y = Number(rect.centerY ?? (rect.y + rect.height / 2));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const candidates = document.elementsFromPoint(x, y);
    const rawTarget = candidates.find((el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.pointerEvents !== 'none' && box.width > 0 && box.height > 0;
    });
    const target = rawTarget?.closest?.('button, a, [role="button"], input[type="button"], input[type="submit"], [tabindex]')
      || rawTarget;
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    target.click();
    return true;
  }, rect).catch(() => false);

  if (clicked) {
    await logStep(`clicked ${label} by DOM point.`);
    return true;
  }

  await humanMouseClick(page, rect, label);
  return true;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function clickConsentButton(page) {
  const target = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const textOf = (el) => String(el?.textContent || el?.value || el?.getAttribute?.('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
    const approvePattern = /批准登录|approve\s*sign\s*in|approve|continue|继续|允许|授权|同意|authorize|allow/i;
    const rejectPattern = /不认识|拒绝|deny|reject|cancel/i;
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        let score = 0;
        if (approvePattern.test(text)) score += 100;
        if (rejectPattern.test(text)) score -= 200;
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 20;
        if (rect.width >= 80 && rect.height >= 28) score += 10;
        return {
          text,
          score,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2,
          },
        };
      })
      .filter((entry) => entry.score > 50)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }).catch(() => null);

  if (target?.rect) {
    await logStep(`consent button target: ${target.text || 'approve'}, score=${Math.round(target.score || 0)}`);
    await clickRectInBackground(page, target.rect, `consent button ${target.text || ''}`.trim());
    return true;
  }

  const locators = [
    page.getByRole('button', { name: /批准登录|approve\s*sign\s*in|continue|\u7ee7\u7eed|\u5141\u8bb8|\u6388\u6743|\u540c\u610f|authorize|allow/i }),
    page.getByRole('link', { name: /批准登录|approve\s*sign\s*in|continue|\u7ee7\u7eed|\u5141\u8bb8|\u6388\u6743|\u540c\u610f|authorize|allow/i }),
    page.locator('button[type="submit"], input[type="submit"]'),
  ];

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) {
        if (await clickLocatorInBackground(item, 'consent button')) return true;
      }
    }
  }

  return false;
}

function createOAuthCallbackGate(page, options) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 240000);
  const requireInteraction = options.requireInteraction !== false;
  const expectedState = String(options.expectedState || '').trim();
  const canAccept = typeof options.canAccept === 'function' ? options.canAccept : () => true;
  let done = false;
  let failedError = null;
  let acceptedUrl = '';

  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      done = true;
      reject(new Error(`no localhost OAuth callback captured in ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    const check = (rawUrl) => {
      if (done || !isOAuthCallbackUrl(rawUrl)) return;
      if (expectedState && callbackState(rawUrl) !== expectedState) {
        return;
      }
      if (requireInteraction && !canAccept()) {
        failedError = new Error(
          `OAuth callback arrived before matching Casdoor account login. This means an old browser session was reused. URL: ${rawUrl}`
        );
        done = true;
        cleanup();
        reject(failedError);
        return;
      }
      done = true;
      acceptedUrl = rawUrl;
      cleanup();
      resolve(rawUrl);
    };

    const onFrameNavigated = (frame) => {
      if (frame === page.mainFrame()) check(frame.url());
    };
    const onRequest = (request) => check(request.url());

    cleanup = () => {
      clearTimeout(timer);
      page.off('framenavigated', onFrameNavigated);
      page.off('request', onRequest);
    };

    page.on('framenavigated', onFrameNavigated);
    page.on('request', onRequest);
    check(page.url());
  });

  promise.catch(() => {});

  return {
    wait: () => promise,
    dispose: () => cleanup(),
    isDone: () => Boolean(acceptedUrl),
    throwIfFailed: () => {
      if (failedError) throw failedError;
    },
  };
}

function callbackState(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get('state') || '';
  } catch {
    return '';
  }
}

async function markCodexAuthReached(config, flowState, reason, metadata = {}) {
  flowState.codexAuthReached = true;
  flowState.codexAuthReason = reason;
  flowState.codexAuthReachedAt = flowState.codexAuthReachedAt || new Date().toISOString();

  if (flowState.usedEmailMarked) return;
  if (typeof config.onCodexAuthReached !== 'function') return;

  await config.onCodexAuthReached({
    email: config.email,
    reason,
    ...metadata,
    flowState: { ...flowState },
  });
  flowState.usedEmailMarked = true;
}

function isOAuthCallbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocalhost) return false;
    return ['/auth/callback', '/codex/callback'].includes(parsed.pathname);
  } catch {
    return false;
  }
}

async function hasEmailInput(page) {
  return Boolean(await findVisibleLocator(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="\u90ae\u7bb1"]',
    'input[placeholder*="\u7535\u5b50\u90ae\u4ef6"]',
  ], 3500));
}

async function pageContainsEmailLikeList(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    return (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []).length > 0;
  }).catch(() => false);
}

async function fillFirstVisibleInput(page, selectors, value) {
  const locator = await findVisibleLocator(page, selectors, 15000);
  if (!locator) throw new Error(`input not found: ${selectors.join(', ')}`);
  await locator.fill(value);
}

async function clickFirstVisible(page, selectors) {
  const locator = await findVisibleLocator(page, selectors, 15000);
  if (!locator) throw new Error(`clickable element not found: ${selectors.join(', ')}`);
  await locator.click();
}

async function clickByNormalizedText(page, text, { timeoutMs = 15000 } = {}) {
  const target = normalizeTextForMatch(text);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate((target) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim().toLowerCase();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], div, span'))
        .filter(visible)
        .filter((el) => normalize(el.textContent).includes(target))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const clickable = el.closest('button, a, [role="button"], [role="link"]') || el;
          return { el: clickable, area: rect.width * rect.height };
        })
        .sort((a, b) => a.area - b.area);

      const targetEl = candidates[0]?.el;
      if (!targetEl) return false;
      targetEl.scrollIntoView({ block: 'center', inline: 'center' });
      targetEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      targetEl.click();
      return true;
    }, target);

    if (clicked) return true;
    await page.waitForTimeout(300);
  }

  return false;
}

async function findVisibleLocator(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = typeof selector === 'string' ? page.locator(selector) : selector;
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function waitForPageSettled(page, config = null, stageLabel = 'page') {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  await throwIfAddPhonePage(page, config, stageLabel);
  await waitForCloudflareIfPresent(page, config, stageLabel);
  await throwIfAddPhonePage(page, config, stageLabel);
}

async function safeGoto(page, url, options = {}) {
  try {
    await page.goto(url, options);
  } catch (error) {
    const message = String(error?.message || error);
    const tolerated = /net::ERR_ABORTED|frame was detached|navigation|Execution context was destroyed/i.test(message)
      && page.url() !== 'about:blank';
    if (!tolerated) throw error;
    await logStep(`navigation continued after transient error: ${message.split('\n')[0]}`);
  }
}

async function waitForCloudflareIfPresent(page, config, stageLabel = 'page') {
  if (!config) return false;

  const firstState = await detectCloudflareChallenge(page);
  if (!firstState.ok) return false;

  const timeoutMs = Math.max(30000, Number(config.cloudflareTimeoutMs) || 600000);
  if (config.headless || !config.pauseForCloudflare) {
    throw new Error(
      `Cloudflare human verification required at ${stageLabel}. Use non-headless Chrome and PAUSE_FOR_CLOUDFLARE=true. Current URL: ${page.url()}`
    );
  }

  await logStep(
    `Cloudflare human verification detected at ${stageLabel}. Finish it in the opened Chrome window; waiting up to ${Math.round(timeoutMs / 1000)}s.`
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
    await throwIfAddPhonePage(page, config, stageLabel);

    const state = await detectCloudflareChallenge(page);
    if (!state.ok) {
      await logStep(`Cloudflare verification cleared at ${stageLabel}.`);
      await page.waitForTimeout(800);
      return true;
    }
  }

  const finalState = await detectCloudflareChallenge(page);
  throw new Error(
    `Cloudflare human verification was not cleared within ${Math.round(timeoutMs / 1000)}s at ${stageLabel}. Current URL: ${page.url()}. Title: ${finalState.title || 'unknown'}`
  );
}

async function throwIfAddPhonePage(page, config, stageLabel = 'page') {
  if (!await isAddPhonePage(page)) return;
  if (hasMatchingCallbackPage(page, config?.oauthExpectedState)) {
    await logStep(`OpenAI add-phone page appeared after matching callback at ${stageLabel}; treating callback as authoritative.`);
    return;
  }
  await logStep(`OpenAI add-phone page detected at ${stageLabel}; current OAuth will be discarded and retried with a fresh link.`);
  throw new AddPhoneRetryError(page.url());
}

function hasMatchingCallbackPage(page, expectedState = '') {
  const state = String(expectedState || '').trim();
  if (!state) return false;
  return page.context().pages().some((candidate) => {
    const url = candidate.url();
    return isOAuthCallbackUrl(url) && callbackState(url) === state;
  });
}

async function isAddPhonePage(page) {
  try {
    const parsed = new URL(page.url());
    if (parsed.hostname === 'auth.openai.com' && parsed.pathname === '/add-phone') return true;
  } catch {}

  const text = await textSnapshot(page);
  return /电话号码是必填项|add\s*phone|phone\s*number\s*is\s*required|验证手机号|手机号/i.test(text)
    && /OpenAI|auth\.openai|电话号码|phone/i.test(`${page.url()}\n${text}`);
}

async function detectCloudflareChallenge(page) {
  return page.evaluate((patternSource) => {
    const text = document.body?.innerText || '';
    const title = document.title || '';
    const html = document.documentElement?.outerHTML || '';
    const pattern = new RegExp(patternSource, 'i');
    const hasChallengeDom = Boolean(
      document.querySelector('iframe[src*="challenges.cloudflare.com"]')
      || document.querySelector('input[name="cf-turnstile-response"]')
      || document.querySelector('.cf-turnstile')
      || document.querySelector('#challenge-stage')
      || document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')
    );
    const hasChallengeText = pattern.test(`${title}\n${text}`);
    const hasChallengeHtml = /cdn-cgi\/challenge-platform|cf-turnstile|cf-browser-verification|challenge-stage/i.test(html);
    return {
      ok: hasChallengeDom || (hasChallengeText && hasChallengeHtml),
      title,
      sample: text.replace(/\s+/g, ' ').trim().slice(0, 240),
    };
  }, RE_CLOUDFLARE_TEXT.source).catch(() => ({ ok: false, title: '', sample: '' }));
}

async function textSnapshot(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

async function clearAuthState(context, page, config) {
  if (!config.clearAuthState && !config.clearOauthOrigin && !config.resetOpenAiSessionBeforeLogin) {
    await logStep('preserve browser auth state; CLEAR_AUTH_STATE=false, CLEAR_OAUTH_ORIGIN=false, RESET_OPENAI_SESSION_BEFORE_LOGIN=false.');
    return;
  }

  const origins = new Set(config.clearAuthState ? KNOWN_AUTH_ORIGINS : []);
  if (config.resetOpenAiSessionBeforeLogin) {
    origins.add('https://auth.openai.com');
    origins.add('https://accounts.openai.com');
    origins.add('https://external.auth.openai.com');
  }
  if (config.clearOauthOrigin) {
    try {
      origins.add(new URL(config.oauthUrl).origin);
    } catch {}
  }

  const session = await context.newCDPSession(page).catch(() => null);
  if (!session) return;

  for (const origin of origins) {
    await session.send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers,websql,file_systems',
    }).catch(() => {});
  }
  await session.detach().catch(() => {});
}

async function resetProfileDir(profileDir) {
  const resolved = path.resolve(profileDir);
  const cwdProfiles = path.resolve(process.cwd(), 'profiles');
  const parent = path.dirname(resolved);
  const insideProjectProfiles = resolved === cwdProfiles || resolved.startsWith(`${cwdProfiles}${path.sep}`);
  if (!insideProjectProfiles) {
    throw new Error(`refuse to delete profile outside project profiles dir: ${resolved}`);
  }

  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
}

async function saveFailureArtifacts(page, artifactsDir, error, flowState = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `failure-${stamp}`;
  const screenshotPath = path.join(artifactsDir, `${baseName}.png`);
  const htmlPath = path.join(artifactsDir, `${baseName}.html`);
  const metaPath = path.join(artifactsDir, `${baseName}.json`);

  await fs.mkdir(artifactsDir, { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  await fs.writeFile(htmlPath, html, 'utf8').catch(() => {});
  await fs.writeFile(metaPath, JSON.stringify({
    error: error?.message || String(error),
    url: page.url(),
    flowState,
    savedAt: new Date().toISOString(),
  }, null, 2), 'utf8').catch(() => {});
}

async function logStep(message) {
  console.log(`[gpt-sso-loginer] ${message}`);
}

function normalizeTextForMatch(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function escapedTextPattern(value) {
  return new RegExp(escapeRegExp(String(value || '').replace(/\s+/g, ' ').trim()), 'i');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortUrl(value) {
  const text = String(value || '');
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}
