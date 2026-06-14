(function initMeetingView() {
  const MEETING_AVATAR_SRC = 'assets/icons/meeting-team.png';
  const HISTORY_LIMIT = 10;
  const LIVE_RECORD_KEY = '__live__';

  const chatScreenEl = document.getElementById('chat-screen');
  const meetingScreenEl = document.getElementById('meeting-screen');
  const messagesEl = document.getElementById('meeting-messages');
  const composerEl = document.getElementById('composer');
  const composerBodyEl = document.getElementById('composer-body');
  const observeBarEl = document.getElementById('meeting-observe-bar');
  const toolbarEl = document.getElementById('meeting-toolbar');
  const historyPickerEl = document.getElementById('meeting-history-picker');
  const historyTriggerEl = document.getElementById('meeting-history-trigger');
  const historyTriggerTextEl = document.getElementById('meeting-history-trigger-text');
  const historyMenuEl = document.getElementById('meeting-history-menu');
  const toolbarStatusEl = document.getElementById('meeting-toolbar-status');
  const newMeetingBtn = document.getElementById('meeting-new-btn');
  const leaveHubBtn = document.getElementById('meeting-leave-hub-btn');
  const endConfirmModal = document.getElementById('meeting-end-confirm-modal');
  const endConfirmYesBtn = document.getElementById('meeting-end-confirm-yes');
  const endConfirmNoBtn = document.getElementById('meeting-end-confirm-no');

  if (!messagesEl) return;

  let running = false;
  let hubVisible = false;
  let viewingLive = false;
  /** @type {Array<object>} */
  let meetingMessages = [];
  /** @type {object|null} */
  let meetingConfig = null;
  /** @type {Map<string, object>} */
  let agentCatalog = new Map();
  let meetingStatus = '';
  /** @type {string|null} */
  let liveMeetingId = null;
  /** @type {string} */
  let selectedRecordKey = '';
  /** @type {Array<object>} */
  let recordList = [];
  let loadingArchive = false;
  /** @type {Array<{ value: string, label: string }>} */
  let historyOptions = [];

  function syncHistoryTriggerLabel() {
    if (!historyTriggerTextEl) return;
    const opt = historyOptions.find((o) => o.value === selectedRecordKey);
    historyTriggerTextEl.textContent = opt?.label || '暂无历史会议';
  }

  function closeHistoryMenu() {
    if (!historyMenuEl || !historyTriggerEl) return;
    historyMenuEl.hidden = true;
    historyTriggerEl.classList.remove('open');
    historyTriggerEl.setAttribute('aria-expanded', 'false');
  }

  function toggleHistoryMenu(forceOpen) {
    if (!historyMenuEl || !historyTriggerEl) return;
    const open = typeof forceOpen === 'boolean' ? forceOpen : historyMenuEl.hidden;
    if (!open) {
      closeHistoryMenu();
      return;
    }
    historyMenuEl.hidden = false;
    historyTriggerEl.classList.add('open');
    historyTriggerEl.setAttribute('aria-expanded', 'true');
  }

  function selectHistoryKey(key) {
    selectedRecordKey = key;
    syncHistoryTriggerLabel();
    if (historyMenuEl) {
      for (const btn of historyMenuEl.querySelectorAll('.meeting-history-item')) {
        btn.classList.toggle('active', btn.dataset.value === key);
      }
    }
    closeHistoryMenu();
    if (key === LIVE_RECORD_KEY && running) {
      viewingLive = true;
      applyMeetingChrome();
      render();
      return;
    }
    void loadArchiveRecord(key);
  }

  function setSelectedHistoryKey(key) {
    selectedRecordKey = key;
    syncHistoryTriggerLabel();
    if (historyMenuEl) {
      for (const btn of historyMenuEl.querySelectorAll('.meeting-history-item')) {
        btn.classList.toggle('active', btn.dataset.value === key);
      }
    }
  }

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

  function formatRecordDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function recordOptionLabel(entry, { live = false } = {}) {
    const topic = String(entry?.topic || '未命名议题').trim();
    const date = formatRecordDate(entry?.startedAt || entry?.finishedAt);
    const prefix = live ? '进行中 · ' : '';
    return date ? `${prefix}${date} · ${topic}` : `${prefix}${topic}`;
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

  function emptyHintText() {
    if (loadingArchive) return '加载会议记录…';
    if (running && viewingLive) return '会议进行中，等待发言…';
    if (recordList.length === 0) return '暂无历史会议，点击「新建会议」开始';
    return '请选择历史会议';
  }

  function render() {
    if (!hubVisible || !messagesEl) return;
    if (meetingMessages.length === 0) {
      messagesEl.innerHTML = `<div class="msg-hint">${escapeHtml(emptyHintText())}</div>`;
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
    if (!toolbarStatusEl) return;
    if (!text) {
      toolbarStatusEl.hidden = true;
      toolbarStatusEl.textContent = '';
      return;
    }
    toolbarStatusEl.hidden = false;
    toolbarStatusEl.textContent = text;
  }

  function buildCatalog(config) {
    agentCatalog = new Map();
    const list = config?.agentCatalog || [];
    for (const agent of list) {
      if (agent?.id) agentCatalog.set(agent.id, agent);
    }
  }

  function buildCatalogFromRecord(record) {
    const catalog = Array.isArray(record?.agentCatalog) ? record.agentCatalog : [];
    if (catalog.length > 0) {
      buildCatalog({ agentCatalog: catalog });
      return;
    }
    const agents = new Map();
    if (record?.moderatorAgentId) {
      agents.set(record.moderatorAgentId, {
        id: record.moderatorAgentId,
        label: record.moderatorLabel || record.moderatorAgentId,
      });
    }
    for (const id of record?.participantAgentIds || []) {
      if (!agents.has(id)) agents.set(id, { id, label: id });
    }
    for (const msg of record?.transcript || []) {
      if (msg?.speakerAgentId && msg?.speakerLabel) {
        agents.set(msg.speakerAgentId, {
          id: msg.speakerAgentId,
          label: msg.speakerLabel,
        });
      }
    }
    buildCatalog({ agentCatalog: [...agents.values()] });
  }

  function configFromRecord(record) {
    return {
      topic: record?.topic || '会议',
      moderatorAgentId: record?.moderatorAgentId,
      moderatorLabel: record?.moderatorLabel,
      participantAgentIds: record?.participantAgentIds || [],
      agentCatalog: record?.agentCatalog || [...agentCatalog.values()],
      meetingId: record?.id,
    };
  }

  function applyTranscript(messages) {
    if (!Array.isArray(messages)) return;
    meetingMessages = messages.map((m) => ({ ...m }));
    if (hubVisible) render();
  }

  function getMessages() {
    return meetingMessages.map((m) => ({ ...m }));
  }

  function populateHistorySelect() {
    if (!historyMenuEl) return;
    const previous = selectedRecordKey;
    historyOptions = [];
    historyMenuEl.innerHTML = '';

    if (running && liveMeetingId && meetingConfig) {
      historyOptions.push({
        value: LIVE_RECORD_KEY,
        label: recordOptionLabel(meetingConfig, { live: true }),
      });
    }

    if (recordList.length === 0 && !running) {
      historyOptions.push({ value: '', label: '暂无历史会议' });
    } else {
      for (const entry of recordList) {
        if (running && entry.id === liveMeetingId) continue;
        historyOptions.push({
          value: entry.file || entry.id || '',
          label: recordOptionLabel(entry),
        });
      }
    }

    for (const opt of historyOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'meeting-history-item';
      btn.setAttribute('role', 'option');
      btn.dataset.value = opt.value;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => selectHistoryKey(opt.value));
      historyMenuEl.appendChild(btn);
    }

    if (running && viewingLive) {
      setSelectedHistoryKey(LIVE_RECORD_KEY);
      return;
    }

    if (previous && historyOptions.some((o) => o.value === previous)) {
      setSelectedHistoryKey(previous);
      return;
    }

    if (running) {
      setSelectedHistoryKey(LIVE_RECORD_KEY);
      return;
    }

    if (historyOptions[0]) {
      setSelectedHistoryKey(historyOptions[0].value);
    }
  }

  async function refreshRecordList() {
    if (!window.qizi?.listMeetingRecords) {
      recordList = [];
      return;
    }
    try {
      const result = await window.qizi.listMeetingRecords();
      recordList = result?.ok && Array.isArray(result.records)
        ? result.records.slice(0, HISTORY_LIMIT)
        : [];
    } catch {
      recordList = [];
    }
  }

  async function loadArchiveRecord(key) {
    if (!key || key === LIVE_RECORD_KEY) {
      if (running) {
        viewingLive = true;
        applyTranscript(meetingMessages);
        setStatus(meetingStatus || '会议进行中…');
        render();
      }
      return;
    }
    if (!window.qizi?.loadMeetingRecord) return;
    loadingArchive = true;
    viewingLive = false;
    render();
    try {
      const payload = key.includes('/') || key.includes('\\')
        ? { file: key }
        : { id: key };
      const result = await window.qizi.loadMeetingRecord(payload);
      if (!result?.ok || !result.record) {
        setStatus(result?.error || '加载失败');
        meetingMessages = [];
        render();
        return;
      }
      buildCatalogFromRecord(result.record);
      meetingConfig = configFromRecord(result.record);
      applyTranscript(result.record.transcript || []);
      setStatus('只读');
    } catch (err) {
      setStatus(err.message || '加载失败');
      meetingMessages = [];
      render();
    } finally {
      loadingArchive = false;
      render();
    }
  }

  async function refreshHistorySelectAndLoadDefault() {
    await refreshRecordList();
    populateHistorySelect();
    if (running) {
      viewingLive = true;
      selectedRecordKey = LIVE_RECORD_KEY;
      setSelectedHistoryKey(LIVE_RECORD_KEY);
      applyMeetingChrome();
      render();
      return;
    }
    const key = selectedRecordKey || historyOptions.find((o) => o.value)?.value;
    if (key) {
      await loadArchiveRecord(key);
    } else {
      meetingMessages = [];
      setStatus('');
      render();
    }
  }

  function applyMeetingChrome() {
    document.body.classList.add('meeting-mode');
    if (toolbarEl) toolbarEl.hidden = false;
    if (composerBodyEl) composerBodyEl.hidden = true;
    if (observeBarEl) observeBarEl.hidden = !(running && viewingLive);
    if (composerEl) composerEl.classList.add('composer--meeting');
    if (newMeetingBtn) newMeetingBtn.disabled = running;
    if (running && viewingLive) {
      setStatus(meetingStatus || '会议进行中…');
    }
  }

  function clearMeetingChrome() {
    document.body.classList.remove('meeting-mode');
    if (toolbarEl) toolbarEl.hidden = true;
    if (composerBodyEl) composerBodyEl.hidden = false;
    if (observeBarEl) observeBarEl.hidden = true;
    if (composerEl) composerEl.classList.remove('composer--meeting');
    setStatus('');
  }

  function showMeetingScreen() {
    if (chatScreenEl) chatScreenEl.hidden = true;
    if (meetingScreenEl) meetingScreenEl.hidden = false;
  }

  function hideMeetingScreen() {
    if (meetingScreenEl) meetingScreenEl.hidden = true;
    if (chatScreenEl) chatScreenEl.hidden = false;
  }

  async function openHub() {
    hubVisible = true;
    if (running) {
      viewingLive = true;
      selectedRecordKey = LIVE_RECORD_KEY;
    }
    showMeetingScreen();
    applyMeetingChrome();
    await refreshHistorySelectAndLoadDefault();
    window.dispatchEvent(new CustomEvent('qizi-meeting-hub-opened', {
      detail: meetingConfig || {},
    }));
    if (running) {
      window.dispatchEvent(new CustomEvent('qizi-meeting-view-shown', { detail: meetingConfig }));
    }
  }

  function leaveHub() {
    if (!hubVisible) return;
    hubVisible = false;
    closeHistoryMenu();
    hideMeetingScreen();
    clearMeetingChrome();
    window.dispatchEvent(new CustomEvent('qizi-meeting-view-hidden'));
  }

  function showEndMeetingConfirm() {
    if (endConfirmModal) endConfirmModal.hidden = false;
  }

  function hideEndMeetingConfirm() {
    if (endConfirmModal) endConfirmModal.hidden = true;
  }

  function requestEndMeeting() {
    if (running) {
      showEndMeetingConfirm();
      return;
    }
    void endMeeting();
  }

  async function endMeeting() {
    hideEndMeetingConfirm();
    if (running) {
      try {
        if (window.qizi?.cancelMeeting) {
          await window.qizi.cancelMeeting();
        }
      } catch {
        // ignore
      }
      running = false;
      viewingLive = false;
      liveMeetingId = null;
      meetingStatus = '';
      selectedRecordKey = '';
      meetingMessages = [];
      meetingConfig = null;
      agentCatalog = new Map();
      if (newMeetingBtn) newMeetingBtn.disabled = false;
      window.dispatchEvent(new CustomEvent('qizi-meeting-exited'));
    }
    leaveHub();
  }

  function showView() {
    if (!running) {
      void openHub();
      return;
    }
    viewingLive = true;
    selectedRecordKey = LIVE_RECORD_KEY;
    setSelectedHistoryKey(LIVE_RECORD_KEY);
    if (!hubVisible) {
      hubVisible = true;
      showMeetingScreen();
    }
    applyMeetingChrome();
    render();
    window.dispatchEvent(new CustomEvent('qizi-meeting-view-shown', { detail: meetingConfig }));
  }

  function leaveView() {
    leaveHub();
  }

  function enter(config) {
    running = true;
    viewingLive = true;
    hubVisible = true;
    liveMeetingId = null;
    meetingConfig = config || {};
    meetingMessages = [];
    meetingStatus = '';
    selectedRecordKey = LIVE_RECORD_KEY;
    buildCatalog(meetingConfig);

    showMeetingScreen();
    applyMeetingChrome();
    setStatus('正在发送任务书…');
    render();

    void refreshRecordList().then(() => populateHistorySelect());

    window.dispatchEvent(new CustomEvent('qizi-meeting-entered', { detail: meetingConfig }));
  }

  async function exit() {
    running = false;
    viewingLive = false;
    hubVisible = false;
    liveMeetingId = null;
    meetingConfig = null;
    meetingMessages = [];
    meetingStatus = '';
    selectedRecordKey = '';
    agentCatalog = new Map();

    clearMeetingChrome();
    hideMeetingScreen();

    if (window.qizi?.exitMeeting) {
      try { await window.qizi.exitMeeting(); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent('qizi-meeting-exited'));
  }

  async function abortLiveStart() {
    running = false;
    viewingLive = false;
    liveMeetingId = null;
    meetingStatus = '';
    selectedRecordKey = '';
    meetingMessages = [];
    if (window.qizi?.exitMeeting) {
      try { await window.qizi.exitMeeting(); } catch { /* ignore */ }
    }
    hubVisible = true;
    applyMeetingChrome();
    await refreshHistorySelectAndLoadDefault();
  }

  async function openNewMeetingSetup() {
    if (!window.MeetingUI?.openSetup) return;
    let agents = [];
    try {
      const result = await window.qizi?.listAgents?.();
      if (result?.ok && Array.isArray(result.agents)) {
        agents = result.agents;
      }
    } catch {
      // ignore
    }
    window.MeetingUI.openSetup(agents);
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
      if (!hubVisible) return;
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

  function handleEvent(event) {
    if (!running || !event) return;

    if (event.type === 'preparing') {
      setStatus('正在准备任务书…');
    }
    if (event.type === 'briefing_ready' && event.payload) {
      liveMeetingId = event.payload.meetingId || liveMeetingId;
      meetingConfig = {
        ...meetingConfig,
        sessionKey: event.payload.sessionKey,
        meetingId: event.payload.meetingId,
        startedAt: meetingConfig?.startedAt || new Date().toISOString(),
      };
      populateHistorySelect();
      setStatus('任务书已发送');
    }
    if (event.type === 'briefing_sending') {
      setStatus('主持 Agent 正在接收任务书…');
    }
    if (event.type === 'transcript') {
      applyTranscript(event.payload?.messages);
      viewingLive = true;
      selectedRecordKey = LIVE_RECORD_KEY;
      setSelectedHistoryKey(LIVE_RECORD_KEY);
      const streaming = meetingMessages.some((m) => m.streaming);
      setStatus(streaming ? '发言中…' : '会议进行中 · 群聊');
      if (observeBarEl) observeBarEl.hidden = false;
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
      const reason = event.payload?.reason;
      if (reason === 'idle_watchdog') {
        setStatus('长时间无发言，已提醒主持继续…');
      } else if (reason === 'idle_force_final') {
        setStatus('长时间无发言，主持正在强制总结…');
      } else {
        setStatus(reason === 'idle' ? '请主持 @ 下一位…' : '请主持继续…');
      }
    }
    if (event.type === 'idle_watchdog' && event.payload) {
      const { strike = 1, maxStrikes = 3 } = event.payload;
      setStatus(`长时间无发言，已提醒主持 (${strike}/${maxStrikes})…`);
    }
    if (event.type === 'idle_watchdog_force_end' && event.payload) {
      setStatus('长时间无发言，正在强制提前总结并结束…');
    }
    if (event.type === 'moderator_nudge_empty') {
      setStatus('主持未返回发言，正在重试…');
    }
    if (event.type === 'moderator_nudge_error' && event.payload) {
      setStatus(`主持发言失败，正在重试：${event.payload.error || '未知'}`);
    }
    if (event.type === 'done') {
      if (event.payload?.messages) {
        applyTranscript(event.payload.messages);
      }
      running = false;
      viewingLive = false;
      liveMeetingId = event.payload?.meetingId || liveMeetingId;
      if (observeBarEl) observeBarEl.hidden = true;
      if (event.payload?.endedEarly || event.payload?.state === 'DONE_EARLY_IDLE') {
        const reason = event.payload?.endReason || '长时间无反馈';
        setStatus(`会议已提前结束 · ${reason}`);
      } else {
        setStatus('会议已结束');
      }
      void refreshHistorySelectAndLoadDefault();
    }
    if (event.type === 'post_meeting_forward' && event.payload) {
      const { ok, label, error } = event.payload;
      if (ok) {
        setStatus(`会议已结束 · 已派活至 ${label || 'Agent'}`);
      } else {
        setStatus(`会议已结束 · 派活失败：${error || '未知错误'}`);
      }
    }
    if (event.type === 'error') {
      setStatus(`错误: ${event.payload?.error || '未知'}`);
    }
    if (event.type === 'cancelled') {
      running = false;
      viewingLive = false;
      liveMeetingId = null;
      meetingStatus = '';
      if (newMeetingBtn) newMeetingBtn.disabled = false;
      if (observeBarEl) observeBarEl.hidden = true;
      setStatus('会议已结束');
    }
  }

  if (historyTriggerEl) {
    historyTriggerEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHistoryMenu();
    });
  }

  document.addEventListener('click', (e) => {
    if (historyMenuEl && !historyMenuEl.hidden) {
      if (!historyPickerEl?.contains(e.target)) closeHistoryMenu();
    }
  });

  if (newMeetingBtn) {
    newMeetingBtn.addEventListener('click', () => { void openNewMeetingSetup(); });
  }

  if (leaveHubBtn) {
    leaveHubBtn.addEventListener('click', () => { requestEndMeeting(); });
  }

  if (endConfirmNoBtn) {
    endConfirmNoBtn.addEventListener('click', () => { hideEndMeetingConfirm(); });
  }

  if (endConfirmYesBtn) {
    endConfirmYesBtn.addEventListener('click', () => { void endMeeting(); });
  }

  if (endConfirmModal) {
    endConfirmModal.addEventListener('click', (e) => {
      if (e.target === endConfirmModal) hideEndMeetingConfirm();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (endConfirmModal && !endConfirmModal.hidden) {
        hideEndMeetingConfirm();
        return;
      }
      if (historyMenuEl && !historyMenuEl.hidden) {
        closeHistoryMenu();
      }
    }
  });

  if (window.qizi?.onMeetingEvent) {
    window.qizi.onMeetingEvent(handleEvent);
  }

  wireMessageInteractions();

  window.MeetingView = {
    enter,
    exit,
    openHub,
    leaveHub,
    endMeeting,
    requestEndMeeting,
    showView,
    leaveView,
    abortLiveStart,
    handleEvent,
    isRunning: () => running,
    isVisible: () => hubVisible,
    isHubVisible: () => hubVisible,
    isActive: () => hubVisible,
    getConfig: () => (meetingConfig ? { ...meetingConfig } : null),
    getMessages,
    getAvatarSrc: () => MEETING_AVATAR_SRC,
    render,
    refreshRecordList,
  };
})();
