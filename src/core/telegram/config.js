'use strict';

function validateTelegramConfig(value) {
  const telegram = value || {};
  if (!telegram.enabled) return { ok: false, reason: 'Telegram is disabled.' };
  if (typeof telegram.botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(telegram.botToken.trim())) {
    return { ok: false, reason: 'The Telegram bot token is not valid.' };
  }
  if (typeof telegram.chatId !== 'string' || !/^\d+$/.test(telegram.chatId.trim())) {
    return { ok: false, reason: 'The Telegram chat ID must be a positive integer.' };
  }
  return { ok: true };
}

module.exports = { validateTelegramConfig };
