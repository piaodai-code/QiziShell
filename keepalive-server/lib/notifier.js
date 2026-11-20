'use strict';

const fs = require('fs');
const path = require('path');

// A re-login can take the Maintainer a while. The socket stays open until the
// turn ends so the turn is not cut short by our disconnect.
const HOLD_SOCKET_MS = 30 * 60 * 1000;

/** The packed server carries its own copy in vendor/; a repo checkout uses the shell's file. */
function loadHermesClient() {
  const candidates = [
    path.join(__dirname, '..', 'vendor', 'hermes-client.js'),
    path.join(__dirname, '..', '..', 'hermes-client.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate).HermesClient;
  }
  throw new Error('缺少 hermes-client.js，无法给 Maintainer 发消息');
}

class NotConfiguredError extends Error {
  constructor() {
    super('还没填 Hermes 地址，掉线通知发不出去');
    this.code = 'not_configured';
  }
}

/** Posts messages into the Maintainer's main Hermes session, one at a time. */
class Notifier {
  constructor(getConfig, log) {
    this.getConfig = getConfig;
    this.log = log;
    this.chain = Promise.resolve();
    this.reachable = null;
    this.lastError = '';
    this.lastTriedAt = 0;
  }

  status() {
    return {
      reachable: this.reachable,
      last_error: this.lastError,
      last_tried_at: this.lastTriedAt,
    };
  }

  configured() {
    return Boolean(this.getConfig().hermes_url);
  }

  send(text) {
    if (!this.configured()) return Promise.reject(new NotConfiguredError());
    const task = this.chain.then(() => this.deliver(text));
    this.chain = task.catch(() => {});
    return task;
  }

  async deliver(text) {
    const config = this.getConfig();
    const HermesClient = loadHermesClient();
    const client = new HermesClient();
    this.lastTriedAt = Date.now();
    try {
      await client.connect({ url: config.hermes_url, username: config.username, password: config.password });
      await client.submit({ text });
      this.reachable = true;
      this.lastError = '';
    } catch (err) {
      client.close();
      this.reachable = false;
      this.lastError = String(err.message || err).split('\n')[0];
      this.log(`notify failed url=${config.hermes_url} error=${this.lastError}`);
      throw err;
    }
    let released = false;
    const release = (why) => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      client.close();
      this.log(`maintainer turn ${why}`);
    };
    const timer = setTimeout(() => release('still running after 30 min, socket released'), HOLD_SOCKET_MS);
    if (typeof timer.unref === 'function') timer.unref();
    client.once('complete', () => release('finished'));
    client.once('turn-error', (payload) => release(`failed: ${payload?.message || 'unknown error'}`));
    client.once('close', () => release('socket closed'));
    client.on('request', (payload) => {
      this.log(`maintainer turn is waiting on an approval (${payload?.method || 'request'}) that this server cannot answer`);
    });
  }
}

module.exports = { Notifier, NotConfiguredError };
