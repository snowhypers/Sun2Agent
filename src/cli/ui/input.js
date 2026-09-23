// Single-line chat input: reads a line of text from the user with live
// redraws, history navigation, and Esc handling. Resolves with the typed
// text on Enter, or ESC_BACK when Esc is pressed on an empty box.
//
// Styling, raw-mode keypress, and redraw math all live here so the caller
// just awaits askInput({ model, tag }).

const readline = require('readline');
const chalk = require('chalk');
const stringWidth = require('string-width');

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

function width() {
  const cols = process.stdout.columns || 80;
  // Stay one column short of the terminal so a full-width line never wraps
  // (a wrapped line would break the up-N-lines redraw math).
  return Math.max(20, Math.min(cols - 1, 120));
}

function sliceToWidth(value, maxWidth) {
  let end = 0;
  let used = 0;
  for (const char of value) {
    const charWidth = stringWidth(char);
    if (used + charWidth > maxWidth) break;
    used += charWidth;
    end += char.length;
  }
  return value.slice(0, end);
}

// Wrap text to a column width. Breaks on spaces, and hard-breaks words that
// are longer than the line. Always returns at least one (possibly empty) line.
function wrapText(text, wcol) {
  if (!text) return [''];
  const lines = [];
  let cur = '';
  for (let word of text.split(' ')) {
    // Hard-break any word longer than a full line.
    while (stringWidth(word) > wcol) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      const part = sliceToWidth(word, wcol);
      lines.push(part);
      word = word.slice(part.length);
    }
    if (cur === '') cur = word;
    else if (stringWidth(cur + ' ' + word) <= wcol) cur += ' ' + word;
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
  // Skills tag is a pre-formatted, space-separated list of "@<id>" tokens
  // (e.g. "@coding @debugging"). It already includes the @ prefixes and
  // is rendered verbatim next to the MCP tag.
  const skillTag = options.skillTag || '';
  const hint = options.hint || '⎋ esc back  ·  /help  ·  /workspace  ·  /mcp  ·  /skills  ·  /exit';

  return new Promise((resolve) => {
    let text = '';
    // Visible length of each line last drawn, so we can compute how many
    // *visual* rows the previous frame occupies at the CURRENT width (it may
    // have reflowed/wrapped since — e.g. after a terminal resize).
    let prevLens = [];
    const visLen = stringWidth;
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

      // Footer line under the box: active MCP tag + skills tag + hint on the
      // left, model on the right. CRITICAL: the visible length must never
      // exceed `w`, or the footer wraps and the redraw math (which counts it
      // as one line) leaves stale boxes on every keystroke. Priority when
      // short on space: mcp tag > skills tag > model > hint (hint gets
      // truncated first, then the skills tag, then the model).
      //
      // tagSep is the gap BETWEEN the MCP tag and what follows it (skills
      // tag, or hint if no skills). skillSep is the gap BETWEEN the
      // skills tag and the hint. Both must be set whenever their
      // respective tag is present — even when only one of the two is
      // shown — otherwise the tag glues to the hint with no space and
      // looks broken. The earlier `(tag && skillTag)` guard was wrong:
      // skills are independent of MCP, so the skills tag can be shown
      // without an MCP tag and must still get its own separator.
      const tagRaw = tag ? `@${tag}` : '';
      const tagSep = tag ? '  ' : '';
      const skillSep = skillTag ? '  ' : '';
      const leftFixed = stringWidth(tagRaw + tagSep + skillTag + skillSep);
      let rightRaw = model ? `→ ${model}` : '';
      let hintShown = hint;
      let skillTagShown = skillTag;

      const hintBudget = w - leftFixed - stringWidth(rightRaw) - 1; // 1 = min gap
      if (hintBudget < 0) {
        // Not enough room even for the model. First trim hint, then model,
        // then the skills tag. The MCP tag always stays (it's the most
        // important — the user must know which server is active).
        const room = w - stringWidth(tagRaw + tagSep) - 1;
        if (room < stringWidth(skillTag)) {
          skillTagShown = '';
        }
        hintShown = '';
        rightRaw = sliceToWidth(rightRaw, Math.max(0, w - stringWidth(tagRaw + tagSep + skillTagShown) - 1));
      } else if (stringWidth(hint) > hintBudget) {
        hintShown = hintBudget > 1 ? sliceToWidth(hint, hintBudget - 1) + '…' : '';
      }

      const usedLeft = stringWidth(tagRaw + tagSep + skillTagShown + skillSep + hintShown);
      const gap = Math.max(1, w - usedLeft - stringWidth(rightRaw));
      const footer =
        (tag ? chalk.green(tagRaw) + tagSep : '') +
        (skillTagShown ? chalk.green(skillTagShown) + skillSep : '') +
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
      if (activeInput && activeInput.erase === erase) activeInput = null;
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
    activeInput = { erase, draw };
    draw(true);
  });
}

module.exports = { askInput, ESC_BACK, printAboveInput };
