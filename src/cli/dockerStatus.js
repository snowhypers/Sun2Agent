// Returns a human-readable warning string when the user has Docker sandbox
// enabled but Docker is not running, or null otherwise. Used by MCP error
// paths so the user sees *why* stdio servers fail instead of guessing.
//
// Inside the sandbox container there is no docker CLI, so the check is
// skipped — the process is already isolated.

const { loadConfig } = require('../config/appConfig');

function dockerDownWarning() {
  if (process.env.SUN2AGENT_SANDBOX === '1') return null;
  try {
    const config = loadConfig();
    if (config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker') {
      const { isDockerRunning } = require('../sandbox');
      if (!isDockerRunning()) {
        return 'Docker sandbox is enabled but Docker is not running. MCP tool calls will fail until Docker is restarted.';
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

module.exports = { dockerDownWarning };
