// Terminal I/O hygiene: inquirer prompt wrapper, user-line echo, and
// the sanitizer that strips ANSI/control chars from untrusted text before
// re-printing it on the terminal.

const inquirer = require('inquirer');
const chalk = require('chalk');

// Run an inquirer prompt that the user can cancel with Esc ("back").
// Resolves with the answers object, or null if Esc was pressed.
function promptBack(questions) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let done = false;

    // Text prompts need a visible cursor to type; selection prompts (list /
    // confirm) do not — hiding it for those stops the cursor from blinking on
    // the panel.
    const isTextPrompt = questions.some(
      (q) => q.type === 'input' || q.type === 'password' || q.type === 'editor'
    );
    const hideCursor = stdin.isTTY && !isTextPrompt;

    const finish = (value) => {
      if (done) return;
      done = true;
      if (stdin.isTTY) stdin.removeListener('keypress', onKey);
      if (hideCursor) process.stdout.write('\x1b[?25h'); // restore cursor
      resolve(value);
    };

    function onKey(_str, key) {
      if (key && key.name === 'escape') {
        try {
          run.ui.close();
        } catch (_) {
          /* ignore */
        }
        // inquirer leaves its menu rendered with the cursor at the end of a
        // line; move to a fresh line so the next input box doesn't draw on top
        // of the menu text (which caused a garbled / doubled box).
        process.stdout.write('\n');
        finish(null); // Esc => back
      }
    }

    // Clear any stray keypress listener left behind by a previously-closed
    // inquirer prompt, so it doesn't also react to arrow keys and cause
    // double-navigation / glitchy scrolling in this menu.
    if (stdin.isTTY) stdin.removeAllListeners('keypress');
    if (hideCursor) process.stdout.write('\x1b[?25l'); // hide blinking cursor
    const run = inquirer.prompt(questions);
    if (stdin.isTTY) stdin.on('keypress', onKey);
    run.then((answers) => finish(answers)).catch(() => finish(null));
  });
}

// Print the user's submitted message as a transcript line: "› text   HH:MM".
function printUserLine(text) {
  const cols = process.stdout.columns || 80;
  const time = new Date().toTimeString().slice(0, 5); // HH:MM
  const left = '› ' + sanitizeTerminalText(text);
  const pad = Math.max(1, cols - left.length - time.length);
  console.log(chalk.magenta('› ') + sanitizeTerminalText(text) + ' '.repeat(pad) + chalk.gray(time));
}

// Strip ANSI escapes and other control characters before writing untrusted
// text to the terminal. Tool output and model replies can both carry them.
function sanitizeTerminalText(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

module.exports = { promptBack, printUserLine, sanitizeTerminalText };
