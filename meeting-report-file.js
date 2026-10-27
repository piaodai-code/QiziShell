/**
 * 阅读报告路径是 OpenClaw 网关所在机器上的绝对路径。
 * 这里只检查写法。文件在不在，由网关上的 qizi.files.stat 确认。
 */
function prepareReadingReportPath(readingReport) {
  const raw = String(readingReport || '').trim();
  if (!raw) return { ok: true, path: '' };
  if (raw.includes('\0')) return { ok: false, error: '阅读报告路径无效' };
  const absolute = raw.startsWith('/') || raw === '~' || raw.startsWith('~/');
  if (!absolute) {
    return {
      ok: false,
      error: `阅读报告要填 OpenClaw 网关那台机器上的绝对路径，当前不是：${raw}`,
    };
  }
  return { ok: true, path: raw };
}

function isMissingGatewayMethod(err) {
  const text = `${err?.message || ''} ${err?.code || ''}`;
  return /unknown method|method not found|not implemented|未注册|没有这个方法/i.test(text);
}

module.exports = {
  prepareReadingReportPath,
  isMissingGatewayMethod,
};
