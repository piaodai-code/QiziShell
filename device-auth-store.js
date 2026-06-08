const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVICE_AUTH_FILE = 'device-auth.json';

function resolveAuthPath() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
  return path.join(stateDir, 'identity', DEVICE_AUTH_FILE);
}

function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.deviceId === 'string' &&
      parsed.tokens &&
      typeof parsed.tokens === 'object'
    ) {
      return parsed;
    }
  } catch {
    // empty
  }
  return null;
}

function writeStore(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function loadDeviceAuthToken({ deviceId, role }) {
  const filePath = resolveAuthPath();
  const store = readStore(filePath);
  if (!store || store.deviceId !== deviceId) return null;
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== 'string') return null;
  return { token: entry.token, scopes: Array.isArray(entry.scopes) ? entry.scopes : [] };
}

function storeDeviceAuthToken({ deviceId, role, token, scopes = [] }) {
  const filePath = resolveAuthPath();
  const existing = readStore(filePath);
  const store = {
    version: 1,
    deviceId,
    tokens:
      existing && existing.deviceId === deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  store.tokens[role] = {
    token,
    role,
    scopes,
    updatedAtMs: Date.now(),
  };
  writeStore(filePath, store);
  return { token, scopes };
}

function clearDeviceAuthToken({ deviceId, role }) {
  const filePath = resolveAuthPath();
  const store = readStore(filePath);
  if (!store || store.deviceId !== deviceId || !store.tokens[role]) return;
  const next = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[role];
  writeStore(filePath, next);
}

module.exports = {
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
};
