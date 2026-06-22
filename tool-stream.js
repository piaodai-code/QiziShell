/**
 * Tool stream state + rendering aligned with OpenClaw Control UI / webchat.
 * Handles gateway `agent` / `session.tool` frames (stream: "tool").
 */
(function initToolStream(global) {
  const TOOL_OUTPUT_CHAR_LIMIT = 120_000;
  const TOOL_STREAM_LIMIT = 50;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extractToolOutputText(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.text === 'string') return value.text;
    const content = value.content;
    if (!Array.isArray(content)) return null;
    const parts = content
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        return null;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  function formatToolOutput(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const contentText = extractToolOutputText(value);
    let text;
    if (typeof value === 'string') {
      text = value;
    } else if (contentText) {
      text = contentText;
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }
    if (text.length > TOOL_OUTPUT_CHAR_LIMIT) {
      return `${text.slice(0, TOOL_OUTPUT_CHAR_LIMIT)}\n\n… truncated (${text.length} chars).`;
    }
    return text;
  }

  function formatArgsPreview(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args.trim();
    try {
      const raw = JSON.stringify(args);
      return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
    } catch {
      return String(args);
    }
  }

  function resolveToolLabel(name) {
    const n = String(name || 'tool').trim() || 'tool';
    const labels = {
      exec: 'Run command',
      read: 'Read file',
      write: 'Write file',
      edit: 'Edit file',
      grep: 'Search',
      glob: 'Find files',
      web_search: 'Web search',
      web_fetch: 'Fetch page',
      browser: 'Browser',
    };
    return labels[n] || n;
  }

  function createState() {
    return {
      byId: new Map(),
      order: [],
    };
  }

  function trimState(state) {
    while (state.order.length > TOOL_STREAM_LIMIT) {
      const id = state.order.shift();
      if (id) state.byId.delete(id);
    }
  }

  /**
   * @returns {{ changed: boolean, commitStream: boolean, entry?: object }}
   */
  function applyToolEvent(state, payload) {
    if (!payload || payload.stream !== 'tool') {
      return { changed: false, commitStream: false };
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
    if (!toolCallId) return { changed: false, commitStream: false };

    const name = typeof data.name === 'string' ? data.name : 'tool';
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const args = phase === 'start' ? data.args : undefined;
    const output = phase === 'update'
      ? formatToolOutput(data.partialResult)
      : phase === 'result'
        ? formatToolOutput(data.result)
        : undefined;
    const isError = phase === 'result' && data.isError === true;
    const now = Date.now();
    let commitStream = false;
    let entry = state.byId.get(toolCallId);

    if (!entry) {
      commitStream = true;
      entry = {
        toolCallId,
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        name,
        args,
        output: output || undefined,
        phase,
        isError,
        seq: typeof payload.seq === 'number' ? payload.seq : undefined,
        startedAt: typeof payload.ts === 'number' ? payload.ts : now,
        updatedAt: now,
      };
      state.byId.set(toolCallId, entry);
      state.order.push(toolCallId);
    } else {
      entry.name = name;
      entry.phase = phase || entry.phase;
      if (args !== undefined) entry.args = args;
      if (output !== undefined) entry.output = output || undefined;
      if (phase === 'result') entry.isError = isError;
      entry.updatedAt = now;
    }

    trimState(state);
    return { changed: true, commitStream, entry: { ...entry } };
  }

  function renderToolCardHtml(entry) {
    if (!entry) return '';
    const label = resolveToolLabel(entry.name);
    const detail = formatArgsPreview(entry.args);
    const running = entry.phase !== 'result' && !entry.output;
    const statusText = entry.isError
      ? 'Error'
      : (running ? 'Running…' : 'Completed');
    const statusClass = entry.isError
      ? 'chat-tool-card__status chat-tool-card__status--error'
      : (running ? 'chat-tool-card__status chat-tool-card__status--running' : 'chat-tool-card__status');

    const inputBlock = entry.args != null
      ? `<div class="chat-tool-data">
          <div class="chat-tool-data__label">Tool input</div>
          <pre class="chat-tool-data__pre"><code>${escapeHtml(formatArgsPreview(entry.args))}</code></pre>
        </div>`
      : '';

    const outputText = entry.output ? String(entry.output) : '';
    const outputBlock = outputText
      ? `<div class="chat-tool-data">
          <div class="chat-tool-data__label">${entry.isError ? 'Tool error' : 'Tool output'}</div>
          <pre class="chat-tool-data__pre"><code>${escapeHtml(outputText)}</code></pre>
        </div>`
      : '';

    return `<details class="chat-tool-card"${running ? ' open' : ''}>
      <summary class="chat-tool-card__summary">
        <span class="chat-tool-card__icon" aria-hidden="true">⚡</span>
        <span class="chat-tool-card__label">${escapeHtml(label)}</span>
        ${detail ? `<span class="chat-tool-card__detail">${escapeHtml(detail)}</span>` : ''}
        <span class="${statusClass}">${escapeHtml(statusText)}</span>
      </summary>
      <div class="chat-tool-card__body">
        <div class="chat-tool-card__title">${escapeHtml(entry.name || 'tool')}</div>
        ${inputBlock}
        ${outputBlock}
      </div>
    </details>`;
  }

  function clearState(state) {
    state.byId.clear();
    state.order.length = 0;
  }

  global.ToolStream = {
    createState,
    applyToolEvent,
    renderToolCardHtml,
    clearState,
    formatToolOutput,
  };
})(typeof window !== 'undefined' ? window : globalThis);
