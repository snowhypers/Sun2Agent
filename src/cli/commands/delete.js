// /delete slash command — confirm with the user, then delete all saved
// config and exit so the user re-runs the first-time setup next launch.

const chalk = require('chalk');
const { deleteConfig } = require('../../config/appConfig');

async function handleDelete(ctx) {
  const ans = await ctx.promptBack([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Delete all config and data?  ' + chalk.gray('(esc to cancel)'),
      default: false
    }
  ]);
  if (!ans) return; // esc -> back
  if (ans.confirm) {
    deleteConfig();
    console.log(chalk.red('\n✔ Config deleted.'));
    console.log(chalk.gray('To fully uninstall run: npm uninstall -g sun2agent\n'));
    process.exit(0);
  }
}

module.exports = { handleDelete };
