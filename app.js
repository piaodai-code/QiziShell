const MessageTimeApi = window.MessageTime || {};
function resolveMessageOriginalSentTime(msg) {
  if (typeof MessageTimeApi.resolveMessageOriginalSentTime === 'function') {
    return MessageTimeApi.resolveMessageOriginalSentTime(msg);
  }
  return String(msg?.sentTime || msg?.time || '').trim();
}
function formatGatewayEnvelopeTime(input) {
  if (typeof MessageTimeApi.formatGatewayEnvelopeTime === 'function') {
    return MessageTimeApi.formatGatewayEnvelopeTime(input);
  }
  return '';
}

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const statusEl = document.getElementById('status');
const cmdPopup = document.getElementById('cmd-popup');
const composerPendingEl = document.getElementById('composer-pending');
const composerQuoteEl = document.getElementById('composer-quote');
const composerQuoteTextEl = document.getElementById('composer-quote-text');
const composerQuoteRemoveEl = document.getElementById('composer-quote-remove');
const msgContextMenuEl = document.getElementById('msg-context-menu');
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
const forwardModal = document.getElementById('forward-modal');
const forwardAgentsListEl = document.getElementById('forward-agents-list');
const forwardPreviewMetaEl = document.getElementById('forward-preview-meta');
const forwardPreviewScrollEl = document.getElementById('forward-preview-scroll');
const forwardPreviewTextEl = document.getElementById('forward-preview-text');
const forwardPreviewEllipsisEl = document.getElementById('forward-preview-ellipsis');
const forwardInputEl = document.getElementById('forward-input');
const forwardCancelBtn = document.getElementById('forward-cancel-btn');
const forwardSendBtn = document.getElementById('forward-send-btn');
const composerSendBtn = document.getElementById('composer-send-btn');
const composerBodyEl = document.getElementById('composer-body');
const composerMultiselectEl = document.getElementById('composer-multiselect');
const multiselectHintEl = document.getElementById('multiselect-hint');
const multiselectCancelBtn = document.getElementById('multiselect-cancel-btn');
const multiselectExportBtn = document.getElementById('multiselect-export-btn');
const multiselectSendBtn = document.getElementById('multiselect-send-btn');
const micBtn = document.getElementById('mic-btn');
const settingsSttHintEl = document.getElementById('settings-stt-hint');
const settingsSttUnsupportedEl = document.getElementById('settings-stt-unsupported');
const settingsSttInstallPanelEl = document.getElementById('settings-stt-install-panel');
const settingsSttReadyPanelEl = document.getElementById('settings-stt-ready-panel');
const settingsSttComponentsEl = document.getElementById('settings-stt-components');
const settingsSttTotalEl = document.getElementById('settings-stt-total');
const settingsSttInstallBtn = document.getElementById('settings-stt-install-btn');
const settingsSttProgressEl = document.getElementById('settings-stt-progress');
const settingsSttProgressFillEl = document.getElementById('settings-stt-progress-fill');
const settingsSttProgressTextEl = document.getElementById('settings-stt-progress-text');
const settingsSttStatusEl = document.getElementById('settings-stt-status');
const settingsSttRecordBtn = document.getElementById('settings-stt-record-btn');
const settingsSttRecordResultEl = document.getElementById('settings-stt-record-result');
const settingsSttTimerEl = document.getElementById('settings-stt-timer');
const settingsSttResultEl = document.getElementById('settings-stt-result');
const settingsSttUninstallBtn = document.getElementById('settings-stt-uninstall-btn');
const settingsSttUninstallBarEl = document.getElementById('settings-stt-uninstall-bar');
const settingsTabGatewayBtn = document.getElementById('settings-tab-gateway');
const settingsTabSttBtn = document.getElementById('settings-tab-stt');
const settingsPanelGatewayEl = document.getElementById('settings-panel-gateway');
const settingsPanelSttEl = document.getElementById('settings-panel-stt');
const sttRecordingOverlay = document.getElementById('stt-recording-overlay');
const sttRecordingWaveCanvas = document.getElementById('stt-recording-wave');
const sttRecordingWaveWrap = sttRecordingWaveCanvas?.closest('.stt-recording-wave-wrap');
const sttRecordingStopBtn = document.getElementById('stt-recording-stop-btn');
const sttRecordingCancelBtn = document.getElementById('stt-recording-cancel-btn');
const composerInputWrapEl = document.getElementById('composer-input-wrap');

let activeSettingsTab = 'gateway';

let sttReady = false;
let sttRecording = false;
let sttRecordingMode = null;
let sttMediaRecorder = null;
let sttMediaStream = null;
let sttAudioChunks = [];
let sttRecordTimer = null;
let sttRecordStartedAt = 0;
let sttRecordMaxSec = 30;
let sttRecordingDiscard = false;
let sttAudioContext = null;
let sttAnalyser = null;
let sttWaveformRaf = null;
const STT_WAVEFORM_POINTS = 80;
const STT_WAVEFORM_DRAW_MS = 55;
const STT_WAVEFORM_AMP = 0.76;
const STT_WAVEFORM_PEAK_FLOOR = 0.05;
const STT_WAVEFORM_PEAK_DECAY = 0.9;
const STT_WAVEFORM_SILENCE_RMS = 0.028;
const COMPOSER_INPUT_PLACEHOLDER = '输入消息，输入 / 看可用命令…';
const STT_RECOGNIZING_HINT = '正在识别，请稍候……';
const SETTINGS_STT_RESULT_PLACEHOLDER = '识别结果将显示在这里…';
let sttComposerPendingActive = false;

let pendingModelUpdate = false;
let currentModelQualified = null;
let modelCatalogCache = null;
let modelCatalogExpiresAt = 0;
const MODEL_CATALOG_TTL_MS = 60_000;

const SLASH_COMMANDS = [
  { cmd: '/stop', desc: '停止当前回复' },
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
/** @type {{ who: 'me'|'them', authorLabel: string, text: string, time?: string } | null} */
let pendingQuote = null;
let contextMenuTargetIndex = -1;
let forwardTargetMessage = null;
let forwardSelectedAgentIds = new Set();
let forwardBatchMode = false;
let multiSelectMode = false;
let multiSelectedIndices = new Set();
const LOCAL_USER_LABEL = '用户';
const BATCH_FORWARD_SOFT_WARN_BYTES = 256 * 1024;
const BATCH_FORWARD_HARD_MAX_BYTES = 2 * 1024 * 1024;

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
  updateComposerSendBtn();
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

function wrapMarkdownTables(html) {
  return String(html || '').replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => (
    `<div class="msg-table-wrap">${tableHtml}</div>`
  ));
}

function parseMarkdown(text, options = {}) {
  const parse = getMarkedParser();
  if (parse) {
    try {
      const result = parse(String(text || ''), {
        async: false,
        gfm: true,
        breaks: options.breaks === true,
        ...options.markedOptions,
      });
      if (typeof result === 'string' && result.trim()) {
        return wrapMarkdownTables(result);
      }
    } catch (e) {
      console.warn('[qizi] markdown parse failed:', e);
    }
  }
  return wrapMarkdownTables(String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>'));
}

function sanitizeExportHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function renderExportQuoteBlock(label, text) {
  const author = escapeHtml(label || '未知');
  const bodyHtml = parseMarkdown(text, { breaks: true });
  return `<div class="export-quote"><div class="export-quote-author">${author}</div>${bodyHtml}</div>`;
}

function renderExportMessageHtml(msg) {
  if (!msg) return '';
  const parts = [];
  const forwardRef = resolveMessageForwardRef(msg);
  if (forwardRef?.text) {
    parts.push(renderExportQuoteBlock(`转发 · ${forwardRef.authorLabel || '未知'}`, forwardRef.text));
  } else if (msg.quote?.text) {
    parts.push(renderExportQuoteBlock(`引用 · ${msg.quote.authorLabel || '未知'}`, msg.quote.text));
  }

  let bodySource = msg.who === 'me'
    ? getUserMessageDisplayText(msg)
    : String(msg.text || '');
  bodySource = bodySource.replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n').trim();
  if (bodySource) {
    parts.push(`<div class="export-body">${parseMarkdown(bodySource, { breaks: true })}</div>`);
  }
  return sanitizeExportHtml(parts.join(''));
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
const composerEl = document.getElementById('composer');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPickerEl = document.getElementById('emoji-picker');
let composerResized = false;

function resetInputHeight() {
  if (composerResized) {
    inputEl.style.height = '';
    inputEl.style.maxHeight = '';
    return;
  }
  inputEl.style.height = DEFAULT_INPUT_HEIGHT;
}
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

function getQuotePreviewLine(text) {
  const line = String(text || '').split(/\r?\n/).find((entry) => entry.trim()) || '';
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 96) return trimmed;
  return `${trimmed.slice(0, 96)}…`;
}

function getMessageAuthorLabel(msg) {
  if (!msg) return '未知';
  if (msg.who === 'me') return LOCAL_USER_LABEL;
  return formatAgentLabel(getCurrentAgentInfo());
}

function extractQuoteTextFromMessage(msg) {
  if (!msg) return '';
  const { plainText } = renderMessageContent(msg.text || '');
  let body = plainText.trim();
  if (!body && Array.isArray(msg.images) && msg.images.length > 0) {
    body = '（图片）';
  }
  if (!body && Array.isArray(msg.files) && msg.files.length > 0) {
    body = msg.files.map((file) => file.name).filter(Boolean).join('、') || '（附件）';
  }
  return body;
}

function buildClientReplyToMeta(ref) {
  const author = ref?.authorLabel || '未知';
  const role = ref?.who === 'me' ? 'user' : 'assistant';
  const time = resolveMessageOriginalSentTime(ref)
    || (typeof ref?.time === 'string' && ref.time.trim() ? formatGatewayEnvelopeTime(ref.time) : '');
  return {
    label: author,
    role,
    time,
  };
}

function formatQuoteForAgent(quote, userText) {
  const quotedBody = String(quote?.text || '').trim();
  const replyTo = buildClientReplyToMeta(quote);
  const meta = {
    label: replyTo.label,
    role: replyTo.role,
    kind: 'quoted-message',
    replyTo,
  };
  const parts = [
    'Sender (untrusted metadata):',
    '```json',
    JSON.stringify(meta),
    '```',
    '',
    '【引用开始】',
    quotedBody,
    '【引用结束】',
  ];
  const tail = String(userText || '').trim();
  if (tail) {
    parts.push('', '【回复】', tail);
  }
  return parts.join('\n');
}

function formatOutboundUserText(userMsg) {
  const typed = String(userMsg?.text || '').trim();
  if (userMsg?.quote) {
    return formatQuoteForAgent(userMsg.quote, typed);
  }
  return typed;
}

function parseSenderMetadataFromOutbound(body) {
  let authorLabel = '未知';
  let who = 'them';
  let time = '';
  const metaMatch = String(body || '').match(/Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      const replyTo = meta.replyTo && typeof meta.replyTo === 'object' ? meta.replyTo : null;
      if (typeof replyTo?.label === 'string' && replyTo.label.trim()) {
        authorLabel = replyTo.label.trim();
      } else if (typeof meta.label === 'string' && meta.label.trim()) {
        authorLabel = meta.label.trim();
      }
      if (replyTo?.role === 'user' || meta.role === 'user') who = 'me';
      else if (replyTo?.role === 'assistant' || meta.role === 'assistant') who = 'them';
      if (typeof replyTo?.time === 'string' && replyTo.time.trim()) {
        time = replyTo.time.trim();
      } else if (typeof meta.time === 'string' && meta.time.trim()) {
        time = meta.time.trim();
      }
    } catch {
      // ignore malformed metadata
    }
  }
  return { authorLabel, who, time };
}

const QUOTE_START_MARKER = '【引用开始】';
const QUOTE_END_MARKER = '【引用结束】';
const FORWARD_START_MARKER = '【转发开始】';
const FORWARD_END_MARKER = '【转发结束】';

function extractMarkedBlock(body, startMarker, endMarker) {
  const text = String(body || '');
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = text.lastIndexOf(endMarker);
  if (endIdx < contentStart) return null;
  return {
    content: text.slice(contentStart, endIdx).trim(),
    endIdx,
    endMarkerLength: endMarker.length,
  };
}

function parseStoredQuoteMessage(text) {
  const body = String(text || '');
  const block = extractMarkedBlock(body, QUOTE_START_MARKER, QUOTE_END_MARKER);
  if (!block) return null;

  const { authorLabel, who, time } = parseSenderMetadataFromOutbound(body);

  let reply = '';
  const afterBlock = block.endIdx + block.endMarkerLength;
  const replyMarker = body.indexOf('【回复】', afterBlock);
  if (replyMarker >= 0) {
    reply = body.slice(replyMarker + '【回复】'.length).trim();
  }

  return {
    reply,
    quote: {
      who,
      authorLabel,
      text: block.content,
      time,
    },
  };
}

function parseStoredForwardMessage(text) {
  const body = String(text || '');
  const block = extractMarkedBlock(body, FORWARD_START_MARKER, FORWARD_END_MARKER);
  if (!block) return null;

  const { authorLabel, who, time } = parseSenderMetadataFromOutbound(body);

  let comment = '';
  const afterBlock = block.endIdx + block.endMarkerLength;
  const commentMarker = body.indexOf('【留言】', afterBlock);
  if (commentMarker >= 0) {
    comment = body.slice(commentMarker + '【留言】'.length).trim();
  }

  return {
    comment,
    forward: {
      who,
      authorLabel,
      text: block.content,
      time,
    },
  };
}

function extractReplyTextFromOutbound(text) {
  const parsed = parseStoredQuoteMessage(text);
  if (parsed) return parsed.reply;
  return String(text || '');
}

function extractCommentTextFromForwardOutbound(text) {
  const parsed = parseStoredForwardMessage(text);
  if (parsed) return parsed.comment;
  return String(text || '');
}

function resolveMessageForwardRef(m) {
  if (!m || m.who !== 'me') return null;
  if (m.forward?.text) return m.forward;
  return parseStoredForwardMessage(m.text)?.forward || null;
}

function getUserMessageDisplayText(m) {
  if (!m || m.who !== 'me') return m?.text || '';
  if (m.forward) {
    const raw = String(m.text || '').trim();
    if (raw.includes('【转发开始】')) return extractCommentTextFromForwardOutbound(raw);
    return m.text || '';
  }
  if (m.quote) {
    const raw = String(m.text || '').trim();
    if (raw.includes('【引用开始】')) return extractReplyTextFromOutbound(raw);
    return m.text || '';
  }
  const forwardParsed = parseStoredForwardMessage(m.text);
  if (forwardParsed?.forward) return forwardParsed.comment;
  const parsed = parseStoredQuoteMessage(m.text);
  if (parsed?.quote) return parsed.reply;
  return m.text || '';
}

function normalizeUserMessageRecord(msg, localFallback = null) {
  const base = { ...msg, streaming: false };
  if (base.who !== 'me') return base;

  if (localFallback?.forward) {
    return {
      ...base,
      forward: localFallback.forward,
      text: localFallback.text ?? extractCommentTextFromForwardOutbound(base.text),
      images: localFallback.images ?? base.images,
      files: localFallback.files ?? base.files,
      time: localFallback.time || base.time,
      runId: localFallback.runId ?? base.runId,
    };
  }

  if (localFallback?.quote) {
    return {
      ...base,
      quote: localFallback.quote,
      text: localFallback.text ?? extractReplyTextFromOutbound(base.text),
      images: localFallback.images ?? base.images,
      files: localFallback.files ?? base.files,
      time: localFallback.time || base.time,
      runId: localFallback.runId ?? base.runId,
    };
  }

  const forwardParsed = parseStoredForwardMessage(base.text);
  if (forwardParsed?.forward) {
    return {
      ...base,
      forward: forwardParsed.forward,
      text: forwardParsed.comment,
    };
  }

  const parsed = parseStoredQuoteMessage(base.text);
  if (parsed?.quote) {
    return {
      ...base,
      quote: parsed.quote,
      text: parsed.reply,
    };
  }

  if (String(base.text || '').includes('【转发开始】')) {
    return { ...base, text: extractCommentTextFromForwardOutbound(base.text) };
  }

  if (String(base.text || '').includes('【引用开始】')) {
    return { ...base, text: extractReplyTextFromOutbound(base.text) };
  }

  return base;
}

function findLocalUserMessageForServer(server, localList) {
  const serverText = String(server?.text || '').trim();
  if (!serverText) return null;
  const serverParsed = parseStoredQuoteMessage(serverText);
  const serverReply = serverParsed?.reply ?? serverText;

  for (const candidate of localList) {
    if (candidate.who !== 'me') continue;
    if (candidate.quote) {
      const outbound = formatQuoteForAgent(candidate.quote, candidate.text || '').trim();
      if (serverText === outbound || serverReply === String(candidate.text || '').trim()) {
        return candidate;
      }
      continue;
    }
    const localText = String(candidate.text || '').trim();
    if (localText && (localText === serverText || localText === serverReply)) {
      return candidate;
    }
  }
  return null;
}

function quoteNeedsExpandToggle(text) {
  const body = String(text || '');
  const lines = body.split(/\r?\n/);
  if (lines.length > 3) return true;
  return body.length > 120 || lines.some((line) => line.length > 42);
}

function renderQuoteRefHtml(quote, msgIndex) {
  if (!quote?.text) return '';
  const author = escapeHtml(quote.authorLabel || '未知');
  const fullText = escapeHtml(quote.text);
  const quoteKey = String(msgIndex);
  const needsToggle = quoteNeedsExpandToggle(quote.text);
  const toggleBtn = needsToggle
    ? `<button type="button" class="msg-quote-toggle" data-quote-key="${quoteKey}" aria-expanded="false" aria-label="展开引用">▼</button>`
    : '';
  const collapsedClass = needsToggle ? ' is-collapsed' : '';
  return `<div class="msg-quote-card${collapsedClass}" data-quote-key="${quoteKey}"><div class="msg-quote-author">${author}</div><div class="msg-quote-body"><div class="msg-quote-text">${fullText}</div>${toggleBtn}</div></div>`;
}

function toggleQuoteCard(card, btn) {
  if (!card || !btn) return;
  const expanding = card.classList.contains('is-collapsed');
  if (expanding) {
    card.classList.remove('is-collapsed');
    btn.textContent = '▲';
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', '收起引用');
  } else {
    card.classList.add('is-collapsed');
    btn.textContent = '▼';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '展开引用');
  }
}

function renderComposerQuote() {
  if (!composerQuoteEl || !composerQuoteTextEl) return;
  if (!pendingQuote?.text) {
    composerQuoteEl.hidden = true;
    composerQuoteTextEl.textContent = '';
    updateComposerSendBtn();
    return;
  }
  const preview = getQuotePreviewLine(pendingQuote.text);
  composerQuoteTextEl.textContent = `${pendingQuote.authorLabel}：${preview}`;
  composerQuoteEl.hidden = false;
  updateComposerSendBtn();
}

function clearPendingQuote() {
  pendingQuote = null;
  renderComposerQuote();
  updateComposerSendBtn();
}

function setPendingQuoteFromMessage(msg) {
  const text = extractQuoteTextFromMessage(msg);
  if (!text) {
    setStatus('该消息没有可引用的文字', 'error');
    return false;
  }
  pendingQuote = {
    who: msg.who,
    authorLabel: getMessageAuthorLabel(msg),
    text,
    time: resolveMessageOriginalSentTime(msg),
    sentAtMs: msg.sentAtMs,
    sentTime: msg.sentTime,
  };
  renderComposerQuote();
  inputEl?.focus();
  return true;
}

function getForwardSourceText(msg) {
  if (!msg) return '';
  if (msg.who === 'me') {
    const parts = [];
    if (msg.quote?.text) {
      parts.push(`[引用 ${msg.quote.authorLabel || '未知'}]\n${msg.quote.text}`);
    }
    const reply = getUserMessageDisplayText(msg);
    if (reply) parts.push(reply);
    const combined = parts.join('\n\n').trim();
    if (combined) return combined;
  }
  return extractQuoteTextFromMessage(msg);
}

function buildForwardSnapshot(msg) {
  if (!msg) {
    return { who: 'them', authorLabel: '未知', text: '', time: '' };
  }
  if (msg.isMergedForward) {
    return {
      who: msg.who || 'them',
      authorLabel: msg.authorLabel || '已选消息',
      text: String(msg.text || '').trim(),
      time: msg.time || '',
      sentAtMs: msg.sentAtMs,
      sentTime: msg.sentTime,
    };
  }
  return {
    who: msg.who,
    authorLabel: getMessageAuthorLabel(msg),
    text: getForwardSourceText(msg),
    time: resolveMessageOriginalSentTime(msg),
    sentAtMs: msg.sentAtMs,
    sentTime: msg.sentTime,
  };
}

function utf8ByteLength(text) {
  try {
    return new TextEncoder().encode(String(text || '')).length;
  } catch {
    return String(text || '').length;
  }
}

function getMessageSelectableText(msg) {
  if (!msg) return '';
  const parts = [];
  const forwardRef = resolveMessageForwardRef(msg);
  if (forwardRef?.text) {
    parts.push(`[转发 ${forwardRef.authorLabel || '未知'}]\n${forwardRef.text}`);
  } else if (msg.quote?.text) {
    parts.push(`[引用 ${msg.quote.authorLabel || '未知'}]\n${msg.quote.text}`);
  }
  const body = msg.who === 'me' ? getUserMessageDisplayText(msg) : extractQuoteTextFromMessage(msg);
  if (body) parts.push(body);
  return parts.join('\n\n').trim();
}

function isMessageSelectable(msg) {
  if (!msg || msg.streaming) return false;
  return Boolean(getMessageSelectableText(msg));
}

function buildMergedForwardSnapshot(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const blocks = [];
  let earliestTime = '';
  let earliestSentAtMs;
  for (const idx of sorted) {
    const msg = messages[idx];
    if (!isMessageSelectable(msg)) continue;
    const text = getMessageSelectableText(msg);
    const author = getMessageAuthorLabel(msg);
    const stamp = msg.time ? ` · ${msg.time}` : '';
    blocks.push(`【${author}${stamp}】\n${text}`);
    const originalTime = resolveMessageOriginalSentTime(msg);
    if (!earliestTime && originalTime) earliestTime = originalTime;
    if (earliestSentAtMs == null && msg.sentAtMs) earliestSentAtMs = msg.sentAtMs;
  }
  return {
    isMergedForward: true,
    who: 'them',
    authorLabel: `已选 ${sorted.length} 条消息`,
    text: blocks.join('\n\n'),
    time: earliestTime,
    sentAtMs: earliestSentAtMs,
  };
}

function buildExportEntryForMessage(msg) {
  const text = getMessageSelectableText(msg);
  return {
    author: getMessageAuthorLabel(msg),
    time: msg.time || '',
    text,
    html: renderExportMessageHtml(msg),
  };
}

function buildExportEntries(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  return sorted
    .map((idx) => buildExportEntryForMessage(messages[idx]))
    .filter((entry) => entry.text || entry.html);
}

async function exportMessagesToWord(entries, { exitMultiSelectOnSuccess = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    setStatus('没有可导出的文字', 'error');
    return;
  }
  if (!window.qizi?.exportMessagesWord) {
    setStatus('导出功能不可用', 'error');
    return;
  }
  setStatus('正在导出…', 'pending');
  try {
    const result = await window.qizi.exportMessagesWord(entries);
    if (result?.cancelled) {
      setStatus('', '');
      return;
    }
    if (!result?.ok) {
      setStatus(result?.error || '导出失败', 'error');
      return;
    }
    setStatus('已导出', 'ok');
    if (exitMultiSelectOnSuccess) exitMultiSelectMode();
  } catch (err) {
    setStatus(err.message || '导出失败', 'error');
  }
}

async function exportMessageAtIndex(index) {
  const msg = messages[index];
  if (!isMessageSelectable(msg)) {
    setStatus('该消息没有可导出的文字', 'error');
    return;
  }
  hideMessageContextMenu();
  await exportMessagesToWord([buildExportEntryForMessage(msg)]);
}

function updateMultiSelectBar() {
  const count = multiSelectedIndices.size;
  if (multiselectHintEl) {
    multiselectHintEl.textContent = count > 0 ? `已选 ${count} 条` : '请选择消息';
  }
  const enabled = count > 0;
  if (multiselectExportBtn) multiselectExportBtn.disabled = !enabled;
  if (multiselectSendBtn) multiselectSendBtn.disabled = !enabled;
}

function setMultiSelectMode(enabled) {
  multiSelectMode = enabled;
  if (!enabled) multiSelectedIndices = new Set();
  if (messagesEl) messagesEl.classList.toggle('is-multiselect', enabled);
  if (composerBodyEl) composerBodyEl.hidden = enabled;
  if (composerMultiselectEl) composerMultiselectEl.hidden = !enabled;
  hideMessageContextMenu();
  updateMultiSelectBar();
  render();
}

function toggleMultiSelectIndex(index) {
  if (!multiSelectMode || index < 0 || index >= messages.length) return;
  const msg = messages[index];
  if (!isMessageSelectable(msg)) return;
  if (multiSelectedIndices.has(index)) {
    multiSelectedIndices.delete(index);
  } else {
    multiSelectedIndices.add(index);
  }
  updateMultiSelectBar();
  render();
}

function enterMultiSelectMode(initialIndex = -1) {
  setMultiSelectMode(true);
  if (initialIndex >= 0 && isMessageSelectable(messages[initialIndex])) {
    multiSelectedIndices.add(initialIndex);
    updateMultiSelectBar();
    render();
  }
}

function exitMultiSelectMode() {
  setMultiSelectMode(false);
}

function renderMessageSelectCheckHtml(index) {
  if (!multiSelectMode) return '';
  const msg = messages[index];
  if (!isMessageSelectable(msg)) {
    return '<button type="button" class="msg-select-check" hidden aria-hidden="true" tabindex="-1"></button>';
  }
  const selected = multiSelectedIndices.has(index);
  return `<button type="button" class="msg-select-check${selected ? ' selected' : ''}" data-msg-index="${index}" aria-label="${selected ? '取消选择' : '选择消息'}" aria-pressed="${selected ? 'true' : 'false'}">✓</button>`;
}

function formatForwardForAgent(forward, userText) {
  const forwardedBody = String(forward?.text || '').trim();
  const replyTo = buildClientReplyToMeta(forward);
  const meta = {
    label: replyTo.label,
    role: replyTo.role,
    kind: 'forwarded-message',
    replyTo,
  };
  const parts = [
    'Sender (untrusted metadata):',
    '```json',
    JSON.stringify(meta),
    '```',
    '',
    '【转发开始】',
    forwardedBody,
    '【转发结束】',
  ];
  const tail = String(userText || '').trim();
  if (tail) {
    parts.push('', '【留言】', tail);
  }
  return parts.join('\n');
}

function updateForwardPreviewEllipsis() {
  if (!forwardPreviewScrollEl || !forwardPreviewEllipsisEl) return;
  const overflow = forwardPreviewScrollEl.scrollHeight > forwardPreviewScrollEl.clientHeight + 1;
  forwardPreviewEllipsisEl.hidden = !overflow;
}

function scheduleForwardPreviewEllipsisCheck() {
  requestAnimationFrame(() => {
    updateForwardPreviewEllipsis();
    requestAnimationFrame(updateForwardPreviewEllipsis);
  });
}

function updateForwardSendButton() {
  if (!forwardSendBtn) return;
  forwardSendBtn.disabled = forwardSelectedAgentIds.size === 0;
}

function renderForwardAgentList(agents) {
  if (!forwardAgentsListEl) return;
  if (!agents.length) {
    forwardAgentsListEl.innerHTML = '<div class="forward-agents-empty">暂无可用 Agent</div>';
    return;
  }
  forwardAgentsListEl.innerHTML = '';
  for (const agent of agents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'forward-agent-item' + (forwardSelectedAgentIds.has(agent.id) ? ' selected' : '');
    btn.dataset.agentId = agent.id;

    const check = document.createElement('span');
    check.className = 'forward-agent-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');

    const avatarWrap = document.createElement('span');
    avatarWrap.innerHTML = buildAgentAvatarInner(agent, 'menu');

    const body = document.createElement('span');
    body.className = 'forward-agent-body';

    const nameRow = document.createElement('span');
    nameRow.className = 'forward-agent-name';
    nameRow.textContent = formatAgentLabel(agent);

    const meta = document.createElement('span');
    meta.className = 'forward-agent-meta';
    meta.textContent = formatAgentCurrentModel(agent);

    body.appendChild(nameRow);
    body.appendChild(meta);
    btn.appendChild(check);
    btn.appendChild(avatarWrap.firstElementChild || avatarWrap);
    btn.appendChild(body);
    btn.addEventListener('click', () => {
      if (forwardSelectedAgentIds.has(agent.id)) {
        forwardSelectedAgentIds.delete(agent.id);
      } else {
        forwardSelectedAgentIds.add(agent.id);
      }
      btn.classList.toggle('selected', forwardSelectedAgentIds.has(agent.id));
      updateForwardSendButton();
    });
    forwardAgentsListEl.appendChild(btn);
  }
}

function closeForwardModal() {
  if (!forwardModal) return;
  forwardModal.hidden = true;
  forwardTargetMessage = null;
  forwardBatchMode = false;
  forwardSelectedAgentIds = new Set();
  if (forwardInputEl) forwardInputEl.value = '';
  if (forwardPreviewTextEl) forwardPreviewTextEl.textContent = '';
  if (forwardPreviewMetaEl) forwardPreviewMetaEl.textContent = '';
  if (forwardPreviewEllipsisEl) forwardPreviewEllipsisEl.hidden = true;
  updateForwardSendButton();
}

async function openForwardModalWithSnapshot(snapshot, previewLabel, options = {}) {
  if (!forwardModal) return;
  const text = String(snapshot?.text || '').trim();
  if (!text) {
    setStatus('没有可转发的文字', 'error');
    return;
  }

  const bytes = utf8ByteLength(text);
  if (bytes > BATCH_FORWARD_HARD_MAX_BYTES) {
    setStatus(`合并内容约 ${Math.round(bytes / 1024)}KB，超过 2MB 上限`, 'error');
    return;
  }
  if (bytes > BATCH_FORWARD_SOFT_WARN_BYTES) {
    setStatus(`合并内容约 ${Math.round(bytes / 1024)}KB，可能接近 Gateway 上下文上限`, 'pending');
  }

  hideAgentPopup();
  hideModelPopup();
  hideMessageContextMenu();

  forwardTargetMessage = snapshot;
  forwardBatchMode = options.isBatch === true;
  forwardSelectedAgentIds = new Set();
  if (forwardInputEl) forwardInputEl.value = '';
  if (forwardPreviewMetaEl) {
    forwardPreviewMetaEl.textContent = previewLabel || `${snapshot.authorLabel || '未知'} · 转发内容`;
  }
  if (forwardPreviewTextEl) forwardPreviewTextEl.textContent = text;
  updateForwardSendButton();
  forwardModal.hidden = false;
  scheduleForwardPreviewEllipsisCheck();

  if (forwardAgentsListEl) {
    forwardAgentsListEl.innerHTML = '<div class="forward-agents-loading">加载 Agent…</div>';
  }

  if (!connected) {
    await checkConnection();
  }

  try {
    const result = await window.qizi.listAgents();
    if (!result?.ok) {
      if (forwardAgentsListEl) {
        forwardAgentsListEl.innerHTML = `<div class="forward-agents-error">${escapeHtml(result?.error || '加载失败')}</div>`;
      }
      return;
    }
    const agents = Array.isArray(result.agents) ? result.agents : [];
    applyAgentCatalog(agents);
    renderForwardAgentList(agents);
    scheduleForwardPreviewEllipsisCheck();
    forwardInputEl?.focus();
  } catch (err) {
    if (forwardAgentsListEl) {
      forwardAgentsListEl.innerHTML = `<div class="forward-agents-error">${escapeHtml(err.message || '加载失败')}</div>`;
    }
  }
}

async function openForwardModal(msg) {
  const snapshot = buildForwardSnapshot(msg);
  if (!snapshot.text) {
    setStatus('该消息没有可转发的文字', 'error');
    return;
  }
  await openForwardModalWithSnapshot(
    snapshot,
    `${getMessageAuthorLabel(msg)} · 转发内容`,
    { isBatch: false },
  );
}

async function openForwardModalForSelection() {
  if (multiSelectedIndices.size === 0) return;
  const snapshot = buildMergedForwardSnapshot(multiSelectedIndices);
  if (!snapshot.text) {
    setStatus('所选消息没有可转发的文字', 'error');
    return;
  }
  await openForwardModalWithSnapshot(
    snapshot,
    `已选 ${multiSelectedIndices.size} 条消息 · 转发预览`,
    { isBatch: true },
  );
}

async function exportSelectedMessages() {
  if (multiSelectedIndices.size === 0) return;
  const entries = buildExportEntries(multiSelectedIndices);
  await exportMessagesToWord(entries, { exitMultiSelectOnSuccess: true });
}

async function submitForward() {
  if (!forwardTargetMessage || forwardSelectedAgentIds.size === 0) return;
  const comment = forwardInputEl?.value || '';
  const outbound = formatForwardForAgent(buildForwardSnapshot(forwardTargetMessage), comment);
  if (!outbound.trim()) {
    setStatus('转发内容为空', 'error');
    return;
  }

  if (forwardSendBtn) forwardSendBtn.disabled = true;
  setStatus('正在转发…', 'pending');
  try {
    const result = await window.qizi.forwardMessage({
      agentIds: [...forwardSelectedAgentIds],
      message: outbound,
    });
    if (!result?.ok) {
      setStatus(result?.error || '转发失败', 'error');
      updateForwardSendButton();
      return;
    }
    const failed = Array.isArray(result.results)
      ? result.results.filter((entry) => !entry.ok)
      : [];
    if (failed.length > 0) {
      setStatus(`部分转发失败（${failed.length}）`, 'error');
    } else {
      setStatus('已转发', 'ok');
    }
    closeForwardModal();
    if (forwardBatchMode) exitMultiSelectMode();
  } catch (err) {
    setStatus(err.message || '转发失败', 'error');
    updateForwardSendButton();
  }
}

function hideMessageContextMenu() {
  if (!msgContextMenuEl) return;
  msgContextMenuEl.hidden = true;
  contextMenuTargetIndex = -1;
}

function showMessageContextMenu(x, y, msgIndex) {
  if (!msgContextMenuEl) return;
  contextMenuTargetIndex = msgIndex;
  msgContextMenuEl.hidden = false;
  const menuRect = msgContextMenuEl.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;
  msgContextMenuEl.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  msgContextMenuEl.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
}

function renderMessageBubbleContent(m, msgIndex = -1) {
  const extraImages = Array.isArray(m.images) ? m.images : [];
  const files = Array.isArray(m.files) ? m.files : [];
  let text = m.who === 'me' ? getUserMessageDisplayText(m) : (m.text || '');
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
  const forwardRef = resolveMessageForwardRef(m);
  if (forwardRef) {
    content.html = renderQuoteRefHtml(forwardRef, msgIndex) + content.html;
  } else if (m.quote) {
    content.html = renderQuoteRefHtml(m.quote, msgIndex) + content.html;
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
  } else if (local?.forward) {
    merged.text = localText || extractCommentTextFromForwardOutbound(serverText);
  } else if (local?.quote) {
    merged.text = localText || extractReplyTextFromOutbound(serverText);
  } else {
    const forwardParsed = parseStoredForwardMessage(serverText);
    if (forwardParsed?.forward) {
      merged.text = forwardParsed.comment || localText;
      merged.forward = forwardParsed.forward;
    } else {
      const parsed = parseStoredQuoteMessage(serverText);
      if (parsed?.quote) {
        merged.text = parsed.reply || localText;
        merged.quote = parsed.quote;
      } else {
        merged.text = serverText || localText;
      }
    }
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

  if (who === 'me' && local?.forward) {
    merged.forward = local.forward;
  }

  if (who === 'me' && local?.quote) {
    merged.quote = local.quote;
  }

  if (local?.sentAtMs) {
    merged.sentAtMs = local.sentAtMs;
    merged.sentTime = local.sentTime || merged.sentTime;
  } else if (server?.sentAtMs) {
    merged.sentAtMs = server.sentAtMs;
    merged.sentTime = server.sentTime;
  } else if (local?.sentTime) {
    merged.sentTime = local.sentTime;
  } else if (server?.sentTime) {
    merged.sentTime = server.sentTime;
  }

  return merged;
}

function assistantTextsMatch(a, b) {
  return String(a?.text || '').trim() === String(b?.text || '').trim();
}

function dedupeAssistantMessages(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const out = [];
  for (const msg of list) {
    if (msg?.who !== 'them') {
      out.push(msg);
      continue;
    }
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev?.who === 'them' && assistantTextsMatch(prev, msg) && !prev.streaming && !msg.streaming) {
      if (!prev.runId && msg.runId) {
        out[out.length - 1] = { ...msg, streaming: false };
      }
      continue;
    }
    out.push(msg);
  }
  return out;
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
      if (!local?.text && !local?.images?.length && !local?.files?.length) continue;
      if (local.who === 'them') {
        const lastThem = [...merged].reverse().find((m) => m.who === 'them');
        if (lastThem && assistantTextsMatch(lastThem, local)) continue;
      }
      merged.push({ ...local, streaming: false });
    }
  }
  return dedupeAssistantMessages(merged);
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
    const serverText = String(server?.text || '').trim();
    let local = findLocalUserMessageForServer(server, localList);

    if (!local && server.who === 'me') {
      for (const candidate of localList) {
        if (candidate.who !== 'me') continue;
        const localText = (candidate.text || '').trim();
        if (localText && serverText && localText === serverText) {
          local = candidate;
          break;
        }
      }
    }

    let copy = normalizeUserMessageRecord(server, local);

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

function clearStaleStreamingState(options = {}) {
  const force = options.force === true;
  let cleared = false;
  for (const message of messages) {
    if (message.streaming) {
      message.streaming = false;
      cleared = true;
    }
  }
  if (cleared && (force || !isLocalOwnedActiveRun())) {
    stopStreamHistoryPoll();
    setBusy(false);
    activeRunId = null;
    externalSessionRunId = null;
  }
  return cleared;
}

function isStopCommand(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized === '/stop' || normalized === '/abort';
}

async function handleStopCommand() {
  if (busy) {
    await abortRun();
    return;
  }
  try {
    await window.qizi.abortChat();
  } catch {
    // ignore
  }
  clearStaleStreamingState({ force: true });
  userAborted = false;
  flushSaveMessages();
  render();
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
      message: formatOutboundUserText(userMsg) || (userMsg.text || '').trim(),
      images: inlineImages,
      files: inlineFiles,
    };
  }
  const { plainText, images } = renderMessageContent(userMsg.text || '');
  return {
    message: formatOutboundUserText(userMsg) || plainText,
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
      quote: m.quote || undefined,
      forward: m.forward || undefined,
      sentTime: m.sentTime || undefined,
      sentAtMs: m.sentAtMs ?? undefined,
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
      messages = parsed.map((m) => normalizeUserMessageRecord({ ...m, streaming: false }));
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
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
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
        ${renderMessageSelectCheckHtml(i)}
      `;
      row.querySelector('.msg-bubble').innerHTML = renderMessageBubbleContent(m, i).html;
      messagesEl.appendChild(row);
    } catch (e) {
      console.error('render error:', e);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateStreamingBubble(runId) {
  if (!messagesEl || runId == null) return;
  const msgIndex = messages.findIndex((msg) => msg.runId === runId && msg.streaming);
  const m = msgIndex >= 0 ? messages[msgIndex] : null;
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
    bubble.innerHTML = renderMessageBubbleContent(m, msgIndex).html;
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
    || Boolean(m.quote?.text)
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
      // 本地 run 仍标记 busy 时，不做全量 merge，避免停止输出后重复追加助手气泡
      return;
    }

    clearStaleStreamingState();

    if (result.messages.length === 0 && messages.length > 0) return;

    if (!isLocalOwnedActiveRun()) {
      messages = dedupeAssistantMessages(
        overlayLocalAttachmentsOntoServerHistory(result.messages, messages),
      );
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
  if (userAborted && !error) return;
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

function composerHasSendableContent() {
  const text = inputEl?.value?.trim() || '';
  return Boolean(
    text || pendingQuote || pendingImages.length > 0 || pendingFiles.length > 0,
  );
}

function updateComposerSendBtn() {
  if (!composerSendBtn) return;
  const canSend = composerHasSendableContent();
  composerSendBtn.classList.toggle('is-stop', busy);
  composerSendBtn.disabled = !busy && !canSend;
  const label = busy ? '停止' : '发送';
  composerSendBtn.title = label;
  composerSendBtn.setAttribute('aria-label', label);
}

function setBusy(value) {
  busy = value;
  updateComposerSendBtn();
}

async function abortRun() {
  if (!busy) return;
  userAborted = true;
  stopStreamHistoryPoll();
  const staleRunId = activeRunId;
  // 清空队列里的所有 pending 消息，把它们从 messages 里也删掉
  for (const m of pendingQueue) {
    const idx = messages.indexOf(m);
    if (idx >= 0) messages.splice(idx, 1);
  }
  pendingQueue = [];
  const target = staleRunId != null
    ? messages.find((m) => m.who === 'them' && Number(m.runId) === Number(staleRunId))
    : null;
  if (target) {
    target.streaming = false;
  }
  setBusy(false);
  activeRunId = null;
  flushSaveMessages();
  render();
  try {
    await window.qizi.abortChat();
  } catch (e) { /* ignore */ }
  try {
    await syncHistoryFromGateway();
  } catch (e) { /* ignore */ }
  userAborted = false;
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
  if (!text && !pendingQuote && pendingImages.length === 0 && pendingFiles.length === 0) return;
  if (text && isStopCommand(text)) {
    inputEl.value = '';
    resetInputHeight();
    hideCommandPopup();
    await handleStopCommand();
    return;
  }
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

  const quoteSnapshot = pendingQuote ? { ...pendingQuote } : undefined;
  const sentAtMs = Date.now();

  // 立刻把 user 消息 push + 渲染（不卡 UI，方案 A3）
  messages.push({
    who: 'me',
    text,
    quote: quoteSnapshot,
    images: outgoingImages.length > 0 ? outgoingImages : undefined,
    files: outgoingFiles.length > 0 ? outgoingFiles : undefined,
    time: now(),
    sentTime: formatGatewayEnvelopeTime(sentAtMs),
    sentAtMs,
  });
  inputEl.value = '';
  resetInputHeight();
  clearPendingQuote();
  hideCommandPopup();
  updateComposerSendBtn();
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
  startStreamHistoryPoll(myRunId);

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

if (messagesEl) {
  messagesEl.addEventListener('click', (e) => {
    const selectBtn = e.target.closest('.msg-select-check');
    if (selectBtn && multiSelectMode) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(selectBtn.dataset.msgIndex);
      if (Number.isFinite(idx)) toggleMultiSelectIndex(idx);
      return;
    }
    if (multiSelectMode) {
      const row = e.target.closest('.msg');
      if (row && !e.target.closest('.msg-quote-toggle, a, .msg-bubble img')) {
        const rows = [...messagesEl.querySelectorAll('.msg')];
        const idx = rows.indexOf(row);
        if (idx >= 0) {
          e.preventDefault();
          toggleMultiSelectIndex(idx);
          return;
        }
      }
    }
    const toggleBtn = e.target.closest('.msg-quote-toggle');
    if (!toggleBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const card = toggleBtn.closest('.msg-quote-card');
    toggleQuoteCard(card, toggleBtn);
  });
  messagesEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg');
    if (!row || !messagesEl.contains(row)) return;
    e.preventDefault();
    const rows = [...messagesEl.querySelectorAll('.msg')];
    const msgIndex = rows.indexOf(row);
    if (msgIndex < 0 || msgIndex >= messages.length) return;
    const msg = messages[msgIndex];
    if (msg.streaming) {
      setStatus('生成中的消息暂不可操作', 'error');
      return;
    }
    showMessageContextMenu(e.clientX, e.clientY, msgIndex);
  });
  messagesEl.addEventListener('scroll', hideMessageContextMenu);
}

if (msgContextMenuEl) {
  msgContextMenuEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item || item.disabled) return;
    const action = item.dataset.action;
    if (action === 'quote') {
      const msg = messages[contextMenuTargetIndex];
      if (msg) setPendingQuoteFromMessage(msg);
      hideMessageContextMenu();
      return;
    }
    if (action === 'forward') {
      const msg = messages[contextMenuTargetIndex];
      if (msg) openForwardModal(msg);
      else hideMessageContextMenu();
      return;
    }
    if (action === 'multiselect') {
      enterMultiSelectMode(contextMenuTargetIndex);
      return;
    }
    if (action === 'export') {
      exportMessageAtIndex(contextMenuTargetIndex);
      return;
    }
    hideMessageContextMenu();
  });
}

document.addEventListener('click', (e) => {
  if (!msgContextMenuEl || msgContextMenuEl.hidden) return;
  if (e.target.closest('#msg-context-menu')) return;
  hideMessageContextMenu();
});

if (composerQuoteRemoveEl) {
  composerQuoteRemoveEl.addEventListener('click', () => {
    clearPendingQuote();
    inputEl?.focus();
  });
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    hideCommandPopup();
    send();
    return;
  }
  if (e.key === 'Escape') {
    if (multiSelectMode) {
      e.preventDefault();
      exitMultiSelectMode();
      return;
    }
    if (msgContextMenuEl && !msgContextMenuEl.hidden) {
      e.preventDefault();
      hideMessageContextMenu();
      return;
    }
    if (pendingQuote) {
      e.preventDefault();
      clearPendingQuote();
      return;
    }
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
  if (!composerResized) {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(Math.max(inputEl.scrollHeight, 90), 200)}px`;
  }
  updateComposerSendBtn();
});

inputEl.addEventListener('blur', () => {
  setTimeout(hideCommandPopup, 120);
});

if (composerSendBtn) {
  composerSendBtn.addEventListener('click', () => {
    if (busy) {
      abortRun();
      return;
    }
    send();
  });
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

const EMOJI_CATEGORIES = [
  { label: '笑脸', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉'] },
  { label: '大笑', emojis: ['😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚', '😙', '🥲'] },
  { label: '爱心', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'] },
  { label: '亲亲', emojis: ['😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶'] },
  { label: '眼镜', emojis: ['😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶'] },
  { label: '调皮', emojis: ['🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺'] },
  { label: '惊讶', emojis: ['😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠'] },
  { label: '难过', emojis: ['🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼'] },
  { label: '生气', emojis: ['😽', '🙀', '😿', '😾', '🙈', '🙉', '🙊', '💋', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️'] },
  { label: '生病', emojis: ['🗨️', '🗯️', '💭', '💤', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈'] },
  { label: '恶魔', emojis: ['👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️'] },
  { label: '手势', emojis: ['💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅'] },
  { label: 'OK', emojis: ['👄', '👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '👩', '🧓', '👴', '👵', '🙍', '🙎', '🙅', '🙆', '💁'] },
  { label: '挥手', emojis: ['🙋', '🧏', '🙇', '🤦', '🤷', '👮', '🕵️', '💂', '🥷', '👷', '🤴', '👸', '👳', '👲', '🧕', '🤵', '👰', '🤰'] },
  { label: '身体', emojis: ['🤱', '👼', '🎅', '🤶', '🦸', '🦹', '🧙', '🧚', '🧛', '🧜', '🧝', '🧞', '🧟', '💆', '💇', '🚶', '🧍', '🧎'] },
  { label: '人物', emojis: ['🏃', '💃', '🕺', '🕴️', '👯', '🧖', '🧗', '🤸', '🏌️', '🏇', '⛷️', '🏂', '🏋️', '🤼', '🤽', '🤾', '🤺', '⛹️'] },
  { label: '家庭', emojis: ['🏊', '🚣', '🧘', '🛀', '🛌', '👭', '👫', '👬', '💏', '💑', '👪', '👨‍👩‍👧', '👨‍👩‍👧‍👦', '👨‍👩‍👦‍👦', '👨‍👩‍👧‍👧', '👩‍👩‍👧', '👨‍👨‍👦', '👩‍👩‍👦'] },
  { label: '职业', emojis: ['🧑‍💻', '👨‍💻', '👩‍💻', '🧑‍🎓', '👨‍🎓', '👩‍🎓', '🧑‍🏫', '👨‍🏫', '👩‍🏫', '🧑‍⚕️', '👨‍⚕️', '👩‍⚕️', '🧑‍🔬', '👨‍🔬', '👩‍🔬', '🧑‍🎨', '👨‍🎨', '👩‍🎨'] },
  { label: '动物', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈'] },
  { label: '哺乳', emojis: ['🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝'] },
  { label: '鸟类', emojis: ['🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖'] },
  { label: '海洋', emojis: ['🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍'] },
  { label: '昆虫', emojis: ['🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙'] },
  { label: '植物', emojis: ['🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇'] },
  { label: '花卉', emojis: ['🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔', '🐾', '🐉', '🐲', '🌵', '🎄', '🌲', '🌳', '🌴'] },
  { label: '水果', emojis: ['🌱', '🌿', '☘️', '🍀', '🎍', '🎋', '🍃', '🍂', '🍁', '🍄', '🌾', '💐', '🌷', '🌹', '🥀', '🌺', '🌸', '🌼'] },
  { label: '蔬菜', emojis: ['🌻', '🌞', '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔', '🍎', '🍏', '🍐', '🍊'] },
  { label: '主食', emojis: ['🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬'] },
  { label: '甜点', emojis: ['🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳'] },
  { label: '饮料', emojis: ['🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯'] },
  { label: '运动', emojis: ['🫔', '🥗', '🥘', '🫕', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠'] },
  { label: '交通', emojis: ['🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰'] },
  { label: '物品', emojis: ['🥜', '🍯', '🥛', '🍼', '☕', '🫖', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹'] },
  { label: '符号', emojis: ['🧉', '🍾', '🧊', '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '✨', '⭐', '🌟', '💫', '🔥', '💧', '🌈', '☀️', '⛅', '☁️', '❄️', '⚡', '☔', '⛈️', '✅', '❌', '❓', '❗', '💯', '🔔', '🎵', '🎶', '♻️', '⚠️', '🚫', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪'] },
];

function buildEmojiPicker() {
  if (!emojiPickerEl) return;
  const frag = document.createDocumentFragment();
  EMOJI_CATEGORIES.forEach((cat) => {
    const section = document.createElement('section');
    section.className = 'emoji-category';
    const title = document.createElement('h4');
    title.className = 'emoji-category-title';
    title.textContent = cat.label;
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    cat.emojis.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.title = emoji;
      btn.addEventListener('click', () => {
        insertEmojiAtCursor(emoji);
        hideEmojiPicker();
      });
      grid.appendChild(btn);
    });
    section.appendChild(title);
    section.appendChild(grid);
    frag.appendChild(section);
  });
  emojiPickerEl.appendChild(frag);
}

function normalizeUtf16CaretIndex(value, index) {
  let i = Math.max(0, Math.min(index ?? 0, value.length));
  if (i > 0 && i < value.length) {
    const prev = value.charCodeAt(i - 1);
    const curr = value.charCodeAt(i);
    if (prev >= 0xD800 && prev <= 0xDBFF && curr >= 0xDC00 && curr <= 0xDFFF) {
      i += 1;
    }
  }
  return i;
}

function insertEmojiAtCursor(emoji) {
  const value = inputEl.value;
  const start = normalizeUtf16CaretIndex(value, inputEl.selectionStart ?? value.length);
  const end = normalizeUtf16CaretIndex(value, inputEl.selectionEnd ?? start);
  const safeStart = start <= end ? start : end;
  const safeEnd = start <= end ? end : start;
  const before = value.slice(0, safeStart);
  const after = value.slice(safeEnd);
  inputEl.value = before + emoji + after;
  const pos = safeStart + emoji.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function positionEmojiPicker() {
  if (!emojiBtn || !emojiPickerEl || emojiPickerEl.hidden) return;
  const rect = emojiBtn.getBoundingClientRect();
  const panelW = emojiPickerEl.offsetWidth;
  const panelH = emojiPickerEl.offsetHeight;
  const gap = 6;
  let top = rect.top - panelH - gap;
  if (top < 8) top = 8;
  const maxLeft = window.innerWidth - panelW - 8;
  const left = Math.max(8, Math.min(rect.left, maxLeft));
  emojiPickerEl.style.left = `${left}px`;
  emojiPickerEl.style.top = `${top}px`;
}

function showEmojiPicker() {
  if (!emojiPickerEl) return;
  hideModelPopup();
  emojiPickerEl.hidden = false;
  positionEmojiPicker();
  requestAnimationFrame(positionEmojiPicker);
  if (emojiBtn) {
    emojiBtn.classList.add('open');
    emojiBtn.setAttribute('aria-expanded', 'true');
  }
}

function hideEmojiPicker() {
  if (!emojiPickerEl || emojiPickerEl.hidden) return;
  emojiPickerEl.hidden = true;
  if (emojiBtn) {
    emojiBtn.classList.remove('open');
    emojiBtn.setAttribute('aria-expanded', 'false');
  }
}

function toggleEmojiPicker() {
  if (!emojiPickerEl) return;
  if (emojiPickerEl.hidden) showEmojiPicker();
  else hideEmojiPicker();
}

buildEmojiPicker();

if (emojiBtn) {
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEmojiPicker();
  });
}

(function () {
  const handle = document.getElementById('composer-resize');
  if (!handle || !composerEl) return;
  let startY;
  let startH;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = composerEl.offsetHeight;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onUp);
  });
  function onDrag(e) {
    const delta = startY - e.clientY;
    const newH = Math.max(120, Math.min(startH + delta, window.innerHeight * 0.6));
    composerResized = true;
    composerEl.classList.add('composer--resized');
    composerEl.style.height = `${newH}px`;
    inputEl.style.height = '';
    inputEl.style.maxHeight = '';
    positionEmojiPicker();
  }
  function onUp() {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onUp);
  }
})();

resetInputHeight();
updateComposerSendBtn();

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
  refreshSttUi();
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
  if (emojiPickerEl && !emojiPickerEl.hidden) {
    if (!e.target.closest('.emoji-picker-wrap') && !e.target.closest('.emoji-picker')) {
      hideEmojiPicker();
    }
  }
  if (agentPopup && !agentPopup.hidden) {
    if (!e.target.closest('.titlebar-center')) hideAgentPopup();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (multiSelectMode) {
      exitMultiSelectMode();
      return;
    }
    if (forwardModal && !forwardModal.hidden) {
      closeForwardModal();
      return;
    }
    if (settingsModal && !settingsModal.hidden) {
      closeSettingsModal();
      return;
    }
    if (modelPopup && !modelPopup.hidden) hideModelPopup();
    if (emojiPickerEl && !emojiPickerEl.hidden) hideEmojiPicker();
    if (agentPopup && !agentPopup.hidden) hideAgentPopup();
  }
});

if (multiselectCancelBtn) {
  multiselectCancelBtn.addEventListener('click', exitMultiSelectMode);
}
if (multiselectExportBtn) {
  multiselectExportBtn.addEventListener('click', exportSelectedMessages);
}
if (multiselectSendBtn) {
  multiselectSendBtn.addEventListener('click', openForwardModalForSelection);
}

if (forwardCancelBtn) {
  forwardCancelBtn.addEventListener('click', closeForwardModal);
}
if (forwardSendBtn) {
  forwardSendBtn.addEventListener('click', submitForward);
}
if (forwardModal) {
  forwardModal.addEventListener('click', (e) => {
    if (e.target === forwardModal) closeForwardModal();
  });
}
window.addEventListener('resize', () => {
  if (forwardModal && !forwardModal.hidden) updateForwardPreviewEllipsis();
  positionEmojiPicker();
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

function setSttSettingsStatus(text, kind) {
  if (!settingsSttStatusEl) return;
  if (!text) {
    settingsSttStatusEl.hidden = true;
    settingsSttStatusEl.textContent = '';
    settingsSttStatusEl.className = 'settings-status';
    return;
  }
  settingsSttStatusEl.hidden = false;
  settingsSttStatusEl.textContent = text;
  settingsSttStatusEl.className = `settings-status ${kind || ''}`.trim();
}

function setSttRecordTestResult(outcome) {
  if (!settingsSttRecordResultEl) return;
  if (outcome === 'success') {
    settingsSttRecordResultEl.hidden = false;
    settingsSttRecordResultEl.textContent = '语音识别成功';
    settingsSttRecordResultEl.className = 'settings-stt-record-result ok';
    return;
  }
  if (outcome === 'failure') {
    settingsSttRecordResultEl.hidden = false;
    settingsSttRecordResultEl.textContent = '语音识别失败';
    settingsSttRecordResultEl.className = 'settings-stt-record-result error';
    return;
  }
  settingsSttRecordResultEl.hidden = true;
  settingsSttRecordResultEl.textContent = '';
  settingsSttRecordResultEl.className = 'settings-stt-record-result';
}

function updateSttUninstallFooterVisibility(ready) {
  const show = ready === true && activeSettingsTab === 'stt';
  if (settingsSttUninstallBarEl) settingsSttUninstallBarEl.hidden = !show;
}

function updateMicButtonState() {
  if (!micBtn) return;
  if (sttRecording && sttRecordingMode === 'composer') {
    micBtn.disabled = false;
    micBtn.classList.remove('is-disabled');
    micBtn.classList.add('is-recording');
    micBtn.title = '点击停止录音并转文字';
    micBtn.setAttribute('aria-disabled', 'false');
    return;
  }
  micBtn.classList.remove('is-recording');
  if (sttReady) {
    micBtn.disabled = false;
    micBtn.classList.remove('is-disabled');
    micBtn.title = '语音输入（点击开始，再点结束）';
    micBtn.setAttribute('aria-disabled', 'false');
  } else {
    micBtn.disabled = true;
    micBtn.classList.add('is-disabled');
    micBtn.title = '请先在设置中安装语音识别';
    micBtn.setAttribute('aria-disabled', 'true');
  }
}

async function refreshSttUi() {
  if (!window.qizi?.getSttStatus) return;
  try {
    const status = await window.qizi.getSttStatus();
    sttReady = status?.ready === true;
  } catch {
    sttReady = false;
  }
  updateMicButtonState();
  if (settingsModal && !settingsModal.hidden) {
    await renderSttSettingsPanel();
  }
}

async function renderSttSettingsPanel() {
  if (!window.qizi?.getSttStatus) return;
  const status = await window.qizi.getSttStatus();
  sttReady = status?.ready === true;
  updateMicButtonState();

  if (settingsSttHintEl) {
    settingsSttHintEl.textContent = status.supported
      ? 'Apple Silicon Mac 本地识别，数据不上传云端。'
      : '';
  }

  if (settingsSttUnsupportedEl) {
    if (!status.supported) {
      settingsSttUnsupportedEl.hidden = false;
      settingsSttUnsupportedEl.textContent = status.message || '当前设备不支持语音识别。';
    } else {
      settingsSttUnsupportedEl.hidden = true;
      settingsSttUnsupportedEl.textContent = '';
    }
  }

  if (settingsSttInstallPanelEl) {
    settingsSttInstallPanelEl.hidden = !status.supported || status.ready;
  }
  if (settingsSttReadyPanelEl) {
    settingsSttReadyPanelEl.hidden = !status.ready;
  }

  if (settingsSttComponentsEl && Array.isArray(status.components)) {
    settingsSttComponentsEl.innerHTML = status.components
      .map((c) => `<li><strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(c.sizeLabel)}</li>`)
      .join('');
  }
  if (settingsSttTotalEl) {
    settingsSttTotalEl.textContent = status.totalSizeLabel || '';
  }
  if (settingsSttInstallBtn) {
    settingsSttInstallBtn.disabled = status.installing === true;
  }
  updateSttUninstallFooterVisibility(status.ready === true);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') {
        reject(new Error('读取音频失败'));
        return;
      }
      resolve(dataUrl.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error || new Error('读取音频失败'));
    reader.readAsDataURL(blob);
  });
}

function pickAudioMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

function formatRecordTimer(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function clearSttRecordTimer() {
  if (sttRecordTimer) {
    clearInterval(sttRecordTimer);
    sttRecordTimer = null;
  }
}

function stopSttWaveform() {
  if (sttWaveformRaf) {
    cancelAnimationFrame(sttWaveformRaf);
    sttWaveformRaf = null;
  }
  if (sttAudioContext) {
    sttAudioContext.close().catch(() => {});
    sttAudioContext = null;
  }
  sttAnalyser = null;
}

function getSttWaveformSize() {
  const wrap = sttRecordingWaveWrap || sttRecordingWaveCanvas?.parentElement;
  const cssWidth = Math.max(160, Math.round(wrap?.clientWidth || 320));
  const cssHeight = Math.max(40, Math.round(wrap?.clientHeight || 56));
  return { cssWidth, cssHeight };
}

function startSttWaveform(stream) {
  if (!sttRecordingWaveCanvas || !stream) return;
  stopSttWaveform();

  const canvas = sttRecordingWaveCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { cssWidth, cssHeight } = getSttWaveformSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  sttAudioContext = new AudioCtx();
  if (sttAudioContext.state === 'suspended') {
    sttAudioContext.resume().catch(() => {});
  }
  const source = sttAudioContext.createMediaStreamSource(stream);
  sttAnalyser = sttAudioContext.createAnalyser();
  sttAnalyser.fftSize = 2048;
  sttAnalyser.smoothingTimeConstant = 0.72;
  source.connect(sttAnalyser);

  const bufferLength = sttAnalyser.fftSize;
  const timeData = new Uint8Array(bufferLength);
  const pointCount = STT_WAVEFORM_POINTS;
  const sampleStep = Math.max(1, Math.floor(bufferLength / pointCount));
  const bucketSamples = new Float32Array(pointCount);
  const midY = cssHeight / 2;
  let displayPeak = STT_WAVEFORM_PEAK_FLOOR;
  let lastDrawAt = 0;

  const draw = (now) => {
    if (!sttAnalyser) return;
    sttWaveformRaf = requestAnimationFrame(draw);
    if (now - lastDrawAt < STT_WAVEFORM_DRAW_MS) return;
    lastDrawAt = now;

    sttAnalyser.getByteTimeDomainData(timeData);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(cssWidth, midY);
    ctx.stroke();

    let sumSq = 0;
    for (let i = 0; i < bufferLength; i += 1) {
      const s = timeData[i] / 128 - 1;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / bufferLength);

    ctx.strokeStyle = '#1976d2';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, midY);

    if (rms < STT_WAVEFORM_SILENCE_RMS) {
      displayPeak = STT_WAVEFORM_PEAK_FLOOR;
      ctx.lineTo(cssWidth, midY);
      ctx.stroke();
      return;
    }

    let framePeak = STT_WAVEFORM_PEAK_FLOOR;
    for (let p = 0; p < pointCount; p += 1) {
      const start = p * sampleStep;
      const end = Math.min(start + sampleStep, bufferLength);
      let pick = 0;
      for (let i = start; i < end; i += 1) {
        const s = timeData[i] / 128 - 1;
        if (Math.abs(s) >= Math.abs(pick)) pick = s;
      }
      bucketSamples[p] = pick;
      framePeak = Math.max(framePeak, Math.abs(pick));
    }
    displayPeak = Math.max(framePeak, displayPeak * STT_WAVEFORM_PEAK_DECAY);
    const gain = (cssHeight * STT_WAVEFORM_AMP) / (2 * Math.max(displayPeak, STT_WAVEFORM_PEAK_FLOOR));

    const gap = cssWidth / (pointCount - 1);
    for (let p = 0; p < pointCount; p += 1) {
      const x = p * gap;
      const y = midY + bucketSamples[p] * gain;
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  draw(0);
}

function showSttRecordingOverlay(mode) {
  if (!sttRecordingOverlay) return;
  const isModal = mode === 'test';
  sttRecordingOverlay.classList.toggle('is-modal', isModal);
  sttRecordingOverlay.hidden = false;
  if (composerInputWrapEl) {
    composerInputWrapEl.hidden = !isModal && mode === 'composer';
  }
  requestAnimationFrame(() => startSttWaveform(sttMediaStream));
}

function hideSttRecordingOverlay() {
  stopSttWaveform();
  if (sttRecordingOverlay) {
    sttRecordingOverlay.hidden = true;
    sttRecordingOverlay.classList.remove('is-modal');
  }
  if (composerInputWrapEl) composerInputWrapEl.hidden = false;
}

function updateSttRecordTimerDisplay() {
  const elapsed = (Date.now() - sttRecordStartedAt) / 1000;
  if (settingsSttTimerEl && sttRecordingMode === 'test') {
    settingsSttTimerEl.textContent = formatRecordTimer(elapsed);
  }
  if (elapsed >= sttRecordMaxSec) {
    stopSttRecording();
  }
}

async function stopSttMedia() {
  if (sttMediaRecorder && sttMediaRecorder.state !== 'inactive') {
    try {
      sttMediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  if (sttMediaStream) {
    sttMediaStream.getTracks().forEach((t) => t.stop());
    sttMediaStream = null;
  }
}

async function startSttRecording(mode) {
  if (sttRecording || !sttReady) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('当前环境无法访问麦克风', 'error');
    return;
  }
  try {
    sttMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? '未授予麦克风权限，请在系统设置中允许启孜 Shell 使用麦克风'
      : (err.message || '无法打开麦克风');
    if (mode === 'test') setSttRecordTestResult('failure');
    else setStatus(msg, 'error');
    return;
  }

  sttAudioChunks = [];
  const mimeType = pickAudioMimeType();
  sttMediaRecorder = mimeType
    ? new MediaRecorder(sttMediaStream, { mimeType })
    : new MediaRecorder(sttMediaStream);
  sttMediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) sttAudioChunks.push(e.data);
  };
  sttMediaRecorder.onstop = () => {
    if (mode === 'composer' && !sttRecordingDiscard) {
      showComposerSttPending(true);
    } else if (mode === 'test' && !sttRecordingDiscard) {
      showSettingsSttTestPending(true);
    }
    finalizeSttRecording(mode, sttMediaRecorder.mimeType || mimeType || 'webm');
  };
  sttMediaRecorder.start(250);
  sttRecording = true;
  sttRecordingMode = mode;
  sttRecordStartedAt = Date.now();
  sttRecordMaxSec = mode === 'test' ? 30 : 300;
  clearSttRecordTimer();
  sttRecordTimer = setInterval(updateSttRecordTimerDisplay, 200);

  showSttRecordingOverlay(mode);

  if (mode === 'test') {
    if (settingsSttRecordBtn) settingsSttRecordBtn.disabled = true;
    if (settingsSttResultEl) settingsSttResultEl.value = '';
    if (settingsSttTimerEl) settingsSttTimerEl.textContent = '00:00';
    setSttRecordTestResult('');
    setSttSettingsStatus('', '');
  } else {
    setStatus('', '');
  }
  updateMicButtonState();
}

function stopSttRecording() {
  if (!sttRecording) return;
  clearSttRecordTimer();
  sttRecording = false;
  hideSttRecordingOverlay();
  if (settingsSttRecordBtn) {
    settingsSttRecordBtn.disabled = false;
    settingsSttRecordBtn.textContent = '开始录音';
  }
  if (sttMediaRecorder && sttMediaRecorder.state !== 'inactive') {
    sttMediaRecorder.stop();
  } else {
    stopSttMedia();
    sttRecordingMode = null;
    sttRecordingDiscard = false;
    updateMicButtonState();
  }
}

function cancelSttRecording() {
  if (!sttRecording) return;
  sttRecordingDiscard = true;
  stopSttRecording();
}

function showComposerSttPending(active) {
  if (!inputEl) return;
  sttComposerPendingActive = active;
  if (composerInputWrapEl) composerInputWrapEl.hidden = false;
  if (active) {
    inputEl.value = '';
    inputEl.disabled = true;
    inputEl.placeholder = STT_RECOGNIZING_HINT;
    inputEl.classList.add('is-stt-pending');
  } else {
    inputEl.disabled = false;
    inputEl.placeholder = COMPOSER_INPUT_PLACEHOLDER;
    inputEl.classList.remove('is-stt-pending');
  }
  updateComposerSendBtn();
}

function showSettingsSttTestPending(active) {
  if (!settingsSttResultEl) return;
  if (active) {
    settingsSttResultEl.value = '';
    settingsSttResultEl.placeholder = STT_RECOGNIZING_HINT;
    settingsSttResultEl.classList.add('is-stt-pending');
  } else {
    settingsSttResultEl.placeholder = SETTINGS_STT_RESULT_PLACEHOLDER;
    settingsSttResultEl.classList.remove('is-stt-pending');
  }
}

async function finalizeSttRecording(mode, mimeType) {
  const discard = sttRecordingDiscard;
  sttRecordingDiscard = false;
  const chunks = discard ? [] : sttAudioChunks;
  sttAudioChunks = [];
  await stopSttMedia();
  sttMediaRecorder = null;
  sttRecordingMode = null;
  updateMicButtonState();

  if (discard) {
    if (mode === 'test') {
      showSettingsSttTestPending(false);
      setSttSettingsStatus('', '');
    } else showComposerSttPending(false);
    return;
  }

  if (!chunks.length) {
    if (mode === 'test') {
      showSettingsSttTestPending(false);
      setSttRecordTestResult('failure');
    } else showComposerSttPending(false);
    return;
  }

  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
  const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';

  if (mode === 'test') {
    showSettingsSttTestPending(true);
    if (settingsSttRecordBtn) settingsSttRecordBtn.disabled = true;
  } else if (micBtn) {
    micBtn.disabled = true;
  }

  try {
    const data = await blobToBase64(blob);
    const result = await window.qizi.transcribeStt({ data, ext });
    if (!result?.ok) {
      const err = result?.error || '识别失败';
      if (mode === 'test') {
        showSettingsSttTestPending(false);
        setSttRecordTestResult('failure');
      } else {
        showComposerSttPending(false);
        setStatus(err, 'error');
      }
      return;
    }
    const text = String(result.text || '').trim();
    if (mode === 'test') {
      showSettingsSttTestPending(false);
      if (settingsSttResultEl) settingsSttResultEl.value = text;
      setSttRecordTestResult(text ? 'success' : 'failure');
    } else if (text) {
      showComposerSttPending(false);
      insertTextAtInputCursor(text);
    } else {
      showComposerSttPending(false);
      setStatus('未识别到文字', 'error');
    }
  } catch (err) {
    const errText = err.message || '识别失败';
    if (mode === 'test') {
      showSettingsSttTestPending(false);
      setSttRecordTestResult('failure');
    } else {
      showComposerSttPending(false);
      setStatus(errText, 'error');
    }
  } finally {
    if (settingsSttRecordBtn) settingsSttRecordBtn.disabled = false;
    if (sttComposerPendingActive) showComposerSttPending(false);
    if (settingsSttResultEl?.classList.contains('is-stt-pending')) {
      showSettingsSttTestPending(false);
    }
    updateMicButtonState();
  }
}

function insertTextAtInputCursor(text) {
  if (!inputEl || !text) return;
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? start;
  const before = inputEl.value.slice(0, start);
  const after = inputEl.value.slice(end);
  const spacer = before && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  inputEl.value = before + spacer + text + after;
  const pos = (before + spacer + text).length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  updateComposerSendBtn();
}

async function installSttFromSettings() {
  if (!window.qizi?.installStt) return;
  if (settingsSttInstallBtn) settingsSttInstallBtn.disabled = true;
  if (settingsSttProgressEl) settingsSttProgressEl.hidden = false;
  if (settingsSttProgressFillEl) settingsSttProgressFillEl.style.width = '0%';
  setSttSettingsStatus('准备安装…', 'pending');

  const result = await window.qizi.installStt();
  if (result?.ok) {
    setSttSettingsStatus('安装完成', 'ok');
    if (settingsSttProgressFillEl) settingsSttProgressFillEl.style.width = '100%';
    await refreshSttUi();
  } else {
    if (result?.needsPython) {
      setSttSettingsStatus(
        `${result.error || '未检测到 Python 3'} 安装完成后点击「安装语音识别」重试。`,
        'error',
      );
    } else {
      setSttSettingsStatus(result?.error || '安装失败', 'error');
    }
    if (settingsSttInstallBtn) settingsSttInstallBtn.disabled = false;
  }
}

async function uninstallSttFromSettings() {
  if (!window.qizi?.uninstallStt) return;
  if (!window.confirm('确定卸载语音识别？将删除已下载的模型与依赖，主界面麦克风将不可用。')) return;
  if (sttRecording) stopSttRecording();
  setSttSettingsStatus('正在卸载…', 'pending');
  if (settingsSttUninstallBtn) settingsSttUninstallBtn.disabled = true;
  const result = await window.qizi.uninstallStt();
  if (result?.ok) {
    sttReady = false;
    setSttSettingsStatus('已卸载', 'ok');
    if (settingsSttProgressEl) settingsSttProgressEl.hidden = true;
    await refreshSttUi();
  } else {
    setSttSettingsStatus(result?.error || '卸载失败', 'error');
  }
  if (settingsSttUninstallBtn) settingsSttUninstallBtn.disabled = false;
}

function switchSettingsTab(tabId) {
  const next = tabId === 'stt' ? 'stt' : 'gateway';
  if (next !== 'stt' && sttRecording && sttRecordingMode === 'test') {
    stopSttRecording();
  }
  activeSettingsTab = next;

  const tabs = [
    { id: 'gateway', btn: settingsTabGatewayBtn, panel: settingsPanelGatewayEl },
    { id: 'stt', btn: settingsTabSttBtn, panel: settingsPanelSttEl },
  ];
  tabs.forEach(({ id, btn, panel }) => {
    const active = id === next;
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    }
  });

  if (next === 'gateway') {
    requestAnimationFrame(syncSettingsTestStatusLayout);
  }
  updateSttUninstallFooterVisibility(sttReady);
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
  await renderSttSettingsPanel();
}

async function openSettingsModal() {
  if (!settingsModal) return;
  hideAgentPopup();
  hideModelPopup();
  switchSettingsTab('gateway');
  await populateSettingsForm();
  settingsModal.hidden = false;
  requestAnimationFrame(syncSettingsTestStatusLayout);
}

function clearSttSettingsSession() {
  showSettingsSttTestPending(false);
  setSttRecordTestResult('');
  if (settingsSttResultEl) settingsSttResultEl.value = '';
  if (settingsSttTimerEl) settingsSttTimerEl.textContent = '00:00';
  setSttSettingsStatus('', '');
}

function closeSettingsModal() {
  if (!settingsModal) return;
  if (sttRecording && sttRecordingMode === 'test') stopSttRecording();
  clearSttSettingsSession();
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
if (settingsTabGatewayBtn) {
  settingsTabGatewayBtn.addEventListener('click', () => switchSettingsTab('gateway'));
}
if (settingsTabSttBtn) {
  settingsTabSttBtn.addEventListener('click', () => switchSettingsTab('stt'));
}
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
    e.stopPropagation();
  });
  const settingsPanel = settingsModal.querySelector('.settings-panel');
  if (settingsPanel) {
    settingsPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }
}
if (window.qizi?.onOpenSettings) {
  window.qizi.onOpenSettings(() => {
    openSettingsModal();
  });
}

if (window.qizi?.onSttProgress) {
  window.qizi.onSttProgress((payload) => {
    if (settingsSttProgressTextEl) {
      settingsSttProgressTextEl.textContent = payload?.message || '';
    }
    if (settingsSttProgressFillEl && typeof payload?.percent === 'number') {
      settingsSttProgressFillEl.style.width = `${Math.max(0, Math.min(100, payload.percent))}%`;
    }
    if (payload?.message) {
      setSttSettingsStatus(payload.message, 'pending');
    }
  });
}

if (settingsSttInstallBtn) {
  settingsSttInstallBtn.addEventListener('click', installSttFromSettings);
}
if (settingsSttUninstallBtn) {
  settingsSttUninstallBtn.addEventListener('click', uninstallSttFromSettings);
}
if (settingsSttRecordBtn) {
  settingsSttRecordBtn.addEventListener('click', () => {
    if (!sttRecording) startSttRecording('test');
  });
}
if (sttRecordingStopBtn) {
  sttRecordingStopBtn.addEventListener('click', () => stopSttRecording());
}
if (sttRecordingCancelBtn) {
  sttRecordingCancelBtn.addEventListener('click', () => cancelSttRecording());
}
if (micBtn) {
  micBtn.addEventListener('click', () => {
    if (!sttReady || busy) return;
    if (sttRecording && sttRecordingMode === 'composer') stopSttRecording();
    else if (!sttRecording) startSttRecording('composer');
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
