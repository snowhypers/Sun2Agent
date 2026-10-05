// Reserve four terminal rows for a non-editable input frame while a turn runs.
// The transcript, spinner and approval prompts scroll above it. No-op for
// pipes, dumb terminals, or windows too small to reserve the space safely.
const chalk = require('chalk');
const { terminalWidth, truncateToWidth } = require('./layout');
const { renderFooter } = require('./input');
const { printUserLine } = require('../prompt');

const BORDER = chalk.hex('#b5a642');

function startBusyFooter(options = {}, stdout = process.stdout) {
  if (!stdout.isTTY || process.env.TERM === 'dumb' ||
      !Number.isInteger(stdout.rows) || stdout.rows < 8 ||
      !Number.isInteger(stdout.columns) || stdout.columns < 20) {
    return () => {};
  }

  let rows = stdout.rows;
  let scrollBottom = rows - 4;
  let active = true;

  function clearFrame() {
    stdout.write(`\x1b[${scrollBottom + 1};1H\x1b[0J`);
  }

  function draw() {
    const width = terminalWidth(stdout, Infinity);
    const inner = width - 2;
    const message = truncateToWidth('Agent working… press Esc to stop', Math.max(1, inner - 5));
    const middle = ' › ' + message + ' '.repeat(Math.max(0, inner - 4 - message.length)) + ' ';
    const lines = [
      BORDER('╭' + '─'.repeat(inner) + '╮'),
      BORDER('│') + BORDER(middle) + BORDER('│'),
      BORDER('╰' + '─'.repeat(inner) + '╯'),
      renderFooter({ ...options, hint: '⎋ esc to stop' }, stdout)
    ];
    stdout.write('\x1b7'); // save the transcript cursor
    clearFrame();
    stdout.write(lines.join('\n'));
    stdout.write('\x1b8'); // restore the transcript cursor
  }

  function onResize() {
    if (!active) return;
    stdout.write('\x1b[r');
    clearFrame();
    if (!Number.isInteger(stdout.rows) || stdout.rows < 8 ||
        !Number.isInteger(stdout.columns) || stdout.columns < 20) {
      active = false;
      stdout.removeListener('resize', onResize);
      process.removeListener('exit', stopBusyFooter);
      return;
    }
    rows = stdout.rows;
    scrollBottom = rows - 4;
    stdout.write(`\x1b[1;${scrollBottom}r\x1b[${scrollBottom};1H`);
    draw();
  }

  function stopBusyFooter() {
    if (!active) return;
    active = false;
    stdout.removeListener('resize', onResize);
    process.removeListener('exit', stopBusyFooter);
    stdout.write('\x1b[r');
    clearFrame();
    stdout.write(`\x1b[${scrollBottom + 1};1H`);
  }

  stopBusyFooter.updateContext = (value) => {
    options.contextEstimate = value;
    if (active) draw();
  };

  stdout.write(`\x1b[1;${scrollBottom}r\x1b[${scrollBottom};1H`);
  draw();
  stdout.on('resize', onResize);
  process.once('exit', stopBusyFooter);

  return stopBusyFooter;
}

// Reserve the footer before echoing the user's message. Otherwise its first
// clear can erase a message printed in the bottom four terminal rows.
function startTurnDisplay(text, options = {}, stdout = process.stdout) {
  const stop = startBusyFooter(options, stdout);
  printUserLine(text, stdout);
  return stop;
}

module.exports = { startBusyFooter, startTurnDisplay };
