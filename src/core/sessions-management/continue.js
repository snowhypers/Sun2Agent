// Keep the model's tool-call transcript valid if a turn was interrupted
// after it proposed tools but before every result was added to history.
function repairInterruptedTools(history) {
  let start = history.length - 1;
  while (start >= 0 && history[start].role === 'tool') start--;
  const calls = history[start]?.role === 'assistant' ? history[start].tool_calls : null;
  if (!Array.isArray(calls) || !calls.length) return 0;
  const completed = new Set(history.slice(start + 1).map((message) => message.tool_call_id));
  let repaired = 0;
  for (const call of calls) {
    if (!completed.has(call.id)) {
      history.push({ role: 'tool', tool_call_id: call.id,
        content: 'Tool result unavailable after interruption. Inspect current state before retrying.' });
      repaired++;
    }
  }
  return repaired;
}

module.exports = { repairInterruptedTools };
