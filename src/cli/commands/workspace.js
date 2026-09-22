// /workspace — opt in to filesystem tools for the current launch directory.

const chalk = require('chalk');
const ora = require('ora');
const mcp = require('../../core/mcp');

async function handleWorkspace() {
  if (mcp.isWorkspaceConnected()) {
    console.log(chalk.green('\n✔ Connected /workspace plugin — agent can access your workspace.\n'));
    return;
  }

  const spinner = ora('Connecting /workspace...').start();
  const result = await mcp.connectWorkspace();
  spinner.stop();

  if (result.ok) {
    console.log(chalk.green('\n✔ Connected /workspace plugin — agent can access your workspace.\n'));
  } else {
    console.log(chalk.red(`\n✗ Workspace connection failed: ${result.error}\n`));
  }
}

module.exports = { handleWorkspace };
