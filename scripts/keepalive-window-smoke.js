// Opens the Chrome Keep-alive window against a real keep-alive server (temp data
// dir, headless Chrome, fake creator backend), drives its controls and saves a
// screenshot of each state.
//
//   npx electron scripts/keepalive-window-smoke.js [output-dir]
//
// Runs as its own Electron app with a throwaway userData, so it does not touch
// a running QiziShell.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { localParts: systemLocalParts } = require('../system-local-time');

ipcMain.on('qizi:local-time-parts', (event, ms) => {
  event.returnValue = systemLocalParts(ms);
});
const { startFakeSite } = require('../keepalive-server/test/fake-site');
const { createKeepaliveFeature } = require('../keepalive-main');

const outDir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-window-')));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-window-data-'));
app.setPath('userData', path.join(workDir, 'userData'));

// Electron's helper processes still write into userData after this process has
// exited, so the folder is removed by a detached shell a moment later.
process.on('exit', () => {
  spawn('sh', ['-c', 'sleep 3; rm -rf "$0"', workDir], { detached: true, stdio: 'ignore' }).unref();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;

function check(condition, label, detail) {
  if (!condition) throw new Error(`FAILED: ${label}${detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ''}`);
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
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`FAILED: timed out waiting for ${label}`);
}

async function main() {
  if (app.dock) app.dock.hide();
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const cdpPort = await freePort();
  const site = await startFakeSite();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('node', [path.join(__dirname, '..', 'keepalive-server', 'server.js'),
    '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(workDir, 'server')], { stdio: 'ignore' });
  const api = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  let win = null;
  try {
    await waitUntil(() => fetch(`${base}/api/state`).then((res) => res.ok, () => false), 10000, 'the keep-alive server');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const docsDir = path.join(workDir, 'docs');
    const remembered = path.join(workDir, 'remembered');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(remembered, { recursive: true });
    let directoryPicks = 0;
    fs.writeFileSync(path.join(app.getPath('userData'), 'keepalive-client.json'), JSON.stringify({
      serverUrl: base,
      docsDir: remembered,
    }));

    const feature = createKeepaliveFeature({
      app,
      BrowserWindow,
      ipcMain,
      screen,
      presentWindow: (target) => target.showInactive(),
      cancelPresent: () => {},
      syncDockVisibility: () => {},
      safeSendTo: (sender, channel, payload) => sender.send(channel, payload),
      isMainWindowSender: () => false,
      dialog: {
        showOpenDialog: async () => {
          directoryPicks += 1;
          return { canceled: false, filePaths: [docsDir] };
        },
      },
      forbiddenResult: () => ({ ok: false, error: 'forbidden' }),
      gatewayHost: () => '',
    });
    feature.open();
    win = BrowserWindow.getAllWindows()[0];
    const page = (code) => win.webContents.executeJavaScript(code);
    const text = (selector) => page(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() || ''`);
    const shot = async (name) => {
      await sleep(400);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    };
    await waitUntil(() => page('document.readyState === "complete" && Boolean(window.keepalive)'), 10000, 'the window to load');

    console.log('empty server');
    await waitUntil(async () => (await text('#ka-link')).startsWith('已连接'), 10000, 'the window to connect');
    check((await text('#ka-platforms')).includes('还没有平台'), 'an empty server says how to start');
    const docsText = await text('.ka-docs');
    check(docsText.includes('下载这些文件，交给相应agent，让agent按照说明执行'), 'the download row tells the user to hand the files to the agents');
    check(docsText.includes('服务端程序') && docsText.includes('服务端安装') && docsText.includes('保活维护') && docsText.includes('日常发布'),
      'the window offers the program and the three notes');
    await page('document.querySelector(\'.ka-docs button[data-doc="install"]\').click()');
    await waitUntil(() => fs.existsSync(path.join(docsDir, '服务端安装.md')), 5000, 'the install note to be saved');
    check(fs.readFileSync(path.join(docsDir, '服务端安装.md'), 'utf8').includes('第一次安装'), 'the saved note is the install guide');
    await page('document.querySelector(\'.ka-docs button[data-doc="program"]\').click()');
    const packed = path.join(docsDir, 'qizi-keepalive-server-0.2.0.tgz');
    await waitUntil(() => {
      try {
        const listing = execFileSync('tar', ['-tzf', packed], { encoding: 'utf8' });
        return listing.includes('qizi-keepalive-server/server.js')
          && listing.includes('qizi-keepalive-server/shell.js')
          && listing.includes('服务端安装.md');
      } catch {
        return false;
      }
    }, 8000, 'the server program to be saved');
    check(true, 'the download is the latest server program');
    check(directoryPicks === 2, 'each download asks for a directory', directoryPicks);
    check(fs.readdirSync(remembered).length === 0, 'a previously chosen folder is not reused');
    await shot('01-empty');

    console.log('add platform through the dialog');
    await page('document.getElementById("ka-add").click()');
    check(await page('document.getElementById("ka-dialog").open'), 'the add dialog opens');
    check(await page('document.getElementById("ka-f-url").value') === 'https://channels.weixin.qq.com/platform', 'the 视频号 preset fills the entry URL');
    check(await page('document.getElementById("ka-f-lock").value') === '10', 'lock expiry defaults to 10 minutes');
    await shot('02-add-dialog');
    await page(`
      document.getElementById("ka-f-url").value = ${JSON.stringify(`${site.url}/platform`)};
      document.getElementById("ka-f-args").value = "--headless=new";
      document.getElementById("ka-f-lock").value = 45;
      document.getElementById("ka-f-jitter").value = 5;
      document.getElementById("ka-f-interval").value = 3;
      document.getElementById("ka-f-save").click();
    `);
    await waitUntil(async () => (await page('document.getElementById("ka-f-error").hidden')) === false, 5000, 'the validation error');
    check((await text('#ka-f-error')).includes('时间漂移要小于保活间隔'), 'a rejected form shows the server\'s reason in the dialog');
    await page('document.getElementById("ka-f-interval").value = 15; document.getElementById("ka-f-save").click();');
    await waitUntil(async () => !(await page('document.getElementById("ka-dialog").open')), 5000, 'the dialog to close');
    check((await text('.ka-badge')) === '已停止', 'the new platform shows as stopped');
    check(await page('Boolean(document.getElementById("ka-add").compareDocumentPosition(document.getElementById("ka-platforms")) & Node.DOCUMENT_POSITION_FOLLOWING)'), 'add platform sits above the cards');
    check(await page('Math.round(document.querySelector(".ka-card").getBoundingClientRect().width)') <= 540, 'a platform card stays within the side-panel width');
    check(await page('document.querySelector(".ka-lamp").hidden') === true, 'a stopped platform shows no lamp');
    check((await text('.ka-lock-count')) === '', 'an open lock shows no countdown');
    await shot('03-stopped');

    console.log('chrome on');
    await api('PUT', '/api/platforms/channels_01', { browser: 'chrome', cdp_port: cdpPort });
    await page('document.querySelector(\'input[data-act="chrome"]\').click()');
    await waitUntil(async () => (await text('.ka-badge')) === '待确认', 40000, 'Chrome to start');
    check((await text('.ka-alert')).includes('脚本未就绪'), 'a missing script stops the later checks');
    check(await page('document.querySelector(".ka-lamp").dataset.state') === 'warn', 'a missing script shows a steady yellow lamp');
    check(await page('getComputedStyle(document.querySelector(".ka-lamp")).animationName') === 'none', 'the yellow lamp does not breathe or flash');
    await shot('04-no-script');

    console.log('script arrives');
    await api('PUT', '/api/platforms/channels_01/script', {
      keepAlive: { steps: [{ action: 'click', selector: 'text=数据中心' }, { action: 'wait', ms: 200 }, { action: 'click', selector: 'text=内容管理' }] },
      detect: {
        loginUrlPattern: '/\\/login/i',
        logoutTextPattern: '微信扫一扫登录',
        aliveSelectors: ['text=内容管理'],
        apiHostFilter: '127.0.0.1',
        apiAuthErrorCodes: [300334],
      },
    });
    await page('document.querySelector(\'button[data-act="check"]\').click()');
    await waitUntil(async () => (await text('.ka-badge')) === '已登录', 20000, 'the check to report logged in');
    check((await text('#ka-toast')) === '检测结果：已登录', 'Check Now reports its result');
    check(await page('document.querySelector(".ka-lamp").dataset.state') === 'ok', 'a live platform breathes green');
    check(await page('getComputedStyle(document.querySelector(".ka-lamp")).animationName') === 'ka-breathe', 'the green lamp breathes');
    await api('POST', '/api/platforms/channels_01/keepalive');
    await api('POST', '/api/platforms/channels_01/lock', { owner: 'maintainer', reason: '发布视频' });
    await waitUntil(async () => /^\d+:\d{2}/.test(await text('.ka-lock-count')), 5000, 'the lock countdown to show');
    check(await page('document.querySelector(".ka-lock").classList.contains("is-locked")'), 'a held lock is red');
    await page('document.querySelector(".ka-events summary").click()');
    await shot('05-alive-locked');
    await api('POST', '/api/platforms/channels_01/unlock', { owner: 'maintainer' });
    // Unlock schedules a DOM-only check. If that check runs after the API-style
    // logout below, it sees the dashboard and clears the logout. Let it finish first.
    await sleep(8000);

    console.log('pause');
    await page('document.querySelector(\'input[data-act="pause"]\').click()');
    await waitUntil(async () => (await text('.ka-status')).includes('已暂停'), 5000, 'pause to show');
    check((await text('.ka-badge')) === '已登录', 'pause keeps the logged-in badge');
    check(await page('document.querySelector(".ka-lamp").dataset.state') === 'ok', 'pause keeps the green lamp');
    await page('document.querySelector(\'input[data-act="pause"]\').click()');
    await waitUntil(async () => (await text('.ka-badge')) === '已登录', 5000, 'resume to show');

    console.log('logout');
    site.state.loggedIn = false;
    site.state.logoutStyle = 'api';
    await api('POST', '/api/platforms/channels_01/keepalive');
    await waitUntil(async () => (await text('.ka-badge')) === '已掉线', 10000, 'the logout to show');
    check((await text('.ka-alert')).includes('平台接口返回未登录'), 'the card says why it counts as logged out');
    check(await page('document.querySelector(".ka-lamp").dataset.state') === 'lost', 'a failed keep-alive flashes red');
    check(await page('getComputedStyle(document.querySelector(".ka-lamp")).animationName') === 'ka-flash', 'the red lamp flashes');
    await waitUntil(async () => (await text('.ka-alert')).includes('待通过本机已登录的 Maintainer 发出'), 5000, 'the logout notice to be pending');
    check(true, 'an unsent notice waits for the Maintainer session');
    await shot('06-logged-out');

    console.log('edit dialog');
    await page('document.querySelector(\'button[data-act="edit"]\').click()');
    check(await page('document.getElementById("ka-f-id").readOnly'), 'the platform ID cannot be changed');
    await shot('07-edit-dialog');
    await page('document.getElementById("ka-f-cancel").click()');
    await page('document.getElementById("ka-server-connect").click()');
    await page('document.getElementById("ka-link-port").value = "9999"; document.getElementById("ka-link-save").click();');
    await waitUntil(async () => (await page('document.getElementById("ka-link-error").hidden')) === false, 5000, 'the port change to be refused');
    check((await text('#ka-link-error')).includes('先关闭保活窗口'), 'the port cannot change under a running window');
    await page('document.getElementById("ka-link-cancel").click()');

    console.log('chrome off, server gone');
    await page('document.querySelector(\'input[data-act="chrome"]\').click()');
    await waitUntil(async () => (await text('.ka-badge')) === '已停止', 30000, 'Chrome to stop');
    server.kill('SIGTERM');
    await waitUntil(async () => (await page('document.getElementById("ka-link").dataset.state')) === 'offline', 10000, 'the window to notice the server is gone');
    check(await page('document.querySelector(\'input[data-act="chrome"]\').disabled'), 'controls lock while disconnected');
    await shot('08-offline');

    console.log(`\nkeep-alive window smoke ok (${passed} checks). Screenshots: ${outDir}`);
  } catch (err) {
    console.error(`\n${err.message}`);
    if (win && !win.isDestroyed()) {
      fs.writeFileSync(path.join(outDir, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      console.error(`Screenshot at failure: ${path.join(outDir, 'failure.png')}`);
    }
    process.exitCode = 1;
  } finally {
    await api('POST', '/api/platforms/channels_01/chrome', { on: false }).catch(() => {});
    server.kill('SIGTERM');
    site.close();
    app.exit(process.exitCode || 0);
  }
}

app.whenReady().then(main);
