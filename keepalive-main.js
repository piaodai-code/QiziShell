const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KeepaliveClient, normalizeServerUrl, DEFAULT_PORT } = require('./keepalive-client');

/** Notes the keep-alive window can drop into a folder. The program itself is packed on demand. */
const GUIDE_FILES = {
  install: '服务端安装.md',
  maintainer: '保活维护.md',
  publish: '日常发布.md',
};

function serverVersion() {
  const versionFile = path.join(__dirname, 'keepalive-bundle', 'version');
  try {
    const text = fs.readFileSync(versionFile, 'utf8').trim();
    if (text) return text;
  } catch {
    // Dev checkouts read the server package until a build has written the bundle.
  }
  return require('./keepalive-server/package.json').version;
}

function notePath(fileName) {
  const candidates = [
    path.join(__dirname, 'keepalive-server', fileName),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'keepalive-server', fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function bundledProgram() {
  const candidates = [
    path.join(__dirname, 'keepalive-bundle', 'qizi-keepalive-server.tgz'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'keepalive-bundle', 'qizi-keepalive-server.tgz'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

/** Installed app copies the tarball produced at build time. A checkout packs the current sources. */
async function saveServerProgram(destDir, hostApp) {
  const fileName = `qizi-keepalive-server-${serverVersion()}.tgz`;
  const dest = path.join(destDir, fileName);
  if (hostApp.isPackaged) {
    const bundled = bundledProgram();
    if (!bundled) throw new Error('这个安装包里没有服务端程序');
    fs.copyFileSync(bundled, dest);
    return dest;
  }
  return packServerProgram(destDir);
}

function packServerProgram(destDir) {
  const version = require('./keepalive-server/package.json').version;
  const fileName = `qizi-keepalive-server-${version}.tgz`;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-pack-'));
  const root = path.join(stage, 'qizi-keepalive-server');
  const source = path.join(__dirname, 'keepalive-server');
  try {
    fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'server.js', 'shell.js', 'shell-icon.png', ...Object.values(GUIDE_FILES)]) {
      fs.copyFileSync(path.join(source, name), path.join(root, name));
    }
    fs.cpSync(path.join(source, 'lib'), path.join(root, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'hermes-client.js'), path.join(root, 'vendor', 'hermes-client.js'));
    fs.copyFileSync(path.join(__dirname, 'tls-policy.js'), path.join(root, 'vendor', 'tls-policy.js'));
    const dest = path.join(destDir, fileName);
    return new Promise((resolve, reject) => {
      execFile('tar', ['-czf', dest, '-C', stage, 'qizi-keepalive-server'], (err) => {
        fs.rmSync(stage, { recursive: true, force: true });
        if (err) reject(err);
        else resolve(dest);
      });
    });
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

function platformKeepaliveLost(platform) {
  const status = platform?.status;
  if (!status?.chrome_on || status.paused) return false;
  const scriptReady = status.script && status.script.state === 'ok';
  if (!status.browser_alive || !scriptReady) return false;
  return Boolean(
    status.awaiting_login
    || (status.session && status.session.status !== 'alive')
    || (status.last_keepalive && (status.last_keepalive.result === 'action_failed' || status.last_keepalive.result === 'error')),
  );
}

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 780;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 520;

/** Everything the window may ask the server to do. Anything else is refused. */
const OPERATIONS = {
  'platform.create': (_id, payload) => ['POST', '/api/platforms', payload],
  'platform.update': (id, payload) => ['PUT', `/api/platforms/${id}`, payload],
  'platform.delete': (id) => ['DELETE', `/api/platforms/${id}`],
  chrome: (id, payload) => ['POST', `/api/platforms/${id}/chrome`, { on: payload?.on === true }],
  pause: (id, payload) => ['POST', `/api/platforms/${id}/pause`, { paused: payload?.paused === true }],
  check: (id) => ['POST', `/api/platforms/${id}/check`, {}],
};

/**
 * The Chrome Keep-alive window: a remote control for the keep-alive server that
 * runs next to OpenClaw. Once a server address is saved, QiziShell keeps the
 * connection while it is running and forwards logout notices through the
 * Maintainer session it already has. The sandbox Chrome does not depend on it.
 */
function createKeepaliveFeature({
  app,
  BrowserWindow,
  ipcMain,
  screen,
  presentWindow,
  cancelPresent,
  syncDockVisibility,
  safeSendTo,
  isMainWindowSender,
  isMaintainingWindowSender,
  dialog,
  forbiddenResult,
  gatewayHost,
  relayToMaintainer,
  onKeepaliveAlert,
}) {
  let win = null;
  const client = new KeepaliveClient();
  // Resolved on use: this is created before the app has settled its userData path.
  const settingsPath = () => path.join(app.getPath('userData'), 'keepalive-client.json');

  function readSettings() {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      if (!saved || typeof saved !== 'object') return {};
      // An earlier build stored one folder and reused it. Every download asks again.
      if (saved.docsDir) {
        delete saved.docsDir;
        fs.writeFileSync(settingsPath(), JSON.stringify(saved));
      }
      return saved;
    } catch {
      return {};
    }
  }

  function writeSettings(patch) {
    try {
      fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }));
    } catch {
      // non-fatal: the window still works, it just forgets on next launch
    }
  }

  /** The saved address, or a first guess: the keep-alive server sits on the OpenClaw host. */
  function serverUrl() {
    const saved = String(readSettings().serverUrl || '').trim();
    if (saved) return saved;
    const host = gatewayHost();
    return host ? `http://${host}:${DEFAULT_PORT}` : '';
  }

  function push(channel, payload) {
    if (!win || win.isDestroyed()) return;
    safeSendTo(win.webContents, channel, payload);
  }

  const relayed = new Set();
  const inflight = new Set();
  let lastState = null;
  let relayTimer = null;

  function relayText(platform) {
    const notice = platform.status?.notice;
    if (notice?.text) return notice.text;
    const title = `${platform.name}（${platform.platform_id}）`;
    if (notice?.kind === 'script_trouble') {
      return `【Chrome Keep-alive】${title}的保活脚本连续没跑通，请对照现在的页面更新脚本。`;
    }
    const why = platform.status?.session?.reason_text;
    return [
      `【Chrome Keep-alive】${title}掉线，请去重新登录。`,
      why ? `判定依据：${why}` : '',
      `沙盒 Chrome 的 CDP 地址：http://127.0.0.1:${platform.cdp_port}`,
      '登录前先占锁，登录完解锁。',
    ].filter(Boolean).join('\n');
  }

  function considerRelay(state) {
    lastState = state;
    if (typeof relayToMaintainer !== 'function') return;
    for (const platform of state?.platforms || []) {
      const notice = platform.status?.notice;
      const id = platform.platform_id;
      if (!notice?.kind || notice.state === 'sent' || notice.state === 'idle') {
        for (const key of [...relayed]) {
          if (key.startsWith(`${id}:`)) relayed.delete(key);
        }
        continue;
      }
      if (!['pending', 'failed', 'not_configured'].includes(notice.state)) continue;
      const key = `${id}:${notice.kind}`;
      if (relayed.has(key) || inflight.has(key)) continue;
      inflight.add(key);
      relayToMaintainer(relayText(platform)).then(async () => {
        relayed.add(key);
        push('keepalive:relay', { platformId: id, at: notice.at, ok: true });
        await client.request('POST', `/api/platforms/${id}/ack`, { at: notice.at });
      }).catch((err) => {
        push('keepalive:relay', {
          platformId: id,
          at: notice.at,
          ok: false,
          error: err?.message || 'Maintainer 没连上',
        });
        clearTimeout(relayTimer);
        relayTimer = setTimeout(() => { if (lastState) considerRelay(lastState); }, 20000);
      }).finally(() => inflight.delete(key));
    }
  }

  client.on('state', (state) => {
    push('keepalive:state', state);
    considerRelay(state);
    if (typeof onKeepaliveAlert === 'function') {
      onKeepaliveAlert((state?.platforms || []).some(platformKeepaliveLost));
    }
  });
  client.on('link', (link) => push('keepalive:link', link));

  function loadBounds() {
    const saved = readSettings().bounds || {};
    const width = Math.max(MIN_WIDTH, Math.min(2400, Number(saved.width) || DEFAULT_WIDTH));
    const height = Math.max(MIN_HEIGHT, Math.min(1600, Number(saved.height) || DEFAULT_HEIGHT));
    const x = Number(saved.x);
    const y = Number(saved.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x < area.x + area.width - 80
        && x + width > area.x + 80
        && y < area.y + area.height - 40
        && y + 48 > area.y;
    });
    return visible ? { width, height, x, y } : { width, height };
  }

  function saveBounds() {
    if (!win || win.isDestroyed()) return;
    writeSettings({ bounds: win.getBounds() });
  }

  function open() {
    if (win && !win.isDestroyed()) {
      presentWindow(win, { dock: true });
      return { ok: true };
    }
    win = new BrowserWindow({
      ...loadBounds(),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'Keep-alive',
      show: false,
      fullscreenable: false,
      backgroundColor: '#f2f2f2',
      webPreferences: {
        preload: path.join(__dirname, 'keepalive-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        devTools: Boolean(process.env.QIZI_DEVTOOLS_PORT),
      },
    });
    const created = win;
    created.setMenu(null);
    created.once('ready-to-show', () => presentWindow(created, { dock: true }));
    created.on('close', saveBounds);
    created.on('closed', () => {
      cancelPresent(created);
      if (win === created) win = null;
      // The socket stays up so a logout still reaches Maintainer while QiziShell
      // is only sitting in the menu bar.
      syncDockVisibility();
    });
    created.loadFile(path.join(__dirname, 'keepalive.html'));
    return { ok: true };
  }

  function fromKeepaliveWindow(event) {
    return Boolean(win && !win.isDestroyed() && BrowserWindow.fromWebContents(event.sender) === win);
  }

  async function boot() {
    const url = serverUrl();
    client.setBaseUrl(url);
    client.watch();
    const state = url ? await client.request('GET', '/api/state') : { ok: false, error: '还没填保活服务的地址' };
    if (state?.ok) considerRelay(state);
    return { ok: true, serverUrl: url, link: client.link, state };
  }

  app.whenReady().then(() => {
    const url = serverUrl();
    if (!url) return;
    client.setBaseUrl(url);
    client.watch();
  });

  ipcMain.handle('keepalive:open', (event) => {
    const fromMaintainer = typeof isMaintainingWindowSender === 'function' && isMaintainingWindowSender(event);
    if (!isMainWindowSender(event) && !fromMaintainer) return forbiddenResult();
    return open();
  });

  ipcMain.handle('keepalive:save-guide', async (event, payload) => {
    if (!fromKeepaliveWindow(event)) return { ok: false, error: 'Forbidden' };
    const which = String(payload?.which || '');
    const fileName = GUIDE_FILES[which] || '';
    if (which !== 'program' && !fileName) return { ok: false, error: '没有这份文件' };
    if (!dialog) return { ok: false, error: '还没选择下载目录' };
    const picked = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      buttonLabel: '下载到这里',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    const dir = picked.filePaths[0];
    try {
      if (which === 'program') {
        const dest = await saveServerProgram(dir, app);
        return { ok: true, path: dest, dir };
      }
      const source = notePath(fileName);
      if (!source) return { ok: false, error: `安装包里没有${fileName}` };
      const dest = path.join(dir, fileName);
      fs.copyFileSync(source, dest);
      return { ok: true, path: dest, dir };
    } catch (err) {
      return { ok: false, error: err.message || '没保存成功' };
    }
  });

  ipcMain.handle('keepalive:boot', (event) => {
    if (!fromKeepaliveWindow(event)) return { ok: false, error: 'Forbidden' };
    return boot();
  });

  ipcMain.handle('keepalive:set-server', (event, payload) => {
    if (!fromKeepaliveWindow(event)) return { ok: false, error: 'Forbidden' };
    let url;
    try {
      url = normalizeServerUrl(payload?.url);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    writeSettings({ serverUrl: url });
    return boot();
  });

  ipcMain.handle('keepalive:op', (event, payload) => {
    if (!fromKeepaliveWindow(event)) return { ok: false, error: 'Forbidden' };
    const build = OPERATIONS[String(payload?.op || '')];
    if (!build) return { ok: false, error: '不支持的操作' };
    const platformId = String(payload?.platformId || '');
    if (platformId && !/^[A-Za-z0-9_-]{1,40}$/.test(platformId)) return { ok: false, error: '平台 ID 无效' };
    const [method, pathname, body] = build(platformId, payload?.payload);
    return client.request(method, pathname, body);
  });

  return {
    open,
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
  };
}

module.exports = { createKeepaliveFeature, platformKeepaliveLost };
