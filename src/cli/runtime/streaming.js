// Streaming render layer.
//
// Pure presentation: turn a stream of tokens into safe-to-print characters on
// stdout, never letting a partial secret reach the terminal. Knows nothing
// about the LLM, the tool loop, or the chat REPL — it just exposes:
//
//   - createTokenHandler(guardrails) -> onToken(token)
//       The callback api.js calls for every streamed token. Accumulates raw
//       text, runs outputGuard(), and writes only the new safe prefix to
//       stdout. The immutable-prefix invariant (see chatTurn note) means the
//       live output and the final flush always line up.
//
//   - createTurnResetter() -> onToolTurn()
//       Resets the streaming buffers between tool-call iterations. The
//       intermediate tokens from a tool-call turn are not assistant output.
//
//   - finalFlush(reply, guardrails, streamPrinted, streamed)
//       Called once after chatTurn resolves. Re-masks the full reply (a
//       secret may have spanned the held-back tail), then writes the rest of
//       the safe text and a final newline. The streamed() and streamPrinted
//       numbers are passed in so this layer stays stateless.

const chalk = require('chalk');

// Fixed tail always held back from live printing: long enough that any secret
// START marker fully forms inside the unprinted region before any of its
// characters can reach the terminal. (Longest marker is 11 chars; 20 gives
// a safety margin and still keeps the output feeling live.)
const STREAM_TAIL_CHARS = 20;

// Create the per-token handler used by chatTurn. `guardrails` must expose:
//   - outputGuard(text)  -> masked text
//   - guardConfig.secretStarters  (array of literal starters to look for)
//   - guardConfig.secretValueStart  (RegExp whose matches name the position
//     of a value-style secret, e.g. "key=" or 'token: "')
function createTokenHandler(guardrails) {
  let streamRaw = '';
  let streamPrinted = 0;
  let streamed = false;

  const onToken = (token) => {
    streamRaw += token;
    const safe = guardrails.outputGuard(streamRaw);
    // Stream only the STABLE prefix of the guarded text. A secret that
    // arrives across several chunks cannot be masked until it is complete,
    // so text from the last potential secret start is held back (plus the
    // fixed tail) until the guard has seen enough to decide. What was
    // already printed is therefore immutable: a mid-stream mask can only
    // change text inside the held-back region, so the live output and the
    // final flush always line up with no gaps, duplication, or garbling —
    // and no partial secret ever reaches the terminal.
    let printable = Math.max(0, safe.length - STREAM_TAIL_CHARS);
    const consider = (idx) => {
      if (idx < 0 || idx >= printable) return;
      // A starter that already sits inside a completed mask belongs to a
      // secret the guard has handled — it must not stall streaming.
      if (safe.slice(idx, idx + 48).includes('***REDACTED')) return;
      printable = idx;
    };
    for (const marker of guardrails.guardConfig.secretStarters) {
      for (let from = safe.indexOf(marker); from >= 0; from = safe.indexOf(marker, from + 1)) {
        consider(from);
      }
    }
    const valueRe = guardrails.guardConfig.secretValueStart;
    valueRe.lastIndex = 0;
    let vm;
    while ((vm = valueRe.exec(safe)) !== null) {
      consider(vm.index);
      if (vm.index === valueRe.lastIndex) valueRe.lastIndex += 1; // zero-length safety
    }
    if (printable <= streamPrinted) return;
    if (!streamed) {
      streamed = true;
      process.stdout.write(chalk.yellow.bold('sun2Agent: '));
    }
    process.stdout.write(safe.slice(streamPrinted, printable));
    streamPrinted = printable;
  };

  return {
    onToken,
    onToolTurn: () => {
      // Tokens received while the model was constructing a tool call are not
      // assistant output. Start a fresh output buffer for the answer that is
      // generated after the tool result is returned.
      streamRaw = '';
      streamPrinted = 0;
      streamed = false;
    },
    // Read-only state for the final flush + outside callers.
    getStreamed: () => streamed,
    getStreamPrinted: () => streamPrinted,
    getStreamRaw: () => streamRaw
  };
}

// Final flush after chatTurn returns. Re-masks the full reply (a secret may
// have spanned the held-back tail), then writes the rest of the safe text
// and a final newline. If nothing was streamed, falls back to a single-shot
// print of the whole reply.
//
// Returns the text that was actually printed to stdout (for callers that
// want to log / persist the final visible answer).
function finalFlush({ reply, streamRaw, streamed, streamPrinted, guardrails, sanitizeTerminalText }) {
  if (streamed) {
    const safe = guardrails.outputGuard(reply || streamRaw);
    process.stdout.write(safe.slice(streamPrinted) + '\n\n');
    return safe;
  }
  // Non-streamed path: sanitize the reply the same way startChat did before
  // extraction, so tool output / model replies carrying ANSI or control
  // characters never reach the terminal raw.
  const clean = sanitizeTerminalText ? sanitizeTerminalText(reply || '') : (reply || '');
  const out = chalk.yellow.bold('sun2Agent: ') + clean + '\n';
  process.stdout.write(out);
  return out;
}

module.exports = {
  STREAM_TAIL_CHARS,
  createTokenHandler,
  finalFlush
};
