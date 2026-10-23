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

function isProviderRateLimit(error) {
  return error?.response?.status === 429 || error?.providerError?.code === 'rate_limit_exceeded';
}

function providerRateLimitMessage(error) {
  const requestId = String(error?.message || '').match(/request ID ([A-Za-z0-9._:-]+)/)?.[1];
  return 'Provider rate limit reached. Please wait and click /continue, or switch to a different provider.' +
    (requestId ? `\nRequest ID: ${requestId}` : '');
}

module.exports = { resumeAfterModel500, isProviderRateLimit, providerRateLimitMessage };
