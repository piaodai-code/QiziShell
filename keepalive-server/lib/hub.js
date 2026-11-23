'use strict';

const chrome = require('./chrome');
const { PlatformRuntime } = require('./platform');
const { InputError, PRESETS } = require('./store');
const { version } = require('../package.json');

const TICK_MS = 5000;

/** Owns every platform runtime, the shared timer, and the state pushed to clients. */
class Hub {
  constructor({ store, notifier, log }) {
    this.store = store;
    this.notifier = notifier;
    this.log = log;
    this.listeners = new Set();
    this.changeTimer = null;
    this.ticking = false;
    this.runtimes = new Map();
    for (const config of store.platforms) this.runtimes.set(config.platform_id, this.createRuntime(config));
  }

  createRuntime(config) {
    return new PlatformRuntime(config, {
      store: this.store,
      notifier: this.notifier,
      log: this.log,
      changed: () => this.changed(),
    });
  }

  start() {
    this.timer = setInterval(() => this.tickAll(), TICK_MS);
    this.tickAll();
  }

  /** Bring the keep-alive window forward. If 退出 closed it, open it again. */
  async showWindow() {
    if (await chrome.showShell(this.store.dataDir)) return { visible: true };
    const pending = [];
    for (const runtime of this.runtimes.values()) {
      if (!runtime.config.enabled || !runtime.chromeOn || runtime.config.browser !== 'shell') continue;
      pending.push(runtime.enqueue(() => runtime.startChrome('manual')));
    }
    if (!pending.length) return { visible: false };
    await Promise.all(pending);
    await chrome.showShell(this.store.dataDir);
    return { visible: true };
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.changeTimer);
  }

  async tickAll() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await Promise.all([...this.runtimes.values()].map((runtime) => runtime.tick(now)
        .catch((err) => this.log(`[${runtime.id}] tick failed: ${err.stack || err}`))));
    } finally {
      this.ticking = false;
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Several fields usually change together; one push covers them. */
  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    }, 100);
  }

  snapshot() {
    return {
      server: {
        version,
        now: Date.now(),
        port: this.store.listen.port,
        cdp_port: chrome.shellDebugPort() || this.store.cdpPort,
        data_dir: this.store.dataDir,
        scripts_dir: this.store.scriptsDir,
      },
      notify: {
        ...this.store.publicNotify(),
        ...(typeof this.notifier?.status === 'function' ? this.notifier.status() : {}),
      },
      presets: PRESETS,
      platforms: [...this.runtimes.values()].map((runtime) => runtime.snapshot()),
    };
  }

  get(platformId) {
    const runtime = this.runtimes.get(platformId);
    if (!runtime) throw new InputError(`没有平台 ${platformId}`, 404);
    return runtime;
  }

  setCdpPort(port) {
    const live = chrome.shellDebugPort();
    const browserUp = [...this.runtimes.values()].some((runtime) => runtime.chromeOn || runtime.browserAlive);
    if (browserUp && Number(port) !== (live || this.store.cdpPort)) {
      throw new InputError('先关闭保活窗口，再改 CDP 端口', 409);
    }
    const next = this.store.setCdpPort(port);
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.browser === 'shell') runtime.config.cdp_port = next;
    }
    this.store.saveConfig();
    this.changed();
    return { cdp_port: chrome.shellDebugPort() || next };
  }

  addPlatform(raw) {
    const config = this.store.addPlatform(raw);
    const runtime = this.createRuntime(config);
    this.runtimes.set(config.platform_id, runtime);
    runtime.note('平台已添加');
    return runtime;
  }

  async updatePlatform(platformId, raw) {
    const runtime = this.get(platformId);
    const draft = this.store.draftPlatform(platformId, raw);
    // Checked against the running Chrome before anything is written.
    runtime.assertCanApply(draft);
    this.store.commitPlatform(draft);
    await runtime.applyConfig(draft);
    runtime.note('平台配置已保存');
    return runtime;
  }

  async removePlatform(platformId) {
    const runtime = this.get(platformId);
    if (runtime.chromeOn || runtime.browserAlive) await runtime.setChrome(false);
    this.runtimes.delete(platformId);
    this.store.removePlatform(platformId);
    this.changed();
  }
}

module.exports = { Hub };
