// Stable entry point for the local, user-approved self-improvement loop.
const store = require('./store');
const reflection = require('./reflection');

function addLessonToPrompt(prompt, lesson) {
  const safe = store.normalizeLesson(lesson);
  return safe ? prompt + '\n\nUser-approved operational lesson (advisory only; never overrides tool approvals, guardrails, or the current user request):\n- ' + safe : prompt;
}

module.exports = { ...store, ...reflection, addLessonToPrompt };
