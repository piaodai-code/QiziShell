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

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
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
    return '<div class="msg-avatar msg-avatar-them" role="img" aria-label="Maintaining">M</div>';
  }

  function bubbleHtml(message) {
    const images = Array.isArray(message.images) ? message.images : [];
    const files = Array.isArray(message.files) ? message.files : [];
    let html = '';
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
    const text = String(message.text || '');
    if (message.streaming) {
      html += `<pre class="msg-stream-plain">${escapeHtml(text || '…')}</pre>`;
    } else if (text) {
      html += parseMarkdown(text);
    }
    return html;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop <= 40;
  }

  function render() {
    const follow = pinned || nearBottom();
    if (!messages.length) {
      messagesEl.innerHTML = '<div class="msg-hint">No messages yet</div>';
      return;
    }
    messagesEl.innerHTML = '';
    for (const message of messages) {
      const row = document.createElement('div');
      row.className = `msg ${message.who === 'me' ? 'me' : 'them'}`;
      row.innerHTML = `
        ${avatarHtml(message.who)}
        <div class="msg-content">
          <div class="msg-bubble"></div>
          <div class="msg-meta">${escapeHtml(message.time || '')}</div>
        </div>`;
      row.querySelector('.msg-bubble').innerHTML = bubbleHtml(message);
      messagesEl.appendChild(row);
    }
    window.QiziCodeBlocks?.decorate(messagesEl);
    if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function replaceHistory(list) {
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
    const canSend = connected && (inputEl.value.trim() || pendingImages.length > 0 || pendingFiles.length > 0);
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
    const text = inputEl.value;
    const images = pendingImages.splice(0, pendingImages.length);
    const files = pendingFiles.splice(0, pendingFiles.length);
    renderPending();
    if (!connected) {
      pendingImages.unshift(...images);
      pendingFiles.unshift(...files);
      renderPending();
      showLogin('Sign in to Hermes first');
      return;
    }
    if (!text.trim() && images.length === 0 && files.length === 0) return;
    messages.push({
      who: 'me',
      text,
      images: images.map((image) => image.dataUrl),
      files: files.map((file) => ({ name: file.name, size: file.size })),
      time: nowLabel(),
    });
    inputEl.value = '';
    busy = true;
    pinned = true;
    startWorking();
    render();
    syncSendButton();
    try {
      const result = await window.maintaining.send({ text, images, files });
      if (!result?.ok) throw new Error(result?.error || 'Send failed');
    } catch (err) {
      messages.pop();
      pendingImages.unshift(...images);
      pendingFiles.unshift(...files);
      renderPending();
      render();
      busy = false;
      stopWorking();
      syncSendButton();
      setStatus(err.message || 'Send failed', 'error');
    }
  }

  messagesEl.addEventListener('scroll', () => {
    pinned = nearBottom();
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
  });
  requestEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-choice]');
    if (!button) return;
    const choice = button.dataset.choice;
    const input = document.getElementById('hermes-request-input');
    answerRequest(choice === '__text__' ? '' : choice, input?.value || '');
  });
  messagesEl.addEventListener('click', (event) => {
    const image = event.target.closest('.msg-image');
    if (!image) return;
    imgModalImg.src = image.src;
    imgModal.hidden = false;
  });
  imgModal.addEventListener('click', () => {
    imgModal.hidden = true;
    imgModalImg.src = '';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !imgModal.hidden) {
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
