const { formatForwardForAgent } = require('./forward-format');
const {
  isMeetingClosingMessage,
  isModeratorPostCloseStub,
} = require('./meeting-protocol');

function isModeratorMessage(msg, moderatorAgentId) {
  if (!msg || msg.streaming) return false;
  if (msg.speakerLabel === '任务书') return false;
  if (msg.speakerAgentId !== moderatorAgentId) return false;
  if (msg.who !== 'me') return false;
  return true;
}

/** 仅「会议结束」等收尾套话、无实质总结内容 */
function isMeetingClosingStub(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (isModeratorPostCloseStub(t)) return true;
  if (t.length > 48) return false;
  const withoutMarkers = t.replace(/\*\*/g, '').trim();
  if (/^会议结束[。！!…]*$/i.test(withoutMarkers)) return true;
  if (/^讨论(圆满)?结束[。！!…]*$/i.test(withoutMarkers)) return true;
  return false;
}

function hasSubstantiveMeetingSummary(text) {
  const t = String(text || '').trim();
  if (!t || isMeetingClosingStub(t)) return false;
  if (/结论|共识|分歧|派活|下轮焦点|最终总结/i.test(t)) return true;
  return t.length >= 80;
}

function scoreModeratorSummary(text) {
  const t = String(text || '').trim();
  if (!t || isMeetingClosingStub(t) || isModeratorPostCloseStub(t)) return -1;
  let score = 0;
  if (/最终总结|🏁/.test(t)) score += 12;
  if (/\*\*结论\*\*|##\s*最终总结/i.test(t)) score += 8;
  if (/结论|共识/.test(t)) score += 5;
  if (/派活/.test(t)) score += 5;
  if (isMeetingClosingMessage(t)) score += 3;
  if (hasSubstantiveMeetingSummary(t)) score += 2;
  score += Math.min(t.length / 250, 6);
  return score;
}

function findModeratorFinalMessage(messages, moderatorAgentId) {
  if (!Array.isArray(messages) || !moderatorAgentId) return null;

  const modMsgs = [];
  for (const msg of messages) {
    if (!isModeratorMessage(msg, moderatorAgentId)) continue;
    const text = String(msg.text || '').trim();
    if (!text) continue;
    modMsgs.push({ msg, text });
  }
  if (modMsgs.length === 0) return null;

  let best = null;
  let bestScore = -1;
  for (let i = modMsgs.length - 1; i >= 0; i -= 1) {
    const { msg, text } = modMsgs[i];
    const score = scoreModeratorSummary(text);
    if (score > bestScore) {
      bestScore = score;
      best = msg;
    }
  }
  if (best && bestScore > 0) return best;

  for (let i = modMsgs.length - 1; i >= 0; i -= 1) {
    const { msg, text } = modMsgs[i];
    if (isMeetingClosingStub(text)) continue;
    if (hasSubstantiveMeetingSummary(text)) return msg;
  }

  for (let i = modMsgs.length - 1; i >= 0; i -= 1) {
    const { msg, text } = modMsgs[i];
    if (!isMeetingClosingStub(text)) return msg;
  }

  return modMsgs[modMsgs.length - 1].msg;
}

function buildMeetingExecForwardNote(goal) {
  const trimmedGoal = String(goal || '').trim();
  const parts = [];
  if (trimmedGoal) {
    parts.push(`期望结论方向：${trimmedGoal}`);
  }
  parts.push('请根据以上会议最终总结与留言要求执行工作。');
  return parts.join('\n');
}

function buildMeetingForwardPayload(config, finalMsg) {
  const forward = {
    who: 'them',
    authorLabel: config.moderatorLabel || config.moderatorAgentId || '主持 Agent',
    text: String(finalMsg.text || '').trim(),
    time: finalMsg.time || '',
  };
  return formatForwardForAgent(forward, buildMeetingExecForwardNote(config.goal));
}

module.exports = {
  findModeratorFinalMessage,
  buildMeetingForwardPayload,
  isMeetingClosingStub,
  hasSubstantiveMeetingSummary,
};
