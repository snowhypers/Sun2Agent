// Retry only the model request; completed tools are never replayed here.
const { setTimeout: delay } = require('node:timers/promises');

function retryDelay(error, now = Date.now()) {
  const status = error.response?.status;
  if (![429, 500, 502, 503, 504].includes(status)
      && !['ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code)) return null;
  const header = error.response?.headers?.['retry-after'];
  let ms = 1000;
  if (header !== undefined) {
    const seconds = Number(header);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  }
  if (!Number.isFinite(ms)) ms = 1000;
  // Never retry sooner than requested; long cooldowns are returned to the user.
  return ms > 30000 ? null : Math.max(0, ms);
}

async function requestWithRetry(send, { signal, onRetry, enabled = false, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await send(); } catch (error) {
      if (signal?.aborted) throw error;
      const rateLimited = error.response?.status === 429;
      // Rate limits get two bounded retries for every model request. Other
      // transient errors keep the existing opt-in, single-retry behavior.
      if ((!rateLimited && (!enabled || attempt > 0)) || (rateLimited && attempt >= 2)) throw error;
      const ms = retryDelay(error);
      if (ms === null) throw error;
      error.response?.data?.destroy?.();
      onRetry?.(ms, attempt + 1, rateLimited);
      await wait(ms, undefined, { signal });
      if (signal?.aborted) throw error;
    }
  }
}
module.exports = { retryDelay, requestWithRetry };
