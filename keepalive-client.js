const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { rejectUnauthorizedForUrl } = require('./tls-policy');

const DEFAULT_PORT = 18990;
// Turning Chrome on waits for the browser to come up; a check waits for the page.
const REQUEST_TIMEOUT_MS = 90 * 1000;
const RETRY_MS = 3000;

function normalizeServerUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('请填保活服务的地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('保活服务的地址不是有效的网址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('保活服务的地址要以 http:// 或 https:// 开头');
  }
  if (!url.port && url.protocol === 'http:') url.port = String(DEFAULT_PORT);
  return `${url.protocol}//${url.host}`;
}

function describeNetworkError(err) {
  const code = err?.code || '';
  if (code === 'ECONNREFUSED') return '连不上：对方没有在这个端口上监听。确认服务器上的保活服务已启动';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '连不上：找不到这个主机名';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return '连不上：网络到不了这台服务器';
  return `连不上：${err?.message || '未知错误'}`;
}

/**
 * Talks to the keep-alive server on the OpenClaw host. Requests resolve to
 * { ok, ... } and never reject. While watched, the socket reconnects on its
 * own and pushes every state change.
 */
class KeepaliveClient extends EventEmitter {
  constructor() {
    super();
    this.baseUrl = '';
    this.ws = null;
    this.watching = false;
    this.retryTimer = null;
    this.link = { state: 'idle', error: '' };
  }

  setBaseUrl(url) {
    this.baseUrl = url;
    if (this.watching) {
      this.dropSocket();
      this.openSocket();
    }
  }

  request(method, pathname, body) {
    return new Promise((resolve) => {
      if (!this.baseUrl) {
        resolve({ ok: false, error: '还没填保活服务的地址' });
        return;
      }
      const target = new URL(pathname, this.baseUrl);
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
        rejectUnauthorized: rejectUnauthorizedForUrl(this.baseUrl),
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not our server
          }
          if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
            resolve({ ok: false, error: `这个地址上不是保活服务（HTTP ${res.statusCode}）` });
            return;
          }
          resolve(parsed);
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('等了 90 秒没有回应'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => resolve({ ok: false, error: describeNetworkError(err) }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  watch() {
    if (this.watching) return;
    this.watching = true;
    this.openSocket();
  }

  unwatch() {
    this.watching = false;
    this.dropSocket();
    this.setLink('idle', '');
  }

  setLink(state, error) {
    this.link = { state, error };
    this.emit('link', this.link);
  }

  openSocket() {
    if (!this.baseUrl) {
      this.setLink('offline', '还没填保活服务的地址');
      return;
    }
    const wsUrl = `${this.baseUrl.replace(/^http/i, 'ws')}/ws`;
    this.setLink('connecting', '');
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: 8000,
      rejectUnauthorized: rejectUnauthorizedForUrl(wsUrl),
    });
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws === ws) this.setLink('connected', '');
    });
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame?.type === 'state' && frame.state) this.emit('state', frame.state);
    });
    let failure = '';
    ws.on('unexpected-response', (_req, res) => {
      failure = `这个地址上不是保活服务（HTTP ${res.statusCode}）`;
      ws.terminate();
    });
    ws.on('error', (err) => {
      if (!failure) failure = describeNetworkError(err);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.watching) return;
      this.setLink('offline', failure || '和保活服务的连接断了，正在重连');
      this.retryTimer = setTimeout(() => this.openSocket(), RETRY_MS);
    });
  }

  dropSocket() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    }
  }
}

module.exports = { KeepaliveClient, normalizeServerUrl, DEFAULT_PORT };
