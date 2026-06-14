/**
 * Shell 侧会议 transcript（UI 唯一数据源，与 Gateway main 私聊无关）
 */
function nowTimeLabel() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function createMeetingTranscript(config) {
  const moderatorId = config.moderatorAgentId;
  const moderatorLabel = config.moderatorLabel || moderatorId;
  /** @type {Array<object>} */
  const messages = [];
  let streamRunId = 0;

  function getMessages() {
    return messages.map((m) => ({ ...m, streaming: false }));
  }

  function getMessagesMutable() {
    return messages;
  }

  function finalizeStreaming() {
    for (const m of messages) {
      if (m.streaming) m.streaming = false;
    }
  }

  function appendBriefing(text) {
    if (!String(text || '').trim()) return;
    messages.push({
      who: 'me',
      text: String(text).trim(),
      time: nowTimeLabel(),
      streaming: false,
      speakerLabel: '任务书',
      meeting: true,
    });
  }

  function upsertModeratorStream(text, { streaming = true } = {}) {
    const trimmed = String(text || '');
    let target = [...messages].reverse().find(
      (m) => m.streaming && m.who === 'me' && m.speakerAgentId === moderatorId,
    );
    if (!target) {
      streamRunId += 1;
      target = {
        who: 'me',
        text: trimmed,
        time: nowTimeLabel(),
        streaming,
        runId: streamRunId,
        speakerAgentId: moderatorId,
        speakerLabel: moderatorLabel,
        meeting: true,
      };
      messages.push(target);
    } else {
      target.text = trimmed;
      target.streaming = streaming;
    }
    return target;
  }

  function appendModerator(text) {
    finalizeStreaming();
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    messages.push({
      who: 'me',
      text: trimmed,
      time: nowTimeLabel(),
      streaming: false,
      speakerAgentId: moderatorId,
      speakerLabel: moderatorLabel,
      meeting: true,
    });
  }

  function appendParticipant({ agentId, label, text }) {
    finalizeStreaming();
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const catalogEntry = (config.agentCatalog || []).find((a) => a.id === agentId);
    const resolvedLabel = catalogEntry?.label || catalogEntry?.name || label || agentId;
    messages.push({
      who: 'them',
      text: trimmed,
      time: nowTimeLabel(),
      streaming: false,
      speakerAgentId: agentId,
      speakerLabel: resolvedLabel,
      meeting: true,
    });
  }

  function formatForPrompt(options = {}) {
    const maxMessageChars = Number(options.maxMessageChars) || 0;
    const maxTotalChars = Number(options.maxTotalChars) || 0;
    const source = messages.filter((m) => m.text?.trim() && !m.streaming);
    const list = maxTotalChars > 0 && source.length > 48 ? source.slice(-48) : source;
    const blocks = [];
    let total = 0;
    for (const m of list) {
      let body = m.text.trim();
      if (maxMessageChars > 0 && body.length > maxMessageChars) {
        body = `${body.slice(0, maxMessageChars)}…（已截断）`;
      }
      const label = m.speakerLabel || (m.who === 'me' ? '主持' : 'Agent');
      const block = `【${label}】\n${body}`;
      if (maxTotalChars > 0 && total + block.length > maxTotalChars) break;
      blocks.push(block);
      total += block.length;
    }
    return blocks.join('\n\n');
  }

  return {
    getMessages,
    getMessagesMutable,
    finalizeStreaming,
    appendBriefing,
    upsertModeratorStream,
    appendModerator,
    appendParticipant,
    formatForPrompt,
  };
}

module.exports = {
  createMeetingTranscript,
};
