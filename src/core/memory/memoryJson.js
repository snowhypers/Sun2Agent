const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const guardrails = require('../guardrails');

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'for', 'from', 'i', 'in', 'is',
  'it', 'my', 'of', 'on', 'or', 'the', 'this', 'to', 'use', 'user', 'with'
]);
const MAX_LOCAL_MEMORIES = 200;

function getMemoryPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.sun2agent', 'memory.md');
}

// memory.md is intentionally JSON so it stays both editor-friendly and
// machine-safe while matching the user's preferred file name.
function serializeJson(entries) {
  return JSON.stringify({ memories: entries }, null, 2) + '\n';
}

function normalizeEntry(item) {
  if (!item || typeof item.content !== 'string') return null;
  let content = item.content.replace(/\s+/g, ' ').trim();
  if (!content || containsSensitiveData(content)) return null;
  // Defense in depth: even if detection missed, scrub via outputGuard so the
  // on-disk file never holds a raw secret. Re-check after scrubbing because
  // some patterns (PEM blocks, JWTs) leave a ***REDACTED*** marker that is
  // itself a sign the content was unsafe.
  content = guardrails.sanitizeOutput(content);
  if (!content || containsSensitiveData(content)) return null;
  return { content };
}

function uniqueEntries(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).reduce((safe, item) => {
    const normalized = normalizeEntry(item);
    if (!normalized) return safe;
    const key = normalized.content.toLowerCase();
    if (seen.has(key)) return safe;
    seen.add(key);
    safe.push({ id: safe.length + 1, content: normalized.content });
    return safe;
  }, []);
}

function ensureMemoryFile(homeDir = os.homedir()) {
  const file = getMemoryPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, serializeJson([]), { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600); // enforce even if the file pre-existed
  } catch (e) {
    /* best effort */
  }
  return file;
}

function loadLocalMemory(homeDir = os.homedir()) {
  const file = ensureMemoryFile(homeDir);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.memories) ? uniqueEntries(parsed.memories) : [];
  } catch (_) {
    return [];
  }
}

function containsSensitiveData(content) {
  // Two complementary layers of detection:
  //   1. outputGuard.containsSecret — the comprehensive pattern set that
  //      catches provider tokens (NVIDIA, OpenAI, Anthropic, AWS, GitHub,
  //      JWTs, PEM blocks) and `key: value` / `KEY=value` shapes. This is
  //      the authoritative detector.
  //   2. Natural-language secret mentions — "my password is hunter2",
  //      "API key: foo" without surrounding punctuation, "TOKEN = bar".
  //      outputGuard only triggers on the `:`/`=` form, so a sentence-
  //      shaped mention slips through. The backup regex below catches
  //      those cases for memory writes specifically.
  const text = String(content || '');
  if (!text) return false;
  if (guardrails.containsSecret(text)) return true;
  if (/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|private[_-]?key)\b\s*(?:is|[:=])\s*["']?\S+/i.test(text)) return true;
  if (/(^|\s)[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(text)) return true;
  return false;
}

function saveLocalMemory(memories, homeDir = os.homedir()) {
  const file = ensureMemoryFile(homeDir);
  const safe = uniqueEntries(memories)
    .slice(-MAX_LOCAL_MEMORIES)
    .map((item, index) => ({ id: index + 1, content: item.content }));
  fs.writeFileSync(file, serializeJson(safe), { mode: 0o600 });
  return safe;
}

function addLocalMemory(content, options = {}) {
  const raw = String(content || '').replace(/\s+/g, ' ').trim();
  if (!raw || containsSensitiveData(raw)) return null;

  // Defense in depth: scrub via outputGuard so even an undetected secret
  // is masked before reaching the on-disk file. Re-check after scrubbing
  // because a ***REDACTED*** marker in the saved content is itself a sign
  // the original was unsafe — drop the entry entirely in that case.
  const text = guardrails.sanitizeOutput(raw);
  if (!text || containsSensitiveData(text)) return null;

  const homeDir = options.homeDir || os.homedir();
  const memories = loadLocalMemory(homeDir);
  const duplicate = memories.find((item) => item.content.toLowerCase() === text.toLowerCase());
  if (duplicate) return duplicate;

  const entry = { id: memories.length + 1, content: text };
  memories.push(entry);
  const saved = saveLocalMemory(memories, homeDir);
  return saved[saved.length - 1] || null;
}

function tokens(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9+#.-]{2,}/g) || [])]
    .filter((token) => !STOP_WORDS.has(token));
}

function searchLocalMemory(query, memories, limit = 5) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  return (Array.isArray(memories) ? memories : [])
    .map((item) => {
      const memoryTokens = tokens(item.content);
      const overlap = queryTokens.filter((token) => memoryTokens.includes(token)).length;
      const phrase = String(item.content).toLowerCase().includes(String(query).toLowerCase()) ? 2 : 0;
      return { ...item, score: overlap / Math.max(queryTokens.length, 1) + phrase };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id))
    .slice(0, limit);
}

function openMemoryFile(homeDir = os.homedir()) {
  const file = ensureMemoryFile(homeDir);
  const editor = process.env.VISUAL || process.env.EDITOR;
  let command;
  let args;

  if (editor) {
    command = editor;
    args = [file];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = ['-t', file]; // open in default text editor (plain file, like AGENT.md)
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', file];
  } else {
    command = 'xdg-open';
    args = [file];
  }

  const result = spawnSync(command, args, { stdio: 'inherit' });
  return { opened: !result.error && result.status === 0, file };
}

module.exports = {
  getMemoryPath,
  ensureMemoryFile,
  loadLocalMemory,
  saveLocalMemory,
  addLocalMemory,
  searchLocalMemory,
  containsSensitiveData,
  openMemoryFile,
  MAX_LOCAL_MEMORIES
};
