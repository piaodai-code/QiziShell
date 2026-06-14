const crypto = require('crypto');
const { buildMeetingSessionKey, buildModeratorBriefingMessage } = require('./meeting-protocol');

/**
 * 主持驱动模式：Shell 只发送「会议任务书」，由主持 Agent 在 Gateway 内推进会议。
 */
async function startMeetingBriefing(config, deps) {
  const {
    chatTurn,
    chatTurnStream,
    onEvent,
    saveRecord,
    isCancelled,
  } = deps;

  validateBriefingConfig(config);
  onEvent?.({ type: 'preparing', payload: {} });

  const participants = config.participantAgentIds.map((agentId) => {
    const meta = (config.agentCatalog || []).find((a) => a.id === agentId);
    return {
      agentId,
      label: meta?.label || meta?.name || agentId,
    };
  });

  const moderatorMeta = (config.agentCatalog || []).find((a) => a.id === config.moderatorAgentId);
  const briefingMessage = buildModeratorBriefingMessage({
    topic: config.topic,
    draft: config.draft,
    goal: config.goal,
    moderator: {
      agentId: config.moderatorAgentId,
      label: config.moderatorLabel || moderatorMeta?.label || config.moderatorAgentId,
    },
    participants,
  });

  const meetingId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const sessionKey = buildMeetingSessionKey(config.moderatorAgentId, meetingId);

  onEvent?.({
    type: 'briefing_ready',
    payload: { meetingId, sessionKey, briefingMessage },
  });

  if (isCancelled?.()) {
    throw new Error('会议已取消');
  }

  onEvent?.({ type: 'briefing_sending', payload: { sessionKey } });

  let moderatorReply = '';
  if (typeof chatTurnStream === 'function') {
    moderatorReply = await chatTurnStream(sessionKey, briefingMessage, {
      onDelta: (text) => {
        onEvent?.({ type: 'moderator_delta', payload: { text } });
      },
    });
  } else {
    const result = await chatTurn(sessionKey, briefingMessage);
    moderatorReply = result.text || '';
    onEvent?.({ type: 'moderator_delta', payload: { text: moderatorReply } });
  }

  const record = {
    id: meetingId,
    mode: 'moderator_briefing_v1',
    state: 'BRIEFING_SENT',
    topic: config.topic,
    draft: config.draft,
    goal: config.goal || '',
    moderatorAgentId: config.moderatorAgentId,
    participantAgentIds: [...config.participantAgentIds],
    sessionKey,
    briefingMessage,
    moderatorReply,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  let recordPath = null;
  try {
    recordPath = saveRecord(record);
  } catch (err) {
    onEvent?.({ type: 'record_error', payload: { error: err.message || String(err) } });
  }

  onEvent?.({
    type: 'done',
    payload: { meetingId, recordPath, moderatorReply },
  });

  return { ok: true, record, recordPath };
}

function validateBriefingConfig(config) {
  if (!config?.topic?.trim()) throw new Error('请填写议题');
  if (!config?.draft?.trim()) throw new Error('请填写讨论底稿');
  if (!config?.moderatorAgentId) throw new Error('请选择主持 Agent');
  if (!Array.isArray(config.participantAgentIds) || config.participantAgentIds.length === 0) {
    throw new Error('请至少选择一名议事 Agent');
  }
  if (config.participantAgentIds.includes(config.moderatorAgentId)) {
    throw new Error('主持 Agent 不应出现在议事列表中');
  }
}

module.exports = {
  startMeetingBriefing,
};
