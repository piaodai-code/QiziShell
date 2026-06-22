/**
 * Webchat 对齐：Gateway 事件 FIFO 队列 → 时间线 append / 流式原地更新。
 * - chat delta：只更新当前流式气泡
 * - segment / done：commit 流式段，再处理后续
 * - tool start：先 commit 流式，再 append 工具卡；tool update 原地更新
 */
(function initChatTimeline(global) {
  function isToolMsg(m) {
    return m?.kind === 'tool';
  }

  function createChatTimeline(options) {
    const {
      getMessages,
      getScope,
      allocId,
      now,
      formatEnvelopeTime,
      isPlaceholderText,
      onArchive,
      onRender,
      onRenderStream,
      onRunDone,
      onToolRunning,
    } = options;

    const toolState = global.ToolStream?.createState?.() || { byId: new Map(), order: [] };
    /** @type {Array<{ type: string, [key: string]: unknown }>} */
    const queue = [];
    let pumping = false;
    let order = 0;
    /** @type {Set<string>} */
    const finishedRuns = new Set();

    function msgs() {
      return getMessages();
    }

    function inScope(m) {
      const scope = getScope();
      if (m.sessionKey && m.sessionKey !== scope.sessionKey) return false;
      if (m.chatEpoch != null && m.chatEpoch !== scope.chatEpoch) return false;
      return true;
    }

    function runIdsMatch(a, b) {
      if (a == null || b == null) return false;
      return a === b || Number(a) === Number(b);
    }

    function findStreaming(runId) {
      for (let i = msgs().length - 1; i >= 0; i -= 1) {
        const m = msgs()[i];
        if (m.who !== 'them' || isToolMsg(m) || !m.streaming) continue;
        if (!inScope(m)) continue;
        if (runId != null && !runIdsMatch(m.runId, runId)) continue;
        return m;
      }
      return null;
    }

    function findLastAssistantBubble(runId) {
      for (let i = msgs().length - 1; i >= 0; i -= 1) {
        const m = msgs()[i];
        if (m.who !== 'them' || isToolMsg(m) || !inScope(m)) continue;
        if (runId != null && !runIdsMatch(m.runId, runId)) continue;
        return m;
      }
      return null;
    }

    function textSame(a, b) {
      return String(a || '').trim() === String(b || '').trim();
    }

    function stripOneTextPrefix(text, priorRaw) {
      if (!priorRaw) return text;
      let next = String(text || '');
      const prior = priorRaw.trim();
      if (!next) return next;
      if (next.trim() === prior) return '';
      if (next.startsWith(priorRaw) && next.length > priorRaw.length) {
        return next.slice(priorRaw.length).replace(/^\s+/, '');
      }
      if (next.startsWith(prior) && next.length > prior.length) {
        return next.slice(prior.length).replace(/^\s+/, '');
      }
      return next;
    }

    /** 本 run 内已 finalize 的过程消息拼接（Gateway 发来的是累积全文） */
    function committedAssistantPrefix(runId) {
      let prefix = '';
      for (const m of msgs()) {
        if (m.who !== 'them' || isToolMsg(m) || m.streaming) continue;
        if (!inScope(m)) continue;
        if (runId != null && !runIdsMatch(m.runId, runId)) continue;
        prefix += String(m.text || '');
      }
      return prefix;
    }

    function stripCommittedAssistantPrefix(runId, text) {
      return stripOneTextPrefix(String(text || ''), committedAssistantPrefix(runId));
    }

    function createStreamingBubble(runId, extra = {}) {
      const list = msgs();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m.who !== 'them' || isToolMsg(m) || !m.streaming) continue;
        if (runId != null && !runIdsMatch(m.runId, runId)) continue;
        if (!inScope(m)) continue;
        if (isPlaceholderText(m.text)) list.splice(i, 1);
      }
      const scope = getScope();
      const bubble = {
        id: allocId(),
        who: 'them',
        text: '…',
        time: now(),
        streaming: true,
        runId,
        sessionKey: scope.sessionKey,
        chatEpoch: scope.chatEpoch,
        streamingStartedAt: Date.now(),
        lastDeltaAt: Date.now(),
        ...extra,
      };
      msgs().push(bubble);
      return bubble;
    }

    function commitStream({ runId, text, archive = true, error = null } = {}) {
      const incoming = typeof text === 'string' ? text : '';
      let target = findStreaming(runId);

      if (target) {
        if (incoming.trim()) {
          const stripped = stripCommittedAssistantPrefix(runId, incoming);
          if (stripped) {
            target.text = stripped.length >= String(target.text || '').trim().length
              ? stripped
              : target.text;
          }
        }
        const visible = String(target.text || '').trim();
        if (!visible || isPlaceholderText(target.text)) {
          const idx = msgs().indexOf(target);
          if (idx >= 0) msgs().splice(idx, 1);
          return null;
        }
        target.streaming = false;
        target.queued = false;
        const completedAtMs = target.lastDeltaAt || Date.now();
        target.sentAtMs = completedAtMs;
        target.sentTime = formatEnvelopeTime(completedAtMs);
        if (error) {
          target.text = target.text ? `${target.text}\n\n[错误] ${error}` : `[错误] ${error}`;
        }
        if (archive) onArchive(target);
        return target;
      }

      return null;
    }

    function appendFinalBubble({ runId, text, error = null } = {}) {
      const incoming = typeof text === 'string' ? text : '';
      const trimmed = incoming.trim();
      if (!trimmed) return null;
      const last = findLastAssistantBubble(runId);
      if (last && textSame(last.text, incoming)) return last;
      const msg = {
        id: allocId(),
        who: 'them',
        text: error ? `${trimmed}\n\n[错误] ${error}` : incoming,
        time: now(),
        streaming: false,
        runId,
        sessionKey: getScope().sessionKey,
        chatEpoch: getScope().chatEpoch,
        sentAtMs: Date.now(),
        sentTime: formatEnvelopeTime(Date.now()),
      };
      msgs().push(msg);
      onArchive(msg);
      return msg;
    }

    function upsertTool(entry) {
      if (!entry?.toolCallId) return;
      const list = msgs();
      const idx = list.findIndex((m) => isToolMsg(m) && m.toolCallId === entry.toolCallId);
      const running = entry.phase !== 'result' && !entry.output;
      const sentAtMs = entry.startedAt || Date.now();
      const sentTime = formatEnvelopeTime(sentAtMs);
      const displayTime = sentTime.match(/\d{2}:\d{2}/)?.[0] || now();
      const toolMsg = {
        id: idx >= 0 ? list[idx].id : allocId(),
        kind: 'tool',
        who: 'them',
        toolCallId: entry.toolCallId,
        name: entry.name,
        args: entry.args,
        output: entry.output,
        phase: entry.phase,
        isError: entry.isError === true,
        gatewayRunId: entry.runId,
        runId: options.getActiveRunId?.() ?? null,
        sentAtMs,
        sentTime: sentTime || undefined,
        time: displayTime,
        sessionKey: getScope().sessionKey,
        chatEpoch: getScope().chatEpoch,
        updatedAt: entry.updatedAt,
        streaming: running,
      };
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...toolMsg };
      } else {
        list.push(toolMsg);
      }
    }

    function enqueue(item) {
      queue.push({ ...item, _seq: order++ });
      void pump();
    }

    function enqueueDeltaImmediate(item) {
      processDelta({ type: 'delta', ...item, _seq: order++ });
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      while (queue.length > 0) {
        const item = queue.shift();
        processItem(item);
      }
      pumping = false;
    }

    function processItem(item) {
      switch (item.type) {
        case 'delta':
          processDelta(item);
          break;
        case 'segment':
          processSegment(item);
          break;
        case 'done':
          processDone(item);
          break;
        case 'tool':
          processTool(item);
          break;
        default:
          break;
      }
    }

    function processDelta(item) {
      const { runId, delta, replace, fullText } = item;
      const key = runId != null ? String(runId) : '';
      if (key && finishedRuns.has(key)) return;

      let incoming = stripCommittedAssistantPrefix(runId, String(delta ?? fullText ?? ''));
      if (!incoming.trim()) return;

      let target = findStreaming(runId);
      if (!target) {
        const last = findLastAssistantBubble(runId);
        if (last && !last.streaming && textSame(last.text, incoming)) return;
        target = createStreamingBubble(runId, itemExtra(item));
      }

      if (replace === true || isPlaceholderText(target.text)) {
        target.text = incoming;
      } else if (!String(target.text || '').endsWith(incoming)) {
        target.text = `${target.text || ''}${incoming}`;
      }
      target.streaming = true;
      target.lastDeltaAt = Date.now();
      if (onRenderStream && runId != null) {
        onRenderStream(runId);
      } else {
        onRender();
      }
    }

    function itemExtra(item) {
      const extra = {};
      if (item.external) extra.external = true;
      if (item.gatewayRunId) extra.gatewayRunId = item.gatewayRunId;
      return extra;
    }

    function processSegment({ runId, text }) {
      if (!findStreaming(runId)) return;
      const segmentText = text ? stripCommittedAssistantPrefix(runId, text) : '';
      commitStream({ runId, text: segmentText || undefined, archive: true });
      onRender();
    }

    function processDone({ runId, text, error, aborted }) {
      const key = runId != null ? String(runId) : '';
      if (key && finishedRuns.has(key)) return;

      let err = aborted ? (error || '已中止') : error;
      if (err && (String(err).includes('连接断开') || String(err).includes('Gateway'))) {
        err = null;
      }
      const incoming = typeof text === 'string' ? stripCommittedAssistantPrefix(runId, text) : '';
      const streaming = findStreaming(runId);
      if (streaming) {
        commitStream({ runId, text: incoming, archive: true, error: err || null });
      } else if (incoming.trim()) {
        const last = findLastAssistantBubble(runId);
        if (last && textSame(last.text, incoming)) {
          // 已由 segment / delta 展示，跳过重复气泡
        } else if (last && !last.streaming && incoming.trim().length > String(last.text || '').trim().length) {
          last.text = incoming;
          onArchive(last);
        } else if (!last) {
          appendFinalBubble({ runId, text: incoming, error: err || null });
        }
      } else if (err) {
        appendFinalBubble({ runId, text: '', error: err });
      }
      for (const m of msgs()) {
        if (isToolMsg(m) && m.streaming) m.streaming = false;
      }
      if (key) finishedRuns.add(key);
      onRender();
      if (onRunDone) onRunDone({ runId, text, error: err, aborted });
    }

    function processTool({ payload, runId }) {
      if (!global.ToolStream?.applyToolEvent) return;
      const result = global.ToolStream.applyToolEvent(toolState, payload);
      if (!result.changed || !result.entry) return;
      if (result.commitStream) {
        commitStream({ runId: runId ?? options.getActiveRunId?.(), archive: true });
      }
      upsertTool(result.entry);
      onRender();
      if (result.entry.phase !== 'result' && onToolRunning) onToolRunning();
    }

    function reset() {
      if (global.ToolStream?.clearState) {
        global.ToolStream.clearState(toolState);
      } else {
        toolState.byId?.clear?.();
        if (Array.isArray(toolState.order)) toolState.order.length = 0;
      }
      queue.length = 0;
      order = 0;
      finishedRuns.clear();
    }

    function isRunFinished(runId) {
      if (runId == null) return false;
      return finishedRuns.has(String(runId));
    }

    return {
      enqueue,
      enqueueDelta: (p) => enqueueDeltaImmediate(p),
      isRunFinished,
      enqueueSegment: (p) => enqueue({ type: 'segment', ...p }),
      enqueueDone: (p) => enqueue({ type: 'done', ...p }),
      enqueueTool: (p) => enqueue({ type: 'tool', ...p }),
      reset,
      findStreaming,
      commitStream,
    };
  }

  global.ChatTimeline = { create: createChatTimeline, isToolMsg };
})(typeof window !== 'undefined' ? window : globalThis);
