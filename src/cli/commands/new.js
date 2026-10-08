const chalk = require('chalk');
const hitl = require('../../core/hitl/mcpApproval');
const { clearSession } = require('../../core/sessions-management/new');

function handleNew({ history }) {
  try {
    clearSession(true);
    history.length = 0;
    hitl.startPrompt();
    console.log(chalk.green('New conversation started.\n'));
  } catch (error) {
    console.log(chalk.red(`Could not clear the previous chat; context was not reset: ${error.message}\n`));
  }
}

module.exports = { handleNew };
