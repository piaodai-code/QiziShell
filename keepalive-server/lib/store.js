'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 18990;
const DEFAULT_LOCK_TTL_MINUTES = 10;

/** Form defaults per platform type. Keep-alive steps and logout features are not here: the agent supplies them. */
const PRESETS = {
  wechat_channels: {
    platform_type: 'wechat_channels',
    platform_id: 'channels_01',
    name: '微信视频号',
    entry_url: 'https://channels.weixin.qq.com/platform',
    cdp_port: 9333,
    browser: 'shell',
    keep_alive: { interval_minutes: 15, jitter_minutes: 3 },
  },
};

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

/** Hermes on this machine. A public MagicDNS name does not resolve here, and 8443 is not the dashboard. */
const LOCAL_HERMES_URL = 'http://127.0.0.1:9119';

function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function intInRange(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new InputError(`${label}要填 ${min}–${max} 之间的整数`);
  }
  return number;
}

function numberInRange(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new InputError(`${label}要填 ${min}–${max} 之间的数字`);
  }
  return number;
}

function normalizePlatform(raw, { dataDir, others, listenPort, previous }) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const platformId = previous ? previous.platform_id : String(input.platform_id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(platformId)) {
    throw new InputError('平台 ID 只能用字母、数字、下划线和短横线，最长 40 个字符');
  }
  if (!previous && others.some((item) => item.platform_id === platformId)) {
    throw new InputError(`平台 ID ${platformId} 已经存在`, 409);
  }
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : (previous ? previous[key] : fallback));

  const entryUrl = String(pick('entry_url', '') || '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(entryUrl);
  } catch {
    throw new InputError('入口网址不是有效的网址');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InputError('入口网址要以 http:// 或 https:// 开头');
  }

  const cdpPort = intInRange(pick('cdp_port', 9333), 1024, 65535, 'CDP 端口');
  if (cdpPort === listenPort) throw new InputError(`CDP 端口不能和保活服务的端口 ${listenPort} 相同`);
  const clash = others.find((item) => item.platform_id !== platformId && item.cdp_port === cdpPort);
  if (clash) throw new InputError(`CDP 端口 ${cdpPort} 已经分给 ${clash.name || clash.platform_id}`, 409);

  const platformType = String(pick('platform_type', 'custom') || 'custom').trim().slice(0, 40) || 'custom';
  const browserRaw = input.browser !== undefined ? input.browser : previous?.browser;
  const browser = String(browserRaw === undefined || browserRaw === null || browserRaw === ''
    ? 'shell'
    : browserRaw).trim();
  if (browser !== 'chrome' && browser !== 'shell') throw new InputError('浏览器只能是 chrome 或 shell');

  const profileDir = path.resolve(expandHome(pick('profile_dir', '')) || path.join(dataDir, 'profiles', platformId));
  const profileClash = others.find((item) => item.platform_id !== platformId && item.profile_dir === profileDir);
  if (profileClash) throw new InputError(`沙盒目录已经分给 ${profileClash.name || profileClash.platform_id}`, 409);

  const keepInput = { ...(previous?.keep_alive || {}), ...(input.keep_alive && typeof input.keep_alive === 'object' ? input.keep_alive : {}) };
  const interval = numberInRange(keepInput.interval_minutes ?? 15, 1, 24 * 60, '保活间隔（分钟）');
  const jitter = numberInRange(keepInput.jitter_minutes ?? 3, 0, 12 * 60, '时间漂移（分钟）');
  if (jitter >= interval) throw new InputError('时间漂移要小于保活间隔');

  const argsInput = pick('chrome_args', []);
  const chromeArgs = (Array.isArray(argsInput) ? argsInput : String(argsInput || '').split(/\s+/))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  for (const arg of chromeArgs) {
    if (!arg.startsWith('--')) throw new InputError(`附加启动参数要以 -- 开头：${arg}`);
    if (/^--(user-data-dir|remote-debugging-port)\b/.test(arg)) {
      throw new InputError('沙盒目录和 CDP 端口请在各自的输入框里填');
    }
  }

  return {
    platform_id: platformId,
    platform_type: platformType,
    browser,
    name: String(pick('name', platformId) || platformId).trim().slice(0, 60) || platformId,
    entry_url: parsedUrl.toString(),
    cdp_port: cdpPort,
    profile_dir: profileDir,
    keep_alive: { interval_minutes: interval, jitter_minutes: jitter },
    lock_ttl_minutes: numberInRange(pick('lock_ttl_minutes', DEFAULT_LOCK_TTL_MINUTES), 1, 24 * 60, '占用锁过期时间（分钟）'),
    auto_restart: pick('auto_restart', true) !== false,
    chrome_args: chromeArgs,
    enabled: pick('enabled', true) !== false,
  };
}

class Store {
  constructor(dataDir, overrides = {}) {
    this.dataDir = path.resolve(expandHome(dataDir));
    this.configPath = path.join(this.dataDir, 'config.json');
    this.statePath = path.join(this.dataDir, 'state.json');
    this.scriptsDir = path.join(this.dataDir, 'scripts');
    fs.mkdirSync(this.scriptsDir, { recursive: true });

    const saved = readJson(this.configPath, {});
    this.listen = {
      host: overrides.host || saved.listen?.host || '0.0.0.0',
      port: Number(overrides.port) || Number(saved.listen?.port) || DEFAULT_PORT,
    };
    this.chromePath = String(saved.chrome_path || '').trim();
    this.configNotes = [];
    const savedPassword = String(saved.notify?.password || '');
    const password = savedPassword.trim();
    let hermesUrl = String(saved.notify?.hermes_url || '').trim();
    if (hermesUrl && !isLoopbackHttpUrl(hermesUrl)) {
      this.configNotes.push(`notify hermes_url was not a local address; now ${LOCAL_HERMES_URL}`);
      hermesUrl = LOCAL_HERMES_URL;
    }
    if (password !== savedPassword) {
      this.configNotes.push('notify password had surrounding whitespace; stored the trimmed value');
    }
    this.notify = {
      hermes_url: hermesUrl,
      username: String(saved.notify?.username || '').trim(),
      password,
    };
    this.platforms = [];
    for (const raw of Array.isArray(saved.platforms) ? saved.platforms : []) {
      try {
        this.platforms.push(normalizePlatform(raw, {
          dataDir: this.dataDir,
          others: this.platforms,
          listenPort: this.listen.port,
        }));
      } catch (err) {
        console.error(`config.json: skipped platform ${raw?.platform_id || '(no id)'}: ${err.message}`);
      }
    }
    this.state = readJson(this.statePath, {});
    if (!this.state.platforms || typeof this.state.platforms !== 'object') this.state.platforms = {};
    if (this.configNotes.length) this.saveConfig();
  }

  saveConfig() {
    const saved = readJson(this.configPath, {});
    writeJsonAtomic(this.configPath, {
      listen: saved.listen || { host: this.listen.host, port: this.listen.port },
      ...(this.chromePath ? { chrome_path: this.chromePath } : {}),
      notify: this.notify,
      platforms: this.platforms,
    });
  }

  platformState(platformId) {
    const saved = this.state.platforms[platformId] || {};
    return {
      chrome_on: saved.chrome_on === true,
      paused: saved.paused === true,
      lock: saved.lock && typeof saved.lock === 'object' ? saved.lock : null,
    };
  }

  savePlatformState(platformId, value) {
    this.state.platforms[platformId] = value;
    writeJsonAtomic(this.statePath, this.state);
  }

  dropPlatformState(platformId) {
    delete this.state.platforms[platformId];
    writeJsonAtomic(this.statePath, this.state);
  }

  scriptPath(platformId) {
    return path.join(this.scriptsDir, `${platformId}.json`);
  }

  addPlatform(raw) {
    const platform = normalizePlatform(raw, {
      dataDir: this.dataDir,
      others: this.platforms,
      listenPort: this.listen.port,
    });
    this.platforms.push(platform);
    this.saveConfig();
    return platform;
  }

  /** The platform as it would be after applying `raw`. Nothing is saved. */
  draftPlatform(platformId, raw) {
    const previous = this.platforms.find((item) => item.platform_id === platformId);
    if (!previous) throw new InputError('没有这个平台', 404);
    return normalizePlatform(raw, {
      dataDir: this.dataDir,
      others: this.platforms,
      listenPort: this.listen.port,
      previous,
    });
  }

  commitPlatform(platform) {
    const index = this.platforms.findIndex((item) => item.platform_id === platform.platform_id);
    if (index < 0) throw new InputError('没有这个平台', 404);
    this.platforms[index] = platform;
    this.saveConfig();
  }

  removePlatform(platformId) {
    const index = this.platforms.findIndex((item) => item.platform_id === platformId);
    if (index < 0) throw new InputError('没有这个平台', 404);
    this.platforms.splice(index, 1);
    this.saveConfig();
    this.dropPlatformState(platformId);
  }

  updateNotify(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    let url = input.hermes_url !== undefined ? String(input.hermes_url || '').trim() : this.notify.hermes_url;
    if (url) {
      let parsed;
      try {
        parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
      } catch {
        throw new InputError('Hermes 地址不是有效的网址');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new InputError('Hermes 地址要以 http:// 或 https:// 开头');
      }
      url = parsed.href.replace(/\/$/, '');
    }
    if (url && !isLoopbackHttpUrl(url)) {
      throw new InputError(`Hermes 和保活服务在同一台机器上，地址要填 ${LOCAL_HERMES_URL}`);
    }
    // An absent or blank password keeps the saved one. A password is trimmed so a
    // trailing space from a form cannot replace the real one.
    const password = typeof input.password === 'string' && input.password.trim()
      ? input.password.trim()
      : this.notify.password;
    this.notify = {
      hermes_url: url,
      username: input.username !== undefined ? String(input.username || '').trim() : this.notify.username,
      password,
    };
    this.saveConfig();
  }

  publicNotify() {
    return {
      hermes_url: this.notify.hermes_url,
      username: this.notify.username,
      password_set: Boolean(this.notify.password),
    };
  }
}

module.exports = {
  Store,
  InputError,
  PRESETS,
  DEFAULT_PORT,
  DEFAULT_LOCK_TTL_MINUTES,
  LOCAL_HERMES_URL,
  expandHome,
  isLoopbackHttpUrl,
};
