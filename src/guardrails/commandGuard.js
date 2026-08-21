// Command guard — blocks destructive shell commands.
//
// Checked in two places: the `command` a stdio MCP server is launched with,
// and any command-shaped string an MCP tool is asked to run.

const { blockedCommands } = require('./guardConfig');

function validateCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return { ok: true };

  for (const pattern of blockedCommands) {
    if (pattern.test(command)) {
      return {
        ok: false,
        guard: 'command',
        matched: String(pattern),
        reason: `Dangerous command blocked: matches ${pattern}`
      };
    }
  }
  return { ok: true };
}

module.exports = { validateCommand };
