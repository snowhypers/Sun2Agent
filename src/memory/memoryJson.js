const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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

// Path of the legacy JSON file, so older installs can be migrated in place.
function legacyJsonPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.sun2agent', 'memory.json');
}

// The memory file is named memory.md but its content is JSON: a single
// { memories: [...] } object. The .md name keeps it editor-friendly and
// consistent with AGENT.md; the JSON shape keeps it programmatically safe.
function serializeMarkdown(entries) {
  return JSON.stringify({ memories: entries }, null, 2) + '\n';
}

function normalizeEntry(item) {
  if (!item || typeof item.content !== 'string') return null;
  const content = item.content.replace(/\s+/g, ' ').trim();
  if (!content || containsSensitiveData(content)) return null;
  return { ...item, content };
}

function uniqueEntries(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).reduce((safe, item) => {
    const normalized = normalizeEntry(item);
    if (!normalized) return safe;
    const key = normalized.content.toLowerCase();
    if (seen.has(key)) return safe;
    seen.add(key);
    safe.push(normalized);
    return safe;
  }, []);
}

function ensureMemoryFile(homeDir = os.homedir()) {
  const file = getMemoryPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    // One-time migration: an older memory.json is converted to memory.md and
    // then removed, so no memories are lost when upgrading.
    let entries = [];
    const legacy = legacyJsonPath(homeDir);
    if (fs.existsSync(legacy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
        if (parsed && Array.isArray(parsed.memories)) {
          entries = parsed.memories.filter((item) => item && typeof item.content === 'string');
        }
      } catch (_) {
        /* corrupt legacy file — start empty */
      }
      try {
        fs.unlinkSync(legacy);
      } catch (_) {
        /* best effort */
      }
    }
    fs.writeFileSync(file, serializeMarkdown(entries), { mode: 0o600 });
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
    // Current format: JSON. Parse it first.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.memories)) {
        return uniqueEntries(parsed.memories);
      }
    } catch (_) {
      /* not JSON — fall through to legacy markdown bullets */
    }
    // Intermediate format: markdown bullets ("- some memory"). Convert so
    // nothing written by an earlier version is lost.
    const memories = [];
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*[-*+]\s+(.+)$/);
      if (!match) continue;
      const content = match[1].replace(/\s+/g, ' ').trim();
      if (content) memories.push({ content });
    }
    return uniqueEntries(memories);
  } catch (_) {
    return [];
  }
}

function containsSensitiveData(content) {
  const text = String(content || '');
  if (guardrails.containsSecret(text)) return true;
  return /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|private[_-]?key)\b\s*(?:is|[:=])\s*["']?\S+/i.test(text) ||
    /(^|\s)[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/.test(text);
}

function saveLocalMemory(memories, homeDir = os.homedir()) {
  const file = ensureMemoryFile(homeDir);
  const safe = uniqueEntries(memories).slice(-MAX_LOCAL_MEMORIES);
  fs.writeFileSync(file, serializeMarkdown(safe), { mode: 0o600 });
  return safe;
}

function addLocalMemory(content, options = {}) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text || containsSensitiveData(text)) return null;

  const homeDir = options.homeDir || os.homedir();
  const memories = loadLocalMemory(homeDir);
  const duplicate = memories.find((item) => item.content.toLowerCase() === text.toLowerCase());
  if (duplicate) return duplicate;

  const now = new Date().toISOString();
  const entry = {
    id: options.id || crypto.randomUUID(),
    content: text,
    createdAt: options.createdAt || now,
    updatedAt: options.updatedAt || now
  };
  memories.push(entry);
  saveLocalMemory(memories, homeDir);
  return entry;
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
    .sort((a, b) => b.score - a.score || String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
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
