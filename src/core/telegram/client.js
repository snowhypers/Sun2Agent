'use strict';

const axios = require('axios');
const { validateTelegramConfig } = require('./config');

const TELEGRAM_API = 'https://api.telegram.org';

function apiUrl(token, method) {
  return `${TELEGRAM_API}/bot${token}/${method}`;
}

function safeTelegramError(error, token) {
  const description = error && error.response && error.response.data && error.response.data.description;
  const raw = typeof description === 'string' ? description : (error && error.message) || 'Telegram request failed.';
  const secret = String(token || '');
  return secret ? String(raw).replaceAll(secret, '[REDACTED]') : String(raw);
}

async function telegramRequest(http, token, method, data = {}, signal) {
  try {
    const response = await http.post(apiUrl(token, method), data, { signal });
    if (!response.data || response.data.ok !== true) throw new Error('Telegram rejected the request.');
    return response.data.result;
  } catch (error) {
    if (signal && signal.aborted) throw error;
    const wrapped = new Error(safeTelegramError(error, token));
    wrapped.status = error && error.response && error.response.status;
    wrapped.telegramErrorCode = error && error.response && error.response.data && error.response.data.error_code;
    throw wrapped;
  }
}

async function verifyConnection(botToken, chatId, http = axios) {
  const telegram = {
    enabled: true,
    botToken: String(botToken || '').trim(),
    chatId: String(chatId || '').trim()
  };
  const verdict = validateTelegramConfig(telegram);
  if (!verdict.ok) throw new Error(verdict.reason);

  const bot = await telegramRequest(http, telegram.botToken, 'getMe');
  await telegramRequest(http, telegram.botToken, 'sendMessage', {
    chat_id: telegram.chatId,
    text: '☀️ Sun2Agent connected. Send /start for help.'
  });
  return { username: bot && bot.username ? bot.username : '' };
}

module.exports = { telegramRequest, verifyConnection };
