'use strict';

const { isIP } = require('node:net');
function isRemoteServer(server) {
  if (!['http', 'https', 'streamable-http', 'remote', 'sse'].includes(server?.type)) return false;
  try {
    const url = new URL(server.url);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || !host || host === 'localhost' ||
        (!host.includes('.') && !isIP(host)) || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168)) return false;
    }
    if (isIP(host) === 6 && (/^(::1|::|f[cd]|fe[89ab])/.test(host))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { isRemoteServer };
