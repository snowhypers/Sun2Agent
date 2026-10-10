'use strict';

const { TelegramRuntime } = require('./telegram');
const { validateTelegramConfig } = require('./config');
const { verifyConnection } = require('./client');
const { HELP_TEXT, splitMessage } = require('./messageHandler');
const { notify } = require('../../cli/ui/utils');

const runtime = new TelegramRuntime({
  onError: (error) => {
    const message = error && error.message ? error.message : 'unknown error';
    const notice = `Telegram: ${message}`;
    notify(notice);
  }
});

async function sync(config) {
  return runtime.start(config);
}

async function stop() {
  return runtime.stop();
}

function setMcpReady(promise) {
  runtime.setMcpReady(promise);
}

async function prepareScheduled(job) {
  return runtime.prepareScheduled(job);
}

async function sendScheduled(text) {
  return runtime.sendScheduled(text);
}

module.exports = {
  HELP_TEXT,
  TelegramRuntime,
  validateTelegramConfig,
  verifyConnection,
  splitMessage,
  sync,
  setMcpReady,
  prepareScheduled,
  sendScheduled,
  stop
};
