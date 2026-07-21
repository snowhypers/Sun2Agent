// A single-line chat input in the style of Claude Code / Copilot CLI:
// a horizontal rule, a "›" prompt showing just what you are currently typing
// with a block cursor, another rule, and a footer line.
//
//   ────────────────────────────────────────────
//    › what█
//   ────────────────────────────────────────────
//    /exit to quit                    → llama-3.1-70b
//
// Redraws live as you type and resolves with the text on Enter.

const readline = require('readline');
const chalk = require('chalk');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Sentinel resolved by askInput when Esc is pressed on an empty box — the
// caller treats it as "go back to simple chat" (disconnect MCP, drop tag).
const ESC_BACK = Symbol('escBack');

// Soft, muted ("low") yellow for the input box — dimmer than bright yellow.
const YELLOW = chalk.hex('#b5a642');

function width() {
  const cols = process.stdout.columns || 80;
  // Stay one column short of the terminal so a full-width line never wraps
  // (a wrapped line would break the up-N-lines redraw math).
  return Math.max(20, Math.min(cols - 1, 120));
}

// Wrap text to a column width. Breaks on spaces, and hard-breaks words that
// are longer than the line. Always returns at least one (possibly empty) line.
function wrapText(text, wcol) {
  if (!text) return [''];
  const lines = [];
  let cur = '';
  for (let word of text.split(' ')) {
    // Hard-break any word longer than a full line.
    while (word.length > wcol) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(word.slice(0, wcol));
      word = word.slice(wcol);
    }
    if (cur === '') cur = word;
    else if ((cur + ' ' + word).length <= wcol) cur += ' ' + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  lines.push(cur);
  return lines;
}

// Fallback for non-interactive stdin (pipes, tests): plain readline.
function askInputSimple() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.magenta('› '), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askInput(options = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) return askInputSimple();

  const model = options.model ? String(options.model).split('/').pop() : '';
  const tag = options.tag || ''; // active MCP server name, if any
  const hint = options.hint || '⎋ esc back  ·  /help  ·  /mcp  ·  /exit';

  return new Promise((resolve) => {
    let text = '';
    // Visible length of each line last drawn, so we can compute how many
    // *visual* rows the previous frame occupies at the CURRENT width (it may
    // have reflowed/wrapped since — e.g. after a terminal resize).
    let prevLens = [];
    const visLen = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
    const occupiedRows = () => {
      const w = process.stdout.columns || 80;
      return prevLens.reduce((sum, len) => sum + Math.max(1, Math.ceil(len / w)), 0);
    };

    function frame(withCaret) {
      const w = width();
      const inner = w - 2; // space between the two vertical borders

      const promptStr = ' › '; // first line prefix
      const indent = '   '; //    continuation lines align under the text
      const avail = Math.max(4, inner - promptStr.length - 1); // text width per line, reserve 1 for caret

      // Wrap the text so all of it stays visible — the box grows as needed.
      const segments = wrapText(text, avail);
      const caretChar = withCaret ? YELLOW('█') : ' ';

      const midLines = segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const prefix = i === 0 ? promptStr : indent;
        const rawLen = prefix.length + seg.length + 1; // +1 for caret/trailing space slot
        const pad = ' '.repeat(Math.max(0, inner - rawLen));
        return (
          YELLOW('│') +
          YELLOW(prefix) +
          seg +
          (isLast ? caretChar : ' ') +
          pad +
          YELLOW('│')
        );
      });

      const top = YELLOW('╭' + '─'.repeat(inner) + '╮');
      const bot = YELLOW('╰' + '─'.repeat(inner) + '╯');

      // Footer line under the box: active MCP tag + hint on the left, model on
      // the right. CRITICAL: the visible length must never exceed `w`, or the
      // footer wraps and the redraw math (which counts it as one line) leaves
      // stale boxes on every keystroke. Priority when short on space:
      // tag > model > hint (hint gets truncated first).
      const tagRaw = tag ? `@${tag}` : '';
      const tagSep = tag ? '  ' : '';
      const leftFixed = tagRaw.length + tagSep.length;
      let rightRaw = model ? `→ ${model}` : '';
      let hintShown = hint;

      const hintBudget = w - leftFixed - rightRaw.length - 1; // 1 = min gap
      if (hintBudget < 0) {
        hintShown = '';
        rightRaw = rightRaw.slice(0, Math.max(0, w - leftFixed - 1));
      } else if (hint.length > hintBudget) {
        hintShown = hintBudget > 1 ? hint.slice(0, hintBudget - 1) + '…' : '';
      }

      const usedLeft = leftFixed + hintShown.length;
      const gap = Math.max(1, w - usedLeft - rightRaw.length);
      const footer =
        (tag ? chalk.green(tagRaw) + tagSep : '') +
        chalk.gray(hintShown) +
        ' '.repeat(gap) +
        chalk.cyan(rightRaw);

      return [top, ...midLines, bot, footer];
    }

    function draw(withCaret) {
      const lines = frame(withCaret);
      if (prevLens.length) {
        // Move up over the previous frame's *current* visual height, then
        // clear everything below — handles reflow after a resize.
        stdout.write(`\x1b[${occupiedRows()}A\r\x1b[0J`);
      } else {
        // First draw: start at column 0 and clear anything left below the
        // cursor (e.g. a leftover menu line) so the box renders cleanly.
        stdout.write('\r\x1b[0J');
      }
      stdout.write(lines.join('\n') + '\n');
      prevLens = lines.map(visLen);
    }

    // Wipe the whole input frame so it doesn't linger in the transcript.
    function erase() {
      if (prevLens.length) stdout.write(`\x1b[${occupiedRows()}A\r\x1b[0J`);
      prevLens = [];
    }

    function cleanup() {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
    }

    function onKey(str, key) {
      if (key && key.ctrl && key.name === 'c') {
        erase();
        cleanup();
        stdout.write('\n');
        process.exit(0);
      }
      if (key && (key.name === 'return' || key.name === 'enter')) {
        erase(); // remove the input frame; the caller echoes the message
        cleanup();
        resolve(text);
        return;
      }
      if (key && key.name === 'backspace') {
        text = text.slice(0, -1);
        draw(true);
        return;
      }
      if (key && key.name === 'escape') {
        if (text) {
          // First Esc: clear whatever is typed, back to an empty box.
          text = '';
          draw(true);
        } else {
          // Esc on an empty box: signal "back to simple chat".
          erase();
          cleanup();
          resolve(ESC_BACK);
        }
        return;
      }
      if (key && ['up', 'down', 'left', 'right', 'tab'].includes(key.name)) {
        return; // ignored for now
      }
      // Printable input (including pasted chunks); skip control chars.
      if (str && !(key && (key.ctrl || key.meta))) {
        const clean = str.replace(/[\r\n]/g, '');
        if (clean && clean >= ' ') {
          text += clean;
          draw(true);
        }
      }
    }

    readline.emitKeypressEvents(stdin);
    // Clear any stray keypress consumers left behind by inquirer menus
    // (/mcp, /config) so each key is handled exactly once — otherwise typed
    // characters get duplicated after using a menu.
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);
    stdin.on('keypress', onKey);
    draw(true);
  });
}

// Wait for a single key: resolves 'enter' on Enter/Return, 'escape' on Esc.
// Uses the same raw-keypress approach as the input box so it works reliably
// even right after an external editor handed the terminal back. On non-TTY
// stdin it resolves 'enter' immediately (nothing to wait on).
function waitEnterOrEsc(message) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (message) stdout.write(message);
  if (!stdin.isTTY) {
    stdout.write('\n');
    return Promise.resolve('enter');
  }

  return new Promise((resolve) => {
    function done(result) {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdout.write('\n');
      resolve(result);
    }
    function onKey(str, key) {
      if (key && key.ctrl && key.name === 'c') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdout.write('\n');
        process.exit(0);
      }
      if (key && (key.name === 'return' || key.name === 'enter')) done('enter');
      else if (key && key.name === 'escape') done('escape');
    }
    readline.emitKeypressEvents(stdin);
    stdin.removeAllListeners('keypress');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}

// Listen for Esc (and Ctrl+C) while the agent is working, so the user can
// interrupt. Calls onEsc() on Escape. Returns a stop() to remove the listener
// and restore the terminal. No-op on non-TTY stdin.
function watchEscape(onEsc) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  function onKey(str, key) {
    if (key && key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (key && key.name === 'escape') {
      onEsc();
    }
  }

  readline.emitKeypressEvents(stdin);
  // Ensure ours is the only keypress consumer while the agent works.
  stdin.removeAllListeners('keypress');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKey);

  return function stop() {
    stdin.removeListener('keypress', onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
  };
}

module.exports = { askInput, watchEscape, waitEnterOrEsc, ESC_BACK };
