'use strict';

const { telegramRequest } = require('./client');
const fs = require('node:fs');
const path = require('node:path');

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
  const pending = new Map();
  const inFlight = new Set();
  function save() {
    if (!runtime.pendingFile) return;
    fs.mkdirSync(path.dirname(runtime.pendingFile), { recursive: true, mode: 0o700 });
    const temp = `${runtime.pendingFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ offset: runtime.offset,
      pending: [...pending.values()] }), { mode: 0o600 });
    fs.renameSync(temp, runtime.pendingFile);
  }
  function dispatch(update) {
    const id = update.update_id;
    if (inFlight.has(id)) return;
    inFlight.add(id);
    // Keep polling while the model runs so /stop can interrupt the turn.
    void runtime.handleUpdate(update).then(() => {
      if (!signal.aborted) {
        pending.delete(id);
        save();
      }
    }).catch(runtime.onError).finally(() => inFlight.delete(id));
  }
  if (runtime.pendingFile && fs.existsSync(runtime.pendingFile)) {
    const saved = JSON.parse(fs.readFileSync(runtime.pendingFile, 'utf8'));
    runtime.offset = Math.max(runtime.offset, saved.offset || 0);
    for (const update of saved.pending || []) {
      pending.set(update.update_id, update);
      if (Number.isInteger(update.update_id)) runtime.offset = Math.max(runtime.offset, update.update_id + 1);
    }
  }
  for (const update of pending.values()) dispatch(update);
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
      if (pending.has(update.update_id)) continue;
      pending.set(update.update_id, update);
      if (Number.isInteger(update.update_id)) {
        runtime.offset = Math.max(runtime.offset, update.update_id + 1);
      }
      save();
      dispatch(update);
    }
  }
}

module.exports = { pollLoop, isPollingConflict };
