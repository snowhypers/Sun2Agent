// Human-in-the-Loop (HITL): risk-based MCP tool-call approval — per session.
// Read-only tools run without prompting. Once a mutating/unknown tool is
// approved, it is remembered for the entire chat session.
// Designed for continuous indicator: spinner runs through thinking → waiting → running.

const readline = require('readline');
const chalk = require('chalk');
const { loadConfig } = require('../../config/appConfig');
const { sanitizeOutput } = require('../guardrails/outputGuard');

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

const MUTATING_WORDS = new Set([
  'add', 'apply', 'command', 'copy', 'create', 'delete', 'deploy', 'edit',
  'execute', 'install', 'insert', 'move', 'mutate', 'patch', 'post', 'publish',
  'put', 'remove', 'rename', 'restart', 'run', 'send', 'set', 'shell', 'start',
  'stop', 'trigger', 'uninstall', 'update', 'upload', 'upsert', 'write'
]);

const READ_ONLY_WORDS = new Set([
  'allowed', 'check', 'count', 'crawl', 'describe', 'directory', 'extract',
  'fetch', 'find', 'get', 'info', 'inspect', 'list', 'lookup', 'map', 'query',
  'read', 'research', 'resolve', 'search', 'select', 'show', 'stat', 'stats',
  'tree', 'view'
]);

const SAFE_BROWSER_TOOLS = new Set([
  'browser_close', 'browser_console_messages', 'browser_drag',
  'browser_emulate_media', 'browser_find', 'browser_hover', 'browser_navigate',
  'browser_navigate_back', 'browser_network_request', 'browser_network_requests',
  'browser_resize', 'browser_snapshot', 'browser_take_screenshot',
  'browser_tabs', 'browser_wait_for'
]);

const SENSITIVE_BROWSER_ACTION =
  /\b(log[\s_-]?in|sign[\s_-]?in|password|passcode|otp|one[\s_-]?time|buy|purchase|pay(?:ment)?|checkout|place[\s_-]?order|submit|upload|download|delete[\s_-]?account|close[\s_-]?account|save[\s_-]?account|permission|allow)\b/i;

// Browser approvals are intentionally narrow and never remembered. Routine
// navigation remains smooth; consequential actions require a fresh decision.
function browserApproval(tool, args = {}) {
  const values = JSON.stringify(args || {});
  if (tool === 'browser_evaluate' || tool === 'browser_run_code_unsafe') {
    return { required: true, remember: false };
  }
  if (tool === 'browser_file_upload') {
    return { required: Array.isArray(args.paths) && args.paths.length > 0, remember: false };
  }
  if (tool === 'browser_drop') {
    return { required: Array.isArray(args.paths) && args.paths.length > 0, remember: false };
  }
  if (tool === 'browser_handle_dialog') {
    return { required: args.accept === true, remember: false };
  }
  if (tool === 'browser_press_key') {
    return { required: /^enter$/i.test(String(args.key || '')), remember: false };
  }
  if (tool === 'browser_type') {
    return { required: args.submit === true || SENSITIVE_BROWSER_ACTION.test(values), remember: false };
  }
  if (tool === 'browser_fill_form' || tool === 'browser_click') {
    return { required: SENSITIVE_BROWSER_ACTION.test(values), remember: false };
  }
  if (SAFE_BROWSER_TOOLS.has(tool)) return { required: false, remember: false };
  return null;
}

function approvalArgs(server, args) {
  if (server !== 'browser') return args || {};

  function mask(value) {
    if (Array.isArray(value)) return value.map(mask);
    if (!value || typeof value !== 'object') return value;
    const sensitiveField = SENSITIVE_BROWSER_ACTION.test(
      [value.name, value.element, value.label].filter(Boolean).join(' ')
    );
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sensitiveField && (key === 'text' || key === 'value') ? '[REDACTED]' : mask(item)
    ]));
  }

  return mask(args || {});
}

function toolWords(tool) {
  return String(tool || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// MCP annotations are hints, not authority. A mutating/destructive name wins
// over a conflicting readOnlyHint. Unknown tools fail closed and still ask.
function requiresApproval(tool, annotations = {}) {
  const words = toolWords(tool);
  if (annotations.destructiveHint === true) return true;
  if (words.some((word) => MUTATING_WORDS.has(word))) return true;
  if (annotations.readOnlyHint === true) return false;
  if (words.some((word) => READ_ONLY_WORDS.has(word))) return false;
  return true;
}

// Inline approval prompt — minimal, runs alongside spinner.
async function promptApproval({ server, tool, args, remember = true }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    const argsStr = sanitizeOutput(JSON.stringify(approvalArgs(server, args))).slice(0, 120);
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
      if (allowed && remember) allowedTools.add(tool);
      resolve(allowed);
    }

    stdin.on('keypress', onKey);
  });
}

async function checkApproval({ server, tool, args, annotations, enabled, _prompt } = {}) {
  const on = enabled !== undefined ? enabled : isEnabled();
  if (!on) return true;

  const browserDecision = server === 'browser' ? browserApproval(tool, args) : null;
  const required = browserDecision ? browserDecision.required : requiresApproval(tool, annotations);
  const remember = browserDecision ? browserDecision.remember : true;

  if (!required) {
    updateSpinner(browserDecision
      ? `browser tool — running: ${tool}...`
      : `read-only tool — running: ${tool}...`);
    return true;
  }

  // Already allowed in this chat session: do not ask again, but keep the
  // same spinner alive and make the reason visible before execution begins.
  if (remember && allowedTools.has(tool)) {
    updateSpinner(`✓ already approved this session — running tool: ${tool}...`);
    return true;
  }

  // Test override
  if (_prompt) {
    const result = await _prompt({ server, tool, args: args || {} });
    if (result && remember) allowedTools.add(tool);
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

  const allowed = await promptApproval({ server, tool, args, remember });

  // Keep the indicator alive after the decision as well.  A denied call is
  // still part of the running turn, but must not claim that execution began.
  updateSpinner(allowed
    ? `running tool: ${tool}...`
    : `tool not allowed: ${tool} — continuing...`);

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
  requiresApproval,
  browserApproval,
  _resetForTesting
};
