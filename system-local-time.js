const fs = require('fs');

const ZONE_PATH = '/etc/localtime';

let cachedMtimeMs = null;
let cachedSnapshot = null;

function readI32(buf, offset) {
  return buf.readInt32BE(offset);
}

function readI64(buf, offset) {
  const hi = buf.readInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 4294967296 + lo;
}

function designation(chars, index) {
  const end = chars.indexOf('\0', index);
  return chars.slice(index, end === -1 ? undefined : end);
}

function parseHeader(buf, offset) {
  const counts = offset + 20;
  return {
    version: buf.toString('ascii', offset + 4, offset + 5),
    ttisutcnt: readI32(buf, counts),
    ttisstdcnt: readI32(buf, counts + 4),
    leapcnt: readI32(buf, counts + 8),
    timecnt: readI32(buf, counts + 12),
    typecnt: readI32(buf, counts + 16),
    charcnt: readI32(buf, counts + 20),
    dataOffset: counts + 24,
  };
}

function parseSection(buf, offset, sixtyFour) {
  const header = parseHeader(buf, offset);
  let cursor = header.dataOffset;
  const timeSize = sixtyFour ? 8 : 4;
  const times = [];
  for (let i = 0; i < header.timecnt; i += 1) {
    times.push(sixtyFour ? readI64(buf, cursor) : readI32(buf, cursor));
    cursor += timeSize;
  }
  const typeIndexes = [];
  for (let i = 0; i < header.timecnt; i += 1) {
    typeIndexes.push(buf[cursor]);
    cursor += 1;
  }
  const types = [];
  for (let i = 0; i < header.typecnt; i += 1) {
    types.push({
      utoff: readI32(buf, cursor),
      isdst: buf[cursor + 4],
      desigidx: buf[cursor + 5],
    });
    cursor += 6;
  }
  const chars = buf.toString('latin1', cursor, cursor + header.charcnt);
  cursor += header.charcnt;
  cursor += header.leapcnt * (timeSize + 4);
  cursor += header.ttisstdcnt;
  cursor += header.ttisutcnt;
  return { header, times, typeIndexes, types, chars, end: cursor };
}

function parsePosixName(spec, start) {
  if (spec[start] === '<') {
    const end = spec.indexOf('>', start + 1);
    if (end < 0) return null;
    return { name: spec.slice(start + 1, end), next: end + 1 };
  }
  const match = /^[A-Za-z]+/.exec(spec.slice(start));
  if (!match || match[0].length < 3) return null;
  return { name: match[0], next: start + match[0].length };
}

function parsePosixOffset(spec, start) {
  const match = /^([+-])?(\d{1,3})(?::(\d{2}))?(?::(\d{2}))?/.exec(spec.slice(start));
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const west = sign * (
    Number(match[2]) * 3600
    + Number(match[3] || 0) * 60
    + Number(match[4] || 0)
  );
  return { utoff: -west, next: start + match[0].length };
}

function parsePosixTime(spec, start) {
  const match = /^(\d{1,3})(?::(\d{2}))?(?::(\d{2}))?/.exec(spec.slice(start));
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return { seconds, next: start + match[0].length };
}

function parsePosixDate(spec, start) {
  let match = /^M(\d{1,2})\.(\d)\.(\d)/.exec(spec.slice(start));
  if (match) {
    return {
      date: { type: 'M', month: Number(match[1]), week: Number(match[2]), dow: Number(match[3]) },
      next: start + match[0].length,
    };
  }
  match = /^J(\d+)/.exec(spec.slice(start));
  if (match) {
    return { date: { type: 'J', day: Number(match[1]) }, next: start + match[0].length };
  }
  match = /^(\d+)/.exec(spec.slice(start));
  if (!match) return null;
  return { date: { type: 'D', day: Number(match[1]) }, next: start + match[0].length };
}

function parsePosixTz(spec) {
  if (!spec) return null;
  let cursor = 0;
  const std = parsePosixName(spec, cursor);
  if (!std) return null;
  cursor = std.next;
  const stdOff = parsePosixOffset(spec, cursor);
  if (!stdOff) return null;
  cursor = stdOff.next;
  if (cursor >= spec.length) {
    return { stdName: std.name, stdOff: stdOff.utoff, dstName: '' };
  }
  const dst = parsePosixName(spec, cursor);
  if (!dst) return { stdName: std.name, stdOff: stdOff.utoff, dstName: '' };
  cursor = dst.next;
  let dstOff = stdOff.utoff + 3600;
  if (/^[+-]?\d/.test(spec.slice(cursor))) {
    const parsed = parsePosixOffset(spec, cursor);
    if (!parsed) return null;
    dstOff = parsed.utoff;
    cursor = parsed.next;
  }
  if (spec[cursor] !== ',') {
    return { stdName: std.name, stdOff: stdOff.utoff, dstName: dst.name, dstOff };
  }
  cursor += 1;
  const start = parsePosixDate(spec, cursor);
  if (!start) return null;
  cursor = start.next;
  let startTime = 2 * 3600;
  if (spec[cursor] === '/') {
    const parsed = parsePosixTime(spec, cursor + 1);
    if (!parsed) return null;
    startTime = parsed.seconds;
    cursor = parsed.next;
  }
  if (spec[cursor] !== ',') return null;
  cursor += 1;
  const end = parsePosixDate(spec, cursor);
  if (!end) return null;
  cursor = end.next;
  let endTime = 2 * 3600;
  if (spec[cursor] === '/') {
    const parsed = parsePosixTime(spec, cursor + 1);
    if (!parsed) return null;
    endTime = parsed.seconds;
    cursor = parsed.next;
  }
  return {
    stdName: std.name,
    stdOff: stdOff.utoff,
    dstName: dst.name,
    dstOff,
    start: start.date,
    startTime,
    end: end.date,
    endTime,
  };
}

function loadSnapshotFromBuffer(buf) {
  if (buf.toString('ascii', 0, 4) !== 'TZif') return null;
  const first = parseSection(buf, 0, false);
  const version = buf.toString('ascii', 4, 5);
  let section = first;
  let posix = null;
  if (version >= '2') {
    section = parseSection(buf, first.end, true);
    if (buf[section.end] === 0x0a) {
      const endNl = buf.indexOf(0x0a, section.end + 1);
      if (endNl > section.end + 1) {
        posix = parsePosixTz(buf.toString('ascii', section.end + 1, endNl));
      }
    }
  }
  const initialType = section.types[0] || { utoff: 0, desigidx: 0 };
  const transitions = section.times.map((time, index) => {
    const type = section.types[section.typeIndexes[index]] || initialType;
    return {
      time,
      utoff: type.utoff,
      abbr: designation(section.chars, type.desigidx),
    };
  });
  return {
    transitions,
    initial: {
      utoff: initialType.utoff,
      abbr: designation(section.chars, initialType.desigidx),
    },
    posix,
  };
}

function loadSnapshot() {
  try {
    const stat = fs.statSync(ZONE_PATH);
    if (cachedSnapshot && cachedMtimeMs === stat.mtimeMs) return cachedSnapshot;
    const snapshot = loadSnapshotFromBuffer(fs.readFileSync(ZONE_PATH));
    cachedSnapshot = snapshot;
    cachedMtimeMs = stat.mtimeMs;
    return snapshot;
  } catch {
    cachedSnapshot = null;
    cachedMtimeMs = null;
    return null;
  }
}

module.exports = {
  loadSnapshot,
  parsePosixTz,
};
