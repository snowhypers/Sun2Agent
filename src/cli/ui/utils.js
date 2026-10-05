// Background services must not write into an active terminal frame.
const { printAboveInput } = require('./input');

const pending = [];

function notify(message) {
  const text = String(message);
  if (!printAboveInput(text)) pending.push(text);
}

function flushNotices() {
  for (const message of pending.splice(0)) process.stdout.write(`${message}\n`);
}

module.exports = { notify, flushNotices };
