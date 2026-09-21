'use strict';

const { telegramRequest } = require('./client');

async function pollLoop(runtime, signal) {
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
      runtime.onError(error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    for (const update of Array.isArray(updates) ? updates : []) {
      if (Number.isInteger(update.update_id)) {
        runtime.offset = Math.max(runtime.offset, update.update_id + 1);
      }
      // Do not block polling on a model response: /stop must remain responsive.
      void runtime.handleUpdate(update).catch(runtime.onError);
    }
  }
}

module.exports = { pollLoop };
