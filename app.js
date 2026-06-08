const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const statusEl = document.getElementById('status');
const stopBtn = document.getElementById('stop-btn');
const cmdPopup = document.getElementById('cmd-popup');
const composerPendingEl = document.getElementById('composer-pending');
const modelBadge = document.getElementById('model-badge');
const modelPickerBtn = document.getElementById('model-picker-btn');
const modelPopup = document.getElementById('model-popup');
const titlebarAgentBtn = document.getElementById('titlebar-agent-btn');
const titlebarAgentAvatar = document.getElementById('titlebar-agent-avatar');
const agentPopup = document.getElementById('agent-popup');
const contextMeter = document.getElementById('context-meter');
const contextMeterFill = document.getElementById('context-meter-fill');
const contextMeterText = document.getElementById('context-meter-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsCancelBtn = document.getElementById('settings-cancel-btn');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsWsUrlInput = document.getElementById('settings-ws-url');
const settingsTokenInput = document.getElementById('settings-token');
const settingsTokenToggle = document.getElementById('settings-token-toggle');
const settingsTokenNote = document.getElementById('settings-token-note');
const settingsSourceHint = document.getElementById('settings-source-hint');
const settingsStatusEl = document.getElementById('settings-status');
const settingsTestBtn = document.getElementById('settings-test-btn');
const settingsLaunchAtLogin = document.getElementById('settings-launch-at-login');
const settingsShowMainOnLaunch = document.getElementById('settings-show-main-on-launch');

let pendingModelUpdate = false;
let currentModelQualified = null;
let modelCatalogCache = null;
let modelCatalogExpiresAt = 0;
const MODEL_CATALOG_TTL_MS = 60_000;

const SLASH_COMMANDS = [
  { cmd: '/new', desc: '开始新会话' },
  { cmd: '/reset', desc: '重置当前会话' },
  { cmd: '/status', desc: '查看会话状态' },
  { cmd: '/btw', desc: '追问当前会话' },
  { cmd: '/model', desc: '切换模型' },
  { cmd: '/sessions', desc: '查看会话列表' },
  { cmd: '/steer', desc: '转向指定会话' },
  { cmd: '/redirect', desc: '重定向到指定会话' },
  { cmd: '/help', desc: '查看帮助' },
];

let messages = [];
let busy = false;
let connected = false;
// 待发送的图片（dataUrl 列表）
let pendingImages = [];
// 待发送的通用文件 { dataUrl, name, mimeType, size }
let pendingFiles = [];
// 当前正在跑的那条 assistant 消息的 runId（用来在并发流式时精确锁定）
let currentRunId = 0;
// 主进程推过来的 runId（用于校验事件归属，避免旧 stream 的 delta 污染新 stream）
let activeRunId = null;
// 排队队列：每项是 assistant 占位消息对象，busy 时新消息进队，旧 stream 跑完才处理
let pendingQueue = [];
// 队列里两条 stream 之间的间隔（避免把后端冲垮）
const QUEUE_INTER_MS = 100;
// 支持的图片 mime 类型（HEIC 会在发送时自动转为 JPEG）
const ALLOWED_IMAGE_MIMES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/heic', 'image/heif',
];
const IMAGE_FILE_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
// 单次最多接收图片/文件数量
const MAX_PENDING_IMAGES = 10;
const MAX_PENDING_FILES = 10;
const MAX_PENDING_ATTACHMENTS = 10;
// 用户主动 abort 标志：true 时 processQueue 不启动（清队列后重置）
let userAborted = false;

const STORAGE_PREFIX = 'qizi-shell-messages:';
const LEGACY_STORAGE_KEY = 'qizi-shell-messages';
const DEFAULT_SESSION_KEY = 'agent:main:main';
const SAVE_DEBOUNCE_MS = 800;
const STREAM_RENDER_MIN_MS = 48;

let currentSessionKey = DEFAULT_SESSION_KEY;
let currentAgentId = 'main';
/** @type {Map<string, object>} */
let agentCatalog = new Map();

let saveTimer = null;
let streamRenderTimer = null;
let streamRenderRunId = null;
let lastStreamRenderAt = 0;

// 把 File 转成 dataUrl（base64）
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function pendingAttachmentCount() {
  return pendingImages.length + pendingFiles.length;
}

function formatFileSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '';
  const n = Number(bytes);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// 加一张待发图片 dataUrl（选图 / 截屏 / 黏贴 / 拖拽的统一入口）
async function addPendingImageDataUrl(dataUrl) {
  if (!dataUrl) return false;
  if (pendingAttachmentCount() >= MAX_PENDING_ATTACHMENTS) {
    console.warn(`[qizi] 最多 ${MAX_PENDING_ATTACHMENTS} 个附件，已忽略`);
    return false;
  }
  if (pendingImages.length >= MAX_PENDING_IMAGES) {
    console.warn(`[qizi] 最多 ${MAX_PENDING_IMAGES} 张图片，已忽略`);
    return false;
  }
  try {
    const displayUrl = await normalizeImageForUi(dataUrl);
    pendingImages.push(displayUrl);
    renderPendingAttachments();
    return true;
  } catch (err) {
    console.error('[qizi] 读图失败', err);
    return false;
  }
}

function addPendingFileEntry(entry) {
  if (!entry?.dataUrl) return false;
  if (pendingAttachmentCount() >= MAX_PENDING_ATTACHMENTS) {
    console.warn(`[qizi] 最多 ${MAX_PENDING_ATTACHMENTS} 个附件，已忽略`);
    return false;
  }
  if (pendingFiles.length >= MAX_PENDING_FILES) {
    console.warn(`[qizi] 最多 ${MAX_PENDING_FILES} 个文件，已忽略`);
    return false;
  }
  pendingFiles.push({
    dataUrl: entry.dataUrl,
    name: entry.name || '未命名文件',
    mimeType: entry.mimeType || 'application/octet-stream',
    size: entry.size || 0,
  });
  renderPendingAttachments();
  return true;
}

// 加一张待发图片 File
async function addPendingImage(file) {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  const name = file.name || '';
  const mimeOk = mime && ALLOWED_IMAGE_MIMES.includes(mime);
  const extOk = !mime && IMAGE_FILE_EXTENSIONS.test(name);
  if (!mimeOk && !extOk) {
    return false;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    return addPendingImageDataUrl(dataUrl);
  } catch (err) {
    console.error('[qizi] 读图失败', err);
    return false;
  }
}

function renderPendingAttachments() {
  if (!composerPendingEl) return;
  composerPendingEl.innerHTML = '';
  if (pendingImages.length === 0 && pendingFiles.length === 0) {
    composerPendingEl.hidden = true;
    return;
  }
  composerPendingEl.hidden = false;
  pendingImages.forEach((dataUrl, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'pending-thumb';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = `待发图片 ${idx + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'pending-thumb-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = '移除';
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(idx, 1);
      renderPendingAttachments();
    });
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    composerPendingEl.appendChild(thumb);
  });
  pendingFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'pending-file';
    const nameEl = document.createElement('span');
    nameEl.className = 'pending-file-name';
    nameEl.textContent = file.name;
    nameEl.title = file.name;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'pending-file-size';
    sizeEl.textContent = formatFileSize(file.size);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'pending-file-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = '移除';
    removeBtn.addEventListener('click', () => {
      pendingFiles.splice(idx, 1);
      renderPendingAttachments();
    });
    chip.appendChild(nameEl);
    chip.appendChild(sizeEl);
    chip.appendChild(removeBtn);
    composerPendingEl.appendChild(chip);
  });
}

function renderPendingImages() {
  renderPendingAttachments();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getMarkedParser() {
  const root = window.marked;
  if (!root) return null;
  if (typeof root.parse === 'function') return root.parse.bind(root);
  if (typeof root.marked === 'function') return root.marked.bind(root);
  return null;
}

function parseMarkdown(text) {
  const parse = getMarkedParser();
  if (parse) {
    try {
      const result = parse(String(text || ''));
      if (typeof result === 'string' && result.trim()) return result;
    } catch (e) {
      console.warn('[qizi] markdown parse failed:', e);
    }
  }
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function shouldUseStreamingPlainText(message) {
  if (!message || message.who !== 'them' || message.streaming !== true) return false;
  if (!busy) return false;
  if (activeRunId == null || message.runId == null) return true;
  return Number(message.runId) === Number(activeRunId);
}

function normalizeStreamingFlags() {
  if (busy) return;
  for (const message of messages) {
    if (message.streaming) message.streaming = false;
  }
}

// streaming=true 时只做 HTML 转义（流式快）；结束后才走 Markdown
function renderMessageContent(text, { streaming = false, extraImages = [] } = {}) {
  const imageRegex = /\[image:(data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\]/g;
  const images = [...extraImages];
  let plainText = String(text || '').replace(imageRegex, (_m, dataUrl) => {
    images.push(dataUrl);
    return '';
  });
  // 网关/历史里偶发泄漏的裸 base64 长串（非 [image:…] 包裹）
  plainText = plainText.replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n');
  plainText = plainText.replace(/\n{3,}/g, '\n\n').trim();
  let html = '';
  if (images.length > 0) {
    html += '<div class="msg-images">' + images.map((url) => `<img class="msg-image" src="${url}" />`).join('') + '</div>';
  }
  if (plainText) {
    if (streaming) {
      html += `<pre class="msg-stream-plain">${escapeHtml(plainText)}</pre>`;
    } else {
      html += parseMarkdown(plainText);
    }
  }
  return { html, plainText, images };
}

const IMAGE_ONLY_CAPTIONS = new Set([
  '（图片）', '[图片]', '[User sent media without caption]',
]);
const ATTACHMENT_ONLY_CAPTIONS = new Set([
  '（附件）', '（图片）', '[图片]', '[附件]', '[User sent media without caption]',
]);

function isAttachmentPlaceholder(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  return ATTACHMENT_ONLY_CAPTIONS.has(trimmed);
}

const DEFAULT_INPUT_HEIGHT = 'calc(90px + 6mm)';
let streamPollTimer = null;
let streamPollStableCount = 0;
let sessionWatchTimer = null;
let lastSyncedHistorySignature = '';
let externalSessionRunId = null;
const SESSION_WATCH_MS = 800;

async function normalizeImageForUi(dataUrl) {
  if (!window.qizi.normalizeImage) return dataUrl;
  const result = await window.qizi.normalizeImage(dataUrl);
  if (!result?.ok) {
    throw new Error(result?.error || '无法读取图片');
  }
  return result.dataUrl;
}

async function normalizeImageListForUi(urls) {
  const normalized = [];
  for (const url of urls) {
    normalized.push(await normalizeImageForUi(url));
  }
  return normalized;
}

function renderMessageFilesHtml(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const items = files.map((file) => {
    const name = escapeHtml(file.name || '未命名文件');
    const size = file.size ? `<span class="msg-file-size">${escapeHtml(formatFileSize(file.size))}</span>` : '';
    return `<div class="msg-file"><span class="msg-file-name">📄 ${name}</span>${size}</div>`;
  }).join('');
  return `<div class="msg-files">${items}</div>`;
}

function renderMessageBubbleContent(m) {
  const extraImages = Array.isArray(m.images) ? m.images : [];
  const files = Array.isArray(m.files) ? m.files : [];
  let text = m.text || '';
  const trimmed = text.trim();
  if ((extraImages.length > 0 || files.length > 0) && isAttachmentPlaceholder(trimmed)) {
    text = '';
  }
  if (extraImages.length === 0 && text.includes('[image:')) {
    return renderMessageContent(text, { streaming: shouldUseStreamingPlainText(m) });
  }
  const content = renderMessageContent(text, {
    streaming: shouldUseStreamingPlainText(m),
    extraImages,
  });
  if (files.length > 0) {
    content.html = renderMessageFilesHtml(files) + content.html;
  }
  return content;
}

function mergeMessagePair(local, server) {
  const who = server?.who || local?.who;
  const merged = {
    who,
    text: '',
    time: local?.time || server?.time || '',
    runId: local?.runId ?? server?.runId,
    streaming: false,
  };

  const localText = local?.text || '';
  const serverText = server?.text || '';

  if (who === 'them') {
    merged.text = localText.length >= serverText.length ? localText : serverText;
  } else if (isAttachmentPlaceholder(serverText)) {
    merged.text = localText;
  } else {
    merged.text = serverText || localText;
  }

  if (Array.isArray(local?.images) && local.images.length > 0) {
    merged.images = local.images;
  } else if (Array.isArray(server?.images) && server.images.length > 0) {
    merged.images = server.images;
  }

  if (Array.isArray(local?.files) && local.files.length > 0) {
    merged.files = local.files.map(({ name, mimeType, size, dataUrl }) => ({
      name,
      mimeType,
      size,
      ...(dataUrl ? { dataUrl } : {}),
    }));
  } else if (Array.isArray(server?.files) && server.files.length > 0) {
    merged.files = server.files;
  }

  return merged;
}

function mergeHistories(localMessages, serverMessages) {
  if (!Array.isArray(serverMessages) || serverMessages.length === 0) {
    return Array.isArray(localMessages) && localMessages.length
      ? localMessages.map((m) => ({ ...m, streaming: false }))
      : [];
  }
  if (!Array.isArray(localMessages) || localMessages.length === 0) {
    return serverMessages;
  }

  const localAttachmentUsers = localMessages.filter(
    (m) => m.who === 'me' && (
      (Array.isArray(m.images) && m.images.length > 0)
      || (Array.isArray(m.files) && m.files.length > 0)
    ),
  );
  let attachmentUserIdx = 0;

  const merged = serverMessages.map((server, index) => {
    const local = localMessages[index];
    const serverText = server?.text || '';
    const localHasAttachments = local?.who === 'me' && (
      (Array.isArray(local?.images) && local.images.length > 0)
      || (Array.isArray(local?.files) && local.files.length > 0)
    );

    if (server.who === 'me' && isAttachmentPlaceholder(serverText)) {
      if (localHasAttachments) {
        return mergeMessagePair(local, server);
      }
      while (attachmentUserIdx < localAttachmentUsers.length) {
        const candidate = localAttachmentUsers[attachmentUserIdx++];
        return mergeMessagePair(candidate, server);
      }
    }

    return mergeMessagePair(local, server);
  });

  if (localMessages.length > serverMessages.length) {
    for (let i = serverMessages.length; i < localMessages.length; i += 1) {
      const local = localMessages[i];
      if (local?.text || local?.images?.length || local?.files?.length) {
        merged.push({ ...local, streaming: false });
      }
    }
  }
  return merged;
}

function overlayLocalAttachmentsOntoServerHistory(serverMessages, localMessages) {
  if (!Array.isArray(serverMessages)) return [];
  const localList = Array.isArray(localMessages) ? localMessages : [];
  const localAttachmentUsers = localList.filter(
    (m) => m.who === 'me' && (
      (Array.isArray(m.images) && m.images.length > 0)
      || (Array.isArray(m.files) && m.files.length > 0)
    ),
  );
  let attachmentUserIdx = 0;

  return serverMessages.map((server) => {
    const copy = { ...server, streaming: false };
    const serverText = (copy.text || '').trim();
    let local = null;

    for (const candidate of localList) {
      if (candidate.who !== 'me') continue;
      const localText = (candidate.text || '').trim();
      if (localText && serverText && localText === serverText) {
        local = candidate;
        break;
      }
    }

    if (!local && copy.who === 'me' && isAttachmentPlaceholder(serverText)) {
      while (attachmentUserIdx < localAttachmentUsers.length) {
        local = localAttachmentUsers[attachmentUserIdx++];
        break;
      }
    }

    if (local?.images?.length) copy.images = local.images;
    if (local?.files?.length) {
      copy.files = local.files.map(({ name, mimeType, size, dataUrl }) => ({
        name,
        mimeType,
        size,
        ...(dataUrl ? { dataUrl } : {}),
      }));
    }
    if (isAttachmentPlaceholder(copy.text) && (local?.text || '').trim()) {
      copy.text = local.text;
    }

    return copy;
  });
}

function clearStaleStreamingState() {
  let cleared = false;
  for (const message of messages) {
    if (message.streaming) {
      message.streaming = false;
      cleared = true;
    }
  }
  if (cleared && !isLocalOwnedActiveRun()) {
    stopStreamHistoryPoll();
    setBusy(false);
    activeRunId = null;
    externalSessionRunId = null;
  }
  return cleared;
}

function applyLoadedSessionKey(result) {
  if (!result?.sessionKey || result.sessionKey === currentSessionKey) return false;
  flushSaveMessages();
  currentSessionKey = result.sessionKey;
  currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
  loadMessages();
  return true;
}

function splitMessageForSend(userMsg) {
  if (!userMsg) return { message: '', images: [], files: [] };
  const inlineImages = Array.isArray(userMsg.images) ? userMsg.images : [];
  const inlineFiles = Array.isArray(userMsg.files) ? userMsg.files : [];
  if (inlineImages.length > 0 || inlineFiles.length > 0) {
    return {
      message: (userMsg.text || '').trim(),
      images: inlineImages,
      files: inlineFiles,
    };
  }
  const { plainText, images } = renderMessageContent(userMsg.text || '');
  return {
    message: plainText,
    images,
    files: [],
  };
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function messagesStorageKey(sessionKey = currentSessionKey) {
  return `${STORAGE_PREFIX}${sessionKey || DEFAULT_SESSION_KEY}`;
}

function parseAgentIdFromSessionKey(sessionKey) {
  const match = /^agent:([^:]+):/.exec(sessionKey || '');
  return match ? match[1] : 'main';
}

function formatAgentLabel(agent) {
  if (!agent) return '启孜';
  if (agent.label) return agent.label;
  if (agent.id === 'main') return '启孜';
  return agent.name || agent.id || '启孜';
}

function updateAgentTitleLabel(agent) {
  if (!titlebarAgentAvatar) return;
  const info = agent || getCurrentAgentInfo();
  titlebarAgentAvatar.innerHTML = buildAgentAvatarInner(info, 'titlebar');
  if (titlebarAgentBtn) {
    titlebarAgentBtn.title = `切换 Agent · ${formatAgentLabel(info)}`;
    titlebarAgentBtn.setAttribute('aria-label', `切换 Agent · ${formatAgentLabel(info)}`);
  }
}

function applyAgentCatalog(agents) {
  agentCatalog = new Map();
  if (!Array.isArray(agents)) return;
  for (const agent of agents) {
    if (agent?.id) agentCatalog.set(agent.id, agent);
  }
}

function getCurrentAgentInfo() {
  return agentCatalog.get(currentAgentId) || { id: currentAgentId, label: formatAgentLabel({ id: currentAgentId }) };
}

function agentAvatarFallbackText(agent) {
  const emoji = agent?.emoji;
  if (emoji && emoji.trim()) return emoji.trim();
  const label = formatAgentLabel(agent);
  return label.slice(0, 1) || '启';
}

function isEmojiLike(text) {
  return /\p{Extended_Pictographic}/u.test(text);
}

function buildAgentAvatarInner(agent, variant) {
  const label = formatAgentLabel(agent);
  const safeLabel = escapeHtml(label);
  if (agent?.avatarDataUrl) {
    return `<span class="agent-avatar agent-avatar-${variant}" role="img" aria-label="${safeLabel}"><img src="${agent.avatarDataUrl}" alt="${safeLabel}"></span>`;
  }
  const fallback = agentAvatarFallbackText(agent);
  const safeFallback = escapeHtml(fallback);
  const kind = isEmojiLike(fallback) ? 'emoji' : 'letter';
  return `<span class="agent-avatar agent-avatar-${variant} agent-avatar-${kind}" role="img" aria-label="${safeLabel}">${safeFallback}</span>`;
}

function renderMessageAvatarHtml(who) {
  if (who === 'me') {
    return '<div class="msg-avatar msg-avatar-me">我</div>';
  }
  const agent = getCurrentAgentInfo();
  const label = escapeHtml(formatAgentLabel(agent));
  if (agent?.avatarDataUrl) {
    return `<div class="msg-avatar msg-avatar-them" role="img" aria-label="${label}"><img src="${agent.avatarDataUrl}" alt="${label}"></div>`;
  }
  const fallback = agentAvatarFallbackText(agent);
  const emojiClass = isEmojiLike(fallback) ? ' msg-avatar-emoji' : '';
  return `<div class="msg-avatar msg-avatar-them${emojiClass}" role="img" aria-label="${label}">${escapeHtml(fallback)}</div>`;
}

async function loadAgentCatalog() {
  try {
    const result = await window.qizi.listAgents();
    if (!result?.ok) return result;
    applyAgentCatalog(result.agents);
    const agent = result.agents.find((entry) => entry.id === currentAgentId);
    if (agent) updateAgentTitleLabel(agent);
    render();
    return result;
  } catch (err) {
    return { ok: false, error: err.message || String(err), agents: [] };
  }
}

function setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind || '';
}

function writeMessagesToStorage(items) {
  const storageKey = messagesStorageKey();
  let slice = items;
  while (slice.length > 0) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(slice));
      return true;
    } catch {
      if (slice.length <= 4) return false;
      slice = slice.slice(Math.ceil(slice.length / 4));
    }
  }
  return false;
}

function saveMessages(force) {
  if (!force && saveTimer) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const write = () => {
    const payload = messages.map((m) => ({
      who: m.who,
      text: m.text,
      images: Array.isArray(m.images) && m.images.length > 0 ? m.images : undefined,
      files: Array.isArray(m.files) && m.files.length > 0
        ? m.files.map(({ name, mimeType, size }) => ({ name, mimeType, size }))
        : undefined,
      time: m.time,
      runId: m.runId,
      streaming: false,
    }));
    if (!writeMessagesToStorage(payload)) {
      console.warn('[qizi] localStorage 空间不足，部分历史未能保存');
    }
  };
  if (force) {
    write();
  } else {
    saveTimer = setTimeout(write, SAVE_DEBOUNCE_MS);
  }
}

function flushSaveMessages() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveMessages(true);
}

function loadMessages() {
  try {
    const storageKey = messagesStorageKey();
    let raw = localStorage.getItem(storageKey);
    if (!raw && currentSessionKey === DEFAULT_SESSION_KEY) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        localStorage.setItem(storageKey, raw);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (!raw) {
      messages = [];
      return;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      messages = parsed.map((m) => ({ ...m, streaming: false }));
    }
  } catch {
    messages = [];
  }
}

function render() {
  if (!messagesEl) return;
  normalizeStreamingFlags();
  if (messages.length === 0) {
    messagesEl.innerHTML = '<div class="msg-hint">还没有消息，发个试试 👋</div>';
    return;
  }
  messagesEl.innerHTML = '';
  for (const m of messages) {
    try {
      const row = document.createElement('div');
      row.className = 'msg ' + m.who;
      if (m.runId != null) row.dataset.runId = String(m.runId);
      row.innerHTML = `
        ${renderMessageAvatarHtml(m.who)}
        <div class="msg-content">
          <div class="msg-bubble"></div>
          <div class="msg-meta">${m.time || ''}${m.streaming ? ' · 输入中…' : ''}</div>
        </div>
      `;
      row.querySelector('.msg-bubble').innerHTML = renderMessageBubbleContent(m).html;
      messagesEl.appendChild(row);
    } catch (e) {
      console.error('render error:', e);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateStreamingBubble(runId) {
  if (!messagesEl || runId == null) return;
  const m = messages.find((msg) => msg.runId === runId && msg.streaming);
  if (!m) {
    render();
    return;
  }
  let row = messagesEl.querySelector(`[data-run-id="${runId}"]`);
  if (!row) {
    render();
    row = messagesEl.querySelector(`[data-run-id="${runId}"]`);
    if (!row) return;
  }
  const bubble = row.querySelector('.msg-bubble');
  if (bubble) {
    bubble.innerHTML = renderMessageBubbleContent(m).html;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function isLocalOwnedActiveRun() {
  if (!busy || activeRunId == null) return false;
  const target = messages.find((m) => m.runId === activeRunId);
  return Boolean(target && !target.external);
}

function historySignature(historyMessages) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return '0';
  const last = historyMessages[historyMessages.length - 1];
  return `${historyMessages.length}:${last.who}:${(last.text || '').length}`;
}

function stopSessionWatch() {
  if (sessionWatchTimer) {
    clearInterval(sessionWatchTimer);
    sessionWatchTimer = null;
  }
}

async function tickSessionWatch() {
  if (!connected || isLocalOwnedActiveRun()) return;

  try {
    const sessionInfo = await window.qizi.getSessionInfo();
    if (!sessionInfo?.ok) return;

    if (sessionInfo.hasActiveRun) {
      if (!messages.some((m) => m.streaming)) {
        await syncHistoryFromGateway();
        await resumeInterruptedSession({ external: true });
      } else {
        await syncHistoryFromGateway();
      }
      return;
    }

    const history = await window.qizi.loadHistory();
    if (!history?.ok) return;
    const signature = historySignature(history.messages);
    if (signature !== lastSyncedHistorySignature) {
      lastSyncedHistorySignature = signature;
      await syncHistoryFromGateway();
    }
  } catch {
    // ignore background sync errors
  }
}

function startSessionWatch() {
  stopSessionWatch();
  sessionWatchTimer = setInterval(() => {
    tickSessionWatch();
  }, SESSION_WATCH_MS);
}

async function handleExternalSessionChat(payload) {
  if (!payload || isLocalOwnedActiveRun()) return;

  if (payload.state === 'delta') {
    await syncHistoryFromGateway();
    let target = [...messages].reverse().find((m) => m.who === 'them');
    if (!target) {
      currentRunId += 1;
      target = {
        who: 'them',
        text: payload.text || payload.delta || '',
        time: now(),
        streaming: true,
        runId: currentRunId,
        external: true,
      };
      messages.push(target);
    } else {
      if (payload.text && payload.text.length >= (target.text || '').length) {
        target.text = payload.text;
      } else if (payload.delta) {
        applyStreamingDelta(payload.delta, target.runId, payload.replace === true);
      }
      target.streaming = true;
      target.external = true;
    }
    externalSessionRunId = payload.gatewayRunId;
    activeRunId = target.runId ?? activeRunId;
    setBusy(true);
    scheduleStreamingUpdate(target.runId);
    setStatus('Webchat 回复中…', 'pending');
    return;
  }

  if (payload.state === 'final' || payload.state === 'aborted' || payload.state === 'error') {
    await syncHistoryFromGateway();
    clearStaleStreamingState();
    externalSessionRunId = null;
    render();
    flushSaveMessages();
    setStatus('已连接', 'ok');
  }
}

function findAssistantStreamTarget(runId) {
  if (runId != null) {
    const numericRunId = Number(runId);
    const byRunId = messages.find(
      (m) => m.who === 'them' && (m.runId === runId || Number(m.runId) === numericRunId),
    );
    if (byRunId) return byRunId;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].who === 'them' && messages[i].streaming) {
      return messages[i];
    }
  }
  return null;
}

function scheduleStreamingUpdate(runId) {
  streamRenderRunId = runId;
  if (streamRenderTimer) return;
  const elapsed = Date.now() - lastStreamRenderAt;
  const delay = Math.max(0, STREAM_RENDER_MIN_MS - elapsed);
  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    lastStreamRenderAt = Date.now();
    updateStreamingBubble(streamRenderRunId);
  }, delay);
}

function applyStreamingDelta(delta, runId, replace) {
  const target = findAssistantStreamTarget(runId);
  if (!target) return;

  const prevLength = (target.text || '').length;
  target.text = replace ? delta : `${target.text || ''}${delta}`;
  target.streaming = true;
  target.lastDeltaAt = Date.now();

  if (prevLength === 0) {
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    lastStreamRenderAt = Date.now();
    updateStreamingBubble(runId ?? target.runId);
    return;
  }
  scheduleStreamingUpdate(runId ?? target.runId);
}

function userMessageHasPayload(m) {
  return m?.who === 'me' && (
    Boolean(m.text)
    || (Array.isArray(m.images) && m.images.length > 0)
    || (Array.isArray(m.files) && m.files.length > 0)
  );
}

function toChatPayload(assistantMsg) {
  let userMsg = null;
  if (assistantMsg) {
    const idx = messages.indexOf(assistantMsg);
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (userMessageHasPayload(messages[i])) {
          userMsg = messages[i];
          break;
        }
      }
    }
  }
  if (!userMsg) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (userMessageHasPayload(messages[i]) && !messages[i].streaming) {
        userMsg = messages[i];
        break;
      }
    }
  }
  if (!userMsg) {
    return { message: '', images: [], files: [] };
  }
  return splitMessageForSend(userMsg);
}

async function syncHistoryFromGateway() {
  if (!window.qizi.loadHistory) return;
  try {
    const result = await window.qizi.loadHistory();
    if (!result?.ok || !Array.isArray(result.messages)) return;

    if (applyLoadedSessionKey(result)) {
      lastSyncedHistorySignature = '';
    }

    lastSyncedHistorySignature = historySignature(result.messages);

    if (isLocalOwnedActiveRun()) {
      const streamingMsgs = messages.filter((m) => m.streaming && !m.external);
      if (streamingMsgs.length > 0) {
        for (const sm of streamingMsgs) {
          const lastThem = [...result.messages].reverse().find((m) => m.who === 'them');
          if (lastThem && (lastThem.text || '').length > (sm.text || '').length) {
            sm.text = lastThem.text;
            scheduleStreamingUpdate(sm.runId);
          }
        }
        return;
      }
    }

    clearStaleStreamingState();

    if (result.messages.length === 0 && messages.length > 0) return;

    if (!isLocalOwnedActiveRun()) {
      messages = overlayLocalAttachmentsOntoServerHistory(result.messages, messages);
    } else {
      messages = mergeHistories(messages, result.messages);
    }

    flushSaveMessages();
    render();
    refreshSessionInfo();
  } catch (err) {
    console.warn('[qizi] 拉取服务端历史失败', err);
  }
}

function stopStreamHistoryPoll() {
  if (streamPollTimer) {
    clearInterval(streamPollTimer);
    streamPollTimer = null;
  }
  streamPollStableCount = 0;
}

async function pollStreamHistoryOnce(runId) {
  const target = findAssistantStreamTarget(runId);
  if (!target || !target.streaming) {
    stopStreamHistoryPoll();
    return;
  }

  try {
    const [historyResult, sessionInfo] = await Promise.all([
      window.qizi.loadHistory(),
      window.qizi.getSessionInfo(),
    ]);

    if (historyResult?.ok) {
      const lastThem = [...historyResult.messages].reverse().find((m) => m.who === 'them');
      if (lastThem && (lastThem.text || '').length > (target.text || '').length) {
        target.text = lastThem.text;
        streamPollStableCount = 0;
        scheduleStreamingUpdate(runId);
      } else {
        streamPollStableCount += 1;
      }
    }

    if (sessionInfo?.ok && !sessionInfo.hasActiveRun && streamPollStableCount >= 2) {
      finishAssistant({ runId });
      stopStreamHistoryPoll();
    }
  } catch {
    // ignore transient poll errors
  }
}

function startStreamHistoryPoll(runId) {
  stopStreamHistoryPoll();
  streamPollTimer = setInterval(() => {
    pollStreamHistoryOnce(runId);
  }, 2000);
}

async function resumeInterruptedSession(options = {}) {
  if (isLocalOwnedActiveRun()) return;

  const sessionInfo = await window.qizi.getSessionInfo();
  if (!sessionInfo?.ok || !sessionInfo.hasActiveRun) return;

  await syncHistoryFromGateway();

  let target = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].who === 'them') {
      target = messages[i];
      break;
    }
  }

  if (!target) {
    currentRunId += 1;
    target = {
      who: 'them',
      text: '',
      time: now(),
      streaming: true,
      runId: currentRunId,
      external: Boolean(options.external),
    };
    messages.push(target);
  } else {
    if (!target.runId) {
      currentRunId += 1;
      target.runId = currentRunId;
    } else {
      currentRunId = Math.max(currentRunId, target.runId);
    }
    target.streaming = true;
    if (options.external) target.external = true;
  }

  setBusy(true);
  activeRunId = target.runId;
  render();
  setStatus(options.external ? 'Webchat 回复中，同步…' : '检测到进行中的回复，正在续传…', 'pending');

  await pollStreamHistoryOnce(target.runId);
  startStreamHistoryPoll(target.runId);
}

function finishAssistant({ error, runId, text } = {}) {
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }
  let target = null;
  if (runId != null) {
    target = findAssistantStreamTarget(runId);
  }
  if (!target) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].who === 'them' && messages[i].streaming) {
        target = messages[i];
        break;
      }
    }
  }
  if (!target) {
    setBusy(false);
    return;
  }
  if (!target.streaming && !error && !(text && text.length > (target.text || '').length)) {
    return;
  }
  if (typeof text === 'string' && text.length > (target.text || '').length) {
    target.text = text;
  }
  target.streaming = false;
  // 如果有错误，追加错误信息（不覆盖已输出内容）
  if (error && !String(error).includes('连接断开') && !String(error).includes('Gateway')) {
    target.text = target.text ? `${target.text}\n\n[错误] ${error}` : `[错误] ${error}`;
  }
  // /model 回复时解析模型名更新标签
  if (pendingModelUpdate) {
    pendingModelUpdate = false;
    updateModelBadge(target.text);
  }

  if (runId == null || runId === activeRunId) {
    setBusy(false);
    stopStreamHistoryPoll();
    if (target.external) {
      externalSessionRunId = null;
    }
  }
  flushSaveMessages();
  render();
  refreshSessionInfo();
}

function formatAgentCurrentModel(agent) {
  if (!agent) return '—';
  const qualified = agent.currentModelQualified
    || (agent.currentModelProvider && agent.currentModel
      ? `${agent.currentModelProvider}/${agent.currentModel}`
      : null);
  if (qualified) return formatModelShortName(qualified);
  if (agent.currentModel) return formatModelShortName(agent.currentModel);
  if (agent.defaultModel) return formatModelShortName(agent.defaultModel);
  return '—';
}

function formatModelShortName(name) {
  if (!name) return '—';
  const parts = String(name).split('/');
  if (parts.length >= 3 && parts[1].startsWith('@')) {
    return parts.slice(1).join('/');
  }
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return name;
}

function formatCatalogEntryLabel(entry) {
  return entry?.name || entry?.id || '未知模型';
}

function formatCatalogEntryQualified(entry) {
  if (!entry?.provider || !entry?.id) return null;
  return `${entry.provider}/${entry.id}`;
}

function setModelBadgeText(text) {
  if (modelBadge) modelBadge.textContent = text || '—';
}

function formatTokenCount(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function updateContextMeter({ used, max, percent, fresh } = {}) {
  if (!contextMeter || !contextMeterFill || !contextMeterText) return;
  if (used == null || max == null || max <= 0) {
    contextMeterFill.style.width = '0%';
    contextMeterText.textContent = '—';
    contextMeter.classList.remove('stale');
    contextMeter.title = 'Context 占用';
    return;
  }
  const pct = percent != null ? percent : Math.min(100, Math.round((used / max) * 100));
  contextMeterFill.style.width = `${pct}%`;
  contextMeterText.textContent = `${formatTokenCount(used)} / ${formatTokenCount(max)} · ${pct}%`;
  contextMeter.classList.toggle('stale', fresh === false);
  contextMeter.title = fresh === false
    ? `Context 占用（估算）${used.toLocaleString()} / ${max.toLocaleString()} tokens`
    : `Context 占用 ${used.toLocaleString()} / ${max.toLocaleString()} tokens`;
}

async function refreshSessionInfo() {
  if (!window.qizi.getSessionInfo) return;
  try {
    const result = await window.qizi.getSessionInfo();
    if (!result?.ok) return;
    currentModelQualified = result.qualified || null;
    const label = result.model || result.provider || '—';
    setModelBadgeText(formatModelShortName(label));
    updateContextMeter(result.context);
  } catch {
    // ignore
  }
}

async function refreshCurrentModelBadge() {
  return refreshSessionInfo();
}

async function loadModelCatalog(force) {
  const now = Date.now();
  if (!force && modelCatalogCache && modelCatalogExpiresAt > now) {
    return modelCatalogCache;
  }
  const result = await window.qizi.listModels();
  if (!result?.ok) {
    throw new Error(result?.error || '无法加载模型列表');
  }
  modelCatalogCache = Array.isArray(result.models) ? result.models : [];
  modelCatalogExpiresAt = now + MODEL_CATALOG_TTL_MS;
  return modelCatalogCache;
}

function hideAgentPopup() {
  if (!agentPopup) return;
  agentPopup.hidden = true;
  agentPopup.innerHTML = '';
  if (titlebarAgentBtn) titlebarAgentBtn.classList.remove('open');
}

function renderAgentPopup(agents) {
  if (!agentPopup) return;
  if (!agents.length) {
    agentPopup.innerHTML = '<div class="agent-popup-empty">暂无可用 Agent</div>';
    return;
  }
  agentPopup.innerHTML = '';
  for (const agent of agents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-item' + (agent.id === currentAgentId ? ' active' : '');

    const avatarWrap = document.createElement('span');
    avatarWrap.innerHTML = buildAgentAvatarInner(agent, 'menu');

    const body = document.createElement('span');
    body.className = 'agent-item-body';

    const nameRow = document.createElement('span');
    nameRow.className = 'agent-item-name';
    nameRow.textContent = formatAgentLabel(agent);

    const meta = document.createElement('span');
    meta.className = 'agent-item-meta';
    meta.textContent = formatAgentCurrentModel(agent);

    body.appendChild(nameRow);
    body.appendChild(meta);
    btn.appendChild(avatarWrap.firstElementChild || avatarWrap);
    btn.appendChild(body);
    btn.addEventListener('click', () => {
      if (agent.id !== currentAgentId) {
        switchToAgent(agent.id);
      } else {
        hideAgentPopup();
      }
    });
    agentPopup.appendChild(btn);
  }
}

async function showAgentPopup() {
  if (!agentPopup || !titlebarAgentBtn) return;
  if (!agentPopup.hidden) {
    hideAgentPopup();
    return;
  }
  hideModelPopup();
  hideCommandPopup();
  agentPopup.hidden = false;
  titlebarAgentBtn.classList.add('open');
  agentPopup.innerHTML = '<div class="agent-popup-loading">加载 Agent…</div>';

  if (!connected) {
    await checkConnection();
    if (!connected) {
      agentPopup.innerHTML = '<div class="agent-popup-error">未连接 Gateway</div>';
      return;
    }
  }

  try {
    const result = await window.qizi.listAgents();
    if (!result?.ok) {
      agentPopup.innerHTML = `<div class="agent-popup-error">${escapeHtml(result?.error || '加载失败')}</div>`;
      return;
    }
    const agents = Array.isArray(result.agents) ? result.agents : [];
    applyAgentCatalog(agents);
    renderAgentPopup(agents);
  } catch (err) {
    agentPopup.innerHTML = `<div class="agent-popup-error">${escapeHtml(err.message || '加载失败')}</div>`;
  }
}

async function switchToAgent(agentId) {
  if (!agentId || agentId === currentAgentId) {
    hideAgentPopup();
    return;
  }

  hideAgentPopup();
  setStatus('切换 Agent…', 'pending');

  if (busy) {
    userAborted = true;
    pendingQueue = [];
    try {
      await window.qizi.abortChat();
    } catch {
      // ignore
    }
    stopStreamHistoryPoll();
    setBusy(false);
    activeRunId = null;
    for (const m of messages) {
      if (m.streaming) m.streaming = false;
    }
  }

  flushSaveMessages();

  try {
    const result = await window.qizi.switchAgent(agentId);
    if (!result?.ok) {
      setStatus(result?.error || '切换失败', 'error');
      return;
    }

    currentSessionKey = result.sessionKey || buildAgentSessionKeyFallback(agentId);
    currentAgentId = agentId;
    if (result.agent) {
      agentCatalog.set(agentId, result.agent);
    }
    messages = [];
    pendingQueue = [];
    pendingImages = [];
    pendingFiles = [];
    currentRunId = 0;
    activeRunId = null;
    userAborted = false;
    modelCatalogExpiresAt = 0;

    updateAgentTitleLabel(result.agent || { id: agentId });
    loadMessages();
    render();

    await syncHistoryFromGateway();
    await resumeInterruptedSession();
    await refreshCurrentModelBadge();
    await refreshSessionInfo();
    setStatus('已连接', 'ok');
  } catch (err) {
    setStatus(err.message || '切换失败', 'error');
  }
}

function buildAgentSessionKeyFallback(agentId) {
  return `agent:${agentId}:main`;
}

async function refreshAgentTitleFromGateway() {
  try {
    currentSessionKey = await window.qizi.getSessionKey();
    currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
    await loadAgentCatalog();
  } catch {
    updateAgentTitleLabel({ id: currentAgentId });
  }
}

function hideModelPopup() {
  if (!modelPopup) return;
  modelPopup.hidden = true;
  modelPopup.innerHTML = '';
  if (modelPickerBtn) modelPickerBtn.classList.remove('open');
}

function renderModelPopup(models) {
  if (!modelPopup) return;
  if (!models.length) {
    modelPopup.innerHTML = '<div class="model-popup-empty">暂无可用模型</div>';
    return;
  }
  modelPopup.innerHTML = '';
  for (const entry of models) {
    const qualified = formatCatalogEntryQualified(entry);
    if (!qualified) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-item' + (qualified === currentModelQualified ? ' active' : '');
    const unavailable = entry.available === false;
    if (unavailable) btn.disabled = true;

    const nameRow = document.createElement('span');
    nameRow.className = 'model-item-name';
    nameRow.textContent = formatCatalogEntryLabel(entry);
    if (unavailable) {
      const tag = document.createElement('span');
      tag.className = 'model-item-badge';
      tag.textContent = '未配置';
      nameRow.appendChild(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'model-item-meta';
    meta.textContent = qualified;

    btn.appendChild(nameRow);
    btn.appendChild(meta);
    btn.addEventListener('click', () => selectModel(qualified, formatCatalogEntryLabel(entry)));
    modelPopup.appendChild(btn);
  }
}

async function showModelPopup() {
  if (!modelPopup || !modelPickerBtn) return;
  if (!modelPopup.hidden) {
    hideModelPopup();
    return;
  }
  hideAgentPopup();
  hideCommandPopup();
  modelPopup.hidden = false;
  modelPickerBtn.classList.add('open');
  modelPopup.innerHTML = '<div class="model-popup-loading">加载模型…</div>';

  if (!connected) {
    await checkConnection();
    if (!connected) {
      modelPopup.innerHTML = '<div class="model-popup-error">未连接 Gateway</div>';
      return;
    }
  }

  try {
    await refreshCurrentModelBadge();
    const models = await loadModelCatalog(false);
    renderModelPopup(models);
  } catch (err) {
    modelPopup.innerHTML = `<div class="model-popup-error">${escapeHtml(err.message || '加载失败')}</div>`;
  }
}

async function selectModel(qualified, label) {
  if (!qualified || qualified === currentModelQualified) {
    hideModelPopup();
    return;
  }
  if (modelPickerBtn) modelPickerBtn.disabled = true;
  setModelBadgeText('切换中…');
  hideModelPopup();
  try {
    const result = await window.qizi.setModel(qualified);
    if (!result?.ok) {
      throw new Error(result?.error || '切换失败');
    }
    currentModelQualified = result.qualified || qualified;
    setModelBadgeText(formatModelShortName(result.model || label || qualified));
    setStatus(`已切换至 ${formatModelShortName(result.model || label)}`, 'ok');
    const activeAgent = agentCatalog.get(currentAgentId);
    if (activeAgent) {
      activeAgent.currentModel = result.model ?? null;
      activeAgent.currentModelProvider = result.provider ?? null;
      activeAgent.currentModelQualified = result.qualified || qualified;
      agentCatalog.set(currentAgentId, activeAgent);
    }
    await refreshSessionInfo();
  } catch (err) {
    setModelBadgeText(formatModelShortName(currentModelQualified || '—'));
    setStatus(err.message || '切换模型失败', 'error');
  } finally {
    if (modelPickerBtn) modelPickerBtn.disabled = false;
  }
}

// 从 /model 命令回复解析模型名（聊天切换时的兜底）
function updateModelBadge(text) {
  if (!text || !modelBadge) return;
  const patterns = [
    /(?:🧠\s*)?Model[:：]\s*([\w@\/-]+)/i,
    /📌\s*Session selected[:：]\s*([\w@\/-]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const fullName = m[1];
      currentModelQualified = fullName.includes('/') ? fullName : currentModelQualified;
      setModelBadgeText(formatModelShortName(fullName));
      return;
    }
  }
}

async function checkConnection() {
  setStatus('连接中…', 'pending');
  try {
    const result = await window.qizi.checkConnection();
    if (result.ok) {
      connected = true;
      setStatus('已连接', 'ok');
      await refreshCurrentModelBadge();
      await syncHistoryFromGateway();
      await resumeInterruptedSession();
      startSessionWatch();
    } else {
      connected = false;
      setStatus(result.error || '连接失败', 'error');
    }
  } catch (err) {
    connected = false;
    setStatus(err.message || '连接失败', 'error');
  }
}

function setBusy(value) {
  busy = value;
  if (stopBtn) stopBtn.hidden = !value;
}

async function abortRun() {
  if (!busy) return;
  userAborted = true;
  // 清空队列里的所有 pending 消息，把它们从 messages 里也删掉
  for (const m of pendingQueue) {
    const idx = messages.indexOf(m);
    if (idx >= 0) messages.splice(idx, 1);
  }
  pendingQueue = [];
  flushSaveMessages();
  render();
  try {
    await window.qizi.abortChat();
  } catch (e) { /* ignore */ }
  // 立即保存已输出的部分内容，不等待 500ms
  const staleRunId = activeRunId;
  const t = messages.find((m) => m.runId === staleRunId && m.streaming);
  if (t) {
    // 保留已输出的内容，不替换为错误信息
    t.streaming = false;
    flushSaveMessages();
    render();
  }
  setBusy(false);
  activeRunId = null;
}


function showCommandPopup(filter) {
  if (!cmdPopup) return;
  const q = (filter || '').toLowerCase();
  const items = SLASH_COMMANDS.filter((c) => !q || c.cmd.toLowerCase().includes(q));
  if (items.length === 0) {
    cmdPopup.hidden = true;
    return;
  }
  cmdPopup.innerHTML = items
    .map(
      (c) =>
        `<div class="cmd-item" data-cmd="${c.cmd}"><span class="cmd-name">${c.cmd}</span><span class="cmd-desc">${c.desc}</span></div>`,
    )
    .join('');
  cmdPopup.hidden = false;
  cmdPopup.querySelectorAll('.cmd-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = el.dataset.cmd;
      inputEl.value = cmd + ' ';
      inputEl.focus();
      cmdPopup.hidden = true;
    });
  });
}

function hideCommandPopup() {
  if (cmdPopup) cmdPopup.hidden = true;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
  if (!connected) {
    await checkConnection();
    if (!connected) return;
  }

  // 待发图片单独存 images[]；先转成浏览器可显示的 JPEG/PNG
  let outgoingImages = pendingImages.length > 0 ? [...pendingImages] : [];
  const outgoingFiles = pendingFiles.length > 0
    ? pendingFiles.map(({ dataUrl, name, mimeType, size }) => ({ dataUrl, name, mimeType, size }))
    : [];
  if (outgoingImages.length > 0 || outgoingFiles.length > 0) {
    pendingImages = [];
    pendingFiles = [];
    renderPendingAttachments();
  }
  if (outgoingImages.length > 0) {
    try {
      outgoingImages = await normalizeImageListForUi(outgoingImages);
    } catch (err) {
      setStatus(err.message || '图片处理失败', 'error');
      return;
    }
  }

  // 标记 /model 命令
  if (text.trimStart().startsWith('/model')) {
    pendingModelUpdate = true;
  }

  // 分配新 runId
  currentRunId += 1;
  const myRunId = currentRunId;

  // 立刻把 user 消息 push + 渲染（不卡 UI，方案 A3）
  messages.push({
    who: 'me',
    text,
    images: outgoingImages.length > 0 ? outgoingImages : undefined,
    files: outgoingFiles.length > 0 ? outgoingFiles : undefined,
    time: now(),
  });
  inputEl.value = '';
  inputEl.style.height = DEFAULT_INPUT_HEIGHT;
  hideCommandPopup();
  setStatus('', ''); // 清掉 “截屏完成，可发送” 之类的提示（发完了就没用了）

  // 给 user 消息留个对应的 assistant 占位（启孜回复的）
  // 如果当前没在跑 stream → 立刻开始流式；否则入队排队
  const assistantMsg = {
    who: 'them',
    text: busy ? '…' : '',         // 排队中显示三点，开了 stream 后清空
    time: now(),
    streaming: true,
    queued: busy,
    queuedAt: busy ? Date.now() : null,
    runId: myRunId,
    streamingStartedAt: Date.now(), // 心跳探活：流式起始时间
    lastDeltaAt: Date.now(),         // 心跳探活：最近一次收到 delta 的时间
  };
  messages.push(assistantMsg);
  flushSaveMessages();
  render();

  if (busy) {
    // 旧 stream 还在跑，入队等它跑完由 processQueue() 处理
    pendingQueue.push(assistantMsg);
  } else {
    // 没在跑，立刻起 stream
    setBusy(true);
    activeRunId = myRunId;
    runStream(assistantMsg);
  }
}

// 跑一条 assistant 消息的 stream，跑完自动处理队列下一条
// 注：之前有 60s 排队超时兜底，但实测发现启孜流式输出不会真的卡 60s，
//     反倒是这个超时把正常流式给掐断了。先撤掉，改成后续加连接探活。
async function runStream(assistantMsg) {
  const myRunId = assistantMsg.runId;
  activeRunId = myRunId;

  try {
    const payload = toChatPayload(assistantMsg);
    const result = await window.qizi.chatStream(payload, myRunId);
    if (result && result.ok === false && result.error && !result.aborted) {
      finishAssistant({ error: result.error, runId: myRunId });
    }
  } catch (err) {
    finishAssistant({ error: err.message || '发送失败', runId: myRunId });
  } finally {
    // 主动 abort 后队列已经被 abortRun 清空，这里不启动 processQueue
    if (userAborted) {
      setBusy(false);
      activeRunId = null;
      return;
    }
    if (pendingQueue.length > 0) {
      setTimeout(processQueue, QUEUE_INTER_MS);
    } else {
      setBusy(false);
      activeRunId = null;
    }
  }
}

// 队列处理器：从队列里取下一条，标记 streaming 状态，跑 stream
function processQueue() {
  if (userAborted) {
    // 主动 abort 后不启动队列
    userAborted = false;
    setBusy(false);
    activeRunId = null;
    return;
  }
  if (pendingQueue.length === 0) {
    setBusy(false);
    activeRunId = null;
    return;
  }
  const next = pendingQueue.shift();
  next.queued = false;
  next.queuedAt = null;
  next.streaming = true;
  next.text = '';   // 清理排队中的 '…'
  saveMessages();
  render();
  setBusy(true);
  runStream(next);
}

window.qizi.onChatDelta((delta, runId, replace) => {
  applyStreamingDelta(delta, runId, replace);
});

window.qizi.onChatDone((runId, payload) => {
  finishAssistant({ runId, text: payload?.text });
});

if (window.qizi.onGatewayStatus) {
  window.qizi.onGatewayStatus((payload) => {
    if (payload?.connected === false) {
      stopSessionWatch();
      if (payload.reconnecting !== false) {
        setStatus(busy ? '网络抖动，重连中…' : '重连中…', 'pending');
      } else {
        connected = false;
        setStatus('连接断开', 'error');
      }
    } else if (payload?.connected === true) {
      connected = true;
      if (payload.reconnected && busy) {
        setStatus('已重连，继续接收…', 'ok');
        syncHistoryFromGateway();
      } else {
        setStatus('已连接', 'ok');
        refreshCurrentModelBadge();
        if (!busy) syncHistoryFromGateway();
      }
      startSessionWatch();
    }
  });
}

if (window.qizi.onSessionChat) {
  window.qizi.onSessionChat((payload) => {
    handleExternalSessionChat(payload);
  });
}

if (window.qizi.onSessionChanged) {
  window.qizi.onSessionChanged(() => {
    if (!isLocalOwnedActiveRun()) {
      syncHistoryFromGateway();
    }
  });
}

// 探活 + 事件监听：主进程会推 done/error, 正常走那两个路径收尾
// 不再加 30s 兜底——LLM thinking 长时会被误判"已发完的消息末尾追加 [错误]"
// 真死了 (像 /stop 那次) 也不卡, 新 stream 走 runId 锁 + 入队, 不依赖旧 stream 收尾
// 用户主动 abort 时，立即保存已输出内容，不等待 500ms

window.qizi.onChatError((message, runId) => {
  finishAssistant({ error: message, runId });
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    hideCommandPopup();
    send();
    return;
  }
  if (e.key === 'Escape') {
    if (busy) {
      e.preventDefault();
      abortRun();
      return;
    }
    hideCommandPopup();
  }
});

inputEl.addEventListener('input', () => {
  const v = inputEl.value;
  if (v.startsWith('/')) {
    const filter = v.split(/\s/, 1)[0];
    showCommandPopup(filter);
  } else {
    hideCommandPopup();
  }
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 90), 200) + 'px';
});

inputEl.addEventListener('blur', () => {
  setTimeout(hideCommandPopup, 120);
});

if (stopBtn) {
  stopBtn.addEventListener('click', () => abortRun());
}

const screenshotBtn = document.getElementById('screenshot-btn');
if (screenshotBtn) {
  screenshotBtn.addEventListener('click', async () => {
    if (busy) return; // 生成中不准触发
    screenshotBtn.disabled = true;
    const oldTitle = screenshotBtn.title;
    screenshotBtn.title = '选个区域...';
    try {
      const result = await window.qizi.captureScreenshot();
      if (!result.ok) {
        if (result.canceled) return; // 用户按 Esc
        setStatus(`截屏失败: ${result.error || ''}`, 'error');
        return;
      }
      // 把 dataUrl 存到 pendingImages，预览区显示缩略图
      const ok = await addPendingImageDataUrl(result.dataUrl);
      if (!ok) {
        setStatus('截屏图片处理失败', 'error');
        return;
      }
      inputEl.focus();
      setStatus('截屏完成，可发送', 'ok');
    } finally {
      screenshotBtn.disabled = false;
      screenshotBtn.title = oldTitle;
    }
  });
}

const pickImageBtn = document.getElementById('pick-image-btn');
if (pickImageBtn) {
  pickImageBtn.addEventListener('click', async () => {
    if (busy) return;
    pickImageBtn.disabled = true;
    const oldTitle = pickImageBtn.title;
    pickImageBtn.title = '选图中…';
    try {
      const result = await window.qizi.pickImages();
      if (!result?.ok) {
        if (result?.canceled) return;
        setStatus(`选图失败: ${result?.error || ''}`, 'error');
        return;
      }
      let added = 0;
      let skipped = 0;
      for (const img of result.images || []) {
        const ok = await addPendingImageDataUrl(img.dataUrl);
        if (ok) added++;
        else skipped++;
      }
      if (added > 0) {
        inputEl.focus();
        setStatus(`已选 ${added} 张图，可发送`, 'ok');
      } else if (skipped > 0) {
        setStatus('图片未能加入（格式不支持或已达上限）', 'error');
      }
    } finally {
      pickImageBtn.disabled = false;
      pickImageBtn.title = oldTitle;
    }
  });
}

const pickFileBtn = document.getElementById('pick-file-btn');
if (pickFileBtn) {
  pickFileBtn.addEventListener('click', async () => {
    if (busy) return;
    pickFileBtn.disabled = true;
    const oldTitle = pickFileBtn.title;
    pickFileBtn.title = '选文件中…';
    try {
      const result = await window.qizi.pickFiles();
      if (!result?.ok) {
        if (result?.canceled) return;
        setStatus(`选文件失败: ${result?.error || ''}`, 'error');
        return;
      }
      let added = 0;
      let skipped = 0;
      for (const file of result.files || []) {
        const ok = addPendingFileEntry(file);
        if (ok) added++;
        else skipped++;
      }
      if (added > 0) {
        inputEl.focus();
        setStatus(`已选 ${added} 个文件，可发送`, 'ok');
      } else if (skipped > 0) {
        setStatus('文件未能加入（已达上限）', 'error');
      }
    } finally {
      pickFileBtn.disabled = false;
      pickFileBtn.title = oldTitle;
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy && document.activeElement !== inputEl) {
    abortRun();
  }
});

(function () {
  const composer = document.getElementById('composer');
  const handle = document.getElementById('composer-resize');
  let startY;
  let startH;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = composer.offsetHeight;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onUp);
  });
  function onDrag(e) {
    const delta = startY - e.clientY;
    const newH = Math.max(100, Math.min(startH + delta, window.innerHeight * 0.6));
    composer.style.height = newH + 'px';
    inputEl.style.height = (newH - 40) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onUp);
  }
})();

// 强制 textarea 初始高度（防止 composer-resize 把空 textarea 拖小后无法恢复）
inputEl.style.height = DEFAULT_INPUT_HEIGHT;

// ===== 拖拽图片到输入区 =====
let dragCounter = 0;
function isFileDrag(e) {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types || []).includes('Files');
}

document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.body.classList.remove('drag-over');
  }
});

document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files || []);
  let added = 0;
  let skipped = 0;
  for (const file of files) {
    const ok = await addPendingImage(file);
    if (ok) added++;
    else skipped++;
  }
  if (added > 0) inputEl.focus();
  if (skipped > 0) {
    console.warn(`[qizi] 跳过 ${skipped} 个不支持的文件（支持 PNG/JPG/GIF/WebP/HEIC）`);
  }
});

// ===== Cmd+V 黏贴剪贴板图片 =====
inputEl.addEventListener('paste', async (e) => {
  if (!e.clipboardData) return;
  const items = Array.from(e.clipboardData.items || []);
  const imageItems = items.filter((it) => {
    if (it.kind !== 'file') return false;
    const type = (it.type || '').toLowerCase();
    return type && ALLOWED_IMAGE_MIMES.includes(type);
  });
  if (imageItems.length === 0) return; // 让默认行为接管（纯文字粘贴）
  e.preventDefault();
  let added = 0;
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    const ok = await addPendingImage(file);
    if (ok) added++;
  }
  if (added > 0) inputEl.focus();
});

(async function bootstrap() {
  try {
    currentSessionKey = await window.qizi.getSessionKey();
    currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
    loadMessages();
    render();
    await refreshAgentTitleFromGateway();
  } catch {
    updateAgentTitleLabel({ id: currentAgentId });
  }
  checkConnection();
})();

window.addEventListener('beforeunload', () => {
  flushSaveMessages();
});

window.addEventListener('focus', () => {
  if (connected && !isLocalOwnedActiveRun()) {
    syncHistoryFromGateway();
  }
});

if (titlebarAgentBtn) {
  titlebarAgentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showAgentPopup();
  });
}

if (modelPickerBtn) {
  modelPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showModelPopup();
  });
}

document.addEventListener('click', (e) => {
  if (modelPopup && !modelPopup.hidden) {
    if (!e.target.closest('.model-picker-wrap')) hideModelPopup();
  }
  if (agentPopup && !agentPopup.hidden) {
    if (!e.target.closest('.titlebar-center')) hideAgentPopup();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsModal && !settingsModal.hidden) {
      closeSettingsModal();
      return;
    }
    if (modelPopup && !modelPopup.hidden) hideModelPopup();
    if (agentPopup && !agentPopup.hidden) hideAgentPopup();
  }
});

/* ---------------- 设置 ---------------- */
const SETTINGS_SOURCE_LABELS = {
  shell: '当前使用本应用内保存的配置',
  environment: '当前使用环境变量（优先级最高）',
  unset: '尚未配置，请填写管理员提供的 WSS 地址与 Token',
};

function formatConnectionStatusMessage(kind, detail) {
  if (kind === 'ok') {
    return detail ? `连接成功：${detail}` : '连接成功';
  }
  if (kind === 'error') {
    return detail || 'Gateway地址错误';
  }
  return '测试中…';
}

function syncSettingsTestStatusLayout() {
  const row = settingsTestBtn?.parentElement;
  if (!row || !settingsTestBtn) return;
  const gap = 10;
  row.style.setProperty('--settings-test-btn-offset', `${settingsTestBtn.offsetWidth + gap}px`);
}

function setSettingsStatus(text, kind, fullText) {
  if (!settingsStatusEl) return;
  if (!text) {
    settingsStatusEl.hidden = true;
    settingsStatusEl.textContent = '';
    settingsStatusEl.title = '';
    settingsStatusEl.className = 'settings-status';
    return;
  }
  settingsStatusEl.hidden = false;
  settingsStatusEl.textContent = text;
  settingsStatusEl.title = fullText || text;
  settingsStatusEl.className = `settings-status ${kind || ''}`.trim();
}

async function populateSettingsForm() {
  if (!window.qizi?.getSettings) return;
  const snapshot = await window.qizi.getSettings();
  if (settingsWsUrlInput) settingsWsUrlInput.value = snapshot.wsUrl || '';
  if (settingsTokenInput) {
    settingsTokenInput.value = '';
    settingsTokenInput.placeholder = snapshot.tokenSet ? '已保存，留空表示不修改' : 'Gateway 认证 Token';
  }
  if (settingsTokenNote) {
    settingsTokenNote.textContent = snapshot.tokenSet
      ? 'Token 已保存。若要更换请输入新值；测试连接时留空则用已保存值。'
      : '请向管理员索取 Gateway Token 后手动填写。';
  }
  if (settingsWsUrlInput && !settingsWsUrlInput.value) {
    settingsWsUrlInput.placeholder = '向管理员索取，如 wss://host:18789';
  }
  if (settingsSourceHint) {
    const sourceLabel = SETTINGS_SOURCE_LABELS[snapshot.source] || SETTINGS_SOURCE_LABELS.unset;
    settingsSourceHint.textContent = snapshot.envOverrides
      ? `${sourceLabel}（检测到环境变量覆盖）`
      : sourceLabel;
  }
  if (settingsLaunchAtLogin) settingsLaunchAtLogin.checked = snapshot.launchAtLogin === true;
  if (settingsShowMainOnLaunch) settingsShowMainOnLaunch.checked = snapshot.showMainOnLaunch !== false;
  setSettingsStatus('', '');
}

async function openSettingsModal() {
  if (!settingsModal) return;
  hideAgentPopup();
  hideModelPopup();
  await populateSettingsForm();
  settingsModal.hidden = false;
  requestAnimationFrame(syncSettingsTestStatusLayout);
}

function closeSettingsModal() {
  if (!settingsModal) return;
  settingsModal.hidden = true;
  setSettingsStatus('', '');
  if (settingsTokenInput) {
    settingsTokenInput.type = 'password';
    if (settingsTokenToggle) settingsTokenToggle.textContent = '显示';
  }
}

async function saveSettingsFromForm() {
  if (!window.qizi?.saveSettings) return;
  setSettingsStatus('正在保存…', 'pending');
  if (settingsSaveBtn) settingsSaveBtn.disabled = true;
  try {
    const result = await window.qizi.saveSettings({
      wsUrl: settingsWsUrlInput?.value || '',
      token: settingsTokenInput?.value || '',
      launchAtLogin: settingsLaunchAtLogin?.checked === true,
      showMainOnLaunch: settingsShowMainOnLaunch?.checked !== false,
    });
    if (!result?.ok) {
      setSettingsStatus(result?.error || '保存失败', 'error');
      return;
    }
    closeSettingsModal();
    await checkConnection();
  } catch (err) {
    setSettingsStatus(err?.message || '保存失败', 'error');
  } finally {
    if (settingsSaveBtn) settingsSaveBtn.disabled = false;
  }
}

async function testSettingsConnection() {
  if (!window.qizi?.testGatewaySettings) return;
  setSettingsStatus('测试中…', 'pending');
  if (settingsTestBtn) settingsTestBtn.disabled = true;
  try {
    const result = await window.qizi.testGatewaySettings({
      wsUrl: settingsWsUrlInput?.value || '',
      token: settingsTokenInput?.value || '',
    });
    if (result?.ok) {
      const full = `连接成功：${result.wsUrl || settingsWsUrlInput?.value || ''}`;
      setSettingsStatus(
        formatConnectionStatusMessage('ok', result.wsUrl || settingsWsUrlInput?.value || ''),
        'ok',
        full,
      );
    } else {
      const errText = result?.error || 'Gateway地址错误';
      setSettingsStatus(errText, 'error', errText);
    }
  } catch (err) {
    const errText = 'Gateway地址错误';
    setSettingsStatus(errText, 'error', errText);
  } finally {
    if (settingsTestBtn) settingsTestBtn.disabled = false;
  }
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsModal();
  });
}
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettingsModal);
if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsModal);
if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveSettingsFromForm);
if (settingsTestBtn) settingsTestBtn.addEventListener('click', testSettingsConnection);
window.addEventListener('resize', syncSettingsTestStatusLayout);
if (settingsTokenToggle && settingsTokenInput) {
  settingsTokenToggle.addEventListener('click', () => {
    const show = settingsTokenInput.type === 'password';
    settingsTokenInput.type = show ? 'text' : 'password';
    settingsTokenToggle.textContent = show ? '隐藏' : '显示';
  });
}
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
}
if (window.qizi?.onOpenSettings) {
  window.qizi.onOpenSettings(() => {
    openSettingsModal();
  });
}

/* ---------------- 图片点图放大（事件委托：你不发的图和我将来发的图都支持） ---------------- */
const imgModal = document.getElementById('img-modal');
const imgModalImg = document.getElementById('img-modal-img');
const imgModalCloseBtn = imgModal ? imgModal.querySelector('.img-modal-close') : null;

function openImgModal(src) {
  if (!imgModal) return;
  imgModalImg.src = src;
  imgModal.hidden = false;
}

function closeImgModal() {
  if (!imgModal) return;
  imgModal.hidden = true;
  imgModalImg.src = ''; // 释放大图内存
}

if (imgModal && imgModalCloseBtn) {
  // 点关闭按钮 / 点背景 关闭
  imgModalCloseBtn.addEventListener('click', closeImgModal);
  imgModal.addEventListener('click', (e) => {
    if (e.target === imgModal) closeImgModal();
  });
  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !imgModal.hidden) {
      e.stopPropagation();
      closeImgModal();
    }
  });
}

// 事件委托：点消息气泡里的任何 .msg-image 就打开 modal
if (messagesEl) {
  messagesEl.addEventListener('click', (e) => {
    const img = e.target.closest('img.msg-image');
    if (img && img.src) {
      e.preventDefault();
      openImgModal(img.src);
    }
  });
}
