// /browser — opt in to an isolated Playwright browser for this chat session.

const chalk = require('chalk');
const ora = require('ora');
const mcp = require('../../core/mcp');

async function handleBrowser() {
  if (mcp.isBrowserConnected()) {
    console.log(chalk.green('\n✔ /browser is already connected.\n'));
    return;
  }

  const spinner = ora('Connecting /browser...').start();
  const result = await mcp.connectBrowser();
  spinner.stop();

  if (result.ok) {
    console.log(chalk.green('\n✔ Connected /browser plugin — agent can automate an isolated browser.\n'));
  } else {
    console.log(chalk.red(`\n✗ Browser connection failed: ${result.error}\n`));
  }
}

module.exports = { handleBrowser };
