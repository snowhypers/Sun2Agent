'use strict';

const { HELP_TEXT } = require('./messageHandler');

async function handleCommand(runtime, command, chatId) {
  if (command === '/start') {
    await runtime.send(chatId, HELP_TEXT);
    return true;
  }
  if (command === '/new') {
    const controller = runtime.active.get(chatId);
    if (controller) controller.abort();
    runtime.histories.delete(chatId);
    await runtime.send(chatId, '✔ New chat started. Context cleared.');
    return true;
  }
  if (command === '/stop') {
    const controller = runtime.active.get(chatId);
    if (controller) {
      controller.abort();
    } else {
      await runtime.send(chatId, 'Nothing is running.');
    }
    return true;
  }
  return false;
}

module.exports = { handleCommand };
