(function initMeetingPresetStore(global) {
  const STORAGE_KEY = 'qizi-meeting-presets-v1';

  let cache = [];
  let refreshPromise = null;

  function readLocal() {
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
      id: String(raw?.id || '').trim(),
      topic,
      goal: String(raw?.goal || '').trim(),
      draft: raw?.draft == null ? null : String(raw.draft),
      readingReport: String(raw?.readingReport || '').trim(),
      postMeetingExecAgentId: String(raw?.postMeetingExecAgentId || '').trim(),
      postMeetingExecLabel: String(raw?.postMeetingExecLabel || '').trim(),
      moderatorAgentId: String(raw?.moderatorAgentId || '').trim(),
      moderatorLabel: String(raw?.moderatorLabel || '').trim(),
      participantAgentIds: Array.isArray(raw?.participantAgentIds)
        ? raw.participantAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [],
      participantLabels: Array.isArray(raw?.participantLabels)
        ? raw.participantLabels.map((label) => String(label || '').trim())
        : [],
      roundCount: roundCount === 1 || roundCount === 3 ? roundCount : 2,
      noRepeatPastTopics: Boolean(raw?.noRepeatPastTopics),
      savedAtMs: Number(raw?.savedAtMs) || Date.now(),
    };
  }

  function listPresets() {
    return cache
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
    return listPresets().find((entry) => entry.topic === key) || null;
  }

  function hasPreset(topic) {
    return Boolean(getPreset(topic));
  }

  async function migrateLocalPresets(remotePresets) {
    const local = readLocal();
    const topics = Object.keys(local);
    if (!topics.length || !window.qizi?.saveMeetingPreset) return false;
    const remoteTopics = new Set((remotePresets || []).map((entry) => normalizeTopic(entry?.topic)));
    let failed = false;
    for (const topic of topics) {
      if (remoteTopics.has(normalizeTopic(topic))) continue;
      const preset = normalizePreset(local[topic]);
      if (!preset?.moderatorAgentId || !preset.participantAgentIds.length) continue;
      const result = await window.qizi.saveMeetingPreset(preset);
      if (!result?.ok) {
        failed = true;
        break;
      }
    }
    if (!failed) localStorage.removeItem(STORAGE_KEY);
    return !failed && topics.some((topic) => !remoteTopics.has(normalizeTopic(topic)));
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!window.qizi?.listMeetingPresets) {
        return { ok: false, error: '会议保存暂不可用', presets: listPresets() };
      }
      let result = await window.qizi.listMeetingPresets();
      if (!result?.ok) {
        return { ok: false, error: result?.error || '加载失败', presets: listPresets() };
      }
      const migrated = await migrateLocalPresets(result.presets);
      if (migrated) {
        result = await window.qizi.listMeetingPresets();
        if (!result?.ok) {
          return { ok: false, error: result?.error || '加载失败', presets: listPresets() };
        }
      }
      cache = (result.presets || []).map((entry) => normalizePreset(entry)).filter(Boolean);
      return { ok: true, presets: listPresets() };
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function savePreset(raw) {
    const preset = normalizePreset(raw);
    if (!preset) return { ok: false, error: '请填写议题' };
    if (!preset.moderatorAgentId) return { ok: false, error: '请选择主持 Agent' };
    if (!preset.participantAgentIds.length) {
      return { ok: false, error: '请至少选择一名议事 Agent' };
    }
    if (!window.qizi?.saveMeetingPreset) return { ok: false, error: '会议保存暂不可用' };
    const result = await window.qizi.saveMeetingPreset(preset);
    if (!result?.ok) return { ok: false, error: result?.error || '保存失败' };
    const saved = normalizePreset(result.preset || preset);
    cache = cache.filter((entry) => entry.topic !== saved.topic);
    cache.unshift(saved);
    return { ok: true, preset: saved };
  }

  async function removePreset(topic) {
    const key = normalizeTopic(topic);
    if (!key) return { ok: false, error: '请填写议题' };
    const existing = getPreset(key);
    if (!existing) return { ok: false, error: '未找到已保存的会议' };
    if (!window.qizi?.deleteMeetingPreset) return { ok: false, error: '会议保存暂不可用' };
    const result = await window.qizi.deleteMeetingPreset({ id: existing.id, topic: key });
    if (!result?.ok) return { ok: false, error: result?.error || '未找到已保存的会议' };
    cache = cache.filter((entry) => entry.topic !== key);
    return { ok: true, topic: key };
  }

  global.MeetingPresetStore = {
    listPresets,
    getPreset,
    hasPreset,
    refresh,
    savePreset,
    removePreset,
    roundCountLabel,
  };
}(window));
