const { setTimeout: delay } = require('node:timers/promises');

// After the API's bounded request retry, resume one more time from the same
// in-memory tool history. Completed tool calls are not replayed by this layer.
async function resumeAfterModel500(run, { signal, onRetry, wait = delay } = {}) {
  try { return await run(); } catch (error) {
    if (signal?.aborted || error.response?.status !== 500) throw error;
    onRetry?.();
    await wait(2000, undefined, { signal });
    return run();
  }
}

module.exports = { resumeAfterModel500 };
