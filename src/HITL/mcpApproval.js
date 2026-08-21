// Human-in-the-Loop (HITL): MCP tool-call approval — per session.
// Once a tool is approved, it's remembered for the entire chat session.
// Designed for continuous indicator: spinner runs through thinking → waiting → running.

const readline = require('readline');
const chalk = require('chalk');
const { loadConfig } = require('../config');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function isEnabled() {
  const config = loadConfig();
  return !(config.hitl && config.hitl.mcpApproval === false);
}

// Per-session allowed tools (keyed by tool name only). This is intentionally
// in memory only: every call to startSession() begins with an empty set.
const allowedTools = new Set();

// Single pending approval at a time (simplifies continuous UI).
let pendingEntry = null;
let resolvePending = null;

// Called by chat.js to get a continuous spinner that we can update.
let activeSpinner = null;
function setSpinner(spinner) {
  activeSpinner = spinner;
}

function updateSpinner(text) {
  if (activeSpinner && activeSpinner.isSpinning) {
    activeSpinner.text = chalk.gray(text);
  }
}

function startSession() {
  allowedTools.clear();
}

// Inline approval prompt — minimal, runs alongside spinner.
async function promptApproval({ server, tool, args }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    const argsStr = JSON.stringify(args || {}).slice(0, 120);
    const promptLine =
      `\n  ${chalk.yellow('⚠')}  ${chalk.bold('Allow this MCP tool call?')}\n` +
      `  ${chalk.bold(tool)}  ${chalk.gray(argsStr)}\n` +
      `  ${chalk.cyan('Allow')}  ${chalk.gray('—')}  ${chalk.red("Don't allow")}\n` +
      `  ${chalk.gray('[Enter]')} ${chalk.cyan('Allow')}    ${chalk.gray('[Esc]')} ${chalk.red("Don't allow")}: `;
    process.stdout.write(promptLine);

    function onKey(str, key) {
      if (key && key.ctrl && key.name === 'c') {
        process.stdout.write(SHOW_CURSOR + '\n');
        process.exit(0);
      }
      if (str === 'y' || str === 'Y' || (key && key.name === 'return')) {
        cleanup(true);
      } else if (str === 'n' || str === 'N' || (key && key.name === 'escape')) {
        cleanup(false);
      }
    }

    function cleanup(allowed) {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      process.stdout.write(SHOW_CURSOR + '\n');
      if (allowed) allowedTools.add(tool);
      resolve(allowed);
    }

    stdin.on('keypress', onKey);
  });
}

async function checkApproval({ server, tool, args, enabled, _prompt } = {}) {
  const on = enabled !== undefined ? enabled : isEnabled();
  if (!on) return true;

  // Already allowed in this chat session: do not ask again, but keep the
  // same spinner alive and make the reason visible before execution begins.
  if (allowedTools.has(tool)) {
    updateSpinner(`✓ already approved this session — running tool: ${tool}...`);
    return true;
  }

  // Test override
  if (_prompt) {
    const result = await _prompt({ server, tool, args: args || {} });
    if (result) allowedTools.add(tool);
    return result;
  }

  // There is no user to make the required Allow/Don't allow decision in a
  // non-interactive process, so fail closed. Users can explicitly turn this
  // feature off in config for deliberate automation.
  if (!process.stdin.isTTY) {
    return false;
  }

  // Continuous indicator: update spinner to "waiting for approval"
  updateSpinner(`waiting for approval: ${tool}...`);

  const allowed = await promptApproval({ server, tool, args });

  // Continuous indicator: update spinner to "running tool"
  updateSpinner(`running tool: ${tool}...`);

  return allowed;
}

// log() behaves like console.log (used by chat.js for tool output).
function log(line) {
  console.log(line);
}

// Start of a new chat session. The allow-list must never persist across
// sessions or process restarts.
function startPrompt() { startSession(); }
function resetApprovals() { startSession(); }

// Internal: clear session approvals (for tests only)
function _resetForTesting() {
  startSession();
  pendingEntry = null;
  resolvePending = null;
  activeSpinner = null;
}

module.exports = {
  checkApproval,
  isEnabled,
  startPrompt,
  resetApprovals,
  log,
  setSpinner,
  _resetForTesting
};
