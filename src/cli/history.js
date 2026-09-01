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

module.exports = { isEmptyAssistantMessage, cleanHistory };
