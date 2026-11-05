const { app, BrowserWindow, clipboard, ipcMain, shell, Tray, Menu, nativeImage, dialog, screen } = require('electron');
const { spawn } = require('child_process');

const openLinksExternally = !process.argv.includes('--open-links-in-shell');

const { shouldAllowInsecureTls, rejectUnauthorizedForUrl } = require('./tls-policy');
const { MaintainingSession } = require('./maintaining-session');
const { buildExportWordHtml } = require('./export-html');
const { checkForUpdate, downloadAndInstallUpdate } = require('./update-checker');
const { startMeetingGroupRelay } = require('./meeting-group');
const { saveMeetingRecord } = require('./meeting-store');
const { priorTopicExcerpt } = require('./meeting-topic-ledger');
const {
  listFinishedMeetings,
  saveFinishedMeeting,
  loadFinishedMeeting,
  listPriorSummaries,
} = require('./meeting-record-remote');
const {
  isMeetingA2ASessionKey,
  isModeratorPostCloseStub,
  buildMeetingRequirementSections,
} = require('./meeting-protocol');
const {
  PRESET_ID_RE,
  meetingPresetId,
  buildMeetingPresetMarkdown,
  presetFromMarkdown,
  parseMeetingRequirementSections,
  unsavedMeetingParameters,
} = require('./meeting-preset-doc');
const { prepareReadingReportPath, isMissingGatewayMethod } = require('./meeting-report-file');
const {
  listAgentFileCatalog,
  readAgentFile,
  saveAgentFile,
} = require('./agent-files');
const {
  findModeratorFinalMessage,
  buildMeetingForwardPayload,
  isMeetingClosingStub,
} = require('./meeting-forward');
const {
  createPrivateChannelStore,
  buildPrivateChannelCatalog,
  publicChannelOption,
  normalizeDmScope,
  dmScopeRank,
} = require('./private-channel');
const { createMessageArchiveStore } = require('./message-archive');

function isSafeExternalHttpUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isExternalUrl(url) {
  return isSafeExternalHttpUrl(url);
}

function openExternal(url) {
  if (isSafeExternalHttpUrl(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
}

if (!app || typeof app.whenReady !== 'function') {
  console.error(
    '无法加载 Electron 主进程 API。\n' +
    '请在项目目录运行: npm start\n' +
    '(若在 Cursor 内置终端失败，请用系统「终端.app」启动)'
  );
  process.exit(1);
}

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { GatewayWsClient } = require('./gateway-ws');
const { extractMessageSentTimeFromRaw, stripLeadingEnvelopeTimestamp, stripSenderUntrustedMetadata } = require('./message-time');
const {
  initSttManager,
  getSttStatus,
  installStt,
  uninstallStt,
  transcribeAudioFile,
} = require('./stt-manager');
const { file: tmpFile } = require('tmp-promise');

let mainWindow = null;
let maintainingWindow = null;
let maintainingSession = null;

const FORWARD_DEDUP_MS = 120_000;
const FORWARD_REGISTRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FORWARD_REGISTRY_MAX_ENTRIES = 8000;
// Gateway chat.history 不传 maxChars 时默认只回 8000 字，并在末尾加 ...(truncated)...
// 该参数的协议上限是 50 万；网页端按单条消息另取全文，这里对齐到上限。
const CHAT_HISTORY_TEXT_MAX_CHARS = 500_000;
const FORWARD_REGISTRY_PATH = () => path.join(app.getPath('userData'), 'forward-sent-registry.json');
function normalizeDebugMode(input) {
  const mode = String(input || '').trim().toLowerCase();
  if (mode === 'stream' || mode === 'session' || mode === 'all') return mode;
  return '';
}
function getEnvDebugMode() {
  const mode = normalizeDebugMode(process.env.QIZI_DEBUG);
  if (mode) return mode;
  if (process.env.QIZI_DEBUG_STREAM === '1') return 'stream';
  return '';
}
const ENV_DEBUG_MODE = getEnvDebugMode();
let runtimeDebugMode = '';

function getRuntimeDebugMode() {
  return runtimeDebugMode || '';
}

function debugEvent(channel, event, payload) {
  const mode = getRuntimeDebugMode();
  const enabled = mode === 'all' || mode === channel;
  if (!enabled) return;
  try {
    console.log(`[qizi:main:${channel}] ${event}`, payload || {});
  } catch {
    // ignore debug log failures
  }
}
/** @type {Map<string, Promise<object>>} */
const forwardInFlight = new Map();
/** @type {Map<string, number>} */
const recentForwardScopes = new Map();
/** @type {Set<string>} */
const meetingForwardDone = new Set();
/** @type {Map<string, number> | null} */
let forwardSentRegistry = null;
/** @type {Map<string, { sessionKey: string, agentId: string, startedAt: number }>} */
const pendingForwardRuns = new Map();
const FORWARD_WATCH_MS = 5 * 60 * 1000;

function watchForwardSession(sessionKey, agentId, gatewayRunId) {
  if (gatewayRunId) {
    pendingForwardRuns.set(gatewayRunId, {
      sessionKey: String(sessionKey || '').trim(),
      agentId: String(agentId || '').trim(),
      startedAt: Date.now(),
    });
  }
}

function pruneForwardWatchState() {
  const now = Date.now();
  for (const [runId, meta] of pendingForwardRuns) {
    if (now - meta.startedAt > FORWARD_WATCH_MS) pendingForwardRuns.delete(runId);
  }
}

function finishForwardRun(gatewayRunId) {
  pendingForwardRuns.delete(gatewayRunId);
}

const FORWARD_SCOPE_START = '【转发开始】';
const FORWARD_SCOPE_END = '【转发结束】';
const FORWARD_SCOPE_COMMENT = '【留言】';

function extractForwardScopeContent(message) {
  const trimmed = String(message || '').trim();
  const start = trimmed.indexOf(FORWARD_SCOPE_START);
  const end = trimmed.indexOf(FORWARD_SCOPE_END);
  if (start >= 0 && end > start) {
    const body = trimmed.slice(start + FORWARD_SCOPE_START.length, end).trim();
    const commentIdx = trimmed.indexOf(FORWARD_SCOPE_COMMENT, end);
    const comment = commentIdx >= 0
      ? trimmed.slice(commentIdx + FORWARD_SCOPE_COMMENT.length).trim()
      : '';
    return comment ? `${body}\0${comment}` : body;
  }
  return trimmed;
}

function forwardHistoryFingerprint(msg) {
  if (!msg || msg.who !== 'me') return null;
  const text = String(msg.text || '');
  if (!text.includes(FORWARD_SCOPE_START) && !/"kind"\s*:\s*"forwarded-message"/.test(text)) {
    return null;
  }
  const content = extractForwardScopeContent(text);
  if (!content) return null;
  return content.includes('\0') ? content.split('\0')[0] : content;
}

function dedupeForwardHistoryMessages(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const out = [];
  for (const msg of list) {
    if (msg?.who !== 'me') {
      out.push(msg);
      continue;
    }
    const fp = forwardHistoryFingerprint(msg);
    if (!fp) {
      out.push(msg);
      continue;
    }
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const prevFp = prev?.who === 'me' ? forwardHistoryFingerprint(prev) : null;
    if (prevFp && prevFp === fp) continue;
    out.push(msg);
  }
  return out;
}

function buildForwardDedupeScope(agentIds, message, dedupeScope) {
  const explicit = typeof dedupeScope === 'string' ? dedupeScope.trim() : '';
  if (explicit) return explicit;
  const normalizedIds = [...new Set(agentIds.map((id) => id.trim()).filter(Boolean))].sort().join(',');
  const contentKey = extractForwardScopeContent(message);
  return crypto
    .createHash('sha256')
    .update(normalizedIds)
    .update('\0')
    .update(contentKey)
    .digest('hex')
    .slice(0, 40);
}

function buildForwardIdempotencyKey(scope, agentId) {
  return `qizi-fwd-${scope}-${agentId}`.slice(0, 120);
}

function isMeetingForwardScope(dedupeScope) {
  return typeof dedupeScope === 'string' && dedupeScope.startsWith('meeting-fwd:');
}

function buildManualForwardAttemptKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function dedupeAgentEntries(rawAgents) {
  const byId = new Map();
  for (const agent of rawAgents) {
    const id = typeof agent?.id === 'string' ? agent.id.trim() : '';
    if (!id || byId.has(id)) continue;
    byId.set(id, agent);
  }
  return [...byId.values()];
}

function uniqueAgentsMatchingIds(rawAgents, ids) {
  const idSet = new Set(
    (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim()),
  );
  if (idSet.size === 0) return [];
  return dedupeAgentEntries(rawAgents.filter((agent) => idSet.has(agent?.id)));
}

function pruneRecentForwardScopes(now = Date.now()) {
  for (const [scope, ts] of recentForwardScopes) {
    if (now - ts > FORWARD_DEDUP_MS) recentForwardScopes.delete(scope);
  }
}

function loadForwardSentRegistry() {
  if (forwardSentRegistry) return forwardSentRegistry;
  forwardSentRegistry = new Map();
  try {
    const raw = fs.readFileSync(FORWARD_REGISTRY_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [key, ts] of Object.entries(parsed)) {
        if (typeof key === 'string' && typeof ts === 'number') {
          forwardSentRegistry.set(key, ts);
        }
      }
    }
  } catch {
    // ignore missing or corrupt registry
  }
  pruneForwardSentRegistry();
  for (const key of forwardSentRegistry.keys()) {
    const marker = ':meeting-fwd:';
    const pos = key.indexOf(marker);
    if (pos >= 0) {
      const meetingId = key.slice(pos + marker.length).split(':')[0];
      if (meetingId) meetingForwardDone.add(meetingId);
    }
  }
  return forwardSentRegistry;
}

function pruneForwardSentRegistry(now = Date.now()) {
  if (!forwardSentRegistry) return;
  for (const [key, ts] of forwardSentRegistry) {
    if (now - ts > FORWARD_REGISTRY_RETENTION_MS) forwardSentRegistry.delete(key);
  }
  if (forwardSentRegistry.size <= FORWARD_REGISTRY_MAX_ENTRIES) return;
  const sorted = [...forwardSentRegistry.entries()].sort((a, b) => a[1] - b[1]);
  const dropCount = sorted.length - FORWARD_REGISTRY_MAX_ENTRIES;
  for (let i = 0; i < dropCount; i += 1) {
    forwardSentRegistry.delete(sorted[i][0]);
  }
}

function saveForwardSentRegistry() {
  if (!forwardSentRegistry) return;
  pruneForwardSentRegistry();
  try {
    fs.writeFileSync(
      FORWARD_REGISTRY_PATH(),
      JSON.stringify(Object.fromEntries(forwardSentRegistry)),
      'utf8',
    );
  } catch (err) {
    console.warn('[qizi] save forward registry failed:', err.message);
  }
}

function forwardBodyRegistryKey(agentId, message) {
  const agent = String(agentId || '').trim();
  if (!agent) return '';
  const contentKey = extractForwardScopeContent(message);
  const bodyOnly = contentKey.includes('\0') ? contentKey.split('\0')[0] : contentKey;
  if (!bodyOnly) return '';
  const hash = crypto.createHash('sha256').update(bodyOnly).digest('hex').slice(0, 32);
  return `${agent}:fwd-body:${hash}`;
}

function forwardSentRegistryKey(agentId, scope) {
  return `${String(agentId || '').trim()}:${String(scope || '').trim()}`;
}

function isForwardAlreadySent(agentId, scope) {
  const key = forwardSentRegistryKey(agentId, scope);
  if (!key || key === ':') return false;
  return loadForwardSentRegistry().has(key);
}

function isForwardBodyAlreadySent(agentId, message) {
  const key = forwardBodyRegistryKey(agentId, message);
  if (!key || !key.includes(':fwd-body:')) return false;
  return loadForwardSentRegistry().has(key);
}

function markForwardSent(agentId, scope, message) {
  const key = forwardSentRegistryKey(agentId, scope);
  if (key && key !== ':') {
    loadForwardSentRegistry().set(key, Date.now());
    if (scope.startsWith('meeting-fwd:')) {
      const meetingId = scope.split(':')[1];
      if (meetingId) meetingForwardDone.add(meetingId);
    }
  }
  const bodyKey = forwardBodyRegistryKey(agentId, message);
  if (bodyKey && bodyKey.includes(':fwd-body:')) {
    loadForwardSentRegistry().set(bodyKey, Date.now());
  }
  saveForwardSentRegistry();
}

function getAuthorizedMainWindow(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== mainWindow) return null;
  return mainWindow;
}

function getAuthorizedMaintainingWindow(event) {
  if (!maintainingWindow || maintainingWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== maintainingWindow) return null;
  return maintainingWindow;
}

function shellWindowVisible(win) {
  return Boolean(win && !win.isDestroyed() && win.isVisible());
}

function syncDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (shellWindowVisible(mainWindow) || shellWindowVisible(maintainingWindow)) app.dock.show();
  else app.dock.hide();
}

function forbiddenSenderResult() {
  return { ok: false, error: '仅主窗口可调用此功能' };
}

function isAllowedSttAudioPath(audioPath) {
  if (!audioPath || typeof audioPath !== 'string') return false;
  let resolved;
  try {
    resolved = fs.realpathSync(audioPath);
  } catch {
    return false;
  }
  const allowedRoots = [
    app.getPath('temp'),
    path.join(app.getPath('userData'), 'recordings'),
  ].map((root) => {
    const dir = path.resolve(root);
    return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  });
  return allowedRoots.some((root) => resolved.startsWith(root));
}
let aboutWindow = null;
let meetingHelpWindow = null;
let historyWindow = null;
let historyWindowContext = null;
let copyEditWindow = null;
let agentFilesWindow = null;
let agentFilesClosing = false;
let agentFilesClosePrompt = false;
let agentFilesDirty = false;
let agentFilesSaveWait = null;
let agentFilesContext = null;
let copyEditPayload = null;
let updateWindow = null;
let pendingUpdateInfo = null;
let auxiliaryModalRefCount = 0;
/** @type {Map<string, { fullText: string, resolve: Function, reject: Function, timeout: NodeJS.Timeout, lastEventAt: number }>} */
const pendingMeetingRuns = new Map();
let meetingEngine = null;
let meetingBriefingRunning = false;
let meetingBriefingCancelled = false;
/** 当前会议群聊 session（与私聊 main session 隔离） */
let activeMeetingSessionKey = null;
/** @type {{ sessionKey: string, meetingId: string, moderatorAgentId: string, moderatorLabel?: string, participantAgentIds: string[], topic?: string } | null} */
let activeMeetingMeta = null;
/** @type {{ appendOwnerNote: (text: string) => void } | null} */
let activeMeetingRelay = null;
/** @type {object | null} */
let activeMeetingForwardConfig = null;
/** @type {Array<object>} */
let activeMeetingTranscript = [];
let meetingHistoryPollTimer = null;
let controlUiWindow = null;
let controlUiLaunchUrl = null;
let tray = null;
let isQuitting = false;
/** macOS 点菜单栏图标会同时触发 activate + tray click，需忽略紧随其后的 activate */
let suppressAppActivateUntil = 0;
let gateway = null;
let gatewayConfigKey = null;
/** @type {Map<number, { gatewayRunId: string, sender: Electron.WebContents, fullText: string, done?: (v: unknown) => void, timeout?: NodeJS.Timeout }>} */
const activeRuns = new Map();
/** @type {Map<string, number>} gatewayRunId -> clientRunId */
const gatewayRunIndex = new Map();
/** Shell 自有 run 结束后，Gateway 仍可能延迟推送同 runId 的 chat 事件；忽略以免 refresh 历史覆盖本地 */
/** @type {Map<string, { sessionKey: string, finishedAt: number }>} */
const suppressedOwnedGatewayRuns = new Map();
const SUPPRESS_OWNED_GATEWAY_RUN_MS = 3 * 60 * 1000;
const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const BTW_TIMEOUT_MS = 2 * 60 * 1000;
/** @type {Map<string, { sender: Electron.WebContents, question: string, startedAt: number, timeout?: NodeJS.Timeout }>} */
const pendingBtwRuns = new Map();
let openClawConfigCache = null;
let sessionKey = null;
let privateChannelStore = null;
const DEFAULT_SESSION_KEY = 'agent:main:main';
const SHELL_SESSION_MAIN_KEY = 'main';
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const COPY_EDIT_STATE_PATH = path.join(app.getPath('userData'), 'copy-edit-window-state.json');
const HISTORY_STATE_PATH = path.join(app.getPath('userData'), 'history-window-state.json');
const messageArchive = createMessageArchiveStore(path.join(app.getPath('userData'), 'message-archive'));
const HISTORY_MIN_WIDTH = 360;
const HISTORY_MIN_HEIGHT = 420;
const HISTORY_DEFAULT_WIDTH = 480;
const HISTORY_DEFAULT_HEIGHT = 760;
const COPY_EDIT_MIN_WIDTH = 720;
const COPY_EDIT_MIN_HEIGHT = 480;
const COPY_EDIT_DEFAULT_WIDTH = 960;
const COPY_EDIT_DEFAULT_HEIGHT = 680;
const COPY_EDIT_MAX_CHARS = 2 * 1024 * 1024;
const COPY_EDIT_DRAFTS_PATH = path.join(app.getPath('userData'), 'copy-edit-drafts.json');
const COPY_EDIT_MAX_DRAFTS = 50;
const COPY_EDIT_MAX_PATCHES = 5000;
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const MESSAGE_SOUND_IDS = ['日历铃声.mp3', '明亮音调.mp3', '水滴音.mp3'];

function normalizeMessageSoundId(value) {
  const id = String(value || '').trim();
  return MESSAGE_SOUND_IDS.includes(id) ? id : MESSAGE_SOUND_IDS[0];
}

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
  showMainWindow();
});

function markTrayClick() {
  suppressAppActivateUntil = Date.now() + 400;
}

function shouldIgnoreAppActivate() {
  return process.platform === 'darwin' && Date.now() < suppressAppActivateUntil;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  syncDockVisibility();
}

function getSessionKeyPath() {
  return path.join(app.getPath('userData'), 'session-key');
}

function persistSessionKey(key) {
  const prev = sessionKey;
  sessionKey = key;
  debugEvent('session', 'persist_session_key', { from: prev, to: key });
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
    for (const session of result?.sessions || []) {
      if (!session?.key) continue;
      const match = /^agent:([^:]+):/.exec(session.key);
      if (!match) continue;
      if (session.key !== shellSessionKeyForAgent(match[1], mainKey)) continue;
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

function pinnedSessionKeyForAgent(agentId, mainKey = SHELL_SESSION_MAIN_KEY) {
  return buildAgentSessionKey(agentId, mainKey);
}

function getPrivateChannels() {
  if (!privateChannelStore) {
    privateChannelStore = createPrivateChannelStore(
      path.join(app.getPath('userData'), 'private-channel.json'),
    );
  }
  return privateChannelStore;
}

function shellSessionKeyForAgent(agentId, mainKey = SHELL_SESSION_MAIN_KEY) {
  return getPrivateChannels().shellSessionKey(agentId, mainKey);
}

function sendFieldsForSession(sessionKey) {
  return getPrivateChannels().sendFieldsForSession(sessionKey);
}

function sanitizeSessionKeyForShell(sessionKey, mainKey = SHELL_SESSION_MAIN_KEY) {
  const trimmed = String(sessionKey || '').trim();
  const agentId = parseAgentIdFromSessionKey(trimmed || DEFAULT_SESSION_KEY);
  return shellSessionKeyForAgent(agentId, mainKey);
}

/** @type {Map<string, string>} */
const agentAvatarCache = new Map();
/** @type {Map<string, { label?: string, emoji?: string|null, avatarStatus?: string }>} */
const agentIdentityCache = new Map();
const AGENT_LIST_FRESH_MS = 3 * 60 * 1000;
const AGENT_LIST_STALE_MS = 7 * 24 * 60 * 60 * 1000;
let agentListCache = { gatewayKey: null, at: 0, data: null };
let agentListRefreshPromise = null;

function getAgentListGatewayKey() {
  const { wsUrl, token } = loadOpenClawConfig();
  return `${wsUrl || ''}\0${Boolean(token)}`;
}

function getAgentCatalogCachePath() {
  return path.join(app.getPath('userData'), 'agent-catalog-cache.json');
}

function hydrateIdentityCachesFromAgents(agents) {
  for (const agent of agents || []) {
    if (!agent?.id) continue;
    agentIdentityCache.set(agent.id, {
      label: agent.label,
      emoji: agent.emoji || null,
      avatarStatus: agent.avatarStatus || 'none',
    });
    if (agent.avatarDataUrl) agentAvatarCache.set(agent.id, agent.avatarDataUrl);
  }
}

function loadAgentListCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(getAgentCatalogCachePath(), 'utf8'));
    const key = getAgentListGatewayKey();
    if (!raw?.data?.ok || raw.gatewayKey !== key) return;
    agentListCache = { gatewayKey: key, at: raw.at || 0, data: raw.data };
    hydrateIdentityCachesFromAgents(raw.data.agents);
  } catch {
    // ignore missing or corrupt cache
  }
}

function persistAgentListCacheToDisk() {
  if (!agentListCache.data?.ok || !agentListCache.gatewayKey) return;
  try {
    const data = {
      ...agentListCache.data,
      agents: (agentListCache.data.agents || []).map((agent) => {
        const { avatarDataUrl, ...rest } = agent;
        return rest;
      }),
    };
    const filePath = getAgentCatalogCachePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify({
      gatewayKey: agentListCache.gatewayKey,
      at: agentListCache.at,
      data,
    }), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // non-fatal
  }
}

function clearAgentListCache() {
  agentListCache = { gatewayKey: null, at: 0, data: null };
  agentListRefreshPromise = null;
}

function storeAgentListResult(data) {
  agentListCache = { gatewayKey: getAgentListGatewayKey(), at: Date.now(), data };
  hydrateIdentityCachesFromAgents(data.agents);
  persistAgentListCacheToDisk();
}

function broadcastAgentsUpdated(payload) {
  broadcastToRenderers('openclaw:agents-updated', payload);
}

function applyCachedIdentityToEntry(entry) {
  const cached = agentIdentityCache.get(entry.id);
  if (typeof cached?.label === 'string' && cached.label.trim()) {
    entry.label = cached.label.trim();
  }
  if (cached?.emoji) entry.emoji = cached.emoji;
  if (cached?.avatarStatus) entry.avatarStatus = cached.avatarStatus;
  const avatar = agentAvatarCache.get(entry.id);
  if (avatar) entry.avatarDataUrl = avatar;
  return entry;
}

function pickAvatarCandidate(...values) {
  for (const value of values) {
    const raw = String(value || '').trim();
    if (raw) return raw;
  }
  return '';
}

function isDataUrl(value) {
  return String(value || '').trim().startsWith('data:');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveInlineAvatarValue(avatarValue) {
  const raw = String(avatarValue || '').trim();
  if (!raw) return null;
  if (isDataUrl(raw) || isHttpUrl(raw)) return raw;
  return null;
}

function buildGatewayAvatarUrl(avatarPath) {
  const raw = String(avatarPath || '').trim();
  if (!raw) return null;
  if (isDataUrl(raw) || isHttpUrl(raw)) return raw;
  const { wsUrl } = loadOpenClawConfig();
  if (!wsUrl) return null;
  const base = gatewayHttpBase(wsUrl);
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

function applyListIdentityToEntry(entry, agent) {
  const identity = agent?.identity;
  if (!identity || typeof identity !== 'object') return;
  if (typeof identity.name === 'string' && identity.name.trim()) {
    entry.label = identity.name.trim();
  }
  if (identity.emoji) entry.emoji = identity.emoji;
  if (identity.avatarStatus) entry.avatarStatus = identity.avatarStatus;
  const inline = resolveInlineAvatarValue(pickAvatarCandidate(identity.avatarUrl, identity.avatar));
  if (inline) {
    entry.avatarDataUrl = inline;
    agentAvatarCache.set(entry.id, inline);
  }
}

function buildAgentEntryFast(agent, meta) {
  const entry = normalizeAgentEntry(agent, meta);
  applyCurrentModelToEntry(entry, meta.sessionModels?.get(entry.id), meta.defaults);
  applyListIdentityToEntry(entry, agent);
  applyCachedIdentityToEntry(entry);
  return entry;
}

async function fetchAgentListDefaults(client, defaultId, mainKey) {
  try {
    const defaultsResult = await client.request('chat.history', {
      sessionKey: buildAgentSessionKey(defaultId, mainKey),
      limit: 1,
    });
    return {
      modelProvider: defaultsResult?.sessionInfo?.modelProvider ?? defaultsResult?.defaults?.modelProvider ?? null,
      model: defaultsResult?.defaults?.model ?? null,
    };
  } catch {
    return { modelProvider: null, model: null };
  }
}

async function fetchAgentListCore(client) {
  const result = await client.request('agents.list', {});
  const defaultId = result?.defaultId || 'main';
  const mainKey = result?.mainKey || 'main';
  const rawAgents = dedupeAgentEntries(Array.isArray(result?.agents) ? result.agents : []);
  return { rawAgents, defaultId, mainKey };
}

async function buildAgentListResult(client, rawAgents, defaultId, mainKey, { enrichFull = false } = {}) {
  const sessionModels = await fetchAgentMainSessionModels(client, mainKey);
  const defaults = enrichFull
    ? await fetchAgentListDefaults(client, defaultId, mainKey)
    : { modelProvider: null, model: null };
  const meta = { defaultId, sessionModels, defaults };
  const agents = enrichFull
    ? await Promise.all(rawAgents.map((agent) => enrichAgentEntry(client, agent, meta)))
    : rawAgents.map((agent) => buildAgentEntryFast(agent, meta));
  return {
    ok: true,
    agents,
    defaultId,
    mainKey,
    currentSessionKey: getSessionKey(),
    enriched: enrichFull,
  };
}

function prefetchAgentList() {
  void refreshAgentListInBackground();
}

async function refreshAgentListInBackground() {
  if (agentListRefreshPromise) return agentListRefreshPromise;
  agentListRefreshPromise = (async () => {
    try {
      const client = ensureGateway();
      await client.waitForConnect();
      const { rawAgents, defaultId, mainKey } = await fetchAgentListCore(client);
      const fast = await buildAgentListResult(client, rawAgents, defaultId, mainKey, { enrichFull: false });
      storeAgentListResult(fast);
      broadcastAgentsUpdated(fast);
      const full = await buildAgentListResult(client, rawAgents, defaultId, mainKey, { enrichFull: true });
      storeAgentListResult(full);
      broadcastAgentsUpdated(full);
      return full;
    } catch (err) {
      console.warn('[qizi] agent list refresh failed:', err.message);
      return null;
    } finally {
      agentListRefreshPromise = null;
    }
  })();
  return agentListRefreshPromise;
}

const MODEL_LIST_FRESH_MS = 3 * 60 * 1000;
const MODEL_LIST_STALE_MS = 24 * 60 * 60 * 1000;
/** @type {Map<string, { at: number, data: object }>} */
const modelListByAgent = new Map();
/** @type {Set<string>} */
const modelRefreshInflight = new Set();

function normalizeModelCatalogEntries(models) {
  return (Array.isArray(models) ? models : []).map((entry) => {
    const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : '';
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const alias = typeof entry?.alias === 'string' ? entry.alias.trim() : '';
    let qualified = typeof entry?.qualified === 'string' ? entry.qualified.trim() : '';
    if (!qualified && provider && id) qualified = `${provider}/${id}`;
    if (!qualified && alias.includes('/')) qualified = alias;
    if (!qualified && alias) qualified = alias;
    return qualified ? { ...entry, qualified } : { ...entry };
  });
}

function storeModelListResult(agentId, data) {
  const id = String(agentId || '').trim();
  if (!id) return;
  modelListByAgent.set(id, { at: Date.now(), data });
}

function broadcastModelsUpdated(payload) {
  broadcastToRenderers('openclaw:models-updated', payload);
}

async function requestModelCatalog(client, agentId, { preparedOnly = false, view = 'configured', timeoutMs } = {}) {
  const params = { agentId, view };
  if (preparedOnly) params.preparedOnly = true;
  const opts = typeof timeoutMs === 'number' ? { timeoutMs } : {};
  const result = await client.request('models.list', params, opts);
  return normalizeModelCatalogEntries(result?.models);
}

async function loadModelCatalogForAgent(client, agentId) {
  const attempts = [
    { preparedOnly: true, view: 'configured', timeoutMs: 45_000 },
    { preparedOnly: true, view: 'default', timeoutMs: 45_000 },
    { preparedOnly: false, view: 'configured', timeoutMs: 120_000 },
    { preparedOnly: false, view: 'default', timeoutMs: 120_000 },
  ];
  for (const attempt of attempts) {
    const models = await requestModelCatalog(client, agentId, attempt);
    if (models.length > 0) return models;
  }
  return [];
}

async function refreshModelListForAgent(agentId) {
  const id = String(agentId || '').trim();
  if (!id || modelRefreshInflight.has(id)) return null;
  const cached = modelListByAgent.get(id);
  if (cached?.data?.ok && Date.now() - cached.at < MODEL_LIST_FRESH_MS) return cached.data;
  modelRefreshInflight.add(id);
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const models = await loadModelCatalogForAgent(client, id);
    const data = { ok: true, models, agentId: id };
    storeModelListResult(id, data);
    broadcastModelsUpdated(data);
    return data;
  } catch (err) {
    console.warn('[qizi] model list refresh failed:', err.message);
    return null;
  } finally {
    modelRefreshInflight.delete(id);
  }
}

function refreshModelListInBackground() {
  const agentId = parseAgentIdFromSessionKey(getSessionKey());
  return refreshModelListForAgent(agentId);
}

function prefetchModelList() {
  void refreshModelListInBackground();
}

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
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: rejectUnauthorizedForUrl(url) } : {}),
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

async function resolveAgentAvatarDataUrl(agentId, avatarValue, avatarStatus) {
  const raw = String(avatarValue || '').trim();
  if (!raw) return null;

  const cached = agentAvatarCache.get(agentId);
  if (cached) return cached;

  const inline = resolveInlineAvatarValue(raw);
  if (inline) {
    agentAvatarCache.set(agentId, inline);
    return inline;
  }

  if (avatarStatus === 'none') return null;

  const { token } = loadOpenClawConfig();
  if (!token) return null;

  const url = buildGatewayAvatarUrl(raw);
  if (!url || isDataUrl(url)) return url;
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

/** @deprecated alias */
async function fetchAgentAvatarDataUrl(agentId, avatarPath, avatarStatus) {
  return resolveAgentAvatarDataUrl(agentId, avatarPath, avatarStatus);
}

async function enrichAgentEntry(client, agent, meta = {}) {
  const entry = buildAgentEntryFast(agent, meta);
  try {
    const identity = await client.request('agent.identity.get', { agentId: entry.id });
    if (typeof identity?.name === 'string' && identity.name.trim()) {
      entry.label = identity.name.trim();
    }
    entry.emoji = identity?.emoji || null;
    entry.avatarStatus = identity?.avatarStatus || entry.avatarStatus || 'none';
    agentIdentityCache.set(entry.id, {
      label: entry.label,
      emoji: entry.emoji,
      avatarStatus: entry.avatarStatus,
    });
    entry.avatarDataUrl = await resolveAgentAvatarDataUrl(
      entry.id,
      pickAvatarCandidate(identity?.avatarUrl, identity?.avatar),
      identity?.avatarStatus,
    ) || entry.avatarDataUrl;
  } catch {
    // keep fast entry without fresh identity
  }
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
      messageSoundEnabled: parsed.messageSoundEnabled === true,
      messageSoundId: normalizeMessageSoundId(parsed.messageSoundId),
      tokenless: parsed.tokenless === true,
      debugMode: normalizeDebugMode(parsed.debugMode),
    };
  } catch {
    return {};
  }
}

function saveShellSettings(next) {
  const current = loadShellSettings();
  const hasDebugMode = Object.prototype.hasOwnProperty.call(next || {}, 'debugMode');
  const nextDebugMode = hasDebugMode ? next.debugMode : current.debugMode;
  const merged = {
    wsUrl: typeof next.wsUrl === 'string' ? next.wsUrl.trim().replace(/\/$/, '') : current.wsUrl,
    token: typeof next.token === 'string' && next.token.trim()
      ? next.token.trim()
      : current.token,
    launchAtLogin: next.launchAtLogin == null ? current.launchAtLogin === true : next.launchAtLogin === true,
    showMainOnLaunch: next.showMainOnLaunch == null ? current.showMainOnLaunch !== false : next.showMainOnLaunch !== false,
    messageSoundEnabled: next.messageSoundEnabled == null
      ? current.messageSoundEnabled === true
      : next.messageSoundEnabled === true,
    messageSoundId: next.messageSoundId == null
      ? normalizeMessageSoundId(current.messageSoundId)
      : normalizeMessageSoundId(next.messageSoundId),
    tokenless: next.tokenless == null ? current.tokenless === true : next.tokenless === true,
    debugMode: normalizeDebugMode(nextDebugMode),
  };
  if (!merged.wsUrl) delete merged.wsUrl;
  if (!merged.token) delete merged.token;
  if (!merged.tokenless) delete merged.tokenless;
  if (!merged.debugMode) delete merged.debugMode;
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: merged.launchAtLogin === true,
      openAsHidden: merged.showMainOnLaunch === false,
    });
  }
  openClawConfigCache = null;
  return merged;
}

function applyRuntimeDebugMode(mode, { persist = false } = {}) {
  const normalized = normalizeDebugMode(mode);
  if (ENV_DEBUG_MODE) {
    runtimeDebugMode = ENV_DEBUG_MODE;
    return { ok: true, mode: runtimeDebugMode, source: 'env' };
  }
  runtimeDebugMode = normalized;
  if (persist) {
    saveShellSettings({ debugMode: normalized });
  }
  return { ok: true, mode: runtimeDebugMode, source: 'settings' };
}

function initRuntimeDebugMode() {
  if (ENV_DEBUG_MODE) {
    runtimeDebugMode = ENV_DEBUG_MODE;
    return;
  }
  const shell = loadShellSettings();
  runtimeDebugMode = normalizeDebugMode(shell.debugMode);
}

function resolveGatewayConfigSource(shell = loadShellSettings()) {
  const tokenless = shell.tokenless === true;
  if (process.env.OPENCLAW_GATEWAY_URL || (!tokenless && process.env.OPENCLAW_GATEWAY_TOKEN)) {
    return 'environment';
  }
  if (shell.wsUrl || shell.token || tokenless) return 'shell';
  return 'unset';
}

function loadOpenClawConfig() {
  const shell = loadShellSettings();
  const tokenless = shell.tokenless === true;
  const cacheKey = `${shell.wsUrl || ''}\0${shell.token || ''}\0${tokenless ? '1' : '0'}`;
  if (openClawConfigCache && openClawConfigCache.__cacheKey === cacheKey) {
    return openClawConfigCache;
  }
  const wsUrl = (process.env.OPENCLAW_GATEWAY_URL || shell.wsUrl || '').trim().replace(/\/$/, '');
  const token = tokenless ? undefined : (process.env.OPENCLAW_GATEWAY_TOKEN || shell.token);
  openClawConfigCache = {
    token,
    wsUrl,
    tokenless,
    source: resolveGatewayConfigSource(shell),
    __cacheKey: cacheKey,
  };
  return openClawConfigCache;
}

function getSettingsSnapshot() {
  const shell = loadShellSettings();
  const effective = loadOpenClawConfig();
  return {
    wsUrl: shell.wsUrl || '',
    tokenSet: Boolean(shell.token || process.env.OPENCLAW_GATEWAY_TOKEN),
    tokenless: shell.tokenless === true,
    source: effective.source,
    shellSettingsPath: SETTINGS_PATH,
    launchAtLogin: shell.launchAtLogin === true,
    showMainOnLaunch: shell.showMainOnLaunch !== false,
    messageSoundEnabled: shell.messageSoundEnabled === true,
    messageSoundId: normalizeMessageSoundId(shell.messageSoundId),
    debugMode: getRuntimeDebugMode(),
    debugModeSource: ENV_DEBUG_MODE ? 'env' : 'settings',
    envOverrides: Boolean(
      process.env.OPENCLAW_GATEWAY_URL
      || (!shell.tokenless && process.env.OPENCLAW_GATEWAY_TOKEN),
    ),
  };
}

async function testGatewaySettings({ wsUrl, token, tokenless }) {
  const url = (wsUrl || '').trim().replace(/\/$/, '');
  if (!url) {
    return { ok: false, error: 'Gateway地址错误' };
  }
  const skipToken = tokenless === true;
  const shell = loadShellSettings();
  const authToken = skipToken
    ? ''
    : (token || process.env.OPENCLAW_GATEWAY_TOKEN || shell.token);
  if (!skipToken && !authToken) {
    return { ok: false, error: 'Gateway可访问，但Token错误' };
  }
  const client = new GatewayWsClient({
    url,
    token: skipToken ? undefined : authToken,
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
  showMainWindow();
  safeSendTo(mainWindow.webContents, 'openclaw:open-settings');
}

function setMainWindowAuxModalDim(active) {
  if (active) auxiliaryModalRefCount += 1;
  else auxiliaryModalRefCount = Math.max(0, auxiliaryModalRefCount - 1);
  const on = auxiliaryModalRefCount > 0;
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeSendTo(mainWindow.webContents, 'openclaw:aux-modal-dim', { active: on });
  }
}

function centerAuxiliaryWindowOnParent(child, parent) {
  if (!child || child.isDestroyed() || !parent || parent.isDestroyed()) return;
  const pb = parent.getBounds();
  const [cw, ch] = child.getSize();
  child.setPosition(
    Math.round(pb.x + (pb.width - cw) / 2),
    Math.round(pb.y + (pb.height - ch) / 2),
  );
}

function createAuxiliaryModalWindow(options) {
  showMainWindow();
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const win = new BrowserWindow({
    width: 400,
    height: 560,
    resizable: false,
    closable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1a2421',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'default' } : {}),
    ...options,
    parent: parent || undefined,
    // macOS 下 modal 子窗口会异常（红绿灯不可用）；parent 已保证叠在主窗口之上
    modal: process.platform !== 'darwin' && Boolean(parent),
    closable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      ...(options.webPreferences || {}),
    },
  });
  win.setMenu(null);
  setMainWindowAuxModalDim(true);
  win.once('ready-to-show', () => {
    centerAuxiliaryWindowOnParent(win, parent);
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    setMainWindowAuxModalDim(false);
  });
  return win;
}

function getAuthorizedMeetingHelpWindow(event) {
  if (!meetingHelpWindow || meetingHelpWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== meetingHelpWindow) return null;
  return meetingHelpWindow;
}

function getAuthorizedHistoryWindow(event) {
  if (!historyWindow || historyWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== historyWindow) return null;
  return historyWindow;
}

async function readLocalMessagesFromMainWindow(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key || !mainWindow || mainWindow.isDestroyed()) return [];
  const safeKey = JSON.stringify(key);
  try {
    const messages = await mainWindow.webContents.executeJavaScript(`(() => {
      if (typeof window.qiziExportHistoryArchive === 'function') {
        return window.qiziExportHistoryArchive(${safeKey});
      }
      const STORAGE_PREFIX = 'qizi-shell-messages:';
      const LEGACY_STORAGE_KEY = 'qizi-shell-messages';
      const sessionKey = ${safeKey};
      const storageKey = STORAGE_PREFIX + sessionKey;
      let raw = localStorage.getItem(storageKey);
      if (!raw && sessionKey.endsWith(':main')) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      }
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })()`, true);
    if (Array.isArray(messages) && messages.length > 0) return messages;
  } catch {
    // 主窗口还没把归档放进内存时，直接读磁盘
  }
  return messageArchive.read(key);
}

function closeHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.close();
  }
  historyWindow = null;
  historyWindowContext = null;
}

function loadHistoryWindowState() {
  const fallback = {
    width: HISTORY_DEFAULT_WIDTH,
    height: HISTORY_DEFAULT_HEIGHT,
    x: null,
    y: null,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_STATE_PATH, 'utf8'));
    const width = Math.max(HISTORY_MIN_WIDTH, Math.min(2400, Number(saved.width) || fallback.width));
    const height = Math.max(HISTORY_MIN_HEIGHT, Math.min(1600, Number(saved.height) || fallback.height));
    const x = Number(saved.x);
    const y = Number(saved.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height, x: null, y: null };
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x < area.x + area.width - 80
        && x + width > area.x + 80
        && y < area.y + area.height - 40
        && y + 48 > area.y;
    });
    if (!visible) return { width, height, x: null, y: null };
    return { width, height, x, y };
  } catch {
    return fallback;
  }
}

function saveHistoryWindowState() {
  if (!historyWindow || historyWindow.isDestroyed()) return;
  try {
    const bounds = historyWindow.getBounds();
    fs.writeFileSync(HISTORY_STATE_PATH, JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }));
  } catch {
    // non-fatal
  }
}

function openHistoryWindow(context) {
  historyWindowContext = context || {};
  const title = `${historyWindowContext.agentLabel || 'Agent'} · 历史消息`;

  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.setTitle(title);
    safeSendTo(historyWindow.webContents, 'openclaw:history:refresh', historyWindowContext);
    historyWindow.show();
    historyWindow.focus();
    return;
  }

  const state = loadHistoryWindowState();
  const options = {
    width: state.width,
    height: state.height,
    minWidth: HISTORY_MIN_WIDTH,
    minHeight: HISTORY_MIN_HEIGHT,
    title,
    backgroundColor: '#eceff1',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'history-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (state.x != null && state.y != null) {
    options.x = state.x;
    options.y = state.y;
  }
  const mainRef = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  historyWindow = new BrowserWindow(options);
  historyWindow.setMenu(null);
  historyWindow.on('resize', saveHistoryWindowState);
  historyWindow.on('move', saveHistoryWindowState);
  historyWindow.on('close', saveHistoryWindowState);
  historyWindow.once('ready-to-show', () => {
    if (state.x == null && mainRef && !mainRef.isDestroyed()) {
      centerAuxiliaryWindowOnParent(historyWindow, mainRef);
    }
    historyWindow.show();
    historyWindow.focus();
  });
  historyWindow.loadFile(path.join(__dirname, 'history.html'));
  historyWindow.on('closed', () => {
    historyWindow = null;
    historyWindowContext = null;
  });
}

function loadCopyEditWindowState() {
  const fallback = {
    width: COPY_EDIT_DEFAULT_WIDTH,
    height: COPY_EDIT_DEFAULT_HEIGHT,
    x: null,
    y: null,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(COPY_EDIT_STATE_PATH, 'utf8'));
    const width = Math.max(COPY_EDIT_MIN_WIDTH, Math.min(2400, Number(saved.width) || fallback.width));
    const height = Math.max(COPY_EDIT_MIN_HEIGHT, Math.min(1600, Number(saved.height) || fallback.height));
    const x = Number(saved.x);
    const y = Number(saved.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height, x: null, y: null };
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x < area.x + area.width - 80
        && x + width > area.x + 80
        && y < area.y + area.height - 40
        && y + 48 > area.y;
    });
    if (!visible) return { width, height, x: null, y: null };
    return { width, height, x, y };
  } catch {
    return fallback;
  }
}

function saveCopyEditWindowState() {
  if (!copyEditWindow || copyEditWindow.isDestroyed()) return;
  try {
    const bounds = copyEditWindow.getBounds();
    fs.writeFileSync(COPY_EDIT_STATE_PATH, JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }));
  } catch {
    // non-fatal
  }
}

function sanitizeCopyEditPayload(payload, extra) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const text = typeof source.text === 'string' ? source.text : '';
  if (!text.trim() || text.length > COPY_EDIT_MAX_CHARS) return null;
  const sessionSource = extra && typeof extra.sessionKey === 'string' ? extra.sessionKey : source.sessionKey;
  const labelSource = extra && typeof extra.agentLabel === 'string' ? extra.agentLabel : source.agentLabel;
  return {
    text,
    sessionKey: typeof sessionSource === 'string' ? sessionSource.slice(0, 300) : '',
    agentLabel: typeof labelSource === 'string' ? labelSource.trim().slice(0, 80) : '',
  };
}

let copyEditDraftsCache = null;

function loadCopyEditDrafts() {
  if (copyEditDraftsCache) return copyEditDraftsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(COPY_EDIT_DRAFTS_PATH, 'utf8'));
    copyEditDraftsCache = Array.isArray(parsed) ? parsed.filter((draft) => draft && typeof draft.id === 'string') : [];
  } catch {
    copyEditDraftsCache = [];
  }
  return copyEditDraftsCache;
}

function writeCopyEditDrafts(drafts) {
  copyEditDraftsCache = drafts;
  try {
    fs.writeFileSync(COPY_EDIT_DRAFTS_PATH, JSON.stringify(drafts));
  } catch (err) {
    console.warn('[qizi] save copy-edit drafts failed:', err.message);
  }
  sendToMainRenderer('copy-edit:drafts-changed', copyEditDraftSummaries());
}

function copyEditDraftSummaries() {
  return loadCopyEditDrafts().map((draft) => ({
    id: draft.id,
    sessionKey: draft.sessionKey,
    savedAt: draft.savedAt,
    preview: draft.preview,
  }));
}

function sanitizeCopyEditDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const originalText = typeof raw.originalText === 'string' ? raw.originalText : '';
  const baseText = typeof raw.baseText === 'string' ? raw.baseText : '';
  if (originalText.length > COPY_EDIT_MAX_CHARS || baseText.length > COPY_EDIT_MAX_CHARS) return null;
  if (!Array.isArray(raw.patches) || raw.patches.length > COPY_EDIT_MAX_PATCHES) return null;
  let patches;
  try {
    const encoded = JSON.stringify(raw.patches);
    if (encoded.length > COPY_EDIT_MAX_CHARS * 2) return null;
    patches = JSON.parse(encoded);
  } catch {
    return null;
  }
  const id = typeof raw.id === 'string' && /^draft_[a-z0-9]{1,40}$/.test(raw.id)
    ? raw.id
    : `draft_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey.slice(0, 300) : '',
    agentLabel: typeof raw.agentLabel === 'string' ? raw.agentLabel.trim().slice(0, 80) : '',
    originalText,
    baseText,
    patches,
    preview: typeof raw.preview === 'string' ? raw.preview.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    savedAt: Date.now(),
  };
}

function removeCopyEditDraft(id) {
  if (!id) return false;
  const drafts = loadCopyEditDrafts();
  const next = drafts.filter((draft) => draft.id !== id);
  if (next.length === drafts.length) return false;
  writeCopyEditDrafts(next);
  return true;
}

function closeCopyEditWindowSoon() {
  setTimeout(() => {
    if (copyEditWindow && !copyEditWindow.isDestroyed()) copyEditWindow.close();
  }, 0);
}

function getAuthorizedCopyEditWindow(event) {
  if (!copyEditWindow || copyEditWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== copyEditWindow) return null;
  return copyEditWindow;
}

function openCopyEditWindow(payload) {
  copyEditPayload = payload;
  const title = payload.agentLabel ? `文案编辑 · ${payload.agentLabel}` : '文案编辑';
  if (copyEditWindow && !copyEditWindow.isDestroyed()) {
    copyEditWindow.setTitle(title);
    safeSendTo(copyEditWindow.webContents, 'copy-edit:load', copyEditPayload);
    copyEditWindow.show();
    copyEditWindow.focus();
    return { ok: true };
  }

  const state = loadCopyEditWindowState();
  const options = {
    width: state.width,
    height: state.height,
    minWidth: COPY_EDIT_MIN_WIDTH,
    minHeight: COPY_EDIT_MIN_HEIGHT,
    title,
    backgroundColor: '#f2f2f2',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'copy-edit-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (state.x != null && state.y != null) {
    options.x = state.x;
    options.y = state.y;
  }
  const mainRef = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  copyEditWindow = new BrowserWindow(options);
  copyEditWindow.setMenu(null);
  copyEditWindow.on('resize', saveCopyEditWindowState);
  copyEditWindow.on('move', saveCopyEditWindowState);
  copyEditWindow.on('close', saveCopyEditWindowState);
  copyEditWindow.once('ready-to-show', () => {
    if (state.x == null && mainRef && !mainRef.isDestroyed()) {
      centerAuxiliaryWindowOnParent(copyEditWindow, mainRef);
    }
    copyEditWindow.show();
    copyEditWindow.focus();
  });
  copyEditWindow.loadFile(path.join(__dirname, 'copy-edit.html'));
  copyEditWindow.on('closed', () => {
    copyEditWindow = null;
  });
  return { ok: true };
}

const AGENT_FILES_MIN_HEIGHT = 560;
const AGENT_FILES_EDITOR_MIN = 320;

let agentFilesEditorOpen = false;
let agentFilesPreviewWidth = 0;
let agentFilesPreviewX = 0;
let agentFilesWidthTimer = null;
let agentFilesAnimateToken = 0;
let agentFilesAnimateResolve = null;
let agentFilesAdjusting = false;

function agentFilesWorkArea(bounds) {
  const anchor = bounds
    || (agentFilesWindow && !agentFilesWindow.isDestroyed() ? agentFilesWindow.getBounds() : null)
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null);
  const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
  return display.workArea;
}

function agentFilesHalfScreenBounds() {
  const area = agentFilesWorkArea();
  return {
    x: area.x,
    y: area.y,
    width: Math.max(1, Math.round(area.width / 2)),
    height: Math.max(AGENT_FILES_MIN_HEIGHT, area.height),
  };
}

function applyAgentFilesSizeLimits() {
  if (!agentFilesWindow || agentFilesWindow.isDestroyed() || agentFilesAdjusting) return;
  const area = agentFilesWorkArea();
  const half = Math.max(1, Math.round(area.width / 2));
  const maxHeight = Math.max(AGENT_FILES_MIN_HEIGHT, area.height);
  const minWidth = agentFilesEditorOpen
    ? Math.min(area.width, Math.max(320, (agentFilesPreviewWidth || half) + AGENT_FILES_EDITOR_MIN))
    : Math.min(640, half);
  const maxWidth = agentFilesEditorOpen ? area.width : half;
  agentFilesAdjusting = true;
  try {
    // 先把两边都放松，避免最小宽度大于最大宽度时窗口被撑飞。
    agentFilesWindow.setMinimumSize(200, 200);
    agentFilesWindow.setMaximumSize(area.width, maxHeight);
    agentFilesWindow.setMinimumSize(Math.min(minWidth, maxWidth), AGENT_FILES_MIN_HEIGHT);
    agentFilesWindow.setMaximumSize(Math.max(minWidth, maxWidth), maxHeight);
  } finally {
    agentFilesAdjusting = false;
  }
}

function clampAgentFilesWindow() {
  if (!agentFilesWindow || agentFilesWindow.isDestroyed() || agentFilesAdjusting) return;
  const area = agentFilesWorkArea();
  const bounds = agentFilesWindow.getBounds();
  const width = Math.min(Math.max(bounds.width, 480), area.width);
  const height = Math.min(Math.max(bounds.height, AGENT_FILES_MIN_HEIGHT), area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) return;
  agentFilesAdjusting = true;
  try {
    agentFilesWindow.setBounds({ x, y, width, height });
  } finally {
    agentFilesAdjusting = false;
  }
}

function stopAgentFilesAnimation() {
  agentFilesAnimateToken += 1;
  if (agentFilesWidthTimer) {
    clearTimeout(agentFilesWidthTimer);
    agentFilesWidthTimer = null;
  }
  const resolve = agentFilesAnimateResolve;
  agentFilesAnimateResolve = null;
  if (resolve) resolve(false);
}

function animateAgentFilesBounds(target) {
  if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return Promise.resolve(false);
  if (agentFilesWidthTimer) {
    clearTimeout(agentFilesWidthTimer);
    agentFilesWidthTimer = null;
  }
  const token = ++agentFilesAnimateToken;
  const previous = agentFilesAnimateResolve;
  const start = agentFilesWindow.getBounds();
  const fromX = start.x;
  const fromWidth = start.width;
  const began = Date.now();
  const duration = 220;
  return new Promise((resolve) => {
    agentFilesAnimateResolve = resolve;
    if (previous) previous(false);
    const step = () => {
      if (token !== agentFilesAnimateToken) return;
      if (!agentFilesWindow || agentFilesWindow.isDestroyed()) {
        agentFilesWidthTimer = null;
        agentFilesAnimateResolve = null;
        resolve(false);
        return;
      }
      const t = Math.min(1, (Date.now() - began) / duration);
      const eased = 1 - ((1 - t) ** 3);
      const current = agentFilesWindow.getBounds();
      agentFilesAdjusting = true;
      try {
        agentFilesWindow.setBounds({
          x: Math.round(fromX + (target.x - fromX) * eased),
          y: current.y,
          width: Math.max(1, Math.round(fromWidth + (target.width - fromWidth) * eased)),
          height: current.height,
        });
      } finally {
        agentFilesAdjusting = false;
      }
      if (t < 1) {
        agentFilesWidthTimer = setTimeout(step, 16);
        return;
      }
      agentFilesWidthTimer = null;
      agentFilesAnimateResolve = null;
      resolve(true);
    };
    step();
  });
}

function resetAgentFilesWindowBounds() {
  stopAgentFilesAnimation();
  agentFilesEditorOpen = false;
  agentFilesPreviewWidth = 0;
  agentFilesPreviewX = 0;
  const bounds = agentFilesHalfScreenBounds();
  applyAgentFilesSizeLimits();
  if (agentFilesWindow && !agentFilesWindow.isDestroyed()) agentFilesWindow.setBounds(bounds);
  return bounds;
}

async function setAgentFilesEditorPane(open) {
  if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return { ok: false };
  const current = agentFilesWindow.getBounds();
  const area = agentFilesWorkArea(current);
  const maxHeight = Math.max(AGENT_FILES_MIN_HEIGHT, area.height);
  if (open) {
    if (!agentFilesEditorOpen || !agentFilesPreviewWidth) {
      agentFilesPreviewWidth = current.width;
      agentFilesPreviewX = current.x;
    }
    agentFilesEditorOpen = true;
    agentFilesAdjusting = true;
    try {
      agentFilesWindow.setMinimumSize(200, 200);
      agentFilesWindow.setMaximumSize(area.width, maxHeight);
    } finally {
      agentFilesAdjusting = false;
    }
    const previewWidth = agentFilesPreviewWidth || current.width;
    const right = area.x + area.width;
    let width = area.width;
    let x = current.x;
    if (previewWidth + AGENT_FILES_EDITOR_MIN > width) {
      width = Math.min(area.width, previewWidth + AGENT_FILES_EDITOR_MIN);
    }
    if (x + width > right) x = Math.max(area.x, right - width);
    if (Math.abs(width - current.width) < 2 && Math.abs(x - current.x) < 2) {
      applyAgentFilesSizeLimits();
      return { ok: true };
    }
    const finished = await animateAgentFilesBounds({ x, width });
    if (!finished) return { ok: true };
    applyAgentFilesSizeLimits();
    return { ok: true };
  }
  if (!agentFilesEditorOpen && !agentFilesPreviewWidth) return { ok: true };
  agentFilesEditorOpen = false;
  const half = Math.max(1, Math.round(area.width / 2));
  agentFilesWindow.setMinimumSize(Math.min(640, half), AGENT_FILES_MIN_HEIGHT);
  const width = agentFilesPreviewWidth || half;
  const x = Number.isFinite(agentFilesPreviewX) ? agentFilesPreviewX : current.x;
  const finished = await animateAgentFilesBounds({ x, width });
  if (agentFilesEditorOpen) return { ok: true };
  agentFilesPreviewWidth = 0;
  agentFilesPreviewX = 0;
  if (!finished) return { ok: true };
  applyAgentFilesSizeLimits();
  return { ok: true };
}

function getAuthorizedAgentFilesWindow(event) {
  if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== agentFilesWindow) return null;
  return agentFilesWindow;
}

function requestAgentFilesSave(win) {
  return new Promise((resolve) => {
    if (agentFilesSaveWait) agentFilesSaveWait(false);
    const timer = setTimeout(() => {
      if (agentFilesSaveWait !== finish) return;
      agentFilesSaveWait = null;
      resolve(false);
    }, 20000);
    const finish = (ok) => {
      clearTimeout(timer);
      resolve(ok === true);
    };
    agentFilesSaveWait = finish;
    win.webContents.send('agent-files:request-save');
  });
}

async function confirmAgentFilesClose(win) {
  if (!win || win.isDestroyed() || agentFilesClosing || agentFilesClosePrompt) return;
  if (!agentFilesDirty) {
    agentFilesClosing = true;
    win.close();
    return;
  }
  agentFilesClosePrompt = true;
  try {
    win.show();
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: '这些修改还没保存。',
      detail: '要保存后再关闭吗？',
    });
    if (win.isDestroyed() || response === 2) return;
    if (response === 0) {
      const saved = await requestAgentFilesSave(win);
      if (!saved || win.isDestroyed()) return;
    }
    agentFilesDirty = false;
    agentFilesClosing = true;
    win.close();
  } catch {
    agentFilesDirty = false;
    agentFilesClosing = true;
    if (!win.isDestroyed()) win.destroy();
  } finally {
    agentFilesClosePrompt = false;
  }
}

function openAgentFilesWindow(payload) {
  const agentId = String(payload?.agentId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return { ok: false, error: '未指定 Agent' };
  const agentLabel = String(payload?.agentLabel || agentId).trim().slice(0, 80) || agentId;
  agentFilesContext = { agentId, agentLabel };
  const title = `${agentLabel} · 头脑与技能`;
  if (agentFilesWindow && !agentFilesWindow.isDestroyed()) {
    agentFilesWindow.setTitle(title);
    resetAgentFilesWindowBounds();
    safeSendTo(agentFilesWindow.webContents, 'agent-files:reload');
    agentFilesWindow.show();
    agentFilesWindow.focus();
    return { ok: true };
  }
  const bounds = agentFilesHalfScreenBounds();
  const options = {
    ...bounds,
    minWidth: Math.min(640, bounds.width),
    minHeight: AGENT_FILES_MIN_HEIGHT,
    maxWidth: bounds.width,
    maxHeight: bounds.height,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title,
    backgroundColor: '#f2f2f2',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'agent-files-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  agentFilesWindow = new BrowserWindow(options);
  agentFilesWindow.setMenu(null);
  agentFilesEditorOpen = false;
  agentFilesPreviewWidth = 0;
  agentFilesPreviewX = 0;
  agentFilesDirty = false;
  agentFilesClosing = false;
  applyAgentFilesSizeLimits();
  agentFilesWindow.on('move', () => {
    if (agentFilesWidthTimer || agentFilesAdjusting) return;
    applyAgentFilesSizeLimits();
  });
  agentFilesWindow.once('ready-to-show', () => {
    if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return;
    clampAgentFilesWindow();
    agentFilesWindow.show();
    agentFilesWindow.focus();
  });
  agentFilesWindow.webContents.on('render-process-gone', () => {
    agentFilesDirty = false;
    agentFilesClosePrompt = false;
    if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return;
    agentFilesWindow.webContents.reload();
  });
  agentFilesWindow.loadFile(path.join(__dirname, 'agent-files.html'));
  agentFilesWindow.on('close', (event) => {
    if (!agentFilesWindow || agentFilesWindow.isDestroyed()) return;
    if (agentFilesClosing || !agentFilesDirty) return;
    if (agentFilesClosePrompt) {
      agentFilesDirty = false;
      agentFilesClosing = true;
      agentFilesWindow.destroy();
      return;
    }
    event.preventDefault();
    void confirmAgentFilesClose(agentFilesWindow);
  });
  agentFilesWindow.on('closed', () => {
    agentFilesWindow = null;
    agentFilesClosing = false;
    agentFilesDirty = false;
    agentFilesEditorOpen = false;
    agentFilesPreviewWidth = 0;
    agentFilesPreviewX = 0;
    if (agentFilesSaveWait) {
      const wait = agentFilesSaveWait;
      agentFilesSaveWait = null;
      wait(false);
    }
  });
  return { ok: true };
}

async function agentFilesGateway() {
  const client = ensureGateway();
  await client.waitForConnect();
  return (method, params) => client.request(method, params);
}

function openMeetingHelp() {
  if (meetingHelpWindow && !meetingHelpWindow.isDestroyed()) {
    showMainWindow();
    meetingHelpWindow.focus();
    return;
  }
  meetingHelpWindow = createAuxiliaryModalWindow({
    width: 680,
    height: 780,
    minWidth: 460,
    minHeight: 520,
    resizable: true,
    maximizable: true,
    title: '会议模式配置',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'meeting-help-preload.js'),
    },
  });
  meetingHelpWindow.loadFile(path.join(__dirname, 'meeting-help.html'));
  meetingHelpWindow.on('closed', () => {
    meetingHelpWindow = null;
  });
}

function openAbout() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    showMainWindow();
    aboutWindow.focus();
    return;
  }
  const { version } = require('./package.json');
  aboutWindow = createAuxiliaryModalWindow({
    width: 360,
    height: 440,
    title: 'About QiziShell',
  });
  aboutWindow.loadFile(path.join(__dirname, 'about.html'), {
    query: { version },
  });
  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
}

function getAuthorizedUpdateWindow(event) {
  if (!updateWindow || updateWindow.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== updateWindow) return null;
  return updateWindow;
}

function openUpdate() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    showMainWindow();
    updateWindow.focus();
    safeSendTo(updateWindow.webContents, 'qizi-update:recheck');
    return;
  }
  const { version } = require('./package.json');
  updateWindow = createAuxiliaryModalWindow({
    width: 400,
    height: 580,
    title: 'Update QiziShell',
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
    },
  });
  updateWindow.loadFile(path.join(__dirname, 'update.html'), {
    query: { version },
  });
  updateWindow.on('closed', () => {
    updateWindow = null;
    pendingUpdateInfo = null;
  });
}

function gatewayWsUrlToControlHttpUrl(wsUrl) {
  const trimmed = String(wsUrl || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'wss:') {
      return `https://${parsed.host}/`;
    }
    if (parsed.protocol === 'ws:') {
      return `http://${parsed.host}/`;
    }
    return null;
  } catch {
    return null;
  }
}

function buildOpenClawControlLaunchUrl(wsUrl, token) {
  const httpBase = gatewayWsUrlToControlHttpUrl(wsUrl);
  const trimmedWs = String(wsUrl || '').trim();
  const trimmedToken = String(token || '').trim();
  if (!httpBase || !trimmedWs) return null;
  try {
    const url = new URL(httpBase);
    url.searchParams.set('gatewayUrl', trimmedWs);
    if (trimmedToken) {
      const hash = new URLSearchParams();
      hash.set('token', trimmedToken);
      url.hash = hash.toString();
    }
    return url.toString();
  } catch {
    return null;
  }
}

function attachGatewayTlsSessionPolicy(session) {
  session.setCertificateVerifyProc((request, callback) => {
    if (shouldAllowInsecureTls(request.hostname)) {
      callback(0);
      return;
    }
    callback(-2);
  });
}

function openOpenClawControl() {
  const { wsUrl, token, tokenless } = loadOpenClawConfig();
  if (!wsUrl) {
    return { ok: false, error: '未配置 Gateway 地址，请先在设置中填写 WSS/WS 地址' };
  }
  if (!tokenless && !token) {
    return { ok: false, error: '未配置 Gateway Token，请先在设置中填写' };
  }
  const controlUrl = buildOpenClawControlLaunchUrl(wsUrl, tokenless ? '' : token);
  if (!controlUrl) {
    return { ok: false, error: 'Gateway 地址格式无效' };
  }

  if (controlUiWindow && !controlUiWindow.isDestroyed()) {
    controlUiWindow.focus();
    if (controlUiLaunchUrl !== controlUrl) {
      controlUiLaunchUrl = controlUrl;
      void controlUiWindow.loadURL(controlUrl);
    }
    return { ok: true, url: gatewayWsUrlToControlHttpUrl(wsUrl) };
  }

  controlUiLaunchUrl = controlUrl;
  controlUiWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenClaw Control',
    backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: Boolean(process.env.QIZI_DEVTOOLS_PORT),
    },
  });
  attachGatewayTlsSessionPolicy(controlUiWindow.webContents.session);
  controlUiWindow.setMenu(null);
  controlUiWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalHttpUrl(url)) {
      openExternal(url);
    }
    return { action: 'deny' };
  });
  controlUiWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = controlUiWindow.webContents.getURL();
    if (!url || url === currentUrl) return;
    try {
      const target = new URL(url);
      const current = new URL(currentUrl);
      if (target.origin !== current.origin) {
        event.preventDefault();
        if (isSafeExternalHttpUrl(url)) {
          openExternal(url);
        }
      }
    } catch {
      event.preventDefault();
    }
  });
  void controlUiWindow.loadURL(controlUrl);
  controlUiWindow.on('closed', () => {
    controlUiWindow = null;
    controlUiLaunchUrl = null;
  });
  return { ok: true, url: gatewayWsUrlToControlHttpUrl(wsUrl) };
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
  if (/DNS lookup.*provider endpoint/i.test(message)) {
    return [
      'Gateway 调用 LLM 失败：无法解析模型服务商 API 域名（DNS）。',
      '这发生在 OpenClaw Gateway 主机上，不是 QiziShell 会议逻辑问题。',
      '请检查：① Gateway 主机能否上网；② OpenClaw 模型 provider 的 baseURL/代理是否正确；③ 私聊发一条消息是否同样报错。',
    ].join('');
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

function sendToMainRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return safeSendTo(mainWindow.webContents, channel, payload);
  }
  return false;
}

function sendStreamDeltaToRenderer(run, clientRunId, text, replace = false) {
  const payload = {
    runId: clientRunId,
    sessionKey: run?.sessionKey || getSessionKey(),
    delta: text,
    replace: replace === true,
  };
  debugEvent('stream', 'delta_emit', {
    runId: clientRunId,
    replace: replace === true,
    deltaLength: String(text || '').length,
  });
  sendToMainRenderer('openclaw:delta', payload);
  if (run?.sender) {
    safeSendTo(run.sender, 'openclaw:delta', payload);
  }
}

function sendStreamDoneToRenderer(run, clientRunId, payload) {
  const fullPayload = {
    runId: clientRunId,
    sessionKey: run?.sessionKey || getSessionKey(),
    gatewayRunId: run?.gatewayRunId || '',
    ...payload,
  };
  debugEvent('stream', 'done_emit', {
    runId: clientRunId,
    textLength: String(payload?.text || '').length,
    aborted: payload?.aborted === true,
  });
  sendToMainRenderer('openclaw:done', fullPayload);
  if (run?.sender) {
    safeSendTo(run.sender, 'openclaw:done', fullPayload);
  }
}

function sendStreamErrorToRenderer(run, clientRunId, error) {
  const payload = {
    runId: clientRunId,
    sessionKey: run?.sessionKey || getSessionKey(),
    error,
  };
  debugEvent('stream', 'error_emit', { runId: clientRunId, error: String(error || '') });
  sendToMainRenderer('openclaw:error', payload);
  if (run?.sender) {
    safeSendTo(run.sender, 'openclaw:error', payload);
  }
}

function sendChatSegmentToRenderer(run, clientRunId, text) {
  const payload = {
    runId: clientRunId,
    sessionKey: run?.sessionKey || getSessionKey(),
    text,
  };
  sendToMainRenderer('openclaw:chat-segment', payload);
  if (run?.sender) {
    safeSendTo(run.sender, 'openclaw:chat-segment', payload);
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

function isVisibleAssistantTextBlock(block) {
  if (!block || typeof block !== 'object') return true;
  if (block.type !== 'text') return false;
  const phase = block.textSignature?.phase ?? block.phase;
  if (!phase) return true;
  const p = String(phase).toLowerCase();
  return p !== 'commentary' && p !== 'thinking' && p !== 'reasoning';
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
        if (isVisibleAssistantTextBlock(block)) textParts.push(block.text);
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

function normalizeHistoryRole(role) {
  if (typeof role !== 'string') return '';
  return role.trim().toLowerCase().replace(/-/g, '_');
}

function isToolHistoryRole(role) {
  const flat = normalizeHistoryRole(role).replace(/_/g, '');
  return flat === 'tool' || flat === 'toolresult' || flat === 'function';
}

function isToolHistoryMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = normalizeHistoryRole(message.role ?? message.who);
  if (isToolHistoryRole(role)) return true;
  if (role === 'user' || role === 'assistant' || role === 'me' || role === 'them') {
    return false;
  }
  if (message.toolCallId || message.tool_call_id) return true;
  if (message.toolName || message.tool_name) return true;
  return false;
}

function looksLikeLeakedToolPayloadText(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 40) return false;
  if (raw.includes('<<<EXTERNAL_UNTRUSTED_CONTENT')) return true;
  if (!raw.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const ext = parsed.externalContent;
    if (ext && typeof ext === 'object') {
      const source = ext.source;
      if (source === 'web_search' || source === 'web_fetch') return true;
    }
    if ('query' in parsed && Array.isArray(parsed.results) && ('provider' in parsed || 'tookMs' in parsed)) {
      return true;
    }
    if ('url' in parsed && 'fetchedAt' in parsed && ('extractMode' in parsed || typeof parsed.text === 'string')) {
      return true;
    }
  } catch {
    // not JSON tool payload
  }
  return false;
}

const EXEC_COMPLETION_NOTICE_RE = /^exec (completed|failed) \([a-z0-9_-]{1,64},\s*(?:code -?\d+|signal [^)]+)\)/i;

function isExecCompletionNoticeText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const visible = stripLeadingEnvelopeTimestamp(stripSenderUntrustedMetadata(raw)).trim();
  return EXEC_COMPLETION_NOTICE_RE.test(visible) || EXEC_COMPLETION_NOTICE_RE.test(raw);
}

function shouldHideHistoryMessage(message) {
  if (isToolHistoryMessage(message)) return true;
  if (isExecCompletionNoticeText(extractMessageText(message))) return true;
  const role = normalizeHistoryRole(message?.role ?? message?.who);
  if (role === 'assistant' || role === 'them' || !role) {
    return looksLikeLeakedToolPayloadText(extractMessageText(message));
  }
  return false;
}

function convertHistoryMessages(serverMessages) {
  if (!Array.isArray(serverMessages)) return [];
  return serverMessages
    .filter((m) => !shouldHideHistoryMessage(m))
    .map((m) => {
      const role = m?.role || m?.who;
      const { text, images } = extractMessageParts(m);
      const files = extractOpenClawFileMeta(m);
      let resolvedText = text;
      if (role === 'user') {
        resolvedText = stripLeadingEnvelopeTimestamp(stripSenderUntrustedMetadata(resolvedText));
      }
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

function lookupMeetingAgentLabel(agentId, meta) {
  if (!agentId) return 'Agent';
  if (agentId === meta?.moderatorAgentId) {
    return meta?.moderatorLabel || agentId;
  }
  const catalog = meta?.agentCatalog;
  if (Array.isArray(catalog)) {
    const found = catalog.find((a) => a.id === agentId);
    if (found?.label || found?.name) return found.label || found.name;
  }
  return agentId;
}

function extractHistoryAgentId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.agentId,
    raw.senderAgentId,
    raw.meta?.agentId,
    raw.meta?.senderAgentId,
    raw.sender?.agentId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractHistoryLabel(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const label = raw.label || raw.senderLabel || raw.meta?.label;
  return typeof label === 'string' ? label.trim() : '';
}

function resolveInjectedSpeaker(label, meta) {
  const participantIds = new Set(meta?.participantAgentIds || []);
  const idMatch = label.match(/\(@([a-zA-Z0-9_-]+)\)/);
  if (idMatch && participantIds.has(idMatch[1])) {
    return {
      agentId: idMatch[1],
      label: lookupMeetingAgentLabel(idMatch[1], meta),
    };
  }
  const prefix = label.split('(')[0].trim();
  if (prefix) {
    const catalog = meta?.agentCatalog;
    if (Array.isArray(catalog)) {
      const found = catalog.find((a) => a.label === prefix || a.name === prefix);
      if (found && participantIds.has(found.id)) {
        return { agentId: found.id, label: found.label || found.name || found.id };
      }
    }
  }
  return null;
}

function convertMeetingHistoryMessages(serverMessages, meta) {
  if (!Array.isArray(serverMessages)) return [];
  const moderatorId = meta?.moderatorAgentId;
  const participantIds = new Set(meta?.participantAgentIds || []);
  let briefingSeen = false;

  return serverMessages
    .filter((m) => !shouldHideHistoryMessage(m))
    .map((raw) => {
      const role = normalizeHistoryRole(raw?.role ?? raw?.who);
      const { text, images } = extractMessageParts(raw);
      const files = extractOpenClawFileMeta(raw);
      let resolvedText = text;
      if (!resolvedText && raw?.errorMessage) {
        resolvedText = `[错误] ${raw.errorMessage}`;
      }
      if (!resolvedText && images.length === 0 && files.length === 0) return null;

      const injectLabel = extractHistoryLabel(raw);
      const injectedSpeaker = injectLabel ? resolveInjectedSpeaker(injectLabel, meta) : null;
      const agentId = injectedSpeaker?.agentId || extractHistoryAgentId(raw);
      let who = 'them';
      let speakerAgentId = agentId;
      let speakerLabel = injectedSpeaker?.label || lookupMeetingAgentLabel(agentId, meta);

      if (role === 'user') {
        if (resolvedText.startsWith('[系统')) return null;
        if (!briefingSeen && resolvedText.includes('【QiziShell 会议模式')) {
          briefingSeen = true;
          who = 'me';
          speakerAgentId = null;
          speakerLabel = '任务书';
        } else if (agentId && agentId !== moderatorId && participantIds.has(agentId)) {
          who = 'them';
          speakerLabel = lookupMeetingAgentLabel(agentId, meta);
        } else if (agentId === moderatorId) {
          who = 'me';
          speakerLabel = lookupMeetingAgentLabel(moderatorId, meta);
        } else {
          who = 'me';
          speakerAgentId = null;
          speakerLabel = '老大';
        }
      } else if (role === 'assistant') {
        if (injectedSpeaker) {
          who = 'them';
          speakerAgentId = injectedSpeaker.agentId;
          speakerLabel = injectedSpeaker.label;
        } else if (agentId && agentId !== moderatorId && participantIds.has(agentId)) {
          who = 'them';
          speakerLabel = lookupMeetingAgentLabel(agentId, meta);
        } else {
          who = 'me';
          speakerAgentId = moderatorId;
          speakerLabel = lookupMeetingAgentLabel(moderatorId, meta);
        }
      }

      const sent = extractMessageSentTimeFromRaw(raw);
      const displayTime = sent.time
        ? sent.time.match(/\d{2}:\d{2}/)?.[0] || sent.time
        : '';

      return {
        who,
        text: resolvedText,
        images: images.length > 0 ? images : undefined,
        files: files.length > 0 ? files : undefined,
        time: displayTime,
        sentTime: sent.time || undefined,
        sentAtMs: sent.sentAtMs ?? undefined,
        streaming: false,
        speakerAgentId: speakerAgentId || undefined,
        speakerLabel,
        meeting: true,
      };
    })
    .filter(Boolean);
}

async function fetchMeetingHistory(sessionKey, meta) {
  const client = ensureGateway();
  await client.waitForConnect();
  const result = await client.request('chat.history', {
    sessionKey,
    limit: 200,
    maxChars: CHAT_HISTORY_TEXT_MAX_CHARS,
  });
  return convertMeetingHistoryMessages(result?.messages || [], meta);
}

function broadcastMeetingHistory(messages) {
  broadcastMeetingEvent({
    type: 'history',
    payload: { messages },
  });
}

function stopMeetingHistoryPoll() {
  if (meetingHistoryPollTimer) {
    clearInterval(meetingHistoryPollTimer);
    meetingHistoryPollTimer = null;
  }
}

function startMeetingHistoryPoll() {
  stopMeetingHistoryPoll();
  if (!activeMeetingSessionKey || !activeMeetingMeta) return;

  const poll = async () => {
    if (!activeMeetingSessionKey || !activeMeetingMeta) return;
    try {
      const messages = await fetchMeetingHistory(activeMeetingSessionKey, activeMeetingMeta);
      broadcastMeetingHistory(messages);
    } catch {
      // ignore background poll errors
    }
  };

  void poll();
  meetingHistoryPollTimer = setInterval(poll, 3000);
  meetingHistoryPollTimer.unref?.();
}

function setActiveMeetingMeta(meta) {
  activeMeetingMeta = meta;
  activeMeetingSessionKey = meta?.sessionKey || null;
}

function clearActiveMeeting() {
  stopMeetingHistoryPoll();
  activeMeetingSessionKey = null;
  activeMeetingMeta = null;
  activeMeetingRelay = null;
  activeMeetingForwardConfig = null;
  activeMeetingTranscript = [];
}

function resolveDeltaText(currentText, payload) {
  const snapshot = payload.message == null ? null : extractMessageText(payload.message);
  if (typeof snapshot === 'string' && looksLikeLeakedToolPayloadText(snapshot)) {
    return currentText;
  }
  if (typeof payload.deltaText === 'string') {
    if (looksLikeLeakedToolPayloadText(payload.deltaText)) {
      return currentText;
    }
    if (payload.replace === true) return payload.deltaText;
    // 首包优先 deltaText：snapshot 可能仍挂着上一轮助手全文
    if (!currentText) {
      if (payload.deltaText) return payload.deltaText;
      return typeof snapshot === 'string' ? snapshot : currentText;
    }
    if (typeof snapshot === 'string') {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (prefixLength === currentText.length && snapshot.slice(0, prefixLength) === currentText) {
        return `${currentText}${payload.deltaText}`;
      }
      if (looksLikeLeakedToolPayloadText(snapshot)) {
        return currentText;
      }
      if (snapshot.startsWith(currentText)) {
        return snapshot;
      }
      return `${currentText}${payload.deltaText}`;
    }
    return `${currentText}${payload.deltaText}`;
  }
  if (typeof snapshot === 'string' && looksLikeLeakedToolPayloadText(snapshot)) {
    return currentText;
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

function bindRunToGatewayRunId(clientRunId, run, gatewayRunId) {
  if (!run || !gatewayRunId) return;
  if (run.gatewayRunId && run.gatewayRunId !== gatewayRunId) {
    gatewayRunIndex.delete(run.gatewayRunId);
  }
  run.gatewayRunId = gatewayRunId;
  gatewayRunIndex.set(gatewayRunId, clientRunId);
}

function pickLatestActiveRun(sessionKey) {
  let latest = null;
  for (const [clientRunId, run] of activeRuns.entries()) {
    if (sessionKey && run.sessionKey && run.sessionKey !== sessionKey) continue;
    if (!latest || Number(run.startedAt || 0) > Number(latest.run.startedAt || 0)) {
      latest = { clientRunId, run };
    }
  }
  return latest;
}

function findOwnedRunForChatPayload(payload) {
  const gatewayRunId = payload?.runId == null ? '' : String(payload.runId);
  if (!gatewayRunId) return null;

  const direct = findClientRunByGatewayRunId(gatewayRunId);
  if (direct) return direct;

  for (const [clientRunId, run] of activeRuns.entries()) {
    if (run.gatewayRunId === gatewayRunId || String(clientRunId) === gatewayRunId) {
      return { clientRunId, run };
    }
  }

  const payloadSessionKey = typeof payload?.sessionKey === 'string' ? payload.sessionKey : '';

  if (activeRuns.size === 1) {
    const [clientRunId, run] = activeRuns.entries().next().value;
    if (!(payloadSessionKey && run.sessionKey && payloadSessionKey !== run.sessionKey)) {
      bindRunToGatewayRunId(clientRunId, run, gatewayRunId);
      debugEvent('stream', 'run_bind_single_active', {
        clientRunId,
        gatewayRunId,
        payloadSessionKey: payloadSessionKey || null,
      });
      return { clientRunId, run };
    }
  }

  // Some gateways emit chat deltas before ack runId mapping settles.
  // If payload belongs to current session, attach it to the newest local run.
  const currentSessionKey = getSessionKey();
  if (!payloadSessionKey || payloadSessionKey === currentSessionKey) {
    const fallback = pickLatestActiveRun(payloadSessionKey || currentSessionKey);
    if (fallback) {
      const { clientRunId, run } = fallback;
      bindRunToGatewayRunId(clientRunId, run, gatewayRunId);
      debugEvent('stream', 'run_bind_session_fallback', {
        clientRunId,
        gatewayRunId,
        payloadSessionKey: payloadSessionKey || null,
        currentSessionKey,
      });
      return fallback;
    }
  }

  return null;
}

function rememberFinishedOwnedGatewayRun(gatewayRunId, sessionKey) {
  const id = gatewayRunId == null ? '' : String(gatewayRunId).trim();
  if (!id) return;
  suppressedOwnedGatewayRuns.set(id, {
    sessionKey: String(sessionKey || getSessionKey()).trim(),
    finishedAt: Date.now(),
  });
}

function shouldSuppressLateOwnedGatewayEvent(payload) {
  const gatewayRunId = payload?.runId == null ? '' : String(payload.runId).trim();
  if (!gatewayRunId) return false;
  const entry = suppressedOwnedGatewayRuns.get(gatewayRunId);
  if (!entry) return false;
  if (Date.now() - entry.finishedAt > SUPPRESS_OWNED_GATEWAY_RUN_MS) {
    suppressedOwnedGatewayRuns.delete(gatewayRunId);
    return false;
  }
  const sessionKey = String(payload?.sessionKey || '').trim() || getSessionKey();
  if (entry.sessionKey && sessionKey && entry.sessionKey !== sessionKey) return false;
  return true;
}

function pruneSuppressedOwnedGatewayRuns() {
  const now = Date.now();
  for (const [id, entry] of suppressedOwnedGatewayRuns.entries()) {
    if (now - entry.finishedAt > SUPPRESS_OWNED_GATEWAY_RUN_MS) {
      suppressedOwnedGatewayRuns.delete(id);
    }
  }
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
    maxChars: CHAT_HISTORY_TEXT_MAX_CHARS,
  });
  const msgs = convertHistoryMessages(result?.messages || []);
  return [...msgs].reverse().find((m) => m.who === 'them')?.text || null;
}

async function recoverActiveRunsAfterReconnect() {
  if (activeRuns.size === 0) return;
  for (const [clientRunId, run] of activeRuns.entries()) {
    run.suspended = false;
    run.lastEventAt = Date.now();
    clearRunRecoverTimer(run);
    armRunTimeout(clientRunId, run);
  }
}

function stripOneTextPrefix(text, priorRaw) {
  if (!priorRaw) return text;
  let next = String(text || '');
  const prior = priorRaw.trim();
  if (!next) return next;
  if (next.trim() === prior) return '';
  if (next.startsWith(priorRaw) && next.length > priorRaw.length) {
    return next.slice(priorRaw.length);
  }
  if (next.startsWith(prior) && next.length > prior.length) {
    return next.slice(prior.length);
  }
  return next;
}

function stripPriorAssistantPrefix(run, text) {
  let next = String(text || '');
  next = stripOneTextPrefix(next, String(run.priorAssistantText || ''));
  next = stripOneTextPrefix(next, String(run.committedInRunText || ''));
  return next;
}

function recordCommittedSegment(run, segmentText) {
  const part = String(segmentText || '');
  if (!part) return;
  run.committedInRunText = `${run.committedInRunText || ''}${part}`;
}

function advanceOwnedStream(run, rawNext) {
  if (typeof rawNext !== 'string') return null;
  const next = stripPriorAssistantPrefix(run, rawNext);
  if (!next) return null;
  const current = String(run.fullText || '');

  if (!current) {
    return { fullText: next, delta: next };
  }

  if (next === current) return null;

  if (next.startsWith(current)) {
    const delta = next.slice(current.length);
    if (!delta) return null;
    return { fullText: next, delta };
  }

  // 工具卡已 commit 上一段过程消息，Gateway 发来新段（strip 后不再延续 current）
  recordCommittedSegment(run, current);
  return { fullText: next, delta: next };
}

function finishClientRun(clientRunId, outcome) {
  const run = activeRuns.get(clientRunId);
  if (!run) return;
  if (run.gatewayRunId) {
    rememberFinishedOwnedGatewayRun(run.gatewayRunId, run.sessionKey || getSessionKey());
  }
  unregisterActiveRun(clientRunId);
  const fullText = String(
    (typeof outcome?.text === 'string' ? outcome.text : '')
    || run.fullText
    || '',
  );
  if (outcome.aborted) {
    sendStreamDoneToRenderer(run, clientRunId, { aborted: true, text: fullText });
  } else if (outcome.error) {
    sendStreamErrorToRenderer(run, clientRunId, outcome.error);
  } else {
    sendStreamDoneToRenderer(run, clientRunId, { text: fullText });
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

function markOwnedRunToolActivity(gatewayRunId, phase) {
  const id = gatewayRunId == null ? '' : String(gatewayRunId).trim();
  if (!id) return;
  const matched = findClientRunByGatewayRunId(id);
  if (!matched?.run) return;
  matched.run.sawToolActivity = true;
  matched.run.lastEventAt = Date.now();
  matched.run.quietPolls = 0;
  if (phase === 'result') matched.run.sawToolResult = true;
}

function isToolAgentEventPayload(payload) {
  return Boolean(payload && payload.stream === 'tool');
}

function handleGatewayToolEvent(payload) {
  if (!isToolAgentEventPayload(payload)) return;
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (sessionKey && sessionKey !== getSessionKey()) return;
  if (activeMeetingSessionKey && sessionKey === activeMeetingSessionKey) return;
  if (isMeetingA2ASessionKey(sessionKey)) return;
  if (payload.runId) {
    const phase = typeof payload.data?.phase === 'string' ? payload.data.phase : '';
    markOwnedRunToolActivity(String(payload.runId), phase);
  }
  broadcastToRenderers('openclaw:tool-event', payload);
}

function handleGatewayAgentLifecycleEvent(payload) {
  if (!payload || payload.stream !== 'lifecycle') return;
  const phase = payload.data?.phase;
  if (phase !== 'end' && phase !== 'error') return;
  const gatewayRunId = payload.runId == null ? '' : String(payload.runId);
  if (!gatewayRunId) return;
  const matched = findClientRunByGatewayRunId(gatewayRunId);
  if (!matched) return;
  const { clientRunId, run } = matched;
  if (phase === 'error') {
    const err = payload.data?.message || payload.data?.error || payload.data?.reason || 'agent error';
    finishClientRun(clientRunId, { error: String(err) });
    return;
  }
  const remaining = String(run.fullText || '').trim();
  let doneText = remaining;
  if (remaining) {
    if (run.sawToolActivity) {
      sendChatSegmentToRenderer(run, clientRunId, run.fullText);
      recordCommittedSegment(run, run.fullText);
      run.fullText = '';
      doneText = '';
    } else {
      sendStreamDeltaToRenderer(run, clientRunId, run.fullText, true);
    }
  }
  finishClientRun(clientRunId, { ok: true, text: doneText });
}

function handleGatewayAgentEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.stream === 'tool') {
    noteMeetingRunActivity(payload, { tool: true });
    handleGatewayToolEvent(payload);
    return;
  }
  if (payload.stream === 'lifecycle') {
    noteMeetingRunActivity(payload, { tool: false });
    handleGatewayAgentLifecycleEvent(payload);
  }
}

function handleExternalSessionChatEvent(payload, { allowWhileBusy = false } = {}) {
  if (!payload || typeof payload.runId !== 'string') return;
  if (activeMeetingSessionKey && payload.sessionKey === activeMeetingSessionKey) return;
  if (isMeetingA2ASessionKey(payload.sessionKey)) return;

  const sessionKey = String(payload.sessionKey || '').trim();
  const forCurrentSession = !sessionKey || sessionKey === getSessionKey();
  const isForwardRun = pendingForwardRuns.has(payload.runId);
  // Shell 正在当前 session 发消息时，忽略同 session 的外部流（owned run 优先）
  if (!allowWhileBusy && activeRuns.size > 0 && forCurrentSession) return;

  const passive = isForwardRun || !forCurrentSession;

  const gatewayRunId = payload.runId;
  let run = externalSessionRuns.get(gatewayRunId);
  if (!run) {
    run = { fullText: '', lastEventAt: Date.now() };
    externalSessionRuns.set(gatewayRunId, run);
  }
  run.lastEventAt = Date.now();

  const broadcastBase = { sessionKey, gatewayRunId, passive };

  if (payload.state === 'delta') {
    const next = resolveDeltaText(run.fullText, payload);
    if (typeof next === 'string' && next !== run.fullText) {
      if (payload.replace === true) {
        run.fullText = next;
        broadcastToRenderers('openclaw:session-chat', {
          ...broadcastBase,
          state: 'delta',
          delta: next,
          replace: true,
          text: next,
        });
      } else {
        const delta = next.startsWith(run.fullText) ? next.slice(run.fullText.length) : next;
        run.fullText = next;
        if (delta) {
          broadcastToRenderers('openclaw:session-chat', {
            ...broadcastBase,
            state: 'delta',
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
      ...broadcastBase,
      state: 'final',
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
    if (isForwardRun) finishForwardRun(gatewayRunId);
    return;
  }

  if (payload.state === 'aborted') {
    broadcastToRenderers('openclaw:session-chat', {
      ...broadcastBase,
      state: 'aborted',
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
    if (isForwardRun) finishForwardRun(gatewayRunId);
    return;
  }

  if (payload.state === 'error') {
    broadcastToRenderers('openclaw:session-chat', {
      ...broadcastBase,
      state: 'error',
      error: payload.errorMessage || 'chat error',
      text: run.fullText,
    });
    externalSessionRuns.delete(gatewayRunId);
    if (isForwardRun) finishForwardRun(gatewayRunId);
  }
}

function broadcastMeetingEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    safeSendTo(mainWindow.webContents, 'qizi-meeting:event', event);
  }
}

function finishMeetingRun(gatewayRunId, outcome) {
  const run = pendingMeetingRuns.get(gatewayRunId);
  if (!run || run.settled) return;
  run.settled = true;
  if (run.timeout) clearTimeout(run.timeout);
  pendingMeetingRuns.delete(gatewayRunId);
  if (run.stoppingForTools && (outcome.stoppedForTools || outcome.aborted)) {
    run.resolve({ text: outcome.text || run.fullText || '', stoppedForTools: true });
    return;
  }
  if (outcome.stoppedForTools) {
    run.resolve({ text: outcome.text || run.fullText || '', stoppedForTools: true });
    return;
  }
  if (outcome.error) {
    run.reject(new Error(formatGatewayError(new Error(outcome.error))));
    return;
  }
  if (outcome.aborted) {
    run.reject(new Error('回复已中止'));
    return;
  }
  run.resolve({ text: outcome.text || run.fullText || '' });
}

function handleMeetingGatewayChatEvent(payload) {
  const found = findPendingMeetingRun(payload);
  if (!found) return false;
  const { id, run } = found;
  run.lastEventAt = Date.now();
  if (typeof run.armIdle === 'function') run.armIdle();
  if (payload.state === 'delta') {
    run.fullText = resolveDeltaText(run.fullText, payload);
    if (typeof run.onDelta === 'function') {
      run.onDelta(run.fullText);
    }
    return true;
  }
  if (payload.state === 'final') {
    const finalText = extractMessageText(payload.message);
    if (finalText && finalText.length >= run.fullText.length && !looksLikeLeakedToolPayloadText(finalText)) {
      run.fullText = finalText;
    }
    finishMeetingRun(id, { ok: true, text: run.fullText });
    return true;
  }
  if (payload.state === 'aborted') {
    finishMeetingRun(id, { aborted: true, text: run.fullText });
    return true;
  }
  if (payload.state === 'error') {
    finishMeetingRun(id, { error: payload.errorMessage || 'chat error' });
    return true;
  }
  return true;
}

function findPendingMeetingRun(payload) {
  const runId = payload?.runId == null ? '' : String(payload.runId);
  if (runId && pendingMeetingRuns.has(runId)) {
    return { id: runId, run: pendingMeetingRuns.get(runId) };
  }
  const sessionKey = typeof payload?.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (!sessionKey) return null;
  const matches = [];
  for (const [id, run] of pendingMeetingRuns.entries()) {
    if (run.sessionKey === sessionKey) matches.push({ id, run });
  }
  return matches.length === 1 ? matches[0] : null;
}

function noteMeetingRunActivity(payload, { tool = false } = {}) {
  const found = findPendingMeetingRun(payload);
  if (!found || found.run.settled) return;
  const { id, run } = found;
  run.lastEventAt = Date.now();
  if (typeof run.armIdle === 'function') run.armIdle();
  if (tool && run.stopOnTools && !String(run.fullText || '').trim() && !run.stoppingForTools) {
    run.stoppingForTools = true;
    void (async () => {
      await abortMeetingChatRun(run.sessionKey, id);
      finishMeetingRun(id, { stoppedForTools: true, text: '' });
    })();
  }
}

async function abortMeetingChatRun(sessionKey, runId) {
  try {
    const client = ensureGateway();
    if (!client?.connected) return;
    await client.request('chat.abort', { sessionKey, runId });
  } catch (err) {
    console.warn('[qizi] meeting chat.abort failed:', err?.message || err);
  }
}

async function subscribeMeetingSession(client, sessionKey) {
  try {
    await client.request('sessions.messages.subscribe', { key: sessionKey });
  } catch (err) {
    console.warn('[qizi] meeting session subscribe failed:', err?.message || err);
  }
}

function runMeetingChatTurn(sessionKey, message, {
  timeoutMs = 180000,
  absoluteTimeoutMs,
  onDelta,
  stopOnTools = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const idleMs = timeoutMs;
    const absoluteMs = typeof absoluteTimeoutMs === 'number' ? absoluteTimeoutMs : timeoutMs;
    const startedAt = Date.now();
    let gatewayRunId = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      const run = gatewayRunId ? pendingMeetingRuns.get(gatewayRunId) : null;
      if (run) {
        run.settled = true;
        if (run.timeout) clearTimeout(run.timeout);
        pendingMeetingRuns.delete(gatewayRunId);
      }
      const runId = gatewayRunId;
      void (async () => {
        if (runId) await abortMeetingChatRun(sessionKey, runId);
        reject(error instanceof Error ? error : new Error(String(error || '会议发言失败')));
      })();
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    void (async () => {
      try {
        const client = ensureGateway();
        await client.waitForConnect();
        await subscribeMeetingSession(client, sessionKey);
        const idempotencyKey = `qizi-meeting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ack = await client.request('chat.send', {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey,
        });
        gatewayRunId = (ack && ack.runId) || idempotencyKey;
      } catch (err) {
        fail(err);
        return;
      }

      const armIdle = () => {
        const run = pendingMeetingRuns.get(gatewayRunId);
        if (!run || run.settled || settled) return;
        if (run.timeout) clearTimeout(run.timeout);
        const remain = absoluteMs - (Date.now() - startedAt);
        if (remain <= 0) {
          fail(new Error('会议发言超时'));
          return;
        }
        run.timeout = setTimeout(() => {
          fail(new Error('会议发言超时'));
        }, Math.min(idleMs, remain));
        run.timeout.unref?.();
      };

      pendingMeetingRuns.set(gatewayRunId, {
        fullText: '',
        sessionKey,
        stopOnTools,
        stoppingForTools: false,
        settled: false,
        armIdle,
        resolve: (value) => succeed(value),
        reject: (err) => fail(err),
        timeout: null,
        lastEventAt: Date.now(),
        onDelta,
      });
      armIdle();
    })();
  });
}

function refreshMeetingHistorySoon() {
  if (!activeMeetingSessionKey || !activeMeetingMeta) return;
  void (async () => {
    try {
      const messages = await fetchMeetingHistory(activeMeetingSessionKey, activeMeetingMeta);
      broadcastMeetingHistory(messages);
    } catch {
      // ignore
    }
  })();
}

async function injectMeetingChatMessage(sessionKey, message, label) {
  const client = ensureGateway();
  await client.waitForConnect();
  await client.request('chat.inject', {
    sessionKey,
    message,
    label,
  });
}

function resolveExecAgentLabel(config, agentId) {
  const catalog = config?.agentCatalog || [];
  const entry = catalog.find((a) => a.id === agentId);
  return entry?.label || entry?.name || agentId;
}

async function maybeForwardMeetingConclusion(config, messages, meetingId) {
  const agentId = String(config?.postMeetingExecAgentId || '').trim();
  if (!agentId) return null;

  const execSessionKey = shellSessionKeyForAgent(agentId);
  const normalizedMeetingId = String(meetingId || '').trim();
  const label = resolveExecAgentLabel(config, agentId);
  const goal = String(config?.goal || '').trim();

  const finalMsg = findModeratorFinalMessage(messages, config.moderatorAgentId);
  let forwardMessage = '';
  if (finalMsg?.text?.trim()
    && !isMeetingClosingStub(finalMsg.text)
    && !isModeratorPostCloseStub(finalMsg.text)) {
    forwardMessage = buildMeetingForwardPayload(config, finalMsg);
  }

  const dedupeScope = normalizedMeetingId
    ? `meeting-fwd:${normalizedMeetingId}:${agentId}`
    : undefined;
  if (dedupeScope && isForwardAlreadySent(agentId, dedupeScope)) {
    meetingForwardDone.add(normalizedMeetingId);
    return {
      ok: true,
      agentId,
      sessionKey: execSessionKey,
      forwardMessage,
      goal,
      label,
      deduped: true,
    };
  }
  if (normalizedMeetingId && meetingForwardDone.has(normalizedMeetingId)) {
    return {
      ok: true,
      agentId,
      sessionKey: execSessionKey,
      forwardMessage,
      goal,
      label,
      deduped: true,
    };
  }

  if (!finalMsg?.text?.trim()) {
    return {
      ok: false,
      agentId,
      sessionKey: execSessionKey,
      goal,
      label,
      error: '未找到主持最终总结，无法转发结论',
    };
  }
  if (isMeetingClosingStub(finalMsg.text) || isModeratorPostCloseStub(finalMsg.text)) {
    return {
      ok: false,
      agentId,
      sessionKey: execSessionKey,
      goal,
      label,
      error: '主持仅回复了「会议结束」等收尾语，缺少可转发的最终总结',
    };
  }

  try {
    const outbound = forwardMessage || buildMeetingForwardPayload(config, finalMsg);
    const result = await forwardMessageToAgents({
      agentIds: [agentId],
      message: outbound,
      dedupeScope,
    });
    if (result?.ok && normalizedMeetingId) {
      meetingForwardDone.add(normalizedMeetingId);
    }
    const sentSessionKey = result?.results?.find((entry) => entry.agentId === agentId)?.sessionKey
      || execSessionKey;
    return {
      ok: Boolean(result?.ok),
      agentId,
      sessionKey: sentSessionKey,
      forwardMessage: outbound,
      goal,
      label,
      deduped: Boolean(result?.deduped),
      error: result?.ok ? undefined : (result?.error || '转发失败'),
    };
  } catch (err) {
    return {
      ok: false,
      agentId,
      sessionKey: execSessionKey,
      forwardMessage,
      goal,
      label,
      error: err?.message || String(err),
    };
  }
}

async function runMeetingBriefingFlow(config) {
  meetingBriefingRunning = true;
  meetingBriefingCancelled = false;
  config = {
    ...(config || {}),
    startedAt: config?.startedAt || new Date().toISOString(),
    noRepeatPastTopics: Boolean(config?.noRepeatPastTopics),
  };
  if (config.noRepeatPastTopics) {
    try {
      config.priorTopicSummaries = await listPriorSummaries(requestMeetingGateway, config.topic);
    } catch (err) {
      config.priorTopicSummaries = [];
      console.error('[qizi] prior topic ledger:', err?.message || err);
    }
  } else {
    config.priorTopicSummaries = [];
  }
  activeMeetingForwardConfig = { ...config };
  activeMeetingTranscript = [];
  try {
    await startMeetingGroupRelay(config, {
      chatTurn: (sessionKey, message, opts) => runMeetingChatTurn(sessionKey, message, opts || {}),
      chatTurnStream: (sessionKey, message, opts = {}) => runMeetingChatTurn(sessionKey, message, opts),
      onRelayReady: (api) => {
        activeMeetingRelay = api;
      },
      onEvent: (event) => {
        if (event.type === 'briefing_ready' && event.payload) {
          if (config.ephemeral) event.payload.ephemeral = true;
          setActiveMeetingMeta({
            sessionKey: event.payload.sessionKey,
            meetingId: event.payload.meetingId,
            moderatorAgentId: config.moderatorAgentId,
            moderatorLabel: config.moderatorLabel,
            participantAgentIds: [...(config.participantAgentIds || [])],
            agentCatalog: config.agentCatalog || [],
            topic: config.topic,
          });
        }
        if (event.type === 'transcript') {
          if (Array.isArray(event.payload?.messages)) {
            activeMeetingTranscript = event.payload.messages;
          }
          broadcastMeetingEvent(event);
          return;
        }
        if (event.type === 'done') {
          void (async () => {
            const forwardResult = await maybeForwardMeetingConclusion(
              config,
              event.payload?.messages,
              event.payload?.meetingId,
            );
            clearActiveMeeting();
            broadcastMeetingEvent(event);
            if (forwardResult) {
              broadcastMeetingEvent({
                type: 'post_meeting_forward',
                payload: forwardResult,
              });
            }
          })();
          return;
        }
        if (event.type === 'error' || event.type === 'cancelled') {
          clearActiveMeeting();
        }
        broadcastMeetingEvent(event);
      },
      saveRecord: async (record) => {
        const saved = await saveFinishedMeeting(requestMeetingGateway, record);
        if (!saved.ok) throw new Error(saved.error || '保存会议记录失败');
        return saved.id;
      },
      isCancelled: () => meetingBriefingCancelled,
    });
  } catch (err) {
    console.error('[qizi] meeting failed:', err?.message || err);
    clearActiveMeeting();
    if (!meetingBriefingCancelled) {
      broadcastMeetingEvent({ type: 'error', payload: { error: err.message || String(err) } });
    } else {
      broadcastMeetingEvent({ type: 'cancelled', payload: {} });
    }
  } finally {
    activeMeetingRelay = null;
    meetingBriefingRunning = false;
    meetingBriefingCancelled = false;
    try {
      if (gateway?.connected) void ensureGatewaySessionSubscription(gateway);
    } catch {
      // ignore
    }
  }
}

function ensureMeetingEngine() {
  if (!meetingEngine) {
    const { MeetingEngine } = require('./meeting-engine');
    meetingEngine = new MeetingEngine({
      chatTurn: runMeetingChatTurn,
      onEvent: (event) => broadcastMeetingEvent(event),
      saveRecord: saveMeetingRecord,
    });
  }
  return meetingEngine;
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
  if (activeMeetingSessionKey && keys.has(activeMeetingSessionKey)) {
    refreshMeetingHistorySoon();
  }
  const currentSession = getSessionKey();
  const affectsCurrent = keys.size === 0 || keys.has(currentSession);
  debugEvent('session', 'sessions_changed', {
    currentSession,
    affectsCurrent,
    keyCount: keys.size,
  });
  if (keys.size > 0 && !affectsCurrent) return;
  broadcastToRenderers('openclaw:session-changed', {
    sessionKey: currentSession,
  });
}

function handleGatewayChatEvent(payload) {
  if (!payload || payload.runId == null) return;
  if (handleMeetingGatewayChatEvent(payload)) return;
  if (activeMeetingSessionKey && payload.sessionKey === activeMeetingSessionKey) {
    if (payload.state === 'final' || payload.state === 'aborted' || payload.state === 'error') {
      refreshMeetingHistorySoon();
    }
    return;
  }
  const matched = findOwnedRunForChatPayload(payload);
  if (matched) {
    handleOwnedGatewayChatEvent(payload, matched);
    return;
  }
  if (shouldSuppressLateOwnedGatewayEvent(payload)) {
    debugEvent('stream', 'suppress_late_owned_run_event', {
      runId: String(payload.runId || ''),
      state: payload.state || null,
      sessionKey: payload.sessionKey || null,
    });
    return;
  }
  pruneSuppressedOwnedGatewayRuns();
  debugEvent('stream', 'unmatched_chat_event', {
    runId: String(payload.runId || ''),
    state: payload.state || null,
    sessionKey: payload.sessionKey || null,
    activeRunIds: [...activeRuns.keys()],
  });
  handleExternalSessionChatEvent(payload);
}

function handleOwnedGatewayChatEvent(payload, matched) {
  const { clientRunId, run } = matched;
  const incomingRunId = payload.runId == null ? '' : String(payload.runId);
  if (incomingRunId && run.gatewayRunId !== incomingRunId) {
    gatewayRunIndex.delete(run.gatewayRunId);
    run.gatewayRunId = incomingRunId;
    gatewayRunIndex.set(incomingRunId, clientRunId);
  }
  run.lastEventAt = Date.now();
  run.stableHistoryPolls = 0;
  run.quietPolls = 0;
  clearRunRecoverTimer(run);

  if (payload.state === 'delta') {
    const rawNext = resolveDeltaText(run.fullText, payload);
    const advance = advanceOwnedStream(run, rawNext);
    if (!advance) return;
    run.fullText = advance.fullText;
    sendStreamDeltaToRenderer(run, clientRunId, advance.fullText, true);
    return;
  }

  if (payload.state === 'final') {
    let finalText = extractMessageText(payload.message);
    if (finalText && !looksLikeLeakedToolPayloadText(finalText)) {
      const stripped = stripPriorAssistantPrefix(run, finalText);
      if (stripped) {
        finalText = stripped;
        if (finalText.length >= run.fullText.length) {
          run.fullText = finalText;
          sendStreamDeltaToRenderer(run, clientRunId, run.fullText, true);
        }
      }
    }
    const visible = String(run.fullText || '').trim();
    // chat final 就是这一轮的结束（网页版据此收起「正在回复」）。
    // 用过工具时不能再空等 lifecycle / hasActiveRun：结束后网关仍可能短暂标成活跃，界面就会一直停在等待。
    if (run.sawToolActivity && visible) {
      sendChatSegmentToRenderer(run, clientRunId, run.fullText);
      recordCommittedSegment(run, run.fullText);
    }
    run.sawChatFinal = true;
    finishClientRun(clientRunId, { ok: true, text: run.fullText });
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

function isBtwSlashCommand(message) {
  const trimmed = String(message || '').trim();
  return /^\/(?:btw|side)(?:\s|$)/i.test(trimmed);
}

function parseBtwQuestion(message) {
  const trimmed = String(message || '').trim();
  const match = trimmed.match(/^\/(?:btw|side)\s+([\s\S]+)$/i);
  return match ? match[1].trim() : '';
}

function parseChatSideResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.kind !== 'btw') return null;
  if (typeof payload.sessionKey !== 'string') return null;
  if (typeof payload.text !== 'string') return null;
  return {
    kind: 'btw',
    runId: typeof payload.runId === 'string' ? payload.runId : '',
    sessionKey: payload.sessionKey,
    question: typeof payload.question === 'string' ? payload.question : '',
    text: payload.text,
    isError: payload.isError === true,
    ts: Number(payload.ts) || Date.now(),
    seq: payload.seq,
  };
}

function clearPendingBtwRun(gatewayRunId) {
  const pending = pendingBtwRuns.get(gatewayRunId);
  if (!pending) return null;
  if (pending.timeout) clearTimeout(pending.timeout);
  pendingBtwRuns.delete(gatewayRunId);
  return pending;
}

function deliverBtwSideResult(sideResult) {
  const pending = sideResult.runId ? clearPendingBtwRun(sideResult.runId) : null;
  if (pending) {
    safeSendTo(pending.sender, 'openclaw:side-result', sideResult);
    return;
  }
  broadcastToRenderers('openclaw:side-result', sideResult);
}

function handleGatewaySideResultEvent(payload) {
  const sideResult = parseChatSideResult(payload);
  if (!sideResult) return;
  if (!isPayloadForCurrentSession(sideResult)) return;
  deliverBtwSideResult(sideResult);
}

function clearAllPendingBtwRuns() {
  for (const gatewayRunId of [...pendingBtwRuns.keys()]) {
    clearPendingBtwRun(gatewayRunId);
  }
}

async function sendDetachedBtwChat(event, { message, attachments }) {
  const trimmedMessage = String(message || '').trim();
  const question = parseBtwQuestion(trimmedMessage);
  if (!question) {
    return { ok: false, error: '请在 /btw 或 /side 后输入问题' };
  }

  const client = ensureGateway();
  await client.waitForConnect();

  const idempotencyKey = `qizi-btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionKey = getSessionKey();
  const ack = await client.request('chat.send', {
    sessionKey,
    message: trimmedMessage,
    idempotencyKey,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    ...sendFieldsForSession(sessionKey),
  });
  const gatewayRunId = (ack && ack.runId) || idempotencyKey;

  const timeout = setTimeout(() => {
    if (!pendingBtwRuns.has(gatewayRunId)) return;
    clearPendingBtwRun(gatewayRunId);
    deliverBtwSideResult({
      kind: 'btw',
      runId: gatewayRunId,
      sessionKey: getSessionKey(),
      question,
      text: '侧问超时，请重试',
      isError: true,
      ts: Date.now(),
    });
  }, BTW_TIMEOUT_MS);
  timeout.unref?.();

  pendingBtwRuns.set(gatewayRunId, {
    sender: event.sender,
    question,
    startedAt: Date.now(),
    timeout,
  });

  return { ok: true, gatewayRunId, question };
}

async function ensureGatewaySessionSubscription(client) {
  if (!client?.connected) return;
  try {
    await client.request('sessions.subscribe', { limit: 60, ownerFirst: true });
  } catch (err) {
    console.warn('[qizi] sessions.subscribe failed:', err.message);
  }
  try {
    await client.request('sessions.messages.subscribe', { key: getSessionKey() });
  } catch (err) {
    console.warn('[qizi] sessions.messages.subscribe failed:', err.message);
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
    if (frame.event === 'chat.side_result') {
      handleGatewaySideResultEvent(frame.payload);
      return;
    }
    if (frame.event === 'sessions.changed') {
      handleSessionsChangedEvent(frame.payload);
      return;
    }
    if (frame.event === 'agent' || frame.event === 'session.tool') {
      handleGatewayAgentEvent(frame.payload);
    }
  });
  client.on('connected', () => {
    void ensureGatewaySessionSubscription(client);
    prefetchAgentList();
    prefetchModelList();
    warmPrivateChannelSource();
    ensureShellWarmTimer();
    ensureBackgroundRunPoll();
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
  client.on('close', (info) => {
    if (isQuitting) {
      failAllActiveRuns('应用正在退出');
    } else {
      suspendActiveRuns();
    }
    clearAllPendingBtwRuns();
    const reconnecting = !isQuitting && info?.reconnecting !== false;
    broadcastToRenderers('openclaw:gateway-status', {
      connected: false,
      reconnecting,
      error: info?.errorMessage || null,
    });
  });
}

function ensureGateway() {
  const config = loadOpenClawConfig();
  if (!config.wsUrl) {
    throw new Error('未配置 Gateway，请在设置中填写管理员提供的 WSS 地址');
  }
  if (!config.tokenless && !config.token) {
    throw new Error('未配置 Gateway，请在设置中填写管理员提供的 WSS 地址与 Token');
  }
  const nextKey = `${config.wsUrl}\0${config.tokenless ? '' : (config.token || '')}`;
  if (!gateway || gatewayConfigKey !== nextKey) {
    if (gateway) {
      failAllActiveRuns('Gateway 配置已变更');
      gateway.stop();
    }
    clearAgentListCache();
    modelListByAgent.clear();
    modelRefreshInflight.clear();
    channelSourceCache = { at: 0, source: null };
    channelSourceInflight = null;
    gateway = new GatewayWsClient({
      url: config.wsUrl,
      token: config.tokenless ? undefined : config.token,
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
      devTools: Boolean(process.env.QIZI_DEVTOOLS_PORT),
    },
  });

  mainWindow.webContents.session.setCertificateVerifyProc((request, callback) => {
    if (shouldAllowInsecureTls(request.hostname)) {
      callback(0);
      return;
    }
    callback(-2);
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('close', (event) => {
    saveWindowState();
    // 拦截「红点关闭」→ 隐藏而不是退出（菜单栏应用习惯）
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      syncDockVisibility();
    }
  });

  mainWindow.on('show', () => {
    syncDockVisibility();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openLinksExternally && isSafeExternalHttpUrl(url)) {
      openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (!url || url === currentUrl) return;
    try {
      const target = new URL(url);
      const current = new URL(currentUrl);
      if (target.href === current.href) return;
    } catch {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (openLinksExternally && isSafeExternalHttpUrl(url)) {
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
    syncDockVisibility();
  } else {
    showMainWindow();
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

function trayMenuIcon(filename) {
  const iconPath = path.join(__dirname, 'assets', 'icons', filename);
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) return undefined;
    return img.resize({ width: 16, height: 16 });
  } catch {
    return undefined;
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Settings', icon: trayMenuIcon('gear.png'), click: () => openSettings() },
    { label: 'Maintaining', icon: trayMenuIcon('tools-wrench.png'), click: () => openMaintainingWindow() },
    { label: 'Openclaw Control', icon: trayMenuIcon('openclaw-control.png'), click: () => openOpenClawControl() },
    { label: 'Update', icon: trayMenuIcon('update-menu.png'), click: () => openUpdate() },
    { label: 'About QiziShell', icon: trayMenuIcon('about-menu.png'), click: () => openAbout() },
    { type: 'separator' },
    { label: 'Quit', icon: trayMenuIcon('exit.png'), click: () => {
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
  if (process.platform === 'darwin') {
    // 不要 setContextMenu。macOS 会让左键进入菜单跟踪，click 在按下时触发：
    // 主窗口刚显示，松开鼠标跟踪结束，窗口就被收掉。左键只切换主窗口，右键再弹出菜单。
    tray.on('click', (event) => {
      if (event.ctrlKey || event.metaKey) return;
      markTrayClick();
      toggleMainWindow();
    });
    tray.on('right-click', () => {
      tray.popUpContextMenu(buildTrayMenu());
    });
    return;
  }
  tray.setContextMenu(buildTrayMenu());
}

async function checkConnection() {
  const { token, wsUrl, tokenless } = loadOpenClawConfig();
  if (!wsUrl) {
    return { ok: false, error: '未配置 Gateway，请在设置中填写管理员提供的 WSS 地址' };
  }
  if (!tokenless && !token) {
    return { ok: false, error: '未配置 Gateway，请在设置中填写管理员提供的 WSS 地址与 Token' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const current = getSessionKey();
    debugEvent('session', 'connection_ok', { sessionKey: current });
    return { ok: true, wsUrl, sessionKey: current };
  } catch (err) {
    debugEvent('session', 'connection_error', { error: formatGatewayError(err) });
    return { ok: false, error: formatGatewayError(err) };
  }
}

function finiteUsageNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readMessageCost(message) {
  const sources = [message?.cost, message?.usage?.cost];
  const cost = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    for (const source of sources) {
      const value = finiteUsageNumber(source?.[key]);
      if (value != null) {
        cost[key] = value;
        break;
      }
    }
  }
  return Object.keys(cost).length ? cost : null;
}

function latestAssistantCost(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = message?.role || message?.who;
    if (role === 'user') return null;
    if (role !== 'assistant') continue;
    const cost = readMessageCost(message);
    if (cost) return cost;
  }
  return null;
}

async function fetchSessionInfo() {
  const client = ensureGateway();
  await client.waitForConnect();
  const result = await client.request('chat.history', {
    sessionKey: getSessionKey(),
    limit: 8,
  });
  return {
    sessionInfo: result?.sessionInfo || {},
    defaults: result?.defaults || {},
    messages: Array.isArray(result?.messages) ? result.messages : [],
  };
}

async function getSessionInfo() {
  try {
    const { sessionInfo, defaults, messages } = await fetchSessionInfo();
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
      context: {
        used,
        max,
        percent,
        fresh,
        input: finiteUsageNumber(sessionInfo.inputTokens),
        output: finiteUsageNumber(sessionInfo.outputTokens),
        cost: finiteUsageNumber(sessionInfo.estimatedCostUsd),
        costByType: latestAssistantCost(messages),
      },
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

async function listModels(options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  const agentId = String(options?.agentId || parseAgentIdFromSessionKey(getSessionKey()) || '').trim();
  const cachedEntry = agentId ? modelListByAgent.get(agentId) : null;
  const cached = cachedEntry?.data || null;
  const age = cachedEntry ? Date.now() - cachedEntry.at : Infinity;

  if (!forceRefresh && cached?.ok) {
    if (age < MODEL_LIST_FRESH_MS) {
      return cached;
    }
    if (age < MODEL_LIST_STALE_MS) {
      void refreshModelListForAgent(agentId);
      return cached;
    }
  }

  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const models = await loadModelCatalogForAgent(client, agentId);
    const data = { ok: true, models, agentId };
    storeModelListResult(agentId, data);
    return data;
  } catch (err) {
    if (cached?.ok) return cached;
    return { ok: false, error: formatGatewayError(err), models: [] };
  }
}

async function listAgents(options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  const key = getAgentListGatewayKey();
  const cacheValid = agentListCache.gatewayKey === key;
  const cached = cacheValid ? agentListCache.data : null;
  const age = cacheValid ? Date.now() - agentListCache.at : Infinity;

  if (!forceRefresh && cached?.ok) {
    if (age < AGENT_LIST_FRESH_MS) {
      if (!cached.enriched) void refreshAgentListInBackground();
      return cached;
    }
    if (age < AGENT_LIST_STALE_MS) {
      void refreshAgentListInBackground();
      return cached;
    }
  }

  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const { rawAgents, defaultId, mainKey } = await fetchAgentListCore(client);
    const fast = await buildAgentListResult(client, rawAgents, defaultId, mainKey, { enrichFull: false });
    storeAgentListResult(fast);
    void buildAgentListResult(client, rawAgents, defaultId, mainKey, { enrichFull: true })
      .then((full) => {
        storeAgentListResult(full);
        broadcastAgentsUpdated(full);
      })
      .catch((err) => {
        console.warn('[qizi] agent list enrich failed:', err.message);
      });
    return fast;
  } catch (err) {
    if (cached?.ok) return cached;
    return { ok: false, error: formatGatewayError(err), agents: [] };
  }
}

function describeActiveRunForSession(sessionKey) {
  let latest = null;
  for (const [clientRunId, run] of activeRuns.entries()) {
    if (run.sessionKey !== sessionKey) continue;
    if (!latest || Number(run.startedAt || 0) > Number(latest.startedAt || 0)) {
      latest = { clientRunId, text: run.fullText || '', startedAt: run.startedAt || 0 };
    }
  }
  if (!latest) return null;
  return { clientRunId: latest.clientRunId, text: latest.text };
}

async function switchToAgent(agentId) {
  if (!agentId || typeof agentId !== 'string') {
    return { ok: false, error: '未指定 Agent' };
  }
  try {
    debugEvent('session', 'switch_agent_start', { agentId, fromSessionKey: getSessionKey() });
    const client = ensureGateway();
    await client.waitForConnect();
    const cacheOk = agentListCache.data?.ok && agentListCache.gatewayKey === getAgentListGatewayKey();
    let mainKey = cacheOk ? (agentListCache.data.mainKey || SHELL_SESSION_MAIN_KEY) : SHELL_SESSION_MAIN_KEY;
    let found = cacheOk
      ? (agentListCache.data.agents || []).find((agent) => agent.id === agentId) || null
      : null;
    if (!found) {
      const result = await client.request('agents.list', {});
      mainKey = result?.mainKey || mainKey;
      const agents = Array.isArray(result?.agents) ? result.agents : [];
      found = agents.find((agent) => agent.id === agentId) || null;
      if (!found) return { ok: false, error: `未找到 Agent: ${agentId}` };
    }

    closeHistoryWindow();

    const newSessionKey = shellSessionKeyForAgent(agentId, mainKey);
    persistSessionKey(newSessionKey);
    debugEvent('session', 'switch_agent_success', { agentId, sessionKey: newSessionKey });
    void ensureGatewaySessionSubscription(client);
    return {
      ok: true,
      sessionKey: newSessionKey,
      agent: found,
      mainKey,
      activeRun: describeActiveRunForSession(newSessionKey),
    };
  } catch (err) {
    debugEvent('session', 'switch_agent_failed', { agentId, error: formatGatewayError(err) });
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
    const sessionKey = getSessionKey();
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const result = await client.request('sessions.patch', {
      key: sessionKey,
      agentId,
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

const FAST_MODE_PROVIDER_IDS = new Set([
  'anthropic',
  'minimax',
  'minimax-portal',
  'openai',
  'openrouter',
  'xai',
]);

function sessionRowMatchesDefaults(row, defaults) {
  if (!row) return false;
  const rowProvider = row.modelProvider ?? null;
  const rowModel = row.model ?? null;
  const defProvider = defaults?.modelProvider ?? null;
  const defModel = defaults?.model ?? null;
  if (rowProvider && defProvider && rowProvider !== defProvider) return false;
  if (rowModel && defModel && rowModel !== defModel) return false;
  return true;
}

function normalizeThinkingLevelId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.toLowerCase().replace(/\s+/g, '_');
}

function formatThinkingLevelDisplayLabel(value) {
  const raw = normalizeThinkingLevelId(value);
  if (!raw || raw === 'off') return 'Off';
  if (['on', 'enable', 'enabled'].includes(raw)) return 'On';
  switch (raw) {
    case 'adaptive':
      return 'Adaptive';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case 'max':
      return 'Maximum';
    case 'ultra':
      return 'Ultra';
    default: {
      const text = String(value || '').trim();
      if (!text) return 'Off';
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
}

function formatThinkingOverrideLabel(value, label) {
  const normalized = normalizeThinkingLevelId(value);
  if (!normalized || normalized === 'off') return 'Off';
  const trimmed = String(label || '').trim();
  if (trimmed && normalizeThinkingLevelId(trimmed) !== normalized) {
    return trimmed;
  }
  return formatThinkingLevelDisplayLabel(normalized);
}

function mapThinkingLevelEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    if (entry && typeof entry === 'object') {
      const id = entry.id ?? entry.value ?? normalizeThinkingLevelId(entry.label);
      const idStr = String(id);
      const rawLabel = entry.label ?? entry.id ?? idStr;
      return {
        id: idStr,
        label: formatThinkingOverrideLabel(idStr, rawLabel),
      };
    }
    const id = normalizeThinkingLevelId(entry);
    return { id, label: formatThinkingLevelDisplayLabel(id || entry) };
  }).filter((item) => item.id || item.label);
}

function resolveThinkingLevelOptions(row, defaults) {
  if (Array.isArray(row?.thinkingLevels) && row.thinkingLevels.length) {
    return mapThinkingLevelEntries(row.thinkingLevels);
  }
  const useDefaults = sessionRowMatchesDefaults(row, defaults);
  if (useDefaults && Array.isArray(defaults?.thinkingLevels) && defaults.thinkingLevels.length) {
    return mapThinkingLevelEntries(defaults.thinkingLevels);
  }
  const labels = Array.isArray(row?.thinkingOptions) && row.thinkingOptions.length
    ? row.thinkingOptions
    : (useDefaults && Array.isArray(defaults?.thinkingOptions) ? defaults.thinkingOptions : []);
  return mapThinkingLevelEntries(labels);
}

function formatInheritedThinkingLabel(defaultLevel) {
  return `Inherited: ${formatThinkingLevelDisplayLabel(defaultLevel || 'off')}`;
}

function resolveFastModeUiValue(row) {
  const value = row?.fastMode;
  if (value === true || value === 'on') return 'on';
  if (value === false || value === 'off') return 'off';
  if (value === 'auto') return 'auto';
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function resolveFastModeSupported(row) {
  const provider = String(row?.modelProvider || '').trim().toLowerCase();
  if (provider && FAST_MODE_PROVIDER_IDS.has(provider)) return true;
  const current = resolveFastModeUiValue(row);
  return current === 'on' || current === 'off' || current === 'auto';
}

function resolveFastModeOptionsForSupportedProvider() {
  return [
    { id: '', label: 'Default' },
    { id: 'off', label: 'Standard' },
    { id: 'on', label: 'Fast' },
    { id: 'auto', label: 'Auto' },
  ];
}

function formatFastModeDisplayLabel(current) {
  const id = current === undefined || current === null ? '' : String(current);
  const match = resolveFastModeOptionsForSupportedProvider().find((o) => o.id === id);
  if (match) return match.label;
  if (id === 'on') return 'Fast';
  if (id === 'off') return 'Standard';
  if (id === 'auto') return 'Auto';
  return 'Default';
}

function resolveSpeedSegmentOptions() {
  return [
    { id: 'off', label: 'Standard' },
    { id: 'on', label: 'Fast' },
  ];
}

function resolveSpeedSegmentSelection(current) {
  if (current === 'on') return 'on';
  if (current === 'auto') return 'auto';
  return 'off';
}

function patchFastModeForGateway(uiValue) {
  if (uiValue === '' || uiValue == null || uiValue === 'inherit') return null;
  if (uiValue === 'on') return true;
  if (uiValue === 'off') return false;
  if (uiValue === 'auto') return 'auto';
  return uiValue;
}

async function fetchSessionListRow(client, sessionKey) {
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  const paramSets = [
    { limit: 200, includeGlobal: true, includeUnknown: true, agentId },
    { limit: 200, includeGlobal: true, includeUnknown: true },
    { limit: 200 },
  ];
  for (const params of paramSets) {
    try {
      const result = await client.request('sessions.list', params);
      const sessions = result?.sessions || [];
      const row = sessions.find((s) => s?.key === sessionKey);
      if (row) return { row, defaults: result?.defaults || {} };
    } catch {
      // try next param set
    }
  }
  return { row: null, defaults: {} };
}

const SESSION_PERMISSION_MODES = new Set(['read-only', 'guarded', 'workspace', 'full']);

function normalizeSessionPermissionMode(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return SESSION_PERMISSION_MODES.has(text) ? text : null;
}

async function fetchAgentDefaultPermissionMode(client, agentId) {
  try {
    const result = await client.request('agents.list', {});
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    const found = agents.find((agent) => agent?.id === agentId)
      || agents.find((agent) => agent?.id === (result?.defaultId || 'main'));
    return normalizeSessionPermissionMode(found?.defaultPermissionMode);
  } catch {
    return null;
  }
}

async function getSessionPermission() {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const sessionKey = getSessionKey();
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const [{ row }, defaultMode] = await Promise.all([
      fetchSessionListRow(client, sessionKey),
      fetchAgentDefaultPermissionMode(client, agentId),
    ]);
    return {
      ok: true,
      mode: normalizeSessionPermissionMode(row?.permissionMode),
      pending: row?.permissionModePending === true,
      defaultMode,
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function setSessionPermission(mode) {
  const clearing = mode == null || mode === '' || mode === 'default';
  const normalized = clearing ? null : normalizeSessionPermissionMode(mode);
  if (!clearing && !normalized) {
    return { ok: false, error: '未知的执行权限' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const sessionKey = getSessionKey();
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    await client.request('sessions.patch', {
      key: sessionKey,
      agentId,
      permissionMode: normalized,
    });
    const fresh = await getSessionPermission();
    if (!fresh.ok) {
      return { ok: true, mode: normalized, pending: false, defaultMode: null };
    }
    fresh.mode = normalized;
    fresh.pending = false;
    return fresh;
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function getSessionControls() {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const sessionKey = getSessionKey();
    const { row, defaults } = await fetchSessionListRow(client, sessionKey);
    if (!row) {
      return { ok: false, error: '未找到当前会话' };
    }
    const thinkingLevels = resolveThinkingLevelOptions(row, defaults);
    const defaultLevel = row.thinkingDefault ?? defaults.thinkingDefault ?? 'off';
    const thinkingCurrent = row.thinkingLevel ? String(row.thinkingLevel) : '';
    const effectiveThinkingId = thinkingCurrent || defaultLevel;
    const speedSupported = resolveFastModeSupported(row);
    const speedCurrent = resolveFastModeUiValue(row);
    return {
      ok: true,
      thinking: {
        supported: thinkingLevels.length > 0,
        current: thinkingCurrent,
        defaultLevel: String(defaultLevel),
        effectiveId: String(effectiveThinkingId),
        inheritedLabel: formatInheritedThinkingLabel(defaultLevel),
        display: thinkingCurrent
          ? formatThinkingOverrideLabel(thinkingCurrent)
          : formatThinkingLevelDisplayLabel(defaultLevel),
        levels: thinkingLevels,
      },
      speed: {
        supported: speedSupported,
        current: speedCurrent,
        display: speedSupported ? formatFastModeDisplayLabel(speedCurrent) : null,
        options: speedSupported ? resolveFastModeOptionsForSupportedProvider() : [],
        segments: speedSupported ? resolveSpeedSegmentOptions() : [],
        segmentCurrent: speedSupported ? resolveSpeedSegmentSelection(speedCurrent) : '',
      },
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function patchSessionControls(patch = {}) {
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    const sessionKey = getSessionKey();
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    const body = { key: sessionKey, agentId };
    if ('thinkingLevel' in patch) {
      const value = patch.thinkingLevel;
      body.thinkingLevel = value === '' || value == null ? null : String(value);
    }
    if ('fastMode' in patch) {
      body.fastMode = patchFastModeForGateway(patch.fastMode);
    }
    if (!('thinkingLevel' in patch) && !('fastMode' in patch)) {
      return { ok: false, error: '未指定要更新的项' };
    }
    await client.request('sessions.patch', body);
    return getSessionControls();
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

// Gateway 单次 chat.history 最多 1000 条，响应还有约 512KB 的页上限。
// 不跟 hasMore 时，主界面就只剩最新一页，更早的消息只能去历史窗口。
const CHAT_HISTORY_PAGE_LIMIT = 1000;
const CHAT_HISTORY_PAGE_GUARD = 400;
/** @type {Map<string, { sessionId: string, totalMessages: number | null, raw: object[] }>} */
const chatHistoryAssemblies = new Map();
/** @type {Map<string, Promise<object[]>>} */
const chatHistoryAssemblyInflight = new Map();

function rawChatHistoryIdentity(message) {
  if (!message || typeof message !== 'object') return '';
  const meta = message.__openclaw;
  if (!meta || typeof meta !== 'object') return '';
  if (typeof meta.id === 'string' && meta.id) return `id:${meta.id}`;
  if (typeof meta.seq === 'number' && Number.isSafeInteger(meta.seq)) return `seq:${meta.seq}`;
  return '';
}

function takeUnseenHistoryMessages(messages, seen) {
  const pageCounts = new Map();
  const fresh = [];
  for (const message of messages) {
    const key = rawChatHistoryIdentity(message);
    if (!key) {
      fresh.push(message);
      continue;
    }
    const count = (pageCounts.get(key) || 0) + 1;
    pageCounts.set(key, count);
    if (count > (seen.get(key) || 0)) fresh.push(message);
  }
  for (const [key, count] of pageCounts) {
    seen.set(key, Math.max(count, seen.get(key) || 0));
  }
  return fresh;
}

function spliceCachedHistoryWithTail(cachedRaw, tailMessages) {
  const anchor = tailMessages.map(rawChatHistoryIdentity).find(Boolean);
  if (!anchor) return null;
  const index = cachedRaw.findIndex((message) => rawChatHistoryIdentity(message) === anchor);
  if (index < 0) return null;
  return cachedRaw.slice(0, index).concat(tailMessages);
}

function requestDisplayHistoryPage(client, sessionKey, offset) {
  return client.request('chat.history', {
    sessionKey,
    limit: CHAT_HISTORY_PAGE_LIMIT,
    offset,
    maxChars: CHAT_HISTORY_TEXT_MAX_CHARS,
  });
}

function rememberAssembledHistory(sessionKey, sessionId, totalMessages, raw) {
  chatHistoryAssemblies.set(sessionKey, { sessionId, totalMessages, raw });
}

async function assembleDisplayChatHistory(client, sessionKey) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tail = await requestDisplayHistoryPage(client, sessionKey, 0);
    const tailMessages = Array.isArray(tail?.messages) ? tail.messages : [];
    const sessionId = typeof tail?.sessionId === 'string' ? tail.sessionId : '';
    const totalMessages = typeof tail?.totalMessages === 'number' ? tail.totalMessages : null;
    if (!tail?.hasMore) {
      rememberAssembledHistory(sessionKey, sessionId, totalMessages, tailMessages);
      return tailMessages;
    }

    const cached = chatHistoryAssemblies.get(sessionKey);
    const totalsAllowReuse = totalMessages == null
      || cached?.totalMessages == null
      || totalMessages >= cached.totalMessages;
    if (cached && cached.sessionId === sessionId && totalsAllowReuse && Array.isArray(cached.raw)) {
      const spliced = spliceCachedHistoryWithTail(cached.raw, tailMessages);
      if (spliced) {
        rememberAssembledHistory(sessionKey, sessionId, totalMessages, spliced);
        return spliced;
      }
    }

    const pages = [];
    const seen = new Map();
    let offset = 0;
    let page = tail;
    let restarted = false;
    for (let guard = 0; guard < CHAT_HISTORY_PAGE_GUARD; guard += 1) {
      if (guard > 0) page = await requestDisplayHistoryPage(client, sessionKey, offset);
      const pageSessionId = typeof page?.sessionId === 'string' ? page.sessionId : '';
      const pageTotal = typeof page?.totalMessages === 'number' ? page.totalMessages : null;
      if ((sessionId && pageSessionId && pageSessionId !== sessionId)
        || (totalMessages != null && pageTotal != null && pageTotal !== totalMessages)) {
        chatHistoryAssemblies.delete(sessionKey);
        restarted = true;
        break;
      }
      const messages = Array.isArray(page?.messages) ? page.messages : [];
      pages.push(takeUnseenHistoryMessages(messages, seen));
      const stalled = page?.hasMore === true
        && (typeof page.nextOffset !== 'number' || page.nextOffset <= offset);
      if (!page?.hasMore || stalled) {
        const raw = pages.reverse().flat();
        rememberAssembledHistory(sessionKey, pageSessionId || sessionId, pageTotal ?? totalMessages, raw);
        return raw;
      }
      offset = page.nextOffset;
    }
    if (restarted) continue;
    return pages.reverse().flat();
  }
  const fallback = await requestDisplayHistoryPage(client, sessionKey, 0);
  return Array.isArray(fallback?.messages) ? fallback.messages : [];
}

function loadDisplayChatHistory(client, sessionKey) {
  const existing = chatHistoryAssemblyInflight.get(sessionKey);
  if (existing) return existing;
  const job = assembleDisplayChatHistory(client, sessionKey).finally(() => {
    if (chatHistoryAssemblyInflight.get(sessionKey) === job) {
      chatHistoryAssemblyInflight.delete(sessionKey);
    }
  });
  chatHistoryAssemblyInflight.set(sessionKey, job);
  return job;
}

function presentChatHistory(rawMessages) {
  return dedupeForwardHistoryMessages(convertHistoryMessages(rawMessages || []));
}

async function loadChatHistoryForSession(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key) {
    return { ok: false, error: '未指定 session' };
  }
  try {
    const client = ensureGateway();
    await client.waitForConnect();
    // 后台预热别的通道仍只取最新一页；正在看的这一路要全量，避免转发刷新把界面又切短。
    const rawMessages = key === getSessionKey()
      ? await loadDisplayChatHistory(client, key)
      : (await client.request('chat.history', {
        sessionKey: key,
        limit: CHAT_HISTORY_PAGE_LIMIT,
        maxChars: CHAT_HISTORY_TEXT_MAX_CHARS,
      }))?.messages;
    return {
      ok: true,
      sessionKey: key,
      messages: presentChatHistory(rawMessages),
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
    const rawMessages = await loadDisplayChatHistory(client, sessionKey);
    return {
      ok: true,
      sessionKey,
      sessionKeyChanged: false,
      messages: presentChatHistory(rawMessages),
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

async function forwardMessageToAgents({ agentIds, message, dedupeScope } = {}) {
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

  const meetingForward = isMeetingForwardScope(dedupeScope);
  const scope = buildForwardDedupeScope(ids, trimmed, dedupeScope);
  const inFlightKey = meetingForward ? scope : buildManualForwardAttemptKey();

  if (meetingForward) {
    pruneRecentForwardScopes();
    loadForwardSentRegistry();
    const recentTs = recentForwardScopes.get(scope);
    if (recentTs && Date.now() - recentTs < FORWARD_DEDUP_MS) {
      return { ok: true, deduped: true, results: [] };
    }
    if (ids.every((agentId) => isForwardAlreadySent(agentId, scope) || isForwardBodyAlreadySent(agentId, trimmed))) {
      return { ok: true, deduped: true, results: [] };
    }
  }

  if (forwardInFlight.has(inFlightKey)) {
    return forwardInFlight.get(inFlightKey);
  }

  const work = (async () => {
    try {
      const client = ensureGateway();
      await client.waitForConnect();
      const result = await client.request('agents.list', {});
      const mainKey = result?.mainKey || 'main';
      const rawAgents = Array.isArray(result?.agents) ? result.agents : [];
      const targets = uniqueAgentsMatchingIds(rawAgents, ids);
      if (targets.length === 0) {
        return { ok: false, error: '未找到所选 Agent' };
      }
      const matchedEntryCount = rawAgents.filter((agent) => ids.includes(agent?.id)).length;
      if (matchedEntryCount > targets.length) {
        console.warn(
          `[qizi] forward: agents.list had ${matchedEntryCount} entries for ${targets.length} unique target(s); deduped before send`,
        );
      }

      const results = [];
      for (const agent of targets) {
        const sessionKey = shellSessionKeyForAgent(agent.id, mainKey);
        const idempotencyKey = meetingForward
          ? buildForwardIdempotencyKey(scope, agent.id)
          : `qizi-fwd-${inFlightKey}-${agent.id}`.slice(0, 120);
        if (meetingForward && (isForwardAlreadySent(agent.id, scope) || isForwardBodyAlreadySent(agent.id, trimmed))) {
          results.push({
            agentId: agent.id,
            sessionKey,
            ok: true,
            deduped: true,
            runId: idempotencyKey,
          });
          continue;
        }
        try {
          const ack = await client.request('chat.send', {
            sessionKey,
            message: trimmed,
            idempotencyKey,
            ...sendFieldsForSession(sessionKey),
          });
          const gatewayRunId = (ack && ack.runId) || idempotencyKey;
          debugEvent('session', 'forward_sent', {
            agentId: agent.id,
            sessionKey,
            runId: gatewayRunId,
            idempotencyKey,
          });
          if (meetingForward) {
            markForwardSent(agent.id, scope, trimmed);
          }
          watchForwardSession(sessionKey, agent.id, gatewayRunId);
          results.push({
            agentId: agent.id,
            sessionKey,
            ok: true,
            runId: gatewayRunId,
          });
        } catch (err) {
          results.push({
            agentId: agent.id,
            sessionKey,
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
      pruneForwardWatchState();
      if (meetingForward && failed.length === 0) {
        recentForwardScopes.set(scope, Date.now());
      }
      const newSends = results.filter((entry) => entry.ok && !entry.deduped);
      if (newSends.length > 0) {
        broadcastToRenderers('openclaw:forward-sent', {
          targets: newSends.map((entry) => ({
            agentId: entry.agentId,
            sessionKey: entry.sessionKey,
            runId: entry.runId,
          })),
        });
      }
      return {
        ok: true,
        deduped: newSends.length === 0,
        results,
      };
    } catch (err) {
      return { ok: false, error: formatGatewayError(err) };
    } finally {
      forwardInFlight.delete(inFlightKey);
    }
  })();

  forwardInFlight.set(inFlightKey, work);
  return work;
}

async function streamChat(event, { message, attachments, runId, priorAssistantText: priorFromRenderer, sessionKey: requestedSessionKey }) {
  const client = ensureGateway();
  await client.waitForConnect();

  const priorAssistantText = typeof priorFromRenderer === 'string' ? priorFromRenderer : '';
  const sessionKey = String(requestedSessionKey || '').trim() || getSessionKey();

  const idempotencyKey = `qizi-${runId}-${Date.now()}`;

  return new Promise((resolve) => {
    registerActiveRun(runId, idempotencyKey, {
      gatewayRunId: idempotencyKey,
      sender: event.sender,
      sessionKey,
      fullText: '',
      priorAssistantText,
      committedInRunText: '',
      sawToolActivity: false,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      stableHistoryPolls: 0,
      quietPolls: 0,
      backgroundPollInflight: false,
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
    }

    void (async () => {
      try {
        const ack = await client.request('chat.send', {
          sessionKey,
          message: message || '',
          idempotencyKey,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          ...sendFieldsForSession(sessionKey),
        });

        const gatewayRunId = (ack && ack.runId) || idempotencyKey;
        const activeRun = activeRuns.get(runId);
        if (activeRun && activeRun.gatewayRunId !== gatewayRunId) {
          gatewayRunIndex.delete(activeRun.gatewayRunId);
          activeRun.gatewayRunId = gatewayRunId;
          gatewayRunIndex.set(gatewayRunId, runId);
        }

      } catch (err) {
        if (activeRuns.has(runId)) {
          finishClientRun(runId, { error: formatGatewayError(err) });
        } else {
          resolve({ ok: false, error: formatGatewayError(err) });
        }
      }
    })();
  });
}

ipcMain.handle('openclaw:check', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return checkConnection();
});
ipcMain.handle('openclaw:settings:get', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getSettingsSnapshot();
});
ipcMain.handle('openclaw:settings:test', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return testGatewaySettings(payload || {});
});
ipcMain.handle('openclaw:settings:save', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    const current = loadShellSettings();
    const wsUrl = typeof payload?.wsUrl === 'string' ? payload.wsUrl.trim() : current.wsUrl;
    const tokenInput = typeof payload?.token === 'string' ? payload.token.trim() : '';
    const token = tokenInput || current.token;
    const tokenless = payload?.tokenless === true;
    if (!wsUrl) return { ok: false, error: '请填写 WSS 地址' };
    if (!tokenless && !token) return { ok: false, error: '请填写 Gateway Token' };
    saveShellSettings({
      wsUrl,
      token,
      tokenless,
      launchAtLogin: payload?.launchAtLogin === true,
      showMainOnLaunch: payload?.showMainOnLaunch !== false,
      messageSoundEnabled: payload?.messageSoundEnabled === true,
      messageSoundId: payload?.messageSoundId,
    });
    restartGatewayAfterSettings();
    return { ok: true, snapshot: getSettingsSnapshot() };
  } catch (err) {
    return { ok: false, error: err.message || '保存失败' };
  }
});
ipcMain.handle('openclaw:debug:get', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return {
    ok: true,
    mode: getRuntimeDebugMode(),
    source: ENV_DEBUG_MODE ? 'env' : 'settings',
  };
});
ipcMain.handle('openclaw:debug:set', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const requested = normalizeDebugMode(payload?.mode || payload);
  const result = applyRuntimeDebugMode(requested, { persist: true });
  debugEvent('session', 'debug_mode_set', {
    requested,
    mode: result.mode,
    source: result.source,
  });
  return result;
});
ipcMain.handle('openclaw:open-settings', () => {
  openSettings();
  return { ok: true };
});

ipcMain.handle('openclaw:open-about', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  openAbout();
  return { ok: true };
});

ipcMain.handle('qizi-meeting:open-help', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  openMeetingHelp();
  return { ok: true };
});

ipcMain.handle('qizi-meeting:help:copy', (event, text) => {
  if (!getAuthorizedMeetingHelpWindow(event)) return forbiddenSenderResult();
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('openclaw:open-update', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  openUpdate();
  return { ok: true };
});

ipcMain.handle('qizi-update:version', (event) => {
  if (!getAuthorizedUpdateWindow(event)) return forbiddenSenderResult();
  const { version } = require('./package.json');
  return version;
});

ipcMain.handle('qizi-update:check', async (event) => {
  if (!getAuthorizedUpdateWindow(event)) return forbiddenSenderResult();
  const { version } = require('./package.json');
  try {
    const result = await checkForUpdate(version);
    pendingUpdateInfo = result.updateAvailable ? result : null;
    return result;
  } catch (err) {
    pendingUpdateInfo = null;
    return { ok: false, error: err.message || '检查更新失败' };
  }
});

ipcMain.handle('qizi-update:install', async (event) => {
  if (!getAuthorizedUpdateWindow(event)) return forbiddenSenderResult();
  if (!pendingUpdateInfo?.updateAvailable || !pendingUpdateInfo.downloadUrl) {
    return { ok: false, error: '没有可安装的更新' };
  }
  try {
    await downloadAndInstallUpdate(pendingUpdateInfo, ({ received, total }) => {
      safeSendTo(event.sender, 'qizi-update:progress', { received, total });
    }, { updaterPid: process.pid });
    isQuitting = true;
    app.quit();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '升级失败' };
  }
});

function normalizeMeetingPresetInput(raw) {
  const topic = String(raw?.topic || '').trim();
  if (!topic) return { ok: false, error: '请填写议题' };
  const moderatorAgentId = String(raw?.moderatorAgentId || '').trim();
  if (!moderatorAgentId) return { ok: false, error: '请选择主持 Agent' };
  const participantAgentIds = Array.isArray(raw?.participantAgentIds)
    ? raw.participantAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (!participantAgentIds.length) return { ok: false, error: '请至少选择一名议事 Agent' };
  const roundCount = Number(raw?.roundCount);
  return {
    ok: true,
    preset: {
      topic,
      goal: String(raw?.goal || '').trim(),
      draft: String(raw?.draft || '').trim(),
      readingReport: String(raw?.readingReport || '').trim(),
      postMeetingExecAgentId: String(raw?.postMeetingExecAgentId || '').trim(),
      postMeetingExecLabel: String(raw?.postMeetingExecLabel || '').trim(),
      moderatorAgentId,
      moderatorLabel: String(raw?.moderatorLabel || '').trim(),
      participantAgentIds,
      participantLabels: participantAgentIds.map((id, index) => {
        const label = Array.isArray(raw?.participantLabels) ? raw.participantLabels[index] : '';
        return String(label || '').trim() || id;
      }),
      roundCount: roundCount === 1 || roundCount === 3 ? roundCount : 2,
      noRepeatPastTopics: Boolean(raw?.noRepeatPastTopics),
      savedAtMs: Date.now(),
    },
  };
}

async function requestMeetingGateway(method, params) {
  const client = await withMeetingPresetClient();
  return client.request(method, params);
}

async function withMeetingPresetClient() {
  const client = ensureGateway();
  await client.waitForConnect();
  return client;
}

async function listMeetingPresets() {
  try {
    const client = await withMeetingPresetClient();
    const listed = await client.request('qizi.meetings.list', {});
    const meetings = Array.isArray(listed?.meetings) ? listed.meetings : [];
    const loaded = await Promise.all(meetings.map(async (entry) => {
      const id = String(entry?.id || '').trim();
      if (!PRESET_ID_RE.test(id)) return null;
      try {
        const got = await client.request('qizi.meetings.get', { id });
        return presetFromMarkdown(got?.markdown || '', id);
      } catch (err) {
        console.warn('[qizi] 读取会议参数失败', id, err.message);
        return null;
      }
    }));
    const presets = loaded.filter(Boolean);
    presets.sort((a, b) => b.savedAtMs - a.savedAtMs);
    return { ok: true, presets };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err), presets: [] };
  }
}

async function checkReadingReportOnGateway(readingReport) {
  const prepared = prepareReadingReportPath(readingReport);
  if (!prepared.ok || !prepared.path) return prepared;
  try {
    const result = await requestMeetingGateway('qizi.files.stat', { path: prepared.path });
    const resolved = String(result?.path || '').trim();
    if (!resolved.startsWith('/')) {
      return { ok: false, error: '网关没有返回阅读报告的绝对路径' };
    }
    return { ok: true, path: resolved };
  } catch (err) {
    if (isMissingGatewayMethod(err)) {
      return {
        ok: false,
        error: '网关还不能检查服务器上的文件。请在 OpenClaw 网关的 qizi-meetings 插件里补上 qizi.files.stat，然后重启网关。',
      };
    }
    const message = formatGatewayError(err);
    return { ok: false, error: message || `无法在网关上确认阅读报告：${prepared.path}` };
  }
}

async function saveMeetingPreset(raw) {
  const normalized = normalizeMeetingPresetInput(raw);
  if (!normalized.ok) return normalized;
  const preset = normalized.preset;
  const report = await checkReadingReportOnGateway(preset.readingReport);
  if (!report.ok) return report;
  preset.readingReport = report.path;
  const id = meetingPresetId(preset.topic);
  const markdown = buildMeetingPresetMarkdown({ ...preset, id });
  try {
    const client = await withMeetingPresetClient();
    const result = await client.request('qizi.meetings.put', { id, markdown });
    return { ok: true, preset: { ...preset, id }, bytes: result?.bytes };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function loadMeetingRequirements(topic) {
  const key = String(topic || '').trim();
  if (!key) return { ok: false, error: '请填写议题' };
  const id = meetingPresetId(key);
  try {
    const client = await withMeetingPresetClient();
    const got = await client.request('qizi.meetings.get', { id });
    const markdown = got?.markdown || '';
    const parsed = parseMeetingRequirementSections(markdown);
    if (!parsed.ok) return { ok: false, error: parsed.error || '读取会议要求失败' };
    const preset = presetFromMarkdown(markdown, id);
    if (!preset) return { ok: false, error: '已保存的会议参数不完整' };
    return { ok: true, sections: parsed.sections, preset };
  } catch (err) {
    const message = formatGatewayError(err);
    if (/not found|no such|enoent|missing|不存在|未找到/i.test(message)) {
      return { ok: false, error: '未找到已保存的会议，请先保存再开始' };
    }
    return { ok: false, error: message ? `读取会议要求失败：${message}` : '读取会议要求失败' };
  }
}

async function deleteMeetingPreset(raw) {
  const topic = String(raw?.topic || '').trim();
  const givenId = String(raw?.id || '').trim();
  const id = PRESET_ID_RE.test(givenId) ? givenId : meetingPresetId(topic);
  if (!PRESET_ID_RE.test(id)) return { ok: false, error: '请填写议题' };
  try {
    const client = await withMeetingPresetClient();
    const result = await client.request('qizi.meetings.delete', { id });
    if (result?.deleted === false) return { ok: false, error: '未找到已保存的会议' };
    return { ok: true, id, topic, deleted: true };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

ipcMain.handle('qizi-meeting:presets:list', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return listMeetingPresets();
});

ipcMain.handle('qizi-meeting:presets:save', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return saveMeetingPreset(payload || {});
});

ipcMain.handle('qizi-meeting:check-reading-report', async (event, filePath) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return checkReadingReportOnGateway(filePath);
});

ipcMain.handle('qizi-meeting:presets:delete', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return deleteMeetingPreset(payload || {});
});

function isMissingSavedMeetingError(error) {
  return /未找到已保存的会议/.test(String(error || ''));
}

function catalogAgentLabel(catalog, agentId, fallback) {
  const id = String(agentId || '').trim();
  if (!id) return '';
  const entry = (catalog || []).find((agent) => agent.id === id);
  return String(fallback || entry?.label || entry?.name || id).trim();
}

async function resolveMeetingLaunch(config) {
  const topic = String(config?.topic || '').trim();
  const loaded = await loadMeetingRequirements(topic);
  if (!loaded.ok && !isMissingSavedMeetingError(loaded.error)) return loaded;
  const savedReady = loaded.ok && unsavedMeetingParameters(config, loaded.preset).length === 0;
  if (savedReady) {
    const report = await checkReadingReportOnGateway(loaded.preset.readingReport);
    if (!report.ok) return report;
    return {
      ok: true,
      config: {
        ...(config || {}),
        topic: loaded.preset.topic,
        draft: String(config?.draft || '').trim(),
        savedDraft: loaded.preset.draft == null ? '' : loaded.preset.draft,
        goal: loaded.preset.goal,
        readingReport: report.path,
        participantLabels: loaded.preset.participantLabels,
        postMeetingExecLabel: loaded.preset.postMeetingExecLabel,
        postMeetingExecAgentId: loaded.preset.postMeetingExecAgentId,
        moderatorAgentId: loaded.preset.moderatorAgentId,
        moderatorLabel: loaded.preset.moderatorLabel || config?.moderatorLabel,
        participantAgentIds: loaded.preset.participantAgentIds,
        roundCount: loaded.preset.roundCount,
        noRepeatPastTopics: loaded.preset.noRepeatPastTopics,
        meetingRequirements: loaded.sections,
        ephemeral: false,
      },
    };
  }

  const report = await checkReadingReportOnGateway(config?.readingReport);
  if (!report.ok) return report;
  const parsed = parseMeetingRequirementSections(
    `---\ntopic: "t"\n---\n${buildMeetingRequirementSections(report.path)}`,
  );
  if (!parsed.ok) return { ok: false, error: parsed.error || '无法准备会议要求' };
  const catalog = config?.agentCatalog || [];
  const participantAgentIds = Array.isArray(config?.participantAgentIds)
    ? config.participantAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const roundCount = Number(config?.roundCount);
  return {
    ok: true,
    config: {
      ...(config || {}),
      topic,
      draft: String(config?.draft || '').trim(),
      savedDraft: '',
      goal: String(config?.goal || '').trim(),
      readingReport: report.path,
      participantAgentIds,
      participantLabels: participantAgentIds.map((id, index) => catalogAgentLabel(
        catalog,
        id,
        Array.isArray(config?.participantLabels) ? config.participantLabels[index] : '',
      )),
      postMeetingExecAgentId: String(config?.postMeetingExecAgentId || '').trim(),
      postMeetingExecLabel: catalogAgentLabel(catalog, config?.postMeetingExecAgentId, config?.postMeetingExecLabel),
      moderatorAgentId: String(config?.moderatorAgentId || '').trim(),
      moderatorLabel: catalogAgentLabel(catalog, config?.moderatorAgentId, config?.moderatorLabel),
      roundCount: roundCount === 1 || roundCount === 3 ? roundCount : 2,
      noRepeatPastTopics: Boolean(config?.noRepeatPastTopics),
      meetingRequirements: parsed.sections,
      ephemeral: true,
    },
  };
}

ipcMain.handle('qizi-meeting:start', async (event, config) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    if (meetingBriefingRunning || (meetingEngine && meetingEngine.running)) {
      return { ok: false, error: '已有会议在进行中' };
    }
    const launch = await resolveMeetingLaunch(config);
    if (!launch.ok) return launch;
    void runMeetingBriefingFlow(launch.config);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '无法启动会议' };
  }
});

ipcMain.handle('qizi-meeting:cancel', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  meetingBriefingCancelled = true;
  if (meetingEngine) meetingEngine.cancel();
  let forwardResult = null;
  if (activeMeetingForwardConfig?.postMeetingExecAgentId && activeMeetingTranscript.length > 0) {
    forwardResult = await maybeForwardMeetingConclusion(
      activeMeetingForwardConfig,
      activeMeetingTranscript,
      activeMeetingMeta?.meetingId,
    );
  }
  clearActiveMeeting();
  for (const [runId, run] of [...pendingMeetingRuns.entries()]) {
    if (run.timeout) clearTimeout(run.timeout);
    run.reject(new Error('会议已取消'));
    pendingMeetingRuns.delete(runId);
  }
  if (forwardResult) {
    broadcastMeetingEvent({ type: 'post_meeting_forward', payload: forwardResult });
  }
  broadcastMeetingEvent({ type: 'cancelled', payload: {} });
  return { ok: true };
});

ipcMain.handle('qizi-meeting:send-owner-note', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const text = String(payload?.text || '').trim();
  if (!text) return { ok: false, error: '消息不能为空' };
  if (!meetingBriefingRunning) return { ok: false, error: '会议未进行中' };
  if (!activeMeetingRelay?.appendOwnerNote) return { ok: false, error: '会议尚未就绪' };
  if (!activeMeetingSessionKey) return { ok: false, error: '会议 session 未就绪' };
  try {
    activeMeetingRelay.appendOwnerNote(text);
    await injectMeetingChatMessage(activeMeetingSessionKey, text, '老大');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('qizi-meeting:status', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return {
    ok: true,
    snapshot: {
      mode: 'a2a_transcript_v1',
      running: meetingBriefingRunning || Boolean(meetingEngine?.running),
    },
  };
});

ipcMain.handle('qizi-meeting:list-records', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    return await listFinishedMeetings(requestMeetingGateway, 10);
  } catch (err) {
    return { ok: false, error: err.message || String(err), records: [] };
  }
});

ipcMain.handle('qizi-meeting:prior-topics', async (event, topic) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    const entries = (await listPriorSummaries(requestMeetingGateway, topic)).map((entry) => ({
      meetingId: entry.meetingId,
      finishedAt: entry.finishedAt,
      excerpt: priorTopicExcerpt(entry.finalSummary),
    }));
    return { ok: true, count: entries.length, entries };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('qizi-meeting:load-record', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    const record = await loadFinishedMeeting(requestMeetingGateway, payload || {});
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('qizi-meeting:load-history', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const sessionKey = payload?.sessionKey || activeMeetingSessionKey;
  const meta = payload?.meta || activeMeetingMeta;
  if (!sessionKey || !meta) {
    return { ok: false, error: '没有进行中的会议' };
  }
  try {
    const messages = await fetchMeetingHistory(sessionKey, meta);
    return { ok: true, sessionKey, messages };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('qizi-meeting:exit', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  clearActiveMeeting();
  return { ok: true };
});

ipcMain.handle('openclaw:open-control', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return openOpenClawControl();
});

ipcMain.handle('openclaw:quit', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  isQuitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle('openclaw:stt:status', () => getSttStatus());

ipcMain.handle('openclaw:stt:install', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const sender = event.sender;
  return installStt((payload) => {
    safeSendTo(sender, 'openclaw:stt:progress', payload);
  });
});

ipcMain.handle('openclaw:stt:uninstall', () => uninstallStt());

ipcMain.handle('openclaw:stt:transcribe', async (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const audioPath = payload?.audioPath;
  if (audioPath) {
    if (!isAllowedSttAudioPath(audioPath)) {
      return { ok: false, error: '音频路径无效' };
    }
    if (fs.existsSync(audioPath)) {
      return transcribeAudioFile(audioPath);
    }
    return { ok: false, error: '音频文件不存在' };
  }
  const data = payload?.data;
  const ext = payload?.ext || 'webm';
  if (!data || typeof data !== 'string') {
    return { ok: false, error: '缺少音频数据' };
  }
  let tmp;
  try {
    tmp = await tmpFile({ postfix: `.${ext.replace(/^\./, '')}` });
    fs.writeFileSync(tmp.path, Buffer.from(data, 'base64'));
    return await transcribeAudioFile(tmp.path);
  } catch (err) {
    return { ok: false, error: err.message || '识别失败' };
  } finally {
    if (tmp?.cleanup) {
      try {
        await tmp.cleanup();
      } catch {
        // ignore
      }
    }
  }
});

const CHANNEL_SOURCE_FRESH_MS = 60 * 1000;
const CHANNEL_SOURCE_STALE_MS = 10 * 60 * 1000;
let channelSourceCache = { at: 0, source: null };
let channelSourceInflight = null;

async function refreshPrivateChannelSource(client) {
  if (channelSourceInflight) return channelSourceInflight;
  channelSourceInflight = (async () => {
    await client.waitForConnect();
    const [status, cfg, agents] = await Promise.all([
      client.request('channels.status', { probe: false }),
      client.request('config.get', {}),
      client.request('agents.list', {}),
    ]);
    let sessions = [];
    try {
      const listed = await client.request('sessions.list', {
        limit: 500,
        includeGlobal: true,
        includeUnknown: true,
      });
      sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
    } catch {
      sessions = [];
    }
    const config = cfg?.config || {};
    const source = {
      dmScope: config.session?.dmScope,
      hash: typeof cfg?.hash === 'string' ? cfg.hash : '',
      bindings: Array.isArray(config.bindings) ? config.bindings : [],
      channelStatus: status || {},
      sessions,
      defaultAgentId: agents?.defaultId || 'main',
      mainKey: agents?.mainKey || SHELL_SESSION_MAIN_KEY,
    };
    channelSourceCache = { at: Date.now(), source };
    broadcastToRenderers('openclaw:private-channel-updated', { at: channelSourceCache.at });
    return source;
  })().finally(() => {
    channelSourceInflight = null;
  });
  return channelSourceInflight;
}

async function loadPrivateChannelSource(client) {
  const age = channelSourceCache.source ? Date.now() - channelSourceCache.at : Infinity;
  if (channelSourceCache.source && age < CHANNEL_SOURCE_FRESH_MS) return channelSourceCache.source;
  if (channelSourceCache.source && age < CHANNEL_SOURCE_STALE_MS) {
    void refreshPrivateChannelSource(client);
    return channelSourceCache.source;
  }
  return refreshPrivateChannelSource(client);
}

function warmPrivateChannelSource() {
  if (!gateway?.connected) return;
  const age = channelSourceCache.source ? Date.now() - channelSourceCache.at : Infinity;
  if (age < CHANNEL_SOURCE_FRESH_MS || channelSourceInflight) return;
  void refreshPrivateChannelSource(gateway).catch((err) => {
    console.warn('[qizi] channel source warm failed:', err.message);
  });
}

const BACKGROUND_RUN_POLL_MS = 2500;
let backgroundRunPollTimer = null;

function ensureBackgroundRunPoll() {
  if (backgroundRunPollTimer) return;
  backgroundRunPollTimer = setInterval(() => {
    void pollBackgroundOwnedRuns();
  }, BACKGROUND_RUN_POLL_MS);
  backgroundRunPollTimer.unref?.();
}

async function pollBackgroundOwnedRuns() {
  const client = gateway;
  if (!client?.connected) return;
  const current = getSessionKey();
  for (const [clientRunId, run] of activeRuns.entries()) {
    const onScreen = !run.sessionKey || run.sessionKey === current;
    if (onScreen && !run.sawToolActivity && !run.sawChatFinal) continue;
    if (run.backgroundPollInflight) continue;
    const quietMs = onScreen ? 2000 : 3000;
    if (Date.now() - (run.lastEventAt || 0) < quietMs) continue;
    const observedAt = run.lastEventAt || 0;
    run.backgroundPollInflight = true;
    try {
      const result = await client.request('chat.history', {
        sessionKey: run.sessionKey || current,
        limit: 40,
        maxChars: CHAT_HISTORY_TEXT_MAX_CHARS,
      });
      if (!activeRuns.has(clientRunId)) continue;
      if (onScreen && (run.lastEventAt || 0) !== observedAt) {
        run.quietPolls = 0;
        continue;
      }
      const msgs = convertHistoryMessages(result?.messages || []);
      const latest = [...msgs].reverse().find((item) => item.who === 'them' && String(item.text || '').trim());
      const text = latest?.text || '';
      if (!onScreen && text && text !== run.fullText && text.length >= String(run.fullText || '').length) {
        run.fullText = text;
        run.lastEventAt = Date.now();
        sendStreamDeltaToRenderer(run, clientRunId, run.fullText, true);
      }
      const info = result?.sessionInfo;
      const gatewayIdle = info && info.hasActiveRun === false;
      const replyAlreadyFinal = run.sawChatFinal === true;
      if ((gatewayIdle || replyAlreadyFinal) && Date.now() - (run.startedAt || 0) > 4000) {
        run.quietPolls = (run.quietPolls || 0) + 1;
        const needQuietPolls = (onScreen && (run.sawChatFinal || run.sawToolResult)) ? 1 : 2;
        if (run.quietPolls >= needQuietPolls) {
          finishClientRun(clientRunId, { ok: true, text: run.fullText || text });
        }
      } else {
        run.quietPolls = 0;
      }
    } catch (err) {
      debugEvent('session', 'background_run_poll_failed', { error: err.message || String(err) });
    } finally {
      if (activeRuns.get(clientRunId) === run) run.backgroundPollInflight = false;
    }
  }
}

const SHELL_WARM_MS = 20 * 1000;
let shellWarmTimer = null;
let shellWarmStep = 0;
let modelWarmCursor = 0;
let modelWarmBusy = false;

function currentSessionHasOwnedRun() {
  const current = getSessionKey();
  for (const run of activeRuns.values()) {
    if (!run.sessionKey || run.sessionKey === current) return true;
  }
  return false;
}

async function warmOneStaleModel() {
  if (modelWarmBusy) return;
  modelWarmBusy = true;
  try {
  const agents = agentListCache.data?.agents || [];
  const currentId = parseAgentIdFromSessionKey(getSessionKey());
  const ids = [];
  if (currentId) ids.push(currentId);
  for (const agent of agents) {
    if (agent?.id && agent.id !== currentId) ids.push(agent.id);
  }
  if (!ids.length) return;
  for (let offset = 0; offset < ids.length; offset += 1) {
    const id = ids[(modelWarmCursor + offset) % ids.length];
    const entry = modelListByAgent.get(id);
    const age = entry ? Date.now() - entry.at : Infinity;
    if (age < MODEL_LIST_FRESH_MS || modelRefreshInflight.has(id)) continue;
    modelWarmCursor = (modelWarmCursor + offset + 1) % ids.length;
    await refreshModelListForAgent(id);
    return;
  }
  } finally {
    modelWarmBusy = false;
  }
}

function ensureShellWarmTimer() {
  if (shellWarmTimer) return;
  shellWarmTimer = setInterval(() => {
    void tickShellWarm();
  }, SHELL_WARM_MS);
  shellWarmTimer.unref?.();
  setTimeout(() => {
    void tickShellWarm();
  }, 2500);
}

async function tickShellWarm() {
  if (!gateway?.connected || currentSessionHasOwnedRun()) return;
  shellWarmStep += 1;
  try {
    if (shellWarmStep % 2 === 0) warmPrivateChannelSource();
    else await warmOneStaleModel();
  } catch (err) {
    console.warn('[qizi] shell warm failed:', err.message);
  }
}

async function getPrivateChannelCatalog(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: '未指定 Agent' };
  try {
    const client = ensureGateway();
    const source = await loadPrivateChannelSource(client, id);
    const catalog = buildPrivateChannelCatalog({
      agentId: id,
      defaultAgentId: source.defaultAgentId,
      mainKey: source.mainKey,
      dmScope: source.dmScope,
      channelStatus: source.channelStatus,
      bindings: source.bindings,
      sessions: source.sessions,
      savedChoice: getPrivateChannels().getChoice(id),
    });
    return {
      ok: true,
      agentId: id,
      selectedId: catalog.selectedId,
      options: catalog.options.map(publicChannelOption),
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

async function ensurePrivateChannelDmScope(client, needed, baseHash) {
  const target = normalizeDmScope(needed);
  if (target === 'main') return false;
  try {
    const patched = await client.request('config.patch', {
      raw: JSON.stringify({ session: { dmScope: target } }),
      baseHash,
    });
    return patched?.noop !== true;
  } catch (err) {
    try {
      await client.waitForConnect();
    } catch {
      // 配置可能已经写上，连接正在重来
    }
    const again = await client.request('config.get', {});
    const now = normalizeDmScope(again?.config?.session?.dmScope);
    if (dmScopeRank(now) < dmScopeRank(target)) throw err;
    return true;
  }
}

async function setPrivateChannelChoice(agentId, choiceId) {
  const id = String(agentId || '').trim();
  const picked = String(choiceId || '').trim();
  if (!id || !picked) return { ok: false, error: '请选择一个私聊通道' };
  try {
    const client = ensureGateway();
    const source = await loadPrivateChannelSource(client, id);
    const catalog = buildPrivateChannelCatalog({
      agentId: id,
      defaultAgentId: source.defaultAgentId,
      mainKey: source.mainKey,
      dmScope: source.dmScope,
      channelStatus: source.channelStatus,
      bindings: source.bindings,
      sessions: source.sessions,
      savedChoice: getPrivateChannels().getChoice(id),
    });
    const option = catalog.options.find((item) => item.id === picked);
    if (!option || option.selectable !== true) {
      return { ok: false, error: '这个选项现在不能用' };
    }
    let scopeChanged = false;
    if (option.mode === 'channel') {
      const current = normalizeDmScope(source.dmScope);
      const needed = normalizeDmScope(option.dmScope);
      if (dmScopeRank(current) < dmScopeRank(needed)) {
        if (!source.hash) return { ok: false, error: '网关配置暂时不能改，请稍后再试' };
        scopeChanged = await ensurePrivateChannelDmScope(client, needed, source.hash);
        try {
          await client.waitForConnect();
        } catch {
          // 订阅时再等
        }
      }
      getPrivateChannels().setChoice(id, option);
    } else {
      getPrivateChannels().setChoice(id, null);
    }
    if (scopeChanged) channelSourceCache = { at: 0, source: null };
    const sessionKey = shellSessionKeyForAgent(id, source.mainKey);
    const viewingThisAgent = parseAgentIdFromSessionKey(getSessionKey()) === id;
    if (viewingThisAgent) {
      persistSessionKey(sessionKey);
      await ensureGatewaySessionSubscription(client);
    }
    return {
      ok: true,
      agentId: id,
      sessionKey,
      appliedToOpenChat: viewingThisAgent,
      scopeChanged,
      label: option.label,
      shellSessionKeys: getPrivateChannels().shellSessionKeys([id], source.mainKey),
    };
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
}

ipcMain.handle('openclaw:getSessionKey', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getSessionKey();
});
ipcMain.handle('openclaw:agents:list', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const result = await listAgents();
  if (!result?.ok) return result;
  const ids = (result.agents || []).map((agent) => agent?.id).filter(Boolean);
  return {
    ...result,
    shellSessionKeys: getPrivateChannels().shellSessionKeys(ids, result.mainKey || SHELL_SESSION_MAIN_KEY),
  };
});
ipcMain.handle('openclaw:private-channel:get', (event, agentId) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getPrivateChannelCatalog(agentId);
});
ipcMain.handle('openclaw:private-channel:set', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return setPrivateChannelChoice(payload?.agentId, payload?.choiceId);
});
ipcMain.handle('openclaw:forward', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return forwardMessageToAgents(payload || {});
});
ipcMain.handle('openclaw:session:switch', (event, agentId) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return switchToAgent(agentId);
});
ipcMain.handle('openclaw:history', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return loadChatHistory();
});
ipcMain.handle('openclaw:history:session', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return loadChatHistoryForSession(payload?.sessionKey);
});
ipcMain.handle('openclaw:models:list', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return listModels();
});
ipcMain.handle('openclaw:models:current', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getCurrentModel();
});
ipcMain.handle('openclaw:session:info', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getSessionInfo();
});
ipcMain.handle('openclaw:models:set', (event, qualifiedModel) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return setSessionModel(qualifiedModel);
});
ipcMain.handle('openclaw:session:controls', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getSessionControls();
});
ipcMain.handle('openclaw:session:controls:patch', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return patchSessionControls(payload || {});
});
ipcMain.handle('openclaw:session:permission', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return getSessionPermission();
});
ipcMain.handle('openclaw:session:permission:set', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return setSessionPermission(payload?.mode);
});
ipcMain.handle('openclaw:abort', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const client = gateway;
  const sessionKey = getSessionKey();
  const runs = [...activeRuns.entries()].filter(([, run]) => !run.sessionKey || run.sessionKey === sessionKey);

  if (client?.connected) {
    if (runs.length > 0) {
      await Promise.allSettled(
        runs.map(([, run]) =>
          client.request('chat.abort', {
            sessionKey: run.sessionKey || sessionKey,
            runId: run.gatewayRunId,
          }),
        ),
      );
    } else {
      try {
        await client.request('chat.abort', { sessionKey });
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
  const win = getAuthorizedMainWindow(event);
  if (!win) return forbiddenSenderResult();
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

ipcMain.handle('openclaw:export:word', async (event, payload) => {
  const win = getAuthorizedMainWindow(event) || getAuthorizedHistoryWindow(event);
  if (!win) return forbiddenSenderResult();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (!entries.length) return { ok: false, error: '没有可导出的消息' };
  if (entries.some((entry) => typeof entry?.html === 'string' && entry.html.trim())) {
    return { ok: false, error: '导出格式无效' };
  }
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
  const win = getAuthorizedMainWindow(event);
  if (!win) return forbiddenSenderResult();
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

function captureInteractiveScreenshot() {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `qizi-shot-${Date.now()}.png`);
    const proc = spawn('screencapture', ['-i', '-x', '-t', 'png', tmpFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `无法启动 screencapture: ${err.message}` });
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, canceled: true });
        return;
      }
      try {
        const buf = fs.readFileSync(tmpFile);
        const base64 = buf.toString('base64');
        try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
        resolve({
          ok: true,
          dataUrl: `data:image/png;base64,${base64}`,
          size: buf.length,
          name: 'screenshot.png',
        });
      } catch (err) {
        resolve({ ok: false, error: `读取截屏失败: ${err.message}` });
      }
    });
  });
}

ipcMain.handle('openclaw:screenshot', async (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return captureInteractiveScreenshot();
});

ipcMain.handle('openclaw:normalize-image', async (event, dataUrl) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
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

ipcMain.handle('openclaw:history:open', (event, context) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  openHistoryWindow(context || {});
  return { ok: true };
});

ipcMain.handle('openclaw:history:context', (event) => {
  if (!getAuthorizedHistoryWindow(event)) return null;
  return historyWindowContext;
});

ipcMain.handle('openclaw:history:read-local', async (event, payload) => {
  if (!getAuthorizedHistoryWindow(event)) return forbiddenSenderResult();
  const messages = await readLocalMessagesFromMainWindow(payload?.sessionKey);
  return { ok: true, messages };
});

ipcMain.handle('openclaw:archive:list', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return { ok: true, archives: messageArchive.list() };
});

ipcMain.handle('openclaw:archive:read', (event, sessionKey) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const key = String(sessionKey || '').trim().slice(0, 300);
  if (!key) return { ok: false, error: '未指定 session' };
  return { ok: true, messages: messageArchive.read(key) };
});

ipcMain.handle('openclaw:archive:write', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const key = String(payload?.sessionKey || '').trim().slice(0, 300);
  if (!key) return { ok: false, error: '未指定 session' };
  if (!Array.isArray(payload?.messages)) return { ok: false, error: '归档格式无效' };
  try {
    messageArchive.write(key, payload.messages);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || '写入失败' };
  }
});

const HISTORY_HANDOFF_ACTIONS = new Set(['quote', 'forward', 'start-meeting']);
const HISTORY_HANDOFF_MAX_CHARS = 2 * 1024 * 1024;

function historyHandoffText(value) {
  if (typeof value !== 'string') return '';
  if (value.length > HISTORY_HANDOFF_MAX_CHARS) return null;
  return value;
}

function historyHandoffLabel(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, 200);
}

function sanitizeHistoryForward(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = historyHandoffText(raw.text);
  if (text == null || !text.trim()) return null;
  return {
    preparedForward: true,
    isMergedForward: raw.isMergedForward === true,
    who: raw.who === 'me' ? 'me' : 'them',
    authorLabel: historyHandoffLabel(raw.authorLabel, '未知'),
    text,
    time: typeof raw.time === 'string' ? raw.time.slice(0, 80) : '',
    sentAtMs: Number.isFinite(raw.sentAtMs) ? raw.sentAtMs : undefined,
    sentTime: typeof raw.sentTime === 'string' ? raw.sentTime.slice(0, 80) : undefined,
  };
}

function sanitizeHistoryHandoff(payload) {
  const action = String(payload?.action || '');
  if (!HISTORY_HANDOFF_ACTIONS.has(action)) return null;
  if (action === 'quote') {
    const raw = payload?.quote;
    const text = historyHandoffText(raw?.text);
    if (!raw || text == null || !text.trim()) return null;
    return {
      action,
      quote: {
        who: raw.who === 'me' ? 'me' : 'them',
        authorLabel: historyHandoffLabel(raw.authorLabel, '未知'),
        text,
        time: typeof raw.time === 'string' ? raw.time.slice(0, 80) : '',
        sentAtMs: Number.isFinite(raw.sentAtMs) ? raw.sentAtMs : undefined,
        sentTime: typeof raw.sentTime === 'string' ? raw.sentTime.slice(0, 80) : undefined,
      },
    };
  }
  if (action === 'forward') {
    const forward = sanitizeHistoryForward(payload?.forward);
    if (!forward) return null;
    return {
      action,
      previewLabel: historyHandoffLabel(payload?.previewLabel, ''),
      forward,
    };
  }
  const draft = historyHandoffText(payload?.draft);
  if (draft == null || !draft.trim()) return null;
  return { action, draft };
}

ipcMain.handle('openclaw:history:message-action', (event, payload) => {
  if (!getAuthorizedHistoryWindow(event)) return forbiddenSenderResult();
  const handoff = sanitizeHistoryHandoff(payload);
  if (!handoff) return { ok: false, error: '没有可操作的内容' };
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不可用' };
  showMainWindow();
  safeSendTo(mainWindow.webContents, 'openclaw:history:message-action', handoff);
  return { ok: true };
});

ipcMain.handle('copy-edit:open', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const clean = sanitizeCopyEditPayload(payload);
  if (!clean) return { ok: false, error: '没有可编辑的文字' };
  return openCopyEditWindow(clean);
});

ipcMain.handle('agent-files:open', (event, payload) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return openAgentFilesWindow(payload || {});
});

ipcMain.handle('agent-files:context', (event) => {
  if (!getAuthorizedAgentFilesWindow(event)) return forbiddenSenderResult();
  return agentFilesContext || { agentId: '', agentLabel: '' };
});

ipcMain.on('agent-files:dirty', (event, dirty) => {
  if (!getAuthorizedAgentFilesWindow(event)) return;
  agentFilesDirty = dirty === true;
});

ipcMain.on('agent-files:save-result', (event, ok) => {
  if (!getAuthorizedAgentFilesWindow(event)) return;
  const wait = agentFilesSaveWait;
  agentFilesSaveWait = null;
  if (wait) wait(ok === true);
});

ipcMain.handle('agent-files:editor-pane', async (event, open) => {
  if (!getAuthorizedAgentFilesWindow(event)) return forbiddenSenderResult();
  return setAgentFilesEditorPane(open === true);
});

ipcMain.handle('agent-files:list', async (event) => {
  if (!getAuthorizedAgentFilesWindow(event)) return forbiddenSenderResult();
  try {
    const request = await agentFilesGateway();
    return await listAgentFileCatalog(request, agentFilesContext?.agentId);
  } catch (err) {
    return { ok: false, error: formatGatewayError(err), memories: [], skills: { global: [], private: [] } };
  }
});

ipcMain.handle('agent-files:read', async (event, file) => {
  if (!getAuthorizedAgentFilesWindow(event)) return forbiddenSenderResult();
  try {
    const request = await agentFilesGateway();
    return await readAgentFile(request, { ...(file || {}), agentId: agentFilesContext?.agentId });
  } catch (err) {
    if (err?.clientError) return { ok: false, error: err.message };
    return { ok: false, error: formatGatewayError(err) };
  }
});

ipcMain.handle('agent-files:save', async (event, payload) => {
  if (!getAuthorizedAgentFilesWindow(event)) return forbiddenSenderResult();
  try {
    const request = await agentFilesGateway();
    return await saveAgentFile(
      request,
      { ...(payload || {}), agentId: agentFilesContext?.agentId },
      path.join(app.getPath('userData'), 'agent-file-backups'),
    );
  } catch (err) {
    if (err?.clientError) return { ok: false, error: err.message };
    return { ok: false, error: formatGatewayError(err) };
  }
});

ipcMain.handle('copy-edit:open-from-history', (event, payload) => {
  if (!getAuthorizedHistoryWindow(event)) return { ok: false, error: '无权打开文案编辑' };
  const clean = sanitizeCopyEditPayload(payload, {
    sessionKey: historyWindowContext?.sessionKey || '',
    agentLabel: historyWindowContext?.agentLabel || '',
  });
  if (!clean) return { ok: false, error: '没有可编辑的文字' };
  return openCopyEditWindow(clean);
});

ipcMain.handle('copy-edit:payload', (event) => {
  if (!getAuthorizedCopyEditWindow(event)) return null;
  return copyEditPayload;
});

ipcMain.handle('copy-edit:send', async (event, payload) => {
  if (!getAuthorizedCopyEditWindow(event)) return { ok: false, error: '无权发送' };
  const text = typeof payload?.text === 'string' ? payload.text : '';
  if (!text.trim()) return { ok: false, error: '没有可发送的内容' };
  if (text.length > COPY_EDIT_MAX_CHARS * 2) return { ok: false, error: '修订内容太长' };
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不可用' };
  const sessionKey = typeof payload?.sessionKey === 'string' ? payload.sessionKey.slice(0, 300) : '';
  const draftId = typeof payload?.draftId === 'string' ? payload.draftId : '';
  showMainWindow();
  let result;
  try {
    result = await mainWindow.webContents.executeJavaScript(
      `window.qiziDeliverCopyEditPrompt(${JSON.stringify(text)}, ${JSON.stringify(sessionKey)})`,
    );
  } catch (err) {
    return { ok: false, error: err?.message || '发送失败' };
  }
  if (!result || typeof result !== 'object') return { ok: false, error: '发送失败' };
  if (result.ok) {
    removeCopyEditDraft(draftId);
    closeCopyEditWindowSoon();
  }
  return result;
});

ipcMain.handle('copy-edit:stash', (event, payload) => {
  if (!getAuthorizedCopyEditWindow(event)) return { ok: false, error: '无权暂存' };
  const draft = sanitizeCopyEditDraft(payload);
  if (!draft) return { ok: false, error: '修改内容太大，暂存不了' };
  const others = loadCopyEditDrafts().filter((item) => item.id !== draft.id);
  writeCopyEditDrafts([...others, draft].slice(-COPY_EDIT_MAX_DRAFTS));
  showMainWindow();
  closeCopyEditWindowSoon();
  return { ok: true, id: draft.id };
});

ipcMain.handle('copy-edit:discard', (event, payload) => {
  if (!getAuthorizedCopyEditWindow(event)) return { ok: false, error: '无权操作' };
  removeCopyEditDraft(typeof payload?.draftId === 'string' ? payload.draftId : '');
  closeCopyEditWindowSoon();
  return { ok: true };
});

ipcMain.handle('copy-edit:drafts:list', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  return { ok: true, drafts: copyEditDraftSummaries() };
});

ipcMain.handle('copy-edit:drafts:delete', (event, id) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  removeCopyEditDraft(typeof id === 'string' ? id : '');
  return { ok: true };
});

ipcMain.handle('copy-edit:drafts:open', (event, id) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  const draft = loadCopyEditDrafts().find((item) => item.id === id);
  if (!draft) return { ok: false, error: '这份暂存已经不在了' };
  return openCopyEditWindow({
    text: draft.originalText,
    sessionKey: draft.sessionKey,
    agentLabel: draft.agentLabel,
    draft,
  });
});

ipcMain.handle('openclaw:chat', async (event, { message, images, files, runId, priorAssistantText, sessionKey }) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
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
    return await streamChat(event, {
      message: outboundMessage,
      attachments,
      runId,
      priorAssistantText,
      sessionKey,
    });
  } catch (err) {
    const errMessage = formatGatewayError(err);
    safeSendTo(event.sender, 'openclaw:error', { runId, error: errMessage });
    return { ok: false, error: errMessage };
  }
});

ipcMain.handle('openclaw:btw:send', async (event, { message, images, files }) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  try {
    const imageList = Array.isArray(images) ? images : [];
    const fileList = Array.isArray(files) ? files : [];
    const attachments = await buildChatAttachments(imageList, fileList);
    return await sendDetachedBtwChat(event, { message, attachments });
  } catch (err) {
    return { ok: false, error: formatGatewayError(err) };
  }
});

const MAINTAINING_MIN_WIDTH = 440;
const MAINTAINING_MIN_HEIGHT = 502;
const MAINTAINING_DEFAULT_WIDTH = 480;
const MAINTAINING_DEFAULT_HEIGHT = 760;

function maintainingStatePath() {
  return path.join(app.getPath('userData'), 'maintaining-window-state.json');
}

function pushMaintaining(channel, payload) {
  if (!maintainingWindow || maintainingWindow.isDestroyed()) return;
  safeSendTo(maintainingWindow.webContents, channel, payload);
}

function getMaintainingSession() {
  if (!maintainingSession) {
    maintainingSession = new MaintainingSession(app.getPath('userData'));
    maintainingSession.on('status', (payload) => pushMaintaining('hermes:status', payload));
    maintainingSession.on('history', (messages) => pushMaintaining('hermes:history', messages));
    maintainingSession.on('stream', (payload) => pushMaintaining('hermes:stream', payload));
    maintainingSession.on('complete', (payload) => pushMaintaining('hermes:complete', payload));
    maintainingSession.on('turn-error', (payload) => pushMaintaining('hermes:turn-error', payload));
    maintainingSession.on('request', (payload) => pushMaintaining('hermes:request', payload));
    maintainingSession.on('activity', (payload) => pushMaintaining('hermes:activity', payload));
  }
  return maintainingSession;
}

function loadMaintainingWindowState() {
  const fallback = {
    width: MAINTAINING_DEFAULT_WIDTH,
    height: MAINTAINING_DEFAULT_HEIGHT,
    x: null,
    y: null,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(maintainingStatePath(), 'utf8'));
    const width = Math.max(MAINTAINING_MIN_WIDTH, Math.min(2400, Number(saved.width) || fallback.width));
    const height = Math.max(MAINTAINING_MIN_HEIGHT, Math.min(1600, Number(saved.height) || fallback.height));
    const x = Number(saved.x);
    const y = Number(saved.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height, x: null, y: null };
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x < area.x + area.width - 80
        && x + width > area.x + 80
        && y < area.y + area.height - 40
        && y + 48 > area.y;
    });
    if (!visible) return { width, height, x: null, y: null };
    return { width, height, x, y };
  } catch {
    return fallback;
  }
}

function saveMaintainingWindowState() {
  if (!maintainingWindow || maintainingWindow.isDestroyed()) return;
  try {
    const bounds = maintainingWindow.getBounds();
    fs.writeFileSync(maintainingStatePath(), JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }));
  } catch {
    // non-fatal
  }
}

function openMaintainingWindow() {
  if (maintainingWindow && !maintainingWindow.isDestroyed()) {
    if (maintainingWindow.isMinimized()) maintainingWindow.restore();
    if (!maintainingWindow.isVisible()) maintainingWindow.show();
    maintainingWindow.focus();
    syncDockVisibility();
    return;
  }
  const state = loadMaintainingWindowState();
  const options = {
    width: state.width,
    height: state.height,
    minWidth: MAINTAINING_MIN_WIDTH,
    minHeight: MAINTAINING_MIN_HEIGHT,
    title: 'Maintaining',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#F2F2F2',
    webPreferences: {
      preload: path.join(__dirname, 'maintaining-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: Boolean(process.env.QIZI_DEVTOOLS_PORT),
    },
  };
  if (state.x != null && state.y != null) {
    options.x = state.x;
    options.y = state.y;
  }
  maintainingWindow = new BrowserWindow(options);
  maintainingWindow.setMenu(null);
  maintainingWindow.on('resize', saveMaintainingWindowState);
  maintainingWindow.on('move', saveMaintainingWindowState);
  maintainingWindow.on('close', (event) => {
    saveMaintainingWindowState();
    if (!isQuitting) {
      event.preventDefault();
      maintainingWindow.hide();
      syncDockVisibility();
    }
  });
  maintainingWindow.on('show', () => syncDockVisibility());
  maintainingWindow.once('ready-to-show', () => {
    if (!maintainingWindow || maintainingWindow.isDestroyed()) return;
    maintainingWindow.show();
    maintainingWindow.focus();
    syncDockVisibility();
  });
  maintainingWindow.on('closed', () => {
    maintainingWindow = null;
  });
  maintainingWindow.loadFile(path.join(__dirname, 'maintaining.html'));
}

ipcMain.handle('hermes:open', (event) => {
  if (!getAuthorizedMainWindow(event)) return forbiddenSenderResult();
  openMaintainingWindow();
  return { ok: true };
});

ipcMain.handle('hermes:boot', async (event) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  const snapshot = await getMaintainingSession().ensureConnected();
  return { ok: true, ...snapshot };
});

ipcMain.handle('hermes:login', async (event, payload) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  const snapshot = await getMaintainingSession().login({
    url: payload?.url,
    username: payload?.username,
    password: payload?.password,
  });
  return { ok: Boolean(snapshot.connected), ...snapshot };
});

ipcMain.handle('hermes:test', async (event, payload) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  const { HermesClient } = require('./hermes-client');
  const probe = new HermesClient();
  try {
    await probe.probe({
      url: payload?.url,
      username: payload?.username,
      password: payload?.password,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not connect' };
  } finally {
    probe.close();
  }
});

ipcMain.handle('hermes:send', async (event, payload) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  try {
    await getMaintainingSession().send({
      text: payload?.text,
      images: Array.isArray(payload?.images) ? payload.images : [],
      files: Array.isArray(payload?.files) ? payload.files : [],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Send failed' };
  }
});

ipcMain.handle('hermes:abort', async (event) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  try {
    await getMaintainingSession().abort();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not stop' };
  }
});

ipcMain.handle('hermes:respond', (event, payload) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  try {
    getMaintainingSession().respond(payload?.id, payload?.result || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not answer' };
  }
});

ipcMain.handle('hermes:screenshot', (event) => {
  if (!getAuthorizedMaintainingWindow(event)) return { ok: false, error: 'Forbidden' };
  return captureInteractiveScreenshot();
});

ipcMain.handle('hermes:pick-images', async (event) => {
  const win = getAuthorizedMaintainingWindow(event);
  if (!win) return { ok: false, error: 'Forbidden' };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose images',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try {
    const images = [];
    for (const filePath of result.filePaths) {
      const buf = fs.readFileSync(filePath);
      const mime = mimeFromImagePath(filePath);
      images.push({
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        size: buf.length,
        name: path.basename(filePath),
      });
    }
    return { ok: true, images };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not read the image' };
  }
});

ipcMain.handle('hermes:pick-files', async (event) => {
  const win = getAuthorizedMaintainingWindow(event);
  if (!win) return { ok: false, error: 'Forbidden' };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose files',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try {
    const files = [];
    for (const filePath of result.filePaths) {
      const buf = fs.readFileSync(filePath);
      if (buf.length > CHAT_ATTACHMENT_MAX_BYTES) {
        return { ok: false, error: `${path.basename(filePath)} is larger than 20 MB` };
      }
      const mime = mimeFromFilePath(filePath);
      files.push({
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        size: buf.length,
        name: path.basename(filePath),
        mimeType: mime,
      });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not read the file' };
  }
});

app.whenReady().then(() => {
  initRuntimeDebugMode();
  initSttManager(app);
  loadAgentListCacheFromDisk();
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
    syncDockVisibility();
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
// macOS：点 Dock / 从 Spotlight 唤醒时，恢复已隐藏的主窗口
app.on('activate', () => {
  if (process.platform !== 'darwin') return;
  if (shouldIgnoreAppActivate()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    showMainWindow();
    return;
  }
  mainWindow.focus();
});
// 真的退出前清理菜单栏图标，避免 macOS 状态栏残留
app.on('before-quit', () => {
  isQuitting = true;
  if (maintainingSession) maintainingSession.close();
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
