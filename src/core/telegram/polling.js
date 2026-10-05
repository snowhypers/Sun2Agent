'use strict';

const { telegramRequest } = require('./client');

function isPollingConflict(error) {
  return error && (
    error.status === 409 ||
    error.telegramErrorCode === 409 ||
    /conflict:.*getupdates request/i.test(String(error.message || ''))
  );
}

function waitForRetry(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

async function pollLoop(runtime, signal) {
  let failures = 0;
  let lastError = '';
  while (runtime.running && !signal.aborted) {
    let updates;
    try {
      updates = await telegramRequest(runtime.http, runtime.config.telegram.botToken, 'getUpdates', {
        offset: runtime.offset,
        timeout: 25,
        allowed_updates: ['message']
      }, signal);
    } catch (error) {
      if (signal.aborted || !runtime.running) return;
      if (isPollingConflict(error)) {
        runtime.running = false;
        runtime.onError(new Error(
          'Polling stopped because this bot is already running in another process. ' +
          'Stop the other instance, then restart Sun2Agent.'
        ));
        return;
      }
      const errorText = String(error && error.message || error);
      if (errorText !== lastError) runtime.onError(error);
      lastError = errorText;
      failures += 1;
      await waitForRetry(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)), signal);
      continue;
    }
    failures = 0;
    lastError = '';
    for (const update of Array.isArray(updates) ? updates : []) {
      if (Number.isInteger(update.update_id)) {
        runtime.offset = Math.max(runtime.offset, update.update_id + 1);
      }
      // Do not block polling on a model response: /stop must remain responsive.
      void runtime.handleUpdate(update).catch(runtime.onError);
    }
  }
}

module.exports = { pollLoop, isPollingConflict };
