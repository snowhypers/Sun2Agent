// Approximate prompt size, not provider-reported token usage. Hosted endpoints
// may enforce a smaller window than a model's published maximum.
const { MODELS } = require('../../config/appConfig');

function estimateContextTokens(system, history = [], tools = []) {
  const messages = [{ role: 'system', content: system }, ...history];
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  return Math.ceil(bytes / 4) + messages.length * 4;
}

function contextLabel(tokens, provider) {
  const model = provider?.id === 'nvidia'
    ? MODELS.find((item) => item.id === provider.model)
    : null;
  if (model?.contextWindow) {
    const remaining = Math.max(0, Math.min(100, 100 * (1 - tokens / model.contextWindow)));
    return `ctx ~${remaining.toFixed(1)}% left`;
  }
  const rounded = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return `ctx ~${rounded} used`;
}

module.exports = { estimateContextTokens, contextLabel };
