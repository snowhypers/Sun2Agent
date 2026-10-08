// Approximate tokens retained in the active conversation, not provider billing usage.

function estimateConversationTokens(history = []) {
  if (!history.length) return 0;
  const bytes = Buffer.byteLength(JSON.stringify(history), 'utf8');
  return Math.ceil(bytes / 4) + history.length * 4;
}

function tokenLabel(tokens) {
  return `chat ~${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`;
}

module.exports = { estimateConversationTokens, tokenLabel };
