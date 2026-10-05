// Approximate next-request size, not provider-reported token usage.
const { MODELS } = require('../../config/appConfig');

function estimateContextTokens(system, history = [], tools = []) {
  const messages = [{ role: 'system', content: system }, ...history];
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  return Math.ceil(bytes / 4) + messages.length * 4;
}

function contextLabel(tokens, config = {}) {
  const custom = config.providers?.find((item) => item.id === config.activeProvider);
  // Groq publishes this window; older saved providers may predate the /config field.
  const groqWindow = /^https:\/\/api\.groq\.com\/openai\/v1\/?$/i.test(custom?.baseUrl || '') &&
    custom.activeModel === 'openai/gpt-oss-120b' ? 131072 : undefined;
  const window = custom
    ? custom.contextWindows?.[custom.activeModel] || groqWindow
    : MODELS.find((item) => item.id === config.model)?.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) {
    return `ctx ~${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} used`;
  }
  const remaining = Math.max(0, Math.min(100, 100 * (1 - tokens / window)));
  return `ctx ~${tokens > 0 ? Math.min(99.9, remaining).toFixed(1) : '100.0'}% left`;
}

module.exports = { estimateContextTokens, contextLabel };
