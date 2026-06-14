const crypto = require('crypto');
const { createMeetingTranscript } = require('./meeting-transcript');
const {
  buildMeetingSessionKey,
  buildModeratorBriefingMessage,
  parseMeetingMentions,
  pickRelayMention,
  markModeratorMessageMentionsProcessed,
  buildParticipantGroupPrompt,
  buildModeratorContinuePrompt,
  buildModeratorIdlePrompt,
  isMeetingCompleteText,
  isMeetingClosingMessage,
  hasClosingModeratorMessage,
  capMeetingSpeech,
  capModeratorSpeech,
  resolveModeratorSpeechMode,
  computeMaxRelayTurns,
  normalizeRoundCount,
  resolveRosterLabel,
  MEETING_MODERATOR_HARD_CHARS,
  MEETING_PARTICIPANT_HARD_CHARS,
  MEETING_TRANSCRIPT_MSG_CHARS,
  MEETING_TRANSCRIPT_TOTAL_CHARS,
} = require('./meeting-protocol');

const RELAY_POLL_MS = 1500;
const PARTICIPANT_TURN_TIMEOUT_MS = 180_000;

function chatTurnText(result) {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result.text === 'string') return result.text.trim();
  return String(result?.text ?? '').trim();
}

/**
 * A2A 会议 relay + Shell transcript
 * - 后台：agent:{id}:a2a:qizi-{meetingId}（绝不写 main）
 * - 前台：transcript 事件驱动群聊气泡
 */
async function startMeetingGroupRelay(config, deps) {
  const {
    chatTurn,
    chatTurnStream,
    onEvent,
    saveRecord,
    isCancelled,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;

  validateRelayConfig(config);
  onEvent?.({ type: 'preparing', payload: {} });

  const roundCount = normalizeRoundCount(config.roundCount);
  const maxRelayTurns = computeMaxRelayTurns(config);
  const promptTranscriptOpts = {
    maxMessageChars: MEETING_TRANSCRIPT_MSG_CHARS,
    maxTotalChars: MEETING_TRANSCRIPT_TOTAL_CHARS,
  };

  const meetingId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const moderatorSessionKey = buildMeetingSessionKey(config.moderatorAgentId, meetingId);
  const roster = buildRoster(config);
  const transcript = createMeetingTranscript(config);

  const emitTranscript = () => {
    onEvent?.({ type: 'transcript', payload: { messages: transcript.getMessages() } });
  };

  const briefingMessage = buildModeratorBriefingMessage({
    topic: config.topic,
    draft: config.draft,
    goal: config.goal,
    roundCount,
    moderator: {
      agentId: config.moderatorAgentId,
      label: config.moderatorLabel || config.moderatorAgentId,
    },
    participants: roster,
  });

  onEvent?.({
    type: 'briefing_ready',
    payload: { meetingId, sessionKey: moderatorSessionKey, briefingMessage },
  });

  if (isCancelled?.()) throw new Error('会议已取消');

  transcript.appendBriefing(briefingMessage);
  emitTranscript();

  onEvent?.({ type: 'briefing_sending', payload: { sessionKey: moderatorSessionKey } });

  let moderatorReply = '';
  if (typeof chatTurnStream === 'function') {
    const streamResult = await chatTurnStream(moderatorSessionKey, briefingMessage, {
      onDelta: (text) => {
        transcript.upsertModeratorStream(text, { streaming: true });
        emitTranscript();
        onEvent?.({ type: 'moderator_delta', payload: { text } });
      },
    });
    moderatorReply = chatTurnText(streamResult);
  } else {
    const result = await chatTurn(moderatorSessionKey, briefingMessage);
    moderatorReply = result.text || '';
    transcript.appendModerator(moderatorReply);
    emitTranscript();
    onEvent?.({ type: 'moderator_delta', payload: { text: moderatorReply } });
  }

  transcript.finalizeStreaming();
  if (moderatorReply) {
    moderatorReply = capMeetingSpeech(moderatorReply, MEETING_MODERATOR_HARD_CHARS);
    const last = transcript.getMessagesMutable().slice(-1)[0];
    if (last?.streaming || last?.speakerAgentId === config.moderatorAgentId) {
      last.text = moderatorReply;
      last.streaming = false;
    }
  }
  emitTranscript();

  if (isCancelled?.()) throw new Error('会议已取消');

  onEvent?.({ type: 'relay_started', payload: { sessionKey: moderatorSessionKey } });

  const processedMentionKeys = new Set();
  let relayTurns = 0;
  let nudgedAfterParticipant = false;
  let lastNudgedMessageIndex = -1;

  while (!isCancelled?.()) {
    relayTurns += 1;
    if (relayTurns > maxRelayTurns) {
      throw new Error(`会议 relay 超过安全上限（${maxRelayTurns}），已停止`);
    }

    const messages = transcript.getMessagesMutable();

    const pending = findNextMention(messages, roster, processedMentionKeys, config.moderatorAgentId);

    if (pending) {
      nudgedAfterParticipant = false;
      const msgText = messages[pending.messageIndex]?.text || '';

      onEvent?.({
        type: 'participant_turn_start',
        payload: {
          agentId: pending.agentId,
          label: resolveRosterLabel(roster, pending.agentId),
        },
      });

      const participantSessionKey = buildMeetingSessionKey(pending.agentId, meetingId);
      const prompt = buildParticipantGroupPrompt({
        topic: config.topic,
        draft: config.draft,
        agentId: pending.agentId,
        agentLabel: pending.label,
        instruction: pending.instruction,
        transcript: transcript.formatForPrompt(promptTranscriptOpts),
        groupSessionKey: participantSessionKey,
      });

      let replyText = '';
      try {
        const result = await chatTurn(participantSessionKey, prompt, {
          timeoutMs: PARTICIPANT_TURN_TIMEOUT_MS,
        });
        replyText = String(result?.text || '').trim();
        replyText = capMeetingSpeech(replyText, MEETING_PARTICIPANT_HARD_CHARS);
      } catch (err) {
        onEvent?.({
          type: 'participant_turn_error',
          payload: {
            agentId: pending.agentId,
            label: pending.label,
            error: err?.message || String(err),
          },
        });
      }

      markModeratorMessageMentionsProcessed(
        pending.messageIndex,
        msgText,
        roster,
        config.moderatorAgentId,
        processedMentionKeys,
      );

      if (!replyText) {
        onEvent?.({
          type: 'participant_turn_empty',
          payload: { agentId: pending.agentId, label: pending.label },
        });
        await sleep(RELAY_POLL_MS);
        continue;
      }

      transcript.appendParticipant({
        agentId: pending.agentId,
        label: resolveRosterLabel(roster, pending.agentId),
        text: replyText,
      });
      emitTranscript();

      onEvent?.({
        type: 'participant_turn_end',
        payload: { agentId: pending.agentId, label: pending.label, text: replyText },
      });

      await sleep(RELAY_POLL_MS);
      continue;
    }

    if (hasClosingModeratorMessage(
      messages,
      config.moderatorAgentId,
      roster,
      processedMentionKeys,
      roundCount,
    )) {
      break;
    }

    const visible = transcript.getMessages();
    const last = visible[visible.length - 1];

    if (messages.some((m) => m.streaming)) {
      await sleep(RELAY_POLL_MS);
      continue;
    }

    const lastIsParticipant = last
      && last.who === 'them'
      && last.speakerAgentId
      && last.speakerAgentId !== config.moderatorAgentId;

    const lastIsModerator = last
      && last.who === 'me'
      && last.speakerAgentId === config.moderatorAgentId
      && last.speakerLabel !== '任务书';

    if (lastIsParticipant && !nudgedAfterParticipant) {
      nudgedAfterParticipant = true;
      lastNudgedMessageIndex = -1;
      const spokenAgentIds = collectSpokenAgentIds(visible);
      const transcriptText = transcript.formatForPrompt(promptTranscriptOpts);
      const speechMode = resolveModeratorSpeechMode(
        visible,
        roster,
        config.moderatorAgentId,
        roundCount,
      );
      onEvent?.({
        type: 'moderator_nudge',
        payload: { reason: 'after_participant' },
      });
      const nudgeReply = chatTurnText(await chatTurnStream(
        moderatorSessionKey,
        buildModeratorContinuePrompt({
          transcript: transcriptText,
          lastSpeakerLabel: resolveRosterLabel(roster, last.speakerAgentId),
          roster,
          spokenAgentIds,
          messages: visible,
          roundCount,
          speechKind: speechMode.kind,
          softChars: speechMode.softChars,
          hardChars: speechMode.hardChars,
        }),
        {
          onDelta: (text) => {
            transcript.upsertModeratorStream(text, { streaming: true });
            emitTranscript();
            onEvent?.({ type: 'moderator_delta', payload: { text } });
          },
        },
      ));
      transcript.finalizeStreaming();
      if (nudgeReply) {
        const trimmedNudge = capModeratorSpeech(
          nudgeReply,
          visible,
          roster,
          config.moderatorAgentId,
          roundCount,
        );
        const mutable = transcript.getMessagesMutable();
        const tail = mutable[mutable.length - 1];
        if (tail?.speakerAgentId === config.moderatorAgentId) {
          tail.text = trimmedNudge;
          tail.streaming = false;
        } else {
          transcript.appendModerator(trimmedNudge);
        }
      }
      emitTranscript();
      await sleep(RELAY_POLL_MS);
      continue;
    }

    if (lastIsModerator) {
      const lastIndex = visible.length - 1;
      if (lastNudgedMessageIndex !== lastIndex) {
        lastNudgedMessageIndex = lastIndex;
        nudgedAfterParticipant = false;
        const spokenAgentIds = collectSpokenAgentIds(visible);
        const transcriptText = transcript.formatForPrompt(promptTranscriptOpts);
        const speechMode = resolveModeratorSpeechMode(
          visible,
          roster,
          config.moderatorAgentId,
          roundCount,
        );
        onEvent?.({ type: 'moderator_nudge', payload: { reason: 'idle' } });
        const nudgeReply = chatTurnText(await chatTurnStream(
          moderatorSessionKey,
          buildModeratorIdlePrompt({
            transcript: transcriptText,
            roster,
            spokenAgentIds,
            messages: visible,
            roundCount,
            speechKind: speechMode.kind,
            softChars: speechMode.softChars,
            hardChars: speechMode.hardChars,
          }),
          {
            onDelta: (text) => {
              transcript.upsertModeratorStream(text, { streaming: true });
              emitTranscript();
              onEvent?.({ type: 'moderator_delta', payload: { text } });
            },
          },
        ));
        transcript.finalizeStreaming();
        if (nudgeReply) {
          const trimmedNudge = capModeratorSpeech(
            nudgeReply,
            visible,
            roster,
            config.moderatorAgentId,
            roundCount,
          );
          const mutable = transcript.getMessagesMutable();
          const tail = mutable[mutable.length - 1];
          if (tail?.speakerAgentId === config.moderatorAgentId) {
            tail.text = trimmedNudge;
            tail.streaming = false;
          } else {
            transcript.appendModerator(trimmedNudge);
          }
        }
        emitTranscript();
        await sleep(RELAY_POLL_MS);
        continue;
      }
    }

    await sleep(RELAY_POLL_MS);
  }

  transcript.finalizeStreaming();
  emitTranscript();

  const finalMessages = transcript.getMessages();
  const record = {
    id: meetingId,
    mode: 'a2a_transcript_v1',
    state: 'DONE',
    topic: config.topic,
    draft: config.draft,
    goal: config.goal || '',
    roundCount,
    moderatorAgentId: config.moderatorAgentId,
    participantAgentIds: [...config.participantAgentIds],
    sessionKey: moderatorSessionKey,
    briefingMessage,
    moderatorReply,
    transcript: finalMessages,
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
    payload: { meetingId, recordPath, sessionKey: moderatorSessionKey, messages: finalMessages },
  });

  return { ok: true, record, recordPath };
}

function buildRoster(config) {
  return config.participantAgentIds.map((agentId) => {
    const entry = (config.agentCatalog || []).find((a) => a.id === agentId);
    return {
      agentId,
      label: entry?.label || entry?.name || agentId,
    };
  });
}

function collectSpokenAgentIds(messages) {
  return (messages || [])
    .filter((m) => m.who === 'them' && m.speakerAgentId)
    .map((m) => m.speakerAgentId);
}

function findNextMention(messages, roster, processed, moderatorAgentId) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.streaming) continue;
    if (msg.speakerLabel === '任务书') continue;
    if (msg.speakerAgentId !== moderatorAgentId) continue;
    const text = msg?.text || '';
    if (!text.trim()) continue;

    const mentions = parseMeetingMentions(text, roster, moderatorAgentId);
    const mention = pickRelayMention(text, mentions, messages, roster, moderatorAgentId);
    if (!mention) {
      for (const skipped of mentions) {
        processed.add(`${i}:${skipped.agentId}`);
      }
      continue;
    }

    const key = `${i}:${mention.agentId}`;
    if (processed.has(key)) continue;

    return {
      messageIndex: i,
      agentId: mention.agentId,
      label: resolveRosterLabel(roster, mention.agentId),
      instruction: mention.instruction || text,
    };
  }
  return null;
}

function validateRelayConfig(config) {
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
  startMeetingGroupRelay,
};
