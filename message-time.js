(function initMessageTime(root, moduleObj) {
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
        date = new Date();
        date.setHours(hours, minutes, 0, 0);
      } else {
        const parsed = Date.parse(trimmed);
        if (Number.isNaN(parsed)) return trimmed;
        date = new Date(parsed);
      }
    } else {
      return '';
    }

    if (!date || Number.isNaN(date.getTime())) return '';

    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(date);

    const year = parts.find((part) => part.type === 'year')?.value || '';
    const month = parts.find((part) => part.type === 'month')?.value || '';
    const day = parts.find((part) => part.type === 'day')?.value || '';
    const hour = parts.find((part) => part.type === 'hour')?.value || '';
    const minute = parts.find((part) => part.type === 'minute')?.value || '';
    const timeZone = parts.find((part) => part.type === 'timeZoneName')?.value || '';
    const core = `${weekday} ${year}-${month}-${day} ${hour}:${minute}`;
    return timeZone ? `${core} ${timeZone}` : core;
  }

  function parseLeadingEnvelopeTimestamp(text) {
    const match = String(text || '').match(/^\[([A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*)\]/);
    return match ? match[1].trim() : '';
  }

  function coerceTimestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
        const parsed = Date.parse(trimmed.replace(/^([A-Za-z]{3}) /, ''));
        return Number.isNaN(parsed) ? null : parsed;
      }
      if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
        const [hours, minutes] = trimmed.split(':').map((part) => Number(part));
        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        return date.getTime();
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
      return { time: envelopeTime, sentAtMs: null };
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
    parseLeadingEnvelopeTimestamp,
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
