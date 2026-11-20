'use strict';

const http = require('http');

/**
 * A stand-in creator backend for the smoke test: a dashboard with two tabs that
 * call an API, and a login page. `state` is flipped by the test to log the
 * session out or to rename the tabs as a redesign would.
 */
function startFakeSite() {
  const state = { loggedIn: true, logoutStyle: 'redirect', redesigned: false, apiHits: 0 };

  const dashboard = () => `<!doctype html><meta charset="utf-8"><title>创作者后台</title>
<nav>
  <a href="#" id="tab-content">${state.redesigned ? '作品' : '内容管理'}</a>
  <a href="#" id="tab-data">${state.redesigned ? '数据' : '数据中心'}</a>
</nav>
<main id="main">首页</main>
<script>
  async function load(tab) {
    const res = await fetch('/api/data?tab=' + tab);
    const data = await res.json();
    document.getElementById('main').textContent = data.errCode ? '加载失败' : tab + ' 已加载';
  }
  document.getElementById('tab-content').onclick = (e) => { e.preventDefault(); load('content'); };
  document.getElementById('tab-data').onclick = (e) => { e.preventDefault(); load('data'); };
</script>`;

  const login = '<!doctype html><meta charset="utf-8"><title>登录</title><h1>微信扫一扫登录</h1><div class="login-qrcode">QR</div>';

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/platform') {
      if (!state.loggedIn && state.logoutStyle === 'redirect') {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboard());
      return;
    }
    if (pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(login);
      return;
    }
    if (pathname === '/api/data') {
      state.apiHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.loggedIn ? { errCode: 0, items: [] } : { errCode: 300334, errMsg: 'not login' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

/** Accepts the Maintainer login used by HermesClient and records every submitted prompt. */
function startFakeHermes() {
  const { WebSocketServer } = require('ws');
  const prompts = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/status')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ auth_required: true, auth_providers: ['basic'] }));
      return;
    }
    if (req.url === '/auth/password-login') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (json.username !== 'admin' || json.password !== 'secret') {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.setHeader('set-cookie', 'hermes_session_at=token; Path=/');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.url === '/api/auth/ws-ticket') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ticket: 'ticket-1' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const sockets = new WebSocketServer({ server, path: '/api/ws' });
  sockets.on('connection', (socket) => {
    const event = (type, payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, payload } }));
    event('gateway.ready', {});
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      const reply = (result) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
      if (frame.method === 'session.most_recent') reply({ session_id: 'stored-1' });
      else if (frame.method === 'session.resume') reply({ session_id: 'live-1', stored_session_id: 'stored-1', messages: [] });
      else if (frame.method === 'prompt.submit') {
        prompts.push(frame.params.text);
        reply({ status: 'streaming' });
        event('message.complete', { text: '收到' });
      } else reply({ ok: true });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        prompts,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          for (const socket of sockets.clients) socket.terminate();
          server.close();
        },
      });
    });
  });
}

module.exports = { startFakeSite, startFakeHermes };
