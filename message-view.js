/**
 * 只读消息列表渲染（主窗口与历史窗口共用）
 */
(() => {
  const LOCAL_USER_LABEL = '用户';
  const ATTACHMENT_ONLY_CAPTIONS = new Set([
    '（附件）', '（图片）', '[图片]', '[附件]', '[User sent media without caption]',
  ]);
  const INLINE_EMOJI_SEGMENT_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*|[\u{1F1E6}-\u{1F1FF}]{2})$/u;
  const INLINE_EMOJI_SPLIT_RE = /(\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
  const RICH_HTML_PURIFY_CONFIG = {
    ALLOWED_TAGS: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
      'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody',
      'td', 'th', 'thead', 'tr', 'ul',
    ],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
  };

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function isEmojiLike(text) {
    return /\p{Extended_Pictographic}/u.test(text);
  }

  function formatAgentLabel(agent) {
    if (!agent) return '启孜';
    if (agent.label) return agent.label;
    if (agent.id === 'main') return '启孜';
    return agent.name || agent.id || '启孜';
  }

  function agentAvatarFallbackText(agent) {
    const emoji = agent?.emoji;
    if (emoji && emoji.trim()) return emoji.trim();
    const label = formatAgentLabel(agent);
    return label.slice(0, 1) || '启';
  }

  function wrapInlineEmojisForHtml(text, { escape = false } = {}) {
    return String(text || '').split(INLINE_EMOJI_SPLIT_RE).map((part) => {
      if (!part) return '';
      if (INLINE_EMOJI_SEGMENT_RE.test(part)) {
        return `<span class="msg-inline-emoji">${part}</span>`;
      }
      return escape ? escapeHtml(part) : part;
    }).join('');
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

  function sanitizeRichHtml(html) {
    if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
      return DOMPurify.sanitize(String(html || ''), RICH_HTML_PURIFY_CONFIG);
    }
    return escapeHtml(String(html || ''));
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
          return sanitizeRichHtml(wrapMarkdownTables(result));
        }
      } catch (e) {
        console.warn('[message-view] markdown parse failed:', e);
      }
    }
    return sanitizeRichHtml(wrapMarkdownTables(String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>')));
  }

  function isAttachmentPlaceholder(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return true;
    return ATTACHMENT_ONLY_CAPTIONS.has(trimmed);
  }

  function formatFileSize(bytes) {
    if (bytes == null || Number.isNaN(Number(bytes))) return '';
    const n = Number(bytes);
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }

  function renderMessageContent(text, { extraImages = [] } = {}) {
    const imageRegex = /\[image:(data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\]/g;
    const images = [...extraImages];
    let plainText = String(text || '').replace(imageRegex, (_m, dataUrl) => {
      images.push(dataUrl);
      return '';
    });
    plainText = plainText.replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n');
    plainText = plainText.replace(/\n{3,}/g, '\n\n').trim();
    let html = '';
    if (images.length > 0) {
      html += `<div class="msg-images">${images.map((url) => `<img class="msg-image" src="${url}" />`).join('')}</div>`;
    }
    if (plainText) {
      html += parseMarkdown(wrapInlineEmojisForHtml(plainText), { breaks: true });
    }
    return { html, plainText, images };
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

  function getUserMessageDisplayText(m) {
    if (!m || m.who !== 'me') return m?.text || '';
    return m.text || '';
  }

  function renderMessageAvatarHtml(who, agent) {
    if (who === 'me') {
      return `<div class="msg-avatar msg-avatar-me" role="img" aria-label="${LOCAL_USER_LABEL}">我</div>`;
    }
    const label = escapeHtml(formatAgentLabel(agent));
    if (agent?.avatarDataUrl) {
      return `<div class="msg-avatar msg-avatar-them" role="img" aria-label="${label}"><img src="${agent.avatarDataUrl}" alt="${label}"></div>`;
    }
    const fallback = agentAvatarFallbackText(agent);
    const emojiClass = isEmojiLike(fallback) ? ' msg-avatar-emoji' : '';
    return `<div class="msg-avatar msg-avatar-them${emojiClass}" role="img" aria-label="${label}">${escapeHtml(fallback)}</div>`;
  }

  function renderMessageBubbleContent(m, msgIndex, agent) {
    const extraImages = Array.isArray(m.images) ? m.images : [];
    const files = Array.isArray(m.files) ? m.files : [];
    let text = m.who === 'me' ? getUserMessageDisplayText(m) : (m.text || '');
    const trimmed = text.trim();
    if ((extraImages.length > 0 || files.length > 0) && isAttachmentPlaceholder(trimmed)) {
      text = '';
    }
    const content = extraImages.length === 0 && text.includes('[image:')
      ? renderMessageContent(text)
      : renderMessageContent(text, { extraImages });
    if (files.length > 0) {
      content.html = renderMessageFilesHtml(files) + content.html;
    }
    const forwardRef = m.who === 'me' && m.forward?.text ? m.forward : null;
    if (forwardRef) {
      content.html = renderQuoteRefHtml(forwardRef, msgIndex) + content.html;
    } else if (m.quote) {
      content.html = renderQuoteRefHtml(m.quote, msgIndex) + content.html;
    }
    return content;
  }

  function formatMessageMeta(m) {
    const parts = [];
    const time = String(m.sentTime || m.time || '').trim();
    if (time) parts.push(time);
    return parts.join(' · ');
  }

  function renderMessageList(container, messages, { agent, showAvatars = true } = {}) {
    if (!container) return;
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      container.innerHTML = '<div class="msg-hint">近两个月暂无历史消息</div>';
      return;
    }
    container.innerHTML = '';
    container.classList.toggle('messages--no-avatar', showAvatars !== true);
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      const row = document.createElement('div');
      row.className = `msg ${m.who || 'them'}${showAvatars ? '' : ' no-avatar'}`;
      if (m.runId != null) row.dataset.runId = String(m.runId);
      const avatarHtml = showAvatars ? renderMessageAvatarHtml(m.who, agent) : '';
      row.innerHTML = `
        ${avatarHtml}
        <div class="msg-content">
          <div class="msg-bubble"></div>
          <div class="msg-meta">${escapeHtml(formatMessageMeta(m))}</div>
        </div>
      `;
      row.querySelector('.msg-bubble').innerHTML = renderMessageBubbleContent(m, i, agent).html;
      container.appendChild(row);
    }
    container.scrollTop = container.scrollHeight;
  }

  function bindQuoteToggles(container) {
    if (!container) return;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.msg-quote-toggle');
      if (!btn) return;
      const card = btn.closest('.msg-quote-card');
      if (!card) return;
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
    });
  }

  window.MessageView = {
    renderMessageList,
    bindQuoteToggles,
    formatAgentLabel,
  };
})();
