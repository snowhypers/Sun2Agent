// /new clears only the active in-memory conversation. Durable task summaries
// are created separately, and only with the user's approval through /save.
function startNewSession(history) {
  history.length = 0;
}

module.exports = { startNewSession };
