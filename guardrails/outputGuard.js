// Output guard — masks secrets in tool output.
//
// Runs on every tool result before it is printed and before it goes into
// history, so a leaked key never reaches the terminal, the transcript, or
// the next request to the model.

const { secretPatterns, maxOutputChars } = require('./guardConfig');

function sanitizeOutput(text) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') return text;

  let out = text;
  for (const [pattern, replacement] of secretPatterns) {
    // Patterns are module-level and carry /g, so reset before each use.
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }

  if (out.length > maxOutputChars) {
    out = out.slice(0, maxOutputChars) + `\n…[truncated ${out.length - maxOutputChars} chars]`;
  }
  return out;
}

// True when sanitizing would change the text — useful for telling the user
// something was masked.
function containsSecret(text) {
  return typeof text === 'string' && sanitizeOutput(text) !== text;
}

module.exports = { sanitizeOutput, containsSecret };
