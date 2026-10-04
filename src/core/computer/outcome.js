// A desktop tool reports what it attempted, not whether the user's goal happened.
// Rebuild this small ledger from history so model-error recovery never replays an action.
const { isComputerReadOnly } = require('../hitl/mcpApproval');

const STATE_CHECKS = new Set([
  'find_element', 'get_ui_tree', 'get_frontmost_app', 'get_window',
  'list_windows', 'snapshot', 'screenshot', 'sun2agent_wait_for_window'
]);

function pendingComputerOutcome(history) {
  let start = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' &&
        !/^\s*(continue|retry|resume|go on)\s*[.!]?\s*$/i.test(String(history[i].content || ''))) start = i;
  }
  const calls = new Map();
  const pending = [];
  for (const message of history.slice(start)) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) calls.set(call.id, call.function);
      continue;
    }
    if (message.role !== 'tool') continue;
    const call = calls.get(message.tool_call_id);
    if (!call?.name?.startsWith('computer__')) continue;
    const tool = call.name.slice('computer__'.length);
    const text = String(message.content || '');
    const failed = /^(?:Tool error:|MCP call .* NOT executed|interrupted|Tool not completed)/i.test(text);
    if (isComputerReadOnly(tool)) {
      if (pending.length && !failed && STATE_CHECKS.has(tool)) pending.at(-1).checked = true;
      if (tool === 'sun2agent_wait_for_window' && !failed) {
        let args = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch (_) { /* no match */ }
        const index = pending.findIndex((action) => action.tool === 'open_application' &&
          action.bundleId === args.bundle_id && text.startsWith(`Window ready for ${action.bundleId}:`));
        if (index >= 0) pending.splice(index, 1);
      }
      continue;
    }
    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch (_) { /* no target */ }
    pending.push({ tool, bundleId: args.bundle_id, checked: false, failed });
  }
  return pending[0] || null;
}

function unverifiedComputerMessage(outcome) {
  if (!outcome) return '';
  if (outcome.failed) return `Task incomplete: computer tool ${outcome.tool} failed or was not allowed. The requested result was not verified.`;
  return `Task outcome not verified. Computer tool ${outcome.tool} ran, but its result does not prove the requested change happened. Inspect the app before retrying; the action was not repeated.`;
}

module.exports = { pendingComputerOutcome, unverifiedComputerMessage };
