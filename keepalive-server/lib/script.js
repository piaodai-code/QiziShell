'use strict';

const fs = require('fs');

const MAX_STEPS = 50;
const MAX_WAIT_MS = 120000;
const STEP_ACTIONS = ['open', 'reload', 'click', 'wait'];

class ScriptError extends Error {}

/** Accepts a bare pattern ("扫码登录|请重新登录") or a literal ("/\\/login|passport/i"). */
function compilePattern(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ScriptError(`${label} 要写成字符串`);
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(value);
  const source = literal ? literal[1] : value;
  // g and y make test() remember its position between calls.
  const flags = (literal ? literal[2] : '').replace(/[gy]/g, '');
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new ScriptError(`${label} 不是有效的正则：${err.message}`);
  }
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ScriptError(`${label} 要写成字符串`);
  return value.trim();
}

function parseStep(raw, index) {
  const label = `keepAlive.steps[${index}]`;
  if (!raw || typeof raw !== 'object') throw new ScriptError(`${label} 要写成对象`);
  const action = String(raw.action || '');
  if (!STEP_ACTIONS.includes(action)) {
    throw new ScriptError(`${label}.action 只能是 ${STEP_ACTIONS.join(' / ')}，现在是 ${JSON.stringify(raw.action)}`);
  }
  if (action === 'open') {
    const url = optionalString(raw.url, `${label}.url`);
    if (url && !/^https?:\/\//i.test(url)) throw new ScriptError(`${label}.url 要以 http:// 或 https:// 开头`);
    return { action, url };
  }
  if (action === 'reload') return { action };
  if (action === 'click') {
    const selector = optionalString(raw.selector, `${label}.selector`);
    if (!selector) throw new ScriptError(`${label} 缺少 selector`);
    const timeout = raw.timeout_ms === undefined ? 10000 : Number(raw.timeout_ms);
    if (!Number.isFinite(timeout) || timeout < 500 || timeout > 60000) {
      throw new ScriptError(`${label}.timeout_ms 要在 500–60000 之间`);
    }
    return { action, selector, timeout_ms: timeout, optional: raw.optional === true };
  }
  const range = Array.isArray(raw.ms) ? raw.ms : [raw.ms, raw.ms];
  const [min, max] = range.map(Number);
  if (range.length !== 2 || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > MAX_WAIT_MS) {
    throw new ScriptError(`${label}.ms 要写成毫秒数，或 [最短, 最长]，上限 ${MAX_WAIT_MS}`);
  }
  return { action, ms: [min, max] };
}

function parseDetect(raw) {
  if (!raw || typeof raw !== 'object') throw new ScriptError('缺少 detect');
  const aliveSelectors = Array.isArray(raw.aliveSelectors)
    ? raw.aliveSelectors.map((item, i) => optionalString(item, `detect.aliveSelectors[${i}]`)).filter(Boolean)
    : [];
  if (aliveSelectors.length === 0) {
    throw new ScriptError('detect.aliveSelectors 至少要有一个选择器，否则永远判断不出“已登录”');
  }
  const detect = {
    loginUrlPattern: compilePattern(raw.loginUrlPattern, 'detect.loginUrlPattern'),
    requiredUrlSubstr: optionalString(raw.requiredUrlSubstr, 'detect.requiredUrlSubstr'),
    logoutTextPattern: compilePattern(raw.logoutTextPattern, 'detect.logoutTextPattern'),
    qrSelector: optionalString(raw.qrSelector, 'detect.qrSelector'),
    aliveSelectors,
    apiHostFilter: optionalString(raw.apiHostFilter, 'detect.apiHostFilter'),
    apiAuthErrorCodes: (Array.isArray(raw.apiAuthErrorCodes) ? raw.apiAuthErrorCodes : []).map(String),
    apiAuthErrorFields: Array.isArray(raw.apiAuthErrorFields) && raw.apiAuthErrorFields.length > 0
      ? raw.apiAuthErrorFields.map(String)
      : ['errCode', 'code'],
    apiAuthHttpStatuses: Array.isArray(raw.apiAuthHttpStatuses)
      ? raw.apiAuthHttpStatuses.map(Number).filter(Number.isInteger)
      : [401],
  };
  const hasLogoutEvidence = detect.loginUrlPattern || detect.logoutTextPattern || detect.qrSelector
    || (detect.apiHostFilter && (detect.apiAuthErrorCodes.length > 0 || detect.apiAuthHttpStatuses.length > 0));
  if (!hasLogoutEvidence) {
    throw new ScriptError('detect 里至少要有一种掉线依据：loginUrlPattern、logoutTextPattern、qrSelector，或 apiHostFilter 加错误码');
  }
  return detect;
}

function parseScript(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScriptError('脚本要写成一个 JSON 对象');
  const steps = raw.keepAlive?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new ScriptError('keepAlive.steps 至少要有一步');
  if (steps.length > MAX_STEPS) throw new ScriptError(`keepAlive.steps 最多 ${MAX_STEPS} 步`);
  return {
    keepAlive: { steps: steps.map(parseStep) },
    detect: parseDetect(raw.detect),
  };
}

/**
 * Reads the agent's script from disk on every use, so a replaced file takes
 * effect on the next round without a restart.
 */
function loadScript(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing', script: null, error: '' };
    return { state: 'invalid', script: null, error: `脚本读不出来：${err.message}` };
  }
  try {
    return { state: 'ok', script: parseScript(JSON.parse(text)), error: '' };
  } catch (err) {
    const detail = err instanceof ScriptError ? err.message : `不是有效的 JSON：${err.message}`;
    return { state: 'invalid', script: null, error: detail };
  }
}

module.exports = { loadScript, parseScript, ScriptError };
