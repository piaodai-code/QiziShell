const { saveMeetingRecord, listMeetingRecords, loadMeetingRecordFile, loadMeetingRecordById } = require('./meeting-store');
const { extractMeetingFinalSummaryText } = require('./meeting-protocol');
const {
  isWithinLedgerWindow,
  listPriorTopicSummaries,
  recordMeetingDecision,
} = require('./meeting-topic-ledger');

const RECORD_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const RECORD_MAX_CHARS = 2_000_000;
const SUMMARY_STORE_CHARS = 8000;

let recordsApi = 'unknown';
let migration = null;

function isMissingMethod(err) {
  const text = `${err?.message || ''} ${err?.code || ''}`;
  return /unknown method|method not found|not implemented|未注册|没有这个方法/i.test(text);
}

function prepareRecord(record) {
  const next = { ...(record || {}) };
  const id = String(next.id || '').trim();
  next.id = id;
  let finalSummary = extractMeetingFinalSummaryText(next);
  if (finalSummary.length > SUMMARY_STORE_CHARS) {
    finalSummary = `${finalSummary.slice(0, SUMMARY_STORE_CHARS).trim()}\n\n（下文已截断）`;
  }
  if (finalSummary) next.finalSummary = finalSummary;
  return next;
}

function normalizeListed(entry) {
  const id = String(entry?.id || '').trim();
  if (!RECORD_ID_RE.test(id)) return null;
  return {
    id,
    topic: String(entry?.topic || '').trim(),
    state: String(entry?.state || '').trim(),
    startedAt: String(entry?.startedAt || '').trim(),
    finishedAt: String(entry?.finishedAt || entry?.startedAt || '').trim(),
    noRepeatPastTopics: Boolean(entry?.noRepeatPastTopics),
    finalSummary: String(entry?.finalSummary || '').trim(),
  };
}

function listedFromLocal(entry) {
  return {
    id: String(entry?.id || '').trim(),
    file: entry?.file,
    topic: entry?.topic,
    state: entry?.state,
    startedAt: entry?.startedAt,
    finishedAt: entry?.finishedAt,
  };
}

function parseStoredRecord(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) throw new Error('会议记录为空');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('会议记录不是 JSON 对象');
  }
  return parsed;
}

async function migrateLocalRecords(request) {
  if (recordsApi === 'missing' || migration) return migration;
  const local = listMeetingRecords(500);
  if (!local.length) return null;
  migration = (async () => {
    for (const entry of local) {
      let record;
      try {
        record = loadMeetingRecordFile(entry.file);
      } catch {
        continue;
      }
      const prepared = prepareRecord(record);
      if (!RECORD_ID_RE.test(prepared.id)) continue;
      const body = JSON.stringify(prepared);
      if (body.length > RECORD_MAX_CHARS) {
        console.error('[qizi] 会议记录超过服务器上限，仍留在本机', prepared.id);
        continue;
      }
      try {
        await request('qizi.meetingRecords.put', { id: prepared.id, record: body });
        recordsApi = 'ok';
        const fs = require('fs');
        fs.unlinkSync(entry.file);
      } catch (err) {
        if (isMissingMethod(err)) recordsApi = 'missing';
        console.error('[qizi] 上传已开完的会议失败', prepared.id, err?.message || err);
        break;
      }
    }
  })().finally(() => {
    migration = null;
  });
  return migration;
}

async function listRemoteRecords(request) {
  const listed = await request('qizi.meetingRecords.list', {});
  recordsApi = 'ok';
  const records = Array.isArray(listed?.records) ? listed.records : [];
  return records.map(normalizeListed).filter(Boolean);
}

async function listFinishedMeetings(request, limit = 10) {
  if (recordsApi !== 'missing') {
    try {
      const remote = await listRemoteRecords(request);
      void migrateLocalRecords(request);
      const remoteIds = new Set(remote.map((entry) => entry.id));
      const localOnly = listMeetingRecords(500)
        .map(listedFromLocal)
        .filter((entry) => entry.id && !remoteIds.has(entry.id));
      const merged = remote.concat(localOnly).sort((a, b) => {
        const left = new Date(b.finishedAt || b.startedAt || 0).getTime();
        const right = new Date(a.finishedAt || a.startedAt || 0).getTime();
        return left - right;
      });
      return { ok: true, records: merged.slice(0, limit) };
    } catch (err) {
      if (isMissingMethod(err)) recordsApi = 'missing';
      else console.error('[qizi] 读取服务器会议记录失败', err?.message || err);
    }
  }
  return { ok: true, records: listMeetingRecords(limit).map(listedFromLocal), local: true };
}

async function saveFinishedMeeting(request, record) {
  const prepared = prepareRecord(record);
  if (!RECORD_ID_RE.test(prepared.id)) {
    return { ok: false, error: '会议 id 无效' };
  }
  const body = JSON.stringify(prepared);
  if (body.length > RECORD_MAX_CHARS) {
    return { ok: false, error: '会议记录超过服务器上限' };
  }
  if (recordsApi !== 'missing') {
    try {
      await request('qizi.meetingRecords.put', { id: prepared.id, record: body });
      recordsApi = 'ok';
      return { ok: true, id: prepared.id };
    } catch (err) {
      if (isMissingMethod(err)) recordsApi = 'missing';
      const message = err?.message || String(err);
      try {
        saveMeetingRecord(prepared);
        recordMeetingDecision(prepared);
      } catch (localErr) {
        return { ok: false, error: message || localErr.message };
      }
      return { ok: false, error: `会议全文未能写到服务器（${message}），已暂存在本机` };
    }
  }
  try {
    saveMeetingRecord(prepared);
    recordMeetingDecision(prepared);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  return { ok: false, error: '服务器还没有会议记录接口，已暂存在本机' };
}

async function loadFinishedMeeting(request, payload) {
  const file = payload?.file;
  const id = String(payload?.id || '').trim();
  if (file) return loadMeetingRecordFile(file);
  if (!RECORD_ID_RE.test(id)) throw new Error('缺少会议 id');
  if (recordsApi !== 'missing') {
    try {
      const got = await request('qizi.meetingRecords.get', { id });
      recordsApi = 'ok';
      return parseStoredRecord(got?.record);
    } catch (err) {
      if (isMissingMethod(err)) recordsApi = 'missing';
      else if (!/not found|no such|enoent|不存在|未找到/i.test(String(err?.message || ''))) {
        throw err;
      }
    }
  }
  return loadMeetingRecordById(id);
}

function localPriorEntries() {
  const entries = [];
  for (const entry of listMeetingRecords(500)) {
    let record;
    try {
      record = loadMeetingRecordFile(entry.file);
    } catch {
      continue;
    }
    const prepared = prepareRecord(record);
    if (!prepared.id || !prepared.finalSummary) continue;
    const finishedAt = prepared.finishedAt || prepared.startedAt;
    if (!isWithinLedgerWindow(finishedAt)) continue;
    entries.push({
      meetingId: prepared.id,
      topic: prepared.topic,
      finishedAt,
      finalSummary: prepared.finalSummary,
      noRepeatPastTopics: Boolean(prepared.noRepeatPastTopics),
    });
  }
  return entries;
}

async function listPriorSummaries(request, topic) {
  const key = String(topic || '').trim();
  if (!key) return [];
  const localEntries = localPriorEntries().filter((entry) => entry.topic === key);
  if (recordsApi !== 'missing') {
    try {
      const remote = await listRemoteRecords(request);
      void migrateLocalRecords(request);
      const seen = new Set();
      const merged = [];
      for (const entry of remote) {
        if (entry.topic !== key || !entry.finalSummary || !isWithinLedgerWindow(entry.finishedAt)) continue;
        seen.add(entry.id);
        merged.push({
          meetingId: entry.id,
          topic: entry.topic,
          finishedAt: entry.finishedAt,
          finalSummary: entry.finalSummary,
          noRepeatPastTopics: entry.noRepeatPastTopics,
        });
      }
      for (const entry of localEntries) {
        if (seen.has(entry.meetingId)) continue;
        merged.push(entry);
      }
      return merged.sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
    } catch (err) {
      if (isMissingMethod(err)) recordsApi = 'missing';
      else console.error('[qizi] 读取往期会议失败', err?.message || err);
    }
  }
  if (localEntries.length) return localEntries;
  return listPriorTopicSummaries(key);
}

module.exports = {
  RECORD_ID_RE,
  listFinishedMeetings,
  saveFinishedMeeting,
  loadFinishedMeeting,
  listPriorSummaries,
};
