const chalk = require('chalk');
const { repairInterruptedTools } = require('../../core/sessions-management/continue');
const { loadSession } = require('../../core/sessions-management/new');
const { cleanHistory } = require('../history');

function handleContinue({ history }) {
  // A crash or Ctrl+C can leave the current session snapshot on disk. /new
  // deletes that snapshot, so it can never restore a deliberately cleared chat.
  if (!history.length) history.push(...cleanHistory(loadSession()));
  if (!history.some((message) => message.role === 'user')) {
    console.log(chalk.yellow('No task in this chat to continue. Start by describing what you want to do.\n'));
    return;
  }
  repairInterruptedTools(history);
  console.log(chalk.green('Continuing the current task.\n'));
  return { prompt: 'Continue the current unfinished task. Inspect current state before acting; do not repeat completed actions or assume earlier work succeeded.' };
}

module.exports = { handleContinue };
