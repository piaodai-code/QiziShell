const crypto = require('crypto');
const {
  MEETING_STATES,
  MAX_JSON_RETRIES,
  buildMeetingSessionKey,
  extractJsonFromText,
  validateDeliberantOutput,
  validateModeratorSummary,
  buildModeratorInitPrompt,
  buildModeratorDispatchPrompt,
  buildDeliberantPrompt,
  buildModeratorRoundSummaryPrompt,
  buildExecDispatchPrompt,
  buildDeliberantRetryPrompt,
} = require('./meeting-protocol');

const TURN_TIMEOUT_MS = 120_000;

class MeetingEngine {
  /**
   * @param {{ chatTurn: Function, onEvent: Function, saveRecord: Function }} deps
   */
  constructor(deps) {
    this.chatTurn = deps.chatTurn;
    this.onEvent = deps.onEvent || (() => {});
    this.saveRecord = deps.saveRecord || (() => null);
    this.meeting = null;
    this.running = false;
    this.cancelRequested = false;
  }

  getSnapshot() {
    if (!this.meeting) {
      return { state: MEETING_STATES.IDLE, running: this.running };
    }
    return {
      ...this.meeting,
      running: this.running,
      cancelRequested: this.cancelRequested,
    };
  }

  cancel() {
    this.cancelRequested = true;
    this.emit('cancel_requested', {});
  }

  async start(config) {
    if (this.running) {
      throw new Error('已有会议在进行中');
    }
    this.validateConfig(config);
    this.running = true;
    this.cancelRequested = false;
    this.meeting = {
      id: crypto.randomUUID(),
      state: MEETING_STATES.INIT,
      topic: config.topic.trim(),
      goal: config.goal?.trim() || '',
      moderatorAgentId: config.moderatorAgentId,
      moderatorLabel: config.moderatorLabel || config.moderatorAgentId,
      assigneeAgentId: config.assigneeAgentId || null,
      deliberants: config.deliberants.map((d) => ({
        agentId: d.agentId,
        agentLabel: d.agentLabel || d.agentId,
        role: d.role.trim(),
        roleLabel: d.roleLabel?.trim() || d.role.trim(),
      })),
      round: 0,
      summaries: {},
      speeches: {},
      log: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      recordPath: null,
    };
    this.emit('started', { meeting: this.publicMeeting() });
    try {
      await this.runMeetingLoop();
    } catch (err) {
      this.meeting.state = MEETING_STATES.ERROR;
      this.meeting.error = err.message || String(err);
      this.emit('error', { error: this.meeting.error });
      this.finalizeRecord();
    } finally {
      this.running = false;
    }
    return this.getSnapshot();
  }

  validateConfig(config) {
    if (!config?.topic?.trim()) throw new Error('请填写议题');
    if (!config?.moderatorAgentId) throw new Error('请选择主持 Agent');
    if (!Array.isArray(config.deliberants) || config.deliberants.length === 0) {
      throw new Error('请至少添加一名议事 Agent');
    }
    for (const d of config.deliberants) {
      if (!d.agentId || !d.role?.trim()) {
        throw new Error('议事 Agent 需指定 agent 与身份 role');
      }
    }
  }

  publicMeeting() {
    const m = this.meeting;
    return {
      id: m.id,
      state: m.state,
      topic: m.topic,
      goal: m.goal,
      round: m.round,
      moderatorAgentId: m.moderatorAgentId,
      deliberants: m.deliberants,
      summaries: m.summaries,
      log: m.log,
      startedAt: m.startedAt,
      finishedAt: m.finishedAt,
      recordPath: m.recordPath,
      error: m.error || null,
    };
  }

  emit(type, payload) {
    this.onEvent({ type, payload, meeting: this.meeting ? this.publicMeeting() : null });
  }

  log(entry) {
    const item = { at: new Date().toISOString(), ...entry };
    this.meeting.log.push(item);
    this.emit('log', { entry: item });
  }

  setState(state) {
    this.meeting.state = state;
    this.emit('state', { state });
  }

  checkCancelled() {
    if (this.cancelRequested) {
      throw new Error('会议已取消');
    }
  }

  async runMeetingLoop() {
    await this.runInit();
    for (let round = 1; round <= 3; round += 1) {
      this.checkCancelled();
      this.meeting.round = round;
      await this.runRoundDispatch(round);
      this.checkCancelled();
      const isFinal = round === 3;
      await this.runRoundSummary(round, { finalRound: isFinal });
      if (isFinal) {
        await this.runDispatchExec();
        this.setState(MEETING_STATES.DONE);
        this.meeting.finishedAt = new Date().toISOString();
        this.finalizeRecord();
        this.emit('done', { recordPath: this.meeting.recordPath });
        return;
      }
      this.checkCancelled();
      await this.runRoundFeedback(round);
    }
  }

  async runInit() {
    this.setState(MEETING_STATES.INIT);
    const prompt = buildModeratorInitPrompt({
      topic: this.meeting.topic,
      goal: this.meeting.goal,
      deliberants: this.meeting.deliberants,
      moderatorLabel: this.meeting.moderatorLabel,
    });
    const raw = await this.askAgent(this.meeting.moderatorAgentId, prompt, { kind: 'moderator' });
    const parsed = extractJsonFromText(raw);
    this.log({
      kind: 'moderator_open',
      agentId: this.meeting.moderatorAgentId,
      raw,
      parsed,
    });
    this.setState(MEETING_STATES.ROUND_1_DISPATCH);
  }

  async runRoundDispatch(round) {
    this.setState(`ROUND_${round}_DISPATCH`);
    const key = `round_${round}`;
    this.meeting.speeches[key] = [];
    for (const deliberant of this.meeting.deliberants) {
      this.checkCancelled();
      const dispatchPrompt = buildModeratorDispatchPrompt({
        round,
        phase: 'dispatch',
        topic: this.meeting.topic,
        target: deliberant,
        deliberants: this.meeting.deliberants,
        summaries: this.meeting.summaries,
      });
      const dispatchRaw = await this.askAgent(this.meeting.moderatorAgentId, dispatchPrompt, {
        kind: 'moderator_dispatch',
        round,
      });
      const dispatchJson = extractJsonFromText(dispatchRaw);
      const instruction = dispatchJson?.instruction || dispatchRaw;
      this.log({
        kind: 'dispatch',
        round,
        targetAgentId: deliberant.agentId,
        instruction,
        raw: dispatchRaw,
      });

      const deliberantPrompt = buildDeliberantPrompt({
        round,
        phase: 'dispatch',
        topic: this.meeting.topic,
        role: deliberant.role,
        roleLabel: deliberant.roleLabel,
        instruction,
        context: this.summariesForRound(round),
      });
      const speech = await this.askDeliberant(deliberant, deliberantPrompt, { round, phase: 'dispatch' });
      this.meeting.speeches[key].push(speech);
    }
    this.setState(`ROUND_${round}_SUMMARY`);
  }

  async runRoundSummary(round, { finalRound = false } = {}) {
    this.setState(`ROUND_${round}_SUMMARY`);
    const speeches = this.meeting.speeches[`round_${round}`] || [];
    const prompt = buildModeratorRoundSummaryPrompt({
      round,
      topic: this.meeting.topic,
      speeches,
      finalRound,
    });
    const raw = await this.askAgent(this.meeting.moderatorAgentId, prompt, {
      kind: 'moderator_summary',
      round,
    });
    let parsed = extractJsonFromText(raw);
    let valid = validateModeratorSummary(parsed, { round, finalRound });
    if (!valid.ok) {
      const retryRaw = await this.askAgent(
        this.meeting.moderatorAgentId,
        `${prompt}\n\n${valid.error}。请重新输出合法 JSON。`,
        { kind: 'moderator_summary_retry', round },
      );
      parsed = extractJsonFromText(retryRaw) || parsed;
      valid = validateModeratorSummary(parsed, { round, finalRound });
    }
    const summaryText = valid.ok
      ? parsed.summary
      : String(raw || '').trim();
    this.meeting.summaries[`round_${round}_summary`] = summaryText;
    if (valid.ok) {
      this.meeting.summaries[`round_${round}_meta`] = parsed;
      if (finalRound && parsed.assignee) {
        this.meeting.assigneeAgentId = parsed.assignee.trim();
      }
    }
    this.log({
      kind: 'summary',
      round,
      finalRound,
      summary: summaryText,
      parsed: valid.ok ? parsed : null,
      raw,
    });
    if (finalRound) {
      this.setState(MEETING_STATES.DISPATCH_EXEC);
    } else {
      this.setState(`ROUND_${round}_FEEDBACK`);
    }
  }

  async runRoundFeedback(round) {
    this.setState(`ROUND_${round}_FEEDBACK`);
    const key = `round_${round}_feedback`;
    this.meeting.speeches[key] = [];
    const context = this.summariesForRound(round + 1);
    for (const deliberant of this.meeting.deliberants) {
      this.checkCancelled();
      const dispatchPrompt = buildModeratorDispatchPrompt({
        round,
        phase: 'feedback',
        topic: this.meeting.topic,
        target: deliberant,
        deliberants: this.meeting.deliberants,
        summaries: this.meeting.summaries,
      });
      const dispatchRaw = await this.askAgent(this.meeting.moderatorAgentId, dispatchPrompt, {
        kind: 'moderator_feedback_dispatch',
        round,
      });
      const dispatchJson = extractJsonFromText(dispatchRaw);
      const instruction = dispatchJson?.instruction || dispatchRaw;
      const deliberantPrompt = buildDeliberantPrompt({
        round,
        phase: 'feedback',
        topic: this.meeting.topic,
        role: deliberant.role,
        roleLabel: deliberant.roleLabel,
        instruction,
        context,
      });
      const speech = await this.askDeliberant(deliberant, deliberantPrompt, { round, phase: 'feedback' });
      this.meeting.speeches[key].push(speech);
    }
    const nextRound = round + 1;
    this.setState(`ROUND_${nextRound}_DISPATCH`);
  }

  async runDispatchExec() {
    this.setState(MEETING_STATES.DISPATCH_EXEC);
    const assigneeId = this.meeting.assigneeAgentId
      || this.meeting.deliberants[0]?.agentId;
    if (!assigneeId) throw new Error('未指定执行 Agent');
    const assignee = this.meeting.deliberants.find((d) => d.agentId === assigneeId)
      || { agentId: assigneeId, agentLabel: assigneeId };
    const finalSummary = this.meeting.summaries.round_3_summary || '';
    const prompt = buildExecDispatchPrompt({
      topic: this.meeting.topic,
      summary: finalSummary,
      assigneeLabel: assignee.agentLabel,
      assigneeId: assignee.agentId,
    });
    const raw = await this.askAgent(assignee.agentId, prompt, { kind: 'exec' });
    this.log({
      kind: 'exec_ack',
      agentId: assignee.agentId,
      raw,
      parsed: extractJsonFromText(raw),
    });
  }

  summariesForRound(round) {
    const ctx = {};
    if (round > 1 && this.meeting.summaries.round_1_summary) {
      ctx.round_1_summary = this.meeting.summaries.round_1_summary;
    }
    if (round > 2 && this.meeting.summaries.round_2_summary) {
      ctx.round_2_summary = this.meeting.summaries.round_2_summary;
    }
    return ctx;
  }

  async askDeliberant(deliberant, prompt, meta) {
    let attemptPrompt = prompt;
    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt += 1) {
      const raw = await this.askAgent(deliberant.agentId, attemptPrompt, {
        kind: 'deliberant',
        ...meta,
        agentId: deliberant.agentId,
      });
      const parsed = extractJsonFromText(raw);
      const valid = validateDeliberantOutput(parsed, deliberant.role);
      if (valid.ok) {
        const speech = {
          agentId: deliberant.agentId,
          agentLabel: deliberant.agentLabel,
          role: deliberant.role,
          content: valid.data.content.trim(),
          parsed: valid.data,
          raw,
        };
        this.log({
          kind: 'speech',
          ...meta,
          agentId: deliberant.agentId,
          speech,
        });
        return speech;
      }
      if (attempt >= MAX_JSON_RETRIES) {
        this.log({
          kind: 'speech_fallback',
          ...meta,
          agentId: deliberant.agentId,
          error: valid.error,
          raw,
        });
        return {
          agentId: deliberant.agentId,
          agentLabel: deliberant.agentLabel,
          role: deliberant.role,
          content: String(raw || '').trim().slice(0, 500),
          parsed: null,
          raw,
          validationError: valid.error,
        };
      }
      attemptPrompt = `${prompt}\n\n${buildDeliberantRetryPrompt(valid.error)}`;
    }
    throw new Error('议事发言失败');
  }

  async askAgent(agentId, message, meta = {}) {
    this.emit('turn_start', { agentId, ...meta });
    const sessionKey = buildMeetingSessionKey(agentId, this.meeting?.id);
    const result = await this.chatTurn(sessionKey, message, { timeoutMs: TURN_TIMEOUT_MS });
    this.emit('turn_end', { agentId, ...meta, text: result.text });
    return result.text;
  }

  finalizeRecord() {
    const record = {
      ...this.publicMeeting(),
      speeches: this.meeting.speeches,
      summariesMeta: {
        round_1_meta: this.meeting.summaries.round_1_meta || null,
        round_2_meta: this.meeting.summaries.round_2_meta || null,
        round_3_meta: this.meeting.summaries.round_3_meta || null,
      },
    };
    try {
      this.meeting.recordPath = this.saveRecord(record);
      this.emit('record_saved', { path: this.meeting.recordPath });
    } catch (err) {
      this.emit('record_error', { error: err.message || String(err) });
    }
  }
}

module.exports = {
  MeetingEngine,
  MEETING_STATES,
  TURN_TIMEOUT_MS,
};
