/** 会议隔离 session：agent:<agentId>:a2a:qizi-<meetingId>（不进 main 私聊） */
const MEETING_A2A_NAMESPACE = 'a2a';
const MEETING_ID_PREFIX = 'qizi-';
const MAX_DELIBERANT_CONTENT_CHARS = 500;
const MAX_JSON_RETRIES = 2;
const MEETING_PARTICIPANT_SOFT_CHARS = 450;
const MEETING_PARTICIPANT_HARD_CHARS = 2400;
const MEETING_MODERATOR_SOFT_CHARS = 550;
const MEETING_MODERATOR_HARD_CHARS = 3000;
const MEETING_MODERATOR_SUMMARY_SOFT_CHARS = 500;
const MEETING_MODERATOR_SUMMARY_HARD_CHARS = 3000;
const MEETING_MODERATOR_FINAL_SOFT_CHARS = 700;
const MEETING_MODERATOR_FINAL_HARD_CHARS = 3000;
/** @deprecated 硬上限别名，供旧引用 */
const MEETING_MODERATOR_MAX_CHARS = MEETING_MODERATOR_HARD_CHARS;
const MEETING_PARTICIPANT_MAX_CHARS = MEETING_PARTICIPANT_HARD_CHARS;
/** 0 = 拼进 prompt 时不截断单条/总量，也不限条数 */
const MEETING_TRANSCRIPT_MSG_CHARS = 0;
const MEETING_TRANSCRIPT_TOTAL_CHARS = 0;
/** 主持在真正结束会议时写入；系统只认此口令停止 relay（勿在任务书/讨论正文中使用） */
const MEETING_ADJOURN_KEYWORD = 'meeting adjourned';

function hasMeetingAdjournedMarker(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  const lastLine = lines[lines.length - 1];
  if (!/^meeting\s+adjourned[.!！?？…]*$/i.test(lastLine)) return false;
  // 仅末行单独一行算收尾；正文里解释/引用口令（如「末行写 meeting adjourned」）允许
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^meeting\s+adjourned[.!！?？]*$/i.test(lines[i])) return false;
  }
  return true;
}

function meetingAdjournInstruction() {
  return `末行**单独一行**写 \`${MEETING_ADJOURN_KEYWORD}\`（全小写；正文可解释口令，但不要在前文再单独占一行写同一句）`;
}

function normalizeRoundCount(value) {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return 2;
}

function roundCountLabel(roundCount) {
  return ({ 1: '一', 2: '二', 3: '三' })[roundCount] || String(roundCount);
}

function moderatorSummaryRules({ final = false } = {}) {
  const label = final ? '最终总结' : '当轮总结';
  const allowed = final
    ? '  - **只允许**：已经决定的结论、仍未定的分歧（各一句）。**禁止派活**：不要安排写稿、剪辑、配音、发布、排期。若会前选了接收人，只转给这个系统指定的 agent 去执行；'
    : '  - **只允许**：已形成的共识、仍未定的分歧（各一句立场）、下轮要验证的一点；';
  const formatBlock = final
    ? [
      '  - **输出格式**（按顺序，每项一行；不要散文、不要铺垫）：',
      '    **结论** …（1–3 条编号，写「决定了什么」）',
      '    **分歧/风险** …（无则写「无」；各一句）',
      `    \`${MEETING_ADJOURN_KEYWORD}\`（**必须为本条发言最后一行/最后一句**）`,
      '  - 不要输出「派活」这一项。',
    ]
    : [
      '  - **输出格式**（按顺序，不要散文、不要铺垫）：',
      '    **共识** …（≤2 条编号）',
      '    **分歧** …（各立场一句，≤3 条；无则写「无」）',
      '    **下轮焦点** …（≤1 条：下轮要验证/收敛什么；**禁止**抛出新开放议题）',
    ];
  return [
    `- **${label} = 只写结论，不写过程**（硬约束）：`,
    '  - **禁止**：逐人复述谁说了什么、引用原话、描述讨论先后、铺垫背景、补充新议题、发散性提问或「还可以考虑…」类探索；',
    allowed,
    ...formatBlock,
  ].join('\n');
}

function meetingSummaryGuidance(softMax, hardMax, { final = false } = {}) {
  const label = final ? '最终总结' : '当轮总结';
  if (final) {
    return [
      moderatorSummaryRules({ final }),
      `- **${label}篇幅**：会议即将结束，**不设字数上限**；请把结论、分歧写完整，系统不会截断；`,
      '- 下方群聊记录仅供**提炼结论**；总结中**不得**复述或改写各位的发言过程。',
    ].join('\n');
  }
  return [
    moderatorSummaryRules({ final }),
    `- **${label}篇幅**：建议 ${softMax} 字以内；只写上述格式块；**必须在本条内收束完整**；`,
    `- 系统硬上限约 ${hardMax} 字（仅超出时在完整句处截断）。`,
    '- 下方群聊记录仅供**提炼结论**；总结中**不得**复述或改写各位的发言过程。',
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
    if (msg.excludeFromRound) continue;
    if (msg.who !== 'them' || !msg.speakerAgentId || !rosterIds.has(msg.speakerAgentId)) continue;
    counts.set(msg.speakerAgentId, (counts.get(msg.speakerAgentId) || 0) + 1);
  }
  return counts;
}

/** 按每人发言次数推断当前轮次派发状态（不受「主持接话」消息重置影响） */
function resolveRoundDispatchState(messages, roster, roundCount) {
  const rosterList = roster || [];
  if (rosterList.length === 0) {
    return { phase: 'dispatch', activeRound: 1, remaining: [] };
  }
  const counts = participantTurnCounts(messages, rosterList);
  const rounds = normalizeRoundCount(roundCount);
  const countValues = rosterList.map((entry) => counts.get(entry.agentId) || 0);
  const minCount = Math.min(...countValues);
  const allSynced = countValues.every((value) => value === minCount);

  if (allSynced && minCount >= rounds) {
    return { phase: 'all_rounds_done', activeRound: rounds, remaining: [] };
  }
  if (allSynced && minCount > 0) {
    return {
      phase: 'round_complete',
      completedRound: minCount,
      activeRound: minCount + 1,
      remaining: [],
    };
  }

  const activeRound = minCount + 1;
  const remaining = rosterList.filter((entry) => (counts.get(entry.agentId) || 0) < activeRound);
  return { phase: 'dispatch', activeRound, remaining };
}

function hasParticipantSpokenActiveRound(messages, roster, agentId, roundCount) {
  if (!agentId || !Array.isArray(roster) || roster.length === 0) return false;
  const state = resolveRoundDispatchState(messages, roster, roundCount);
  if (state.phase !== 'dispatch') return false;
  const counts = participantTurnCounts(messages, roster);
  return (counts.get(agentId) || 0) >= state.activeRound;
}

function isFinalSummaryExpected(messages, roster, roundCount) {
  const rounds = normalizeRoundCount(roundCount);
  const counts = participantTurnCounts(messages, roster);
  return (roster || []).every((entry) => (counts.get(entry.agentId) || 0) >= rounds);
}

function resolveModeratorSpeechMode(messages, roster, moderatorId, roundCount) {
  if (isFinalSummaryExpected(messages, roster, roundCount)) {
    return {
      kind: 'final_summary',
      softChars: MEETING_MODERATOR_FINAL_SOFT_CHARS,
      hardChars: 0,
    };
  }
  if (!shouldUseModeratorSummaryLimits(messages, roster, moderatorId)) {
    return {
      kind: 'dispatch',
      softChars: MEETING_MODERATOR_SOFT_CHARS,
      hardChars: MEETING_MODERATOR_HARD_CHARS,
    };
  }
  return {
    kind: 'round_summary',
    softChars: MEETING_MODERATOR_SUMMARY_SOFT_CHARS,
    hardChars: MEETING_MODERATOR_SUMMARY_HARD_CHARS,
  };
}

function capModeratorSpeech(text, messages, roster, moderatorId, roundCount, speechKindOverride) {
  const mode = speechKindOverride
    ? {
      kind: speechKindOverride,
      hardChars: speechKindOverride === 'final_summary' ? 0 : MEETING_MODERATOR_SUMMARY_HARD_CHARS,
    }
    : resolveModeratorSpeechMode(messages, roster, moderatorId, roundCount);
  const raw = String(text || '').trim();
  if (mode.kind === 'final_summary') {
    return raw;
  }
  if (/最终总结|🏁\s*最终总结/i.test(raw)) {
    return raw;
  }
  return capMeetingSpeech(raw, mode.hardChars);
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

function meetingRequirementText(requirements, title) {
  if (!requirements) return '';
  const text = String(requirements[title] || '').trim();
  if (!text) throw new Error(`会议要求缺少：${title}`);
  return text;
}

function moderatorRequirementBlock(requirements, speechKind, noRepeatPastTopics) {
  if (!requirements) return '';
  const titles = ['主持过程中的要求'];
  if (speechKind === 'round_summary') titles.push('当轮总结');
  if (speechKind === 'final_summary') titles.push('最终总结');
  if (noRepeatPastTopics) titles.push('往期主题');
  return titles.map((title) => meetingRequirementText(requirements, title)).join('\n\n');
}

function draftAttachmentBlocks(draft, savedDraft) {
  const current = String(draft || '').trim();
  const saved = String(savedDraft || '').trim();
  const blocks = ['## 本次讨论底稿', current || '无'];
  if (saved && saved !== current) {
    blocks.push('', '## 已保存的讨论底稿', saved);
  }
  return blocks.join('\n');
}

function buildParticipantGroupPrompt({
  topic,
  draft,
  savedDraft = '',
  agentId,
  agentLabel,
  instruction,
  transcript,
  groupSessionKey,
  noRepeatPastTopics = false,
  priorTopicSummaries = [],
  softChars = MEETING_PARTICIPANT_SOFT_CHARS,
  hardChars = MEETING_PARTICIPANT_HARD_CHARS,
  requirements = null,
  readingReport = '',
}) {
  const priorBlock = buildPriorTopicsSection(priorTopicSummaries, { emptyNote: false });
  const fileRules = requirements
    ? [
      meetingRequirementText(requirements, '议事发言要求'),
      noRepeatPastTopics ? meetingRequirementText(requirements, '往期主题') : '',
    ].filter(Boolean).join('\n\n')
    : '';
  return [
    '【QiziShell 会议 · 你的发言轮次】',
    '',
    fileRules || [
      '你正在一场 **会议群聊** 中发言（由 QiziShell 展示给老大）。硬约束：',
      '- 只回答本次议题要决定的那一件事。判断理由可以带上，但不要展开议题没要求的工序（写稿、剪辑、配音、发布、排期）；',
      meetingSpeechGuidance(softChars, hardChars),
      '- 你的回复会出现在 **会议群聊界面**，不要尝试 sessions_send 或私聊其他 Agent；',
      '- **不要**在发言末尾 @ 下一位 Agent——由主持 Agent 统一派发，你只需完成自己的论述；',
      '- 只发表一次性完整意见，不要代笔其他 Agent；',
      '- 不要输出 JSON，用自然语言直接发言。',
      `- 会议参数 · 不可与往日主题重复：${noRepeatPastTopics ? 'true' : 'false'}`,
      priorBlock ? '- 不得再选下方「往期主题」里已经定过的主题；换标题、换角度、换说法仍算同一主题。拿不准时当成不重复，照常说出你的选择。' : '',
    ].filter(Boolean).join('\n'),
    '',
    `本次会议隔离 session：\`${groupSessionKey}\`（不是你的 main 私聊）`,
    `你的 agentId：\`${agentId}\`（${agentLabel}）`,
    '',
    savedReadingReportSection(requirements),
    `## 议题\n${topic.trim()}`,
    '',
    draftAttachmentBlocks(draft, savedDraft),
    priorBlock ? `\n${priorBlock}` : '',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
    '',
    '## 本轮对你的要求',
    instruction.trim(),
    '',
    '请直接输出你在群里的发言正文：',
  ].filter(Boolean).join('\n');
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
function isRepickMention(text, agentId) {
  const raw = String(text || '');
  if (!agentId || !raw.includes(`@${agentId}`)) return false;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(`@${agentId}`)) continue;
    if (/往期主题重复|不得再定|请重选|要求重选/.test(line)) return true;
  }
  return false;
}

function hasCountableParticipantSpeech(messages, agentId) {
  return (messages || []).some((msg) => (
    msg.who === 'them' && msg.speakerAgentId === agentId && !msg.excludeFromRound
  ));
}

function hasUsedRepick(messages, agentId) {
  return (messages || []).some((msg) => (
    msg.who === 'them' && msg.speakerAgentId === agentId && msg.excludeFromRound
  ));
}

function excludeLatestParticipantSpeech(messages, agentId) {
  if (!Array.isArray(messages) || !agentId) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.who === 'them' && msg.speakerAgentId === agentId && !msg.excludeFromRound) {
      msg.excludeFromRound = true;
      return true;
    }
  }
  return false;
}

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

function hasParticipantReplyAfter(messages, messageIndex, agentId) {
  if (!Array.isArray(messages) || messageIndex < 0 || !agentId) return false;
  for (let i = messageIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.streaming) continue;
    if (msg.who === 'them' && msg.speakerAgentId === agentId) return true;
  }
  return false;
}

function shouldSkipRelayMention(
  text,
  agentId,
  messages,
  moderatorAgentId,
  messageIndex = -1,
  roster = null,
  roundCount = 2,
  options = {},
) {
  if (!agentId || agentId === moderatorAgentId) return true;
  if (messageIndex >= 0 && hasParticipantReplyAfter(messages, messageIndex, agentId)) {
    return true;
  }
  if (options.noRepeatPastTopics
    && isRepickMention(text, agentId)
    && hasCountableParticipantSpeech(messages, agentId)) {
    return hasUsedRepick(messages, agentId);
  }
  if (isCorrectionMention(text, agentId)) return true;
  if (Array.isArray(roster) && roster.length > 0
    && hasParticipantSpokenActiveRound(messages, roster, agentId, roundCount)) {
    return true;
  }
  return false;
}

/** 一条主持发言里可能有多个 @（列名单）；取正文中第一个有效 @（按出现顺序，不是名单排序） */
function pickRelayMention(
  text,
  mentions,
  messages,
  roster,
  moderatorAgentId,
  messageIndex = -1,
  roundCount = 2,
  options = {},
) {
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  for (const mention of mentions) {
    if (shouldSkipRelayMention(
      text,
      mention.agentId,
      messages,
      moderatorAgentId,
      messageIndex,
      roster,
      roundCount,
      options,
    )) {
      continue;
    }
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

function readingReportRuleLines(readingReport) {
  const path = String(readingReport || '').trim();
  if (!path) return [];
  return [
    `- **先读报告（硬约束）**：文件路径 \`${path}\`。该路径在 OpenClaw 网关所在机器上，不是开会的人自己电脑上的路径。`,
    '- 所有 Agent（主持与全体议事）在开始发言前，务必先读取并仔细阅读该文件的全文。未读完全文不得发言。不得只看文件名、摘要或片段。',
    '- 主持每次 @ 派发时，必须在同一条派发里明确要求对方先读完该文件再发言。',
  ];
}

function savedReadingReportSection(requirements) {
  const text = String(requirements?.['阅读报告'] || '').trim();
  if (!text) return '';
  return `## 阅读报告\n${text}`;
}

function buildMeetingRequirementSections(readingReport = '') {
  const ruleBlock = readingReportRuleLines(readingReport);
  const readingRules = ruleBlock.length ? [...ruleBlock, ''] : [];
  return [
    '## 篇幅与收尾',
    `- 议事建议 ${MEETING_PARTICIPANT_SOFT_CHARS} 字，硬上限 ${MEETING_PARTICIPANT_HARD_CHARS}`,
    `- 主持派发建议 ${MEETING_MODERATOR_SOFT_CHARS} 字，硬上限 ${MEETING_MODERATOR_HARD_CHARS}`,
    `- 当轮总结建议 ${MEETING_MODERATOR_SUMMARY_SOFT_CHARS} 字，硬上限 ${MEETING_MODERATOR_SUMMARY_HARD_CHARS}`,
    `- 最终总结建议 ${MEETING_MODERATOR_FINAL_SOFT_CHARS} 字，不截断`,
    `- 散会：${meetingAdjournInstruction()}`,
    '- 轮次以本文开头的 roundCount 为准（1、2 或 3）。',
    '',
    '## 主持启动任务书',
    ...readingRules,
    '硬约束（先看这里）：',
    '- 立刻用文字回复。不要调用 exec、read、sessions_list、sessions_history，也不要排查会议程序、插件或数据库。',
    '- 议题、底稿、名单和规则都已经写在这条消息里。不要再去打开别的文件。',
    '- 只有这条消息写明了必须阅读的文件路径时，才可以读取那一个文件，读完马上开场。没写路径时，一个工具都不要用。',
    '你现在是本次会议 **主持 Agent**。硬约束：',
    '- 你只负责主持：派发（@ 指定议事 Agent 发言）、轮次总结、最终收尾。不要派活；若会前选了接收人，只转给这个系统指定的 agent 去执行；',
    '- **不要**发表你自己的议事观点，也不要替其他 Agent 代笔；',
    `- **篇幅**：派发/开场建议 ${MEETING_MODERATOR_SOFT_CHARS} 字内；**当轮总结**（仅结论）建议 ${MEETING_MODERATOR_SUMMARY_SOFT_CHARS} 字内；**最终总结**建议 ${MEETING_MODERATOR_FINAL_SOFT_CHARS} 字内；议事建议 ${MEETING_PARTICIPANT_SOFT_CHARS} 字内；`,
    '- **总结铁律**：当轮/最终总结**只写结论**（共识、分歧），**禁止**派活、复述研讨过程、逐人回顾、发散新问题；',
    '- 议事 Agent 之间 **互不可见** 彼此原文，只能看到你整理后的**结论型**轮次总结；',
    '- **N 轮制**：每轮 @ 各议事 Agent 各发言一次 → 当轮总结；全部轮次结束后作最终总结，收尾 **勿 @ 任何人**。',
    '- **派发语法（硬约束）**：只认 @agentId，例如 @mo_bao；**@墨宝 等中文名不会被 relay**；一次只 @ 一人；',
    '- **纠正派发错误时**：正文里**不要**写 @agentId（用纯文字 agentId 即可），否则仍会 relay；',
    '- **禁止**调用 sessions_send / sessions_spawn，**禁止**向任何 Agent 的 main 私聊发消息；只需在发言里 @；',
    '- **派发范围（硬约束）**：每次 @ 只问本次议题要拍板的那一件事。不要按 IDENTITY.md 的岗位出题，不要问写稿、剪辑、配音、收料时长、出片时间、发布验收。',
    '- **禁止派活**：最终总结只写决定了什么。不要安排写稿、剪辑、配音、发布、排期。若会前选了接收人，只转给这个系统指定的 agent 去执行。',
    '',
    '## 主持过程中的要求',
    ...readingRules,
    '继续主持、空闲提醒、没有识别到 @、强制收尾时都遵守：',
    '- **每条发言只 @ 一位** agentId；纠正派发时**不要**写 @（写纯文字 agentId 即可）；',
    '- 驳回往期主题时，`@agentId` 和「往期主题重复」必须在同一行，才会转发重选；',
    '- **派发范围**：只问本次议题要拍板的那一件事，不要按岗位追问写稿、剪辑、配音、收料时长或出片时间；',
    '- 本轮所有人已发言：按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮；总结正文里不要 @；',
    '- 全部轮次结束后作 **最终总结**（只写结论和分歧，不要派活），然后写散会口令；**勿 @ 任何人**；',
    '- 空闲时必须在正文里写 @agentId（如 @mo_bao）才会触发 relay；',
    '- 连续空闲仍无新发言则强制最终总结，正文写明提前结束原因，**不要 @ 任何人**；',
    '- 上一条没有可识别的 @ 时，按建议补上 @agentId，不要就此结束。',
    '',
    '## 当轮总结',
    meetingSummaryGuidance(
      MEETING_MODERATOR_SUMMARY_SOFT_CHARS,
      MEETING_MODERATOR_SUMMARY_HARD_CHARS,
      { final: false },
    ),
    '',
    '## 最终总结',
    meetingSummaryGuidance(
      MEETING_MODERATOR_FINAL_SOFT_CHARS,
      MEETING_MODERATOR_FINAL_HARD_CHARS,
      { final: true },
    ),
    '',
    '## 议事发言要求',
    ...readingRules,
    '你正在一场 **会议群聊** 中发言。硬约束：',
    '- 只回答本次议题要决定的那一件事。判断理由可以带上，但不要展开议题没要求的工序（写稿、剪辑、配音、发布、排期）；',
    meetingSpeechGuidance(MEETING_PARTICIPANT_SOFT_CHARS, MEETING_PARTICIPANT_HARD_CHARS),
    '- 回复出现在 **会议群聊界面**，不要尝试 sessions_send 或私聊其他 Agent；',
    '- **不要**在发言末尾 @ 下一位 Agent——由主持 Agent 统一派发；',
    '- 只发表一次性完整意见，不要代笔其他 Agent；',
    '- 不要输出 JSON，用自然语言直接发言。',
    '- 若开头「不可与往日主题重复」为 true：不得再选往期主题里已经定过的主题；换标题、换角度、换说法仍算同一主题。拿不准时当成不重复。',
    '',
    '## 往期主题',
    moderatorNoRepeatRules(),
    ...(ruleBlock.length ? ['', buildReadingReportBlock(readingReport)] : []),
  ].join('\n');
}

function moderatorNoRepeatRules() {
  return [
    '- **往期主题**：议事 Agent 的选择若与「往期主题」原文是同一件事（换标题、换角度、换说法仍算），当场驳回，不要写入共识、下轮焦点或最终结论；',
    '- 驳回必须单独成行，同一行里写 `@agentId` 和「往期主题重复」，要求该 agent 重选；同一人同一轮只驳回一次；',
    '- 重选后仍是往期主题：该提议作废，不写入共识，改 @ 下一位；',
    '- 拿不准是否同一主题时，当成不重复，会议继续。',
  ].join('\n');
}

function buildModeratorDispatchHint(roster, messages, { noRepeatPastTopics = false } = {}) {
  const lastId = getLastParticipantAgentId(messages);
  const lastEntry = roster.find((r) => r.agentId === lastId);
  const next = getSuggestedNextParticipant(roster, lastId);
  const parts = [];
  if (lastEntry && noRepeatPastTopics) {
    parts.push(`上一位刚发完言：${lastEntry.label} (@${lastEntry.agentId})。若其选择与往期主题是同一件事，单独一行写 @${lastEntry.agentId} 和「往期主题重复」，要求重选（同一轮只此一次）。否则请勿再次 @ 同一人。`);
  } else if (lastEntry) {
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
  moderatorAgentId = '',
  speechKind = 'dispatch',
  softChars = MEETING_MODERATOR_SOFT_CHARS,
  hardChars = MEETING_MODERATOR_HARD_CHARS,
  noRepeatPastTopics = false,
  requirements = null,
} = {}) {
  const remaining = resolveRoundDispatchState(messages, roster, roundCount).remaining;
  const dispatchHint = buildModeratorDispatchHint(roster, messages, { noRepeatPastTopics });
  const lastFromTranscript = resolveLastParticipantLabel(roster, messages);
  const lastLabel = lastFromTranscript || lastSpeakerLabel;
  const rounds = normalizeRoundCount(roundCount);
  const roundWord = roundCountLabel(rounds);
  const summaryHint = speechKind === 'final_summary'
    ? `- 全员已发言：作 **最终总结**（只写结论和分歧，不要派活），${meetingAdjournInstruction()}；**勿 @ 任何人**。`
    : (speechKind === 'round_summary'
      ? (noRepeatPastTopics
        ? '- 若上一位的选择与往期主题是同一件事，先不要总结；单独一行 @ 该 agent 并写「往期主题重复」，要求重选。否则按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮；总结正文里不要 @；'
        : '- 本轮所有人已发言完毕：请按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮；总结正文里不要 @；')
      : '- 若本轮按名单尚未派完，请 @ **下一位** 议事 Agent（**必须**用 agentId，如 @nai_pang；@墨宝 无效）；');
  const fileRules = moderatorRequirementBlock(requirements, speechKind, noRepeatPastTopics);
  return [
    '[系统 · QiziShell]',
    lastLabel
      ? `上一位议事 Agent（${lastLabel}）已在群聊中发言完毕。`
      : '上一位议事 Agent 已在群聊中发言完毕。',
    '（以上依据当前群聊记录最后一条议事 Agent 发言判定。）',
    '请继续主持会议。硬约束：',
    fileRules || moderatorSpeechGuidance(speechKind, softChars, hardChars),
    fileRules ? '' : (noRepeatPastTopics
      ? '- **每条发言只 @ 一位** agentId；驳回往期主题时，`@agentId` 和「往期主题重复」必须在同一行，才会转发重选；'
      : '- **每条发言只 @ 一位** agentId；QiziShell 会对每个 @agentId 自动 relay——纠正派发时**不要**写 @（写 nai_pang 等纯文字即可）；'),
    fileRules ? '' : '- **派发范围**：只问本次议题要拍板的那一件事，不要按岗位追问写稿、剪辑、配音、收料时长或出片时间；',
    summaryHint,
    speechKind === 'dispatch'
      ? '- 若本轮所有人已各发言一次，请作 **当轮总结（仅结论，见格式块）**，然后 @ 名单第一位开始下一轮反馈；'
      : '',
    !fileRules && noRepeatPastTopics ? moderatorNoRepeatRules() : '',
    `- 共 ${rounds} 轮；结束后最终总结，${meetingAdjournInstruction()}；**勿 @ 任何人**。`,
    '一次只 @ 一位 Agent。',
    dispatchHint ? `\n${dispatchHint}` : '',
    remaining.length
      ? `\n（本轮统计）尚未发言：${remaining.map((r) => `${r.label} (@${r.agentId})`).join('、')}`
      : '\n（本轮统计）所有议事 Agent 已各发言一次——请作当轮总结或 @ 下一位开始新一轮反馈。',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
  ].filter(Boolean).join('\n');
}

function buildModeratorIdleWatchdogPrompt({
  transcript,
  roster,
  spokenAgentIds = [],
  messages = [],
  roundCount = 2,
  speechKind = 'dispatch',
  softChars = MEETING_MODERATOR_SOFT_CHARS,
  hardChars = MEETING_MODERATOR_HARD_CHARS,
  strike = 1,
  maxStrikes = 3,
  idleMs = 0,
  noRepeatPastTopics = false,
  requirements = null,
} = {}) {
  const spoken = new Set(spokenAgentIds);
  const remaining = (roster || []).filter((entry) => !spoken.has(entry.agentId));
  const dispatchHint = buildModeratorDispatchHint(roster, messages, { noRepeatPastTopics });
  const next = getSuggestedNextParticipant(roster, getLastParticipantAgentId(messages));
  const rounds = normalizeRoundCount(roundCount);
  const idleMin = Math.max(1, Math.round(idleMs / 60_000));
  const fileRules = moderatorRequirementBlock(requirements, speechKind, noRepeatPastTopics);
  const actionHint = speechKind === 'final_summary'
    ? `作 **最终总结**，${meetingAdjournInstruction()}；**勿 @ 任何人**。`
    : (speechKind === 'round_summary'
      ? (noRepeatPastTopics
        ? '若上一位与往期主题重复，先单独一行 @ 该 agent 并写「往期主题重复」要求重选；否则按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮反馈。'
        : '请按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮反馈。')
      : (next
        ? `请立即 @：@${next.agentId}（${next.label}）`
        : (remaining.length
          ? `请 @ 以下尚未发言的议事 Agent 之一：${remaining.map((r) => `@${r.agentId}（${r.label}）`).join('、')}`
          : '请 @ 下一位议事 Agent 或作本轮总结。')));
  return [
    '[系统 · QiziShell]',
    `⚠️ 已约 ${idleMin} 分钟无任何议事 Agent 新发言（空闲提醒 ${strike}/${maxStrikes}）。`,
    '会议仍在进行：请主动推进——**必须**在正文里写 @agentId（如 @mo_bao）才会触发 relay。',
    fileRules || moderatorSpeechGuidance(speechKind, softChars, hardChars),
    actionHint,
    strike >= maxStrikes
      ? '若仍无法推进，下一条系统消息将要求你强制最终总结并结束会议。'
      : '',
    !fileRules && noRepeatPastTopics ? moderatorNoRepeatRules() : '',
    `共 ${rounds} 轮；结束后 ${meetingAdjournInstruction()}，勿 @ 任何人。`,
    fileRules ? '' : (noRepeatPastTopics
      ? '一次只 @ 一位 Agent。驳回往期主题时，@ 必须和「往期主题重复」写在同一行。'
      : '一次只 @ 一位 Agent；纠正错误时正文里不要写 @。'),
    dispatchHint ? `\n${dispatchHint}` : '',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
  ].filter(Boolean).join('\n');
}

function buildModeratorForceFinalSummaryPrompt({
  transcript,
  roster,
  spokenAgentIds = [],
  messages = [],
  roundCount = 2,
  softChars = MEETING_MODERATOR_FINAL_SOFT_CHARS,
  hardChars = MEETING_MODERATOR_FINAL_HARD_CHARS,
  idleMs = 0,
  endReason = '长时间无议事 Agent 反馈',
  noRepeatPastTopics = false,
  requirements = null,
} = {}) {
  const idleMin = Math.max(1, Math.round(idleMs / 60_000));
  const rounds = normalizeRoundCount(roundCount);
  const dispatchHint = buildModeratorDispatchHint(roster, messages, { noRepeatPastTopics });
  const fileRules = moderatorRequirementBlock(requirements, 'final_summary', noRepeatPastTopics);
  return [
    '[系统 · QiziShell]',
    `⚠️ 已连续提醒仍无议事 Agent 新发言（约 ${idleMin} 分钟），**必须立即强制收尾**。`,
    `提前结束原因（须写入总结正文）：${endReason}`,
    '硬约束：',
    fileRules || moderatorSpeechGuidance('final_summary', softChars, hardChars),
    fileRules ? '' : '- 按 **最终总结格式（仅结论与分歧，不要派活）** 输出；',
    '- 总结中**明确写出**上述提前结束原因；',
    `- ${meetingAdjournInstruction()}；`,
    fileRules ? '' : '- **不要 @ 任何人**。若会前选了接收人，只转给这个系统指定的 agent 去执行。',
    !fileRules && noRepeatPastTopics ? '- 最终结论不得把往期主题再定为决定；拿不准时不要写进结论。' : '',
    `- 共 ${rounds} 轮制；当前为强制提前结束，不必再等待未发言者。`,
    dispatchHint ? `\n${dispatchHint}` : '',
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
  noRepeatPastTopics = false,
  requirements = null,
} = {}) {
  const spoken = new Set(spokenAgentIds);
  const remaining = (roster || []).filter((entry) => !spoken.has(entry.agentId));
  const dispatchHint = buildModeratorDispatchHint(roster, messages, { noRepeatPastTopics });
  const next = getSuggestedNextParticipant(roster, getLastParticipantAgentId(messages));
  const rounds = normalizeRoundCount(roundCount);
  const fileRules = moderatorRequirementBlock(requirements, speechKind, noRepeatPastTopics);
  if (speechKind === 'final_summary') {
    return [
      '[系统 · QiziShell]',
      '当前处于**最终总结/收尾**阶段。',
      '**本阶段不再向议事 Agent relay**。只写结论与分歧，不要派活，**勿写 @**。',
      `若已发过最终总结，**只**回复一行 \`${MEETING_ADJOURN_KEYWORD}\`。`,
      `若尚未总结，作 **最终总结** 并 ${meetingAdjournInstruction()}；**勿 @ 任何人**。`,
      fileRules || moderatorSpeechGuidance('final_summary', softChars, hardChars),
      !fileRules && noRepeatPastTopics ? '- 最终结论不得把往期主题再定为决定；拿不准时不要写进结论。' : '',
      `共 ${rounds} 轮；结束后 ${meetingAdjournInstruction()}，勿 @ 任何人。`,
      '',
      '## 当前群聊记录',
      transcript || '（暂无）',
    ].filter(Boolean).join('\n');
  }
  const actionHint = speechKind === 'round_summary'
    ? (noRepeatPastTopics
      ? '若上一位与往期主题重复，先单独一行 @ 该 agent 并写「往期主题重复」要求重选；否则按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮反馈。'
      : '请按 **当轮总结格式（仅结论）** 收束，**然后** @ 名单第一位开始下一轮反馈。')
    : (next
      ? `建议现在 @：@${next.agentId}（${next.label}）`
      : (remaining.length
        ? `建议 @ 以下议事 Agent 之一：${remaining.map((r) => `@${r.agentId}（${r.label}）`).join('、')}`
        : '请 @ 下一位议事 Agent 或作本轮总结。'));
  return [
    '[系统 · QiziShell]',
    '你的上一条发言里没有可被 relay 识别的 @（**必须**写 @agentId，例如 @mo_bao）。',
    fileRules || moderatorSpeechGuidance(speechKind, softChars, hardChars),
    actionHint,
    `共 ${rounds} 轮；结束后 ${meetingAdjournInstruction()}，勿 @ 任何人。`,
    fileRules ? '' : (noRepeatPastTopics
      ? '一次只 @ 一位 Agent。驳回往期主题时，@ 必须和「往期主题重复」写在同一行。'
      : '一次只 @ 一位 Agent；纠正错误时正文里不要写 @。'),
    !fileRules && noRepeatPastTopics ? moderatorNoRepeatRules() : '',
    dispatchHint ? `\n${dispatchHint}` : '',
    '',
    '## 当前群聊记录',
    transcript || '（暂无）',
  ].filter(Boolean).join('\n');
}

function isMeetingCompleteText(text) {
  return isMeetingClosingMessage(text);
}

/** 任务书/开场里复述的「写会议结束」等说明，不是实际收尾 */
function stripMeetingEndInstructions(text) {
  return String(text || '')
    .replace(/写[「『"'""]?会议结束[」』"'""]?/gi, '')
    .replace(/作最终总结并写[「『"'""]?会议结束[」』"'""]?/gi, '')
    .replace(/全部结束后[^。\n]{0,48}会议结束/gi, '')
    .replace(/结束后写[「『"'""]?会议结束[」』"'""]?/gi, '')
    .replace(/届时[^。\n]{0,24}会议结束/gi, '');
}

/** 明确的收尾标记（非规则复述） */
function hasExplicitMeetingEndMarker(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\*\*会议结束\*\*\s*$/.test(t)) return true;
  if (/^\s*\*\*会议结束\*\*\s*$/m.test(t)) return true;
  if (/^会议结束[。.!！…]*\s*$/m.test(t)) return true;
  if (/会议已(正式)?结束[。.!！…\s]*$/i.test(t)) return true;
  const stripped = stripMeetingEndInstructions(t).trim();
  if (stripped && /会议结束[。.!！…]*\s*$/.test(stripped)) return true;
  if (stripped && /会议已(正式)?结束[。.!！…\s]*$/i.test(stripped)) return true;
  return false;
}

/** 主持已宣布收尾、不再派发的短回复（idle nudge 后常见） */
function isModeratorPostCloseStub(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return false;
  if (/会议已(正式)?结束/i.test(t) && /不再动作|不再派发|不再发言|等待老大|本主持.*不再/i.test(t)) {
    return true;
  }
  if (t.length <= 80 && /会议已(正式)?结束|会议结束/i.test(t) && !/写[「『]会议结束/.test(t)) {
    return true;
  }
  return false;
}

/** 系统只认 MEETING_ADJOURN_KEYWORD 停止 relay */
function isMeetingClosingMessage(text) {
  return hasMeetingAdjournedMarker(text);
}

function isStrongMeetingClosingMessage(text) {
  return hasMeetingAdjournedMarker(text);
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

/** 主持收尾：派活/总结里的 @ 仅是指派说明，不触发议事 relay */
function isModeratorClosingMessage(text, roster, moderatorAgentId, roundCount = 3, messages = []) {
  if (isModeratorPostCloseStub(text)) return true;
  return isMeetingClosingMessage(text, roundCount);
}

function findFirstClosingModeratorIndex(messages, moderatorAgentId, roster, roundCount = 3) {
  if (!Array.isArray(messages) || !moderatorAgentId) return -1;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.speakerLabel === '任务书') continue;
    if (msg.speakerAgentId !== moderatorAgentId) continue;
    if (msg.streaming) continue;
    if (isModeratorClosingMessage(msg.text, roster, moderatorAgentId, roundCount, messages)) {
      return i;
    }
  }
  return -1;
}

function hasClosingModeratorMessage(messages, moderatorAgentId) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.speakerLabel === '任务书') continue;
    if (msg.speakerAgentId !== moderatorAgentId) continue;
    if (msg.streaming) continue;
    return hasMeetingAdjournedMarker(msg?.text);
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

const PRIOR_TOPIC_SUMMARY_CHARS = 2500;
const PRIOR_TOPIC_MAX_ENTRIES = 8;

function formatPriorTopicDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '').slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clipPriorSummary(text) {
  const t = String(text || '').trim();
  if (t.length <= PRIOR_TOPIC_SUMMARY_CHARS) return t;
  return `${t.slice(0, PRIOR_TOPIC_SUMMARY_CHARS).trim()}\n\n（下文已截断）`;
}

function listPriorTopicEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && String(entry.finalSummary || '').trim());
}

function buildPriorTopicsSection(entries, { emptyNote = true } = {}) {
  const list = listPriorTopicEntries(entries);
  if (!list.length) {
    if (!emptyNote) return '';
    return [
      '## 往期主题',
      '近 7 日没有本议题已结束会议的最终总结，本场不设排除。',
    ].join('\n');
  }
  const shown = list.slice(0, PRIOR_TOPIC_MAX_ENTRIES);
  const blocks = shown.map((entry) => (
    `### ${formatPriorTopicDate(entry.finishedAt)}\n${clipPriorSummary(entry.finalSummary)}`
  ));
  const extra = list.length - shown.length;
  return [
    '## 往期主题（原文，不得再定）',
    '以下是本议题近 7 日已结束会议的最终总结原文。',
    '这些主题不得再定。换标题、换角度、换说法，仍算同一主题。',
    '拿不准是否同一主题时，当成不重复。',
    '',
    ...blocks,
    extra > 0 ? `（另有 ${extra} 条未附上，以已附原文为准。）` : '',
  ].filter(Boolean).join('\n');
}

function extractMeetingFinalSummaryText(record) {
  const messages = record?.transcript;
  const moderatorAgentId = record?.moderatorAgentId;
  if (!Array.isArray(messages) || !moderatorAgentId) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.streaming) continue;
    if (msg.speakerLabel === '任务书') continue;
    if (msg.who !== 'me' || msg.speakerAgentId !== moderatorAgentId) continue;
    const text = String(msg.text || '').trim();
    if (!text) continue;
    if (hasMeetingAdjournedMarker(text) || /最终总结/.test(text)) return text;
  }
  return '';
}

function buildReadingReportBlock(readingReport) {
  const path = String(readingReport || '').trim();
  if (!path) return '';
  return [
    '## 阅读报告',
    path,
    '该路径在 OpenClaw 网关所在机器上，不是开会的人自己电脑上的路径。',
    '硬约束：所有 Agent（主持与全体议事）在开始发言前，务必先读取并仔细阅读该文件的全文。未读完全文不得发言。不得只看文件名、摘要或片段。主持每次派发时，也要明确要求对方先读完该文件再发言。',
  ].join('\n');
}

function buildModeratorBriefingMessage({
  topic,
  draft,
  savedDraft = '',
  goal,
  readingReport = '',
  moderator,
  participants,
  roundCount = 2,
  noRepeatPastTopics = false,
  priorTopicSummaries = [],
  requirements = null,
}) {
  const rounds = normalizeRoundCount(roundCount);
  const roundWord = roundCountLabel(rounds);
  const roster = participants.map((p) => {
    const id = p.agentId;
    const label = p.label || id;
    return `- ${label} → 派发时写 **@${id}**（不要写 @${label}）`;
  }).join('\n');
  const fileRules = requirements
    ? [
      meetingRequirementText(requirements, '主持启动任务书'),
      '',
      meetingRequirementText(requirements, '篇幅与收尾'),
      noRepeatPastTopics ? meetingRequirementText(requirements, '往期主题') : '',
    ].filter(Boolean).join('\n\n')
    : '';

  return [
    '【QiziShell 会议模式 · 启动任务书】',
    '',
    '硬约束（先看这里）：',
    '- 立刻用文字回复。不要调用 exec、read、sessions_list、sessions_history，也不要排查会议程序、插件或数据库。',
    '- 议题、底稿、名单和规则都已经写在这条消息里。不要再去打开别的文件。',
    '- 只有这条消息写明了必须阅读的文件路径时，才可以读取那一个文件，读完马上开场。没写路径时，一个工具都不要用。',
    '',
    fileRules || [
      '你现在是本次会议 **主持 Agent**。硬约束：',
      '- 你只负责主持：派发（@ 指定议事 Agent 发言）、轮次总结、最终收尾。不要派活；若会前选了接收人，只转给这个系统指定的 agent 去执行；',
      '- **不要**发表你自己的议事观点，也不要替其他 Agent 代笔；',
      `- **篇幅**：派发/开场建议 ${MEETING_MODERATOR_SOFT_CHARS} 字内；**当轮总结**（仅结论）建议 ${MEETING_MODERATOR_SUMMARY_SOFT_CHARS} 字内；**最终总结**建议 ${MEETING_MODERATOR_FINAL_SOFT_CHARS} 字内；议事建议 ${MEETING_PARTICIPANT_SOFT_CHARS} 字内；`,
      '- **总结铁律**：当轮/最终总结**只写结论**（共识、分歧），**禁止**派活、复述研讨过程、逐人回顾、发散新问题；格式见系统后续提示中的 **共识/分歧/下轮焦点** 或 **结论/分歧** 块；',
      '- 议事 Agent 之间 **互不可见** 彼此原文，只能看到你整理后的**结论型**轮次总结；',
      `- **${rounds} 轮制**：每轮 @ 各议事 Agent 各发言一次 → 当轮总结；${rounds} 轮结束后作最终总结，${meetingAdjournInstruction()}；收尾 **勿 @ 任何人**。`,
      '- **派发语法（硬约束）**：只认 @agentId，例如 @mo_bao；**@墨宝 等中文名不会被 relay**；一次只 @ 一人；',
      '- **纠正派发错误时**：正文里**不要**写 @agentId（用纯文字 nai_pang 即可），否则 QiziShell 仍会 relay；',
      '- **禁止**调用 sessions_send / sessions_spawn，**禁止**向任何 Agent 的 main 私聊发消息；只需在发言里 @，QiziShell 会 relay；',
      '- **派发范围（硬约束）**：每次 @ 只问本次议题要拍板的那一件事（例如选题会只问选哪一条、为什么、备选是什么）。不要按 IDENTITY.md 的岗位出题，不要问写稿、剪辑、配音、收料时长、出片时间、发布验收。',
      '- **禁止派活**：最终总结只写决定了什么。不要安排写稿、剪辑、配音、发布、排期。若会前选了接收人，只转给这个系统指定的 agent 去执行。',
    ].join('\n'),
    '',
    '---',
    '## 会议参数',
    `- 不可与往日主题重复：${noRepeatPastTopics ? 'true' : 'false'}`,
    '',
    `## 议题\n${topic.trim()}`,
    '',
    draftAttachmentBlocks(draft, savedDraft),
    goal ? `\n## 期望结论方向\n${goal.trim()}\n（这是结论要落到的方向，写进「结论」即可。不要据此给任何人派活。）` : '',
    savedReadingReportSection(requirements),
    noRepeatPastTopics ? `\n${buildPriorTopicsSection(priorTopicSummaries)}` : '',
    !fileRules && noRepeatPastTopics && listPriorTopicEntries(priorTopicSummaries).length
      ? `\n${moderatorNoRepeatRules()}`
      : '',
    '',
    '## 议事 Agent 名单（已确认参与）',
    roster,
    '',
    `## 你的身份`,
    `主持：${moderator.label || moderator.agentId} (\`${moderator.agentId}\`) — 仅主持，不参与议事。`,
    '',
    '---',
    '现在就用文字回复，不要先调用工具。',
    '请阅读以上任务书后：',
    '1. 用简短开场向「老大」宣布议题与参与名单；',
    '2. 立即开始 **第 1 轮**：按名单顺序 @ 第一位议事 Agent 的 agentId（如 @mo_bao），要求其只基于底稿回答本次议题要决定的那一件事，一次说完；',
    `3. 按议程推进，直到 ${rounds} 轮结束或达成结论。`,
    '',
    '（本消息由 QiziShell 代老大发送；老大当前仅观察，不插话。）',
  ].filter(Boolean).join('\n');
}

function buildModeratorSpeakNowMessage(participants) {
  const first = Array.isArray(participants) ? participants[0] : null;
  const mention = first?.agentId ? `@${first.agentId}` : '第一位议事 Agent 的 agentId';
  return [
    '停。不要再调用任何工具，不要 exec，不要读文件，不要排查系统。',
    '上一条任务书里的议题、底稿、名单和规则已经足够。',
    '现在只用一段文字回复：',
    '1. 向老大简短宣布议题和参与名单；',
    `2. 立刻 ${mention}，请对方只回答本次议题要决定的那一件事。`,
    '不要输出工具调用。',
  ].join('\n');
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
  isRepickMention,
  hasCountableParticipantSpeech,
  hasUsedRepick,
  excludeLatestParticipantSpeech,
  shouldSkipRelayMention,
  pickRelayMention,
  markModeratorMessageMentionsProcessed,
  buildParticipantGroupPrompt,
  buildModeratorContinuePrompt,
  buildModeratorIdlePrompt,
  buildModeratorIdleWatchdogPrompt,
  buildModeratorForceFinalSummaryPrompt,
  MEETING_ADJOURN_KEYWORD,
  hasMeetingAdjournedMarker,
  meetingAdjournInstruction,
  isMeetingCompleteText,
  isMeetingClosingMessage,
  isModeratorClosingMessage,
  isModeratorPostCloseStub,
  findFirstClosingModeratorIndex,
  hasUnprocessedModeratorMentions,
  hasClosingModeratorMessage,
  isFinalSummaryExpected,
  buildModeratorBriefingMessage,
  buildModeratorSpeakNowMessage,
  buildMeetingRequirementSections,
  buildPriorTopicsSection,
  extractMeetingFinalSummaryText,
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
