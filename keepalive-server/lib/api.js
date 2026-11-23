'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const chrome = require('./chrome');
const { parseScript, loadScript, ScriptError } = require('./script');
const { InputError } = require('./store');

const MAX_BODY_BYTES = 1024 * 1024;
const GUIDE_DIR = path.join(__dirname, '..');
const GUIDES = {
  install: { file: '服务端安装.md', title: '服务端安装（安装、启动、停止）' },
  maintainer: { file: '保活维护.md', title: '保活维护（启动、脚本、重新登录）' },
  publish: { file: '日常发布.md', title: '日常发布（占锁、发完解锁）' },
};

function guideIndex() {
  const lines = ['# Chrome Keep-alive 说明', ''];
  for (const [name, guide] of Object.entries(GUIDES)) {
    lines.push(`- ${guide.title}：GET /api/agent-guide/${name}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}
const TEST_NOTICE = '【Chrome Keep-alive】这是一条测试通知，用来确认保活服务能把消息发到这里。不需要做任何操作。';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError('请求体太大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new InputError('请求体要是一个 JSON 对象'));
      }
    });
  });
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length });
  res.end(payload);
}

function createApi({ hub, store, notifier, log }) {
  async function platformDetail(runtime) {
    const detail = { platform: runtime.snapshot(), pages: [], cdp_ws: '' };
    if (runtime.browserAlive) {
      const port = chrome.debugPort(runtime.config);
      const info = await chrome.probe(port);
      detail.cdp_ws = info?.webSocketDebuggerUrl || '';
      detail.pages = await chrome.listPlatformPages(runtime.config).catch(() => []);
    }
    return detail;
  }

  async function handlePlatform(method, runtime, action, body) {
    if (!action) {
      if (method === 'GET') return platformDetail(runtime);
      if (method === 'PUT') return { platform: (await hub.updatePlatform(runtime.id, body)).snapshot() };
      if (method === 'DELETE') {
        await hub.removePlatform(runtime.id);
        return {};
      }
      return null;
    }
    if (action === 'script') {
      const file = store.scriptPath(runtime.id);
      if (method === 'GET') {
        const loaded = loadScript(file);
        let raw = null;
        try {
          raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          // missing or unreadable: state and error below say which
        }
        return { state: loaded.state, error: loaded.error, path: file, script: raw };
      }
      if (method === 'PUT') {
        parseScript(body);
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
        fs.renameSync(tmp, file);
        runtime.refreshScript();
        return { state: 'ok', path: file };
      }
      return null;
    }
    if (method !== 'POST') return null;
    if (action === 'chrome') {
      await runtime.setChrome(body.on === true);
      return { platform: runtime.snapshot() };
    }
    if (action === 'pause') {
      runtime.setPaused(body.paused === true);
      return { platform: runtime.snapshot() };
    }
    if (action === 'check') return { detection: await runtime.checkNow(), platform: runtime.snapshot() };
    if (action === 'keepalive') {
      return { keepalive: await runtime.keepaliveNow(String(body.owner || '').trim()), platform: runtime.snapshot() };
    }
    if (action === 'lock') return { lock: await runtime.lock(body) };
    if (action === 'unlock') return runtime.unlock(body);
    if (action === 'ack') return runtime.ackNotice(body.at);
    return null;
  }

  async function route(req, body) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (pathname === '/api/state' && method === 'GET') return hub.snapshot();
    if (pathname === '/api/window/show' && method === 'POST') return hub.showWindow();
    if (pathname === '/api/platforms' && method === 'GET') return { platforms: hub.snapshot().platforms };
    if (pathname === '/api/platforms' && method === 'POST') return { platform: hub.addPlatform(body).snapshot() };
    if (pathname === '/api/settings/cdp' && method === 'PUT') return hub.setCdpPort(body.cdp_port);
    if (pathname === '/api/settings/notify' && method === 'PUT') {
      store.updateNotify(body);
      hub.changed();
      return { notify: hub.snapshot().notify };
    }
    if (pathname === '/api/notify/test' && method === 'POST') {
      try {
        await notifier.send(TEST_NOTICE);
      } catch (err) {
        const error = String(err.message || err).split('\n')[0];
        log(`notify failed url=${store.notify.hermes_url} error=${error}`);
        throw new InputError(`测试通知没发出去：${error}`, 502);
      }
      return {};
    }
    const match = /^\/api\/platforms\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?$/.exec(pathname);
    if (match) return handlePlatform(method, hub.get(match[1]), match[2] || '', body);
    return null;
  }

  const server = http.createServer(async (req, res) => {
    // Browsers attach Origin to cross-site requests. QiziShell and agents call from
    // Node or curl and never send it, so a web page cannot drive this API.
    if (req.headers.origin) {
      sendJson(res, 403, { ok: false, error: '不接受来自网页的请求' });
      return;
    }
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (pathname === '/api/agent-guide' || pathname.startsWith('/api/agent-guide/'))) {
        const name = pathname.slice('/api/agent-guide'.length).replace(/^\//, '');
        const guide = GUIDES[name === 'server' ? 'install' : name];
        if (name && !guide) {
          sendJson(res, 404, { ok: false, error: `没有这份说明：${name}` });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(guide ? fs.readFileSync(path.join(GUIDE_DIR, guide.file)) : guideIndex());
        return;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await route(req, body);
      if (result === null) {
        sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${pathname}` });
        return;
      }
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err instanceof InputError || err instanceof ScriptError) {
        sendJson(res, err.status || 400, { ok: false, error: err.message });
        return;
      }
      log(`request failed: ${req.method} ${req.url}: ${err.stack || err}`);
      sendJson(res, 500, { ok: false, error: String(err.message || err).split('\n')[0] });
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws' || req.headers.origin) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'state', state: hub.snapshot() }));
    });
  });
  hub.onChange((snapshot) => {
    const frame = JSON.stringify({ type: 'state', state: snapshot });
    for (const ws of sockets.clients) {
      if (ws.readyState === 1) ws.send(frame);
    }
  });

  return {
    server,
    close: () => {
      for (const ws of sockets.clients) ws.terminate();
      server.close();
    },
  };
}

module.exports = { createApi };
