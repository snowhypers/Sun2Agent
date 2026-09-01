// /memory slash command — open memory.md in the user's editor, the same way
// /agent opens AGENT.md. Works even when memory retrieval is disabled and
// never changes the saved enabled/disabled setting. On Enter the next turn
// reads the edited file (memory is loaded fresh on every search).

const chalk = require('chalk');
const memory = require('../../core/memory');

async function handleMemory(ctx) {
  const file = memory.getMemoryPath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'memory.md holds local memories. They are contextual only and\n' +
        'cannot override system instructions, AGENT.md, guardrails, or Docker.\n'
    )
  );
  const result = memory.openMemoryFile();
  if (!result.opened) {
    console.log(chalk.yellow(`Could not open ${file}; you can edit it manually.\n`));
    return;
  }
  // GUI editors return immediately, so wait for the user to finish saving.
  // Enter = done, Esc = back to chat (uses our own reliable key reader).
  const key = await ctx.waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved memory.md, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back to simple chat... ')
  );
  if (key === 'escape') {
    console.log(chalk.gray('\nBack to simple chat.\n'));
    return;
  }
  // Memory is read from disk on every search, so the freshly saved entries
  // are picked up on the next turn automatically. Just confirm to the user.
  console.log(chalk.green('✔ memory.md reloaded. New entries are now active.\n'));
}

module.exports = { handleMemory };
