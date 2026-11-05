const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { rejectUnauthorizedForUrl } = require('./tls-policy');

// Node's built-in WebSocket rejects a decompressed frame above 4 MB and drops
// the socket. A long Hermes session.resume is larger than that; web chat is not.
const SOCKET_MAX_PAYLOAD = 128 * 1024 * 1024;

const RPC_TIMEOUT_MS = 90 * 1000;
const HTTP_TIMEOUT_MS = 20 * 1000;

function normalizeDashboardUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Address is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Address is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Address must start with http:// or https://');
  }
  url.hash = '';
  url.username = '';
  url.password = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path || '';
  return url.toString().replace(/\/$/, '');
}

function dashboardToWsUrl(base, query) {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`;
  url.search = '';
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && part.type === 'text') return String(part.text || '');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function extractImages(message) {
  const images = [];
  const content = message?.content;
  const push = (url) => {
    const value = String(url || '');
    if (value.startsWith('data:image/') && !images.includes(value)) images.push(value);
  };
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      push(part.image_url?.url || part.url);
      if (typeof part.data === 'string' && part.mime) {
        push(`data:${part.mime};base64,${part.data}`);
      }
    }
  }
  const text = extractText(content ?? message?.text);
  const matches = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
  matches.forEach(push);
  return images;
}

function historyToUiMessages(list) {
  const out = [];
  for (const message of Array.isArray(list) ? list : []) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const images = extractImages(message);
    let text = extractText(message.content ?? message.text ?? '');
    text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text && images.length === 0) continue;
    out.push({
      who: role === 'user' ? 'me' : 'them',
      text,
      images,
      time: '',
    });
  }
  return out;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/s.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('Image could not be read');
  const mime = match[1] || 'image/png';
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
    : mime.includes('gif') ? 'gif'
      : mime.includes('webp') ? 'webp'
        : 'png';
  return { mime, ext, base64: match[2].replace(/\s/g, '') };
}

function clipLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function activityText(type, payload, thoughtTail) {
  const body = payload || {};
  if (type === 'status.update' || type === 'agent.print') return clipLine(body.text);
  if (type === 'notice') return clipLine(body.message || body.text);
  if (type === 'message.interim') return clipLine(body.text);
  if (type === 'tool.generating') return clipLine(`Preparing ${body.name || 'tool'}`);
  if (type === 'tool.start') {
    const name = String(body.name || 'tool');
    const ctx = clipLine(body.context || body.preview || '', 120);
    return ctx ? `${name} · ${ctx}` : name;
  }
  if (type === 'tool.progress') {
    const name = String(body.name || 'tool');
    if (body.message) return clipLine(`${name} · ${body.message}`);
    if (body.percent != null && body.percent !== '') return `${name} · ${body.percent}%`;
    return name;
  }
  if (type === 'tool.complete') {
    const name = String(body.name || 'tool');
    const summary = clipLine(body.summary || '', 120);
    return summary ? `${name} · ${summary}` : `${name} done`;
  }
  if (type === 'thinking.delta' || type === 'reasoning.delta' || type === 'reasoning.available') {
    const snippet = clipLine(thoughtTail, 120);
    return snippet ? `Thinking · ${snippet}` : 'Thinking';
  }
  return '';
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorbCookies(jar, setCookie) {
  const lines = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const line of lines) {
    const pair = String(line).split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function request({ url, method, headers, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Accept: 'application/json, text/html;q=0.8',
        ...(headers || {}),
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        } : {}),
      },
      rejectUnauthorized: rejectUnauthorizedForUrl(url),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Connection timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function providerName(status) {
  const list = status?.auth_providers || status?.providers || [];
  for (const item of list) {
    if (typeof item === 'string' && item === 'basic') return 'basic';
    if (item && typeof item === 'object' && (item.supports_password || item.name === 'basic' || item.id === 'basic')) {
      return String(item.name || item.id || 'basic');
    }
  }
  return 'basic';
}

function splitFrames(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  if (text.includes('\n')) {
    return text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  }
  return [text];
}

class HermesClient extends EventEmitter {
  constructor() {
    super();
    this.cookies = new Map();
    this.ws = null;
    this.generation = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.liveSessionId = '';
    this.storedSessionId = '';
    this.baseUrl = '';
    this.streamBuffer = '';
    this.thoughtTail = '';
    this.pingTimer = null;
    this.intentionalClose = false;
    this.socketReject = null;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1 && this.liveSessionId);
  }

  async prepareSocket({ url, username, password }) {
    this.close();
    this.intentionalClose = false;
    this.cookies = new Map();
    this.liveSessionId = '';
    this.storedSessionId = '';
    this.streamBuffer = '';
    const base = normalizeDashboardUrl(url);
    this.baseUrl = base;
    const statusRes = await request({ url: `${base}/api/status`, method: 'GET' });
    if (statusRes.status < 200 || statusRes.status >= 300) {
      throw new Error(`Hermes did not answer (${statusRes.status || 'offline'})`);
    }
    const status = readJson(statusRes.body) || {};
    let wsUrl;
    if (status.auth_required) {
      const account = String(username || '').trim();
      const secret = String(password || '');
      if (!account || !secret) throw new Error('Account and password are required');
      const login = await request({
        url: `${base}/auth/password-login`,
        method: 'POST',
        body: {
          provider: providerName(status),
          username: account,
          password: secret,
          next: '/',
        },
      });
      absorbCookies(this.cookies, login.headers['set-cookie']);
      if (login.status === 401) throw new Error('Invalid account or password');
      if (login.status === 429) throw new Error('Too many sign-in attempts. Wait a minute and try again');
      if (login.status === 404) throw new Error('This Hermes dashboard has no username and password sign-in');
      if (login.status < 200 || login.status >= 300) {
        throw new Error(`Sign-in failed (${login.status})`);
      }
      const ticketRes = await request({
        url: `${base}/api/auth/ws-ticket`,
        method: 'POST',
        headers: { Cookie: cookieHeader(this.cookies) },
        body: {},
      });
      absorbCookies(this.cookies, ticketRes.headers['set-cookie']);
      const ticketBody = readJson(ticketRes.body) || {};
      if (ticketRes.status < 200 || ticketRes.status >= 300 || !ticketBody.ticket) {
        throw new Error('Sign-in succeeded, but the chat connection was refused');
      }
      wsUrl = dashboardToWsUrl(base, { ticket: ticketBody.ticket });
    } else {
      const page = await request({ url: `${base}/`, method: 'GET' });
      const match = page.body.match(/__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']*)["']/);
      wsUrl = dashboardToWsUrl(base, match?.[1] ? { token: match[1] } : null);
    }
    await this.openSocket(wsUrl);
  }

  async connect(credentials) {
    await this.prepareSocket(credentials);
    const opened = await this.openMainSession();
    if (opened.hasHistory) this.emit('history', opened.messages);
    return opened;
  }

  async probe(credentials) {
    try {
      await this.prepareSocket(credentials);
    } finally {
      this.close();
    }
  }

  openSocket(wsUrl) {
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (this.socketReject === fail) this.socketReject = null;
        reject(err instanceof Error ? err : new Error(String(err || 'Connection failed')));
      };
      this.socketReject = fail;
      const ws = new WebSocket(wsUrl, {
        maxPayload: SOCKET_MAX_PAYLOAD,
        handshakeTimeout: 15_000,
        rejectUnauthorized: rejectUnauthorizedForUrl(wsUrl),
      });
      this.ws = ws;
      const readyTimer = setTimeout(() => {
        if (!ready) fail(new Error('Hermes chat channel did not become ready'));
      }, 15000);
      ws.addEventListener('open', () => {
        if (generation !== this.generation) return;
      });
      ws.addEventListener('message', (event) => {
        if (generation !== this.generation) return;
        const raw = typeof event.data === 'string' ? event.data : String(event.data || '');
        for (const line of splitFrames(raw)) {
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame?.method === 'event' && frame.params?.type === 'gateway.ready') {
            ready = true;
            clearTimeout(readyTimer);
            if (!settled) {
              settled = true;
              if (this.socketReject === fail) this.socketReject = null;
              resolve();
            }
          }
          this.ingest(frame);
        }
      });
      ws.addEventListener('error', () => {
        if (generation !== this.generation) return;
        fail(new Error('Chat connection failed'));
      });
      ws.addEventListener('close', (event) => {
        if (generation !== this.generation) return;
        clearTimeout(readyTimer);
        this.stopPing();
        const code = Number(event.code) || 0;
        if (!settled) {
          fail(code === 4401 ? new Error('Sign-in was rejected') : new Error('Chat connection closed'));
          return;
        }
        this.liveSessionId = '';
        this.rejectPending(new Error('Disconnected'));
        if (!this.intentionalClose) this.emit('close', { code, reason: event.reason || '' });
      });
    });
  }

  async openMainSession() {
    await this.rpc('client.capabilities', { server_requests: true }, 15000);
    this.startPing();
    let stored = '';
    try {
      const recent = await this.rpc('session.most_recent', {}, 30000);
      stored = String(recent?.session_id || '');
    } catch {
      stored = '';
    }
    let opened = null;
    if (stored) {
      try {
        opened = await this.rpc('session.resume', { session_id: stored }, RPC_TIMEOUT_MS);
      } catch (err) {
        if (!this.ws || this.ws.readyState !== 1) {
          const detail = err?.message && err.message !== 'Disconnected' && err.message !== 'Not connected'
            ? err.message
            : 'Chat connection closed while loading the session';
          throw new Error(detail);
        }
        opened = null;
      }
    }
    if (!opened?.session_id) {
      opened = await this.rpc('session.create', {}, RPC_TIMEOUT_MS);
    }
    this.liveSessionId = String(opened.session_id || '');
    this.storedSessionId = String(opened.stored_session_id || opened.resumed || stored || '');
    if (!this.liveSessionId) throw new Error('Hermes did not open a session');
    return {
      messages: historyToUiMessages(opened.messages),
      hasHistory: Array.isArray(opened.messages),
    };
  }

  async submit({ text, images, files }) {
    if (!this.liveSessionId) throw new Error('Not connected');
    const list = Array.isArray(images) ? images : [];
    for (const image of list) {
      const parsed = parseDataUrl(image?.dataUrl || image);
      await this.rpc('image.attach_bytes', {
        session_id: this.liveSessionId,
        content_base64: parsed.base64,
        filename: image?.name || `image.${parsed.ext}`,
      }, 30000);
    }
    const fileList = Array.isArray(files) ? files : [];
    const refs = [];
    for (const file of fileList) {
      const dataUrl = String(file?.dataUrl || '');
      if (!dataUrl.startsWith('data:')) throw new Error('File could not be read');
      const attached = await this.rpc('file.attach', {
        session_id: this.liveSessionId,
        data_url: dataUrl,
        name: file?.name || 'file',
      }, 60000);
      const ref = String(attached?.ref_text || '').trim();
      refs.push(ref || `@file:${file?.name || 'file'}`);
    }
    const typed = String(text || '').trim();
    const body = [typed, ...refs].filter(Boolean).join('\n');
    return this.rpc('prompt.submit', {
      session_id: this.liveSessionId,
      text: body,
    }, RPC_TIMEOUT_MS);
  }

  abort() {
    if (!this.liveSessionId) return Promise.resolve(null);
    return this.rpc('session.interrupt', { session_id: this.liveSessionId }, 15000);
  }

  respond(id, result) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('Not connected');
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = String(this.nextId);
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: params || {},
        }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  ingest(frame) {
    if (!frame || typeof frame !== 'object') return;
    const id = frame.id != null ? String(frame.id) : '';
    if (id && frame.method && frame.method !== 'event') {
      this.emit('request', { id, method: frame.method, params: frame.params || {} });
      return;
    }
    if (id && (Object.prototype.hasOwnProperty.call(frame, 'result') || frame.error)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message || 'Request failed'));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method !== 'event') return;
    const type = String(frame.params?.type || '');
    const payload = frame.params?.payload && typeof frame.params.payload === 'object'
      ? frame.params.payload
      : {};
    if (type === 'message.start') {
      this.streamBuffer = '';
      this.thoughtTail = '';
      this.emitActivity('Writing…');
      return;
    }
    if (type === 'message.delta') {
      const text = String(payload.text || '');
      if (!text) return;
      if (this.streamBuffer && text.startsWith(this.streamBuffer)) this.streamBuffer = text;
      else this.streamBuffer += text;
      this.emit('stream', { text: this.streamBuffer });
      return;
    }
    if (type === 'message.complete') {
      const text = String(payload.text || this.streamBuffer || '');
      this.streamBuffer = '';
      this.thoughtTail = '';
      this.emit('complete', { text });
      return;
    }
    if (type === 'error') {
      this.streamBuffer = '';
      this.thoughtTail = '';
      this.emit('turn-error', { message: String(payload.message || payload.text || 'Hermes error') });
      return;
    }
    if (type === 'thinking.delta' || type === 'reasoning.delta' || type === 'reasoning.available') {
      const chunk = String(payload.text || '');
      if (chunk) {
        if (this.thoughtTail && chunk.startsWith(this.thoughtTail)) this.thoughtTail = chunk;
        else this.thoughtTail += chunk;
        this.thoughtTail = this.thoughtTail.slice(-180);
      }
      this.emitActivity(activityText(type, payload, this.thoughtTail));
      return;
    }
    this.emitActivity(activityText(type, payload, this.thoughtTail));
  }

  emitActivity(text) {
    const line = String(text || '').trim();
    if (!line) return;
    this.emit('activity', { text: line });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.rpc('gateway.ping', {}, 10000).catch(() => {});
    }, 15000);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  rejectPending(err) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.intentionalClose = true;
    this.generation += 1;
    this.stopPing();
    this.rejectPending(new Error('Disconnected'));
    const rejectSocket = this.socketReject;
    this.socketReject = null;
    const ws = this.ws;
    this.ws = null;
    this.liveSessionId = '';
    if (ws && ws.readyState !== 3) {
      try { ws.close(); } catch { /* already closing */ }
    }
    if (rejectSocket) rejectSocket(new Error('Disconnected'));
  }
}

module.exports = {
  HermesClient,
  normalizeDashboardUrl,
  historyToUiMessages,
  parseDataUrl,
  dashboardToWsUrl,
};
