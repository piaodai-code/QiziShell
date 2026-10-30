const crypto = require('crypto');
const { buildMeetingRequirementSections } = require('./meeting-protocol');

const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function meetingPresetId(topic) {
  const key = String(topic || '').trim();
  const hex = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  return `m${hex}`;
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function parseYamlScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function yamlList(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '  []';
  return list.map((item) => `  - ${yamlScalar(item)}`).join('\n');
}

function shownOrNone(value) {
  const text = String(value || '').trim();
  return text || '无';
}

function buildMeetingPresetMarkdown(preset) {
  const topic = String(preset.topic || '').trim();
  const participants = Array.isArray(preset.participantAgentIds) ? preset.participantAgentIds : [];
  const participantLabels = participants.map((id, index) => {
    const label = Array.isArray(preset.participantLabels) ? preset.participantLabels[index] : '';
    return String(label || '').trim() || id;
  });
  const savedAt = new Date(preset.savedAtMs || Date.now()).toISOString();
  const goal = String(preset.goal || '').trim();
  const draft = String(preset.draft || '').trim();
  const readingReport = String(preset.readingReport || '').trim();
  const moderatorLabel = String(preset.moderatorLabel || '').trim();
  const moderatorAgentId = String(preset.moderatorAgentId || '').trim();
  const execId = String(preset.postMeetingExecAgentId || '').trim();
  const execLabel = String(preset.postMeetingExecLabel || '').trim();
  const roundCount = preset.roundCount === 1 || preset.roundCount === 3 ? preset.roundCount : 2;
  const roster = participants.length
    ? participants.map((id, index) => {
      const label = participantLabels[index] || id;
      const avoid = label === id ? '' : `，不要写 @${label}`;
      return `  - ${label}（${id}），派发时写 @${id}${avoid}`;
    })
    : ['  - 无'];
  return [
    '---',
    `topic: ${yamlScalar(topic)}`,
    `goal: ${yamlScalar(goal)}`,
    `draft: ${yamlScalar(draft)}`,
    `readingReport: ${yamlScalar(readingReport)}`,
    `moderatorAgentId: ${yamlScalar(moderatorAgentId)}`,
    `moderatorLabel: ${yamlScalar(moderatorLabel)}`,
    'participantAgentIds:',
    yamlList(participants),
    'participantLabels:',
    yamlList(participantLabels),
    `postMeetingExecAgentId: ${yamlScalar(execId)}`,
    `postMeetingExecLabel: ${yamlScalar(execLabel)}`,
    `roundCount: ${roundCount}`,
    `noRepeatPastTopics: ${preset.noRepeatPastTopics ? 'true' : 'false'}`,
    `savedAt: ${yamlScalar(savedAt)}`,
    '---',
    '',
    `# ${topic}`,
    '',
    '## 会议参数',
    '',
    `- 议题：${topic}`,
    `- 期望结论方向：${shownOrNone(goal)}`,
    `- 阅读报告：${shownOrNone(readingReport)}`,
    `- 讨论底稿：${draft ? '见下一节「讨论底稿」全文' : '无'}`,
    `- 主持：${shownOrNone(moderatorLabel)}（${moderatorAgentId}）`,
    '- 议事：',
    ...roster,
    `- 会后接收：${execId ? `${execLabel || execId}（${execId}）` : '无'}`,
    `- 讨论轮次：${roundCount}`,
    `- 不可与近 7 天旧题重复：${preset.noRepeatPastTopics ? '是' : '否'}`,
    '',
    '## 讨论底稿',
    '',
    draft || '无',
    '',
    buildMeetingRequirementSections(readingReport),
    '',
  ].join('\n');
}

function parseFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(markdown || ''));
  if (!match) return null;
  const data = {};
  const lines = match[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const found = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!found) {
      i += 1;
      continue;
    }
    const key = found[1];
    const rest = found[2];
    if (!rest && (key === 'participantAgentIds' || key === 'participantLabels')) {
      const items = [];
      i += 1;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        const item = parseYamlScalar(lines[i].replace(/^\s+-\s+/, ''));
        if (item && item !== '[]') items.push(String(item));
        i += 1;
      }
      data[key] = items;
      continue;
    }
    data[key] = parseYamlScalar(rest);
    i += 1;
  }
  return data;
}

function presetFromMarkdown(markdown, id) {
  const data = parseFrontMatter(markdown);
  if (!data) return null;
  const topic = String(data.topic || '').trim();
  if (!topic) return null;
  const roundCount = Number(data.roundCount);
  const savedAt = String(data.savedAt || '').trim();
  const savedAtMs = Date.parse(savedAt);
  return {
    id: PRESET_ID_RE.test(String(id || '')) ? String(id) : meetingPresetId(topic),
    topic,
    goal: String(data.goal || '').trim(),
    readingReport: String(data.readingReport || '').trim(),
    draft: Object.prototype.hasOwnProperty.call(data, 'draft') ? String(data.draft ?? '') : null,
    moderatorAgentId: String(data.moderatorAgentId || '').trim(),
    moderatorLabel: String(data.moderatorLabel || '').trim(),
    participantAgentIds: Array.isArray(data.participantAgentIds)
      ? data.participantAgentIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    participantLabels: Array.isArray(data.participantLabels)
      ? data.participantLabels.map((item) => String(item || '').trim())
      : [],
    postMeetingExecAgentId: String(data.postMeetingExecAgentId || '').trim(),
    postMeetingExecLabel: String(data.postMeetingExecLabel || '').trim(),
    roundCount: roundCount === 1 || roundCount === 3 ? roundCount : 2,
    noRepeatPastTopics: data.noRepeatPastTopics === true,
    savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : Date.now(),
  };
}

const REQUIRED_MEETING_SECTIONS = [
  '篇幅与收尾',
  '主持启动任务书',
  '主持过程中的要求',
  '当轮总结',
  '最终总结',
  '议事发言要求',
  '往期主题',
];

function parseMeetingRequirementSections(markdown) {
  const source = String(markdown || '');
  if (!source.trim()) {
    return { ok: false, error: '未找到已保存的会议，请先保存再开始' };
  }
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const sections = {};
  for (const chunk of body.split(/\n(?=## )/)) {
    const match = /^## ([^\n]+)\n?([\s\S]*)$/.exec(chunk.trim());
    if (!match) continue;
    const title = match[1].trim();
    const text = match[2].trim();
    if (title) sections[title] = text;
  }
  const missing = REQUIRED_MEETING_SECTIONS.filter((title) => !sections[title]);
  if (missing.length) {
    return { ok: false, error: `会议要求缺少：${missing.join('、')}`, missing };
  }
  return { ok: true, sections };
}

function unsavedMeetingParameters(config, preset) {
  const drifted = [];
  const same = (label, left, right) => {
    if (String(left || '').trim() !== String(right || '').trim()) drifted.push(label);
  };
  same('期望结论方向', config?.goal, preset?.goal);
  same('阅读报告', config?.readingReport, preset?.readingReport);
  same('主持', config?.moderatorAgentId, preset?.moderatorAgentId);
  same('会后接收', config?.postMeetingExecAgentId, preset?.postMeetingExecAgentId);
  const formRounds = Number(config?.roundCount);
  const savedRounds = Number(preset?.roundCount);
  if ((formRounds === 1 || formRounds === 3 ? formRounds : 2) !== savedRounds) drifted.push('讨论轮次');
  if (Boolean(config?.noRepeatPastTopics) !== Boolean(preset?.noRepeatPastTopics)) {
    drifted.push('不可与往日主题重复');
  }
  const formIds = Array.isArray(config?.participantAgentIds)
    ? config.participantAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (formIds.join('\n') !== (preset?.participantAgentIds || []).join('\n')) drifted.push('议事 Agent');
  return drifted;
}

module.exports = {
  PRESET_ID_RE,
  REQUIRED_MEETING_SECTIONS,
  meetingPresetId,
  buildMeetingPresetMarkdown,
  presetFromMarkdown,
  parseMeetingRequirementSections,
  unsavedMeetingParameters,
};
