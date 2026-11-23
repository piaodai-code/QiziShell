(function initMessageTime(root, moduleObj) {
  function localParts(ms) {
    if (typeof require === 'function') {
      try {
        return require('./system-local-time').localParts(ms);
      } catch {
        // Renderer cannot spawn the system clock. Ask the main process.
      }
    }
    const bridge = root && root.qiziLocalTime;
    if (bridge && typeof bridge.parts === 'function') return bridge.parts(ms);
    return null;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatLocalParts(parts, withZone) {
    const core = `${parts.weekday} ${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
    if (!withZone || !parts.abbr) return core;
    return `${core} ${parts.abbr}`;
  }

  function msFromLocalClock(hours, minutes, seconds = 0) {
    const today = localParts(Date.now());
    if (!today || !Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return Date.UTC(today.year, today.month - 1, today.day, hours, minutes, seconds) - today.offsetSeconds * 1000;
  }

  /** Local midnight after the system-clock day that contains ms. */
  function nextLocalMidnight(ms) {
    const parts = localParts(ms);
    if (!parts) return null;
    const start = Date.UTC(parts.year, parts.month - 1, parts.day) - parts.offsetSeconds * 1000;
    return start + 24 * 60 * 60 * 1000;
  }

  function formatClock(ms) {
    const parts = localParts(ms);
    if (!parts) return '';
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  }

  function messageClockLabel(msg) {
    if (msg && typeof msg.sentAtMs === 'number' && Number.isFinite(msg.sentAtMs)) {
      const clock = formatClock(msg.sentAtMs);
      if (clock) return clock;
    }
    const display = String(msg?.time || '').trim();
    const match = display.match(/\d{1,2}:\d{2}/);
    if (!match) return display;
    const [hours, minutes] = match[0].split(':');
    return `${pad2(hours)}:${pad2(minutes)}`;
  }

  function formatGatewayEnvelopeTime(input) {
    let date;
    if (typeof input === 'number' && Number.isFinite(input)) {
      date = new Date(input < 1e12 ? input * 1000 : input);
    } else if (input instanceof Date) {
      date = input;
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return '';
      if (/^[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
        return trimmed;
      }
      if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
        const [hours, minutes] = trimmed.split(':').map((part) => Number(part));
        const today = localParts(Date.now());
        if (today && Number.isFinite(hours) && Number.isFinite(minutes)) {
          return formatLocalParts({
            ...today,
            hour: hours,
            minute: minutes,
          }, true);
        }
        const clockMs = msFromLocalClock(hours, minutes, 0);
        if (clockMs == null) return trimmed;
        date = new Date(clockMs);
      } else {
        const parsed = Date.parse(trimmed);
        if (Number.isNaN(parsed)) return trimmed;
        date = new Date(parsed);
      }
    } else {
      return '';
    }

    if (!date || Number.isNaN(date.getTime())) return '';

    const local = localParts(date.getTime());
    return local ? formatLocalParts(local, true) : '';
  }

  function parseLeadingEnvelopeTimestamp(text) {
    const match = String(text || '').match(/^\[([A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*)\]/);
    return match ? match[1].trim() : '';
  }

  function stripLeadingEnvelopeTimestamp(text) {
    return String(text || '')
      .replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*/m, '')
      .trim();
  }

  function stripSenderUntrustedMetadata(text) {
    return String(text || '')
      .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/m, '')
      .trim();
  }

  function coerceTimestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const wall = trimmed.match(/^[A-Za-z]{3} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
      if (wall) {
        const guess = Date.UTC(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]), Number(wall[4]), Number(wall[5]), Number(wall[6] || 0));
        const parts = localParts(guess);
        if (!parts) return null;
        return guess - parts.offsetSeconds * 1000;
      }
      if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
        const [hours, minutes] = trimmed.split(':').map((part) => Number(part));
        return msFromLocalClock(hours, minutes, 0);
      }
      if (/^\d+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  function extractMessageSentTimeFromRaw(raw) {
    if (!raw || typeof raw !== 'object') {
      return { time: '', sentAtMs: null };
    }

    const fieldCandidates = [
      raw.timestampMs,
      raw.timestamp_ms,
      raw.timestamp,
      raw.Timestamp,
      raw.createdAtMs,
      raw.created_at_ms,
      raw.createdAt,
      raw.created_at,
      raw.sentAtMs,
      raw.sent_at_ms,
      raw.sentAt,
      raw.sent_at,
      raw.messageTimestamp,
      raw.message_timestamp,
      raw.dateMs,
      raw.date_ms,
      raw.time,
      raw.Time,
    ];

    for (const candidate of fieldCandidates) {
      const sentAtMs = coerceTimestampMs(candidate);
      if (sentAtMs != null) {
        return {
          time: formatGatewayEnvelopeTime(sentAtMs),
          sentAtMs,
        };
      }
    }

    const text = typeof raw.content === 'string'
      ? raw.content
      : typeof raw.text === 'string'
        ? raw.text
        : '';
    const envelopeTime = parseLeadingEnvelopeTimestamp(text);
    if (envelopeTime) {
      const sentAtMs = coerceTimestampMs(envelopeTime);
      return {
        time: envelopeTime,
        sentAtMs,
      };
    }

    return { time: '', sentAtMs: null };
  }

  function resolveMessageOriginalSentTime(msg) {
    if (!msg) return '';
    if (msg.sentAtMs && Number.isFinite(msg.sentAtMs)) {
      return formatGatewayEnvelopeTime(msg.sentAtMs);
    }
    const sentTime = String(msg.sentTime || '').trim();
    if (sentTime) return formatGatewayEnvelopeTime(sentTime);
    const displayTime = String(msg.time || '').trim();
    if (displayTime) return formatGatewayEnvelopeTime(displayTime);
    return '';
  }

  const api = {
    formatGatewayEnvelopeTime,
    formatClock,
    messageClockLabel,
    localParts,
    nextLocalMidnight,
    parseLeadingEnvelopeTimestamp,
    stripLeadingEnvelopeTimestamp,
    stripSenderUntrustedMetadata,
    extractMessageSentTimeFromRaw,
    resolveMessageOriginalSentTime,
  };

  if (moduleObj && moduleObj.exports) {
    moduleObj.exports = api;
  }
  if (root) {
    root.MessageTime = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, typeof module !== 'undefined' ? module : undefined);
