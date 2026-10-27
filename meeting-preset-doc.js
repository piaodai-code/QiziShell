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

function buildMeetingPresetMarkdown(preset) {
  const topic = String(preset.topic || '').trim();
  const participants = Array.isArray(preset.participantAgentIds) ? preset.participantAgentIds : [];
  const savedAt = new Date(preset.savedAtMs || Date.now()).toISOString();
  const participantLines = participants.length
    ? participants.map((id) => `  - ${yamlScalar(id)}`).join('\n')
    : '  []';
  const goal = String(preset.goal || '').trim();
  const readingReport = String(preset.readingReport || '').trim();
  const moderatorLabel = String(preset.moderatorLabel || '').trim();
  const moderatorAgentId = String(preset.moderatorAgentId || '').trim();
  const execId = String(preset.postMeetingExecAgentId || '').trim();
  const roundCount = preset.roundCount === 1 || preset.roundCount === 3 ? preset.roundCount : 2;
  return [
    '---',
    `topic: ${yamlScalar(topic)}`,
    `goal: ${yamlScalar(goal)}`,
    `readingReport: ${yamlScalar(readingReport)}`,
    `moderatorAgentId: ${yamlScalar(moderatorAgentId)}`,
    `moderatorLabel: ${yamlScalar(moderatorLabel)}`,
    'participantAgentIds:',
    participantLines,
    `postMeetingExecAgentId: ${yamlScalar(execId)}`,
    `roundCount: ${roundCount}`,
    `noRepeatPastTopics: ${preset.noRepeatPastTopics ? 'true' : 'false'}`,
    `savedAt: ${yamlScalar(savedAt)}`,
    '---',
    '',
    `# ${topic}`,
    '',
    goal ? `期望结论方向：${goal}` : '期望结论方向：',
    readingReport ? `阅读报告：${readingReport}` : '阅读报告：',
    '',
    `- 主持：${moderatorLabel || moderatorAgentId}（${moderatorAgentId}）`,
    `- 议事：${participants.join('、') || '无'}`,
    `- 会后接收：${execId || '无'}`,
    `- 轮次：${roundCount}`,
    `- 不可与近 7 天旧题重复：${preset.noRepeatPastTopics ? '是' : '否'}`,
    '',
    buildMeetingRequirementSections(),
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
    if (!rest && (key === 'participantAgentIds')) {
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
    moderatorAgentId: String(data.moderatorAgentId || '').trim(),
    moderatorLabel: String(data.moderatorLabel || '').trim(),
    participantAgentIds: Array.isArray(data.participantAgentIds)
      ? data.participantAgentIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    postMeetingExecAgentId: String(data.postMeetingExecAgentId || '').trim(),
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

module.exports = {
  PRESET_ID_RE,
  REQUIRED_MEETING_SECTIONS,
  meetingPresetId,
  buildMeetingPresetMarkdown,
  presetFromMarkdown,
  parseMeetingRequirementSections,
};
