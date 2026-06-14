const fs = require('fs');
const os = require('os');
const path = require('path');

const MEETINGS_DIR = path.join(os.homedir(), 'Documents', 'QiziShell', 'meetings');

function ensureMeetingsDir() {
  fs.mkdirSync(MEETINGS_DIR, { recursive: true });
}

function buildMeetingFilename(meetingId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `meeting-${stamp}-${meetingId.slice(0, 8)}.json`;
}

function saveMeetingRecord(record) {
  ensureMeetingsDir();
  const filename = buildMeetingFilename(record.id);
  const filePath = path.join(MEETINGS_DIR, filename);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return filePath;
}

function listMeetingRecords(limit = 20) {
  ensureMeetingsDir();
  const files = fs.readdirSync(MEETINGS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const full = path.join(MEETINGS_DIR, name);
      const stat = fs.statSync(full);
      return { name, full, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  return files.map(({ name, full, mtime }) => {
    try {
      const record = JSON.parse(fs.readFileSync(full, 'utf8'));
      return {
        file: full,
        name,
        mtime,
        id: record.id,
        topic: record.topic,
        state: record.state,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      };
    } catch {
      return { file: full, name, mtime };
    }
  });
}

function loadMeetingRecordFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('缺少会议记录路径');
  }
  const resolved = path.resolve(filePath);
  const dir = path.resolve(MEETINGS_DIR);
  if (!resolved.startsWith(`${dir}${path.sep}`) && resolved !== dir) {
    throw new Error('无效会议记录路径');
  }
  const record = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return record;
}

function loadMeetingRecordById(meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) throw new Error('缺少会议 id');
  const entries = listMeetingRecords(200);
  const found = entries.find((entry) => entry.id === id);
  if (!found?.file) throw new Error('未找到会议记录');
  return loadMeetingRecordFile(found.file);
}

module.exports = {
  MEETINGS_DIR,
  saveMeetingRecord,
  listMeetingRecords,
  loadMeetingRecordFile,
  loadMeetingRecordById,
};
