'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  TelegramRuntime,
  validateTelegramConfig,
  verifyConnection,
  splitMessage
} = require('../src/core/telegram');
const { handleConfig } = require('../src/cli/commands/config');

const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyzABCDE';
const CHAT_ID = '123456789';

function messageUpdate(text, chatId = CHAT_ID) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      text,
      from: { id: Number(chatId) },
      chat: { id: Number(chatId), type: 'private' }
    }
  };
}

function fakeHttp() {
  const calls = [];
  let nextMessageId = 1;
  return {
    calls,
    async post(url, data) {
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push({ method, data });
      if (method === 'getMe') return { data: { ok: true, result: { username: 'sun_test_bot' } } };
      if (method === 'getUpdates') return { data: { ok: true, result: [] } };
      if (method === 'sendMessage') return { data: { ok: true, result: { message_id: nextMessageId++ } } };
      return { data: { ok: true, result: {} } };
    }
  };
}

function runtimeConfig() {
  return {
    apiKey: 'nvapi-test',
    model: 'test-model',
    memory: { enabled: false },
    selectedSkills: [],
    telegram: { enabled: true, botToken: TOKEN, chatId: CHAT_ID }
  };
}

test('Telegram config validation requires a token and positive chat ID', () => {
  assert.strictEqual(validateTelegramConfig({ enabled: false }).ok, false);
  assert.strictEqual(validateTelegramConfig({ enabled: true, botToken: 'bad', chatId: CHAT_ID }).ok, false);
  assert.strictEqual(validateTelegramConfig({ enabled: true, botToken: TOKEN, chatId: '-10' }).ok, false);
  assert.strictEqual(validateTelegramConfig(runtimeConfig().telegram).ok, true);
});

test('/config disables Telegram without erasing credentials and verifies token then chat ID on yes', async () => {
  const base = runtimeConfig();
  base.langsmith = { enabled: false, project: 'sun2agent' };
  base.search = { enabled: false, provider: 'tavily', apiKey: '' };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const noPrompts = [];
    let savedNo;
    const noAnswers = {
      apiKey: { apiKey: base.apiKey },
      model: { model: base.model },
      enableSearch: { enableSearch: false },
      enableLangSmith: { enableLangSmith: false },
      enableMemory: { enableMemory: false },
      connectTelegram: { connectTelegram: false }
    };
    await handleConfig({
      loadConfig: () => base,
      saveConfig: (value) => { savedNo = value; },
      promptBack: async ([question]) => {
        noPrompts.push(question.name);
        return noAnswers[question.name];
      }
    });
    assert.deepStrictEqual(noPrompts, [
      'apiKey', 'model', 'enableSearch', 'enableLangSmith', 'enableMemory', 'connectTelegram'
    ]);
    assert.deepStrictEqual(savedNo.telegram, {
      enabled: false,
      botToken: TOKEN,
      chatId: CHAT_ID
    });
    assert.strictEqual(validateTelegramConfig(savedNo.telegram).ok, false);

    const yesPrompts = [];
    let savedYes;
    let verified;
    const yesAnswers = {
      ...noAnswers,
      connectTelegram: { connectTelegram: true },
      telegramBotToken: { telegramBotToken: TOKEN },
      telegramChatId: { telegramChatId: CHAT_ID }
    };
    await handleConfig({
      loadConfig: () => ({ ...base, telegram: { enabled: false, botToken: '', chatId: '' } }),
      saveConfig: (value) => { savedYes = value; },
      verifyTelegramConnection: async (token, chatId) => {
        verified = [token, chatId];
        return { username: 'sun_test_bot' };
      },
      promptBack: async ([question]) => {
        yesPrompts.push(question.name);
        if (question.name === 'telegramBotToken') assert.strictEqual(question.default, undefined);
        if (question.name === 'telegramChatId') assert.strictEqual(question.default, undefined);
        return yesAnswers[question.name];
      }
    });
    assert.deepStrictEqual(yesPrompts.slice(-3), ['connectTelegram', 'telegramBotToken', 'telegramChatId']);
    assert.deepStrictEqual(verified, [TOKEN, CHAT_ID]);
    assert.deepStrictEqual(savedYes.telegram, { enabled: true, botToken: TOKEN, chatId: CHAT_ID });
  } finally {
    console.log = originalLog;
  }
});

test('/config reuses saved Telegram credentials after they were disabled', async () => {
  const base = {
    ...runtimeConfig(),
    langsmith: { enabled: false, project: 'sun2agent' },
    search: { enabled: false, provider: 'tavily', apiKey: '' },
    telegram: { enabled: false, botToken: TOKEN, chatId: CHAT_ID }
  };
  const answers = {
    apiKey: { apiKey: base.apiKey },
    model: { model: base.model },
    enableSearch: { enableSearch: false },
    enableLangSmith: { enableLangSmith: false },
    enableMemory: { enableMemory: false },
    connectTelegram: { connectTelegram: true },
    telegramBotToken: { telegramBotToken: TOKEN },
    telegramChatId: { telegramChatId: CHAT_ID }
  };
  let saved;
  let verified;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await handleConfig({
      loadConfig: () => base,
      saveConfig: (value) => { saved = value; },
      verifyTelegramConnection: async (token, chatId) => {
        verified = [token, chatId];
        return { username: 'sun_test_bot' };
      },
      promptBack: async ([question]) => {
        if (question.name === 'telegramBotToken') assert.strictEqual(question.default, TOKEN);
        if (question.name === 'telegramChatId') assert.strictEqual(question.default, CHAT_ID);
        return answers[question.name];
      }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepStrictEqual(verified, [TOKEN, CHAT_ID]);
  assert.deepStrictEqual(saved.telegram, { enabled: true, botToken: TOKEN, chatId: CHAT_ID });
});

test('Telegram connection verification checks the bot and sends confirmation', async () => {
  const http = fakeHttp();
  const result = await verifyConnection(TOKEN, CHAT_ID, http);
  assert.strictEqual(result.username, 'sun_test_bot');
  assert.deepStrictEqual(http.calls.map((call) => call.method), ['getMe', 'sendMessage']);
  assert.strictEqual(http.calls[1].data.chat_id, CHAT_ID);
});

test('Telegram long replies are split below the API limit', () => {
  const chunks = splitMessage('word '.repeat(2500));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.strictEqual(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'word '.repeat(2500).trim());
});

test('Telegram ignores messages outside the configured private chat', async () => {
  const http = fakeHttp();
  const runtime = new TelegramRuntime({ http });
  runtime.config = runtimeConfig();
  const handled = await runtime.handleUpdate(messageUpdate('hello', '999999999'));
  assert.strictEqual(handled, false);
  assert.strictEqual(http.calls.length, 0);
});

test('Telegram /start and /new provide help and clear context', async () => {
  const http = fakeHttp();
  const runtime = new TelegramRuntime({ http });
  runtime.config = runtimeConfig();
  runtime.histories.set(CHAT_ID, [{ role: 'user', content: 'old context' }]);

  await runtime.handleUpdate(messageUpdate('/start'));
  await runtime.handleUpdate(messageUpdate('/new'));

  const sent = http.calls.filter((call) => call.method === 'sendMessage').map((call) => call.data.text);
  assert.match(sent[0], /\/stop/);
  assert.match(sent[1], /Context cleared/);
  assert.strictEqual(runtime.histories.has(CHAT_ID), false);
});

test('Telegram text chat calls the model without tools and saves history', async () => {
  const http = fakeHttp();
  let invocation;
  const runtime = new TelegramRuntime({
    http,
    complete: async (...args) => {
      invocation = args;
      return { role: 'assistant', content: 'Hello from Sun2Agent' };
    }
  });
  runtime.config = runtimeConfig();

  await runtime.handleUpdate(messageUpdate('hello'));

  assert.strictEqual(invocation[0], 'nvapi-test');
  assert.strictEqual(invocation[1], 'test-model');
  assert.strictEqual(invocation[3], undefined, 'Telegram must not expose MCP tools');
  assert.strictEqual(typeof invocation[5], 'function', 'Telegram should request streamed model tokens');
  assert.match(invocation[2][0].content, /MCP and terminal tools are unavailable/);
  assert.deepStrictEqual(runtime.histories.get(CHAT_ID).map((item) => item.role), ['user', 'assistant']);
  const responseUpdates = http.calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText');
  assert.strictEqual(responseUpdates[0].data.text, 'Agent is typing ...');
  assert.deepStrictEqual(responseUpdates[0].data.reply_parameters, { message_id: 42 });
  assert.strictEqual(responseUpdates.at(-1).data.text, 'Hello from Sun2Agent');
});

test('Telegram exposes only Tavily web_search and returns results to the model', async () => {
  const http = fakeHttp();
  const calls = [];
  let searchedQuery;
  const searchProvider = {
    getToolSpec: () => ({
      type: 'function',
      function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } }
    }),
    executeTool: async (query) => {
      searchedQuery = query;
      return '[1] Current result\nhttps://example.com\nFresh information';
    }
  };
  const runtime = new TelegramRuntime({
    http,
    searchProvider,
    complete: async (_key, _model, messages, tools, _signal, onToken) => {
      calls.push({ messages, tools });
      if (calls.length === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'search-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"latest Node.js release"}' }
          }]
        };
      }
      onToken('The current Node.js information is available.');
      return { role: 'assistant', content: 'The current Node.js information is available.' };
    }
  });
  runtime.config = {
    ...runtimeConfig(),
    search: { enabled: true, provider: 'tavily', apiKey: 'tvly-test' }
  };

  await runtime.handleUpdate(messageUpdate('What is the latest Node.js release?'));

  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0].tools.map((tool) => tool.function.name), ['web_search']);
  assert.strictEqual(searchedQuery, 'latest Node.js release');
  const toolResult = calls[1].messages.find((item) => item.role === 'tool');
  assert.match(toolResult.content, /Fresh information/);
  const statuses = http.calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => call.data.text);
  assert.ok(statuses.includes('Agent is searching ...'));
  assert.strictEqual(statuses.at(-1), 'The current Node.js information is available.');
});

test('Telegram shows typing before streaming one progressively edited response', async () => {
  const http = fakeHttp();
  const runtime = new TelegramRuntime({
    http,
    complete: async (_key, _model, _messages, _tools, _signal, onToken) => {
      onToken('This is the beginning of a streamed Telegram response. ');
      await new Promise((resolve) => setTimeout(resolve, 10));
      onToken('This is the end.');
      return {
        role: 'assistant',
        content: 'This is the beginning of a streamed Telegram response. This is the end.'
      };
    }
  });
  runtime.config = runtimeConfig();

  await runtime.handleUpdate(messageUpdate('stream this'));

  const methods = http.calls.map((call) => call.method);
  const typingAt = methods.indexOf('sendChatAction');
  const firstMessageAt = methods.indexOf('sendMessage');
  const editAt = methods.indexOf('editMessageText');
  assert.ok(typingAt >= 0 && typingAt < firstMessageAt, 'typing should appear before response text');
  assert.strictEqual(http.calls[firstMessageAt].data.text, 'Agent is typing ...');
  assert.deepStrictEqual(http.calls[firstMessageAt].data.reply_parameters, { message_id: 42 });
  assert.ok(editAt > firstMessageAt, 'the initial response should be edited with later tokens');
  const edits = http.calls.filter((call) => call.method === 'editMessageText');
  assert.strictEqual(edits.at(-1).data.text, 'This is the beginning of a streamed Telegram response. This is the end.');
});

test('Telegram /stop aborts an active model response', async () => {
  const http = fakeHttp();
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const runtime = new TelegramRuntime({
    http,
    complete: async (_key, _model, _messages, _tools, signal) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  runtime.config = runtimeConfig();

  const activeTurn = runtime.handleUpdate(messageUpdate('take your time'));
  await began;
  await runtime.handleUpdate(messageUpdate('/stop'));
  await activeTurn;

  assert.strictEqual(runtime.active.has(CHAT_ID), false);
  const sentOrEdited = http.calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => call.data.text);
  assert.ok(sentOrEdited.some((text) => /stopped/i.test(text)));
  assert.ok(!sentOrEdited.some((text) => /Unable to complete/.test(text)));
});

test('Telegram stops polling after one getUpdates conflict instead of retrying', async () => {
  let updateCalls = 0;
  const errors = [];
  const http = {
    async post(url) {
      const method = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'getMe') {
        return { data: { ok: true, result: { username: 'sun_test_bot' } } };
      }
      if (method === 'getUpdates') {
        updateCalls += 1;
        const error = new Error('Request failed with status code 409');
        error.response = {
          status: 409,
          data: {
            ok: false,
            error_code: 409,
            description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
          }
        };
        throw error;
      }
      throw new Error(`Unexpected Telegram method: ${method}`);
    }
  };
  const runtime = new TelegramRuntime({
    http,
    onError: (error) => errors.push(error.message)
  });

  const status = await runtime.start(runtimeConfig());
  await runtime.pollPromise;

  assert.strictEqual(status.enabled, true);
  assert.strictEqual(updateCalls, 1);
  assert.strictEqual(runtime.running, false);
  assert.deepStrictEqual(errors, [
    'Polling stopped because this bot is already running in another process. Stop the other instance, then restart Sun2Agent.'
  ]);
  await runtime.stop();
});

test('Telegram starts quietly in the CLI while startup failures remain visible', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /✓ Telegram connected/);
  assert.match(source, /Telegram could not start/);
  assert.match(source, /await telegram\.sync\(config\)/);
  assert.match(source, /void syncTelegram\(config\)/);
});

test('Telegram background startup cannot revive polling after stop', async () => {
  let finishGetMe;
  const getMe = new Promise((resolve) => { finishGetMe = resolve; });
  const runtime = new TelegramRuntime({
    http: {
      async post(url) {
        if (url.endsWith('/getMe')) {
          await getMe;
          return { data: { ok: true, result: { username: 'sun_test_bot' } } };
        }
        throw new Error('polling must not start after stop');
      }
    }
  });

  const starting = runtime.start(runtimeConfig());
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  finishGetMe();

  assert.deepStrictEqual(await starting, { enabled: false });
  assert.strictEqual(runtime.running, false);
  assert.strictEqual(runtime.pollPromise, null);
});
