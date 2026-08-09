// Loads AGENT.md from the current project directory.
//
// AGENT.md is plain-text repository context/instructions that the project
// owner writes (similar to a CLAUDE.md or .cursorrules file). When present,
// its contents are surfaced to the model as advisory context. When absent,
// Sun2Agent behaves exactly as before — no errors, no missing-file handling.
//
// This module is intentionally simple: no database, no embeddings, no RAG.
// Just a UTF-8 file read.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AGENT_FILENAME = 'AGENT.md';

// Where to look for AGENT.md: the directory Sun2Agent was launched from.
// This matches the projectRoot concept used by the guardrails (process.cwd()
// resolved once at load time), so the agent and its sandbox agree on what
// "the project" is.
function agentMdPath(dir) {
  return path.join(dir || process.cwd(), AGENT_FILENAME);
}

// Ensure AGENT.md exists so the editor has something to open. On first use we
// seed it with a short template the project owner can fill in. Created
// owner-only (0600) to match how mcp.json/config.json are handled.
function ensureAgentMd(dir) {
  const file = agentMdPath(dir);
  if (!fs.existsSync(file)) {
    const template = [
      '# AGENT.md',
      '',
      'Repository-specific instructions for Sun2Agent. These are advisory:',
      'they guide code style, tooling, and conventions for this project, but',
      'never override Sun2Agent\u2019s core instructions, security policies,',
      'or guardrails.',
      '',
      '## Project',
      '',
      '- <!-- one-line description of the project -->',
      '',
      '## Conventions',
      '',
      '- <!-- language, framework, style -->',
      '- <!-- test command (e.g. npm test) -->',
      ''
    ].join('\n');
    fs.writeFileSync(file, template, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600); // enforce even if the file pre-existed
    } catch (_) {
      /* best effort */
    }
  }
  return file;
}

// Open AGENT.md in the user's editor, the same way /mcp opens mcp.json:
// $VISUAL or $EDITOR when set, otherwise the OS default text handler.
// Returns true if an editor command was launched.
function openAgentMd(dir) {
  ensureAgentMd(dir);
  const file = agentMdPath(dir);
  const editor = process.env.VISUAL || process.env.EDITOR;
  let cmd;
  let args;
  if (editor) {
    cmd = editor;
    args = [file];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = ['-t', file]; // open in default text editor
  } else if (process.platform === 'win32') {
    cmd = 'notepad';
    args = [file];
  } else {
    cmd = 'xdg-open';
    args = [file];
  }
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  return !res.error;
}

// Read AGENT.md from the given directory (defaults to cwd). Returns the file
// text trimmed, or null when the file does not exist or is unreadable. Never
// throws — a missing or unreadable AGENT.md is treated as "no context".
function loadAgentMd(dir) {
  const file = agentMdPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text && text.trim() ? text.trim() : null;
  } catch (_) {
    return null;
  }
}

module.exports = { loadAgentMd, agentMdPath, ensureAgentMd, openAgentMd, AGENT_FILENAME };
