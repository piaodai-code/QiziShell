#!/usr/bin/env node
/**
 * OpenClaw 9.1+ avatar 解析 smoke test（纯逻辑，不连 Gateway）
 *
 *   node scripts/agent-avatar-smoke.js
 */
function pickAvatarCandidate(...values) {
  for (const value of values) {
    const raw = String(value || '').trim();
    if (raw) return raw;
  }
  return '';
}

function isDataUrl(value) {
  return String(value || '').trim().startsWith('data:');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveInlineAvatarValue(avatarValue) {
  const raw = String(avatarValue || '').trim();
  if (!raw) return null;
  if (isDataUrl(raw) || isHttpUrl(raw)) return raw;
  return null;
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

const dataUri = 'data:image/png;base64,abc123';

runCase('OpenClaw 9.1 data URI 应直接可用', () => {
  if (resolveInlineAvatarValue(dataUri) !== dataUri) {
    throw new Error('expected inline data URI');
  }
});

runCase('avatarUrl 优先于 avatar', () => {
  const picked = pickAvatarCandidate(dataUri, '/avatar/main');
  if (picked !== dataUri) throw new Error(`expected data URI, got ${picked}`);
});

runCase('legacy /avatar 路径不应被当作 inline', () => {
  if (resolveInlineAvatarValue('/avatar/main')) {
    throw new Error('route path should not be inline');
  }
});

runCase('https 外链应直接可用', () => {
  const url = 'https://example.com/a.png';
  if (resolveInlineAvatarValue(url) !== url) throw new Error('expected https passthrough');
});

if (process.exitCode) {
  console.error('\nagent-avatar-smoke FAILED');
  process.exit(1);
}
console.log('\nagent-avatar-smoke OK');
