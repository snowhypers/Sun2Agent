// Guardrails — one entry point for every security check.
//
// chat.js and mcp.js import only this module; the individual guards stay
// internal so their call order and combination live in one place.
//
// A note on shape: MCP tools take structured JSON arguments, not shell
// strings, so validateToolCall() walks every string inside the arguments and
// runs the command, network, and filesystem guards over each one. That is
// how "before executing the command" maps onto a real MCP client.

const { validateInput } = require('./inputGuard');
const { validateCommand } = require('./commandGuard');
const { validateNetwork } = require('./networkGuard');
const { validatePath, looksLikePath } = require('./filesystemGuard');
const { sanitizeOutput, containsSecret } = require('./outputGuard');
const guardConfig = require('./guardConfig');

// Walk a JSON-ish value and yield every string it contains.
function* strings(value, depth = 0) {
  if (depth > 8) return;
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) {
    for (const v of value) yield* strings(v, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) yield* strings(v, depth + 1);
  }
}

// Full check for one MCP tool call. Returns { ok } or { ok:false, reason }.
function validateToolCall(toolName, args) {
  for (const value of strings(args)) {
    const cmd = validateCommand(value);
    if (!cmd.ok) return { ...cmd, tool: toolName, value };

    const net = validateNetwork(value);
    if (!net.ok) return { ...net, tool: toolName, value };

    if (looksLikePath(value)) {
      const fs = validatePath(value);
      if (!fs.ok) return { ...fs, tool: toolName, value };
    }
  }
  return { ok: true };
}

// Check a stdio server definition before it is spawned. `command` and `args`
// come from mcp.json, which the user controls but may have pasted in.
function validateServer(server) {
  if (!server || server.type !== 'stdio') return { ok: true };
  const line = [server.command, ...(server.args || [])].join(' ');
  const cmd = validateCommand(line);
  if (!cmd.ok) return { ...cmd, server: server.name };
  const net = validateNetwork(line);
  if (!net.ok) return { ...net, server: server.name };
  return { ok: true };
}

module.exports = {
  // Individual guards, named as in the design.
  inputGuard: validateInput,
  commandGuard: validateCommand,
  networkGuard: validateNetwork,
  filesystemGuard: validatePath,
  outputGuard: sanitizeOutput,

  // Explicit names, for call sites that prefer them.
  validateInput,
  validateCommand,
  validateNetwork,
  validatePath,
  sanitizeOutput,
  containsSecret,

  // Composed checks used by mcp.js.
  validateToolCall,
  validateServer,

  guardConfig
};
