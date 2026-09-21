'use strict';

const guardrails = require('../guardrails');
const { telegramRequest } = require('./client');

const MAX_MESSAGE_LENGTH = 4000;
const HELP_TEXT = [
  '☀️ Sun2Agent is connected.',
  '',
  'Send a message to chat with the agent.',
  '/new — clear this chat\'s context',
  '/stop — abort the active response',
  '/start — show this help'
].join('\n');

function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  const source = String(text || '');
  if (!source) return [];
  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isAuthorized(runtime, message) {
  if (!message || !message.chat || message.chat.type !== 'private' || !message.from) return false;
  const allowed = String(runtime.config.telegram.chatId);
  return String(message.chat.id) === allowed && String(message.from.id) === allowed;
}

async function send(runtime, chatId, text) {
  const safe = guardrails.outputGuard(String(text || ''));
  for (const chunk of splitMessage(safe)) {
    await telegramRequest(runtime.http, runtime.config.telegram.botToken, 'sendMessage', {
      chat_id: String(chatId),
      text: chunk
    });
  }
}

async function handleUpdate(runtime, update) {
  const message = update && update.message;
  if (!runtime.config || !isAuthorized(runtime, message) || typeof message.text !== 'string') return false;

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0].toLowerCase().replace(/@[^\s]+$/, '');

  const handled = await runtime.handleCommand(command, chatId);
  if (handled || !text) return true;
  if (command.startsWith('/')) {
    await runtime.send(chatId, 'Unknown command. Send /start for help.');
    return true;
  }
  if (runtime.active.has(chatId)) {
    await runtime.send(chatId, 'A response is already running. Send /stop to cancel it.');
    return true;
  }

  const inputVerdict = guardrails.inputGuard(text);
  if (!inputVerdict.ok) {
    await runtime.send(chatId, `⛔ ${inputVerdict.reason}`);
    return true;
  }

  await runtime.runTurn(chatId, text, message.message_id);
  return true;
}

module.exports = { HELP_TEXT, splitMessage, isAuthorized, send, handleUpdate };
