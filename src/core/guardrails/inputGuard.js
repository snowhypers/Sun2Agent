// Input guard — screens the user's prompt before it reaches the LLM.
//
// Catches prompt-injection and system-prompt-extraction phrasing. Plain
// substring matching, no model calls, so it is instant and predictable.

const { blockedPrompts } = require('./guardConfig');

// Collapse whitespace and lowercase so "IGNORE   previous  instructions"
// matches the same rule as the canonical form.
function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function validateInput(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: true };

  const text = normalize(prompt);
  for (const phrase of blockedPrompts) {
    if (text.includes(phrase)) {
      return {
        ok: false,
        guard: 'input',
        matched: phrase,
        reason: `Blocked by Input Guard: prompt contains "${phrase}"`
      };
    }
  }
  return { ok: true };
}

module.exports = { validateInput };
