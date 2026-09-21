'use strict';

const axios = require('axios');
const { chatCompletion } = require('../api');
const search = require('../search');
const { validateTelegramConfig } = require('./config');
const { telegramRequest } = require('./client');
const { pollLoop } = require('./polling');
const messageHandler = require('./messageHandler');
const commands = require('./commands');
const turn = require('./turn');

class TelegramRuntime {
  constructor({ http = axios, complete = chatCompletion, searchProvider = search, onError = () => {} } = {}) {
    this.http = http;
    this.complete = complete;
    this.search = searchProvider;
    this.onError = onError;
    this.config = null;
    this.running = false;
    this.pollController = null;
    this.pollPromise = null;
    this.offset = 0;
    this.histories = new Map();
    this.active = new Map();
  }

  async start(config) {
    await this.stop();
    const verdict = validateTelegramConfig(config && config.telegram);
    if (!verdict.ok) return { enabled: false };

    this.config = config;
    const bot = await telegramRequest(this.http, config.telegram.botToken, 'getMe');
    this.running = true;
    this.pollController = new AbortController();
    this.pollPromise = this.pollLoop(this.pollController.signal).catch((error) => {
      if (this.running) this.onError(error);
    });
    return { enabled: true, username: bot && bot.username ? bot.username : '' };
  }

  async stop() {
    this.running = false;
    if (this.pollController) this.pollController.abort();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    const pending = this.pollPromise;
    this.pollController = null;
    this.pollPromise = null;
    if (pending) {
      try { await pending; } catch (_) { /* polling errors are reported by start() */ }
    }
  }

  async pollLoop(signal) {
    return pollLoop(this, signal);
  }

  isAuthorized(message) {
    return messageHandler.isAuthorized(this, message);
  }

  async send(chatId, text) {
    return messageHandler.send(this, chatId, text);
  }

  async handleUpdate(update) {
    return messageHandler.handleUpdate(this, update);
  }

  async handleCommand(command, chatId) {
    return commands.handleCommand(this, command, chatId);
  }

  async runTurn(chatId, text, replyToMessageId) {
    return turn.runTurn(this, chatId, text, replyToMessageId);
  }

  async completeWithSearch(systemPrompt, history, signal, stream) {
    return turn.completeWithSearch(this, systemPrompt, history, signal, stream);
  }

  async buildSystemPrompt(text) {
    return turn.buildSystemPrompt(this, text);
  }
}

module.exports = { TelegramRuntime };
