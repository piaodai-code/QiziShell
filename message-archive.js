const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createMessageArchiveStore(dirPath) {
  function resolveDir() {
    return typeof dirPath === 'function' ? dirPath() : dirPath;
  }

  function fileFor(sessionKey) {
    const hash = crypto.createHash('sha256').update(String(sessionKey)).digest('hex');
    return path.join(resolveDir(), `${hash}.json`);
  }

  function readFile(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed.sessionKey !== 'string' || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function read(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return [];
    const parsed = readFile(fileFor(key));
    if (!parsed || parsed.sessionKey !== key) return [];
    return parsed.messages;
  }

  function write(sessionKey, messages) {
    const key = String(sessionKey || '').trim();
    if (!key) throw new Error('未指定 session');
    if (!Array.isArray(messages)) throw new Error('归档格式无效');
    const dir = resolveDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = fileFor(key);
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessionKey: key, messages }));
    fs.renameSync(tmp, target);
  }

  function list() {
    let names = [];
    try {
      names = fs.readdirSync(resolveDir());
    } catch {
      return [];
    }
    const archives = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const parsed = readFile(path.join(resolveDir(), name));
      if (!parsed) continue;
      archives.push({ sessionKey: parsed.sessionKey, messages: parsed.messages });
    }
    return archives;
  }

  return { read, write, list };
}

module.exports = { createMessageArchiveStore };
