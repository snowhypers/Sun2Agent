'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getDataDir } = require('../src/core/deployment/dataDir');
const { applyEnvironment } = require('../src/config/appConfig');
const { resolveHeaders } = require('../src/core/mcp/transports');
const { startTelegramService } = require('../src/core/deployment/telegramService');

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('deployment environment overrides runtime credentials without changing stored config', () => {
  withEnv({
    SUN2AGENT_PROVIDER: 'nvidia', SUN2AGENT_MODEL: 'nvidia/test-model',
    SUN2AGENT_API_KEY: 'test-provider-secret',
    SUN2AGENT_TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE',
    SUN2AGENT_TELEGRAM_CHAT_ID: '123456789', TAVILY_API_KEY: 'test-search-secret',
    LANGSMITH_API_KEY: 'test-tracing-secret', LANGSMITH_TRACING: 'true'
  }, () => {
    const config = applyEnvironment({
      activeProvider: 'nvidia', apiKey: 'old-key', model: 'old-model',
      telegram: { enabled: false, botToken: '', chatId: '' },
      search: { enabled: false, apiKey: '' }
    });
    assert.equal(config.apiKey, 'test-provider-secret');
    assert.equal(config.model, 'nvidia/test-model');
    assert.deepEqual(config.telegram, {
      enabled: true,
      botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDE',
      chatId: '123456789'
    });
    assert.equal(config.search.enabled, true);
    assert.equal(config.search.apiKey, 'test-search-secret');
    assert.equal(config.langsmith.enabled, true);
    assert.equal(config.langsmithApiKey, 'test-tracing-secret');
  });
});

test('custom data directory is used when configured', () => {
  withEnv({ SUN2AGENT_DATA_DIR: '/tmp/sun2agent-deployment-test' }, () => {
    assert.equal(getDataDir(), '/tmp/sun2agent-deployment-test');
  });
});

test('remote MCP headers resolve secret references and reject missing ones safely', () => {
  withEnv({ DEPLOY_MCP_TOKEN: 'secret-value' }, () => {
    assert.deepEqual(resolveHeaders({ Authorization: 'Bearer ${DEPLOY_MCP_TOKEN}' }), {
      Authorization: 'Bearer secret-value'
    });
  });
  withEnv({ MISSING_DEPLOY_MCP_TOKEN: undefined }, () => {
    assert.throws(() => resolveHeaders({ Authorization: 'Bearer ${MISSING_DEPLOY_MCP_TOKEN}' }),
      /MISSING_DEPLOY_MCP_TOKEN/);
  });
});

test('Telegram service fails fast with a clear error when model credentials are missing', async () => {
  await assert.rejects(startTelegramService({
    activeProvider: 'nvidia', apiKey: '', model: 'nvidia/test-model', providers: []
  }), /Model credentials are missing/);
});

test('service fails when Telegram polling ends unexpectedly', async () => {
  const telegram = require('../src/core/telegram');
  const mcp = require('../src/core/mcp');
  const runner = require('../src/core/schedule/runner');
  const originals = {
    sync: telegram.sync, stop: telegram.stop, pollingStopped: telegram.pollingStopped,
    connect: mcp.connectRemoteFromConfig, disconnect: mcp.disconnectAll, start: runner.start
  };
  const oldExitCode = process.exitCode;
  const oldError = console.error;
  let endPolling;
  let stopped = false;
  telegram.sync = async () => ({ enabled: true });
  telegram.stop = async () => { stopped = true; };
  telegram.pollingStopped = () => new Promise((resolve) => { endPolling = resolve; });
  mcp.connectRemoteFromConfig = async () => [];
  mcp.disconnectAll = async () => {};
  runner.start = () => ({ stop() {} });
  console.error = () => {};
  try {
    await startTelegramService({
      activeProvider: 'nvidia', apiKey: 'test-key', model: 'nvidia/test-model',
      providers: [], telegram: { enabled: true,
        botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '123456789' }
    });
    endPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, true);
    assert.equal(process.exitCode, 1);
  } finally {
    telegram.sync = originals.sync;
    telegram.stop = originals.stop;
    telegram.pollingStopped = originals.pollingStopped;
    mcp.connectRemoteFromConfig = originals.connect;
    mcp.disconnectAll = originals.disconnect;
    runner.start = originals.start;
    process.exitCode = oldExitCode;
    console.error = oldError;
  }
});
