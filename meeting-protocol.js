/** 会议隔离 session：agent:<agentId>:a2a:qizi-<meetingId>（不进 main 私聊） */
const MEETING_A2A_NAMESPACE = 'a2a';
const MEETING_ID_PREFIX = 'qizi-';
const MAX_DELIBERANT_CONTENT_CHARS = 500;
const MAX_JSON_RETRIES = 2;
const MEETING_PARTICIPANT_SOFT_CHARS = 450;
const MEETING_PARTICIPANT_HARD_CHARS = 1200;
const MEETING_MODERATOR_SOFT_CHARS = 550;
const MEETING_MODERATOR_HARD_CHARS = 1400;
const MEETING_MODERATOR_SUMMARY_SOFT_CHARS = 900;
const MEETING_MODERATOR_SUMMARY_HARD_CHARS = 2800;
const MEETING_MODERATOR_FINAL_SOFT_CHARS = 1200;
const MEETING_MODERATOR_FINAL_HARD_CHARS = 3800;
/** @deprecated 硬上限别名，供旧引用 */
const MEETING_MODERATOR_MAX_CHARS = MEETING_MODERATOR_HARD_CHARS;
const MEETING_PARTICIPANT_MAX_CHARS = MEETING_PARTICIPANT_HARD_CHARS;
const MEETING_TRANSCRIPT_MSG_CHARS = 500;
const MEETING_TRANSCRIPT_TOTAL_CHARS = 14000;

function normalizeRoundCount(value) {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return 2;
}

function roundCountLabel(roundCount) {
  return ({ 1: '一', 2: '二', 3: '三' })[roundCount] || String(roundCount);
}

function meetingSummaryGuidance(softMax, hardMax, { final = false } = {}) {
  const label = final ? '最终总结' : '当轮总结';
  return [
    `- **${label}篇幅**：建议 ${softMax} 字以内；需涵盖各 Agent 核心观点、共识与分歧；可分段或编号；**必须在本条内收束完整**；`,
    `- 系统硬上限约 ${hardMax} 字（仅超出时在完整句处截断）。`,
  ].join('\n');
}

function moderatorSpeechGuidance(speechKind, softChars, hardChars) {
  if (speechKind === 'round_summary' || speechKind === 'final_summary') {
    return meetingSummaryGuidance(softChars, hardChars, { final: speechKind === 'final_summary' });
  }
  return meetingSpeechGuidance(softChars, hardChars);
}

function participantsSpokenSinceLastModerator(messages, roster, moderatorId) {
  const rosterIds = new Set((roster || []).map((r) => r.agentId));
  if (rosterIds.size === 0) return new Set();

  let lastModIdx = -1;
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.who === 'me' && msg.speakerAgentId === moderatorId && msg.speakerLabel !== '任务书') {
      lastModIdx = i;
      break;
    }
  }

  const spokeSince = new Set();
  for (let i = lastModIdx + 1; i < (messages || []).length; i += 1) {
    const msg = messages[i];
    if (msg.who === 'them' && msg.speakerAgentId && rosterIds.has(msg.speakerAgentId)) {
      spokeSince.add(msg.speakerAgentId);
    }
  }
  return spokeSince;
}

function shouldUseModeratorSummaryLimits(messages, roster, moderatorId) {
  const rosterIds = (roster || []).map((r) => r.agentId).filter(Boolean);
  if (rosterIds.length === 0) return false;
  const spokeSince = participantsSpokenSinceLastModerator(messages, roster, moderatorId);
  return rosterIds.every((id) => spokeSince.has(id));
}

function participantTurnCounts(messages, roster) {
  const rosterIds = new Set((roster || []).map((r) => r.agentId));
  const counts = new Map();
  for (const msg of messages || []) {
    if (msg.who !== 'them' || !msg.speakerAgentId || !rosterIds.has(msg.speakerAgentId)) continue;
    counts.set(msg.speakerAgentId, (counts.get(msg.speakerAgentId) || 0) + 1);
  }
  return counts;
}

function isFinalSummaryExpected(messages, roster, roundCount) {
  const rounds = normalizeRoundCount(roundCount);
  const counts = participantTurnCounts(messages, roster);
  return (roster || []).every((entry) => (counts.get(entry.agentId) || 0) >= rounds);
}

function resolveModeratorSpeechMode(messages, roster, moderatorId, roundCount) {
  if (!shouldUseModeratorSummaryLimits(messages, roster, moderatorId)) {
    return {
      kind: 'dispatch',
      softChars: MEETING_MODERATOR_SOFT_CHARS,
      hardChars: MEETING_MODERATOR_HARD_CHARS,
    };
  }
  if (isFinalSummaryExpected(messages, roster, roundCount)) {
    return {
      kind: 'final_summary',
      softChars: MEETING_MODERATOR_FINAL_SOFT_CHARS,
      hardChars: MEETING_MODERATOR_FINAL_HARD_CHARS,
    };
  }
  return {
    kind: 'round_summary',
    softChars: MEETING_MODERATOR_SUMMARY_SOFT_CHARS,
    hardChars: MEETING_MODERATOR_SUMMARY_HARD_CHARS,
  };
}

function capModeratorSpeech(text, messages, roster, moderatorId, roundCount) {
  const mode = resolveModeratorSpeechMode(messages, roster, moderatorId, roundCount);
  return capMeetingSpeech(text, mode.hardChars);
}

function meetingSpeechGuidance(softMax, hardMax) {
  return [
    `- **篇幅**：建议 ${softMax} 字以内；用 **编号要点**（最多 5 条，每条 1–2 句）表述；**必须在本条发言内说完整**，禁止写到一半戛然而止；`,
    `- 系统硬上限约 ${hardMax} 字（仅超出时在完整句处截断，请尽量控制在建议篇幅内）。`,
  ].join('\n');
}

function capMeetingSpeech(text, hardMax) {
  const t = String(text || '').trim();
  const limit = Number(hardMax);
  if (!limit || t.length <= limit) return t;

  const minCut = Math.floor(limit * 0.65);
  const boundaryChars = new Set(['。', '！', '？', '!', '?', '…', '\n', '；']);

  for (let i = Math.min(limit, t.length) - 1; i >= minCut; i -= 1) {
    if (boundaryChars.has(t[i])) {
      const trimmed = t.slice(0, i + 1).trim();
      if (trimmed.length >= minCut) {
        return `${trimmed}\n\n（篇幅超限，已在完整句处截断）`;
      }
    }
  }

  for (let i = Math.min(limit, t.length) - 1; i >= minCut; i -= 1) {
    if (/\s/.test(t[i])) {
      const trimmed = t.slice(0, i).trim();
      if (trimmed.length >= minCut) {
        return `${trimmed}\n\n（篇幅超限，已在完整句处截断）`;
      }
    }
  }

  return `${t.slice(0, limit).trim()}\n\n（篇幅超限，已截断）`;
}

/** @deprecated 使用 capMeetingSpeech */
function truncateMeetingSpeech(text, maxChars) {
  return capMeetingSpeech(text, maxChars);
}

function computeMaxRelayTurns(config) {
  const rounds = normalizeRoundCount(config?.roundCount);
  const participants = Array.isArray(config?.participantAgentIds)
    ? config.participantAgentIds.length
    : 4;
  return Math.max(120, rounds * participants * 14 + 40);
}

function resolveRosterLabel(roster, agentId) {
  if (!agentId) return 'Agent';
  const entry = (roster || []).find((r) => r.agentId === agentId);
  return entry?.label || agentId;
}

function resolveLastParticipantLabel(roster, messages) {
  const agentId = getLastParticipantAgentId(messages);
  if (!agentId) return '';
  return `${resolveRosterLabel(roster, agentId)} (@${agentId})`;
}

const MEETING_STATES = {
  IDLE: 'IDLE',
  INIT: 'INIT',
  ROUND_1_DISPATCH: 'ROUND_1_DISPATCH',
  ROUND_1_SUMMARY: 'ROUND_1_SUMMARY',
  ROUND_1_FEEDBACK: 'ROUND_1_FEEDBACK',
  ROUND_2_DISPATCH: 'ROUND_2_DISPATCH',
  ROUND_2_SUMMARY: 'ROUND_2_SUMMARY',
  ROUND_2_FEEDBACK: 'ROUND_2_FEEDBACK',
  ROUND_3_DISPATCH: 'ROUND_3_DISPATCH',
  ROUND_3_SUMMARY: 'ROUND_3_SUMMARY',
  DISPATCH_EXEC: 'DISPATCH_EXEC',
  DONE: 'DONE',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
};

function buildMeetingSessionKey(agentId, meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) throw new Error('缺少 meetingId');
  if (!agentId) throw new Error('缺少 agentId');
  return `agent:${agentId}:${MEETING_A2A_NAMESPACE}:${MEETING_ID_PREFIX}${id}`;
}

function isMeetingA2ASessionKey(sessionKey) {
  return typeof sessionKey === 'string'
    && sessionKey.includes(`:${MEETING_A2A_NAMESPACE}:${MEETING_ID_PREFIX}`);
}

/** @deprecated use isMeetingA2ASessionKey */
function isMeetingGroupSessionKey(sessionKey) {
  return isMeetingA2ASessionKey(sessionKey);
}

function parseMeetingMentions(text, roster, moderatorAgentId) {
  const raw = String(text || '');
  const results = [];
  const seen = new Set();
  const byId = new Map();
  for (const entry of roster || []) {
    byId.set(entry.agentId, entry);
  }

  // 只认 agentId：@mo_bao；纯中文 @墨宝 不会 relay
  // 兼容 @墨宝（mo_bao）——从括号里提取 agentId
  const patterns = [
    /@([a-zA-Z0-9_-]+)/g,
    /@[^\s@，。！？；：、]*[（(]([a-zA-Z0-9_-]+)[）)]/g,
  ];

  for (const regex of patterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      const agentId = match[1].trim();
      if (!agentId || agentId === moderatorAgentId) continue;
      const entry = byId.get(agentId);
      if (!entry || seen.has(entry.agentId)) continue;
      seen.add(entry.agentId);
      results.push({
        agentId: entry.agentId,
        label: entry.label || entry.agentId,
        instruction: raw.trim(),
      });
    }
  }
  return results;
}

function buildParticipantGroupPrompt({
  topic,
  draft,
  agentId,
  agentLabel,
  instruction,
  transcript,
  groupSessionKey,
  softChars = MEETING_PARTICIPANT_SOFT_CHARS,
  hardChars = MEETING_PARTICIPANT_HARD_CHARS,
}) {
  return [
    '【QiziShell 会议 · 你的发言轮次】',
    '',
    '你正在一场 **会议群聊** 中发言（由 QiziShell 展示给老大）。硬约束：',
    '- 按照你在 IDENTITY.md 中定义的身份与职责角度发表意见；',
    meetingSpeechGuidance(softChars, hardChars),
    '- 你的回复会出现在 **会议群聊界面**，不要尝试 sessions_send 或私聊其他 Agent；',
    '- **不要**在发言末尾 @ 下一位 Agent——由主持 Agent 统一派发，你只需完成自己的论述；',
    '- 只发表一次性完整意见，不要代笔其他 Agent；',
    '- 不要输出 JSON，用自然语言直接发言。',
    '',
    `本次会议隔离 session：\`${groupSessionKey}\`（不是你的 main 私聊）`,
    `你的 agentId：\`${agentId}\`（${agentLabel}）`,
    '',
    `## 议题\n${topic.trim()}`,
    '',
    '## 讨论底稿',
    draft.trim(),
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
    '',
    '## 本轮对你的要求',
    instruction.trim(),
    '',
    '请直接输出你在群里的发言正文：',
  ].join('\n');
}

function getLastParticipantAgentId(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.streaming) continue;
    if (msg.who === 'them' && msg.speakerAgentId) {
      return msg.speakerAgentId;
    }
  }
  return null;
}

/** 按议事名单顺序，建议下一位（刚发完言者的下一名） */
function getSuggestedNextParticipant(roster, lastParticipantAgentId) {
  if (!Array.isArray(roster) || roster.length === 0) return null;
  if (!lastParticipantAgentId) return roster[0];
  const ids = roster.map((r) => r.agentId);
  const idx = ids.indexOf(lastParticipantAgentId);
  if (idx < 0) return roster[0];
  return roster[(idx + 1) % roster.length];
}

/** 主持在纠正/自省时误写的 @，不应触发 relay */
function isCorrectionMention(text, agentId) {
  const raw = String(text || '');
  if (!raw.includes(`@${agentId}`)) return false;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(`@${agentId}`)) continue;
    if (/(不对|又错了|误派|纠正|重新派|错了|误触|抱歉|对不起|我不该|连发.*错|不是.*@|真正的派发|只发\s*@)/.test(line)) {
      return true;
    }
    if (new RegExp(`@${agentId}[^\\n]{0,48}(→|->|应为|应该是|换成)`, 'i').test(line)) {
      return true;
    }
  }
  return false;
}

function shouldSkipRelayMention(text, agentId, messages, moderatorAgentId) {
  if (!agentId || agentId === moderatorAgentId) return true;
  const lastParticipant = getLastParticipantAgentId(messages);
  if (lastParticipant === agentId) return true;
  if (isCorrectionMention(text, agentId)) return true;
  return false;
}

/** 一条主持发言里可能有多个 @（列名单）；取正文中第一个有效 @（按出现顺序，不是名单排序） */
function pickRelayMention(text, mentions, messages, roster, moderatorAgentId) {
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  for (const mention of mentions) {
    if (shouldSkipRelayMention(text, mention.agentId, messages, moderatorAgentId)) continue;
    return mention;
  }
  return null;
}

function markModeratorMessageMentionsProcessed(messageIndex, text, roster, moderatorAgentId, processed) {
  const mentions = parseMeetingMentions(text, roster, moderatorAgentId);
  for (const mention of mentions) {
    processed.add(`${messageIndex}:${mention.agentId}`);
  }
}

function buildModeratorDispatchHint(roster, messages) {
  const lastId = getLastParticipantAgentId(messages);
  const lastEntry = roster.find((r) => r.agentId === lastId);
  const next = getSuggestedNextParticipant(roster, lastId);
  const parts = [];
  if (lastEntry) {
    parts.push(`上一位刚发完言：${lastEntry.label} (@${lastEntry.agentId})——**请勿再次 @ 同一人**（纠正错误时也勿写 @，用纯文字 agentId 即可）`);
  }
  if (next) {
    parts.push(`按名单顺序建议下一位：${next.label} (@${next.agentId})`);
  }
  return parts.join('\n');
}

function buildModeratorContinuePrompt({
  transcript,
  lastSpeakerLabel,
  roster,
  spokenAgentIds = [],
  messages = [],
  roundCount = 2,
  speechKind = 'dispatch',
  softChars = MEETING_MODERATOR_SOFT_CHARS,
  hardChars = MEETING_MODERATOR_HARD_CHARS,
} = {}) {
  const spoken = new Set(spokenAgentIds);
  const remaining = (roster || []).filter((entry) => !spoken.has(entry.agentId));
  const dispatchHint = buildModeratorDispatchHint(roster, messages);
  const lastFromTranscript = resolveLastParticipantLabel(roster, messages);
  const lastLabel = lastFromTranscript || lastSpeakerLabel;
  const rounds = normalizeRoundCount(roundCount);
  const roundWord = roundCountLabel(rounds);
  const summaryHint = speechKind === 'final_summary'
    ? '- 本轮为 **最终总结**：写「会议结束」，**不要 @ 任何人**；'
    : (speechKind === 'round_summary'
      ? '- 本轮所有人已发言完毕：请作 **当轮完整总结**，然后 @ 名单第一位开始下一轮反馈；'
      : '- 若本轮按名单尚未派完，请 @ **下一位** 议事 Agent（**必须**用 agentId，如 @nai_pang；@墨宝 无效）；');
  return [
    '[系统 · QiziShell]',
    lastLabel
      ? `上一位议事 Agent（${lastLabel}）已在群聊中发言完毕。`
      : '上一位议事 Agent 已在群聊中发言完毕。',
    '（以上依据当前群聊记录最后一条议事 Agent 发言判定。）',
    '请继续主持会议。硬约束：',
    moderatorSpeechGuidance(speechKind, softChars, hardChars),
    '- **每条发言只 @ 一位** agentId；QiziShell 会对每个 @agentId 自动 relay——纠正派发时**不要**写 @（写 nai_pang 等纯文字即可）；',
    summaryHint,
    speechKind === 'dispatch'
      ? '- 若本轮所有人已各发言一次，请作当轮完整总结，然后 @ 名单第一位开始下一轮反馈；'
      : '',
    `- 共 ${rounds} 轮（${roundWord}轮制）；**${rounds} 轮全部结束后**作最终总结并写「会议结束」，**不要 @ 任何人**；`,
    '一次只 @ 一位 Agent。',
    dispatchHint ? `\n${dispatchHint}` : '',
    remaining.length
      ? `\n（历史统计）尚未在任何轮次发言过：${remaining.map((r) => `${r.label} (@${r.agentId})`).join('、')}`
      : '\n（历史统计）所有议事 Agent 至少发言过一次——新反馈轮请按名单顺序重新 @。',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
  ].filter(Boolean).join('\n');
}

function buildModeratorIdlePrompt({
  transcript,
  roster,
  spokenAgentIds = [],
  messages = [],
  roundCount = 2,
  speechKind = 'dispatch',
  softChars = MEETING_MODERATOR_SOFT_CHARS,
  hardChars = MEETING_MODERATOR_HARD_CHARS,
} = {}) {
  const spoken = new Set(spokenAgentIds);
  const remaining = (roster || []).filter((entry) => !spoken.has(entry.agentId));
  const dispatchHint = buildModeratorDispatchHint(roster, messages);
  const next = getSuggestedNextParticipant(roster, getLastParticipantAgentId(messages));
  const rounds = normalizeRoundCount(roundCount);
  const actionHint = speechKind === 'final_summary'
    ? '请作 **最终总结** 并写「会议结束」，**不要 @ 任何人**。'
    : (speechKind === 'round_summary'
      ? '请作 **当轮完整总结**，然后 @ 名单第一位开始下一轮反馈。'
      : (next
        ? `建议现在 @：@${next.agentId}（${next.label}）`
        : (remaining.length
          ? `建议 @ 以下议事 Agent 之一：${remaining.map((r) => `@${r.agentId}（${r.label}）`).join('、')}`
          : '请 @ 下一位议事 Agent 或作本轮总结。')));
  return [
    '[系统 · QiziShell]',
    '你的上一条发言里没有可被 relay 识别的 @（**必须**写 @agentId，例如 @mo_bao）。',
    moderatorSpeechGuidance(speechKind, softChars, hardChars),
    actionHint,
    `本次会议共 ${rounds} 轮；全部结束后写「会议结束」且不要 @ 任何人。`,
    '一次只 @ 一位 Agent；纠正错误时正文里不要写 @。',
    dispatchHint ? `\n${dispatchHint}` : '',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
  ].filter(Boolean).join('\n');
}

function isMeetingCompleteText(text) {
  return isMeetingClosingMessage(text);
}

/** 主持收尾/派活完成 → relay 必须立即停止（不再 @ 触发议事发言） */
function isMeetingClosingMessage(text, roundCount = 3) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/会议结束|派活完毕|今日讨论结论|按此结论执行|讨论圆满结束|任务已派发|会议收尾/i.test(t)) {
    return true;
  }
  if (/最终总结/i.test(t) && /派活|派给|执行|@/i.test(t)) {
    return true;
  }
  const rounds = normalizeRoundCount(roundCount);
  if (new RegExp(`${rounds}\\s*轮.*(结束|完成|完毕)|第\\s*${rounds}\\s*轮.*(结束|完成|完毕)`, 'i').test(t)) {
    return true;
  }
  if (/三轮.*(结束|完成|完毕)/i.test(t) && rounds >= 3) {
    return true;
  }
  if (/派活给\s*@|派给\s*@|执行人.*@/i.test(t)) {
    return true;
  }
  return false;
}

function hasUnprocessedModeratorMentions(messages, roster, processed, moderatorAgentId) {
  if (!Array.isArray(messages)) return false;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.streaming) continue;
    if (msg.speakerLabel === '任务书') continue;
    if (msg.speakerAgentId !== moderatorAgentId) continue;
    const text = msg?.text || '';
    if (!text.trim()) continue;
    const mentions = parseMeetingMentions(text, roster, moderatorAgentId);
    for (const mention of mentions) {
      if (!processed.has(`${i}:${mention.agentId}`)) return true;
    }
  }
  return false;
}

/** 主持收尾：有关键词且不再 @ 议事 Agent（@ 表示派发，不是结束） */
function isModeratorClosingMessage(text, roster, moderatorAgentId, roundCount = 3) {
  if (!isMeetingClosingMessage(text, roundCount)) return false;
  const mentions = parseMeetingMentions(text, roster, moderatorAgentId);
  if (mentions.length > 0) return false;
  return true;
}

function hasClosingModeratorMessage(messages, moderatorAgentId, roster = [], processed = new Set(), roundCount = 3) {
  if (!Array.isArray(messages)) return false;
  if (hasUnprocessedModeratorMentions(messages, roster, processed, moderatorAgentId)) {
    return false;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.speakerLabel === '任务书') continue;
    if (msg.speakerAgentId !== moderatorAgentId) continue;
    if (isModeratorClosingMessage(msg.text, roster, moderatorAgentId, roundCount)) return true;
  }
  return false;
}

function extractJsonFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const direct = tryParseJson(text);
  if (direct) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed) return parsed;
  }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) {
    return tryParseJson(brace[0]);
  }
  return null;
}

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function validateDeliberantOutput(parsed, expectedRole) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '回复必须是 JSON 对象' };
  }
  if (typeof parsed.role !== 'string' || !parsed.role.trim()) {
    return { ok: false, error: '缺少 role 字段' };
  }
  if (expectedRole && parsed.role.trim() !== expectedRole) {
    return { ok: false, error: `role 必须为 ${expectedRole}` };
  }
  if (typeof parsed.perspective_check !== 'string' || !parsed.perspective_check.trim()) {
    return { ok: false, error: 'perspective_check 不能为空' };
  }
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    return { ok: false, error: 'content 不能为空' };
  }
  if (parsed.content.trim().length > MAX_DELIBERANT_CONTENT_CHARS) {
    return { ok: false, error: `content 超过 ${MAX_DELIBERANT_CONTENT_CHARS} 字` };
  }
  if (!Array.isArray(parsed.out_of_scope_intent) || parsed.out_of_scope_intent.length === 0) {
    return { ok: false, error: 'out_of_scope_intent 必须为非空数组' };
  }
  return { ok: true, data: parsed };
}

function validateModeratorSummary(parsed, { round, finalRound = false } = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '主持总结必须是 JSON 对象' };
  }
  if (parsed.type !== 'round_summary') {
    return { ok: false, error: 'type 必须为 round_summary' };
  }
  if (Number(parsed.round) !== Number(round)) {
    return { ok: false, error: `round 必须为 ${round}` };
  }
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    return { ok: false, error: 'summary 不能为空' };
  }
  if (finalRound && (!parsed.assignee || typeof parsed.assignee !== 'string' || !parsed.assignee.trim())) {
    return { ok: false, error: '最终总结必须包含 assignee' };
  }
  return { ok: true, data: parsed };
}

function buildModeratorBriefingMessage({
  topic,
  draft,
  goal,
  moderator,
  participants,
  roundCount = 2,
}) {
  const rounds = normalizeRoundCount(roundCount);
  const roundWord = roundCountLabel(rounds);
  const roster = participants.map((p) => {
    const id = p.agentId;
    const label = p.label || id;
    return `- ${label} → 派发时写 **@${id}**（不要写 @${label}）`;
  }).join('\n');

  return [
    '【QiziShell 会议模式 · 启动任务书】',
    '',
    '你现在是本次会议 **主持 Agent**。硬约束：',
    '- 你只负责主持：派发（@ 指定议事 Agent 发言）、轮次总结、最终收尾与派活；',
    '- **不要**发表你自己的议事观点，也不要替其他 Agent 代笔；',
    `- **篇幅**：派发/开场建议 ${MEETING_MODERATOR_SOFT_CHARS} 字内；**当轮总结**建议 ${MEETING_MODERATOR_SUMMARY_SOFT_CHARS} 字内；**最终总结**建议 ${MEETING_MODERATOR_FINAL_SOFT_CHARS} 字内；议事建议 ${MEETING_PARTICIPANT_SOFT_CHARS} 字内；硬上限约 ${MEETING_MODERATOR_HARD_CHARS}/${MEETING_MODERATOR_SUMMARY_HARD_CHARS}/${MEETING_MODERATOR_FINAL_HARD_CHARS}/${MEETING_PARTICIPANT_HARD_CHARS} 字；`,
    '- 议事 Agent 之间 **互不可见** 彼此原文，只能看到你整理后的轮次总结；',
    `- 按 **${rounds} 轮** 议程推进（${roundWord}轮制，最多 ${rounds} 轮总结后结束）；每轮：依次 @ 各议事 Agent 各发言一次 → 你作当轮完整总结 → 将总结发给各 Agent 再论；**全部结束后作最终总结并写「会议结束」，不要 @ 任何人**；`,
    '- **派发语法（硬约束）**：只认 @agentId，例如 @mo_bao；**@墨宝 等中文名不会被 relay**；一次只 @ 一人；',
    '- **纠正派发错误时**：正文里**不要**写 @agentId（用纯文字 nai_pang 即可），否则 QiziShell 仍会 relay；',
    '- **禁止**调用 sessions_send / sessions_spawn，**禁止**向任何 Agent 的 main 私聊发消息；只需在发言里 @，QiziShell 会 relay；',
    '- **派发时务必提醒**：请对方「按照你在 IDENTITY.md 中定义的身份与职责角度」对议题发表一次性完整意见。',
    '',
    '---',
    `## 议题\n${topic.trim()}`,
    '',
    '## 讨论底稿（原始素材）',
    draft.trim(),
    goal ? `\n## 期望结论方向\n${goal.trim()}` : '',
    '',
    '## 议事 Agent 名单（已确认参与）',
    roster,
    '',
    `## 你的身份`,
    `主持：${moderator.label || moderator.agentId} (\`${moderator.agentId}\`) — 仅主持，不参与议事。`,
    '',
    '---',
    '请阅读以上任务书后：',
    '1. 用简短开场向「老大」宣布议题与参与名单；',
    '2. 立即开始 **第 1 轮**：按名单顺序 @ 第一位议事 Agent 的 agentId（如 @mo_bao），要求其 **按 IDENTITY.md 身份** 基于底稿作一次性完整论述；',
    `3. 按议程推进，直到 ${rounds} 轮结束或达成结论。`,
    '',
    '（本消息由 QiziShell 代老大发送；老大当前仅观察，不插话。）',
  ].filter(Boolean).join('\n');
}

function buildModeratorInitPrompt({ topic, goal, deliberants, moderatorLabel }) {
  const roster = deliberants.map((d) => `- ${d.agentLabel || d.agentId}（身份: ${d.roleLabel || d.role}）`).join('\n');
  return [
    '【QiziShell 会议模式 · 主持任务】',
    '你是本次会议主持。硬约束：不发表个人意见；只做派发、总结、收尾。',
    '',
    `议题：${topic}`,
    goal ? `期望结论方向：${goal}` : '',
    '',
    '参与议事 Agent：',
    roster,
    '',
    '请用 JSON 回复（不要 markdown 包裹以外的多余文字）：',
    '{',
    '  "type": "meeting_open",',
    '  "topic": "...重复议题...",',
    '  "roster": ["agentId:roleLabel", ...],',
    '  "opening": "向老大宣布议题与身份分配（简短）"',
    '}',
  ].filter(Boolean).join('\n');
}

function buildModeratorDispatchPrompt({
  round,
  phase,
  topic,
  target,
  deliberants,
  summaries = {},
}) {
  const roster = deliberants.map((d) => `${d.agentLabel || d.agentId}(${d.roleLabel || d.role})`).join('、');
  return [
    '【QiziShell 会议模式 · 主持派发】',
    `第 ${round} 轮 · ${phase === 'feedback' ? '反馈再论' : '首轮论述'}阶段`,
    `议题：${topic}`,
    `议事成员：${roster}`,
    '',
    `请指定 ${target.agentLabel || target.agentId}（身份: ${target.roleLabel || target.role}）发言。`,
    '输出 JSON：',
    '{',
    '  "type": "dispatch",',
    `  "round": ${round},`,
    `  "phase": "${phase}",`,
    `  "target_agent_id": "${target.agentId}",`,
    `  "target_role": "${target.role}",`,
    '  "instruction": "给该 agent 的派发说明（强调其身份，禁止越界）"',
    summaries.round_1_summary ? `\n已有第1轮总结（仅供你参考，勿全文转发给议事者原文）：\n${summaries.round_1_summary}` : '',
    summaries.round_2_summary ? `\n已有第2轮总结：\n${summaries.round_2_summary}` : '',
  ].filter(Boolean).join('\n');
}

function buildDeliberantPrompt({
  round,
  phase,
  topic,
  role,
  roleLabel,
  instruction,
  context = {},
}) {
  const ctxLines = [];
  if (context.round_1_summary) ctxLines.push(`第1轮主持总结：\n${context.round_1_summary}`);
  if (context.round_2_summary) ctxLines.push(`第2轮主持总结：\n${context.round_2_summary}`);
  return [
    '【QiziShell 会议模式 · 议事发言】',
    '硬约束：只从自身身份视角发言一次；不得评论其他 agent；不得看到其他 agent 原文。',
    '',
    `议题：${topic}`,
    `你的身份(role)：${role}`,
    `身份说明：${roleLabel || role}`,
    `轮次：第 ${round} 轮 · ${phase === 'feedback' ? '反馈再论' : '论述'}`,
    '',
    instruction ? `主持指令：${instruction}` : '',
    ctxLines.length ? `\n【你可见的上下文（仅主持总结）】\n${ctxLines.join('\n\n')}` : '',
    '',
    '请严格输出 JSON（不要其他文字）：',
    '{',
    `  "role": "${role}",`,
    '  "perspective_check": "本次发言我严格在以下范围内:...",',
    '  "content": "完整论述（500字内）",',
    '  "out_of_scope_intent": ["我注意到X,但故意不展开,因为不在我身份内"]',
    '}',
  ].filter(Boolean).join('\n');
}

function buildModeratorRoundSummaryPrompt({
  round,
  topic,
  speeches,
  finalRound = false,
}) {
  const body = speeches.map((s) => (
    `[${s.agentLabel || s.agentId} / ${s.role}]\n${s.content}`
  )).join('\n\n');
  return [
    '【QiziShell 会议模式 · 主持总结】',
    `请整合第 ${round} 轮发言，提取共识与分歧。${finalRound ? '这是最终总结，必须指定 assignee（agentId）。' : ''}`,
    `议题：${topic}`,
    '',
    '本轮发言（仅主持可见原文）：',
    body,
    '',
    '输出 JSON：',
    '{',
    '  "type": "round_summary",',
    `  "round": ${round},`,
    '  "summary": "完整总结",',
    '  "consensus": "共识点",',
    '  "disagreements": "分歧点",',
    finalRound ? '  "assignee": "agentId",' : '',
    finalRound ? '  "conclusion": "最终结论",' : '',
    '}',
  ].filter(Boolean).join('\n');
}

function buildExecDispatchPrompt({ topic, summary, assigneeLabel, assigneeId }) {
  return [
    '【QiziShell 会议模式 · 执行派活】',
    `议题：${topic}`,
    `你被指定为执行人（${assigneeLabel || assigneeId}）。`,
    '',
    '会议最终总结：',
    summary,
    '',
    '请确认接收并开始执行。输出 JSON：',
    '{',
    '  "type": "exec_ack",',
    `  "assignee": "${assigneeId}",`,
    '  "ack": "确认接收",',
    '  "plan": "执行计划（简短）"',
    '}',
  ].join('\n');
}

function buildDeliberantRetryPrompt(reason) {
  return `上次回复不符合会议协议：${reason}。请仅输出符合规范的 JSON，不要其他文字。`;
}

module.exports = {
  MEETING_A2A_NAMESPACE,
  MEETING_ID_PREFIX,
  MEETING_STATES,
  MAX_JSON_RETRIES,
  MEETING_PARTICIPANT_SOFT_CHARS,
  MEETING_PARTICIPANT_HARD_CHARS,
  MEETING_MODERATOR_SOFT_CHARS,
  MEETING_MODERATOR_HARD_CHARS,
  MEETING_MODERATOR_SUMMARY_SOFT_CHARS,
  MEETING_MODERATOR_SUMMARY_HARD_CHARS,
  MEETING_MODERATOR_FINAL_SOFT_CHARS,
  MEETING_MODERATOR_FINAL_HARD_CHARS,
  MEETING_MODERATOR_MAX_CHARS,
  MEETING_PARTICIPANT_MAX_CHARS,
  MEETING_TRANSCRIPT_MSG_CHARS,
  MEETING_TRANSCRIPT_TOTAL_CHARS,
  normalizeRoundCount,
  roundCountLabel,
  meetingSpeechGuidance,
  meetingSummaryGuidance,
  moderatorSpeechGuidance,
  resolveModeratorSpeechMode,
  capModeratorSpeech,
  capMeetingSpeech,
  truncateMeetingSpeech,
  computeMaxRelayTurns,
  resolveRosterLabel,
  resolveLastParticipantLabel,
  buildMeetingSessionKey,
  isMeetingA2ASessionKey,
  isMeetingGroupSessionKey,
  parseMeetingMentions,
  getLastParticipantAgentId,
  getSuggestedNextParticipant,
  isCorrectionMention,
  shouldSkipRelayMention,
  pickRelayMention,
  markModeratorMessageMentionsProcessed,
  buildParticipantGroupPrompt,
  buildModeratorContinuePrompt,
  buildModeratorIdlePrompt,
  isMeetingCompleteText,
  isMeetingClosingMessage,
  isModeratorClosingMessage,
  hasUnprocessedModeratorMentions,
  hasClosingModeratorMessage,
  buildModeratorBriefingMessage,
  extractJsonFromText,
  validateDeliberantOutput,
  validateModeratorSummary,
  buildModeratorInitPrompt,
  buildModeratorDispatchPrompt,
  buildDeliberantPrompt,
  buildModeratorRoundSummaryPrompt,
  buildExecDispatchPrompt,
  buildDeliberantRetryPrompt,
};
