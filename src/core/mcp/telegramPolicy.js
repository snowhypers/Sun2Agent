'use strict';

const { isIP } = require('node:net');
const { requiresApproval } = require('../hitl/mcpApproval');

function isRemoteServer(server) {
  if (!['http', 'https', 'streamable-http', 'remote', 'sse'].includes(server?.type)) return false;
  try {
    const url = new URL(server.url);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || !host || host === 'localhost' ||
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

function isReadOnlyTool(route) {
  const name = String(route?.tool || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return Boolean(route &&
    /(?:^|_)(search|list|read|get|fetch|find|lookup|query|inspect|describe|check|count|show|view|extract|map|research|resolve|stat|stats|crawl)(?:_|$)/i.test(name) &&
    !requiresApproval(route.tool, route.annotations));
}

module.exports = { isRemoteServer, isReadOnlyTool };
