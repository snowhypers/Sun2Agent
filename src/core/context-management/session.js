// Local conversation persistence for the sun2Agent REPL.
//
// Saved after every turn so the next launch can pick up the conversation
// where the user left off (especially when Docker is down and the user has
// to re-run the CLI). Stored at ~/.sun2agent/session.json with 0600 perms.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

function sessionFile() {
  return path.join(os.homedir(), '.sun2agent', 'session.json');
}

function saveSession(history) {
  try {
    const dir = path.dirname(sessionFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify({ savedAt: Date.now(), messages: history }), { mode: 0o600 });
  } catch (_) { /* best effort — resume is a nicety, never a hard failure */ }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8'));
    if (Array.isArray(raw.messages) && raw.messages.length) return raw.messages;
  } catch (_) { /* no session or corrupt file — start fresh */ }
  return null;
}

function clearSession(strict = false) {
  try {
    fs.unlinkSync(sessionFile());
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error;
  }
}

function archiveSession(history) {
  if (!history.length) return null;
  const dir = path.join(path.dirname(sessionFile()), 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), messages: history }), {
    flag: 'wx', mode: 0o600
  });
  return file;
}

module.exports = { sessionFile, saveSession, loadSession, clearSession, archiveSession };
