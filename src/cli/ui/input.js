// Single-line chat input: reads a line of text from the user with live
// redraws, history navigation, and Esc handling. Resolves with the typed
// text on Enter, or ESC_BACK when Esc is pressed on an empty box.
//
// Styling, raw-mode keypress, and redraw math all live here so the caller
// just awaits askInput({ model, tag }).

const readline = require('readline');
const chalk = require('chalk');
const stringWidth = require('string-width');
const { sliceToWidth, terminalWidth, truncateToWidth, wrapText } = require('./layout');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Sentinel resolved by askInput when Esc is pressed on an empty box — the
// caller treats it as "go back to simple chat" (disconnect MCP, drop tag).
const ESC_BACK = Symbol('escBack');

// Soft, muted ("low") yellow for the input box — dimmer than bright yellow.
const YELLOW = chalk.hex('#b5a642');
let activeInput = null;

// Background Telegram failures must be printed above the live input box.
// Writing directly to stderr while the box is drawn invalidates its cursor
// position, so the next keystroke can erase or duplicate part of the frame.
function printAboveInput(message) {
  if (!activeInput) return false;
  activeInput.erase();
  process.stdout.write(`${message}\n`);
  activeInput.draw(true);
  return true;
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
  // Skills tag is a pre-formatted, space-separated list of "@<id>" tokens
  // (e.g. "@coding @debugging"). It already includes the @ prefixes and
  // is rendered verbatim next to the MCP tag.
  const skillTag = options.skillTag || '';
  const hint = options.hint || '⎋ esc back  ·  /help  ·  /mcp  ·  /exit';

  return new Promise((resolve) => {
    let text = '';
    // Visible length of each line last drawn, so we can compute how many
    // *visual* rows the previous frame occupies at the CURRENT width (it may
    // have reflowed/wrapped since — e.g. after a terminal resize).
    let prevLens = [];
    const visLen = stringWidth;
    const occupiedRows = () => {
      const w = Math.max(1, Number(stdout.columns) || 80);
      return prevLens.reduce((sum, len) => sum + Math.max(1, Math.ceil(len / w)), 0);
    };

    function frame(withCaret) {
      const w = terminalWidth(stdout, Infinity);
      const inner = w - 2; // space between the two vertical borders

      const promptStr = ' › '; // first line prefix
      const indent = '   '; //    continuation lines align under the text
      const avail = Math.max(1, inner - promptStr.length - 1); // text width per line, reserve 1 for caret

      // Wrap the text so all of it stays visible — the box grows as needed.
      const segments = wrapText(text, avail);
      const caretChar = withCaret ? YELLOW('█') : ' ';

      const midLines = segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const prefix = i === 0 ? promptStr : indent;
        const rawLen = stringWidth(prefix + seg) + 1; // +1 for caret/trailing space slot
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

      const tagRaw = tag ? `@${tag}` : '';
      const rightRaw = model ? `→ ${model}` : '';
      const tagShown = truncateToWidth(tagRaw, Math.floor(w * 0.35));
      // Keep the full model name when possible; shorten the hints first.
      const rightBudget = Math.max(0, w - stringWidth(tagShown) - (tagShown ? 2 : Math.min(16, Math.floor(w / 3))));
      const rightShown = truncateToWidth(rightRaw, rightBudget);
      const outerGap = rightShown ? 1 : 0;
      let leftBudget = Math.max(0, w - stringWidth(rightShown) - outerGap);
      const leftParts = [];

      if (tagShown) {
        leftParts.push({ value: tagShown, color: chalk.green });
        leftBudget -= stringWidth(tagShown);
      }
      if (skillTag && leftBudget > 2) {
        const room = leftBudget - (leftParts.length ? 2 : 0);
        const shown = truncateToWidth(skillTag, room);
        if (shown) {
          leftParts.push({ value: shown, color: chalk.green });
          leftBudget -= stringWidth(shown) + (leftParts.length > 1 ? 2 : 0);
        }
      }
      if (hint && leftBudget > 2) {
        const room = leftBudget - (leftParts.length ? 2 : 0);
        const shown = truncateToWidth(w < 60 ? '/help · /exit' : hint, room);
        if (shown) leftParts.push({ value: shown, color: chalk.gray });
      }

      const left = leftParts.map(({ value, color }) => color(value)).join('  ');
      const usedLeft = leftParts.reduce((sum, part, index) => sum + stringWidth(part.value) + (index ? 2 : 0), 0);
      const gap = rightShown ? Math.max(outerGap, w - usedLeft - stringWidth(rightShown)) : 0;
      const footer = left + ' '.repeat(gap) + chalk.cyan(rightShown);

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
      if (activeInput && activeInput.erase === erase) activeInput = null;
      stdin.removeListener('keypress', onKey);
      stdout.removeListener('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
    }

    function onResize() {
      draw(true);
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
    stdout.on('resize', onResize);
    activeInput = { erase, draw };
    draw(true);
  });
}

module.exports = { askInput, ESC_BACK, printAboveInput };
