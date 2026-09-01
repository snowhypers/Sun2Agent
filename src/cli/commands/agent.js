// /agent slash command — open the project's AGENT.md in the user's editor.
// Wait for Enter to reload (so the next turn picks up the edits) or Esc to
// discard.

const chalk = require('chalk');
const context = require('../../core/context');

async function handleAgent(ctx) {
  const file = context.getAgentMdPath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'AGENT.md holds repository-specific instructions. They are advisory only and\n' +
        'cannot override Sun2Agent’s core instructions, security policies, or guardrails.\n'
    )
  );
  context.openAgentMd();
  // GUI editors return immediately, so wait for the user to finish saving.
  // Enter = reloaded, Esc = back to chat without reloading.
  const key = await ctx.waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved AGENT.md, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back to simple chat... ')
  );
  if (key === 'escape') {
    console.log(chalk.gray('\nBack to simple chat.\n'));
    return;
  }
  // Reload so the next turn uses the freshly edited AGENT.md.
  context.reload();
  console.log(chalk.green('✔ AGENT.md reloaded. Its instructions are now active.\n'));
}

module.exports = { handleAgent };
