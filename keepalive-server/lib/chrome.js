'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const WebSocket = require('ws');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Narrower than this, site menus collapse into icons and an agent cannot see the labels.
const MIN_WINDOW_WIDTH = 1440;
const MIN_WINDOW_HEIGHT = 900;

function findChromeBinary(configured) {
  const candidates = [process.env.CHROME_PATH, configured, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('这台机器上没找到 Google Chrome。装好后重试，或在 config.json 里用 chrome_path 指定路径');
}

function cdpRequest(port, pathname, { method = 'GET', timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`CDP ${pathname} answered ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch {
          resolve(body);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Version info when a Chrome answers CDP on this port, otherwise null. */
async function probe(port) {
  try {
    const info = await cdpRequest(port, '/json/version');
    return info && typeof info === 'object' && info.webSocketDebuggerUrl ? info : null;
  } catch {
    return null;
  }
}

async function listPages(port) {
  const targets = await cdpRequest(port, '/json/list');
  return (Array.isArray(targets) ? targets : [])
    .filter((target) => target.type === 'page')
    .map((target) => ({ id: target.id, url: target.url, title: target.title }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Makes sure the platform has a tab. A fresh launch restores the old tab and
 * opens the entry URL again; `closeExtras` drops the duplicates then, before
 * anyone works in them. An adopted Chrome keeps every tab it has.
 */
async function settleEntryTab(port, entryUrl, { closeExtras }) {
  const host = hostOf(entryUrl);
  const pages = (await listPages(port)).filter((page) => hostOf(page.url) === host);
  if (pages.length === 0) {
    await cdpRequest(port, `/json/new?${encodeURI(entryUrl)}`, { method: 'PUT', timeoutMs: 5000 });
    return;
  }
  if (!closeExtras) return;
  for (const extra of pages.slice(1)) {
    await cdpRequest(port, `/json/close/${extra.id}`, { timeoutMs: 5000 }).catch(() => {});
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function pidsListeningOn(port) {
  const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function commandOf(pid) {
  return (await run('ps', ['-p', String(pid), '-o', 'command='])).trim();
}

/** Directory whose path appears on the browser command line. The shell keeps its own folder inside the platform profile. */
function runtimeProfile(profileDir, browser) {
  return browser === 'shell' ? path.join(profileDir, 'shell') : profileDir;
}

const electronRoot = path.join(__dirname, '..', 'node_modules', 'electron');
let electronInstall = null;

function electronBinaryPath() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  const candidates = [
    path.join(electronRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(electronRoot, 'dist', 'electron'),
    path.join(electronRoot, 'dist', 'electron.exe'),
  ];
  try {
    const rel = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim();
    if (rel) candidates.unshift(path.join(electronRoot, 'dist', rel));
  } catch {
    // path.txt is written after a successful extract.
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function cachedElectronZips() {
  const caches = [
    path.join(os.homedir(), 'Library', 'Caches', 'electron'),
    path.join(os.homedir(), '.cache', 'electron'),
  ];
  const found = [];
  for (const cache of caches) {
    let entries = [];
    try { entries = fs.readdirSync(cache); } catch { continue; }
    for (const entry of entries) {
      const dir = path.join(cache, entry);
      let inner = [];
      try { inner = fs.readdirSync(dir); } catch { continue; }
      for (const name of inner) {
        if (name.endsWith('.zip')) found.push(path.join(dir, name));
      }
    }
  }
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function unpackElectronZip(zipPath) {
  fs.rmSync(path.join(electronRoot, 'dist'), { recursive: true, force: true });
  fs.mkdirSync(path.join(electronRoot, 'dist'), { recursive: true });
  const result = spawnSync('unzip', ['-q', zipPath, '-d', path.join(electronRoot, 'dist')], { timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`解压内置浏览器失败：${(result.stderr || result.stdout || '').toString().trim() || 'unzip 没有成功'}`);
  }
  const relative = process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : (process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.writeFileSync(path.join(electronRoot, 'path.txt'), relative);
}

function runElectronInstall() {
  return new Promise((resolve, reject) => {
    const installer = path.join(electronRoot, 'install.js');
    if (!fs.existsSync(installer)) {
      reject(new Error('服务端目录里没有内置浏览器的安装包。先在该目录执行 npm install --omit=dev'));
      return;
    }
    const env = { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [installer], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('下载内置浏览器超过 10 分钟，已停下'));
    }, 10 * 60 * 1000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`下载内置浏览器失败，退出码 ${code}`));
    });
  });
}

/** The Electron executable. Downloads and unpacks it once when the package is present but the app is not. */
function ensureElectronBinary() {
  const ready = electronBinaryPath();
  if (ready) return Promise.resolve(ready);
  if (!electronInstall) {
    electronInstall = (async () => {
      try {
        await runElectronInstall();
      } catch (err) {
        const zip = cachedElectronZips()[0];
        if (!zip) throw err;
        unpackElectronZip(zip);
      }
      const binary = electronBinaryPath();
      if (!binary) throw new Error('内置浏览器没有装好。服务端目录里执行 npm install --omit=dev 后，再启动一次保活服务');
      return binary;
    })().finally(() => { electronInstall = null; });
  }
  return electronInstall;
}

/** The pid of the browser that listens on `port` with our profile, or null. */
async function ownerPid(port, profileDir) {
  for (const pid of await pidsListeningOn(port)) {
    if ((await commandOf(pid)).includes(`--user-data-dir=${profileDir}`)) return pid;
  }
  return null;
}

async function waitFor(check, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

/**
 * Starts the sandbox Chrome, or adopts the one already running on this port with
 * this profile (the keep-alive server restarts without taking Chrome down).
 */
async function start({ binary, port, profileDir, entryUrl, extraArgs }) {
  if (await probe(port)) {
    const pid = await ownerPid(port, profileDir);
    if (!pid) throw new Error(`端口 ${port} 上已经有另一个 Chrome 在用调试端口，换一个 CDP 端口或先关掉它`);
    return { pid, adopted: true };
  }
  const squatters = await pidsListeningOn(port);
  if (squatters.length > 0) {
    if (await ownerPid(port, profileDir)) {
      throw new Error('沙盒 Chrome 的进程还在，但调试端口没有响应。先关掉沙盒 Chrome 再开');
    }
    throw new Error(`端口 ${port} 被别的程序占着（进程 ${squatters.join(', ')}），换一个 CDP 端口`);
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Session cookies only survive a relaunch when the last session is restored
    // and a URL is passed; measured against Chrome on macOS.
    '--restore-last-session',
    '--hide-crash-restore-bubble',
    // The window is usually covered or on an unattended screen. Without these
    // Chrome throttles the page and the keep-alive clicks stall.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // First paint before the session restores. extraArgs come after, so a
    // platform can still pass its own --window-size. The floor below wins if
    // the restored window is smaller.
    `--window-size=${MIN_WINDOW_WIDTH},${MIN_WINDOW_HEIGHT}`,
    ...(extraArgs || []),
    entryUrl,
  ];
  const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  child.unref();
  const ready = await waitFor(async () => spawnError || Boolean(await probe(port)), 25000);
  if (spawnError) throw new Error(`Chrome 启动失败：${spawnError.message}`);
  if (!ready || !(await probe(port))) {
    throw new Error(`Chrome 启动后 ${port} 端口一直没有响应。这个沙盒目录可能正被另一个 Chrome 进程占用`);
  }
  return { pid: (await ownerPid(port, profileDir)) || child.pid, adopted: false };
}

let shellRuntime = null;
let shellLaunch = null;

function sharedShellDir(dataDir) {
  const shared = path.join(dataDir, 'shell');
  const legacy = path.join(dataDir, 'profiles', 'channels_01', 'shell');
  if (!fs.existsSync(path.join(shared, 'Partitions')) && fs.existsSync(path.join(legacy, 'Partitions'))) {
    fs.renameSync(legacy, shared);
  }
  fs.mkdirSync(shared, { recursive: true });
  return shared;
}

function shellDebugPort() {
  return shellRuntime?.port || 0;
}

/** Port agents and keep-alive visits actually connect to. Shell platforms share one window. */
function debugPort(config) {
  if (config && config.browser === 'shell' && shellDebugPort()) return shellDebugPort();
  return config.cdp_port;
}

function shellProfileDir() {
  return shellRuntime?.dir || '';
}

function readControlPort(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
    return Number(parsed.port) || 0;
  } catch {
    return 0;
  }
}

function controlRequest(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(text || `保活窗口控制端口返回 ${res.statusCode}`));
          return;
        }
        try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('保活窗口控制端口没有响应')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function shellControl() {
  if (!shellRuntime) throw new Error('保活窗口还没打开');
  const port = shellRuntime.controlPort || readControlPort(shellRuntime.dir);
  if (!port) throw new Error('保活窗口的控制端口还没准备好');
  shellRuntime.controlPort = port;
  return port;
}

/**
 * One built-in window for every shell platform. The first caller chooses the
 * debugging port; later platforms add a page to the 保活 group.
 */
async function startShell({ dataDir, port, entryUrl, name, platformId }) {
  if (!shellLaunch) {
    shellLaunch = openShell(dataDir, port).finally(() => { shellLaunch = null; });
  }
  const runtime = await shellLaunch;
  const control = await shellControl();
  await controlRequest(control, 'POST', '/tabs', {
    id: platformId,
    url: entryUrl,
    title: name || platformId,
    group: 'keepalive',
  });
  return { pid: runtime.pid, adopted: runtime.adopted };
}

async function openShell(dataDir, port) {
  const dir = sharedShellDir(dataDir);
  const listenPort = shellRuntime?.port || port;
  if (shellRuntime && await probe(listenPort) && await ownerPid(listenPort, dir)) {
    shellRuntime.adopted = true;
    return shellRuntime;
  }
  const legacyDir = path.join(dataDir, 'profiles', 'channels_01', 'shell');
  if (legacyDir !== dir && await ownerPid(listenPort, legacyDir)) {
    await stop({ port: listenPort, profileDir: legacyDir, pid: null });
  }
  if (await probe(listenPort)) {
    const pid = await ownerPid(listenPort, dir);
    if (!pid) throw new Error(`端口 ${listenPort} 上已经有另一个浏览器在用调试端口，换一个 CDP 端口或先关掉它`);
    shellRuntime = { port: listenPort, dir, controlPort: readControlPort(dir), pid, adopted: true };
    return shellRuntime;
  }
  const squatters = await pidsListeningOn(listenPort);
  if (squatters.length > 0) {
    throw new Error(`端口 ${listenPort} 被别的程序占着（进程 ${squatters.join(', ')}），换一个 CDP 端口`);
  }
  try { fs.unlinkSync(path.join(dir, 'control.json')); } catch { /* first launch */ }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(await ensureElectronBinary(), [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${listenPort}`,
    '--remote-debugging-address=127.0.0.1',
    path.join(__dirname, '..', 'shell.js'),
  ], { detached: true, stdio: 'ignore', env });
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  child.unref();
  const ready = await waitFor(async () => spawnError || (Boolean(await probe(listenPort)) && readControlPort(dir)), 40000);
  if (spawnError) throw new Error(`保活窗口启动失败：${spawnError.message}`);
  if (!ready || !(await probe(listenPort))) throw new Error(`保活窗口启动后 ${listenPort} 端口一直没有响应`);
  shellRuntime = {
    port: listenPort,
    dir,
    controlPort: readControlPort(dir),
    pid: (await ownerPid(listenPort, dir)) || child.pid,
    adopted: false,
  };
  return shellRuntime;
}

async function closeShellTab(platformId) {
  if (!shellRuntime) return;
  const control = await shellControl();
  await controlRequest(control, 'DELETE', `/tabs?id=${encodeURIComponent(platformId)}`);
}

async function shellTabs() {
  if (!shellRuntime || !(await probe(shellRuntime.port))) return [];
  try {
    const control = await shellControl();
    const body = await controlRequest(control, 'GET', '/tabs');
    return body?.tabs || [];
  } catch {
    return [];
  }
}

async function shellHasTab(platformId) {
  const tabs = await shellTabs();
  return tabs.some((tab) => tab.id === platformId && tab.group === 'keepalive');
}

/** The keep-alive tab exists and has landed on this platform's host, not a blank page. */
async function shellTabReady(platformId, entryUrl) {
  const tabs = await shellTabs();
  const tab = tabs.find((item) => item.id === platformId && item.group === 'keepalive');
  const host = hostOf(entryUrl);
  return Boolean(tab && host && hostOf(tab.url) === host);
}

/**
 * Pages an agent should see for one platform. The shared window lists every
 * platform; this keeps the other platforms' tabs out of the response.
 */
async function listPlatformPages(config) {
  const port = debugPort(config);
  const pages = await listPages(port);
  if (!config || config.browser !== 'shell') return pages;
  const host = hostOf(config.entry_url);
  const tabs = await shellTabs();
  const keep = tabs.find((tab) => tab.id === config.platform_id && tab.group === 'keepalive');
  let keepClaimed = false;
  return pages
    .filter((page) => host && hostOf(page.url) === host)
    .map((page) => {
      const isKeep = !keepClaimed && keep && page.url === keep.url;
      if (isKeep) keepClaimed = true;
      return {
        ...page,
        platform_id: config.platform_id,
        group: isKeep ? 'keepalive' : 'work',
      };
    });
}

async function showShell(dataDir) {
  const control = readControlPort(sharedShellDir(dataDir));
  if (!control) return false;
  try {
    await controlRequest(control, 'POST', '/show');
    return true;
  } catch {
    return false;
  }
}

async function stopShellIfEmpty() {
  if (!shellRuntime) return;
  let tabs = [];
  try {
    const control = await shellControl();
    const body = await controlRequest(control, 'GET', '/tabs');
    tabs = (body?.tabs || []).filter((tab) => tab.group === 'keepalive');
  } catch {
    tabs = [];
  }
  if (tabs.length > 0) return;
  const { port, dir, pid } = shellRuntime;
  shellRuntime = null;
  await stop({ port, profileDir: dir, pid });
}

function withCdp(wsUrl, run) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 2000 });
    let nextId = 1;
    const pending = new Map();
    const finish = (err, value) => {
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('CDP timed out')), 5000);
    const send = (method, params) => new Promise((res, rej) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on('open', () => {
      run(send).then(
        (value) => { clearTimeout(timer); finish(null, value); },
        (err) => { clearTimeout(timer); finish(err); },
      );
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.rej(new Error(msg.error.message || 'CDP error'));
      else waiter.res(msg.result || {});
    });
    ws.on('error', (err) => { clearTimeout(timer); finish(err); });
  });
}

async function readWindow(send, targetId) {
  const { windowId, bounds } = await send('Browser.getWindowForTarget', { targetId });
  return { windowId, bounds: bounds || {} };
}

async function applyWindowFloor(send, windowId, bounds) {
  const width = Math.max(Number(bounds.width) || 0, MIN_WINDOW_WIDTH);
  const height = Math.max(Number(bounds.height) || 0, MIN_WINDOW_HEIGHT);
  const left = Number.isFinite(bounds.left) ? bounds.left : 40;
  const top = Number.isFinite(bounds.top) ? bounds.top : 40;
  // macOS ignores a size sent in the same call as a state change, and ignores
  // width and height when left and top are omitted.
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId, bounds: { left, top, width, height } });
}

/**
 * Grow a restored or hand-shrunk window up to the floor. A window that is
 * already at least this big, maximized, or fullscreen is left alone.
 * Returns false when this Chrome has no window (headless).
 */
async function ensureWindowSize(port) {
  const info = await probe(port);
  const targetId = (await listPages(port))[0]?.id;
  if (!info?.webSocketDebuggerUrl || !targetId) return false;
  return withCdp(info.webSocketDebuggerUrl, async (send) => {
    const first = await readWindow(send, targetId);
    if (!first.windowId) return false;
    if (first.bounds.windowState === 'maximized' || first.bounds.windowState === 'fullscreen') return true;
    const width = Number(first.bounds.width) || 0;
    const height = Number(first.bounds.height) || 0;
    if (width >= MIN_WINDOW_WIDTH && height >= MIN_WINDOW_HEIGHT) return true;
    await applyWindowFloor(send, first.windowId, first.bounds);
    const again = await readWindow(send, targetId);
    const grownW = Number(again.bounds.width) || 0;
    const grownH = Number(again.bounds.height) || 0;
    if (grownW < MIN_WINDOW_WIDTH || grownH < MIN_WINDOW_HEIGHT) {
      throw new Error(`窗口仍是 ${grownW || '?'}×${grownH || '?'}，没有拉开到 ${MIN_WINDOW_WIDTH}×${MIN_WINDOW_HEIGHT}`);
    }
    return true;
  });
}

function closeOverCdp(wsUrl) {
  return new Promise((resolve) => {
    let ws;
    const done = () => {
      try { ws.terminate(); } catch { /* already closed */ }
      resolve();
    };
    const timer = setTimeout(done, 3000);
    try {
      ws = new WebSocket(wsUrl, { handshakeTimeout: 2000 });
    } catch {
      clearTimeout(timer);
      resolve();
      return;
    }
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.on('close', () => { clearTimeout(timer); resolve(); });
    ws.on('error', () => { clearTimeout(timer); done(); });
  });
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
}

/** Asks Chrome to quit so it flushes cookies, then signals the process if it stays. */
async function stop({ port, profileDir, pid }) {
  const target = (await ownerPid(port, profileDir)) || pid || null;
  const info = await probe(port);
  if (info && target) {
    await closeOverCdp(info.webSocketDebuggerUrl);
    if (await waitFor(async () => !(await probe(port)), 8000)) return;
  }
  if (!target) {
    if (info) throw new Error(`端口 ${port} 上的 Chrome 不是这个沙盒启动的，没有去关它`);
    return;
  }
  signal(target, 'SIGTERM');
  if (await waitFor(async () => !(await probe(port)), 6000)) return;
  signal(target, 'SIGKILL');
  await waitFor(async () => !(await probe(port)), 3000);
}

module.exports = {
  findChromeBinary,
  findElectronBinary: electronBinaryPath,
  ensureElectronBinary,
  shellDebugPort,
  debugPort,
  closeShellTab,
  shellHasTab,
  shellTabReady,
  listPlatformPages,
  showShell,
  stopShellIfEmpty,
  runtimeProfile,
  ownerPid,
  probe,
  listPages,
  settleEntryTab,
  ensureWindowSize,
  start,
  startShell,
  stop,
  hostOf,
  sleep,
};
