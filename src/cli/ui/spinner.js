// ora spinner glue for the sun2Agent REPL.
//
// The chat loop owns the spinner's lifecycle (it gets reused across the
// "thinking → waiting for approval → running tool" phases of a turn), but
// spinner creation + the standard HITL binding is encapsulated here.

const chalk = require('chalk');
const ora = require('ora');
const hitl = require('../../core/hitl/mcpApproval');

// Build the standard "thinking..." spinner that the chat loop reuses for
// the entire turn, then hands to the HITL module so approval prompts can
// update its text without losing the spin.
function buildThinkingSpinner() {
  const spinner = ora(chalk.gray('sun2Agent is thinking...  (⎋ esc to stop)')).start();
  hitl.setSpinner(spinner);
  return spinner;
}

module.exports = { buildThinkingSpinner };
