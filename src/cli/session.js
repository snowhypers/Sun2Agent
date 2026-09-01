// Session persistence for the sun2Agent REPL.
//
// Saved after every turn so the next launch can pick up the conversation
// where the user left off (especially when Docker is down and the user has
// to re-run the CLI). Stored at ~/.sun2agent/session.json with 0600 perms.

const fs = require('fs');
const path = require('path');
const os = require('os');

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

function clearSession() {
  try { fs.unlinkSync(sessionFile()); } catch (_) { /* already gone */ }
}

module.exports = { sessionFile, saveSession, loadSession, clearSession };
