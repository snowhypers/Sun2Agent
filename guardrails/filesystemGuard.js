// Filesystem guard — validates a path before any tool reads or writes it.
//
// Two rules: never touch credential material, and never escape the project
// root. Paths are resolved first, so "a/../../../etc/passwd" is judged by
// where it actually lands rather than how it is spelled.

const path = require('path');
const os = require('os');
const { projectRoot, protectedFiles } = require('./guardConfig');

// URLs, flags and prose are not paths. Only strings that actually look like
// filesystem locations get checked, to avoid firing on ordinary tool args.
function looksLikePath(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 4096) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false; // http://, file://, etc.
  if (/^-/.test(v)) return false; // CLI flag
  return (
    v.startsWith('/') ||
    v.startsWith('~') ||
    v.startsWith('./') ||
    v.startsWith('../') ||
    v.startsWith('.\\') ||
    v.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(v) || // Windows drive
    /[/\\]/.test(v) // any relative path with a separator
  );
}

// Expand ~ and resolve to an absolute path against the project root.
function resolvePath(p) {
  let raw = String(p).trim();
  if (raw === '~') raw = os.homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(projectRoot, raw);
}

function isInsideRoot(resolved) {
  const rel = path.relative(projectRoot, resolved);
  // Empty means the root itself; "..'-prefixed means it escaped.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validatePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: true };

  const resolved = resolvePath(filePath);

  // Credential material is off-limits wherever it lives — including inside
  // the project root, where a stray .env is the most likely place to find it.
  for (const pattern of protectedFiles) {
    if (pattern.test(resolved) || pattern.test(filePath)) {
      return {
        ok: false,
        guard: 'filesystem',
        matched: String(pattern),
        reason: `Blocked by Filesystem Guard: "${filePath}" is protected credential material`
      };
    }
  }

  if (!isInsideRoot(resolved)) {
    return {
      ok: false,
      guard: 'filesystem',
      matched: resolved,
      reason: `Blocked by Filesystem Guard: "${filePath}" resolves outside the project root (${projectRoot})`
    };
  }

  return { ok: true };
}

module.exports = { validatePath, looksLikePath, resolvePath, isInsideRoot };
