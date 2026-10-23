// Empty-assistant-message hygiene for the sun2Agent REPL.
//
// Occasionally the model returns an assistant message with NO content and NO
// tool calls (prematurely closed SSE stream, or the token budget exhausted by
// hidden reasoning). These messages carry no information, and worse: sending
// one back as conversation context makes the model likelier to answer with
// silence again — turning one glitch into a streak of blank replies.
//
// cleanHistory() drops exactly those messages everywhere history is consumed
// (the outgoing request and the persisted session file) while keeping every
// other role untouched: user, system, and tool results are preserved, and an
// assistant message WITH tool_calls is always kept even if its content is
// empty, because its matching tool result depends on it.

function isEmptyAssistantMessage(m) {
  if (!m || m.role !== 'assistant') return false;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
  if (m.content === null || m.content === undefined) return true;
  return typeof m.content !== 'string' || !m.content.trim();
}

function cleanHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => !isEmptyAssistantMessage(m));
}

function trimToolResults(group, maxBytes) {
  let size = group.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
  while (size > maxBytes) {
    const candidate = group.filter((message) => message.role === 'tool' &&
      typeof message.content === 'string').sort((a, b) => b.content.length - a.content.length)[0];
    if (!candidate || candidate.content.length <= 256) break;
    const excess = size - maxBytes;
    const keep = Math.max(256, candidate.content.length - excess - 64);
    candidate.content = `${candidate.content.slice(0, keep)}\n[tool result shortened to fit context]`;
    size = group.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
  }
}

function requestHistory(messages, maxBytes = 16 * 1024, maxTurns = 8) {
  const groups = [];
  for (const message of cleanHistory(messages)) {
    if (message.role === 'user') groups.push([]);
    if (!groups.length) groups.push([]);
    groups[groups.length - 1].push(message.role === 'tool' ? { ...message } : message);
  }
  const kept = [];
  let chars = 0;
  for (let i = groups.length - 1; i >= 0 && kept.length < maxTurns; i--) {
    const group = groups[i];
    const size = group.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
    if (kept.length && chars + size > maxBytes) break;
    if (!kept.length && size > maxBytes) trimToolResults(group, maxBytes);
    kept.unshift(group);
    chars += group.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
  }
  return kept.flat();
}

function discardFailedTurn(history, start) {
  if (!history.slice(start).some((message) => message.role === 'tool' || message.tool_calls?.length)) {
    history.splice(start);
  }
}

module.exports = { isEmptyAssistantMessage, cleanHistory, requestHistory, discardFailedTurn };
