'use strict';

// End-to-end smoke test: a real server process, a real (headless) Chrome, a fake
// creator backend and a fake Hermes. Takes about three minutes because it waits
// for one scheduled keep-alive round and one crash recovery.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { startFakeSite, startFakeHermes } = require('./fake-site');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;

function check(condition, label, detail) {
  if (!condition) {
    throw new Error(`FAILED: ${label}${detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ''}`);
  }
  passed += 1;
  console.log(`  ok  ${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`FAILED: timed out waiting for ${label}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Timer logic that needs no browser: lock expiry and the stale-script notice. */
async function checkRuntimeRules() {
  const { Store } = require('../lib/store');
  const { PlatformRuntime } = require('../lib/platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-unit-'));
  try {
    const store = new Store(dir, { port: 1 });
    store.addPlatform({ platform_id: 'unit', entry_url: 'http://127.0.0.1:9/', cdp_port: await freePort(), lock_ttl_minutes: 25 });
    const runtime = new PlatformRuntime(store.platforms[0], {
      store,
      log: () => {},
      changed: () => {},
    });

    console.log('lock expiry');
    const lock = await runtime.lock({ owner: 'agent-a' });
    check(lock.expires_at - lock.since === 25 * 60000, 'the lock lasts the configured 25 minutes', lock);
    check(new Store(dir, { port: 1 }).platformState('unit').lock?.owner === 'agent-a', 'the lock is saved, so a server restart keeps it');
    await runtime.tick(lock.expires_at - 1000);
    check(runtime.lockInfo !== null, 'the lock holds until it expires');
    await runtime.tick(lock.expires_at + 1);
    check(runtime.lockInfo === null, 'an expired lock is released on its own');
    check(new Store(dir, { port: 1 }).platformState('unit').lock === null, 'the release is saved');

    console.log('stale script notice');
    runtime.lastKeepalive = { steps: [{ index: 1, action: 'click', selector: 'text=数据中心', ok: false, error: 'Timeout 10000ms exceeded.' }] };
    runtime.trackTrouble(true, { status: 'logged_out' });
    runtime.trackTrouble(true, { status: 'unknown' });
    runtime.trackTrouble(true, { status: 'unknown' });
    check(!runtime.notice?.text, 'two failed rounds stay quiet; a logged-out round does not count');
    runtime.trackTrouble(false, { status: 'unknown' });
    check(runtime.notice?.state === 'pending' && /连续 3 轮没跑通/.test(runtime.notice.text) && /第 2 步 click text=数据中心 失败/.test(runtime.notice.text),
      'the third failed round prepares a notice for the Maintainer', runtime.notice);
    const noticeText = runtime.notice.text;
    runtime.trackTrouble(true, { status: 'unknown' });
    check(runtime.notice.text === noticeText, 'the same streak is reported once');
    runtime.trackTrouble(false, { status: 'alive' });
    check(runtime.troubleRounds === 0, 'a clean round ends the streak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The notify channel: password, local Hermes address, delivery, and the failure log. */
async function checkNotifyChannel() {
  const { Store, LOCAL_HERMES_URL } = require('../lib/store');
  const { Notifier } = require('../lib/notifier');
  const { PlatformRuntime } = require('../lib/platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-notify-'));
  const lines = [];
  const log = (line) => lines.push(line);
  const hermes = await startFakeHermes();
  try {
    console.log('notify channel');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      notify: {
        hermes_url: 'https://server.dog-haddock.ts.net:8443',
        username: ' admin ',
        password: 'secret ',
      },
    }));
    const store = new Store(dir, { port: 1 });
    check(store.notify.password === 'secret' && store.notify.username === 'admin', 'a saved password and username lose surrounding spaces');
    check(store.notify.hermes_url === LOCAL_HERMES_URL, 'a public Hermes address is rewritten to the local dashboard', store.notify);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    check(saved.notify.password === 'secret' && saved.notify.hermes_url === LOCAL_HERMES_URL, 'the corrected notify config is written back');
    store.updateNotify({ hermes_url: LOCAL_HERMES_URL, username: 'admin' });
    check(store.notify.password === 'secret', 'saving notify settings without a password keeps the saved one');
    store.updateNotify({ password: '   ' });
    check(store.notify.password === 'secret', 'a blank password does not wipe the saved one');
    store.updateNotify({ password: ' secret ' });
    check(store.notify.password === 'secret', 'a password is trimmed before it is stored');
    let rejected = null;
    try {
      store.updateNotify({ hermes_url: 'https://server.dog-haddock.ts.net:8443' });
    } catch (err) {
      rejected = err;
    }
    check(rejected && store.notify.hermes_url === LOCAL_HERMES_URL, 'a public Hermes address is refused', rejected && rejected.message);

    store.updateNotify({ hermes_url: hermes.url, username: 'admin', password: 'secret' });
    const notifier = new Notifier(() => store.notify, log);
    await notifier.send('hello');
    check(hermes.prompts.length === 1 && hermes.prompts[0] === 'hello', 'a configured notifier delivers to local Hermes');
    check(notifier.status().reachable === true && notifier.status().last_error === '' && notifier.status().last_tried_at > 0,
      'a successful send marks the channel healthy', notifier.status());

    store.updateNotify({ password: 'wrong' });
    lines.length = 0;
    let failed = false;
    try {
      await notifier.send('again');
    } catch {
      failed = true;
    }
    check(failed && hermes.prompts.length === 1, 'a bad password does not deliver');
    check(lines.some((line) => line.startsWith(`notify failed url=${hermes.url}`) && line.includes('error=Invalid account or password')),
      'a failed send is logged with the url and the error', lines);
    check(notifier.status().reachable === false && notifier.status().last_error === 'Invalid account or password',
      'a failed send marks the channel broken', notifier.status());

    store.updateNotify({ hermes_url: hermes.url, username: 'admin', password: 'secret' });
    const runtime = new PlatformRuntime(store.addPlatform({
      platform_id: 'unit_notify',
      entry_url: 'http://127.0.0.1:9/',
      cdp_port: await freePort(),
    }), { store, notifier, log, changed: () => {} });
    await runtime.sendNotice('logged_out');
    check(runtime.notice.state === 'sent' && hermes.prompts.length === 2, 'a logout notice is sent through local Hermes', runtime.notice);
  } finally {
    hermes.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await checkRuntimeRules();
  await checkNotifyChannel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-smoke-'));
  const port = await freePort();
  const cdpPort = await freePort();
  const site = await startFakeSite();
  const hermes = await startFakeHermes();
  const base = `http://127.0.0.1:${port}`;
  let server = null;
  let serverLog = '';

  const startServer = async () => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'),
      '--port', String(port), '--host', '127.0.0.1', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (chunk) => { serverLog += chunk; });
    server.stderr.on('data', (chunk) => { serverLog += chunk; });
    await waitUntil(async () => fetch(`${base}/api/state`).then((res) => res.ok, () => false), 10000, 'server to listen');
  };
  const stopServer = async () => {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  };
  const api = async (method, pathname, body, headers) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const platform = async () => (await api('GET', '/api/platforms/fake_01')).body.platform;
  const status = async () => (await platform()).status;

  // Leaves no Chrome or server behind, whether a check failed or the run was interrupted.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await api('POST', '/api/platforms/fake_01/chrome', { on: false }).catch(() => {});
    if (server && server.exitCode === null) await stopServer().catch(() => {});
    site.close();
    hermes.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE']) {
    process.on(name, () => cleanup().finally(() => process.exit(130)));
  }
  process.stdout.on('error', () => cleanup().finally(() => process.exit(1)));

  const script = {
    keepAlive: {
      steps: [
        { action: 'open' },
        { action: 'click', selector: 'text=数据中心' },
        { action: 'wait', ms: [200, 400] },
        { action: 'click', selector: 'text=内容管理' },
      ],
    },
    detect: {
      loginUrlPattern: '/\\/login/i',
      requiredUrlSubstr: '/platform',
      logoutTextPattern: '微信扫一扫登录|请重新登录',
      qrSelector: '.login-qrcode',
      aliveSelectors: ['text=内容管理'],
      apiHostFilter: '127.0.0.1',
      apiAuthErrorCodes: [300334],
    },
  };

  try {
    await startServer();

    console.log('platform config');
    let res = await api('POST', '/api/platforms', {
      platform_id: 'fake_01',
      platform_type: 'wechat_channels',
      browser: 'chrome',
      name: '假视频号',
      entry_url: `${site.url}/platform`,
      cdp_port: cdpPort,
      chrome_args: ['--headless=new'],
      keep_alive: { interval_minutes: 1, jitter_minutes: 0 },
    });
    check(res.status === 200 && res.body.platform.lock_ttl_minutes === 10, 'platform is created with a 10 minute lock by default', res.body);
    res = await api('POST', '/api/platforms', { platform_id: 'dup', entry_url: site.url, cdp_port: cdpPort });
    check(res.status === 409, 'a second platform cannot take the same CDP port', res.body);
    res = await api('PUT', '/api/platforms/fake_01', { lock_ttl_minutes: 45 });
    check(res.body.platform?.lock_ttl_minutes === 45, 'lock expiry is configurable per platform', res.body);
    res = await api('PUT', '/api/platforms/fake_01', { keep_alive: { jitter_minutes: 5 } });
    check(res.status === 400, 'jitter must stay below the interval', res.body);
    res = await api('GET', '/api/state', null, { Origin: 'http://evil.example' });
    check(res.status === 403, 'requests from a web page are refused');

    console.log('chrome on, no script yet');
    res = await api('POST', '/api/platforms/fake_01/chrome', { on: true });
    check(res.status === 200 && res.body.platform.status.browser_alive === true, 'sandbox Chrome starts', res.body);
    const firstPid = res.body.platform.status.chrome_pid;
    check(Number.isInteger(firstPid) && pidAlive(firstPid), 'the Chrome pid is tracked', firstPid);
    res = await api('GET', '/api/platforms/fake_01');
    check(res.body.pages.some((page) => page.url.includes('/platform')), 'the entry page is open', res.body.pages);
    check(res.body.cdp_ws.startsWith('ws://'), 'the CDP endpoint is reported for agents', res.body.cdp_ws);
    res = await api('POST', '/api/platforms/fake_01/check');
    check(res.body.detection?.reason === 'no_script', 'without a script nothing is judged', res.body);
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.result === 'no_script' && site.state.apiHits === 0, 'without a script nothing is clicked', res.body);

    console.log('agent script');
    res = await api('PUT', '/api/platforms/fake_01/script', { keepAlive: { steps: [{ action: 'tap' }] }, detect: {} });
    check(res.status === 400 && /action/.test(res.body.error), 'a bad script is rejected with the reason', res.body);
    res = await api('PUT', '/api/platforms/fake_01/script', script);
    check(res.status === 200, 'a valid script is accepted', res.body);
    check((await status()).script.state === 'ok', 'the script shows as ready');
    res = await api('POST', '/api/platforms/fake_01/check');
    check(res.body.detection?.status === 'alive', 'read-only check sees the logged-in dashboard', res.body);
    check(site.state.apiHits === 0, 'the read-only check clicked nothing');
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.result === 'ok' && res.body.keepalive.steps.length === 4, 'a keep-alive round runs all steps', res.body.keepalive);
    check(site.state.apiHits === 2, 'the clicks made the page call its own API', site.state.apiHits);

    console.log('busy lock');
    res = await api('POST', '/api/platforms/fake_01/lock', { owner: 'agent-a' });
    check(res.body.lock?.ttl_minutes === 45, 'a lock takes the configured expiry', res.body);
    res = await api('POST', '/api/platforms/fake_01/lock', { owner: 'agent-a', ttl_minutes: 90 });
    check(res.body.lock?.ttl_minutes === 90, 'the holder can ask for a longer lock', res.body);
    res = await api('POST', '/api/platforms/fake_01/lock', { owner: 'agent-b' });
    check(res.status === 409, 'a second owner is refused while the lock is held', res.body);
    const hitsBefore = site.state.apiHits;
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.result === 'skipped_locked' && site.state.apiHits === hitsBefore, 'keep-alive skips its round while locked', res.body.keepalive);
    res = await api('POST', '/api/platforms/fake_01/unlock', { owner: 'agent-b' });
    check(res.status === 409, 'only the holder can unlock', res.body);
    res = await api('POST', '/api/platforms/fake_01/unlock', { owner: 'agent-a' });
    check(res.body.released === true && (await status()).lock === null, 'the holder unlocks', res.body);

    console.log('scheduled round (waits up to 90s)');
    await waitUntil(async () => (await status()).last_keepalive?.source === '定时', 90000, 'a scheduled keep-alive round');
    check((await status()).last_keepalive.result === 'ok', 'the timer fired a keep-alive round on its own');
    res = await api('POST', '/api/platforms/fake_01/pause', { paused: true });
    check(res.body.platform.status.paused === true && res.body.platform.status.next_keepalive_at === 0, 'pause stops the timer', res.body.platform.status);

    console.log('logout seen through the API');
    site.state.loggedIn = false;
    site.state.logoutStyle = 'api';
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.detection?.reason === 'api_auth_failed', 'an auth error code during the round means logged out', res.body.keepalive);
    const pending = (await status()).notice;
    check(pending.state === 'pending' && /假视频号（fake_01）掉线，请去重新登录/.test(pending.text), 'the logout is waiting for QiziShell to tell the Maintainer', pending);
    check(hermes.prompts.length === 0, 'the keep-alive server does not sign in to Hermes itself');
    check((await status()).awaiting_login === true, 'the platform waits for login');
    res = await api('POST', '/api/platforms/fake_01/ack', { at: pending.at });
    check(res.body.acked === true && (await status()).notice.state === 'sent', 'QiziShell can mark the notice delivered', res.body);
    await api('POST', '/api/platforms/fake_01/keepalive');
    check((await status()).notice.at === pending.at, 'the same outage is not raised again');
    site.state.loggedIn = true;
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.platform.status.awaiting_login === false && res.body.platform.status.session.status === 'alive', 'keep-alive resumes once the session is back', res.body.platform.status);

    console.log('logout seen as a login page');
    site.state.loggedIn = false;
    site.state.logoutStyle = 'redirect';
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.detection?.reason === 'login_url', 'a redirect to the login page means logged out', res.body.keepalive);
    check((await status()).notice.state === 'pending' && hermes.prompts.length === 0, 'a new outage waits for QiziShell again');
    site.state.loggedIn = true;
    await api('POST', '/api/platforms/fake_01/keepalive');
    check((await status()).awaiting_login === false, 'a new login clears the outage');

    console.log('page redesign');
    site.state.redesigned = true;
    res = await api('POST', '/api/platforms/fake_01/keepalive');
    check(res.body.keepalive?.result === 'action_failed' && res.body.keepalive.steps[1].ok === false, 'a step that no longer matches is reported, not treated as logout', res.body.keepalive);
    check(res.body.platform.status.awaiting_login === false, 'a failed step does not trigger a login request');
    site.state.redesigned = false;

    console.log('server restart keeps Chrome');
    await stopServer();
    check(pidAlive(firstPid), 'Chrome outlives the keep-alive server');
    await startServer();
    await waitUntil(async () => (await status()).browser_alive, 20000, 'the restarted server to adopt Chrome');
    check((await status()).chrome_pid === firstPid, 'the restarted server adopts the same Chrome');
    check((await status()).paused === true, 'pause survives a server restart');

    console.log('crash recovery (waits up to 60s)');
    process.kill(firstPid, 'SIGKILL');
    await waitUntil(async () => {
      const now = await status();
      return now.browser_alive && !now.transition && now.chrome_pid && now.chrome_pid !== firstPid;
    }, 60000, 'Chrome to be restarted');
    check(true, 'a killed Chrome is restarted automatically');
    res = await api('GET', '/api/platforms/fake_01');
    const platformTabs = res.body.pages.filter((page) => page.url.startsWith(site.url));
    check(platformTabs.length === 1, 'the relaunch leaves a single platform tab', res.body.pages);

    console.log('live updates');
    const frame = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('message', (raw) => { ws.close(); resolve(JSON.parse(String(raw))); });
      ws.once('error', reject);
    });
    check(frame.type === 'state' && frame.state.platforms[0].platform_id === 'fake_01', 'the socket pushes the full state on connect');

    console.log('chrome off');
    const lastPid = (await status()).chrome_pid;
    res = await api('POST', '/api/platforms/fake_01/chrome', { on: false });
    check(res.body.platform.status.browser_alive === false, 'sandbox Chrome stops', res.body.platform.status);
    await sleep(1000);
    check(!pidAlive(lastPid), 'the Chrome process is gone');
    res = await api('DELETE', '/api/platforms/fake_01');
    check(res.status === 200 && (await api('GET', '/api/state')).body.platforms.length === 0, 'the platform is removed');

    console.log(`\nkeep-alive server smoke ok (${passed} checks)`);
  } catch (err) {
    console.error(`\n${err.message}\n\n--- server log ---\n${serverLog}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main();
