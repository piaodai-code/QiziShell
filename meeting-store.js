const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const LEGACY_MEETINGS_DIR = path.join(os.homedir(), 'Documents', 'QiziShell', 'meetings');
let legacyMeetingsMigrated = false;

function getMeetingsDir() {
  return path.join(app.getPath('userData'), 'meetings');
}

function migrateLegacyMeetingsDir() {
  if (legacyMeetingsMigrated) return;
  legacyMeetingsMigrated = true;

  const nextDir = getMeetingsDir();
  if (!fs.existsSync(LEGACY_MEETINGS_DIR)) return;

  fs.mkdirSync(nextDir, { recursive: true });
  const files = fs.readdirSync(LEGACY_MEETINGS_DIR).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    const from = path.join(LEGACY_MEETINGS_DIR, name);
    const to = path.join(nextDir, name);
    if (fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(from, to);
    } catch {
      // ignore per-file migration errors
    }
  }
}

function ensureMeetingsDir() {
  migrateLegacyMeetingsDir();
  fs.mkdirSync(getMeetingsDir(), { recursive: true });
}

function isAllowedMeetingRecordPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(getMeetingsDir()),
    path.resolve(LEGACY_MEETINGS_DIR),
  ];
  return allowedRoots.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
}

function buildMeetingFilename(meetingId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `meeting-${stamp}-${meetingId.slice(0, 8)}.json`;
}

function saveMeetingRecord(record) {
  ensureMeetingsDir();
  const filename = buildMeetingFilename(record.id);
  const filePath = path.join(getMeetingsDir(), filename);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return filePath;
}

function listMeetingRecords(limit = 20) {
  ensureMeetingsDir();
  const files = fs.readdirSync(getMeetingsDir())
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const full = path.join(getMeetingsDir(), name);
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
  if (!isAllowedMeetingRecordPath(filePath)) {
    throw new Error('无效会议记录路径');
  }
  const record = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
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
  getMeetingsDir,
  saveMeetingRecord,
  listMeetingRecords,
  loadMeetingRecordFile,
  loadMeetingRecordById,
};
