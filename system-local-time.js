const { execFileSync } = require('child_process');
const fs = require('fs');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONE_PATH = '/etc/localtime';

const offsetByHour = new Map();
let zoneMtimeMs = null;

function zoneStamp() {
  try {
    return fs.statSync(ZONE_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function parseOffset(text) {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60);
}

function zoneAt(unixSeconds) {
  const stamp = zoneStamp();
  if (stamp !== zoneMtimeMs) {
    offsetByHour.clear();
    zoneMtimeMs = stamp;
  }
  const bucket = Math.floor(unixSeconds / 3600);
  const cached = offsetByHour.get(bucket);
  if (cached) return cached;
  const sample = bucket * 3600 + 1800;
  const line = execFileSync('/bin/date', ['-r', String(sample), '+%z %Z'], { encoding: 'utf8' }).trim();
  const [offsetText, abbr] = line.split(/\s+/);
  const utoff = parseOffset(offsetText);
  if (utoff == null) return null;
  const zone = { utoff, abbr: abbr || '' };
  offsetByHour.set(bucket, zone);
  return zone;
}

/** Wall-clock parts from macOS `date`, the same conversion the menu bar uses. */
function localParts(ms) {
  const instant = Number(ms);
  if (!Number.isFinite(instant)) return null;
  let zone;
  try {
    zone = zoneAt(Math.floor(instant / 1000));
  } catch {
    return null;
  }
  if (!zone) return null;
  const shifted = new Date(instant + zone.utoff * 1000);
  if (Number.isNaN(shifted.getTime())) return null;
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: WEEKDAYS[shifted.getUTCDay()],
    abbr: zone.abbr,
    offsetSeconds: zone.utoff,
  };
}

module.exports = { localParts };
