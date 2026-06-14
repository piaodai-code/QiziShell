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
  buildModeratorIdleWatchdogPrompt,
  buildModeratorForceFinalSummaryPrompt,
  isMeetingCompleteText,
  isMeetingClosingMessage,
  isModeratorClosingMessage,
  hasClosingModeratorMessage,
  capMeetingSpeech,
  capModeratorSpeech,
  resolveModeratorSpeechMode,
  computeMaxRelayTurns,
  normalizeRoundCount,
  resolveRosterLabel,
  MEETING_MODERATOR_HARD_CHARS,
  MEETING_PARTICIPANT_HARD_CHARS,
  MEETING_MODERATOR_FINAL_SOFT_CHARS,
  MEETING_MODERATOR_FINAL_HARD_CHARS,
  MEETING_TRANSCRIPT_MSG_CHARS,
  MEETING_TRANSCRIPT_TOTAL_CHARS,
} = require('./meeting-protocol');

const RELAY_POLL_MS = 1500;
const PARTICIPANT_TURN_TIMEOUT_MS = 180_000;
const MODERATOR_NUDGE_TIMEOUT_MS = 180_000;
const STALE_PARTICIPANT_LOOPS_MAX = 4;
const MEETING_IDLE_WATCHDOG_MS = 120_000;
const MEETING_IDLE_WATCHDOG_SUMMARY_MS = 180_000;
const MEETING_IDLE_MAX_STRIKES = 3;
const MEETING_IDLE_END_REASON = '长时间无议事 Agent 反馈，已强制提前总结并结束会议';

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
  let staleParticipantLoops = 0;
  let lastParticipantActivityAt = Date.now();
  let idleWatchdogStrikes = 0;
  let lastWatchdogAt = 0;
  let inFlightTurn = false;
  let endedEarly = false;
  let endReason = '';

  function touchParticipantActivity() {
    lastParticipantActivityAt = Date.now();
    idleWatchdogStrikes = 0;
    lastWatchdogAt = 0;
  }

  function getIdleWatchdogThresholdMs(visible) {
    const speechMode = resolveModeratorSpeechMode(
      visible,
      roster,
      config.moderatorAgentId,
      roundCount,
    );
    if (speechMode.kind === 'round_summary' || speechMode.kind === 'final_summary') {
      return MEETING_IDLE_WATCHDOG_SUMMARY_MS;
    }
    return MEETING_IDLE_WATCHDOG_MS;
  }

  function isIdleWatchdogPaused() {
    if (inFlightTurn) return true;
    return transcript.getMessages().some((m) => m.streaming);
  }

  async function maybeHandleIdleWatchdog(visible) {
    if (isIdleWatchdogPaused()) return 'continue';

    const messages = visible || transcript.getMessages();
    if (findNextMention(messages, roster, processedMentionKeys, config.moderatorAgentId)) {
      return 'continue';
    }

    const threshold = getIdleWatchdogThresholdMs(messages);
    const now = Date.now();
    const sinceParticipant = now - lastParticipantActivityAt;
    if (sinceParticipant < threshold) return 'continue';
    if (lastWatchdogAt && (now - lastWatchdogAt) < threshold) return 'continue';

    idleWatchdogStrikes += 1;
    const strike = idleWatchdogStrikes;
    lastWatchdogAt = now;

    if (strike > MEETING_IDLE_MAX_STRIKES) {
      onEvent?.({
        type: 'idle_watchdog_force_end',
        payload: {
          strike,
          maxStrikes: MEETING_IDLE_MAX_STRIKES,
          idleMs: sinceParticipant,
          endReason: MEETING_IDLE_END_REASON,
        },
      });
      await runModeratorNudge({
        reason: 'idle_force_final',
        buildPrompt: buildModeratorForceFinalSummaryPrompt,
        visible: messages,
        speechMode: {
          kind: 'final_summary',
          softChars: MEETING_MODERATOR_FINAL_SOFT_CHARS,
          hardChars: MEETING_MODERATOR_FINAL_HARD_CHARS,
        },
        lastSpeakerLabel: '',
        extraPromptArgs: {
          idleMs: sinceParticipant,
          endReason: MEETING_IDLE_END_REASON,
        },
      });
      endedEarly = true;
      endReason = MEETING_IDLE_END_REASON;
      return 'break';
    }

    onEvent?.({
      type: 'idle_watchdog',
      payload: {
        strike,
        maxStrikes: MEETING_IDLE_MAX_STRIKES,
        idleMs: sinceParticipant,
      },
    });

    const speechMode = resolveModeratorSpeechMode(
      messages,
      roster,
      config.moderatorAgentId,
      roundCount,
    );
    await runModeratorNudge({
      reason: 'idle_watchdog',
      buildPrompt: buildModeratorIdleWatchdogPrompt,
      visible: messages,
      speechMode,
      lastSpeakerLabel: '',
      extraPromptArgs: {
        strike,
        maxStrikes: MEETING_IDLE_MAX_STRIKES,
        idleMs: sinceParticipant,
      },
    });
    return 'continue';
  }

  async function endLoopIteration({ skipWatchdog = false } = {}) {
    if (!skipWatchdog) {
      const wd = await maybeHandleIdleWatchdog(transcript.getMessages());
      if (wd === 'break') return 'break';
    }
    await sleep(RELAY_POLL_MS);
    return 'continue';
  }

  async function runModeratorNudge({
    reason,
    buildPrompt,
    visible,
    speechMode,
    lastSpeakerLabel,
    extraPromptArgs = {},
  }) {
    onEvent?.({ type: 'moderator_nudge', payload: { reason } });
    inFlightTurn = true;
    try {
      const nudgeReply = chatTurnText(await chatTurnStream(
        moderatorSessionKey,
        buildPrompt({
          transcript: transcript.formatForPrompt(promptTranscriptOpts),
          lastSpeakerLabel,
          roster,
          spokenAgentIds: collectSpokenAgentIds(visible),
          messages: visible,
          roundCount,
          moderatorAgentId: config.moderatorAgentId,
          speechKind: speechMode.kind,
          softChars: speechMode.softChars,
          hardChars: speechMode.hardChars,
          ...extraPromptArgs,
        }),
        {
          timeoutMs: MODERATOR_NUDGE_TIMEOUT_MS,
          onDelta: (text) => {
            transcript.upsertModeratorStream(text, { streaming: true });
            emitTranscript();
            onEvent?.({ type: 'moderator_delta', payload: { text } });
          },
        },
      ));
      transcript.finalizeStreaming();
      if (!nudgeReply) {
        onEvent?.({
          type: 'moderator_nudge_empty',
          payload: { reason },
        });
        return false;
      }
      const trimmedNudge = capModeratorSpeech(
        nudgeReply,
        visible,
        roster,
        config.moderatorAgentId,
        roundCount,
      );
      if (!trimmedNudge) {
        onEvent?.({
          type: 'moderator_nudge_empty',
          payload: { reason },
        });
        return false;
      }
      const mutable = transcript.getMessagesMutable();
      const tail = mutable[mutable.length - 1];
      if (tail?.speakerAgentId === config.moderatorAgentId) {
        tail.text = trimmedNudge;
        tail.streaming = false;
      } else {
        transcript.appendModerator(trimmedNudge);
      }
      emitTranscript();
      return true;
    } catch (err) {
      transcript.finalizeStreaming();
      emitTranscript();
      onEvent?.({
        type: 'moderator_nudge_error',
        payload: { reason, error: err?.message || String(err) },
      });
      return false;
    } finally {
      inFlightTurn = false;
    }
  }

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
      inFlightTurn = true;
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
      } finally {
        inFlightTurn = false;
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
        if (await endLoopIteration() === 'break') break;
        continue;
      }

      transcript.appendParticipant({
        agentId: pending.agentId,
        label: resolveRosterLabel(roster, pending.agentId),
        text: replyText,
      });
      emitTranscript();
      touchParticipantActivity();

      onEvent?.({
        type: 'participant_turn_end',
        payload: { agentId: pending.agentId, label: pending.label, text: replyText },
      });

      if (await endLoopIteration({ skipWatchdog: true }) === 'break') break;
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

    if (messages.some((m) => m.streaming)) {
      if (await endLoopIteration({ skipWatchdog: true }) === 'break') break;
      continue;
    }

    const visible = transcript.getMessages();
    const last = visible[visible.length - 1];

    const lastIsParticipant = last
      && last.who === 'them'
      && last.speakerAgentId
      && last.speakerAgentId !== config.moderatorAgentId;

    const lastIsModerator = last
      && last.who === 'me'
      && last.speakerAgentId === config.moderatorAgentId
      && last.speakerLabel !== '任务书';

    if (lastIsParticipant) {
      if (!nudgedAfterParticipant) {
        lastNudgedMessageIndex = -1;
        const speechMode = resolveModeratorSpeechMode(
          visible,
          roster,
          config.moderatorAgentId,
          roundCount,
        );
        const ok = await runModeratorNudge({
          reason: 'after_participant',
          buildPrompt: buildModeratorContinuePrompt,
          visible,
          speechMode,
          lastSpeakerLabel: resolveRosterLabel(roster, last.speakerAgentId),
        });
        nudgedAfterParticipant = ok;
        staleParticipantLoops = ok ? 0 : staleParticipantLoops + 1;
        if (!ok && staleParticipantLoops >= STALE_PARTICIPANT_LOOPS_MAX) {
          nudgedAfterParticipant = false;
          staleParticipantLoops = 0;
        }
        if (await endLoopIteration({ skipWatchdog: true }) === 'break') break;
        continue;
      }
      staleParticipantLoops += 1;
      if (staleParticipantLoops >= STALE_PARTICIPANT_LOOPS_MAX) {
        nudgedAfterParticipant = false;
        staleParticipantLoops = 0;
      }
      if (await endLoopIteration() === 'break') break;
      continue;
    }

    staleParticipantLoops = 0;

    if (lastIsModerator) {
      if (isModeratorClosingMessage(
        last.text,
        roster,
        config.moderatorAgentId,
        roundCount,
        visible,
      )) {
        break;
      }
      const lastIndex = visible.length - 1;
      if (lastNudgedMessageIndex !== lastIndex) {
        lastNudgedMessageIndex = lastIndex;
        nudgedAfterParticipant = false;
        const speechMode = resolveModeratorSpeechMode(
          visible,
          roster,
          config.moderatorAgentId,
          roundCount,
        );
        const ok = await runModeratorNudge({
          reason: 'idle',
          buildPrompt: buildModeratorIdlePrompt,
          visible,
          speechMode,
          lastSpeakerLabel: '',
        });
        if (!ok) {
          lastNudgedMessageIndex = -1;
        }
        if (await endLoopIteration({ skipWatchdog: true }) === 'break') break;
        continue;
      }
    }

    if (await endLoopIteration() === 'break') break;
  }

  transcript.finalizeStreaming();
  emitTranscript();

  const finalMessages = transcript.getMessages();
  const record = {
    id: meetingId,
    mode: 'a2a_transcript_v1',
    state: endedEarly ? 'DONE_EARLY_IDLE' : 'DONE',
    endReason: endedEarly ? endReason : '',
    topic: config.topic,
    draft: config.draft,
    goal: config.goal || '',
    postMeetingExecAgentId: config.postMeetingExecAgentId || '',
    roundCount,
    moderatorAgentId: config.moderatorAgentId,
    moderatorLabel: config.moderatorLabel || config.moderatorAgentId,
    participantAgentIds: [...config.participantAgentIds],
    agentCatalog: Array.isArray(config.agentCatalog) ? config.agentCatalog : [],
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
    payload: {
      meetingId,
      recordPath,
      sessionKey: moderatorSessionKey,
      messages: finalMessages,
      state: endedEarly ? 'DONE_EARLY_IDLE' : 'DONE',
      endReason: endedEarly ? endReason : '',
      endedEarly,
    },
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
    const mention = pickRelayMention(text, mentions, messages, roster, moderatorAgentId, i);
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
