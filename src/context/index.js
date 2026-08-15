// One simple interface for the AGENT.md repository-instructions feature.
//
// chat.js imports only this module:
//   - loadAgentContext() reads AGENT.md from the project directory (cached)
//   - buildSystemPrompt(basePrompt) returns base prompt + AGENT.md section
//
// Nothing else in Sun2Agent is changed by this feature: the guardrails
// continue to run on their own paths (inputGuard on the user prompt;
// commandGuard/networkGuard/filesystemGuard on tool calls and server launches;
// outputGuard on tool output). AGENT.md only becomes part of the system
// prompt text, so it can never disable, bypass, or modify any guardrail.

const { loadAgentMd, openAgentMd, agentMdPath, ensureAgentMd, AGENT_FILENAME } = require('./agentLoader');
const { buildPromptWithAgent } = require('./promptBuilder');

// Module-level cache: read AGENT.md from disk once per process, so a chat
// session never re-reads it on every turn. Call reload() to force a refresh
// (e.g. after the user edits AGENT.md mid-session).
let cached = null; // { found: boolean, text: string|null }
let loaded = false;

// Read AGENT.md from the current project directory. Returns an object:
//   { found: boolean, text: string|null }
// Never throws.
function loadAgentContext(dir) {
  if (!loaded) {
    const text = loadAgentMd(dir);
    cached = { found: text !== null, text };
    loaded = true;
  }
  return cached;
}

// Force the next loadAgentContext() call to re-read AGENT.md from disk.
function reload() {
  cached = null;
  loaded = false;
}

// Build the final system prompt: existing base prompt + AGENT.md section.
// If AGENT.md is absent or empty, the base prompt is returned unchanged.
function buildSystemPrompt(baseSystemPrompt) {
  const { text } = loadAgentContext();
  return buildPromptWithAgent(baseSystemPrompt, text);
}

module.exports = {
  loadAgentContext,
  reload,
  buildSystemPrompt,
  openAgentMd,
  getAgentMdPath: agentMdPath,
  ensureAgentMd,
  AGENT_FILENAME
};



