'use strict';

const { TelegramRuntime } = require('./telegram');
const { validateTelegramConfig } = require('./config');
const { verifyConnection } = require('./client');
const { HELP_TEXT, splitMessage } = require('./messageHandler');
const { printAboveInput } = require('../../cli/ui/input');

const runtime = new TelegramRuntime({
  onError: (error) => {
    const message = error && error.message ? error.message : 'unknown error';
    const notice = `Telegram: ${message}`;
    if (!printAboveInput(notice)) console.error(notice);
  }
});

async function sync(config) {
  return runtime.start(config);
}

async function stop() {
  return runtime.stop();
}

module.exports = {
  HELP_TEXT,
  TelegramRuntime,
  validateTelegramConfig,
  verifyConnection,
  splitMessage,
  sync,
  stop
};
