const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { HermesClient } = require('./hermes-client');

const MAX_TRANSCRIPT = 200;

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

class MaintainingSession extends EventEmitter {
  constructor(dir) {
    super();
    this.loginPath = path.join(dir, 'hermes-login.json');
    this.transcriptPath = path.join(dir, 'hermes-transcript.json');
    this.client = new HermesClient();
    this.credentials = this.loadCredentials();
    this.messages = this.loadTranscript();
    this.connecting = false;
    this.connectPromise = null;
    this.connectSerial = 0;
    this.error = '';
    this.replaced = false;
    this.reconnects = 0;
    this.client.on('history', (messages) => {
      this.messages = Array.isArray(messages) ? messages : [];
      this.saveTranscript();
      this.emit('history', this.messages);
    });
    this.client.on('stream', (payload) => this.emit('stream', payload));
    this.client.on('complete', (payload) => {
      this.finishAssistant(payload?.text || '');
      this.emit('complete', payload);
    });
    this.client.on('turn-error', (payload) => this.emit('turn-error', payload));
    this.client.on('request', (payload) => this.emit('request', payload));
    this.client.on('activity', (payload) => this.emit('activity', payload));
    this.client.on('close', (info) => {
      this.onClose(info);
    });
  }

  loadCredentials() {
    const saved = readJson(this.loginPath);
    if (!saved || typeof saved !== 'object') return null;
    const url = typeof saved.url === 'string' ? saved.url : '';
    const username = typeof saved.username === 'string' ? saved.username : '';
    const password = typeof saved.password === 'string' ? saved.password : '';
    if (!url) return null;
    return { url, username, password };
  }

  loadTranscript() {
    const saved = readJson(this.transcriptPath);
    const url = this.credentials?.url || '';
    if (!saved || saved.url !== url || !Array.isArray(saved.messages)) return [];
    return saved.messages.slice(-MAX_TRANSCRIPT);
  }

  saveCredentials(credentials) {
    this.credentials = {
      url: String(credentials.url || '').trim(),
      username: String(credentials.username || ''),
      password: String(credentials.password || ''),
    };
    writeJson(this.loginPath, this.credentials);
  }

  saveTranscript() {
    const url = this.credentials?.url || this.client.baseUrl || '';
    if (!url) return;
    writeJson(this.transcriptPath, {
      url,
      messages: this.messages.slice(-MAX_TRANSCRIPT),
    });
  }

  snapshot() {
    return {
      connected: this.client.connected,
      connecting: this.connecting,
      needLogin: !this.credentials?.url || Boolean(this.error),
      error: this.error,
      credentials: this.credentials ? {
        url: this.credentials.url,
        username: this.credentials.username,
        password: this.credentials.password,
      } : { url: '', username: '', password: '' },
      messages: this.messages,
    };
  }

  async ensureConnected() {
    if (this.client.connected) return this.snapshot();
    if (!this.credentials?.url) {
      this.error = '';
      return this.snapshot();
    }
    if (this.connectPromise) return this.connectPromise;
    const serial = this.connectSerial;
    this.connecting = true;
    this.error = '';
    this.emit('status', { kind: 'pending', text: 'Connecting…', needLogin: false });
    this.connectPromise = this.client.connect(this.credentials)
      .then(() => {
        if (serial !== this.connectSerial) return this.snapshot();
        this.reconnects = 0;
        this.error = '';
        this.emit('status', { kind: 'ok', text: 'Connected', needLogin: false });
        return this.snapshot();
      })
      .catch((err) => {
        if (serial !== this.connectSerial) return this.snapshot();
        this.error = err.message || 'Could not connect';
        this.emit('status', { kind: 'error', text: this.error, needLogin: true });
        return this.snapshot();
      })
      .finally(() => {
        if (serial === this.connectSerial) {
          this.connecting = false;
          this.connectPromise = null;
        }
      });
    return this.connectPromise;
  }

  async login(credentials) {
    const previousUrl = this.credentials?.url || '';
    this.connectSerial += 1;
    this.connectPromise = null;
    this.connecting = false;
    this.client.close();
    this.saveCredentials(credentials);
    if (this.credentials.url !== previousUrl) this.messages = [];
    this.error = '';
    return this.ensureConnected();
  }

  async send({ text, images, files }) {
    const body = String(text || '');
    const list = Array.isArray(images) ? images : [];
    const fileList = Array.isArray(files) ? files : [];
    if (!body.trim() && list.length === 0 && fileList.length === 0) throw new Error('Message is empty');
    if (!this.client.connected) throw new Error('Not connected');
    const entry = {
      who: 'me',
      text: body,
      images: list.map((image) => image.dataUrl).filter(Boolean),
      files: fileList.map((file) => ({
        name: file?.name || 'file',
        size: Number(file?.size) || 0,
      })),
      time: nowLabel(),
    };
    this.messages.push(entry);
    this.saveTranscript();
    try {
      await this.client.submit({ text: body, images: list, files: fileList });
    } catch (err) {
      this.messages = this.messages.filter((message) => message !== entry);
      this.saveTranscript();
      throw err;
    }
  }

  finishAssistant(text) {
    const value = String(text || '').trim();
    if (!value) return;
    const last = this.messages[this.messages.length - 1];
    if (last?.who === 'them' && last.streaming) {
      last.text = value;
      last.streaming = false;
      last.time = last.time || nowLabel();
    } else {
      this.messages.push({ who: 'them', text: value, images: [], time: nowLabel() });
    }
    this.saveTranscript();
  }

  abort() {
    return this.client.abort();
  }

  respond(id, result) {
    this.client.respond(id, result);
  }

  onClose(info) {
    if (this.replaced) return;
    const code = Number(info?.code) || 0;
    if (code === 4401) {
      this.error = 'Sign-in expired';
      this.emit('status', { kind: 'error', text: this.error, needLogin: true });
      return;
    }
    if (this.reconnects < 1 && this.credentials?.url) {
      this.reconnects += 1;
      this.ensureConnected().catch(() => {});
      return;
    }
    this.error = 'Disconnected';
    this.emit('status', { kind: 'error', text: this.error, needLogin: true });
  }

  close() {
    this.replaced = true;
    this.client.close();
  }
}

module.exports = { MaintainingSession };
