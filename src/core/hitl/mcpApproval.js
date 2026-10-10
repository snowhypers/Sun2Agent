// Human-in-the-Loop (HITL): risk-based MCP tool-call approval — per prompt.
// Read-only tools run without prompting. One approval covers routine changes
// on the same MCP server for this prompt; high-risk actions always ask again.
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

// Never carry an approval into another prompt or another MCP server.
const allowedScopes = new Set();

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
  allowedScopes.clear();
}

const MUTATING_WORDS = new Set([
  'add', 'apply', 'charge', 'command', 'copy', 'create', 'delete', 'deploy', 'edit',
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

const ROUTINE_CHANGE_WORDS = new Set([
  'add', 'apply', 'copy', 'create', 'edit', 'insert', 'move', 'mutate',
  'patch', 'put', 'rename', 'set', 'update', 'upsert', 'write'
]);

const HIGH_RISK_WORDS = new Set([
  'account', 'admin', 'auth', 'command', 'credential', 'delete', 'deploy',
  'download', 'drop', 'erase', 'execute', 'grant', 'install', 'payment',
  'permission', 'permissions', 'post', 'publish', 'purchase', 'remove',
  'restart', 'revoke', 'run', 'send', 'share', 'shell', 'stop', 'submit',
  'token', 'transfer', 'trigger', 'truncate', 'uninstall', 'upload'
]);

const COMPUTER_READ_ONLY = new Set([
  'doctor', 'policy_status', 'get_ui_tree', 'get_focused_element',
  'find_element', 'get_frontmost_app', 'list_windows', 'list_menu_bar',
  'discover_applications', 'list_running_apps', 'get_display_size',
  'list_displays', 'get_window', 'get_cursor_window', 'cursor_position',
  'snapshot', 'screenshot', 'zoom', 'wait', 'get_tool_guide',
  'get_app_capabilities', 'get_tool_metadata', 'sun2agent_wait_for_window',
  'sun2agent_search_tools'
]);
function isComputerReadOnly(tool) { return COMPUTER_READ_ONLY.has(tool); }

// Only these known app-navigation calls can share approval. Window clicks,
// menu selections, keypresses, typing and scripts remain fresh decisions.
const COMPUTER_APP_NAVIGATION = new Set(['open_application', 'activate_app']);
function computerNavigationScope(tool, args, annotations) {
  if (!COMPUTER_APP_NAVIGATION.has(tool) || annotations?.destructiveHint === true) return null;
  const app = args?.bundle_id;
  if (typeof app !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(app)) return null;
  const allowedKeys = tool === 'activate_app' ? ['bundle_id', 'timeout_ms'] : ['bundle_id'];
  if (Object.keys(args).some((key) => !allowedKeys.includes(key))) return null;
  if (args.timeout_ms !== undefined &&
      (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 0 || args.timeout_ms > 30000)) return null;
  return `computer:app-navigation:${app}`;
}

const SAFE_BROWSER_TOOLS = new Set([
  'browser_close', 'browser_console_messages',
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
  if (['browser_press_key', 'browser_type', 'browser_fill_form', 'browser_click', 'browser_drag'].includes(tool)) {
    return { required: true, remember: false };
  }
  if (SAFE_BROWSER_TOOLS.has(tool)) return { required: false, remember: false };
  return null;
}

function approvalArgs(server, args, tool) {
  if (server === 'workspace' && tool === 'run_maven_tests') {
    return { command: 'mvn test', warning: 'Executes project code in this workspace' };
  }
  if (server !== 'browser') return args || {};

  function mask(value) {
    if (Array.isArray(value)) return value.map(mask);
    if (!value || typeof value !== 'object') return value;
    const sensitiveField = tool === 'browser_type' || tool === 'browser_fill_form' || SENSITIVE_BROWSER_ACTION.test(
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
  if (words.some((word) => READ_ONLY_WORDS.has(word))) return false;
  return true;
}

// Inline approval prompt — minimal, runs alongside spinner.
async function promptApproval({ server, tool, args, scope }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const previousKeyListeners = stdin.listeners('keypress');
    const previousRawMode = Boolean(stdin.isRaw);
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    const argsStr = sanitizeOutput(JSON.stringify(approvalArgs(server, args, tool))).slice(0, 120);
    const question = scope
      ? server === 'computer'
        ? `Allow app navigation for ${args.bundle_id} in this prompt?`
        : `Allow routine changes on @${server} for this prompt?`
      : 'Allow this MCP tool call?';
    const promptLine =
      `\n  ${chalk.yellow('⚠')}  ${chalk.bold(question)}\n` +
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
      // Resume the turn's Esc watcher after the approval UI releases stdin.
      for (const listener of previousKeyListeners) stdin.on('keypress', listener);
      if (stdin.isTTY) stdin.setRawMode(previousRawMode);
      process.stdout.write(SHOW_CURSOR + '\n');
      resolve(allowed);
    }

    stdin.on('keypress', onKey);
  });
}

async function checkApproval({ server, tool, args, annotations, enabled, _prompt } = {}) {
  const on = enabled !== undefined ? enabled : isEnabled();
  if (!on) return true;

  const browserDecision = server === 'browser' ? browserApproval(tool, args) : null;
  const mavenRun = server === 'workspace' && tool === 'run_maven_tests';
  const required = mavenRun ? true : server === 'computer' ? !COMPUTER_READ_ONLY.has(tool)
    : browserDecision ? browserDecision.required : requiresApproval(tool, annotations);
  const words = toolWords(tool);
  const routine = server !== 'browser' && server !== 'computer' && !mavenRun &&
    annotations?.destructiveHint !== true &&
    !words.some((word) => HIGH_RISK_WORDS.has(word)) &&
    words.some((word) => ROUTINE_CHANGE_WORDS.has(word));
  const scope = server === 'computer'
    ? computerNavigationScope(tool, args, annotations)
    : routine ? `${server || ''}:routine-change` : null;

  if (!required) {
    updateSpinner(browserDecision
      ? `browser tool — running: ${tool}...`
      : `read-only tool — running: ${tool}...`);
    return true;
  }

  // Routine approval is valid only for this MCP server and user prompt.
  if (scope && allowedScopes.has(scope)) {
    updateSpinner(`✓ approved for this prompt — running tool: ${tool}...`);
    return true;
  }

  // Test override
  if (_prompt) {
    const result = await _prompt({ server, tool, args: args || {} });
    if (result && scope) allowedScopes.add(scope);
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

  const allowed = await promptApproval({ server, tool, args, scope });
  if (allowed && scope) allowedScopes.add(scope);

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

// Called at startup and before each user prompt. The allow-list is in memory
// only and never survives a later prompt or process restart.
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
  isComputerReadOnly,
  browserApproval,
  _resetForTesting
};
