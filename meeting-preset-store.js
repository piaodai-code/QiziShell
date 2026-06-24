(function initMeetingPresetStore(global) {
  const STORAGE_KEY = 'qizi-meeting-presets-v1';

  function readAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function writeAll(map) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  }

  function normalizeTopic(topic) {
    return String(topic || '').trim();
  }

  function roundCountLabel(roundCount) {
    const n = Number(roundCount);
    if (n === 1) return '一轮';
    if (n === 3) return '三轮';
    return '二轮';
  }

  function normalizePreset(raw) {
    const topic = normalizeTopic(raw?.topic);
    if (!topic) return null;
    const roundCount = Number(raw?.roundCount);
    return {
      topic,
      goal: String(raw?.goal || '').trim(),
      postMeetingExecAgentId: String(raw?.postMeetingExecAgentId || '').trim(),
      moderatorAgentId: String(raw?.moderatorAgentId || '').trim(),
      moderatorLabel: String(raw?.moderatorLabel || '').trim(),
      participantAgentIds: Array.isArray(raw?.participantAgentIds)
        ? raw.participantAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [],
      roundCount: roundCount === 1 || roundCount === 3 ? roundCount : 2,
      savedAtMs: Number(raw?.savedAtMs) || Date.now(),
    };
  }

  function listPresets() {
    const map = readAll();
    return Object.values(map)
      .map((entry) => normalizePreset(entry))
      .filter(Boolean)
      .sort((a, b) => {
        if (b.savedAtMs !== a.savedAtMs) return b.savedAtMs - a.savedAtMs;
        return a.topic.localeCompare(b.topic, 'zh-CN');
      });
  }

  function getPreset(topic) {
    const key = normalizeTopic(topic);
    if (!key) return null;
    return normalizePreset(readAll()[key]);
  }

  function hasPreset(topic) {
    return Boolean(getPreset(topic));
  }

  function savePreset(raw) {
    const preset = normalizePreset(raw);
    if (!preset) return { ok: false, error: '请填写议题' };
    if (!preset.moderatorAgentId) return { ok: false, error: '请选择主持 Agent' };
    if (!preset.participantAgentIds.length) {
      return { ok: false, error: '请至少选择一名议事 Agent' };
    }
    const map = readAll();
    map[preset.topic] = preset;
    writeAll(map);
    return { ok: true, preset };
  }

  function removePreset(topic) {
    const key = normalizeTopic(topic);
    if (!key) return { ok: false, error: '请填写议题' };
    const map = readAll();
    if (!map[key]) return { ok: false, error: '未找到已保存的会议' };
    delete map[key];
    writeAll(map);
    return { ok: true, topic: key };
  }

  global.MeetingPresetStore = {
    listPresets,
    getPreset,
    hasPreset,
    savePreset,
    removePreset,
    roundCountLabel,
  };
}(window));
