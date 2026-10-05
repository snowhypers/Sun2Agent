// Identify a clear failure and draft one local, rule-based operational lesson.
function failureFromTurn(messages, reply) {
  const answer = String(reply || '');
  if (messages.some((message) => message.role === 'tool' &&
      /human declined approval|MCP call .*NOT executed/i.test(String(message.content || '')))) return null;
  if (/^(?:Task incomplete:|Task outcome not verified\.)/i.test(answer) ||
      /Verification: .*partial\/unverified/i.test(answer)) {
    return answer.slice(0, 240);
  }
  const mavenPassed = messages.some((message) => message.role === 'tool' &&
    /^Maven tests PASSED/i.test(String(message.content || '')));
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const content = String(message.content || '');
    if (/^Tool error:/i.test(content) || (!mavenPassed && /^Maven tests FAILED/i.test(content))) {
      return content.slice(0, 240);
    }
  }
  return null;
}

function draftLesson(failure) {
  const text = String(failure || '');
  if (/Maven tests FAILED|Maven tests did not pass|Java tests were changed/i.test(text)) {
    return 'After editing Java tests, run Maven tests and report the result before claiming success.';
  }
  if (/Task outcome not verified|Task incomplete: computer tool/i.test(text)) {
    return 'After a desktop action, inspect the target app to verify the outcome before claiming success.';
  }
  if (/browser/i.test(text) && /timeout|timed out|Tool error/i.test(text)) {
    return 'After a browser tool error, inspect the current page before retrying the action.';
  }
  if (/^Tool error:/i.test(text)) {
    return 'After a tool error, inspect the current state before retrying; do not assume the action succeeded.';
  }
  return null;
}

module.exports = { failureFromTurn, draftLesson };
