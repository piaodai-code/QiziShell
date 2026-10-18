const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getMeetingsDir } = require('./meeting-store');
const { extractMeetingFinalSummaryText } = require('./meeting-protocol');

const LEDGER_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_FILE = 'meeting-topic-ledger.json';
const SUMMARY_STORE_CHARS = 8000;

let backfillDone = false;

function ledgerPath() {
  return path.join(app.getPath('userData'), LEDGER_FILE);
}

function withinWindow(iso, now = Date.now()) {
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && now - time <= LEDGER_MS && time <= now + 60_000;
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    if (Array.isArray(parsed?.entries)) return parsed.entries;
  } catch {
    // missing or unreadable ledger
  }
  return [];
}

function normalizeEntry(entry) {
  const meetingId = String(entry?.meetingId || '').trim();
  const topic = String(entry?.topic || '').trim();
  const finishedAt = String(entry?.finishedAt || '').trim();
  let finalSummary = String(entry?.finalSummary || '').trim();
  if (!meetingId || !topic || !finishedAt || !finalSummary) return null;
  if (finalSummary.length > SUMMARY_STORE_CHARS) {
    finalSummary = `${finalSummary.slice(0, SUMMARY_STORE_CHARS).trim()}\n\n（下文已截断）`;
  }
  return { meetingId, topic, finishedAt, finalSummary };
}

function writeLedger(entries) {
  const pruned = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const normalized = normalizeEntry(entry);
    if (!normalized || seen.has(normalized.meetingId) || !withinWindow(normalized.finishedAt)) continue;
    seen.add(normalized.meetingId);
    pruned.push(normalized);
  }
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(
    ledgerPath(),
    `${JSON.stringify({ version: 1, entries: pruned }, null, 2)}\n`,
    'utf8',
  );
  return pruned;
}

function entryFromRecord(record) {
  const meetingId = String(record?.id || '').trim();
  const topic = String(record?.topic || '').trim();
  const finishedAt = String(record?.finishedAt || record?.startedAt || '').trim();
  const finalSummary = extractMeetingFinalSummaryText(record);
  return normalizeEntry({ meetingId, topic, finishedAt, finalSummary });
}

function backfill(entries) {
  if (backfillDone) return entries;
  const dir = getMeetingsDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    backfillDone = true;
    return entries;
  }
  const next = entries.slice();
  const seen = new Set(next.map((entry) => entry.meetingId));
  for (const name of names) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const entry = entryFromRecord(record);
    if (!entry || seen.has(entry.meetingId) || !withinWindow(entry.finishedAt)) continue;
    seen.add(entry.meetingId);
    next.push(entry);
  }
  backfillDone = true;
  return writeLedger(next);
}

function loadEntries() {
  const pruned = writeLedger(readLedger());
  return backfill(pruned);
}

function recordMeetingDecision(record) {
  const entry = entryFromRecord(record);
  if (!entry) return { ok: false, skipped: true };
  const entries = loadEntries().filter((item) => item.meetingId !== entry.meetingId);
  entries.push(entry);
  writeLedger(entries);
  return { ok: true };
}

function listPriorTopicSummaries(topic) {
  const key = String(topic || '').trim();
  if (!key) return [];
  return loadEntries()
    .filter((entry) => entry.topic === key)
    .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
}

function priorTopicExcerpt(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= 80) return line;
  return `${line.slice(0, 80)}…`;
}

module.exports = {
  LEDGER_MS,
  recordMeetingDecision,
  listPriorTopicSummaries,
  priorTopicExcerpt,
};
