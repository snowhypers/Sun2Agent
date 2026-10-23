const chalk = require('chalk');
const mode = require('../../core/coding/mode');

async function handleCoding() {
  const enabled = mode.toggle();
  console.log(enabled
    ? chalk.green('\n✔ Coding mode enabled. Coding requests will follow the build-and-verify workflow; Esc returns to normal chat.\n')
    : chalk.gray('\n⎋ Coding mode disabled. Back to normal chat.\n'));
}

module.exports = { handleCoding };
