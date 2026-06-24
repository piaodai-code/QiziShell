(function initMeetingUI() {
  const modal = document.getElementById('meeting-modal');
  const topicInput = document.getElementById('meeting-topic');
  const draftInput = document.getElementById('meeting-draft');
  const goalInput = document.getElementById('meeting-goal');
  const execAgentSelect = document.getElementById('meeting-exec-agent');
  const moderatorSelect = document.getElementById('meeting-moderator');
  const participantsEl = document.getElementById('meeting-participants');
  const startBtn = document.getElementById('meeting-start-btn');
  const cancelBtn = document.getElementById('meeting-cancel-btn');
  const closeBtn = document.getElementById('meeting-close-btn');
  const savePresetBtn = document.getElementById('meeting-save-preset-btn');
  const deletePresetBtn = document.getElementById('meeting-delete-preset-btn');
  const presetPickerBtn = document.getElementById('meeting-preset-picker-btn');
  const presetMenu = document.getElementById('meeting-preset-menu');
  const toastEl = document.getElementById('meeting-toast');

  if (!modal) return;

  const presetStore = window.MeetingPresetStore;
  let catalogAgents = [];
  let starting = false;
  let toastTimer = null;

  function agentLabel(agent) {
    return agent?.label || agent?.name || agent?.id || 'Agent';
  }

  function fillExecAgentOptions(agents) {
    if (!execAgentSelect) return;
    const previous = execAgentSelect.value;
    execAgentSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '无';
    execAgentSelect.appendChild(noneOpt);
    for (const agent of agents) {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agentLabel(agent);
      execAgentSelect.appendChild(opt);
    }
    if (previous && [...execAgentSelect.options].some((opt) => opt.value === previous)) {
      execAgentSelect.value = previous;
    }
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

  function renderParticipantCheckboxes(agents, selectedIds) {
    if (!participantsEl) return;
    participantsEl.innerHTML = '';
    const moderatorId = moderatorSelect?.value;
    const selected = selectedIds ? new Set(selectedIds) : null;
    for (const agent of agents) {
      if (agent.id === moderatorId) continue;
      const label = document.createElement('label');
      label.className = 'meeting-participant-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'meeting-participant-check';
      cb.value = agent.id;
      cb.checked = selected ? selected.has(agent.id) : true;
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
    const selected = collectParticipants();
    renderParticipantCheckboxes(catalogAgents, selected);
  }

  function applyRoundCount(roundCount) {
    const value = Number(roundCount);
    const target = value === 1 || value === 3 ? value : 2;
    const input = modal.querySelector(`input[name="meeting-rounds"][value="${target}"]`);
    if (input) input.checked = true;
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

  function collectPresetPayload() {
    const topic = topicInput?.value?.trim() || '';
    const goal = goalInput?.value?.trim() || '';
    const postMeetingExecAgentId = execAgentSelect?.value?.trim() || '';
    const moderatorAgentId = moderatorSelect?.value?.trim() || '';
    const participantAgentIds = collectParticipants();
    const roundCount = collectRoundCount();
    const moderator = catalogAgents.find((a) => a.id === moderatorAgentId);
    return {
      topic,
      goal,
      postMeetingExecAgentId,
      moderatorAgentId,
      moderatorLabel: agentLabel(moderator),
      participantAgentIds,
      roundCount,
    };
  }

  function applyPreset(preset) {
    if (!preset) return;
    if (topicInput) topicInput.value = preset.topic || '';
    if (goalInput) goalInput.value = preset.goal || '';
    if (execAgentSelect) {
      const execId = preset.postMeetingExecAgentId || '';
      if ([...execAgentSelect.options].some((opt) => opt.value === execId)) {
        execAgentSelect.value = execId;
      } else {
        execAgentSelect.value = '';
      }
    }
    if (moderatorSelect) {
      const modId = preset.moderatorAgentId || '';
      if ([...moderatorSelect.options].some((opt) => opt.value === modId)) {
        moderatorSelect.value = modId;
      }
    }
    renderParticipantCheckboxes(catalogAgents, preset.participantAgentIds || []);
    applyRoundCount(preset.roundCount);
  }

  function clearForm() {
    if (topicInput) topicInput.value = '';
    if (draftInput) draftInput.value = '';
    if (goalInput) goalInput.value = '';
    if (execAgentSelect) execAgentSelect.value = '';
    if (moderatorSelect && moderatorSelect.options.length) {
      moderatorSelect.selectedIndex = 0;
    }
    applyRoundCount(2);
    syncParticipantsWithModerator();
  }

  function hideToast() {
    if (!toastEl) return;
    toastEl.hidden = true;
    toastEl.textContent = '';
    toastEl.classList.remove('is-ok', 'is-error');
  }

  function showToast(message, kind = 'ok') {
    if (!toastEl) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastEl.textContent = message;
    toastEl.classList.remove('is-ok', 'is-error');
    toastEl.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      hideToast();
      toastTimer = null;
    }, 2400);
  }

  function closePresetMenu() {
    if (!presetMenu || !presetPickerBtn) return;
    presetMenu.hidden = true;
    presetPickerBtn.setAttribute('aria-expanded', 'false');
  }

  function openPresetMenu() {
    if (!presetMenu || !presetPickerBtn) return;
    renderPresetMenu();
    presetMenu.hidden = false;
    presetPickerBtn.setAttribute('aria-expanded', 'true');
  }

  function togglePresetMenu() {
    if (!presetMenu) return;
    if (presetMenu.hidden) openPresetMenu();
    else closePresetMenu();
  }

  function renderPresetMenu() {
    if (!presetMenu || !presetStore) return;
    presetMenu.innerHTML = '';
    const presets = presetStore.listPresets();
    if (!presets.length) {
      const empty = document.createElement('div');
      empty.className = 'meeting-preset-menu-empty';
      empty.textContent = '暂无已保存的会议';
      presetMenu.appendChild(empty);
      return;
    }
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'meeting-preset-option';
      btn.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'meeting-preset-option-title';
      title.textContent = preset.topic;
      const meta = document.createElement('span');
      meta.className = 'meeting-preset-option-meta';
      const roundLabel = presetStore.roundCountLabel(preset.roundCount);
      const modLabel = preset.moderatorLabel || preset.moderatorAgentId || '—';
      meta.textContent = `${roundLabel} · ${modLabel}`;
      btn.appendChild(title);
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        applyPreset(preset);
        closePresetMenu();
      });
      presetMenu.appendChild(btn);
    }
  }

  function savePreset() {
    if (!presetStore) return;
    const payload = collectPresetPayload();
    if (!payload.topic) {
      alert('请填写议题');
      return;
    }
    if (!payload.moderatorAgentId) {
      alert('请选择主持 Agent');
      return;
    }
    if (!payload.participantAgentIds.length) {
      alert('请至少选择一名议事 Agent');
      return;
    }
    if (presetStore.hasPreset(payload.topic)) {
      const ok = confirm(`已存在议题「${payload.topic}」，是否覆盖保存？`);
      if (!ok) return;
    }
    const result = presetStore.savePreset(payload);
    if (!result.ok) {
      alert(result.error || '保存失败');
      return;
    }
    renderPresetMenu();
    showToast('会议已保存');
  }

  function deletePreset() {
    if (!presetStore) return;
    const topic = topicInput?.value?.trim() || '';
    if (!topic) {
      alert('请填写议题');
      return;
    }
    const result = presetStore.removePreset(topic);
    if (!result.ok) {
      alert(result.error || '未找到已保存的会议');
      return;
    }
    renderPresetMenu();
    clearForm();
    showToast('已删除');
  }

  function openSetup(agents, options = {}) {
    catalogAgents = Array.isArray(agents) ? agents : [];
    fillModeratorOptions(catalogAgents);
    fillExecAgentOptions(catalogAgents);
    if (moderatorSelect && !moderatorSelect.dataset.bound) {
      moderatorSelect.addEventListener('change', syncParticipantsWithModerator);
      moderatorSelect.dataset.bound = '1';
    }
    syncParticipantsWithModerator();
    if (options?.draft != null && draftInput) {
      draftInput.value = String(options.draft);
    }
    renderPresetMenu();
    closePresetMenu();
    hideToast();
    modal.hidden = false;
    topicInput?.focus();
  }

  function closeModal() {
    modal.hidden = true;
    starting = false;
    closePresetMenu();
    hideToast();
    if (startBtn) startBtn.disabled = false;
  }

  async function startMeeting() {
    if (!window.qizi?.startMeeting || starting) return;
    const topic = topicInput?.value?.trim();
    const draft = draftInput?.value?.trim();
    const goal = goalInput?.value?.trim() || '';
    const postMeetingExecAgentId = execAgentSelect?.value?.trim() || '';
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
      postMeetingExecAgentId,
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
      if (window.MeetingView?.abortLiveStart) await window.MeetingView.abortLiveStart();
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
  if (savePresetBtn) savePresetBtn.addEventListener('click', savePreset);
  if (deletePresetBtn) deletePresetBtn.addEventListener('click', deletePreset);
  if (presetPickerBtn) presetPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePresetMenu();
  });
  if (presetMenu) {
    presetMenu.addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', () => {
    closePresetMenu();
  });

  window.MeetingUI = { openSetup };
})();
