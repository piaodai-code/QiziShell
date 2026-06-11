function normalizeDeviceMetadata(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

function sanitizePayloadField(value) {
  return String(value ?? '').replace(/\|/g, '');
}

function buildDeviceAuthPayloadV3(params) {
  const scopes = sanitizePayloadField(params.scopes.join(','));
  const token = sanitizePayloadField(params.token ?? '');
  const platform = normalizeDeviceMetadata(params.platform);
  const deviceFamily = normalizeDeviceMetadata(params.deviceFamily);
  return [
    'v3',
    sanitizePayloadField(params.deviceId),
    sanitizePayloadField(params.clientId),
    sanitizePayloadField(params.clientMode),
    sanitizePayloadField(params.role),
    scopes,
    sanitizePayloadField(String(params.signedAtMs)),
    token,
    sanitizePayloadField(params.nonce),
    platform,
    deviceFamily,
  ].join('|');
}

module.exports = { buildDeviceAuthPayloadV3 };
