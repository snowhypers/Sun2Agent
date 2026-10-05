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

module.exports = {
  HELP_TEXT,
  TelegramRuntime,
  validateTelegramConfig,
  verifyConnection,
  splitMessage,
  sync,
  stop
};
