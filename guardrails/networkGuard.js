// Network guard — inspects commands for outbound data exfiltration.
//
// This guard performs no network activity of its own: no DNS, no HTTP. It
// only reads strings and decides whether they should be allowed to run.

const {
  blockedNetworkCommands,
  exfiltrationPatterns,
  strictDomains,
  allowedDomains,
  protectedFiles
} = require('./guardConfig');

// Pull hostnames out of any URLs mentioned in the command.
function extractHosts(command) {
  const hosts = [];
  const re = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/"'`)]+)/gi;
  let m;
  while ((m = re.exec(command)) !== null) {
    const authority = m[1];
    const host = authority.split('@').pop().split(':')[0].toLowerCase();
    if (host) hosts.push(host);
  }
  return hosts;
}

function isAllowedHost(host) {
  return allowedDomains.some((d) => host === d || host.endsWith('.' + d));
}

function validateNetwork(command) {
  if (typeof command !== 'string' || !command.trim()) return { ok: true };

  // Piping local data into an outbound command is exfiltration outright.
  for (const pattern of exfiltrationPatterns) {
    if (pattern.test(command)) {
      return {
        ok: false,
        guard: 'network',
        matched: String(pattern),
        reason: `Blocked by Network Guard: data exfiltration pattern (${pattern})`
      };
    }
  }

  // An upload-shaped command that also names credential material is the same
  // thing spelled differently.
  const uploads = blockedNetworkCommands.filter((p) => p.test(command));
  if (uploads.length) {
    for (const secret of protectedFiles) {
      if (secret.test(command)) {
        return {
          ok: false,
          guard: 'network',
          matched: String(secret),
          reason: `Blocked by Network Guard: outbound command references protected credentials`
        };
      }
    }
    return {
      ok: false,
      guard: 'network',
      matched: String(uploads[0]),
      reason: `Blocked by Network Guard: outbound data transfer (${uploads[0]})`
    };
  }

  // Optional allowlist. Off by default — search and scraping servers need to
  // reach arbitrary hosts to be useful at all.
  if (strictDomains) {
    for (const host of extractHosts(command)) {
      if (!isAllowedHost(host)) {
        return {
          ok: false,
          guard: 'network',
          matched: host,
          reason: `Blocked by Network Guard: "${host}" is not in the allowed domain list`
        };
      }
    }
  }

  return { ok: true };
}

module.exports = { validateNetwork, extractHosts, isAllowedHost };
