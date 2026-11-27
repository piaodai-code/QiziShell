// One keep-alive window for every platform that uses the built-in browser.
// Keep-alive pages sit in the 保活 group. Pages opened from those pages, or
// added without a platform id, sit outside that group.
const { app, BrowserWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

function arg(name) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

const profileDir = arg('user-data-dir');
const debugPort = arg('remote-debugging-port');
const chromeVersion = process.versions.chrome;
const major = String(chromeVersion).split('.')[0];
const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
const secChUa = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`;
const BAR_HEIGHT = 40;

if (!profileDir || !debugPort) {
  console.error('shell.js needs --user-data-dir and --remote-debugging-port');
  process.exit(1);
}

app.userAgentFallback = ua;
app.commandLine.appendSwitch('remote-debugging-port', debugPort);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let quitting = false;
let layingOut = false;
let tray = null;
let win = null;
let bar = null;
let activeId = '';
let barMode = 'keepalive';
const tabs = new Map();

function noteCrash(kind, err) {
  const text = err && err.stack ? err.stack : String(err?.message || err || '');
  const line = `${new Date().toISOString()} ${kind}: ${text}\n`;
  console.error(`[shell] ${line.trim()}`);
  try { fs.appendFileSync(path.join(profileDir, 'shell.log'), line); } catch { /* log dir not ready */ }
}

process.on('uncaughtException', (err) => noteCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => noteCrash('unhandledRejection', err));

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'shell-icon.png'));
  const sized = icon.resize({ width: 18, height: 18 });
  sized.setTemplateImage(true);
  return sized;
}

function writePreload(name, source) {
  fs.mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, name);
  fs.writeFileSync(file, source);
  return file;
}

const pagePreload = writePreload('preload.js', `(() => {
  const brands = [
    { brand: 'Google Chrome', version: '${major}' },
    { brand: 'Chromium', version: '${major}' },
    { brand: 'Not_A Brand', version: '24' },
  ];
  const data = {
    brands,
    mobile: false,
    platform: 'macOS',
    getHighEntropyValues: async () => ({
      brands,
      fullVersionList: brands.map((item) => ({ brand: item.brand, version: '${chromeVersion}' })),
      platform: 'macOS',
      mobile: false,
      architecture: 'arm',
      bitness: '64',
      uaFullVersion: '${chromeVersion}',
    }),
  };
  try {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data, configurable: true });
  } catch (err) {}
})();
`);

const barPreload = writePreload('bar-preload.js', `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bar', {
  select: (id) => ipcRenderer.send('bar-select', id),
  close: (id) => ipcRenderer.send('bar-close', id),
  mode: (mode) => ipcRenderer.send('bar-mode', mode),
});
`);

function downloadDirectory() {
  return path.join(path.dirname(profileDir), 'downloads');
}

function pageSession() {
  const ses = session.fromPartition('persist:keepalive');
  ses.setUserAgent(ua, 'zh-CN,zh,en');
  if (!ses.__qiziHeaders) {
    ses.__qiziHeaders = true;
    const dir = downloadDirectory();
    fs.mkdirSync(dir, { recursive: true });
    ses.on('will-download', (_event, item) => {
      const raw = path.basename(item.getFilename() || 'download');
      let dest = path.join(dir, raw);
      if (fs.existsSync(dest)) {
        const ext = path.extname(raw);
        const stem = path.basename(raw, ext);
        dest = path.join(dir, `${stem}-${Date.now()}${ext}`);
      }
      item.setSavePath(dest);
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      headers['User-Agent'] = ua;
      headers['sec-ch-ua'] = secChUa;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"macOS"';
      callback({ requestHeaders: headers });
    });
  }
  return ses;
}

let cover = null;

function inBarMode(tab) {
  return barMode === 'work' ? tab.group !== 'keepalive' : tab.group === 'keepalive';
}

function nextVisibleId(excluding) {
  const found = [...tabs.values()].find((tab) => tab.id !== excluding && inBarMode(tab));
  return found ? found.id : '';
}

function childAlive(view) {
  if (!view) return false;
  try {
    const contents = view.webContents;
    return Boolean(contents && !contents.isDestroyed());
  } catch {
    return false;
  }
}

function place(view, bounds, attach) {
  if (!childAlive(view) || !win || win.isDestroyed()) return false;
  try {
    view.setBounds(bounds);
    if (attach) win.contentView.addChildView(view);
    return true;
  } catch (err) {
    noteCrash('layout', err);
    return false;
  }
}

function mountBar() {
  const view = new WebContentsView({
    webPreferences: { preload: barPreload, contextIsolation: true, backgroundThrottling: false },
  });
  view.webContents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit') return;
    noteCrash('bar render-process-gone', details?.reason || 'gone');
    if (bar === view) bar = null;
  });
  view.webContents.on('destroyed', () => {
    noteCrash('bar destroyed', 'tab bar webContents destroyed');
    if (bar === view) bar = null;
    setImmediate(() => layout());
  });
  view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml())}`);
  bar = view;
  return view;
}

function ensureCover() {
  if (childAlive(cover)) return cover;
  cover = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  cover.webContents.loadURL('data:text/html;charset=utf-8,<body style="margin:0;background:%23f4f4f5">');
  return cover;
}

function dropDeadTabs() {
  for (const [id, tab] of [...tabs.entries()]) {
    if (childAlive(tab.view)) continue;
    noteCrash('drop tab', `${id} webContents gone`);
    tabs.delete(id);
    try { win.contentView.removeChildView(tab.view); } catch { /* already gone */ }
    if (activeId === id) activeId = nextVisibleId(id);
  }
}

function layout() {
  if (layingOut || !win || win.isDestroyed()) return;
  layingOut = true;
  try {
    dropDeadTabs();
    const [width, height] = win.getContentSize();
    const bounds = { x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) };
    for (const tab of tabs.values()) place(tab.view, bounds, false);
    const active = tabs.get(activeId);
    if (active) place(active.view, bounds, true);
    else place(ensureCover(), bounds, true);
    const top = childAlive(bar) ? bar : mountBar();
    if (!place(top, { x: 0, y: 0, width, height: BAR_HEIGHT }, true) && bar === top) {
      bar = null;
    }
  } finally {
    layingOut = false;
  }
}

function renderBar() {
  if (!childAlive(bar)) return;
  const items = [...tabs.values()].map((tab) => ({
    id: tab.id,
    title: tab.title,
    group: tab.group,
    active: tab.id === activeId,
  }));
  bar.webContents.executeJavaScript(
    `window.renderTabs(${JSON.stringify(items)}, ${JSON.stringify(barMode)})`,
  ).catch(() => {});
}

function showTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  barMode = tab.group === 'keepalive' ? 'keepalive' : 'work';
  activeId = id;
  layout();
  renderBar();
}

function setBarMode(mode) {
  barMode = mode === 'work' ? 'work' : 'keepalive';
  const current = tabs.get(activeId);
  if (!current || !inBarMode(current)) activeId = nextVisibleId('');
  layout();
  renderBar();
}

function attachOpenHandler(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') {
      addTab({ id: `work-${Date.now()}`, url, title: '临时页', group: 'work' });
    }
    return { action: 'deny' };
  });
}

function addTab({ id, url, title, group }) {
  const found = tabs.get(id);
  if (found && !childAlive(found.view)) {
    tabs.delete(id);
    try { win.contentView.removeChildView(found.view); } catch { /* already gone */ }
  }
  const existing = tabs.get(id);
  if (existing) {
    existing.title = title || existing.title;
    try {
      if (url && existing.view.webContents.getURL() !== url) existing.view.webContents.loadURL(url);
    } catch (err) {
      noteCrash(`reload ${id}`, err);
      tabs.delete(id);
      try { win.contentView.removeChildView(existing.view); } catch { /* already gone */ }
    }
    if (tabs.has(id)) {
      showTab(id);
      return;
    }
  }
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: false,
      partition: 'persist:keepalive',
      preload: pagePreload,
    },
  });
  view.webContents.setUserAgent(ua);
  view.webContents.setBackgroundThrottling(false);
  attachOpenHandler(view.webContents);
  view.webContents.on('page-title-updated', (_event, pageTitle) => {
    const tab = tabs.get(id);
    if (!tab || tab.group === 'keepalive') return;
    tab.title = pageTitle || tab.title;
    renderBar();
  });
  view.webContents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit') return;
    noteCrash(`render-process-gone ${id}`, details?.reason || 'gone');
    try { if (!view.webContents.isDestroyed()) view.webContents.destroy(); } catch { /* already gone */ }
  });
  view.webContents.on('destroyed', () => {
    const tab = tabs.get(id);
    if (!tab) return;
    noteCrash('tab destroyed', `${id} group=${tab.group}`);
    tabs.delete(id);
    try { win.contentView.removeChildView(tab.view); } catch { /* already gone */ }
    if (activeId === id) activeId = nextVisibleId(id);
    layout();
    renderBar();
  });
  tabs.set(id, { id, title: title || url, group: group === 'keepalive' ? 'keepalive' : 'work', view });
  win.contentView.addChildView(view);
  if (url) view.webContents.loadURL(url);
  showTab(id);
}

function releaseTab(tab) {
  try { win.contentView.removeChildView(tab.view); } catch { /* already gone */ }
  try { tab.view.webContents?.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab || tab.group === 'keepalive') return;
  tabs.delete(id);
  releaseTab(tab);
  if (activeId === id) activeId = nextVisibleId(id);
  layout();
  renderBar();
}

function removeKeepaliveTab(id) {
  const tab = tabs.get(id);
  if (!tab) return false;
  tabs.delete(id);
  releaseTab(tab);
  if (activeId === id) activeId = nextVisibleId(id);
  layout();
  renderBar();
  return true;
}

function barHtml() {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; font: 13px -apple-system, sans-serif; background: #f4f4f5; color: #18181b; }
    .row { display: flex; align-items: center; height: 40px; gap: 6px; padding: 0 8px; box-sizing: border-box; }
    button { border: 0; background: transparent; border-radius: 8px; height: 28px; padding: 0 10px; color: inherit; cursor: pointer; }
    button.on { background: #fff; box-shadow: 0 0 0 1px #e4e4e7; }
    button.mode { color: #fff; font-weight: 600; padding: 0 12px; flex-shrink: 0; }
    button.mode.keep { background: #137333; }
    button.mode.work { background: #8a8a8a; }
    .x { padding: 0 4px; color: #71717a; }
  </style><div class="row" id="row"></div><script>
    window.renderTabs = (items, mode) => {
      const row = document.getElementById('row');
      row.replaceChildren();
      const showingWork = mode === 'work';
      const toggle = document.createElement('button');
      toggle.className = showingWork ? 'mode work' : 'mode keep';
      toggle.textContent = showingWork ? '工作' : '保活';
      toggle.onclick = () => window.bar.mode(showingWork ? 'keepalive' : 'work');
      row.append(toggle);
      const visible = items.filter((item) => showingWork ? item.group !== 'keepalive' : item.group === 'keepalive');
      for (const item of visible) row.append(tabButton(item, showingWork));
    };
    function tabButton(item, canClose) {
      const button = document.createElement('button');
      button.className = item.active ? 'on' : '';
      button.textContent = item.title;
      button.onclick = () => window.bar.select(item.id);
      if (!canClose) return button;
      const wrap = document.createElement('span');
      const close = document.createElement('button');
      close.className = 'x';
      close.textContent = '×';
      close.onclick = (event) => { event.stopPropagation(); window.bar.close(item.id); };
      wrap.append(button, close);
      return wrap;
    }
  </script>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function startControl() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/tabs') {
        send(res, 200, {
          tabs: [...tabs.values()].flatMap((tab) => {
            if (!childAlive(tab.view)) return [];
            try {
              return [{
                id: tab.id,
                title: tab.title,
                group: tab.group,
                url: tab.view.webContents.getURL(),
              }];
            } catch {
              return [];
            }
          }),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/tabs') {
        const body = await readBody(req);
        if (!body.id || !body.url) return send(res, 400, { ok: false, error: '缺少 id 或 url' });
        addTab({
          id: String(body.id),
          url: String(body.url),
          title: String(body.title || body.url),
          group: body.group === 'work' ? 'work' : 'keepalive',
        });
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/tabs') {
        removeKeepaliveTab(url.searchParams.get('id') || '');
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/show') {
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
        }
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { ok: false });
    } catch (err) {
      send(res, 500, { ok: false, error: err.message });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    fs.writeFileSync(path.join(profileDir, 'control.json'), JSON.stringify({ port }));
  });
}

app.on('before-quit', () => { quitting = true; });
process.on('SIGTERM', () => { quitting = true; app.quit(); });
process.on('SIGINT', () => { quitting = true; app.quit(); });

app.on('browser-window-created', (_event, created) => {
  if (!win || created === win) return;
  created.once('ready-to-show', () => {
    try { win.addTabbedWindow(created); } catch { /* BaseWindow has no native tabs */ }
  });
});

ipcMain.on('bar-select', (_event, id) => showTab(String(id || '')));
ipcMain.on('bar-close', (_event, id) => closeTab(String(id || '')));
ipcMain.on('bar-mode', (_event, mode) => setBarMode(String(mode || '')));

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  pageSession();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: '保活',
    webPreferences: { backgroundThrottling: false },
  });
  mountBar();
  ensureCover();
  win.on('resize', layout);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  const show = () => { win.show(); win.focus(); };
  const hide = () => win.hide();
  tray = new Tray(trayIcon());
  tray.setToolTip('保活');
  const menu = Menu.buildFromTemplate([
    { label: '展开', click: show },
    { label: '收起', click: hide },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    if (win.isVisible()) hide();
    else show();
  });
  tray.on('right-click', () => tray.popUpContextMenu(menu));
  layout();
  const entry = arg('entry');
  if (entry) addTab({ id: arg('id') || 'entry', url: entry, title: arg('name') || '保活', group: 'keepalive' });
  startControl();
});
