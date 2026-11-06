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

  function userMessageKey(message) {
    if (!message || message.who !== 'me' || message.sentAtMs == null) return '';
    return `${message.sentAtMs}\0${String(message.text || '').trim()}`;
  }

  function dedupeMessages(messages) {
    const seen = new Set();
    const out = [];
    for (const message of messages) {
      const key = userMessageKey(message);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(message);
    }
    return out;
  }

  function writeParsed(filePath, parsed) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      sessionKey: parsed.sessionKey,
      messages: parsed.messages,
    }));
    fs.renameSync(tmp, filePath);
  }

  function readFile(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed.sessionKey !== 'string' || !Array.isArray(parsed.messages)) return null;
      const messages = dedupeMessages(parsed.messages);
      if (messages.length !== parsed.messages.length) {
        parsed.messages = messages;
        try {
          writeParsed(filePath, parsed);
        } catch {
          // 读路径上的压缩失败不影响这次返回
        }
      }
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
    const target = fileFor(key);
    writeParsed(target, { sessionKey: key, messages: dedupeMessages(messages) });
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
