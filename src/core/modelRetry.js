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
  try { return await send(); } catch (error) {
    if (!enabled || signal?.aborted) throw error;
    const ms = retryDelay(error);
    if (ms === null) throw error;
    // Release an HTTP error stream before starting another request.
    error.response?.data?.destroy?.();
    onRetry?.(ms);
    await wait(ms, undefined, { signal });
    if (signal?.aborted) throw error;
    return send(); // Exactly one retry; never re-run tools here.
  }
}
module.exports = { retryDelay, requestWithRetry };
