(() => {
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const statusEl = document.getElementById('status');
  const menuBtn = document.getElementById('menu-btn');
  const loginEl = document.getElementById('hermes-login');
  const loginForm = document.getElementById('hermes-login-form');
  const loginErrorEl = document.getElementById('hermes-login-error');
  const urlEl = document.getElementById('hermes-url');
  const usernameEl = document.getElementById('hermes-username');
  const passwordEl = document.getElementById('hermes-password');
  const loginSubmit = document.getElementById('hermes-login-submit');
  const loginTestBtn = document.getElementById('hermes-test-btn');
  const loginStatusEl = document.getElementById('hermes-login-status');
  const loginClose = document.getElementById('hermes-login-close');
  const attachPopup = document.getElementById('attach-popup');
  const attachBtn = document.getElementById('attach-picker-btn');
  const pendingEl = document.getElementById('composer-pending');
  const activityEl = document.getElementById('hermes-activity');
  const activityTimeEl = document.getElementById('hermes-activity-time');
  const activityDetailEl = document.getElementById('hermes-activity-detail');
  const requestEl = document.getElementById('hermes-request');
  const imgModal = document.getElementById('img-modal');
  const imgModalImg = document.getElementById('img-modal-img');
  const composerEl = document.getElementById('composer');
  const composerBodyEl = document.getElementById('composer-body');
  const contextMenuEl = document.getElementById('msg-context-menu');
  const quoteEl = document.getElementById('composer-quote');
  const quoteTextEl = document.getElementById('composer-quote-text');
  const quoteRemoveEl = document.getElementById('composer-quote-remove');
  const multiselectEl = document.getElementById('composer-multiselect');
  const multiselectHintEl = document.getElementById('multiselect-hint');
  const multiselectCancelBtn = document.getElementById('multiselect-cancel-btn');
  const multiselectExportBtn = document.getElementById('multiselect-export-btn');

  const messages = [];
  const pendingImages = [];
  const pendingFiles = [];
  const requests = [];
  let connected = false;
  let busy = false;
  let pinned = true;
  let activityTimer = null;
  let activityStarted = 0;
  let activityDetail = '';
  let pendingQuote = null;
  let multiSelectMode = false;
  let multiSelectedIndices = new Set();
  let contextMenuIndex = -1;
  let connectionLabel = { text: 'Connecting…', kind: 'pending' };
  let statusFlashTimer = null;
  const QUOTE_START = '【引用开始】';
  const QUOTE_END = '【引用结束】';
  const FORWARD_START = '【转发开始】';
  const FORWARD_END = '【转发结束】';

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatFileSize(bytes) {
    const n = Number(bytes);
    if (!n) return '';
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }

  function parseMarkdown(text) {
    const root = window.marked;
    const parser = root && (typeof root.parse === 'function' ? root.parse.bind(root) : (typeof root.marked === 'function' ? root.marked.bind(root) : null));
    const source = String(text || '');
    if (!parser) return escapeHtml(source);
    const html = parser(source, { breaks: true, gfm: true });
    if (window.DOMPurify?.sanitize) {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
        ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'colspan', 'rowspan'],
        ALLOW_DATA_ATTR: false,
      });
    }
    return escapeHtml(source);
  }

  function paintStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
  }

  function setStatus(text, kind) {
    connectionLabel = { text, kind: kind || '' };
    clearTimeout(statusFlashTimer);
    paintStatus(text, kind);
  }

  function showPending(text) {
    clearTimeout(statusFlashTimer);
    paintStatus(text, 'pending');
  }

  function showTransient(text, kind) {
    paintStatus(text, kind);
    clearTimeout(statusFlashTimer);
    statusFlashTimer = setTimeout(() => {
      paintStatus(connectionLabel.text, connectionLabel.kind);
    }, 1600);
  }

  function showLogin(error) {
    loginEl.hidden = false;
    if (error) {
      loginErrorEl.hidden = false;
      loginErrorEl.textContent = error;
    } else {
      loginErrorEl.hidden = true;
      loginErrorEl.textContent = '';
    }
  }

  function hideLogin() {
    loginEl.hidden = true;
  }

  function setLoginStatus(text, kind) {
    if (!text) {
      loginStatusEl.hidden = true;
      loginStatusEl.textContent = '';
      loginStatusEl.className = 'hermes-login-status';
      return;
    }
    loginStatusEl.hidden = false;
    loginStatusEl.textContent = text;
    loginStatusEl.title = text;
    loginStatusEl.className = `hermes-login-status ${kind || ''}`.trim();
  }

  function fillCredentials(credentials) {
    if (!credentials) return;
    if (credentials.url) urlEl.value = credentials.url;
    if (credentials.username) usernameEl.value = credentials.username;
    if (credentials.password) passwordEl.value = credentials.password;
  }

  function avatarHtml(who) {
    if (who === 'me') return '<div class="msg-avatar msg-avatar-me" role="img" aria-label="Me">我</div>';
    return '<div class="msg-avatar msg-avatar-them" role="img" aria-label="Maintaining"><img src="assets/maintaining-avatar.png" alt="Maintaining"></div>';
  }

  function authorLabel(message) {
    return message?.who === 'me' ? '我' : 'Maintaining';
  }

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

  function parseSenderMeta(body) {
    let label = '未知';
    let who = 'them';
    let time = '';
    const match = String(body || '').match(/Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        const meta = JSON.parse(match[1]);
        const replyTo = meta.replyTo && typeof meta.replyTo === 'object' ? meta.replyTo : null;
        if (typeof replyTo?.label === 'string' && replyTo.label.trim()) label = replyTo.label.trim();
        else if (typeof meta.label === 'string' && meta.label.trim()) label = meta.label.trim();
        if (replyTo?.role === 'user' || meta.role === 'user') who = 'me';
        else if (replyTo?.role === 'assistant' || meta.role === 'assistant') who = 'them';
        if (typeof replyTo?.time === 'string' && replyTo.time.trim()) time = replyTo.time.trim();
        else if (typeof meta.time === 'string' && meta.time.trim()) time = meta.time.trim();
      } catch {
        // ignore malformed metadata
      }
    }
    return { authorLabel: label, who, time };
  }

  function parseStoredQuote(text) {
    const body = String(text || '');
    const block = extractMarkedBlock(body, QUOTE_START, QUOTE_END);
    if (!block) return null;
    const meta = parseSenderMeta(body);
    let reply = '';
    const after = block.endIdx + block.endMarkerLength;
    const marker = body.indexOf('【回复】', after);
    if (marker >= 0) reply = body.slice(marker + '【回复】'.length).trim();
    return {
      reply,
      quote: { who: meta.who, authorLabel: meta.authorLabel, text: block.content, time: meta.time },
    };
  }

  function parseStoredForward(text) {
    const body = String(text || '');
    const block = extractMarkedBlock(body, FORWARD_START, FORWARD_END);
    if (!block) return null;
    const meta = parseSenderMeta(body);
    let comment = '';
    const after = block.endIdx + block.endMarkerLength;
    const marker = body.indexOf('【留言】', after);
    if (marker >= 0) comment = body.slice(marker + '【留言】'.length).trim();
    return {
      comment,
      forward: { who: meta.who, authorLabel: meta.authorLabel, text: block.content, time: meta.time },
    };
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function messageView(message) {
    if (!message) return { quote: null, forward: null, body: '' };
    if (message.who === 'me') {
      const forwarded = parseStoredForward(message.text);
      if (forwarded?.forward) {
        return {
          quote: null,
          forward: { ...forwarded.forward, text: cleanText(forwarded.forward.text) },
          body: cleanText(forwarded.comment),
        };
      }
      const quoted = parseStoredQuote(message.text);
      if (quoted?.quote) {
        return {
          quote: { ...quoted.quote, text: cleanText(quoted.quote.text) },
          forward: null,
          body: cleanText(quoted.reply),
        };
      }
    }
    return { quote: null, forward: null, body: cleanText(message.text) };
  }

  function selectableText(message) {
    if (!message || message.streaming) return '';
    const view = messageView(message);
    const parts = [];
    if (view.forward?.text) parts.push(`[转发 ${view.forward.authorLabel || '未知'}]\n${view.forward.text}`);
    else if (view.quote?.text) parts.push(`[引用 ${view.quote.authorLabel || '未知'}]\n${view.quote.text}`);
    if (view.body) parts.push(view.body);
    let body = parts.join('\n\n').trim();
    if (!body && Array.isArray(message.images) && message.images.length) body = '（图片）';
    if (!body && Array.isArray(message.files) && message.files.length) {
      body = message.files.map((file) => file.name).filter(Boolean).join('、') || '（附件）';
    }
    return body;
  }

  function isSelectable(message) {
    return Boolean(selectableText(message));
  }

  function quoteNeedsToggle(text) {
    const body = String(text || '');
    const lines = body.split(/\r?\n/);
    if (lines.length > 3) return true;
    return body.length > 120 || lines.some((line) => line.length > 42);
  }

  function renderQuoteCard(quote, index) {
    if (!quote?.text) return '';
    const author = escapeHtml(quote.authorLabel || '未知');
    const fullText = escapeHtml(quote.text);
    const needsToggle = quoteNeedsToggle(quote.text);
    const toggle = needsToggle
      ? `<button type="button" class="msg-quote-toggle" data-quote-key="${index}" aria-expanded="false" aria-label="展开引用">▼</button>`
      : '';
    const collapsed = needsToggle ? ' is-collapsed' : '';
    return `<div class="msg-quote-card${collapsed}" data-quote-key="${index}"><div class="msg-quote-author">${author}</div><div class="msg-quote-body"><div class="msg-quote-text">${fullText}</div>${toggle}</div></div>`;
  }

  function bubbleHtml(message, index) {
    const view = message.streaming ? { quote: null, forward: null, body: String(message.text || '') } : messageView(message);
    const images = Array.isArray(message.images) ? message.images : [];
    const files = Array.isArray(message.files) ? message.files : [];
    let html = '';
    if (view.forward) html += renderQuoteCard(view.forward, index);
    else if (view.quote) html += renderQuoteCard(view.quote, index);
    if (images.length) {
      html += `<div class="msg-images">${images.map((url) => `<img class="msg-image" src="${url}" alt="">`).join('')}</div>`;
    }
    if (files.length) {
      html += `<div class="msg-files">${files.map((file) => {
        const size = formatFileSize(file.size);
        const sizeHtml = size ? `<span class="msg-file-size">${escapeHtml(size)}</span>` : '';
        return `<div class="msg-file"><span class="msg-file-name">📄 ${escapeHtml(file.name || 'file')}</span>${sizeHtml}</div>`;
      }).join('')}</div>`;
    }
    const text = view.body;
    if (message.streaming) {
      html += `<pre class="msg-stream-plain">${escapeHtml(text || '…')}</pre>`;
    } else if (text) {
      html += parseMarkdown(text);
    }
    return html;
  }

  function selectCheckHtml(index) {
    if (!multiSelectMode) return '';
    const message = messages[index];
    if (!isSelectable(message)) {
      return '<button type="button" class="msg-select-check" hidden aria-hidden="true" tabindex="-1"></button>';
    }
    const selected = multiSelectedIndices.has(index);
    return `<button type="button" class="msg-select-check${selected ? ' selected' : ''}" data-msg-index="${index}" aria-label="${selected ? '取消选择' : '选择消息'}" aria-pressed="${selected ? 'true' : 'false'}">✓</button>`;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop <= 40;
  }

  function render(options = {}) {
    const prevScroll = messagesEl.scrollTop;
    const follow = !options.preserveScroll && (pinned || nearBottom());
    messagesEl.classList.toggle('is-multiselect', multiSelectMode && messages.length > 0);
    if (!messages.length) {
      messagesEl.innerHTML = '<div class="msg-hint">No messages yet</div>';
      return;
    }
    messagesEl.innerHTML = '';
    messages.forEach((message, index) => {
      const row = document.createElement('div');
      row.className = `msg ${message.who === 'me' ? 'me' : 'them'}`;
      row.innerHTML = `
        ${avatarHtml(message.who)}
        <div class="msg-content">
          <div class="msg-bubble"></div>
          <div class="msg-meta">${escapeHtml(message.time || '')}</div>
        </div>
        ${selectCheckHtml(index)}`;
      row.querySelector('.msg-bubble').innerHTML = bubbleHtml(message, index);
      messagesEl.appendChild(row);
    });
    window.QiziCodeBlocks?.decorate(messagesEl);
    if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
    else if (options.preserveScroll) messagesEl.scrollTop = prevScroll;
  }

  function replaceHistory(list) {
    if (multiSelectMode) {
      multiSelectMode = false;
      multiSelectedIndices = new Set();
      messagesEl.classList.remove('is-multiselect');
      composerBodyEl.hidden = false;
      multiselectEl.hidden = true;
      hideContextMenu();
      syncSendButton();
    }
    messages.splice(0, messages.length, ...(Array.isArray(list) ? list : []));
    render();
  }

  function streamingMessage() {
    const last = messages[messages.length - 1];
    if (last?.who === 'them' && last.streaming) return last;
    const created = { who: 'them', text: '', images: [], time: nowLabel(), streaming: true };
    messages.push(created);
    return created;
  }

  function syncSendButton() {
    const canSend = connected && (
      inputEl.value.trim()
      || pendingQuote
      || selectionCount() > 0
      || pendingImages.length > 0
      || pendingFiles.length > 0
    );
    sendBtn.disabled = busy ? false : !canSend;
    sendBtn.classList.toggle('is-stop', busy);
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', sendBtn.title);
  }

  function renderPending() {
    const thumbs = pendingImages.map((image, index) => `
      <div class="pending-thumb">
        <img src="${image.dataUrl}" alt="">
        <button type="button" class="pending-thumb-remove" data-remove="image" data-index="${index}" aria-label="Remove">×</button>
      </div>
    `).join('');
    const chips = pendingFiles.map((file, index) => `
      <div class="pending-file">
        <span class="pending-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="pending-file-size">${escapeHtml(formatFileSize(file.size))}</span>
        <button type="button" class="pending-file-remove" data-remove="file" data-index="${index}" aria-label="Remove">×</button>
      </div>
    `).join('');
    pendingEl.hidden = pendingImages.length === 0 && pendingFiles.length === 0;
    pendingEl.innerHTML = thumbs + chips;
  }

  function addImages(images) {
    for (const image of images || []) {
      if (!image?.dataUrl) continue;
      pendingImages.push({ dataUrl: image.dataUrl, name: image.name || 'image.png' });
    }
    renderPending();
    syncSendButton();
  }

  function addFiles(files) {
    for (const file of files || []) {
      if (!file?.dataUrl) continue;
      pendingFiles.push({
        dataUrl: file.dataUrl,
        name: file.name || 'file',
        size: Number(file.size) || 0,
        mimeType: file.mimeType || '',
      });
    }
    renderPending();
    syncSendButton();
  }

  const IMAGE_DROP_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
  const IMAGE_DROP_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
  const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;

  function isImageDropFile(file) {
    const mime = (file?.type || '').toLowerCase();
    const name = file?.name || '';
    return Boolean((mime && IMAGE_DROP_MIMES.includes(mime)) || IMAGE_DROP_EXTENSIONS.test(name));
  }

  function filesFromDataTransfer(dataTransfer) {
    const items = Array.from(dataTransfer?.items || []);
    const files = [];
    let directories = 0;
    if (items.some((item) => item.kind === 'file')) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          directories += 1;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      return { files, directories };
    }
    return { files: Array.from(dataTransfer?.files || []), directories };
  }

  function readDroppedFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function addDroppedFile(file) {
    if (!file) return 'skip';
    if (isImageDropFile(file)) {
      try {
        const dataUrl = await readDroppedFile(file);
        addImages([{ dataUrl, name: file.name || 'image.png' }]);
        return 'image';
      } catch (err) {
        console.error('[maintaining] could not read dropped image', err);
        return 'skip';
      }
    }
    if (file.size > MAX_DROPPED_FILE_BYTES) return 'large';
    try {
      const dataUrl = await readDroppedFile(file);
      addFiles([{
        dataUrl,
        name: file.name || 'file',
        size: file.size || 0,
        mimeType: file.type || 'application/octet-stream',
      }]);
      return 'file';
    } catch (err) {
      console.error('[maintaining] could not read dropped file', err);
      return 'skip';
    }
  }

  function choiceLabel(choice) {
    if (choice === 'once') return 'Allow once';
    if (choice === 'session') return 'Allow for this session';
    if (choice === 'always') return 'Always allow';
    if (choice === 'deny') return 'Deny';
    return String(choice);
  }

  function renderRequest() {
    const current = requests[0];
    if (!current) {
      requestEl.hidden = true;
      requestEl.innerHTML = '';
      return;
    }
    const params = current.params || {};
    const title = current.method === 'approval' ? 'Approval' : (current.method === 'clarify' ? 'Question' : current.method);
    const body = params.command || params.description || params.question || params.prompt || '';
    const choices = Array.isArray(params.choices) ? params.choices : (current.method === 'approval' ? ['once', 'deny'] : []);
    const needsText = current.method !== 'approval' && choices.length === 0;
    requestEl.hidden = false;
    requestEl.innerHTML = `
      <div class="hermes-request-title">${escapeHtml(title)}</div>
      <div class="hermes-request-body">${escapeHtml(body)}</div>
      ${needsText ? '<input class="hermes-request-input" id="hermes-request-input" type="text">' : ''}
      <div class="hermes-request-actions">
        ${choices.map((choice) => `<button type="button" data-choice="${escapeHtml(choice)}" class="${choice === 'deny' ? 'danger' : ''}">${escapeHtml(choiceLabel(choice))}</button>`).join('')}
        ${needsText ? '<button type="button" data-choice="__text__">Send</button>' : ''}
      </div>`;
  }

  function answerRequest(choice, text) {
    const current = requests.shift();
    renderRequest();
    if (!current) return;
    let result;
    if (current.method === 'approval') result = { choice };
    else if (current.method === 'clarify') {
      const qid = current.params?.qid || current.params?.request_id || current.params?.id || 'answer';
      result = { answers: { [qid]: text || choice } };
    } else result = { value: text || choice };
    window.maintaining.respond({ id: current.id, result }).catch((err) => {
      setStatus(err.message || 'Could not answer', 'error');
    });
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function paintWorking() {
    activityEl.hidden = false;
    activityTimeEl.textContent = formatElapsed(Date.now() - activityStarted);
    activityDetailEl.hidden = !activityDetail;
    activityDetailEl.textContent = activityDetail;
  }

  function startWorking() {
    activityStarted = Date.now();
    activityDetail = 'Waiting for Hermes';
    if (activityTimer) clearInterval(activityTimer);
    paintWorking();
    activityTimer = setInterval(paintWorking, 1000);
  }

  function noteWorking(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line || !busy) return;
    activityDetail = line;
    if (!activityTimer) {
      activityStarted = Date.now();
      activityTimer = setInterval(paintWorking, 1000);
    }
    paintWorking();
  }

  function stopWorking() {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
    activityDetail = '';
    activityEl.hidden = true;
  }

  function hideAttach() {
    attachPopup.hidden = true;
    attachBtn.setAttribute('aria-expanded', 'false');
  }

  function showAttach() {
    if (!attachPopup.hidden) {
      hideAttach();
      return;
    }
    attachPopup.hidden = false;
    attachBtn.setAttribute('aria-expanded', 'true');
    const rect = attachBtn.getBoundingClientRect();
    const width = Math.max(attachPopup.offsetWidth || 148, 148);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    attachPopup.style.left = `${Math.round(left)}px`;
    attachPopup.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 8))}px`;
  }

  async function sendMessage() {
    if (busy) {
      busy = false;
      stopWorking();
      syncSendButton();
      try { await window.maintaining.abort(); } catch (err) {
        setStatus(err.message || 'Could not stop', 'error');
      }
      return;
    }
    const typed = inputEl.value;
    const quote = pendingQuote;
    const selection = multiSelectMode && selectionCount() > 0 ? mergedForward(multiSelectedIndices) : null;
    const images = pendingImages.splice(0, pendingImages.length);
    const files = pendingFiles.splice(0, pendingFiles.length);
    renderPending();
    const outbound = selection?.text
      ? formatQuote(selection, typed)
      : (quote ? formatQuote(quote, typed) : typed);
    if (!connected) {
      pendingImages.unshift(...images);
      pendingFiles.unshift(...files);
      renderPending();
      showLogin('Sign in to Hermes first');
      return;
    }
    if (!outbound.trim() && images.length === 0 && files.length === 0) return;
    messages.push({
      who: 'me',
      text: outbound,
      images: images.map((image) => image.dataUrl),
      files: files.map((file) => ({ name: file.name, size: file.size })),
      time: nowLabel(),
    });
    inputEl.value = '';
    pendingQuote = null;
    renderComposerQuote();
    busy = true;
    pinned = true;
    startWorking();
    render();
    syncSendButton();
    try {
      const result = await window.maintaining.send({ text: outbound, images, files });
      if (!result?.ok) throw new Error(result?.error || 'Send failed');
      if (selection) exitMultiSelect();
    } catch (err) {
      messages.pop();
      inputEl.value = typed;
      pendingQuote = quote;
      pendingImages.unshift(...images);
      pendingFiles.unshift(...files);
      renderPending();
      renderComposerQuote();
      render();
      busy = false;
      stopWorking();
      syncSendButton();
      setStatus(err.message || 'Send failed', 'error');
    }
  }

  function quotePreview(text) {
    const line = String(text || '').split(/\r?\n/).find((entry) => entry.trim()) || '';
    const trimmed = line.trim();
    if (trimmed.length <= 96) return trimmed;
    return `${trimmed.slice(0, 96)}…`;
  }

  function renderComposerQuote() {
    if (!pendingQuote?.text) {
      quoteEl.hidden = true;
      quoteTextEl.textContent = '';
    } else {
      quoteTextEl.textContent = `${pendingQuote.authorLabel}：${quotePreview(pendingQuote.text)}`;
      quoteEl.hidden = false;
    }
    syncSendButton();
  }

  function formatWrapped(kind, start, end, replyLabel, ref, userText) {
    const replyTo = {
      label: ref?.authorLabel || '未知',
      role: ref?.who === 'me' ? 'user' : 'assistant',
      time: ref?.time || '',
    };
    const meta = { label: replyTo.label, role: replyTo.role, kind, replyTo };
    const parts = [
      'Sender (untrusted metadata):',
      '```json',
      JSON.stringify(meta),
      '```',
      '',
      start,
      String(ref?.text || '').trim(),
      end,
    ];
    const tail = String(userText || '').trim();
    if (tail) parts.push('', replyLabel, tail);
    return parts.join('\n');
  }

  function formatQuote(quote, userText) {
    return formatWrapped('quoted-message', QUOTE_START, QUOTE_END, '【回复】', quote, userText);
  }

  function quoteMessage(message) {
    const text = selectableText(message);
    if (!text) {
      showTransient('该消息没有可引用的文字', 'error');
      return;
    }
    pendingQuote = {
      who: message.who,
      authorLabel: authorLabel(message),
      text,
      time: message.time || '',
    };
    if (multiSelectMode) exitMultiSelect();
    renderComposerQuote();
    inputEl.focus();
  }

  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function copyPayload(message) {
    if (!message || message.streaming) return '';
    const parts = [];
    const text = selectableText(message);
    if (text) parts.push(text);
    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length) parts.push(images.length === 1 ? '[图片]' : `[图片 x${images.length}]`);
    const files = Array.isArray(message.files) ? message.files : [];
    if (files.length) parts.push(`[附件] ${files.map((file) => file.name || '未命名文件').join('、')}`);
    return parts.join('\n\n').trim();
  }

  async function copyMessage(index) {
    const text = copyPayload(messages[index]);
    hideContextMenu();
    if (!text) {
      showTransient('该消息没有可复制的内容', 'error');
      return;
    }
    const ok = await copyText(text);
    showTransient(ok ? '已复制' : '复制失败', ok ? 'ok' : 'error');
  }

  function exportEntry(message) {
    const view = messageView(message);
    const entry = {
      author: authorLabel(message),
      time: message.time || '',
      text: String(view.body || '').replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n').trim(),
    };
    if (view.forward?.text) {
      entry.forward = { authorLabel: view.forward.authorLabel || '未知', text: view.forward.text };
    } else if (view.quote?.text) {
      entry.quote = { authorLabel: view.quote.authorLabel || '未知', text: view.quote.text };
    }
    if (!entry.text && !entry.quote && !entry.forward) {
      const fallback = selectableText(message);
      if (fallback) entry.text = fallback;
    }
    return entry;
  }

  async function exportEntries(entries, { exitOnSuccess = false } = {}) {
    const list = (entries || []).filter((entry) => entry.text || entry.quote?.text || entry.forward?.text);
    if (!list.length) {
      showTransient('没有可保存的文字', 'error');
      return;
    }
    if (!window.maintaining?.exportMessagesWord) {
      showTransient('保存功能不可用', 'error');
      return;
    }
    showPending('正在保存…');
    try {
      const result = await window.maintaining.exportMessagesWord(list);
      if (result?.cancelled) {
        paintStatus(connectionLabel.text, connectionLabel.kind);
        return;
      }
      if (!result?.ok) {
        showTransient(result?.error || '保存失败', 'error');
        return;
      }
      showTransient('已保存', 'ok');
      if (exitOnSuccess) exitMultiSelect();
    } catch (err) {
      showTransient(err.message || '保存失败', 'error');
    }
  }

  async function exportMessage(index) {
    const message = messages[index];
    hideContextMenu();
    if (!isSelectable(message)) {
      showTransient('该消息没有可保存的文字', 'error');
      return;
    }
    await exportEntries([exportEntry(message)]);
  }

  function selectionCount() {
    let count = 0;
    for (const index of multiSelectedIndices) {
      if (index >= 0 && index < messages.length && isSelectable(messages[index])) count += 1;
    }
    return count;
  }

  function updateMultiSelectBar() {
    multiSelectedIndices = new Set([...multiSelectedIndices].filter((index) => (
      index >= 0 && index < messages.length && isSelectable(messages[index])
    )));
    const count = multiSelectedIndices.size;
    if (count > 0) {
      const preview = quotePreview(mergedForward(multiSelectedIndices).text);
      multiselectHintEl.textContent = preview ? `已选 ${count} 条：${preview}` : `已选 ${count} 条`;
    } else {
      multiselectHintEl.textContent = '请选择消息';
    }
    multiselectExportBtn.disabled = count === 0;
    multiselectExportBtn.setAttribute('aria-disabled', count > 0 ? 'false' : 'true');
    syncSendButton();
  }

  function hideContextMenu() {
    contextMenuEl.hidden = true;
    contextMenuIndex = -1;
  }

  function showContextMenu(x, y, index) {
    contextMenuIndex = index;
    contextMenuEl.hidden = false;
    const rect = contextMenuEl.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    contextMenuEl.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    contextMenuEl.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
  }

  function setMultiSelectMode(enabled) {
    multiSelectMode = enabled;
    if (!enabled) multiSelectedIndices = new Set();
    if (enabled) {
      pendingQuote = null;
      quoteEl.hidden = true;
      quoteTextEl.textContent = '';
    }
    messagesEl.classList.toggle('is-multiselect', enabled);
    composerBodyEl.hidden = false;
    multiselectEl.hidden = !enabled;
    hideContextMenu();
    updateMultiSelectBar();
    render({ preserveScroll: true });
    if (enabled) inputEl.focus();
  }

  function enterMultiSelect(index) {
    multiSelectedIndices = new Set();
    if (index >= 0 && isSelectable(messages[index])) multiSelectedIndices.add(index);
    setMultiSelectMode(true);
  }

  function exitMultiSelect() {
    setMultiSelectMode(false);
  }

  function toggleSelect(index) {
    if (!multiSelectMode) return;
    if (index < 0 || index >= messages.length || !isSelectable(messages[index])) return;
    if (multiSelectedIndices.has(index)) multiSelectedIndices.delete(index);
    else multiSelectedIndices.add(index);
    updateMultiSelectBar();
    const row = messagesEl.querySelectorAll('.msg')[index];
    const check = row?.querySelector('.msg-select-check');
    if (!check) {
      render({ preserveScroll: true });
      return;
    }
    const selected = multiSelectedIndices.has(index);
    check.classList.toggle('selected', selected);
    check.setAttribute('aria-label', selected ? '取消选择' : '选择消息');
    check.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }

  function toggleQuoteCard(card, button) {
    const expanding = card.classList.contains('is-collapsed');
    if (expanding) {
      card.classList.remove('is-collapsed');
      button.textContent = '▲';
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', '收起引用');
    } else {
      card.classList.add('is-collapsed');
      button.textContent = '▼';
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', '展开引用');
    }
  }

  function mergedForward(indices) {
    const blocks = [];
    let earliest = '';
    for (const index of [...indices].sort((a, b) => a - b)) {
      const message = messages[index];
      if (!isSelectable(message)) continue;
      const stamp = message.time ? ` · ${message.time}` : '';
      blocks.push(`【${authorLabel(message)}${stamp}】\n${selectableText(message)}`);
      if (!earliest && message.time) earliest = message.time;
    }
    return {
      who: 'them',
      authorLabel: `已选 ${blocks.length} 条消息`,
      text: blocks.join('\n\n'),
      time: earliest,
    };
  }

  function bindComposerResize() {
    const handle = document.getElementById('composer-resize');
    if (!handle || !composerEl) return;
    let startY = 0;
    let startH = 0;
    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startY = event.clientY;
      startH = composerEl.offsetHeight;
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onUp);
    });
    function applyHeight(clientY) {
      const next = Math.max(120, Math.min(startH + (startY - clientY), window.innerHeight * 0.6));
      composerEl.classList.add('composer--resized');
      composerEl.style.height = `${next}px`;
      inputEl.style.height = '';
      inputEl.style.maxHeight = '';
    }
    function onDrag(event) {
      applyHeight(event.clientY);
    }
    function onUp(event) {
      if (typeof event.clientY === 'number') applyHeight(event.clientY);
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onUp);
    }
  }

  bindComposerResize();

  messagesEl.addEventListener('scroll', () => {
    pinned = nearBottom();
    hideContextMenu();
  });

  inputEl.addEventListener('input', syncSendButton);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  });
  sendBtn.addEventListener('click', () => { void sendMessage(); });
  menuBtn.addEventListener('click', () => showLogin(''));
  loginClose.addEventListener('click', () => hideLogin());
  loginEl.addEventListener('click', (event) => {
    if (event.target === loginEl) hideLogin();
  });
  loginTestBtn.addEventListener('click', async () => {
    loginErrorEl.hidden = true;
    setLoginStatus('Testing…', 'pending');
    loginTestBtn.disabled = true;
    loginSubmit.disabled = true;
    try {
      const result = await window.maintaining.testConnection({
        url: urlEl.value,
        username: usernameEl.value,
        password: passwordEl.value,
      });
      if (result?.ok) setLoginStatus('Connected', 'ok');
      else setLoginStatus(result?.error || 'Could not connect', 'error');
    } catch (err) {
      setLoginStatus(err.message || 'Could not connect', 'error');
    } finally {
      loginTestBtn.disabled = false;
      loginSubmit.disabled = false;
    }
  });
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginSubmit.disabled = true;
    setStatus('Connecting…', 'pending');
    try {
      const result = await window.maintaining.login({
        url: urlEl.value,
        username: usernameEl.value,
        password: passwordEl.value,
      });
      if (!result?.ok) {
        showLogin(result?.error || 'Could not connect');
        setStatus(result?.error || 'Could not connect', 'error');
        return;
      }
      connected = Boolean(result.connected);
      if (Array.isArray(result.messages)) replaceHistory(result.messages);
      if (connected) {
        hideLogin();
        setStatus('Connected', 'ok');
      } else {
        showLogin(result.error || 'Could not connect');
        setStatus(result.error || 'Sign in', 'error');
      }
    } catch (err) {
      showLogin(err.message || 'Could not connect');
      setStatus(err.message || 'Could not connect', 'error');
    } finally {
      loginSubmit.disabled = false;
      syncSendButton();
    }
  });

  attachBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showAttach();
  });
  document.getElementById('screenshot-btn').addEventListener('click', async () => {
    hideAttach();
    const result = await window.maintaining.captureScreenshot();
    if (result?.ok && result.dataUrl) addImages([result]);
    else if (result && !result.canceled && result.error) setStatus(result.error, 'error');
  });
  document.getElementById('pick-image-btn').addEventListener('click', async () => {
    hideAttach();
    const result = await window.maintaining.pickImages();
    if (result?.ok) addImages(result.images);
    else if (result && !result.canceled && result.error) setStatus(result.error, 'error');
  });
  document.getElementById('pick-file-btn').addEventListener('click', async () => {
    hideAttach();
    const result = await window.maintaining.pickFiles();
    if (result?.ok) addFiles(result.files);
    else if (result && !result.canceled && result.error) setStatus(result.error, 'error');
  });
  pendingEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (button.dataset.remove === 'file') pendingFiles.splice(index, 1);
    else pendingImages.splice(index, 1);
    renderPending();
    syncSendButton();
  });
  document.addEventListener('click', (event) => {
    if (!attachPopup.hidden && !event.target.closest('.attach-picker-wrap')) hideAttach();
    if (!contextMenuEl.hidden && !event.target.closest('#msg-context-menu')) hideContextMenu();
  });

  let dragCounter = 0;
  function isFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  document.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounter += 1;
    document.body.classList.add('drag-over');
  });
  document.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounter -= 1;
    if (dragCounter <= 0) {
      dragCounter = 0;
      document.body.classList.remove('drag-over');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounter = 0;
    document.body.classList.remove('drag-over');
    const { files, directories } = filesFromDataTransfer(event.dataTransfer);
    let images = 0;
    let attached = 0;
    let skipped = directories;
    let oversized = 0;
    for (const file of files) {
      const result = await addDroppedFile(file);
      if (result === 'image') images += 1;
      else if (result === 'file') attached += 1;
      else if (result === 'large') oversized += 1;
      else skipped += 1;
    }
    const added = images + attached;
    if (added > 0) inputEl.focus();
    const parts = [];
    if (images) parts.push(images === 1 ? '1 image' : `${images} images`);
    if (attached) parts.push(attached === 1 ? '1 file' : `${attached} files`);
    if (added > 0 && oversized > 0) {
      setStatus(`Added ${parts.join(' and ')}. A file over 20 MB was left out.`, 'error');
    } else if (added > 0) {
      setStatus(`Added ${parts.join(' and ')}`, 'ok');
    } else if (oversized > 0) {
      setStatus('That file is larger than 20 MB', 'error');
    } else if (skipped > 0) {
      setStatus('That can’t be attached', 'error');
    }
  });
  requestEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-choice]');
    if (!button) return;
    const choice = button.dataset.choice;
    const input = document.getElementById('hermes-request-input');
    answerRequest(choice === '__text__' ? '' : choice, input?.value || '');
  });
  messagesEl.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.msg');
    if (!row || !messagesEl.contains(row)) return;
    event.preventDefault();
    const index = [...messagesEl.querySelectorAll('.msg')].indexOf(row);
    if (index < 0 || index >= messages.length) return;
    if (messages[index].streaming) {
      showTransient('生成中，暂不可操作', 'error');
      return;
    }
    showContextMenu(event.clientX, event.clientY, index);
  });
  messagesEl.addEventListener('click', (event) => {
    const selectBtn = event.target.closest('.msg-select-check');
    if (selectBtn && multiSelectMode) {
      event.preventDefault();
      const index = Number(selectBtn.dataset.msgIndex);
      if (Number.isFinite(index)) toggleSelect(index);
      return;
    }
    const toggleBtn = event.target.closest('.msg-quote-toggle');
    if (toggleBtn) {
      event.preventDefault();
      toggleQuoteCard(toggleBtn.closest('.msg-quote-card'), toggleBtn);
      return;
    }
    if (multiSelectMode) {
      const row = event.target.closest('.msg');
      if (row && !event.target.closest('.msg-quote-toggle, a, .msg-code-btn, .msg-bubble img')) {
        const index = [...messagesEl.querySelectorAll('.msg')].indexOf(row);
        if (index >= 0) {
          event.preventDefault();
          toggleSelect(index);
          return;
        }
      }
    }
    const image = event.target.closest('.msg-image');
    if (!image) return;
    imgModalImg.src = image.src;
    imgModal.hidden = false;
  });
  contextMenuEl.addEventListener('click', (event) => {
    const item = event.target.closest('[data-action]');
    if (!item) return;
    const index = contextMenuIndex;
    const message = messages[index];
    const action = item.dataset.action;
    if (action === 'copy') {
      void copyMessage(index);
      return;
    }
    if (action === 'quote') {
      hideContextMenu();
      if (message) quoteMessage(message);
      return;
    }
    if (action === 'multiselect') {
      enterMultiSelect(index);
      return;
    }
    if (action === 'export') void exportMessage(index);
  });
  quoteRemoveEl.addEventListener('click', () => {
    pendingQuote = null;
    renderComposerQuote();
    inputEl.focus();
  });
  multiselectCancelBtn.addEventListener('click', exitMultiSelect);
  multiselectExportBtn.addEventListener('click', () => {
    if (!selectionCount() || multiselectExportBtn.disabled) return;
    const entries = [...multiSelectedIndices].sort((a, b) => a - b).map((index) => exportEntry(messages[index]));
    void exportEntries(entries, { exitOnSuccess: true });
  });
  imgModal.addEventListener('click', () => {
    imgModal.hidden = true;
    imgModalImg.src = '';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (multiSelectMode) {
      exitMultiSelect();
      return;
    }
    if (!contextMenuEl.hidden) {
      hideContextMenu();
      return;
    }
    if (!imgModal.hidden) {
      imgModal.hidden = true;
      imgModalImg.src = '';
    }
  });

  window.maintaining.onStatus((payload) => {
    if (payload?.text) setStatus(payload.text, payload.kind);
    if (payload?.needLogin) showLogin(payload.text || '');
    if (payload?.kind === 'ok') {
      connected = true;
      hideLogin();
    }
    if (payload?.kind === 'error') connected = false;
    syncSendButton();
  });
  window.maintaining.onHistory((list) => {
    replaceHistory(list);
    connected = true;
    busy = false;
    stopWorking();
    syncSendButton();
  });
  window.maintaining.onStream((payload) => {
    const current = streamingMessage();
    current.text = payload?.text || '';
    busy = true;
    if (activityDetail === 'Waiting for Hermes') noteWorking('Writing…');
    render();
    syncSendButton();
  });
  window.maintaining.onComplete((payload) => {
    const text = String(payload?.text || '');
    const last = messages[messages.length - 1];
    if (last?.who === 'them' && last.streaming) {
      last.streaming = false;
      if (text) last.text = text;
    } else if (text) {
      messages.push({ who: 'them', text, images: [], time: nowLabel() });
    }
    busy = false;
    stopWorking();
    render();
    syncSendButton();
  });
  window.maintaining.onTurnError((payload) => {
    const last = messages[messages.length - 1];
    if (last?.streaming) last.streaming = false;
    busy = false;
    stopWorking();
    setStatus(payload?.message || 'Hermes error', 'error');
    render();
    syncSendButton();
  });
  window.maintaining.onRequest((payload) => {
    requests.push(payload);
    renderRequest();
  });
  window.maintaining.onActivity((payload) => {
    noteWorking(payload?.text);
  });

  window.maintaining.boot().then((result) => {
    fillCredentials(result?.credentials);
    if (Array.isArray(result?.messages) && result.messages.length) replaceHistory(result.messages);
    connected = Boolean(result?.connected);
    if (result?.needLogin) {
      setStatus(result.error || 'Sign in', result.error ? 'error' : 'pending');
      showLogin(result.error || '');
    } else if (connected) {
      setStatus('Connected', 'ok');
    } else {
      setStatus('Connecting…', 'pending');
    }
    syncSendButton();
  }).catch((err) => {
    setStatus(err.message || 'Could not connect', 'error');
    showLogin(err.message || 'Could not connect');
  });
})();
