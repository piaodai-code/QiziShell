/** TLS verification policy: strict on public hosts; relaxed only for local/private/tailnet. */

function normalizeHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isTailscaleHostname(hostname) {
  return hostname.endsWith('.ts.net');
}

function isPrivateOrLocalHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (isTailscaleHostname(host)) return true;
  // Tailscale CGNAT 100.64.0.0/10
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host.endsWith('.local')) return true;
  return false;
}

function hostnameFromUrl(url) {
  try {
    return normalizeHostname(new URL(String(url)).hostname);
  } catch {
    return '';
  }
}

function shouldAllowInsecureTls(urlOrHostname) {
  const host = urlOrHostname.includes('://') || urlOrHostname.includes('/')
    ? hostnameFromUrl(urlOrHostname)
    : normalizeHostname(urlOrHostname);
  return isPrivateOrLocalHost(host);
}

function rejectUnauthorizedForUrl(url) {
  return !shouldAllowInsecureTls(url);
}

module.exports = {
  isPrivateOrLocalHost,
  shouldAllowInsecureTls,
  rejectUnauthorizedForUrl,
  hostnameFromUrl,
};
