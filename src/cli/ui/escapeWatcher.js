// Terminal-key escape utilities shared by the chat REPL.
//
// Two consumers exist, both unrelated to the live input box:
//   - waitEnterOrEsc(message) — used after the user finishes editing a file
//     in $EDITOR (e.g. /agent, /memory, /mcp) so we don't return to the
//     REPL until they hit Enter or Esc.
//   - watchEscape(onEsc) — used while the agent is working (long LLM call,
//     tool call, search). Returns a stop() to remove the listener and
//     restore the terminal when the turn is over.

const readline = require('readline');

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

module.exports = { waitEnterOrEsc, watchEscape };
