const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function getUserIdPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.sun2agent', 'user-id');
}

function getUserId(homeDir = os.homedir()) {
  const file = getUserIdPath(homeDir);
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  } catch (_) {
    // First run or unreadable file: create a new anonymous installation ID.
  }

  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* best effort */
  }
  return id;
}

module.exports = { getUserId, getUserIdPath };
