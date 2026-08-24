// Compatibility adapter for the simple local memory layer.
//
// This module intentionally performs no model, embedding, telemetry, or network
// calls. The filename is retained to keep the memory module boundary stable,
// but the implementation is JSON-only and does not pretend to be Mem0.

const {
  loadLocalMemory,
  addLocalMemory,
  searchLocalMemory,
  containsSensitiveData
} = require('./memoryJson');

const MAX_MEMORIES = 5;
let initialized = false;

function initialize() {
  initialized = true;
  return true;
}

function reset() {
  initialized = false;
}

function isInitialized() {
  return initialized;
}

async function search(query) {
  if (!initialized || !String(query || '').trim()) return [];
  try {
    return searchLocalMemory(query, loadLocalMemory(), MAX_MEMORIES);
  } catch (_) {
    return [];
  }
}

function extractUsefulLocalMemory(messages) {
  if (!Array.isArray(messages)) return [];
  const userMessages = messages
    .filter((message) => message && message.role === 'user')
    .map((message) => String(message.content || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const useful = [];
  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
    /^(i\s+(?:prefer|like|love|use|want|need)\b.+)$/i,
    /^(my\s+(?:preference|preferred|default)\b.+)$/i,
    /^(always\s+.+)$/i
  ];

  for (const message of userMessages) {
    if (containsSensitiveData(message)) continue;
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (!match) continue;
      useful.push((match[1] || match[0]).trim());
      break;
    }
  }
  return useful;
}

async function remember(messages) {
  if (!initialized) return [];
  try {
    return extractUsefulLocalMemory(messages)
      .map((content) => addLocalMemory(content))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  initialize,
  reset,
  isInitialized,
  search,
  remember,
  extractUsefulLocalMemory,
  MAX_MEMORIES
};
