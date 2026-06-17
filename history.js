const MessageTimeApi = window.MessageTime || {};
const STORAGE_PREFIX = 'qizi-shell-messages:';
const LEGACY_STORAGE_KEY = 'qizi-shell-messages';
const DEFAULT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

const messagesEl = document.getElementById('messages');
const historySearchInput = document.getElementById('history-search-input');
const historySearchCount = document.getElementById('history-search-count');
const historySearchPrev = document.getElementById('history-search-prev');
const historySearchNext = document.getElementById('history-search-next');
const historySearchClear = document.getElementById('history-search-clear');

let currentSearchMarks = [];
let currentSearchIndex = -1;

function isStreamingPlaceholderText(text) {
  const trimmed = String(text || '').trim();
  return !trimmed || trimmed === '…';
}

function backfillMessageSentAtMs(msg) {
  if (!msg) return msg;
  if (typeof msg.sentAtMs === 'number' && Number.isFinite(msg.sentAtMs)) return msg;
  if (typeof MessageTimeApi?.extractMessageSentTimeFromRaw === 'function') {
    const sent = MessageTimeApi.extractMessageSentTimeFromRaw({
      sentTime: msg.sentTime,
      sentAtMs: msg.sentAtMs,
      time: msg.time,
      text: msg.text,
    });
    if (sent.sentAtMs != null) {
      return {
        ...msg,
        sentAtMs: sent.sentAtMs,
        sentTime: msg.sentTime || sent.time || msg.sentTime,
      };
    }
  }
  return msg;
}

function pruneByRetention(list, retentionMs) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const cutoff = Date.now() - retentionMs;
  return list
    .map((m) => backfillMessageSentAtMs({ ...m, streaming: false }))
    .filter((m) => {
      if (m.who === 'them' && isStreamingPlaceholderText(m.text)) return false;
      if (m.who === 'me' && !String(m.text || '').trim()
        && !(Array.isArray(m.images) && m.images.length)
        && !(Array.isArray(m.files) && m.files.length)) {
        return false;
      }
      const ms = m.sentAtMs;
      if (typeof ms === 'number' && Number.isFinite(ms)) return ms >= cutoff;
      return true;
    });
}

function loadLocalMessages(sessionKey) {
  if (!sessionKey) return [];
  const storageKey = `${STORAGE_PREFIX}${sessionKey}`;
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
}

function renderHeader(context) {
  const agent = context?.agent || { id: context?.agentId, label: context?.agentLabel };
  document.title = `${window.MessageView.formatAgentLabel(agent)} · 历史消息`;
}

function renderHistory(context) {
  const retentionMs = Number(context?.retentionMs) || DEFAULT_RETENTION_MS;
  const sessionKey = context?.sessionKey || '';
  const raw = loadLocalMessages(sessionKey);
  const messages = pruneByRetention(raw, retentionMs);
  renderHeader(context);
  window.MessageView.renderMessageList(messagesEl, messages, {
    agent: context?.agent,
    showAvatars: false,
  });
  applySearch(historySearchInput?.value || '');
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
  currentSearchMarks = [];
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

async function boot(initialContext) {
  const context = initialContext || await window.qiziHistory.getContext();
  if (!context?.sessionKey) {
    if (messagesEl) {
      messagesEl.innerHTML = '<div class="msg-hint">无法读取会话信息</div>';
    }
    return;
  }
  renderHistory(context);
}

window.MessageView.bindQuoteToggles(messagesEl);
bindSearchEvents();
void boot();

if (window.qiziHistory.onRefresh) {
  window.qiziHistory.onRefresh((context) => {
    if (context?.sessionKey) renderHistory(context);
  });
}
