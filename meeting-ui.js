(function initMeetingUI() {
  const modal = document.getElementById('meeting-modal');
  const topicInput = document.getElementById('meeting-topic');
  const draftInput = document.getElementById('meeting-draft');
  const goalInput = document.getElementById('meeting-goal');
  const moderatorSelect = document.getElementById('meeting-moderator');
  const participantsEl = document.getElementById('meeting-participants');
  const startBtn = document.getElementById('meeting-start-btn');
  const cancelBtn = document.getElementById('meeting-cancel-btn');
  const closeBtn = document.getElementById('meeting-close-btn');

  if (!modal) return;

  let catalogAgents = [];
  let starting = false;

  function agentLabel(agent) {
    return agent?.label || agent?.name || agent?.id || 'Agent';
  }

  function fillModeratorOptions(agents) {
    if (!moderatorSelect) return;
    moderatorSelect.innerHTML = '';
    for (const agent of agents) {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agentLabel(agent);
      moderatorSelect.appendChild(opt);
    }
  }

  function renderParticipantCheckboxes(agents) {
    if (!participantsEl) return;
    participantsEl.innerHTML = '';
    const moderatorId = moderatorSelect?.value;
    for (const agent of agents) {
      if (agent.id === moderatorId) continue;
      const label = document.createElement('label');
      label.className = 'meeting-participant-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'meeting-participant-check';
      cb.value = agent.id;
      cb.checked = true;
      cb.dataset.agentId = agent.id;
      const body = document.createElement('span');
      body.className = 'meeting-participant-body';
      const name = document.createElement('span');
      name.className = 'meeting-participant-name';
      name.textContent = agentLabel(agent);
      const meta = document.createElement('span');
      meta.className = 'meeting-participant-meta';
      meta.textContent = agent.id;
      body.appendChild(name);
      body.appendChild(meta);
      label.appendChild(cb);
      label.appendChild(body);
      participantsEl.appendChild(label);
    }
  }

  function syncParticipantsWithModerator() {
    renderParticipantCheckboxes(catalogAgents);
  }

  function collectRoundCount() {
    const checked = modal?.querySelector('input[name="meeting-rounds"]:checked');
    const value = Number(checked?.value);
    if (value === 1 || value === 2 || value === 3) return value;
    return 2;
  }

  function collectParticipants() {
    const checks = participantsEl?.querySelectorAll('.meeting-participant-check:checked') || [];
    return [...checks].map((cb) => cb.value).filter(Boolean);
  }

  function openSetup(agents, options = {}) {
    catalogAgents = Array.isArray(agents) ? agents : [];
    fillModeratorOptions(catalogAgents);
    if (moderatorSelect && !moderatorSelect.dataset.bound) {
      moderatorSelect.addEventListener('change', syncParticipantsWithModerator);
      moderatorSelect.dataset.bound = '1';
    }
    syncParticipantsWithModerator();
    if (options?.draft != null && draftInput) {
      draftInput.value = String(options.draft);
    }
    modal.hidden = false;
    topicInput?.focus();
  }

  function closeModal() {
    modal.hidden = true;
    starting = false;
    if (startBtn) startBtn.disabled = false;
  }

  async function startMeeting() {
    if (!window.qizi?.startMeeting || starting) return;
    const topic = topicInput?.value?.trim();
    const draft = draftInput?.value?.trim();
    const goal = goalInput?.value?.trim() || '';
    const moderatorAgentId = moderatorSelect?.value;
    const participantAgentIds = collectParticipants();
    const roundCount = collectRoundCount();
    if (!topic) {
      alert('请填写议题');
      return;
    }
    if (!draft) {
      alert('请填写讨论底稿');
      return;
    }
    if (!moderatorAgentId) {
      alert('请选择主持 Agent');
      return;
    }
    if (participantAgentIds.length === 0) {
      alert('请至少选择一名议事 Agent');
      return;
    }
    const moderator = catalogAgents.find((a) => a.id === moderatorAgentId);
    const agentCatalog = catalogAgents.map((a) => ({
      id: a.id,
      label: agentLabel(a),
      name: a.label,
      emoji: a.emoji,
      avatarDataUrl: a.avatarDataUrl,
    }));

    starting = true;
    if (startBtn) startBtn.disabled = true;

    const meetingConfig = {
      topic,
      draft,
      goal,
      moderatorAgentId,
      moderatorLabel: agentLabel(moderator),
      participantAgentIds,
      roundCount,
      agentCatalog,
    };

    closeModal();
    if (window.MeetingView?.enter) {
      window.MeetingView.enter(meetingConfig);
    }

    const result = await window.qizi.startMeeting(meetingConfig);
    if (!result?.ok) {
      starting = false;
      if (startBtn) startBtn.disabled = false;
      if (window.MeetingView?.exit) await window.MeetingView.exit();
      openSetup(catalogAgents);
      alert(result?.error || '无法启动会议');
    } else {
      starting = false;
      if (startBtn) startBtn.disabled = false;
    }
  }

  async function cancelSetup() {
    closeModal();
  }

  if (startBtn) startBtn.addEventListener('click', () => { void startMeeting(); });
  if (cancelBtn) cancelBtn.addEventListener('click', () => { void cancelSetup(); });
  if (closeBtn) closeBtn.addEventListener('click', () => { void cancelSetup(); });
  modal.addEventListener('click', (e) => {
    if (e.target === modal && !starting) closeModal();
  });

  window.MeetingUI = { openSetup };
})();
