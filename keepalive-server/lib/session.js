'use strict';

const { chromium } = require('playwright-core');
const { debugPort, ensureWindowSize, hostOf, sleep } = require('./chrome');

const NAV_TIMEOUT_MS = 30000;
const UNKNOWN_RETRIES = 2;
const UNKNOWN_RETRY_WAIT_MS = 4000;
const API_SETTLE_MS = 1500;

function valueAtPath(data, dotted) {
  let current = data;
  for (const key of String(dotted).split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Watches the platform's own API calls while the keep-alive steps run. An idle
 * page sends nothing, so the watch has to span the steps to see anything.
 */
function watchApi(page, detect) {
  const watch = { failed: false, detail: '' };
  const pending = new Set();
  if (!detect.apiHostFilter) {
    return { watch, settle: async () => {}, stop: () => {} };
  }
  const inspect = async (response) => {
    if (!response.url().includes(detect.apiHostFilter)) return;
    const kind = response.request().resourceType();
    if (kind !== 'xhr' && kind !== 'fetch') return;
    if (detect.apiAuthHttpStatuses.includes(response.status())) {
      watch.failed = true;
      watch.detail = `HTTP ${response.status()} ${response.url()}`;
      return;
    }
    if (detect.apiAuthErrorCodes.length === 0) return;
    const contentType = (await response.headerValue('content-type')) || '';
    if (!contentType.includes('json')) return;
    const data = await response.json();
    for (const field of detect.apiAuthErrorFields) {
      const code = valueAtPath(data, field);
      if (code !== undefined && code !== null && detect.apiAuthErrorCodes.includes(String(code))) {
        watch.failed = true;
        watch.detail = `${field}=${code} ${response.url()}`;
        return;
      }
    }
  };
  const onResponse = (response) => {
    // A body can be gone by the time it is read (navigation, closed tab); that response just does not count.
    const task = inspect(response).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  return {
    watch,
    settle: async () => {
      await sleep(API_SETTLE_MS);
      await Promise.race([Promise.allSettled([...pending]), sleep(3000)]);
    },
    stop: () => page.off('response', onResponse),
  };
}

async function isVisible(page, selector) {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

/**
 * logged_out needs positive evidence. A blank, loading or redirecting page is
 * unknown, so a slow network never sends an agent off to log in again.
 */
async function detectOnce(page, detect, apiWatch) {
  const url = page.url();
  if (detect.loginUrlPattern && detect.loginUrlPattern.test(url)) {
    // A fresh window can sit on the login URL for a moment and then jump into
    // the studio. That pause has neither a QR code nor the quick-login card.
    if (detect.qrSelector && await isVisible(page, detect.qrSelector)) {
      return { status: 'logged_out', reason: 'login_url', url };
    }
    const loginText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (detect.logoutTextPattern && detect.logoutTextPattern.test(loginText)) {
      return { status: 'logged_out', reason: 'logout_text', url };
    }
    if (detect.qrSelector || detect.logoutTextPattern) {
      return { status: 'unknown', reason: 'login_url_settling', url };
    }
    return { status: 'logged_out', reason: 'login_url', url };
  }
  if (apiWatch?.failed) {
    return { status: 'logged_out', reason: 'api_auth_failed', detail: apiWatch.detail, url };
  }
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (detect.logoutTextPattern && detect.logoutTextPattern.test(bodyText)) {
    return { status: 'logged_out', reason: 'logout_text', url };
  }
  if (detect.qrSelector && await isVisible(page, detect.qrSelector)) {
    return { status: 'logged_out', reason: 'login_qr', url };
  }
  if (detect.requiredUrlSubstr && !url.includes(detect.requiredUrlSubstr)) {
    return { status: 'unknown', reason: 'url_mismatch', url };
  }
  for (const selector of detect.aliveSelectors) {
    if (await isVisible(page, selector)) return { status: 'alive', reason: 'alive_ui_matched', url };
  }
  return { status: 'unknown', reason: 'no_alive_signal', url };
}

async function detectWithRetry(page, detect, apiWatch) {
  let result = await detectOnce(page, detect, apiWatch);
  for (let attempt = 0; attempt < UNKNOWN_RETRIES && result.status === 'unknown'; attempt += 1) {
    await sleep(UNKNOWN_RETRY_WAIT_MS);
    result = await detectOnce(page, detect, apiWatch);
  }
  if (result.status === 'unknown' && result.reason === 'login_url_settling') {
    return { status: 'logged_out', reason: 'login_url', url: result.url };
  }
  return result;
}

async function runStep(page, step, entryUrl) {
  if (step.action === 'open') {
    await page.goto(step.url || entryUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } else if (step.action === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } else if (step.action === 'click') {
    await page.locator(step.selector).first().click({ timeout: step.timeout_ms });
  } else if (step.action === 'wait') {
    const [min, max] = step.ms;
    await sleep(Math.round(min + Math.random() * (max - min)));
  }
}

async function runSteps(page, steps, entryUrl) {
  const results = [];
  for (const [index, step] of steps.entries()) {
    const startedAt = Date.now();
    const entry = { index, action: step.action, ...(step.selector ? { selector: step.selector } : {}) };
    try {
      await runStep(page, step, entryUrl);
      results.push({ ...entry, ok: true, ms: Date.now() - startedAt });
    } catch (err) {
      const message = String(err?.message || err).split('\n')[0];
      results.push({ ...entry, ok: false, skipped: step.optional === true, ms: Date.now() - startedAt, error: message });
      if (!step.optional) return { ok: false, results };
    }
  }
  return { ok: true, results };
}

async function findPlatformPage(browser, platform, allowOpen) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (!pages.length) throw new Error('保活窗口里没有可用的页面');
  const host = hostOf(platform.entry_url);
  const existing = pages.find((page) => hostOf(page.url()) === host);
  if (existing) return existing;
  if (!allowOpen || platform.browser === 'shell') return null;
  const page = await browser.contexts()[0].newPage();
  await page.goto(platform.entry_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  return page;
}

/**
 * One visit to the sandbox Chrome.
 *   mode 'keepalive': run the agent's steps, then detect using this round's requests.
 *   mode 'check':     detect only. Nothing is clicked or reloaded, so it is safe
 *                     while an agent holds the lock.
 */
async function visit({ platform, script, mode, allowOpen, timeoutMs }) {
  // noDefaults skips Browser.setDownloadBehavior. Current Chrome rejects that
  // command on a browser we did not launch ourselves ("Browser context management
  // is not supported"), which otherwise fails every check and keep-alive visit.
  const port = debugPort(platform);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: 15000,
    noDefaults: true,
  });
  const work = (async () => {
    const page = await findPlatformPage(browser, platform, allowOpen);
    if (platform.browser !== 'shell') await ensureWindowSize(port).catch(() => {});
    if (!page) {
      return { steps: null, detection: { status: 'unknown', reason: 'no_platform_tab', url: '' } };
    }
    if (mode === 'check') {
      return { steps: null, detection: await detectWithRetry(page, script.detect, null) };
    }
    const api = watchApi(page, script.detect);
    try {
      const steps = await runSteps(page, script.keepAlive.steps, platform.entry_url);
      await api.settle();
      return { steps, detection: await detectWithRetry(page, script.detect, api.watch) };
    } finally {
      api.stop();
    }
  })();
  // Once the deadline wins the race, dropping the connection makes `work` reject; nobody is waiting on it by then.
  work.catch(() => {});
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，已中断`)), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // Connected over CDP: this drops our connection and leaves Chrome running.
    await browser.close().catch(() => {});
  }
}

/** Upper bound for one keep-alive round: every step's own limit plus connect, settle and detection. */
function keepaliveBudgetMs(script) {
  let total = 60000;
  for (const step of script.keepAlive.steps) {
    if (step.action === 'wait') total += step.ms[1];
    else if (step.action === 'click') total += step.timeout_ms;
    else total += NAV_TIMEOUT_MS;
  }
  return total;
}

module.exports = { visit, keepaliveBudgetMs };
