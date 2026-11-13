/**
 * 一轮回复只保留一个助手气泡：文字在这个气泡里增长，结束时定稿。
 * 命令和脚本不进消息列表，交给底部 Working 条。
 */
(function initChatTimeline(global) {
  function isToolMsg(m) {
    return m?.kind === 'tool';
  }

  const SNAPSHOT_SLICE = 48;

  function snapshotSlices(text) {
    const body = String(text || '').trim();
    if (body.length < SNAPSHOT_SLICE) return [];
    const slices = [body.slice(0, SNAPSHOT_SLICE), body.slice(-SNAPSHOT_SLICE)];
    if (body.length > SNAPSHOT_SLICE * 3) {
      const mid = Math.floor(body.length / 2) - Math.floor(SNAPSHOT_SLICE / 2);
      slices.push(body.slice(mid, mid + SNAPSHOT_SLICE));
    }
    return slices;
  }

  function sharesSnapshot(a, b) {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    if (!left || !right) return false;
    const shorter = left.length <= right.length ? left : right;
    const longer = shorter === left ? right : left;
    return snapshotSlices(shorter).some((slice) => longer.includes(slice));
  }

  function dropRepeatedTranscript(text) {
    const body = String(text || '').trim();
    if (body.length < SNAPSHOT_SLICE * 2) return String(text || '');
    const scanEnd = Math.min(body.length, 500);
    for (let i = 0; i + SNAPSHOT_SLICE <= scanEnd; i += 24) {
      const slice = body.slice(i, i + SNAPSHOT_SLICE);
      const at = body.indexOf(slice, i + SNAPSHOT_SLICE);
      if (at < 0) continue;
      const start = at - i;
      if (start < SNAPSHOT_SLICE) continue;
      const first = body.slice(0, start).trim();
      const second = body.slice(start).trim();
      if (second.length < SNAPSHOT_SLICE || !sharesSnapshot(first, second)) continue;
      if (second.length < first.length * 0.6) continue;
      return second.length >= first.length ? second : first;
    }
    return String(text || '');
  }

  function mergeAssistantTranscript(current, incoming) {
    const cur = String(current || '').trim();
    const next = String(incoming || '').trim();
    if (!next) return String(current || '');
    if (!cur || cur === '…') return next;
    if (next === cur || cur.startsWith(next)) return cur;
    if (next.startsWith(cur) || next.includes(cur)) return next;
    if (cur.includes(next)) return cur;
    if (sharesSnapshot(cur, next)) return next.length >= cur.length ? next : cur;
    return dropRepeatedTranscript(`${cur}\n\n${next}`);
  }

  function collapseConsecutiveAssistants(list) {
    if (!Array.isArray(list)) return list;
    const out = [];
    for (const msg of list) {
      const cleaned = msg?.who === 'them' && !msg.streaming
        ? { ...msg, text: dropRepeatedTranscript(msg.text) }
        : msg;
      const prev = out[out.length - 1];
      const canFold = cleaned?.who === 'them'
        && prev?.who === 'them'
        && !cleaned.streaming
        && !prev.streaming
        && cleaned.kind !== 'tool'
        && prev.kind !== 'tool';
      if (!canFold) {
        out.push(cleaned);
        continue;
      }
      out[out.length - 1] = {
        ...prev,
        ...cleaned,
        text: mergeAssistantTranscript(prev.text, cleaned.text),
        streaming: false,
      };
    }
    return out;
  }

  function absorbAssistantText(current, incoming) {
    return mergeAssistantTranscript(current, incoming);
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
      onTools,
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
          if (stripped) target.text = absorbAssistantText(target.text, stripped);
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

    function toolEntries() {
      return toolState.order
        .map((id) => toolState.byId.get(id))
        .filter(Boolean)
        .map((entry) => ({ ...entry }));
    }

    function removeToolMessages() {
      const list = msgs();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (isToolMsg(list[i])) list.splice(i, 1);
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
      const { runId, delta, fullText } = item;
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

      target.text = absorbAssistantText(target.text, incoming);
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
      const segmentText = text ? stripCommittedAssistantPrefix(runId, text) : '';
      if (!segmentText.trim()) return;
      let target = findStreaming(runId);
      if (!target) target = createStreamingBubble(runId);
      target.text = absorbAssistantText(target.text, segmentText);
      target.streaming = true;
      target.lastDeltaAt = Date.now();
      if (onRenderStream && runId != null) onRenderStream(runId);
      else onRender();
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
        const lastText = String(last?.text || '').trim();
        const nextText = incoming.trim();
        if (last && textSame(last.text, incoming)) {
          // 已由 segment / delta 展示，跳过重复气泡
        } else if (
          last
          && !last.streaming
          && lastText
          && nextText.startsWith(lastText)
          && nextText.length > lastText.length
        ) {
          last.text = incoming;
          onArchive(last);
        } else {
          appendFinalBubble({ runId, text: incoming, error: err || null });
        }
      } else if (err) {
        appendFinalBubble({ runId, text: '', error: err });
      }
      removeToolMessages();
      if (global.ToolStream?.clearState) global.ToolStream.clearState(toolState);
      const collapsed = collapseConsecutiveAssistants(msgs());
      if (collapsed !== msgs()) {
        const list = msgs();
        list.splice(0, list.length, ...collapsed);
      }
      if (key) finishedRuns.add(key);
      onRender();
      if (onRunDone) onRunDone({ runId, text, error: err, aborted });
    }

    function processTool({ payload, runId }) {
      if (!global.ToolStream?.applyToolEvent) return;
      const result = global.ToolStream.applyToolEvent(toolState, payload);
      if (!result.changed || !result.entry) return;
      if (onTools) onTools(toolEntries());
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
      clearTools: () => {
        if (global.ToolStream?.clearState) global.ToolStream.clearState(toolState);
      },
      findStreaming,
      commitStream,
    };
  }

  global.ChatTimeline = {
    create: createChatTimeline,
    isToolMsg,
    absorbAssistantText,
    collapseConsecutiveAssistants,
  };
})(typeof window !== 'undefined' ? window : globalThis);
