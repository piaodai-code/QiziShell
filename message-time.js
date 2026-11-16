(function initMessageTime(root, moduleObj) {
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function currentZoneSnapshot() {
    if (typeof require === 'function') {
      try {
        const loaded = require('./system-local-time').loadSnapshot();
        if (loaded) return loaded;
      } catch {
        // Renderer has no filesystem. The preload snapshot is the fallback.
      }
    }
    const bridged = root && root.qiziLocalTime && root.qiziLocalTime.snapshot;
    return bridged && Array.isArray(bridged.transitions) ? bridged : null;
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  function nthWeekday(year, month, week, dow) {
    if (week === 5) {
      const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const lastDow = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
      return lastDate - ((lastDow - dow + 7) % 7);
    }
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((dow - firstDow + 7) % 7) + (week - 1) * 7;
  }

  function monthDayFromDayNumber(year, dayNumber, zeroBased) {
    const leap = isLeapYear(year);
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let remaining = dayNumber;
    if (!zeroBased) remaining -= 1;
    if (!zeroBased && leap && remaining >= 59) remaining += 1;
    for (let month = 1; month <= 12; month += 1) {
      if (remaining < lengths[month - 1]) {
        return { month, day: remaining + 1 };
      }
      remaining -= lengths[month - 1];
    }
    return { month: 12, day: 31 };
  }

  function ruleInstantUtc(year, dateSpec, timeSeconds, offsetSeconds) {
    let month = 1;
    let day = 1;
    if (dateSpec.type === 'M') {
      month = dateSpec.month;
      day = nthWeekday(year, dateSpec.month, dateSpec.week, dateSpec.dow);
    } else if (dateSpec.type === 'J') {
      const found = monthDayFromDayNumber(year, dateSpec.day, false);
      month = found.month;
      day = found.day;
    } else {
      const found = monthDayFromDayNumber(year, dateSpec.day, true);
      month = found.month;
      day = found.day;
    }
    return Math.floor(Date.UTC(year, month - 1, day) / 1000) + timeSeconds - offsetSeconds;
  }

  function posixOffset(rule, unixSeconds) {
    if (!rule) return null;
    if (!rule.dstName || !rule.start || !rule.end) {
      return { utoff: rule.stdOff, abbr: rule.stdName };
    }
    const year = new Date(unixSeconds * 1000).getUTCFullYear();
    for (const candidate of [year - 1, year, year + 1]) {
      const start = ruleInstantUtc(candidate, rule.start, rule.startTime, rule.stdOff);
      const end = ruleInstantUtc(candidate, rule.end, rule.endTime, rule.dstOff);
      const inDst = start < end
        ? unixSeconds >= start && unixSeconds < end
        : unixSeconds >= start || unixSeconds < end;
      if (inDst) return { utoff: rule.dstOff, abbr: rule.dstName };
    }
    return { utoff: rule.stdOff, abbr: rule.stdName };
  }

  function transitionOffset(snapshot, unixSeconds) {
    const transitions = snapshot.transitions || [];
    if (!transitions.length) {
      return posixOffset(snapshot.posix, unixSeconds) || snapshot.initial || null;
    }
    const last = transitions[transitions.length - 1];
    if (unixSeconds >= last.time && snapshot.posix) {
      return posixOffset(snapshot.posix, unixSeconds) || last;
    }
    if (unixSeconds < transitions[0].time) return snapshot.initial || transitions[0];
    let lo = 0;
    let hi = transitions.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (transitions[mid].time <= unixSeconds) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return transitions[found];
  }

  function localParts(ms) {
    const snapshot = currentZoneSnapshot();
    if (!snapshot) return null;
    const instant = Number(ms);
    if (!Number.isFinite(instant)) return null;
    const info = transitionOffset(snapshot, Math.floor(instant / 1000));
    if (!info || !Number.isFinite(info.utoff)) return null;
    const shifted = new Date(instant + info.utoff * 1000);
    if (Number.isNaN(shifted.getTime())) return null;
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      weekday: WEEKDAYS[shifted.getUTCDay()],
      abbr: info.abbr || '',
      offsetSeconds: info.utoff,
    };
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatLocalParts(parts, withZone) {
    const core = `${parts.weekday} ${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
    if (!withZone || !parts.abbr) return core;
    return `${core} ${parts.abbr}`;
  }

  function formatClock(ms) {
    const parts = localParts(ms);
    if (parts) return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
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

    const local = localParts(date.getTime());
    if (local) return formatLocalParts(local, true);

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
