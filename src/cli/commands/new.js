const chalk = require('chalk');
const hitl = require('../../core/hitl/mcpApproval');
const { startNewSession } = require('../../core/sessions-management/new');

function handleNew({ history }) {
  startNewSession(history);
  hitl.startPrompt();
  console.log(chalk.green('New conversation started.\n'));
}

module.exports = { handleNew };
