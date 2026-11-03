const messagesEl = document.getElementById('messages');
const historySearchInput = document.getElementById('history-search-input');
const historySearchCount = document.getElementById('history-search-count');
const historySearchPrev = document.getElementById('history-search-prev');
const historySearchNext = document.getElementById('history-search-next');
const historySearchClear = document.getElementById('history-search-clear');
const historyContextMenuEl = document.getElementById('msg-context-menu');
const historyStatusEl = document.getElementById('history-status');
const historyMultiselectEl = document.getElementById('history-multiselect');
const historyMultiselectHintEl = document.getElementById('history-multiselect-hint');
const historyMultiselectCancelBtn = document.getElementById('history-multiselect-cancel');
const historyMultiselectExportBtn = document.getElementById('history-multiselect-export');
const historyMultiselectSendBtn = document.getElementById('history-multiselect-send');

const currentSearchMarks = [];
let currentSearchIndex = -1;
let renderGeneration = 0;
let displayedMessages = [];
let historyContext = null;
let historyMenuIndex = -1;
let historyMultiSelectMode = false;
let historySelectedIndices = new Set();
let historyStatusTimer = 0;
let historyExportInFlight = false;
let historyHandoffInFlight = false;

function isStreamingPlaceholderText(text) {
  const trimmed = String(text || '').trim();
  return !trimmed || trimmed === '…';
}

function prepareMessagesForDisplay(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => ({ ...m, streaming: false }))
    .filter((m) => {
      if (m.who === 'them' && isStreamingPlaceholderText(m.text)) return false;
      if (m.who === 'me' && !String(m.text || '').trim()
        && !(Array.isArray(m.images) && m.images.length)
        && !(Array.isArray(m.files) && m.files.length)) {
        return false;
      }
      return true;
    });
}

async function loadSavedMessages(sessionKey) {
  if (!sessionKey) return [];
  if (window.qiziHistory?.loadLocalMessages) {
    try {
      const result = await window.qiziHistory.loadLocalMessages({ sessionKey });
      if (result?.ok && Array.isArray(result.messages)) {
        return result.messages;
      }
    } catch {
      // fall through
    }
  }
  return [];
}

function historyAgent() {
  return historyContext?.agent || {
    id: historyContext?.agentId,
    label: historyContext?.agentLabel,
  };
}

function renderHeader(context) {
  const agent = context?.agent || { id: context?.agentId, label: context?.agentLabel };
  document.title = `${window.MessageView.formatAgentLabel(agent)} · 历史消息`;
}

function setHistoryStatus(text, kind = 'ok') {
  if (!historyStatusEl) return;
  window.clearTimeout(historyStatusTimer);
  const value = String(text || '').trim();
  if (!value) {
    historyStatusEl.hidden = true;
    historyStatusEl.textContent = '';
    delete historyStatusEl.dataset.kind;
    return;
  }
  historyStatusEl.hidden = false;
  historyStatusEl.dataset.kind = kind || 'ok';
  historyStatusEl.textContent = value;
  if (kind === 'pending') return;
  historyStatusTimer = window.setTimeout(() => {
    historyStatusEl.hidden = true;
  }, 2200);
}

function historyAuthorLabel(msg) {
  if (!msg) return '未知';
  if (msg.who === 'me') return '用户';
  return window.MessageView.formatAgentLabel(historyAgent());
}

function originalSentTime(msg) {
  if (typeof window.MessageTime?.resolveMessageOriginalSentTime === 'function') {
    return window.MessageTime.resolveMessageOriginalSentTime(msg) || '';
  }
  return String(msg?.sentTime || msg?.time || '').trim();
}

function stripHeavyPayload(text) {
  return String(text || '')
    .replace(/\[image:data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+\]/g, '')
    .replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function quoteTextFromMessage(msg) {
  if (!msg) return '';
  const forwardRef = msg.who === 'me' && msg.forward?.text ? msg.forward : null;
  if (forwardRef?.text) {
    const body = String(forwardRef.text).trim();
    const comment = String(msg.text || '').trim();
    if (comment && comment !== body) return `${body}\n\n${comment}`;
    return body;
  }
  let body = stripHeavyPayload(msg.text || '');
  if (!body && Array.isArray(msg.images) && msg.images.length > 0) body = '（图片）';
  if (!body && Array.isArray(msg.files) && msg.files.length > 0) {
    body = msg.files.map((file) => file.name).filter(Boolean).join('、') || '（附件）';
  }
  return body;
}

function forwardSourceText(msg) {
  if (!msg) return '';
  if (msg.who === 'me') {
    const parts = [];
    if (msg.forward?.text) parts.push(String(msg.forward.text).trim());
    else if (msg.quote?.text) parts.push(`[引用 ${msg.quote.authorLabel || '未知'}]\n${msg.quote.text}`);
    const reply = String(msg.text || '').trim();
    if (reply && reply !== String(msg.forward?.text || '').trim()) parts.push(reply);
    const combined = parts.join('\n\n').trim();
    if (combined) return combined;
  }
  return quoteTextFromMessage(msg);
}

function selectableText(msg) {
  if (!msg) return '';
  const parts = [];
  if (msg.who === 'me' && msg.forward?.text) {
    parts.push(`[转发 ${msg.forward.authorLabel || '未知'}]\n${msg.forward.text}`);
  } else if (msg.quote?.text) {
    parts.push(`[引用 ${msg.quote.authorLabel || '未知'}]\n${msg.quote.text}`);
  }
  const body = msg.who === 'me' ? String(msg.text || '').trim() : quoteTextFromMessage(msg);
  if (body) parts.push(body);
  return parts.join('\n\n').trim();
}

function isHistoryMessageSelectable(msg) {
  return Boolean(selectableText(msg));
}

function copyTextForMessage(msg) {
  if (!msg) return '';
  const parts = [];
  const text = selectableText(msg);
  if (text) parts.push(text);
  const images = Array.isArray(msg.images) ? msg.images : [];
  if (images.length > 0) {
    parts.push(images.length === 1 ? '[图片]' : `[图片 x${images.length}]`);
  }
  const files = Array.isArray(msg.files) ? msg.files : [];
  if (files.length > 0) {
    const names = files.map((file) => file.name || '未命名文件').join('、');
    parts.push(`[附件] ${names}`);
  }
  return parts.join('\n\n').trim();
}

function exportEntryForMessage(msg) {
  const entry = {
    author: historyAuthorLabel(msg),
    time: msg?.time || '',
    text: String(msg?.text || '').replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n').trim(),
  };
  if (msg?.who === 'me' && msg.forward?.text) {
    entry.forward = {
      authorLabel: msg.forward.authorLabel || '未知',
      text: msg.forward.text,
    };
  } else if (msg?.quote?.text) {
    entry.quote = {
      authorLabel: msg.quote.authorLabel || '未知',
      text: msg.quote.text,
    };
  }
  return entry;
}

function preparedForwardForMessage(msg) {
  const text = forwardSourceText(msg);
  if (!text) return null;
  return {
    preparedForward: true,
    who: msg.who === 'me' ? 'me' : 'them',
    authorLabel: historyAuthorLabel(msg),
    text,
    time: originalSentTime(msg),
    sentAtMs: msg.sentAtMs,
    sentTime: msg.sentTime,
  };
}

function preparedForwardForSelection(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const blocks = [];
  let earliestTime = '';
  let earliestSentAtMs;
  let earliestSentTime;
  for (const idx of sorted) {
    const msg = displayedMessages[idx];
    if (!isHistoryMessageSelectable(msg)) continue;
    const text = selectableText(msg);
    const author = historyAuthorLabel(msg);
    const stamp = msg.time ? ` · ${msg.time}` : '';
    blocks.push(`【${author}${stamp}】\n${text}`);
    const sent = originalSentTime(msg);
    if (!earliestTime && sent) earliestTime = sent;
    if (earliestSentAtMs == null && msg.sentAtMs != null) earliestSentAtMs = msg.sentAtMs;
    if (!earliestSentTime && msg.sentTime) earliestSentTime = msg.sentTime;
  }
  if (!blocks.length) return null;
  return {
    preparedForward: true,
    isMergedForward: true,
    who: 'them',
    authorLabel: `已选 ${blocks.length} 条消息`,
    text: blocks.join('\n\n'),
    time: earliestTime,
    sentAtMs: earliestSentAtMs,
    sentTime: earliestSentTime,
    count: blocks.length,
  };
}

function quotePayloadForMessage(msg) {
  const text = quoteTextFromMessage(msg);
  if (!text) return null;
  return {
    who: msg.who === 'me' ? 'me' : 'them',
    authorLabel: historyAuthorLabel(msg),
    text,
    time: originalSentTime(msg),
    sentAtMs: msg.sentAtMs,
    sentTime: msg.sentTime,
  };
}

function paintMessages({ preserveScroll = false, preserveSearch = false } = {}) {
  if (!messagesEl) return;
  const keyword = historySearchInput?.value || '';
  const searchIndex = currentSearchIndex;
  window.MessageView.renderMessageList(messagesEl, displayedMessages, {
    agent: historyAgent(),
    showAvatars: false,
    preserveScroll,
    multiSelect: historyMultiSelectMode ? {
      selected: historySelectedIndices,
      isSelectable: isHistoryMessageSelectable,
    } : null,
  });
  applySearch(keyword);
  if (preserveSearch && searchIndex >= 0 && currentSearchMarks.length > 0) {
    setActiveSearchMark(searchIndex, { scroll: false });
  }
}

function renderHistoryMessages(context, messages, options = {}) {
  historyContext = context || historyContext;
  renderHeader(historyContext);
  displayedMessages = Array.isArray(messages) ? messages : [];
  hideHistoryContextMenu();
  paintMessages(options);
}

async function renderHistory(context) {
  const generation = ++renderGeneration;
  historyContext = context || historyContext;
  const sessionKey = historyContext?.sessionKey || '';
  clearHistoryMultiSelect();
  if (!sessionKey) {
    displayedMessages = [];
    hideHistoryContextMenu();
    if (messagesEl) {
      messagesEl.classList.remove('is-multiselect');
      messagesEl.innerHTML = '<div class="msg-hint">无法读取会话信息</div>';
    }
    return;
  }

  if (messagesEl) {
    messagesEl.innerHTML = '<div class="msg-hint">加载中…</div>';
  }

  const saved = await loadSavedMessages(sessionKey);
  if (generation !== renderGeneration) return;

  const messages = prepareMessagesForDisplay(saved);
  if (!messages.length && messagesEl) {
    displayedMessages = [];
    hideHistoryContextMenu();
    messagesEl.classList.remove('is-multiselect');
    messagesEl.innerHTML = '<div class="msg-hint">暂无历史消息</div>';
    applySearch('');
    renderHeader(historyContext);
    return;
  }
  renderHistoryMessages(historyContext, messages);
}

function escapeRegExp(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearSearchHighlights() {
  if (!messagesEl) return;
  const marks = messagesEl.querySelectorAll('mark.history-search-hit');
  for (const mark of marks) {
    const text = document.createTextNode(mark.textContent || '');
    mark.replaceWith(text);
  }
  messagesEl.normalize();
}

function highlightTextInElement(root, keyword) {
  const marks = [];
  if (!root || !keyword) return marks;
  const regex = new RegExp(escapeRegExp(keyword), 'ig');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node?.nodeValue || !node.nodeValue.trim()) continue;
    if (node.parentElement?.closest('mark.history-search-hit')) continue;
    nodes.push(node);
  }

  for (const node of nodes) {
    const text = node.nodeValue || '';
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const index = match.index;
      const token = match[0];
      if (index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, index)));
      }
      const mark = document.createElement('mark');
      mark.className = 'history-search-hit';
      mark.textContent = token;
      frag.appendChild(mark);
      marks.push(mark);
      last = index + token.length;
      if (token.length === 0) break;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    node.replaceWith(frag);
  }

  return marks;
}

function updateSearchCount() {
  if (!historySearchCount) return;
  const total = currentSearchMarks.length;
  const active = total > 0 && currentSearchIndex >= 0 ? currentSearchIndex + 1 : 0;
  historySearchCount.textContent = `${active}/${total}`;
  if (historySearchPrev) historySearchPrev.disabled = total === 0;
  if (historySearchNext) historySearchNext.disabled = total === 0;
}

function setActiveSearchMark(index, { scroll = true } = {}) {
  if (!currentSearchMarks.length) {
    currentSearchIndex = -1;
    updateSearchCount();
    return;
  }
  const total = currentSearchMarks.length;
  currentSearchIndex = ((index % total) + total) % total;
  for (let i = 0; i < total; i += 1) {
    currentSearchMarks[i].classList.toggle('history-search-hit-active', i === currentSearchIndex);
  }
  updateSearchCount();
  const active = currentSearchMarks[currentSearchIndex];
  if (scroll && active) {
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function applySearch(keywordRaw) {
  clearSearchHighlights();
  const keyword = String(keywordRaw || '').trim();
  currentSearchMarks.length = 0;
  currentSearchIndex = -1;
  if (!keyword || !messagesEl) {
    updateSearchCount();
    return;
  }

  const bubbles = messagesEl.querySelectorAll('.msg-bubble');
  for (const bubble of bubbles) {
    const marks = highlightTextInElement(bubble, keyword);
    if (marks.length > 0) currentSearchMarks.push(...marks);
  }
  setActiveSearchMark(0, { scroll: false });
}

function stepSearch(delta) {
  if (!currentSearchMarks.length) return;
  setActiveSearchMark(currentSearchIndex + delta);
}

function hideHistoryContextMenu() {
  historyMenuIndex = -1;
  if (historyContextMenuEl) historyContextMenuEl.hidden = true;
}

function showHistoryContextMenu(x, y, index) {
  if (!historyContextMenuEl) return;
  historyMenuIndex = index;
  const editBtn = historyContextMenuEl.querySelector('[data-action="copy-edit"]');
  if (editBtn) editBtn.disabled = !selectableText(displayedMessages[index]);
  historyContextMenuEl.hidden = false;
  const menuRect = historyContextMenuEl.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;
  historyContextMenuEl.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  historyContextMenuEl.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
}

function countHistorySelection() {
  let count = 0;
  for (const index of historySelectedIndices) {
    if (isHistoryMessageSelectable(displayedMessages[index])) count += 1;
  }
  return count;
}

function updateHistoryMultiSelectBar() {
  const count = countHistorySelection();
  if (historySelectedIndices.size > count) {
    historySelectedIndices = new Set(
      [...historySelectedIndices].filter((index) => isHistoryMessageSelectable(displayedMessages[index])),
    );
  }
  const hint = count > 0 ? `已选 ${count} 条` : '请选择消息';
  if (historyMultiselectHintEl) historyMultiselectHintEl.textContent = hint;
  if (historyMultiselectEl) historyMultiselectEl.hidden = !historyMultiSelectMode;
  for (const btn of [historyMultiselectExportBtn, historyMultiselectSendBtn]) {
    if (!btn) continue;
    btn.disabled = count === 0;
    btn.setAttribute('aria-disabled', count === 0 ? 'true' : 'false');
  }
}

function clearHistoryMultiSelect() {
  historyMultiSelectMode = false;
  historySelectedIndices = new Set();
  updateHistoryMultiSelectBar();
}

function exitHistoryMultiSelect() {
  if (!historyMultiSelectMode) return;
  clearHistoryMultiSelect();
  paintMessages({ preserveScroll: true, preserveSearch: true });
}

function enterHistoryMultiSelect(index) {
  historySelectedIndices = new Set();
  if (isHistoryMessageSelectable(displayedMessages[index])) {
    historySelectedIndices.add(index);
  }
  historyMultiSelectMode = true;
  hideHistoryContextMenu();
  updateHistoryMultiSelectBar();
  paintMessages({ preserveScroll: true, preserveSearch: true });
}

function updateHistorySelectRow(index) {
  const row = messagesEl?.querySelectorAll('.msg')[index];
  const check = row?.querySelector('.msg-select-check');
  if (!check || check.hidden) {
    paintMessages({ preserveScroll: true, preserveSearch: true });
    return;
  }
  const selected = historySelectedIndices.has(index);
  check.classList.toggle('selected', selected);
  check.setAttribute('aria-label', selected ? '取消选择' : '选择消息');
  check.setAttribute('aria-pressed', selected ? 'true' : 'false');
}

function toggleHistorySelect(index) {
  if (!historyMultiSelectMode) return;
  const msg = displayedMessages[index];
  if (!isHistoryMessageSelectable(msg)) return;
  if (historySelectedIndices.has(index)) historySelectedIndices.delete(index);
  else historySelectedIndices.add(index);
  updateHistoryMultiSelectBar();
  updateHistorySelectRow(index);
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function copyHistoryMessage(msg) {
  const text = copyTextForMessage(msg);
  if (!text) {
    setHistoryStatus('该消息没有可复制的内容', 'error');
    return;
  }
  const ok = await copyTextToClipboard(text);
  setHistoryStatus(ok ? '已复制' : '复制失败', ok ? 'ok' : 'error');
}

async function exportHistoryMessages(messages, { exitOnSuccess = false } = {}) {
  if (historyExportInFlight) return;
  const entries = (Array.isArray(messages) ? messages : [])
    .map((msg) => exportEntryForMessage(msg))
    .filter((entry) => entry.text || entry.quote?.text || entry.forward?.text);
  if (!entries.length) {
    setHistoryStatus('没有可保存的文字', 'error');
    return;
  }
  if (!window.qiziHistory?.exportWord) {
    setHistoryStatus('保存功能不可用', 'error');
    return;
  }
  historyExportInFlight = true;
  setHistoryStatus('正在保存…', 'pending');
  try {
    const result = await window.qiziHistory.exportWord(entries);
    if (result?.cancelled) {
      setHistoryStatus('');
      return;
    }
    if (!result?.ok) {
      setHistoryStatus(result?.error || '保存失败', 'error');
      return;
    }
    setHistoryStatus('已保存', 'ok');
    if (exitOnSuccess) exitHistoryMultiSelect();
  } catch (err) {
    setHistoryStatus(err?.message || '保存失败', 'error');
  } finally {
    historyExportInFlight = false;
  }
}

async function handoffHistoryAction(payload, failureStatus) {
  if (historyHandoffInFlight) return;
  if (!window.qiziHistory?.runMessageAction) {
    setHistoryStatus('操作失败', 'error');
    return;
  }
  historyHandoffInFlight = true;
  try {
    const result = await window.qiziHistory.runMessageAction(payload);
    if (result?.ok) {
      window.close();
      return;
    }
    setHistoryStatus(result?.error || failureStatus, 'error');
  } catch (err) {
    setHistoryStatus(err?.message || failureStatus, 'error');
  } finally {
    historyHandoffInFlight = false;
  }
}

async function runHistoryMenuAction(action) {
  const index = historyMenuIndex;
  const msg = displayedMessages[index];
  hideHistoryContextMenu();
  if (!msg || index < 0) return;
  if (action === 'copy') {
    await copyHistoryMessage(msg);
    return;
  }
  if (action === 'multiselect') {
    enterHistoryMultiSelect(index);
    if (!isHistoryMessageSelectable(msg)) {
      setHistoryStatus('该消息没有可选文字', 'error');
    }
    return;
  }
  if (action === 'export') {
    if (!isHistoryMessageSelectable(msg)) {
      setHistoryStatus('该消息没有可保存的文字', 'error');
      return;
    }
    await exportHistoryMessages([msg]);
    return;
  }
  if (action === 'quote') {
    const quote = quotePayloadForMessage(msg);
    if (!quote) {
      setHistoryStatus('该消息没有可引用的文字', 'error');
      return;
    }
    await handoffHistoryAction({ action: 'quote', quote }, '引用失败');
    return;
  }
  if (action === 'forward') {
    const forward = preparedForwardForMessage(msg);
    if (!forward) {
      setHistoryStatus('该消息没有可转发的文字', 'error');
      return;
    }
    await handoffHistoryAction({
      action: 'forward',
      previewLabel: `${forward.authorLabel || '未知'} · 转发内容`,
      forward,
    }, '转发失败');
    return;
  }
  if (action === 'copy-edit') {
    const text = selectableText(msg);
    if (!text) {
      setHistoryStatus('该消息没有可编辑的文字', 'error');
      return;
    }
    if (!window.qiziHistory?.openCopyEdit) {
      setHistoryStatus('文案编辑不可用', 'error');
      return;
    }
    try {
      const result = await window.qiziHistory.openCopyEdit({ text });
      if (!result?.ok) setHistoryStatus(result?.error || '打不开文案编辑', 'error');
    } catch (err) {
      setHistoryStatus(err?.message || '打不开文案编辑', 'error');
    }
    return;
  }
  if (action === 'start-meeting') {
    const draft = selectableText(msg);
    if (!draft) {
      setHistoryStatus('该消息没有可用内容', 'error');
      return;
    }
    await handoffHistoryAction({ action: 'start-meeting', draft }, '无法发起会议');
  }
}

function selectedHistoryMessages() {
  return [...historySelectedIndices]
    .sort((a, b) => a - b)
    .map((index) => displayedMessages[index])
    .filter((msg) => isHistoryMessageSelectable(msg));
}

async function sendHistorySelection() {
  const forward = preparedForwardForSelection(historySelectedIndices);
  if (!forward?.text) {
    setHistoryStatus('所选消息没有可转发的文字', 'error');
    return;
  }
  await handoffHistoryAction({
    action: 'forward',
    previewLabel: `已选 ${forward.count} 条消息 · 转发预览`,
    forward,
  }, '转发失败');
}

function bindHistoryContextMenu() {
  if (!messagesEl || messagesEl.dataset.historyMenuBound) return;
  messagesEl.dataset.historyMenuBound = '1';
  messagesEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg');
    if (!row || !messagesEl.contains(row)) return;
    e.preventDefault();
    const rows = [...messagesEl.querySelectorAll('.msg')];
    const index = rows.indexOf(row);
    if (index < 0 || index >= displayedMessages.length) return;
    showHistoryContextMenu(e.clientX, e.clientY, index);
  });
  messagesEl.addEventListener('click', (e) => {
    if (!historyMultiSelectMode) return;
    const selectBtn = e.target.closest('.msg-select-check');
    if (selectBtn) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(selectBtn.dataset.msgIndex);
      if (Number.isFinite(idx)) toggleHistorySelect(idx);
      return;
    }
    const row = e.target.closest('.msg');
    if (!row || e.target.closest('.msg-quote-toggle, a, .msg-code-btn, .msg-bubble img')) return;
    const rows = [...messagesEl.querySelectorAll('.msg')];
    const idx = rows.indexOf(row);
    if (idx >= 0) {
      e.preventDefault();
      toggleHistorySelect(idx);
    }
  });
  messagesEl.addEventListener('scroll', hideHistoryContextMenu);
  if (historyContextMenuEl) {
    historyContextMenuEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item || item.disabled) return;
      const index = historyMenuIndex;
      void runHistoryMenuAction(item.dataset.action).finally(() => {
        if (item.dataset.action === 'multiselect' && index >= 0 && historyMultiSelectMode) {
          messagesEl.querySelectorAll('.msg')[index]?.scrollIntoView({ block: 'nearest' });
        }
      });
    });
  }
  document.addEventListener('click', (e) => {
    if (!historyContextMenuEl || historyContextMenuEl.hidden) return;
    if (!e.target.closest('#msg-context-menu')) hideHistoryContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (historyContextMenuEl && !historyContextMenuEl.hidden) {
      hideHistoryContextMenu();
      return;
    }
    if (e.target === historySearchInput) return;
    if (historyMultiSelectMode) exitHistoryMultiSelect();
  });
}

function bindSearchEvents() {
  if (!historySearchInput) return;
  historySearchInput.addEventListener('input', () => {
    applySearch(historySearchInput.value);
  });
  historySearchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    stepSearch(e.shiftKey ? -1 : 1);
  });
  if (historySearchPrev) {
    historySearchPrev.addEventListener('click', () => stepSearch(-1));
  }
  if (historySearchNext) {
    historySearchNext.addEventListener('click', () => stepSearch(1));
  }
  if (historySearchClear) {
    historySearchClear.addEventListener('click', () => {
      historySearchInput.value = '';
      applySearch('');
      historySearchInput.focus();
    });
  }
  document.addEventListener('keydown', (e) => {
    const isFind = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f';
    if (!isFind) return;
    e.preventDefault();
    historySearchInput.focus();
    historySearchInput.select();
  });
}

function bindMultiSelectBar() {
  if (historyMultiselectCancelBtn) {
    historyMultiselectCancelBtn.addEventListener('click', () => {
      exitHistoryMultiSelect();
    });
  }
  if (historyMultiselectExportBtn) {
    historyMultiselectExportBtn.addEventListener('click', () => {
      if (historyMultiselectExportBtn.disabled) return;
      void exportHistoryMessages(selectedHistoryMessages(), { exitOnSuccess: true });
    });
  }
  if (historyMultiselectSendBtn) {
    historyMultiselectSendBtn.addEventListener('click', () => {
      if (historyMultiselectSendBtn.disabled) return;
      void sendHistorySelection();
    });
  }
}

async function boot(initialContext) {
  historyContext = initialContext || await window.qiziHistory.getContext();
  await renderHistory(historyContext);
}

window.MessageView.bindQuoteToggles(messagesEl);
bindHistoryContextMenu();
bindSearchEvents();
bindMultiSelectBar();
updateHistoryMultiSelectBar();
void boot();

if (window.qiziHistory.onRefresh) {
  window.qiziHistory.onRefresh((context) => {
    if (!context?.sessionKey) return;
    historyContext = context;
    void renderHistory(context);
  });
}
