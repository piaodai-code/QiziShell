(function initMeetingView() {
  const MEETING_AVATAR_SRC = 'assets/icons/meeting-team.png';

  const chatScreenEl = document.getElementById('chat-screen');
  const meetingScreenEl = document.getElementById('meeting-screen');
  const messagesEl = document.getElementById('meeting-messages');
  const composerEl = document.getElementById('composer');
  const composerBodyEl = document.getElementById('composer-body');
  const observeBarEl = document.getElementById('meeting-observe-bar');
  const bannerEl = document.getElementById('meeting-banner');
  const bannerTopicEl = document.getElementById('meeting-banner-topic');
  const bannerStatusEl = document.getElementById('meeting-banner-status');
  const exitBtn = document.getElementById('meeting-exit-btn');

  if (!messagesEl) return;

  let running = false;
  let visible = false;
  /** @type {Array<object>} */
  let meetingMessages = [];
  /** @type {object|null} */
  let meetingConfig = null;
  /** @type {Map<string, object>} */
  let agentCatalog = new Map();
  let meetingStatus = '';

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function parseMarkdown(text) {
    const raw = typeof marked !== 'undefined'
      ? marked.parse(String(text || ''), { breaks: true })
      : escapeHtml(text);
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(raw) : raw;
  }

  function renderBubbleHtml(text, streaming) {
    const plain = String(text || '').trim();
    if (!plain) return '';
    if (streaming) {
      return `<pre class="msg-stream-plain">${escapeHtml(plain)}</pre>`;
    }
    return parseMarkdown(plain);
  }

  function agentInfo(agentId) {
    if (!agentId) return null;
    return agentCatalog.get(agentId) || { id: agentId, label: agentId };
  }

  function agentLabel(agentId) {
    const info = agentInfo(agentId);
    return info?.label || info?.name || agentId || 'Agent';
  }

  function isEmojiLike(text) {
    return /\p{Extended_Pictographic}/u.test(text);
  }

  function avatarFallback(agent) {
    if (agent?.emoji?.trim()) return agent.emoji.trim();
    const label = agentLabel(agent?.id);
    return label.slice(0, 1) || '启';
  }

  function speakerDisplay(m) {
    if (m.speakerLabel === '任务书') {
      return { label: '任务书', agent: null };
    }
    if (m.who === 'me') {
      const agentId = m.speakerAgentId || meetingConfig?.moderatorAgentId;
      return { label: m.speakerLabel || agentLabel(agentId), agent: agentInfo(agentId) };
    }
    const agentId = m.speakerAgentId;
    return {
      label: agentId ? agentLabel(agentId) : (m.speakerLabel || 'Agent'),
      agent: agentInfo(agentId),
    };
  }

  function renderAvatarHtml(m) {
    if (m.speakerLabel === '任务书') {
      return '<div class="msg-avatar msg-avatar-me" aria-hidden="true">📋</div>';
    }
    const speaker = speakerDisplay(m);
    const label = escapeHtml(speaker.label);
    if (m.who === 'me') {
      const agent = speaker.agent || agentInfo(meetingConfig?.moderatorAgentId);
      if (agent?.avatarDataUrl) {
        return `<div class="msg-avatar msg-avatar-me" role="img" aria-label="${label}"><img src="${agent.avatarDataUrl}" alt="${label}"></div>`;
      }
      const fb = avatarFallback(agent);
      const cls = isEmojiLike(fb) ? ' msg-avatar-emoji' : '';
      return `<div class="msg-avatar msg-avatar-me${cls}" role="img" aria-label="${label}">${escapeHtml(fb)}</div>`;
    }
    const agent = speaker.agent;
    if (agent?.avatarDataUrl) {
      return `<div class="msg-avatar msg-avatar-them" role="img" aria-label="${label}"><img src="${agent.avatarDataUrl}" alt="${label}"></div>`;
    }
    const fb = avatarFallback(agent || { id: m.speakerAgentId, label: speaker.label });
    const cls = isEmojiLike(fb) ? ' msg-avatar-emoji' : '';
    return `<div class="msg-avatar msg-avatar-them${cls}" role="img" aria-label="${label}">${escapeHtml(fb)}</div>`;
  }

  function renderMetaHtml(m) {
    const parts = [];
    const speaker = speakerDisplay(m);
    if (speaker.label) parts.push(speaker.label);
    if (m.time) parts.push(m.time);
    if (m.streaming) parts.push('输入中…');
    return parts.join(' · ');
  }

  function render() {
    if (!visible || !messagesEl) return;
    if (meetingMessages.length === 0) {
      messagesEl.innerHTML = '<div class="msg-hint">会议进行中，等待发言…</div>';
      return;
    }
    messagesEl.innerHTML = '';
    for (let i = 0; i < meetingMessages.length; i += 1) {
      const m = meetingMessages[i];
      const row = document.createElement('div');
      row.className = 'msg ' + (m.who === 'me' ? 'me' : 'them');
      if (m.runId != null) row.dataset.runId = String(m.runId);
      const selectHtml = window.QiziShellMsgOps?.renderMessageSelectCheckHtml?.(i) || '';
      row.innerHTML = `
        ${renderAvatarHtml(m)}
        <div class="msg-content">
          <div class="msg-bubble"></div>
          <div class="msg-meta">${escapeHtml(renderMetaHtml(m))}</div>
        </div>
        ${selectHtml}
      `;
      row.querySelector('.msg-bubble').innerHTML = renderBubbleHtml(m.text, m.streaming);
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(text) {
    meetingStatus = text || '';
    if (bannerStatusEl) bannerStatusEl.textContent = meetingStatus;
  }

  function buildCatalog(config) {
    agentCatalog = new Map();
    const list = config?.agentCatalog || [];
    for (const agent of list) {
      if (agent?.id) agentCatalog.set(agent.id, agent);
    }
  }

  function applyTranscript(messages) {
    if (!Array.isArray(messages)) return;
    meetingMessages = messages.map((m) => ({ ...m }));
    if (visible) render();
  }

  function getMessages() {
    return meetingMessages.map((m) => ({ ...m }));
  }

  function wireMessageInteractions() {
    if (!messagesEl || messagesEl.dataset.msgOpsBound) return;
    messagesEl.dataset.msgOpsBound = '1';

    messagesEl.addEventListener('click', (e) => {
      const selectBtn = e.target.closest('.msg-select-check');
      if (selectBtn && window.QiziShellMsgOps?.isMultiSelectMode?.()) {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(selectBtn.dataset.msgIndex);
        if (Number.isFinite(idx)) window.QiziShellMsgOps.toggleMultiSelectIndex(idx);
        return;
      }
      if (window.QiziShellMsgOps?.isMultiSelectMode?.()) {
        const row = e.target.closest('.msg');
        if (row && !e.target.closest('a, .msg-bubble img')) {
          const rows = [...messagesEl.querySelectorAll('.msg')];
          const idx = rows.indexOf(row);
          if (idx >= 0) {
            e.preventDefault();
            window.QiziShellMsgOps.toggleMultiSelectIndex(idx);
          }
        }
      }
    });

    messagesEl.addEventListener('contextmenu', (e) => {
      if (!visible) return;
      const row = e.target.closest('.msg');
      if (!row || !messagesEl.contains(row)) return;
      e.preventDefault();
      const rows = [...messagesEl.querySelectorAll('.msg')];
      const msgIndex = rows.indexOf(row);
      if (msgIndex < 0 || msgIndex >= meetingMessages.length) return;
      const msg = meetingMessages[msgIndex];
      if (msg.streaming) return;
      window.QiziShellMsgOps?.showContextMenu?.(e.clientX, e.clientY, msgIndex, 'meeting');
    });

    messagesEl.addEventListener('scroll', () => {
      window.QiziShellMsgOps?.hideContextMenu?.();
    });
  }

  function applyMeetingChrome() {
    const topic = meetingConfig?.topic || '会议模式';
    document.body.classList.add('meeting-mode');
    if (bannerEl) bannerEl.hidden = false;
    if (bannerTopicEl) bannerTopicEl.textContent = topic;
    if (composerBodyEl) composerBodyEl.hidden = true;
    if (observeBarEl) observeBarEl.hidden = false;
    if (composerEl) composerEl.classList.add('composer--meeting');
    setStatus(meetingStatus || '会议进行中…');
  }

  function clearMeetingChrome() {
    document.body.classList.remove('meeting-mode');
    if (bannerEl) bannerEl.hidden = true;
    if (composerBodyEl) composerBodyEl.hidden = false;
    if (observeBarEl) observeBarEl.hidden = true;
    if (composerEl) composerEl.classList.remove('composer--meeting');
  }

  function showMeetingScreen() {
    if (chatScreenEl) chatScreenEl.hidden = true;
    if (meetingScreenEl) meetingScreenEl.hidden = false;
  }

  function hideMeetingScreen() {
    if (meetingScreenEl) meetingScreenEl.hidden = true;
    if (chatScreenEl) chatScreenEl.hidden = false;
  }

  function showView() {
    if (!running) return;
    visible = true;
    showMeetingScreen();
    applyMeetingChrome();
    render();
    window.dispatchEvent(new CustomEvent('qizi-meeting-view-shown', { detail: meetingConfig }));
  }

  function leaveView() {
    if (!running || !visible) return;
    visible = false;
    hideMeetingScreen();
    clearMeetingChrome();
    window.dispatchEvent(new CustomEvent('qizi-meeting-view-hidden'));
  }

  function enter(config) {
    running = true;
    visible = true;
    meetingConfig = config || {};
    meetingMessages = [];
    meetingStatus = '';
    buildCatalog(meetingConfig);

    showMeetingScreen();
    applyMeetingChrome();
    setStatus('正在发送任务书…');
    render();

    window.dispatchEvent(new CustomEvent('qizi-meeting-entered', { detail: meetingConfig }));
  }

  async function exit() {
    running = false;
    visible = false;
    meetingConfig = null;
    meetingMessages = [];
    meetingStatus = '';
    agentCatalog = new Map();

    clearMeetingChrome();
    hideMeetingScreen();
    setStatus('');

    if (window.qizi?.exitMeeting) {
      try { await window.qizi.exitMeeting(); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent('qizi-meeting-exited'));
  }

  function handleEvent(event) {
    if (!running || !event) return;

    if (event.type === 'preparing') {
      setStatus('正在准备任务书…');
    }
    if (event.type === 'briefing_ready' && event.payload) {
      meetingConfig = {
        ...meetingConfig,
        sessionKey: event.payload.sessionKey,
        meetingId: event.payload.meetingId,
      };
      setStatus('任务书已发送');
    }
    if (event.type === 'briefing_sending') {
      setStatus('主持 Agent 正在接收任务书…');
    }
    if (event.type === 'transcript') {
      applyTranscript(event.payload?.messages);
      const streaming = meetingMessages.some((m) => m.streaming);
      setStatus(streaming ? '发言中…' : '会议进行中 · 群聊');
    }
    if (event.type === 'relay_started') {
      setStatus('会议 relay 已启动…');
    }
    if (event.type === 'participant_turn_start' && event.payload) {
      setStatus(`${event.payload.label || event.payload.agentId} 发言中…`);
    }
    if (event.type === 'participant_turn_end' && event.payload) {
      setStatus(`${event.payload.label || event.payload.agentId} 已发言`);
    }
    if (event.type === 'participant_turn_empty' && event.payload) {
      setStatus(`${event.payload.label || event.payload.agentId} 未返回发言，已跳过 · 请主持继续`);
    }
    if (event.type === 'participant_turn_error' && event.payload) {
      setStatus(`${event.payload.label || event.payload.agentId} 发言失败，已跳过 · 请主持继续`);
    }
    if (event.type === 'moderator_nudge') {
      setStatus(event.payload?.reason === 'idle' ? '请主持 @ 下一位…' : '请主持继续…');
    }
    if (event.type === 'done') {
      if (event.payload?.messages) {
        applyTranscript(event.payload.messages);
      }
      setStatus('会议已结束');
    }
    if (event.type === 'error') {
      setStatus(`错误: ${event.payload?.error || '未知'}`);
    }
    if (event.type === 'cancelled') {
      setStatus('已取消');
    }
  }

  if (exitBtn) {
    exitBtn.addEventListener('click', () => { void exit(); });
  }

  if (window.qizi?.onMeetingEvent) {
    window.qizi.onMeetingEvent(handleEvent);
  }

  wireMessageInteractions();

  window.MeetingView = {
    enter,
    exit,
    showView,
    leaveView,
    handleEvent,
    isRunning: () => running,
    isVisible: () => visible,
    isActive: () => visible,
    getConfig: () => (meetingConfig ? { ...meetingConfig } : null),
    getMessages,
    getAvatarSrc: () => MEETING_AVATAR_SRC,
    render,
  };
})();
