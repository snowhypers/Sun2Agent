'use strict';

const guardrails = require('../guardrails');
const { telegramRequest } = require('./client');
const { splitMessage } = require('./messageHandler');

const STREAM_TAIL_CHARS = 20;
const MIN_INITIAL_CHARS = 24;
const EDIT_INTERVAL_MS = 600;
const TYPING_INTERVAL_MS = 4000;
const TYPING_TEXT = 'Agent is typing ...';

// Return only the guarded prefix that cannot change when later tokens arrive.
// Partial secrets remain in the held-back tail and never flash in Telegram.
function stableSafeText(raw) {
  const safe = guardrails.outputGuard(raw);
  let printable = Math.max(0, safe.length - STREAM_TAIL_CHARS);
  const consider = (index) => {
    if (index < 0 || index >= printable) return;
    if (safe.slice(index, index + 48).includes('***REDACTED')) return;
    printable = index;
  };

  for (const marker of guardrails.guardConfig.secretStarters) {
    for (let from = safe.indexOf(marker); from >= 0; from = safe.indexOf(marker, from + 1)) {
      consider(from);
    }
  }
  const valuePattern = guardrails.guardConfig.secretValueStart;
  valuePattern.lastIndex = 0;
  let match;
  while ((match = valuePattern.exec(safe)) !== null) {
    consider(match.index);
    if (match.index === valuePattern.lastIndex) valuePattern.lastIndex += 1;
  }
  return safe.slice(0, printable);
}

class TelegramResponseStream {
  constructor({ http, botToken, chatId, replyToMessageId, onError = () => {} }) {
    this.http = http;
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.replyToMessageId = Number.isInteger(replyToMessageId) ? replyToMessageId : null;
    this.onError = onError;
    this.raw = '';
    this.displayed = '';
    this.messageId = null;
    this.editTimer = null;
    this.typingTimer = null;
    this.queue = Promise.resolve();
    this.flushQueued = false;
  }

  async startTyping() {
    // Keep the native Telegram typing state, and also create an explicit
    // placeholder because some clients display the native state only briefly.
    await this.sendTyping();
    const placeholder = {
      chat_id: this.chatId,
      text: TYPING_TEXT
    };
    if (this.replyToMessageId !== null) {
      placeholder.reply_parameters = { message_id: this.replyToMessageId };
    }
    const message = await telegramRequest(this.http, this.botToken, 'sendMessage', placeholder);
    if (message && Number.isInteger(message.message_id)) this.messageId = message.message_id;
    this.displayed = TYPING_TEXT;
    await this.sendTyping();
    this.startTypingTimer();
  }

  async sendTyping() {
    return telegramRequest(this.http, this.botToken, 'sendChatAction', {
      chat_id: this.chatId,
      action: 'typing'
    });
  }

  stopTyping() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  startTypingTimer() {
    if (this.typingTimer) return;
    this.typingTimer = setInterval(() => {
      void this.sendTyping().catch(this.onError);
    }, TYPING_INTERVAL_MS);
  }

  async showStatus(text) {
    this.clearTimers();
    await this.queue;
    this.raw = '';
    const status = String(text || TYPING_TEXT);
    if (this.messageId !== null && status !== this.displayed) {
      await this.editMessage(status);
    }
    this.displayed = status;
    await this.sendTyping();
    this.startTypingTimer();
  }

  push(token) {
    this.raw += String(token || '');
    const stable = stableSafeText(this.raw);
    if (!stable || (this.messageId === null && stable.length < MIN_INITIAL_CHARS)) return;
    if (this.messageId === null && !this.flushQueued) {
      this.enqueueFlush();
      return;
    }
    if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        this.enqueueFlush();
      }, EDIT_INTERVAL_MS);
    }
  }

  enqueueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.queue = this.queue
      .then(() => this.flush())
      .catch(this.onError)
      .finally(() => { this.flushQueued = false; });
  }

  async flush() {
    const text = stableSafeText(this.raw).slice(0, 4000);
    if (!text || text === this.displayed) return;
    this.stopTyping();
    if (this.messageId === null) {
      const message = await telegramRequest(this.http, this.botToken, 'sendMessage', {
        chat_id: this.chatId,
        text
      });
      if (message && Number.isInteger(message.message_id)) this.messageId = message.message_id;
    } else {
      await telegramRequest(this.http, this.botToken, 'editMessageText', {
        chat_id: this.chatId,
        message_id: this.messageId,
        text
      });
    }
    this.displayed = text;
  }

  async finish(finalText) {
    this.clearTimers();
    await this.queue;
    const safe = guardrails.outputGuard(String(finalText || this.raw || ''));
    const chunks = splitMessage(safe);
    if (!chunks.length) return;

    if (this.messageId !== null) {
      if (chunks[0] !== this.displayed) await this.editMessage(chunks[0]);
      for (const chunk of chunks.slice(1)) await this.sendChunk(chunk);
      return;
    }
    for (const chunk of chunks) await this.sendChunk(chunk);
  }

  async editMessage(text) {
    await telegramRequest(this.http, this.botToken, 'editMessageText', {
      chat_id: this.chatId,
      message_id: this.messageId,
      text
    });
  }

  async sendChunk(text) {
    await telegramRequest(this.http, this.botToken, 'sendMessage', {
      chat_id: this.chatId,
      text
    });
  }

  async cancel() {
    this.clearTimers();
    await this.queue;
  }

  clearTimers() {
    this.stopTyping();
    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = null;
  }
}

module.exports = { TelegramResponseStream, stableSafeText, TYPING_TEXT };
