// Human-in-the-Loop (HITL): MCP tool-call approval.
//
// The approval sits at the MCP execution boundary — inside mcp.callTool(),
// right after the guardrails pass and before the tool actually runs — not
// inside any LLM/ReAct logic. The model proposes a tool and arguments; a
// human confirms or rejects them before anything executes.
//
// Behavior:
//   * One decision per user prompt. The FIRST MCP call of a user question is
//     put to the human; the Allow / Don't allow answer then applies to EVERY
//     later MCP call made while resolving that same prompt — no repeated
//     confirmation for each tool in the chain. The decision resets when the
//     next user prompt starts (chatTurn calls hitl.startPrompt()).
//   * Non-interactive (not a TTY, e.g. scripts / CI) -> auto-allow. There is
//     nobody to ask, and the guardrails still run, so nothing is weakened.
//   * Interactive TTY -> a plain two-choice prompt, like other CLI agents:
//       ↑/↓ or ←/→    move the ❯ between Allow / Don't allow
//       Enter          confirm the selection
//       y / n          inline shorthand
//       Esc            Don't allow
//
// Uses the same raw-keypress approach as inputbox.js / waitEnterOrEsc(), so it
// works reliably even after inquirer menus or an external editor have handled
// the terminal.

const readline = require('readline');
const chalk = require('chalk');
const { loadConfig } = require('../config');

// Config toggle: config.hitl.mcpApproval === false turns the gate off.
// On by default so every MCP call is visible until the user opts out.
function isEnabled() {
  const config = loadConfig();
  return !(config.hitl && config.hitl.mcpApproval === false);
}

// Per-prompt decision. undefined = not decided yet (ask on the first MCP call
// of this prompt); true = allow every MCP call for this prompt; false = deny
// every MCP call for this prompt. chatTurn() calls startPrompt() when a new
// user prompt begins, so the decision never leaks across questions.
let promptDecision;

function startPrompt() {
  promptDecision = undefined;
}

// Backwards-compatible alias: approvals now belong to a prompt, not the process.
function resetApprovals() {
  startPrompt();
}

// A single decision covers every tool, so "is this tool approved?" just
// reports the current prompt decision.
function isApproved() {
  return promptDecision === true;
}

function rememberApproval() {
  promptDecision = true;
}

// Cap a value so one huge argument (e.g. a file body) cannot flood the prompt.
function formatArgs(args) {
  const trimmed = {};
  for (const [k, v] of Object.entries(args || {})) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    trimmed[k] = s.length > 220 ? s.slice(0, 220) + '…' : s;
  }
  const raw = JSON.stringify(trimmed, null, 2);
  return raw.length > 1400 ? raw.slice(0, 1400) + '\n  …' : raw;
}

// Plain-text prompt body (no box). The ❯ marks the highlighted choice.
function render({ server, tool, args }, selected) {
  const allow = selected === 0;
  const deny = selected === 1;
  const lines = [
    chalk.yellow.bold('⚠  MCP tool call'),
    '  Tool:      ' + chalk.bold(tool),
    server ? '  Server:    ' + server : '',
    '  Arguments: ' + formatArgs(args),
    '',
    '  Allow this call?',
    chalk.gray('  One-time choice — applies to every MCP call for this prompt')
  ];
  const choiceAllow = allow ? chalk.cyan.bold('❯ Allow') : chalk.dim('  Allow');
  const choiceDeny = deny ? chalk.cyan.bold("❯ Don't allow") : chalk.dim("  Don't allow");
  lines.push('  ' + choiceAllow + '             ' + choiceDeny);
  lines.push(chalk.gray('  Enter confirm') + chalk.gray('            Esc = No'));
  return lines.filter((l) => l !== null).join('\n');
}

// Raw-key prompt on the interactive TTY. Resolves true (Allow) or false
// (Don't Allow / Esc).
function interactivePrompt(opts) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let selected = 0; // Allow is the default highlight

  function panelLines() {
    return render(opts, selected).split('\n').length;
  }

  function redraw() {
    stdout.write(`\x1b[${panelLines()}A\r${render(opts, selected)}\n`);
  }

  function done(result) {
    stdin.removeListener('keypress', onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdout.write('\n');
    resolve(result);
  }

  function onKey(str, key) {
    if (key && key.ctrl && key.name === 'c') {
      stdout.write('\n');
      process.exit(0);
    }
    if (key && (key.name === 'left' || key.name === 'up' || key.name === 'down' || key.name === 'right')) {
      selected = key.name === 'left' || key.name === 'up' ? 0 : 1;
      redraw();
      return;
    }
    if (key && (key.name === 'return' || key.name === 'enter')) return done(selected === 0);
    if (key && key.name === 'escape') return done(false);
  }

  let resolve;
  return new Promise((r) => {
    resolve = r;
    readline.emitKeypressEvents(stdin);
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(render(opts, selected) + '\n');
    stdin.on('keypress', onKey);
  });
}

// The HITL gate. The first MCP call of a user prompt asks the human once; that
// Allow / Don't allow decision is then applied to every later MCP call made
// while resolving the same prompt. `enabled` overrides the config toggle, and
// `_prompt` injects a prompt function (used by tests).
async function checkApproval({ server, tool, args, enabled, _prompt } = {}) {
  const on = enabled !== undefined ? enabled : isEnabled();
  if (!on) return true;
  if (promptDecision !== undefined) return promptDecision;
  const ask = _prompt || (process.stdin.isTTY ? interactivePrompt : null);
  if (!ask) {
    promptDecision = true; // nobody to ask; guardrails still apply
    return true;
  }
  promptDecision = await ask({ server, tool, args: args || {} });
  return promptDecision;
}

module.exports = { checkApproval, isEnabled, startPrompt, isApproved, rememberApproval, resetApprovals };