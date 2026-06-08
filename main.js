const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn } = require('child_process');

const openLinksExternally = !process.argv.includes('--open-links-in-shell');

function isExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function openExternal(url) {
  if (isExternalUrl(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
}

if (!app || typeof app.whenReady !== 'function') {
  console.error(
    '无法加载 Electron 主进程 API。\n' +
    '请在终端运行: cd ~/Desktop/qizi-shell && npm start\n' +
    '(若在 Cursor 内置终端失败，请用系统「终端.app」启动)'
  );
  process.exit(1);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { GatewayWsClient } = require('./gateway-ws');
const { extractMessageSentTimeFromRaw } = require('./message-time');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let gateway = null;
let gatewayConfigKey = null;
/** @type {Map<number, { gatewayRunId: string, sender: Electron.WebContents, fullText: string, done?: (v: unknown) => void, timeout?: NodeJS.Timeout }>} */
const activeRuns = new Map();
/** @type {Map<string, number>} gatewayRunId -> clientRunId */
const gatewayRunIndex = new Map();
const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
let openClawConfigCache = null;
let sessionKey = null;
const DEFAULT_SESSION_KEY = 'agent:main:main';
const SHELL_SESSION_MAIN_KEY = 'main';
/** 定时任务/后台会话后缀；Shell 不应自动跟到这些 session */
const SYSTEM_SESSION_SUFFIXES = new Set([
  'dreaming',
  'cron',
  'memory',
  'review',
  'recap',
]);
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

// 单实例锁：避免用户多次点击 .app 启动多个进程
if (process.env.QIZI_DEVTOOLS_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.QIZI_DEVTOOLS_PORT);
}
// 抑制 Chromium 后台连 Google 等服务的 SSL 握手重试日志（不影响 Gateway 业务连接）
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // 第二个实例被拒后，主实例被唤醒 → 显示主界面
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function getSessionKeyPath() {
  return path.join(app.getPath('userData'), 'session-key');
}

function persistSessionKey(key) {
  sessionKey = key;
  try {
    const keyPath = getSessionKeyPath();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, 'utf8');
  } catch {
    // non-fatal
  }
}

function getSessionKey() {
  if (sessionKey) return sanitizeSessionKeyForShell(sessionKey);
  const keyPath = getSessionKeyPath();
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing) {
      const sanitized = sanitizeSessionKeyForShell(existing);
      sessionKey = sanitized;
      if (sanitized !== existing) persistSessionKey(sanitized);
      return sessionKey;
    }
  } catch {
    // use default
  }
  persistSessionKey(DEFAULT_SESSION_KEY);
  return sessionKey;
}

function normalizeAgentEntry(agent, meta = {}) {
  const defaultId = meta.defaultId || 'main';
  const id = agent?.id || defaultId;
  const configuredName = typeof agent?.name === 'string' ? agent.name.trim() : '';
  let label = configuredName || id;
  if (id === defaultId && !configuredName) {
    label = '启孜';
  }
  return {
    id,
    label,
    workspace: agent?.workspace || null,
    defaultModel: agent?.model?.primary || null,
    isDefault: id === defaultId,
  };
}

function applyCurrentModelToEntry(entry, current, defaults = {}) {
  if (current?.model) {
    entry.currentModel = current.model;
    entry.currentModelProvider = current.modelProvider ?? null;
    entry.currentModelQualified = current.qualified ?? (
      entry.currentModelProvider && entry.currentModel
        ? `${entry.currentModelProvider}/${entry.currentModel}`
        : entry.currentModel
    );
    return entry;
  }
  const fallbackProvider = defaults.modelProvider ?? null;
  const fallbackModel = defaults.model ?? entry.defaultModel ?? null;
  if (typeof fallbackModel === 'string' && fallbackModel.includes('/') && !fallbackProvider) {
    entry.currentModelQualified = fallbackModel;
    entry.currentModel = fallbackModel.split('/').pop();
    entry.currentModelProvider = fallbackModel.split('/')[0];
    return entry;
  }
  entry.currentModel = fallbackModel;
  entry.currentModelProvider = fallbackProvider;
  entry.currentModelQualified = fallbackProvider && fallbackModel
    ? `${fallbackProvider}/${fallbackModel}`
    : fallbackModel;
  return entry;
}

async function fetchAgentMainSessionModels(client, mainKey = 'main') {
  const map = new Map();
  try {
    const result = await client.request('sessions.list', { limit: 200 });
    const suffix = `:${mainKey}`;
    for (const session of result?.sessions || []) {
      if (!session?.key || !session.key.endsWith(suffix)) continue;
      const match = /^agent:([^:]+):/.exec(session.key);
      if (!match) continue;
      const modelProvider = session.modelProvider ?? null;
      const model = session.model ?? null;
      map.set(match[1], {
        modelProvider,
        model,
        qualified: modelProvider && model ? `${modelProvider}/${model}` : model,
      });
    }
  } catch {
    // ignore session lookup failures
  }
  return map;
}

async function fetchSessionCurrentModel(client, sessionKey, defaults = {}) {
  try {
    const result = await client.request('chat.history', { sessionKey, limit: 1 });
    const sessionInfo = result?.sessionInfo || {};
    const modelProvider = sessionInfo.modelProvider ?? defaults.modelProvider ?? null;
    const model = sessionInfo.model ?? defaults.model ?? null;
    if (!model) return null;
    return {
      modelProvider,
      model,
      qualified: modelProvider && model ? `${modelProvider}/${model}` : model,
    };
  } catch {
    return null;
  }
}

function buildAgentSessionKey(agentId, mainKey = SHELL_SESSION_MAIN_KEY) {
  return `agent:${agentId}:${mainKey}`;
}

function parseAgentIdFromSessionKey(sessionKey) {
  const match = /^agent:([^:]+):/.exec(sessionKey || '');
  return match ? match[1] : 'main';
}

function extractSessionSuffix(sessionKey, agentId) {
  const prefix = `agent:${agentId}:`;
  if (!sessionKey || !sessionKey.startsWith(prefix)) return null;
  return sessionKey.slice(prefix.length);
}

function pinnedSessionKeyForAgent(agentId, mainKey = SHELL_SESSION_MAIN_KEY) {
  return buildAgentSessionKey(agentId, mainKey);
}

function sanitizeSessionKeyForShell(sessionKey, mainKey = SHELL_SESSION_MAIN_KEY) {
  const trimmed = String(sessionKey || '').trim();
  if (!trimmed) return DEFAULT_SESSION_KEY;
  const agentId = parseAgentIdFromSessionKey(trimmed);
  const suffix = extractSessionSuffix(trimmed, agentId);
  const pinned = pinnedSessionKeyForAgent(agentId, mainKey);
  if (!suffix || suffix !== mainKey || SYSTEM_SESSION_SUFFIXES.has(suffix)) {
    return pinned;
  }
  return trimmed;
}

/** @type {Map<string, string>} */
const agentAvatarCache = new Map();

function gatewayHttpBase(wsUrl) {
  return String(wsUrl || '')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/$/, '');
}

function fetchGatewayResource(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function fetchAgentAvatarDataUrl(agentId, avatarPath, avatarStatus) {
  if (!avatarPath || avatarStatus === 'none') return null;
  const cached = agentAvatarCache.get(agentId);
  if (cached) return cached;

  const { wsUrl, token } = loadOpenClawConfig();
  if (!wsUrl || !token) return null;

  const url = `${gatewayHttpBase(wsUrl)}${avatarPath.startsWith('/') ? avatarPath : `/${avatarPath}`}`;
  try {
    const resp = await fetchGatewayResource(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const dataUrl = `data:image/png;base64,${resp.body.toString('base64')}`;
    agentAvatarCache.set(agentId, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

async function enrichAgentEntry(client, agent, meta = {}) {
  const entry = normalizeAgentEntry(agent, meta);
  try {
    const identity = await client.request('agent.identity.get', { agentId: entry.id });
    if (typeof identity?.name === 'string' && identity.name.trim()) {
      entry.label = identity.name.trim();
    }
    entry.emoji = identity?.emoji || null;
    entry.avatarStatus = identity?.avatarStatus || 'none';
    entry.avatarDataUrl = await fetchAgentAvatarDataUrl(
      entry.id,
      identity?.avatar,
      identity?.avatarStatus,
    );
  } catch {
    // keep base entry without avatar
  }
  applyCurrentModelToEntry(entry, meta.sessionModels?.get(entry.id), meta.defaults);
  return entry;
}

function loadShellSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      wsUrl: typeof parsed.wsUrl === 'string' ? parsed.wsUrl.trim() : undefined,
      token: typeof parsed.token === 'string' ? parsed.token.trim() : undefined,
      launchAtLogin: parsed.launchAtLogin === true,
      showMainOnLaunch: parsed.showMainOnLaunch !== false,
    };
  } catch {
    return {};
  }
}

function saveShellSettings(next) {
  const current = loadShellSettings();
  const merged = {
    wsUrl: typeof next.wsUrl === 'string' ? next.wsUrl.trim().replace(/\/$/, '') : current.wsUrl,
    token: typeof next.token === 'string' && next.token.trim()
      ? next.token.trim()
      : current.token,
    launchAtLogin: next.launchAtLogin === true,
    showMainOnLaunch: next.showMainOnLaunch !== false,
  };
  if (!merged.wsUrl) delete merged.wsUrl;
  if (!merged.token) delete merged.token;
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: merged.launchAtLogin === true,
      openAsHidden: merged.showMainOnLaunch === false,
    });
  }
  openClawConfigCache = null;
  return merged;
}

function resolveGatewayConfigSource() {
  if (process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_TOKEN) {
    return 'environment';
  }
  const shell = loadShellSettings();
  if (shell.wsUrl || shell.token) return 'shell';
  return 'unset';
}

function loadOpenClawConfig() {
  const shell = loadShellSettings();
  const cacheKey = `${shell.wsUrl || ''}\0${shell.token || ''}`;
  if (openClawConfigCache && openClawConfigCache.__cacheKey === cacheKey) {
    return openClawConfigCache;
  }
  const wsUrl = (process.env.OPENCLAW_GATEWAY_URL || shell.wsUrl || '').trim().replace(/\/$/, '');
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || shell.token;
  openClawConfigCache = { token, wsUrl, source: resolveGatewayConfigSource(), __cacheKey: cacheKey };
  return openClawConfigCache;
}

function getSettingsSnapshot() {
  const shell = loadShellSettings();
  const effective = loadOpenClawConfig();
  return {
    wsUrl: shell.wsUrl || '',
    tokenSet: Boolean(effective.token),
    source: effective.source,
    shellSettingsPath: SETTINGS_PATH,
    launchAtLogin: shell.launchAtLogin === true,
    showMainOnLaunch: shell.showMainOnLaunch !== false,
    envOverrides: Boolean(process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_TOKEN),
  };
}

async function testGatewaySettings({ wsUrl, token }) {
  const url = (wsUrl || '').trim().replace(/\/$/, '');
  if (!url) {
    return { ok: false, error: 'Gateway地址错误' };
  }
  const authToken = token || loadOpenClawConfig().token;
  if (!authToken) {
    return { ok: false, error: 'Gateway可访问，但Token错误' };
  }
  const client = new GatewayWsClient({
    url,
    token: authToken,
    clientVersion: '0.1.0',
  });
  try {
    client.start();
    await client.waitForConnect();
    client.stop();
    return { ok: true, wsUrl: url };
  } catch (err) {
    client.stop();
    return { ok: false, error: formatTestConnectionError(err) };
  }
}

function restartGatewayAfterSettings() {
  stopGateway();
  try {
    ensureGateway();
  } catch (err) {
    console.warn('[qizi] reconnect after settings failed:', err.message);
  }
}

function openSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) {
    mainWindow.show();
    if (process.platform === 'darwin' && app.dock) app.dock.show();
  }
  mainWindow.focus();
  safeSendTo(mainWindow.webContents, 'openclaw:open-settings');
}

function formatTestConnectionError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  const detailCode = err?.details?.code || err?.details?.detailCode || err?.gatewayCode;

  if (detailCode === 'PAIRING_REQUIRED' || message.includes('pairing')) {
    return 'Gateway可访问，需管理员批准';
  }

  const tokenCodes = new Set([
    'AUTH_FAILED',
    'INVALID_TOKEN',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'AUTH_TOKEN_MISMATCH',
    'AUTH_DEVICE_TOKEN_MISMATCH',
  ]);
  const tokenHints = [
    'unauthorized',
    'invalid token',
    'forbidden',
    'auth',
    'authentication',
    'credential',
    'token',
    '401',
    '403',
  ];
  if (
    (detailCode && tokenCodes.has(detailCode))
    || tokenHints.some((hint) => message.includes(hint))
  ) {
    return 'Gateway可访问，但Token错误';
  }

  const addressHints = [
    'enotfound',
    'econnrefused',
    'etimedout',
    'enetunreach',
    'ehostunreach',
    'getaddrinfo',
    'eai_again',
    'network',
    'dns',
    'connect timeout',
    'connect challenge timeout',
    'gateway connect timeout',
    'gateway closed',
    'socket hang up',
    'eproto',
    'wrong version number',
    'handshake',
    'certificate',
    'cert',
    'ssl',
    'tls',
  ];
  if (addressHints.some((hint) => message.includes(hint))) {
    return 'Gateway地址错误';
  }

  if (err?.details || err?.gatewayCode) {
    return 'Gateway可访问，但Token错误';
  }
  return 'Gateway地址错误';
}

function formatGatewayError(err) {
  const message = err?.message || String(err);
  const detailCode = err?.details?.code || err?.details?.detailCode;
  if (/handshake failed|self[- ]signed|certificate|ssl|tls/i.test(message)) {
    return 'Gateway TLS 握手失败，请确认 WSS 地址正确且 Gateway 已启动';
  }
  if (detailCode === 'PAIRING_REQUIRED' || message.includes('pairing')) {
    return `${message}。请在 Gateway 主机运行: openclaw devices approve`;
  }
  if (detailCode === 'DEVICE_IDENTITY_REQUIRED') {
    return `${message}。设备身份未就绪，请重启应用后重试`;
  }
  return message;
}

function safeSendTo(sender, channel, payload) {
  try {
    if (sender.isDestroyed && sender.isDestroyed()) return false;
    sender.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function broadcastToRenderers(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeSendTo(mainWindow.webContents, channel, payload);
  }
}

function parseImageMarkersFromText(text) {
  const imageRegex = /\[image:(data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\]/g;
  const images = [];
  const plainText = String(text || '')
    .replace(imageRegex, (_m, dataUrl) => {
      images.push(dataUrl);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: plainText, images };
}

function extractMessageParts(message) {
  if (!message) return { text: '', images: [] };
  if (typeof message === 'string') {
    const parsed = parseImageMarkersFromText(message);
    return { text: parsed.text, images: parsed.images };
  }
  if (typeof message.content === 'string') {
    const parsed = parseImageMarkersFromText(message.content);
    return { text: parsed.text, images: parsed.images };
  }
  if (Array.isArray(message.content)) {
    const images = [];
    const textParts = [];
    for (const block of message.content) {
      if (typeof block === 'string') {
        textParts.push(block);
        continue;
      }
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }
      if (block?.type === 'image' && block.source?.data) {
        const mime = block.source.media_type || block.mimeType || 'image/png';
        images.push(`data:${mime};base64,${block.source.data}`);
        continue;
      }
      if (block?.type === 'image_url' && block.image_url?.url) {
        images.push(block.image_url.url);
      }
    }
    const joined = textParts.filter(Boolean).join('\n').trim();
    const parsed = parseImageMarkersFromText(joined);
    return {
      text: parsed.text,
      images: [...images, ...parsed.images],
    };
  }
  return { text: '', images: [] };
}

function extractMessageText(message) {
  return extractMessageParts(message).text;
}

function extractOpenClawFileMeta(message) {
  if (!message || typeof message !== 'object') return [];
  const paths = Array.isArray(message.MediaPaths)
    ? message.MediaPaths
    : (message.MediaPath ? [message.MediaPath] : []);
  const types = Array.isArray(message.MediaTypes)
    ? message.MediaTypes
    : (message.MediaType ? [message.MediaType] : []);
  if (!paths.length) return [];
  return paths.map((filePath, index) => ({
    name: path.basename(String(filePath)),
    mimeType: types[index] || 'application/octet-stream',
  }));
}

function convertHistoryMessages(serverMessages) {
  if (!Array.isArray(serverMessages)) return [];
  return serverMessages
    .map((m) => {
      const role = m?.role || m?.who;
      const { text, images } = extractMessageParts(m);
      const files = extractOpenClawFileMeta(m);
      let resolvedText = text;
      if (!resolvedText && m?.errorMessage) {
        resolvedText = `[错误] ${m.errorMessage}`;
      }
      if (!resolvedText && images.length === 0 && files.length === 0) return null;
      const sent = extractMessageSentTimeFromRaw(m);
      const displayTime = sent.time
        ? sent.time.match(/\d{2}:\d{2}/)?.[0] || sent.time
        : '';
      return {
        who: role === 'user' ? 'me' : 'them',
        text: resolvedText,
        images: images.length > 0 ? images : undefined,
        files: files.length > 0 ? files : undefined,
        time: displayTime,
        sentTime: sent.time || undefined,
        sentAtMs: sent.sentAtMs ?? undefined,
        streaming: false,
      };
    })
    .filter(Boolean);
}

function resolveDeltaText(currentText, payload) {
  const snapshot = payload.message == null ? null : extractMessageText(payload.message);
  if (typeof payload.deltaText === 'string') {
    if (payload.replace === true) return payload.deltaText;
    if (!currentText) return typeof snapshot === 'string' ? snapshot : payload.deltaText;
    if (typeof snapshot === 'string') {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (prefixLength === currentText.length && snapshot.slice(0, prefixLength) === currentText) {
        return `${currentText}${payload.deltaText}`;
      }
      return snapshot;
    }
    return `${currentText}${payload.deltaText}`;
  }
  return typeof snapshot === 'string' ? snapshot : currentText;
}

function findClientRunByGatewayRunId(gatewayRunId) {
  const clientRunId = gatewayRunIndex.get(gatewayRunId);
  if (clientRunId == null) return null;
  const run = activeRuns.get(clientRunId);
  if (!run) {
    gatewayRunIndex.delete(gatewayRunId);
    return null;
  }
  return { clientRunId, run };
}

function registerActiveRun(clientRunId, gatewayRunId, run) {
  activeRuns.set(clientRunId, run);
  gatewayRunIndex.set(gatewayRunId, clientRunId);
}

function unregisterActiveRun(clientRunId) {
  const run = activeRuns.get(clientRunId);
  if (run) {
    if (run.timeout) clearTimeout(run.timeout);
    clearRunRecoverTimer(run);
    gatewayRunIndex.delete(run.gatewayRunId);
  }
  activeRuns.delete(clientRunId);
}

function failAllActiveRuns(reason) {
  for (const [clientRunId] of [...activeRuns.entries()]) {
    finishClientRun(clientRunId, { error: reason });
  }
}

function armRunTimeout(clientRunId, run) {
  if (run.timeout) clearTimeout(run.timeout);
  run.timeout = setTimeout(() => {
    if (activeRuns.has(clientRunId)) {
      finishClientRun(clientRunId, { error: '响应超时（15 分钟）' });
    }
  }, STREAM_TIMEOUT_MS);
  run.timeout.unref?.();
}

function clearRunRecoverTimer(run) {
  if (run.recoverTimer) {
    clearTimeout(run.recoverTimer);
    run.recoverTimer = null;
  }
}

function suspendActiveRuns() {
  for (const [, run] of activeRuns.entries()) {
    run.suspended = true;
    run.disconnectAt = Date.now();
    if (run.timeout) {
      clearTimeout(run.timeout);
      run.timeout = null;
    }
    clearRunRecoverTimer(run);
  }
}

async function fetchLatestAssistantText() {
  const client = gateway;
  if (!client?.connected) return null;
  const result = await client.request('chat.history', {
    sessionKey: getSessionKey(),
    limit: 80,
  });
  const msgs = convertHistoryMessages(result?.messages || []);
  return [...msgs].reverse().find((m) => m.who === 'them')?.text || null;
}

function catchUpRunFromHistory(clientRunId, run, serverText) {
  if (!serverText || serverText.length <= run.fullText.length) return false;
  const delta = serverText.slice(run.fullText.length);
  run.fullText = serverText;
  run.lastEventAt = Date.now();
  safeSendTo(run.sender, 'openclaw:delta', { runId: clientRunId, delta, catchUp: true });
  return true;
}

function pollRunRecovery(clientRunId, attempt = 0) {
  const run = activeRuns.get(clientRunId);
  if (!run) return;

  const sinceEvent = Date.now() - (run.lastEventAt || run.startedAt || Date.now());

  void (async () => {
    try {
      if (sinceEvent < 3000 && attempt < 2) {
        run.recoverTimer = setTimeout(() => pollRunRecovery(clientRunId, attempt + 1), 1500);
        run.recoverTimer.unref?.();
        return;
      }

      const serverText = await fetchLatestAssistantText();
      if (!activeRuns.has(clientRunId)) return;

      if (serverText && serverText.length > run.fullText.length) {
        catchUpRunFromHistory(clientRunId, run, serverText);
        run.stableHistoryPolls = 0;
        run.recoverTimer = setTimeout(() => pollRunRecovery(clientRunId, attempt + 1), 2000);
        run.recoverTimer.unref?.();
        return;
      }

      if (serverText && serverText.length === run.fullText.length && run.fullText.length > 0) {
        run.stableHistoryPolls = (run.stableHistoryPolls || 0) + 1;
        if (run.stableHistoryPolls >= 2 && sinceEvent > 5000) {
          finishClientRun(clientRunId, { ok: true });
          return;
        }
      }

      if (attempt >= 10) {
        finishClientRun(clientRunId, { ok: true });
        return;
      }

      run.recoverTimer = setTimeout(() => pollRunRecovery(clientRunId, attempt + 1), 2500);
      run.recoverTimer.unref?.();
    } catch {
      if (attempt < 8 && activeRuns.has(clientRunId)) {
        run.recoverTimer = setTimeout(() => pollRunRecovery(clientRunId, attempt + 1), 2000);
        run.recoverTimer.unref?.();
      }
    }
  })();
}

async function recoverActiveRunsAfterReconnect() {
  if (activeRuns.size === 0) return;
  for (const [clientRunId, run] of activeRuns.entries()) {
    run.suspended = false;
    run.lastEventAt = Date.now();
    clearRunRecoverTimer(run);
    armRunTimeout(clientRunId, run);
    try {
      const serverText = await fetchLatestAssistantText();
      if (activeRuns.has(clientRunId) && serverText) {
        catchUpRunFromHistory(clientRunId, run, serverText);
      }
    } catch {
      // 重连后 history 拉取失败也不报错，继续等 live event
    }
    pollRunRecovery(clientRunId, 0);
  }
}

function finishClientRun(clientRunId, outcome) {
  const run = activeRuns.get(clientRunId);
  if (!run) return;
  unregisterActiveRun(clientRunId);
  const fullText = run.fullText;
  if (outcome.aborted) {
    safeSendTo(run.sender, 'openclaw:done', { runId: clientRunId, aborted: true, text: fullText });
  } else if (outcome.error) {
    safeSendTo(run.sender, 'openclaw:error', { runId: clientRunId, error: outcome.error });
  } else {
    safeSendTo(run.sender, 'openclaw:done', { runId: clientRunId, text: fullText });
  }
  if (run.done) {
    run.done({ ...outcome, text: fullText });
  }
}

/** @type {Map<string, { fullText: string, lastEventAt: number }>} */
const externalSessionRuns = new Map();

function isPayloadForCurrentSession(payload) {
  const key = payload?.sessionKey;
  return !key || key === getSessionKey();
}

function handleExternalSessionChatEvent(payload) {
  if (!payload || typeof payload.runId !== 'string') return;
  if (activeRuns.size > 0) return;
  if (!isPayloadForCurrentSession(payload)) return;

  const gatewayRunId = payload.runId;
  let run = externalSessionRuns.get(gatewayRunId);
  if (!run) {
    run = { fullText: '', lastEventAt: Date.now() };
    externalSessionRuns.set(gatewayRunId, run);
  }
  run.lastEventAt = Date.now();

  if (payload.state === 'delta') {
    const next = resolveDeltaText(run.fullText, payload);
    if (typeof next === 'string' && next !== run.fullText) {
      if (payload.replace === true) {
        run.fullText = next;
        broadcastToRenderers('openclaw:session-chat', {
          state: 'delta',
          gatewayRunId,
          delta: next,
          replace: true,
          text: next,
        });
      } else {
        const delta = next.startsWith(run.fullText) ? next.slice(run.fullText.length) : next;
        run.fullText = next;
        if (delta) {
          broadcastToRenderers('openclaw:session-chat', {
            state: 'delta',
            gatewayRunId,
            delta,
            replace: false,
            text: next,
          });
        }
      }
    }
    return;
  }

  if (payload.state === 'final') {
    const finalText = extractMessageText(payload.message);
    if (finalText && finalText.length >= run.fullText.length) {
      run.fullText = finalText;
    }
    broadcastToRenderers('openclaw:session-chat', {
      state: 'final',
      gatewayRunId,
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
    return;
  }

  if (payload.state === 'aborted') {
    broadcastToRenderers('openclaw:session-chat', {
      state: 'aborted',
      gatewayRunId,
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
    return;
  }

  if (payload.state === 'error') {
    broadcastToRenderers('openclaw:session-chat', {
      state: 'error',
      gatewayRunId,
      error: payload.errorMessage || 'chat error',
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
  }
}

function handleSessionsChangedEvent(payload) {
  const keys = new Set();
  if (payload?.key) keys.add(payload.key);
  if (payload?.sessionKey) keys.add(payload.sessionKey);
  if (typeof payload?.session?.key === 'string') keys.add(payload.session.key);
  if (Array.isArray(payload?.sessions)) {
    for (const session of payload.sessions) {
      if (session?.key) keys.add(session.key);
    }
  }
  if (keys.size > 0 && !keys.has(getSessionKey())) return;
  broadcastToRenderers('openclaw:session-changed', { sessionKey: getSessionKey() });
}

function handleGatewayChatEvent(payload) {
  if (!payload || typeof payload.runId !== 'string') return;
  const matched = findClientRunByGatewayRunId(payload.runId);
  if (matched) {
    handleOwnedGatewayChatEvent(payload, matched);
    return;
  }
  handleExternalSessionChatEvent(payload);
}

function handleOwnedGatewayChatEvent(payload, matched) {
  const { clientRunId, run } = matched;
  run.lastEventAt = Date.now();
  run.stableHistoryPolls = 0;
  clearRunRecoverTimer(run);

  if (payload.state === 'delta') {
    const next = resolveDeltaText(run.fullText, payload);
    if (typeof next === 'string' && next !== run.fullText) {
      if (payload.replace === true) {
        run.fullText = next;
        safeSendTo(run.sender, 'openclaw:delta', { runId: clientRunId, delta: next, replace: true });
      } else {
        const delta = next.startsWith(run.fullText) ? next.slice(run.fullText.length) : next;
        run.fullText = next;
        if (delta) {
          safeSendTo(run.sender, 'openclaw:delta', { runId: clientRunId, delta });
        }
      }
    }
    return;
  }

  if (payload.state === 'final') {
    const finalText = extractMessageText(payload.message);
    if (finalText && finalText.length >= run.fullText.length) {
      run.fullText = finalText;
    }
    finishClientRun(clientRunId, { ok: true });
    return;
  }

  if (payload.state === 'aborted') {
    finishClientRun(clientRunId, { aborted: true });
    return;
  }

  if (payload.state === 'error') {
    finishClientRun(clientRunId, { error: payload.errorMessage || 'chat error' });
  }
}

function attachGatewayHandlers(client) {
  client.removeAllListeners('event');
  client.removeAllListeners('connected');
  client.removeAllListeners('close');
  client.on('event', (frame) => {
    if (frame.event === 'chat') {
      handleGatewayChatEvent(frame.payload);
      return;
    }
    if (frame.event === 'sessions.changed') {
      handleSessionsChangedEvent(frame.payload);
    }
  });
  client.on('connected', () => {
    broadcastToRenderers('openclaw:gateway-status', {
      connected: true,
      reconnected: activeRuns.size > 0,
    });
    if (activeRuns.size > 0) {
      recoverActiveRunsAfterReconnect().catch((err) => {
        console.warn('[qizi] recover runs failed:', err.message);
      });
    }
  });
  client.on('close', () => {
    if (isQuitting) {
      failAllActiveRuns('应用正在退出');
    } else {
      suspendActiveRuns();
    }
    broadcastToRenderers('openclaw:gateway-status', {
      connected: false,
      reconnecting: !isQuitting,
    });
  });
}

function ensureGateway() {
  const config = loadOpenClawConfig();
  if (!config.wsUrl || !config.token) {
    throw new Error('未配置 Gateway，请在设置中填写管理员提供的 WSS 地址与 Token');
  }
  const nextKey = `${config.wsUrl}\0${config.token || ''}`;
  if (!gateway || gatewayConfigKey !== nextKey) {
    if (gateway) {
      failAllActiveRuns('Gateway 配置已变更');
      gateway.stop();
    }
    gateway = new GatewayWsClient({
      url: config.wsUrl,
      token: config.token,
      clientVersion: '0.1.0',
    });
    attachGatewayHandlers(gateway);
    gateway.start();
    gatewayConfigKey = nextKey;
  }
  return gateway;
}

function stopGateway() {
  failAllActiveRuns('应用正在退出');
  if (gateway) {
    gateway.stop();
    gateway = null;
    gatewayConfigKey = null;
  }
}

// QQ 好友聊天窗口最小尺寸 BuddyChatMsgCtrlMinSizeX/Y
const WINDOW_MIN_WIDTH = 440;
const WINDOW_MIN_HEIGHT = 502;

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      width: Math.max(WINDOW_MIN_WIDTH, Number(saved.width) || WINDOW_MIN_WIDTH),
      height: Math.max(WINDOW_MIN_HEIGHT, Number(saved.height) || WINDOW_MIN_HEIGHT),
    };
  } catch {
    return { width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(mainWindow.getBounds()), 'utf8');
  } catch {
    // non-fatal
  }
}

function createWindow() {
  const { width, height } = loadWindowState();
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'QiziShell',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
  });

  mainWindow.webContents.session.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('close', (event) => {
    saveWindowState();
    // 拦截「红点关闭」→ 隐藏而不是退出（菜单栏应用习惯）
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      // macOS: 主界面隐藏时同步隐藏 Dock 图标
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
      }
    }
  });

  mainWindow.on('show', () => {
    // 主界面显示时让 Dock 图标也出现
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openLinksExternally && openExternal(url)) {
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (openLinksExternally && isExternalUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  mainWindow.loadFile('index.html');
  // 调试用：远程 DevTools 协议端口 (方便脚本控制 renderer)
  if (process.env.QIZI_DEVTOOLS_PORT) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

// 切换主界面显隐（供菜单栏左键调用）
function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// 生成一个简单的占位菜单栏图标（16x16 Template 风格，黑透明）
// 后续可以换成本地图片
function buildTrayIcon() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
  } catch {
    img = nativeImage.createEmpty();
  }
  img.setTemplateImage(true);  // Template 风格 → 跟着 macOS 浅色/深色模式走
  return img;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '设置', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => {
      isQuitting = true;
      app.quit();
    } },
  ]);
}

function createTray() {
  if (tray) return;  // 幂等
  const icon = buildTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('QiziShell');
  tray.setContextMenu(buildTrayMenu());
  // 左键 = toggle 显隐主界面
  tray.on('click', () => toggleMainWindow());
}

async function checkConnection() {
  const { token, wsUrl } = loadOpenClawConfig();
  if (!wsUrl || !token) {
    return { ok: false, error: '未配置 Gateway，请在设置中填写管理员提供的 WSS 地址与 Token' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    return { ok: true, wsUrl, sessionKey: getSessionKey() };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function fetchSessionInfo() {
  const client = ensureGateway();
  await client.waitForConnect();
  const result = await client.request('chat.history', {
    sessionKey: getSessionKey(),
    limit: 1,
  });
  return {
    sessionInfo: result?.sessionInfo || {},
    defaults: result?.defaults || {},
  };
}

async function getSessionInfo() {
  try {
    const { sessionInfo, defaults } = await fetchSessionInfo();
    const provider = sessionInfo.modelProvider ?? defaults.modelProvider ?? null;
    const model = sessionInfo.model ?? defaults.model ?? null;
    const used = typeof sessionInfo.totalTokens === 'number' ? sessionInfo.totalTokens : null;
    const max = sessionInfo.contextTokens ?? defaults.contextTokens ?? null;
    const fresh = sessionInfo.totalTokensFresh !== false;
    let percent = null;
    if (used != null && typeof max === 'number' && max > 0) {
      percent = Math.min(100, Math.round((used / max) * 100));
    }
    return {
      ok: true,
      provider,
      model,
      qualified: provider && model ? `${provider}/${model}` : null,
      hasActiveRun: Boolean(sessionInfo.hasActiveRun),
      context: { used, max, percent, fresh },
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function getCurrentModel() {
  const result = await getSessionInfo();
  if (!result.ok) return result;
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    qualified: result.qualified,
  };
}

async function listModels() {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const result = await client.request('models.list', { view: 'configured' });
    return { ok: true, models: Array.isArray(result?.models) ? result.models : [] };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err), models: [] };
  }
}

async function listAgents() {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const result = await client.request('agents.list', {});
    const defaultId = result?.defaultId || 'main';
    const mainKey = result?.mainKey || 'main';
    const rawAgents = Array.isArray(result?.agents) ? result.agents : [];
    const [sessionModels, defaultsResult] = await Promise.all([
      fetchAgentMainSessionModels(client, mainKey),
      client.request('chat.history', { sessionKey: buildAgentSessionKey(defaultId, mainKey), limit: 1 }).catch(() => null),
    ]);
    const defaults = {
      modelProvider: defaultsResult?.sessionInfo?.modelProvider ?? defaultsResult?.defaults?.modelProvider ?? null,
      model: defaultsResult?.defaults?.model ?? null,
    };
    const agents = await Promise.all(
      rawAgents.map((agent) => enrichAgentEntry(client, agent, { defaultId, sessionModels, defaults })),
    );
    return {
      ok: true,
      agents,
      defaultId,
      mainKey,
      currentSessionKey: getSessionKey(),
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err), agents: [] };
  }
}

async function switchToAgent(agentId) {
  if (!agentId || typeof agentId !== 'string') {
    return { ok: false, error: '未指定 Agent' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const result = await client.request('agents.list', {});
    const defaultId = result?.defaultId || 'main';
    const mainKey = result?.mainKey || 'main';
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    const found = agents.find((agent) => agent.id === agentId);
    if (!found) {
      return { ok: false, error: `未找到 Agent: ${agentId}` };
    }

    for (const [clientRunId] of [...activeRuns.entries()]) {
      finishClientRun(clientRunId, { aborted: true });
    }

    const newSessionKey = pinnedSessionKeyForAgent(agentId, mainKey);
    persistSessionKey(newSessionKey);
    const agent = await enrichAgentEntry(client, found, { defaultId });
    const currentModel = await fetchSessionCurrentModel(client, newSessionKey, {
      modelProvider: result?.defaults?.modelProvider,
      model: result?.defaults?.model,
    });
    applyCurrentModelToEntry(agent, currentModel, {
      modelProvider: result?.defaults?.modelProvider,
      model: result?.defaults?.model,
    });
    return {
      ok: true,
      sessionKey: newSessionKey,
      agent,
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function setSessionModel(qualifiedModel) {
  if (!qualifiedModel || typeof qualifiedModel !== 'string') {
    return { ok: false, error: '未指定模型' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const result = await client.request('sessions.patch', {
      key: getSessionKey(),
      model: qualifiedModel.trim(),
    });
    const resolved = result?.resolved || {};
    const provider = resolved.modelProvider ?? null;
    const model = resolved.model ?? null;
    return {
      ok: true,
      provider,
      model,
      qualified: provider && model ? `${provider}/${model}` : qualifiedModel.trim(),
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function loadChatHistory() {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const sessionKey = getSessionKey();
    const result = await client.request('chat.history', {
      sessionKey,
      limit: 200,
    });
    return {
      ok: true,
      sessionKey,
      sessionKeyChanged: false,
      messages: convertHistoryMessages(result?.messages || []),
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

const VISION_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function isHeicLikeBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brands = buffer.toString('ascii', 8, Math.min(buffer.length, 64)).toLowerCase();
  return /hei[cvx]|heif|mif1|msf1/.test(brands);
}

function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (isHeicLikeBuffer(buffer)) {
    return 'image/heic';
  }
  return null;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exit ${code}`));
    });
  });
}

async function convertBufferToJpegWithSips(buffer, inputExt) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const inputPath = path.join(os.tmpdir(), `qizi-img-in-${id}.${inputExt}`);
  const outputPath = path.join(os.tmpdir(), `qizi-img-out-${id}.jpg`);
  try {
    fs.writeFileSync(inputPath, buffer);
    await runProcess('sips', ['-s', 'format', 'jpeg', inputPath, '--out', outputPath]);
    const jpegBuffer = fs.readFileSync(outputPath);
    if (!jpegBuffer.length) {
      throw new Error('sips produced empty output');
    }
    return jpegBuffer;
  } finally {
    try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
  }
}

async function convertBufferToJpeg(buffer, effectiveMime) {
  const img = nativeImage.createFromBuffer(buffer);
  if (!img.isEmpty()) {
    return img.toJPEG(92);
  }

  if (process.platform !== 'darwin') {
    throw new Error('无法读取图片，请换 JPG 或 PNG 格式');
  }

  const extCandidates = [];
  if (effectiveMime.includes('heic') || effectiveMime.includes('heif') || isHeicLikeBuffer(buffer)) {
    extCandidates.push('heic', 'heif');
  }
  extCandidates.push('jpg', 'jpeg', 'png');
  const seen = new Set();
  for (const ext of extCandidates) {
    if (seen.has(ext)) continue;
    seen.add(ext);
    try {
      return await convertBufferToJpegWithSips(buffer, ext);
    } catch {
      // try next extension hint for mislabeled files
    }
  }

  throw new Error('无法读取图片，请换 JPG 或 PNG 格式');
}

async function normalizeImageDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const declaredMime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) return null;

  const buffer = Buffer.from(base64, 'base64');
  const sniffedMime = sniffImageMime(buffer);
  const effectiveMime = sniffedMime || declaredMime;
  const mimeMismatch = Boolean(sniffedMime && sniffedMime !== declaredMime);
  const needsConversion = !VISION_IMAGE_MIMES.has(effectiveMime) || mimeMismatch;

  if (!needsConversion) {
    return { mimeType: effectiveMime, base64 };
  }

  const jpegBuffer = await convertBufferToJpeg(buffer, effectiveMime);
  return {
    mimeType: 'image/jpeg',
    base64: jpegBuffer.toString('base64'),
  };
}

async function dataUrlToAttachment(dataUrl, index) {
  const normalized = await normalizeImageDataUrl(dataUrl);
  if (!normalized) return null;
  const ext = normalized.mimeType.split('/')[1] || 'jpg';
  return {
    type: 'image',
    mimeType: normalized.mimeType,
    fileName: `image-${index + 1}.${ext}`,
    content: normalized.base64,
  };
}

async function pendingFileToAttachment(fileEntry, index) {
  const dataUrl = fileEntry?.dataUrl;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) return null;
  let mimeType = (fileEntry?.mimeType || match[1] || '').toLowerCase();
  let base64 = match[2].replace(/\s+/g, '');
  const sizeBytes = Buffer.byteLength(base64, 'base64');
  if (sizeBytes > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new Error(`${fileEntry?.name || '文件'} 超过 20MB 上限`);
  }

  const buffer = Buffer.from(base64, 'base64');
  const sniffed = sniffImageMime(buffer);
  const isImage = mimeType.startsWith('image/') || Boolean(sniffed);
  if (isImage) {
    const normalized = await normalizeImageDataUrl(dataUrl);
    if (!normalized) return null;
    mimeType = normalized.mimeType;
    base64 = normalized.base64;
  }

  const fileName = fileEntry?.name || `file-${index + 1}`;
  return {
    type: isImage ? 'image' : 'file',
    mimeType,
    fileName,
    content: base64,
  };
}

async function buildChatAttachments(images = [], files = []) {
  const attachments = [];
  for (let idx = 0; idx < images.length; idx += 1) {
    const attachment = await dataUrlToAttachment(images[idx], idx);
    if (attachment) attachments.push(attachment);
  }
  for (let idx = 0; idx < files.length; idx += 1) {
    const attachment = await pendingFileToAttachment(files[idx], images.length + idx);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

async function forwardMessageToAgents({ agentIds, message }) {
  const ids = Array.isArray(agentIds)
    ? [...new Set(agentIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  if (ids.length === 0) {
    return { ok: false, error: '请至少选择一个 Agent' };
  }
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (!trimmed) {
    return { ok: false, error: '转发内容为空' };
  }

  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const result = await client.request('agents.list', {});
    const mainKey = result?.mainKey || 'main';
    const rawAgents = Array.isArray(result?.agents) ? result.agents : [];
    const idSet = new Set(ids);
    const targets = rawAgents.filter((agent) => idSet.has(agent.id));
    if (targets.length === 0) {
      return { ok: false, error: '未找到所选 Agent' };
    }

    const results = [];
    for (const agent of targets) {
      const sessionKey = pinnedSessionKeyForAgent(agent.id, mainKey);
      const idempotencyKey = `qizi-fwd-${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const ack = await client.request('chat.send', {
          sessionKey,
          message: trimmed,
          deliver: false,
          idempotencyKey,
        });
        results.push({
          agentId: agent.id,
          ok: true,
          runId: (ack && ack.runId) || idempotencyKey,
        });
      } catch (err) {
        results.push({
          agentId: agent.id,
          ok: false,
          error: formatGatewayError(err),
        });
      }
    }

    const failed = results.filter((entry) => !entry.ok);
    if (failed.length === results.length) {
      return {
        ok: false,
        error: failed.map((entry) => entry.error).filter(Boolean).join('；') || '转发失败',
        results,
      };
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function streamChat(event, { message, attachments, runId }) {
  const client = ensureGateway();
  await client.waitForConnect();

  const idempotencyKey = `qizi-${runId}-${Date.now()}`;

  const ack = await client.request('chat.send', {
    sessionKey: getSessionKey(),
    message: message || '',
    deliver: false,
    idempotencyKey,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  });

  const gatewayRunId = (ack && ack.runId) || idempotencyKey;

  return new Promise((resolve) => {
    registerActiveRun(runId, gatewayRunId, {
      gatewayRunId,
      sender: event.sender,
      fullText: '',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      stableHistoryPolls: 0,
      done: (outcome) => {
        if (outcome.error) {
          resolve({ ok: false, error: outcome.error });
        } else if (outcome.aborted) {
          resolve({ ok: false, aborted: true });
        } else {
          resolve({ ok: true, text: outcome.text || '' });
        }
      },
    });
    const run = activeRuns.get(runId);
    if (run) {
      armRunTimeout(runId, run);
      pollRunRecovery(runId, 0);
    }
  });
}

ipcMain.handle('openclaw:check', () => checkConnection());
ipcMain.handle('openclaw:settings:get', () => getSettingsSnapshot());
ipcMain.handle('openclaw:settings:test', (_event, payload) => testGatewaySettings(payload || {}));
ipcMain.handle('openclaw:settings:save', (_event, payload) => {
  try {
    const current = loadShellSettings();
    const wsUrl = typeof payload?.wsUrl === 'string' ? payload.wsUrl.trim() : current.wsUrl;
    const tokenInput = typeof payload?.token === 'string' ? payload.token.trim() : '';
    const token = tokenInput || current.token;
    if (!wsUrl) return { ok: false, error: '请填写 WSS 地址' };
    if (!token) return { ok: false, error: '请填写 Gateway Token' };
    saveShellSettings({
      wsUrl,
      token,
      launchAtLogin: payload?.launchAtLogin === true,
      showMainOnLaunch: payload?.showMainOnLaunch !== false,
    });
    restartGatewayAfterSettings();
    return { ok: true, snapshot: getSettingsSnapshot() };
  } catch (err) {
    return { ok: false, error: err.message || '保存失败' };
  }
});
ipcMain.handle('openclaw:open-settings', () => {
  openSettings();
  return { ok: true };
});
ipcMain.handle('openclaw:getSessionKey', () => getSessionKey());
ipcMain.handle('openclaw:agents:list', () => listAgents());
ipcMain.handle('openclaw:forward', (_event, payload) => forwardMessageToAgents(payload || {}));
ipcMain.handle('openclaw:session:switch', (_event, agentId) => switchToAgent(agentId));
ipcMain.handle('openclaw:history', () => loadChatHistory());
ipcMain.handle('openclaw:models:list', () => listModels());
ipcMain.handle('openclaw:models:current', () => getCurrentModel());
ipcMain.handle('openclaw:session:info', () => getSessionInfo());
ipcMain.handle('openclaw:models:set', (_event, qualifiedModel) => setSessionModel(qualifiedModel));
ipcMain.handle('openclaw:abort', async () => {
  const client = gateway;
  const runs = [...activeRuns.entries()];

  if (client?.connected) {
    if (runs.length > 0) {
      await Promise.allSettled(
        runs.map(([, run]) =>
          client.request('chat.abort', {
            sessionKey: getSessionKey(),
            runId: run.gatewayRunId,
          }),
        ),
      );
    } else {
      try {
        await client.request('chat.abort', { sessionKey: getSessionKey() });
      } catch {
        // ignore
      }
    }
  }

  for (const [clientRunId] of runs) {
    finishClientRun(clientRunId, { aborted: true });
  }
  return { aborted: runs.length > 0 };
});

const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

function mimeFromFilePath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'md':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'zip':
      return 'application/zip';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default:
      return 'application/octet-stream';
  }
}

function mimeFromImagePath(filePath) {
  return mimeFromFilePath(filePath);
}

ipcMain.handle('openclaw:pickImages', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: '找不到主窗口' };
  const result = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  try {
    const images = [];
    for (const filePath of result.filePaths) {
      const buf = fs.readFileSync(filePath);
      const mime = mimeFromImagePath(filePath);
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      images.push({
        dataUrl,
        size: buf.length,
        name: path.basename(filePath),
      });
    }
    return { ok: true, images };
  } catch (err) {
    return { ok: false, error: `读取图片失败: ${err.message}` };
  }
});

function escapeExportHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const EXPORT_WORD_STYLES = `
body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.7; color: #222; }
.export-entry { margin-bottom: 22px; page-break-inside: avoid; }
.export-entry-header { margin: 0 0 10px 0; font-size: 13px; }
.export-entry-header strong { font-weight: 600; }
.export-entry-time { color: #888; font-size: 12px; }
.export-entry-body { font-size: 14px; line-height: 1.7; }
.export-quote { margin: 0 0 10px 0; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; background: #f7f7f7; }
.export-quote-author { font-size: 11px; font-weight: 600; color: #666; margin-bottom: 6px; }
.export-body p { margin: 0 0 8px 0; }
.export-body p:last-child { margin-bottom: 0; }
.export-body strong { font-weight: 600; }
.export-body em { font-style: italic; }
.export-body code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
.export-body pre { margin: 8px 0; padding: 10px 12px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.export-body pre code { background: transparent; padding: 0; }
.export-body table { border-collapse: collapse; margin: 8px 0; font-size: 12px; width: 100%; }
.export-body th, .export-body td, .export-quote th, .export-quote td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
.export-body th, .export-quote th { background: #f5f5f5; font-weight: 600; }
.export-body blockquote, .export-quote blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding: 4px 12px; color: #666; }
.export-body ul, .export-body ol, .export-quote ul, .export-quote ol { margin: 4px 0; padding-left: 22px; }
.export-body li, .export-quote li { margin: 2px 0; }
.export-body h1, .export-body h2, .export-body h3, .export-quote h1, .export-quote h2, .export-quote h3 { margin: 12px 0 6px 0; font-weight: 600; }
.export-body h1, .export-quote h1 { font-size: 16px; }
.export-body h2, .export-quote h2 { font-size: 15px; }
.export-body h3, .export-quote h3 { font-size: 14px; }
.export-body a, .export-quote a { color: #1976d2; text-decoration: underline; }
.export-divider { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
`;

function buildExportWordHtml(entries) {
  const blocks = (Array.isArray(entries) ? entries : []).map((entry) => {
    const author = escapeExportHtml(entry?.author || '未知');
    const time = entry?.time
      ? `<span class="export-entry-time"> ${escapeExportHtml(entry.time)}</span>`
      : '';
    const body = typeof entry?.html === 'string' && entry.html.trim()
      ? entry.html
      : escapeExportHtml(entry?.text || '').replace(/\r?\n/g, '<br/>');
    return [
      '<div class="export-entry">',
      `<p class="export-entry-header"><strong>${author}</strong>${time}</p>`,
      `<div class="export-entry-body">${body}</div>`,
      '</div>',
    ].join('');
  });
  return [
    '<!DOCTYPE html>',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>QiziShell Export</title>',
    `<style>${EXPORT_WORD_STYLES}</style>`,
    '</head>',
    '<body>',
    blocks.join('<hr class="export-divider"/>'),
    '</body></html>',
  ].join('');
}

ipcMain.handle('openclaw:export:word', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: '找不到主窗口' };
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (!entries.length) return { ok: false, error: '没有可导出的消息' };
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(win, {
    title: '保存为 Word 文档',
    defaultPath: `qizi-export-${stamp}.doc`,
    filters: [{ name: 'Word 文档', extensions: ['doc', 'docx'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, cancelled: true };
  }
  try {
    const html = buildExportWordHtml(entries);
    fs.writeFileSync(result.filePath, `\ufeff${html}`, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message || '保存失败' };
  }
});

ipcMain.handle('openclaw:pickFiles', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: '找不到主窗口' };
  const result = await dialog.showOpenDialog(win, {
    title: '选择文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  try {
    const files = [];
    for (const filePath of result.filePaths) {
      const buf = fs.readFileSync(filePath);
      if (buf.length > CHAT_ATTACHMENT_MAX_BYTES) {
        return {
          ok: false,
          error: `${path.basename(filePath)} 超过 20MB 上限`,
        };
      }
      const mime = mimeFromFilePath(filePath);
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      files.push({
        dataUrl,
        size: buf.length,
        name: path.basename(filePath),
        mimeType: mime,
      });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: `读取文件失败: ${err.message}` };
  }
});

ipcMain.handle('openclaw:screenshot', async () => {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `qizi-shot-${Date.now()}.png`);
    // -i 交互式选区域；-x 不播快门声；-t png 输出格式
    const proc = spawn('screencapture', ['-i', '-x', '-t', 'png', tmpFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `无法启动 screencapture: ${err.message}` });
    });
    proc.on('exit', (code) => {
      // 用户按 Esc 取消时 exit code = 1，文件不存在
      if (code !== 0) {
        resolve({ ok: false, canceled: true });
        return;
      }
      try {
        const buf = fs.readFileSync(tmpFile);
        const base64 = buf.toString('base64');
        try { fs.unlinkSync(tmpFile); } catch {}
        resolve({
          ok: true,
          dataUrl: `data:image/png;base64,${base64}`,
          size: buf.length,
        });
      } catch (err) {
        resolve({ ok: false, error: `读取截屏失败: ${err.message}` });
      }
    });
  });
});

ipcMain.handle('openclaw:normalize-image', async (_event, dataUrl) => {
  try {
    const normalized = await normalizeImageDataUrl(dataUrl);
    if (!normalized) {
      return { ok: false, error: '无效图片' };
    }
    return {
      ok: true,
      dataUrl: `data:${normalized.mimeType};base64,${normalized.base64}`,
      mimeType: normalized.mimeType,
    };
  } catch (err) {
    return { ok: false, error: err.message || '无法读取图片' };
  }
});

ipcMain.handle('openclaw:chat', async (event, { message, images, files, runId }) => {
  try {
    const imageList = Array.isArray(images) ? images : [];
    const fileList = Array.isArray(files) ? files : [];
    const attachments = await buildChatAttachments(imageList, fileList);
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    let defaultCaption = '';
    if (!trimmedMessage && attachments.length > 0) {
      const hasImages = imageList.length > 0;
      const hasFiles = fileList.length > 0;
      if (hasImages && !hasFiles) defaultCaption = '（图片）';
      else defaultCaption = '（附件）';
    }
    const outboundMessage = trimmedMessage || defaultCaption;
    return await streamChat(event, { message: outboundMessage, attachments, runId });
  } catch (err) {
    const errMessage = formatGatewayError(err);
    safeSendTo(event.sender, 'openclaw:error', { runId, error: errMessage });
    return { ok: false, error: errMessage };
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  const shellSettings = loadShellSettings();
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: shellSettings.launchAtLogin === true,
      openAsHidden: shellSettings.showMainOnLaunch === false,
    });
  }
  if (shellSettings.showMainOnLaunch === false && mainWindow) {
    mainWindow.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  }
  try {
    ensureGateway();
  } catch (err) {
    console.warn('[qizi] 预连接 Gateway 失败:', err.message);
  }
});
// 菜单栏应用：主界面关了不退出（菜单栏图标还在）
app.on('window-all-closed', () => {
  // 不调 app.quit() —— 让进程跟着菜单栏图标走
  // 点「退出」菜单时 isQuitting=true + app.quit() 才是真退
});
// 真的退出前清理菜单栏图标，避免 macOS 状态栏残留
app.on('before-quit', () => {
  isQuitting = true;
  stopGateway();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// 全局兜底：renderer 销毁/网络抖动等场景下，孤悬的 Promise rejection 不该让 main 崩
// 重点关注 "Render frame was disposed" —— 这是壳子特有的"renderer 被关了"信号
process.on('unhandledRejection', (reason) => {
  const msg = (reason && (reason.message || String(reason))) || '';
  if (msg.includes('Render frame was disposed') || msg.includes('webFrameMain')) {
    console.log('[qizi] 忽略 renderer 销毁后的异步错误: ' + msg);
    return;
  }
  console.error('[qizi] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  const msg = err && (err.message || String(err)) || '';
  if (msg.includes('Render frame was disposed') || msg.includes('webFrameMain')) {
    console.log('[qizi] 忽略 renderer 销毁后的未捕获异常: ' + msg);
    return;
  }
  console.error('[qizi] uncaughtException:', err);
});
