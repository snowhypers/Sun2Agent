'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const providers = require('../src/core/providers');
const { defaultConfig, normalizeProviders } = require('../src/config/appConfig');
const { configureProvider } = require('../src/cli/commands/providerConfig');
const { handleConfig } = require('../src/cli/commands/config');

test('providers: legacy NVIDIA config remains the default', () => {
  const provider = providers.getActiveProvider({ apiKey: 'nvapi-test', model: 'nvidia/test' });
  assert.strictEqual(provider.id, 'nvidia');
  assert.strictEqual(provider.apiKey, 'nvapi-test');
  assert.strictEqual(provider.model, 'nvidia/test');
  assert.match(provider.url, /integrate\.api\.nvidia\.com\/v1\/chat\/completions$/);
  assert.strictEqual(provider.supportsTools, true);
});

test('providers: resolves the selected OpenAI-compatible provider and endpoint', () => {
  const config = {
    ...defaultConfig(),
    activeProvider: 'local-ai',
    providers: [{
      id: 'local-ai',
      name: 'Local AI',
      type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1/',
      apiKey: 'local-key',
      models: ['model-a', 'model-b'],
      activeModel: 'model-b',
      supportsTools: false
    }]
  };
  const provider = providers.getActiveProvider(config);
  assert.deepStrictEqual(provider, {
    id: 'local-ai',
    name: 'Local AI',
    type: 'openai-compatible',
    apiKey: 'local-key',
    model: 'model-b',
    url: 'http://127.0.0.1:1234/v1/chat/completions',
    supportsTools: false
  });
});

test('providers: validates URLs and avoids duplicate reserved IDs', () => {
  assert.strictEqual(providers.openaiCompatible.validateBaseUrl('https://example.com/v1'), true);
  assert.strictEqual(providers.openaiCompatible.validateBaseUrl('http://localhost:8000/v1'), true);
  assert.match(providers.openaiCompatible.validateBaseUrl('file:///tmp/model'), /http/);
  assert.match(providers.openaiCompatible.validateBaseUrl('https://key@example.com/v1'), /credentials/);
  assert.strictEqual(
    providers.openaiCompatible.uniqueId('NVIDIA', [{ id: 'nvidia-2' }]),
    'nvidia-3'
  );
});

test('providers: old and malformed config receives safe provider defaults', () => {
  assert.deepStrictEqual(normalizeProviders(undefined), []);
  assert.deepStrictEqual(normalizeProviders([{ id: 'bad' }]), []);
  assert.deepStrictEqual(normalizeProviders([{
    id: 'custom',
    name: 'Custom',
    baseUrl: 'https://example.com/v1',
    apiKey: 'key',
    models: ['m1', 'm1', 'm2'],
    activeModel: 'missing'
  }]), [{
    id: 'custom',
    name: 'Custom',
    type: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'key',
    models: ['m1', 'm2'],
    activeModel: 'm1',
    supportsTools: true
  }]);
});

test('providers: /config can add and activate a custom provider', async () => {
  const answers = {
    providerChoice: { providerChoice: '__add_provider__' },
    customProviderName: { customProviderName: 'Open Router' },
    customProviderBaseUrl: { customProviderBaseUrl: 'https://openrouter.ai/api/v1/' },
    customProviderApiKey: { customProviderApiKey: 'secret-key' },
    customProviderModel: { customProviderModel: 'vendor/model' },
    customProviderTools: { customProviderTools: true }
  };
  const result = await configureProvider({
    promptBack: async ([question]) => answers[question.name]
  }, defaultConfig());

  assert.strictEqual(result.activeProvider, 'open-router');
  assert.deepStrictEqual(result.providers[0], {
    id: 'open-router',
    name: 'Open Router',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'secret-key',
    models: ['vendor/model'],
    activeModel: 'vendor/model',
    supportsTools: true
  });
});

test('providers: /config can add and select another model for a saved provider', async () => {
  const config = {
    ...defaultConfig(),
    activeProvider: 'custom',
    providers: [{
      id: 'custom', name: 'Custom', type: 'openai-compatible',
      baseUrl: 'https://example.com/v1', apiKey: 'key',
      models: ['model-a'], activeModel: 'model-a', supportsTools: true
    }]
  };
  const answers = {
    providerChoice: { providerChoice: 'custom' },
    customModel: { customModel: '__add_model__' },
    customProviderModel: { customProviderModel: 'model-b' }
  };
  const result = await configureProvider({
    promptBack: async ([question]) => answers[question.name]
  }, config);

  assert.strictEqual(result.activeProvider, 'custom');
  assert.deepStrictEqual(result.providers[0].models, ['model-a', 'model-b']);
  assert.strictEqual(result.providers[0].activeModel, 'model-b');
});

test('providers: full /config saves custom credentials without printing the key', async () => {
  const answers = {
    providerChoice: { providerChoice: '__add_provider__' },
    customProviderName: { customProviderName: 'Example API' },
    customProviderBaseUrl: { customProviderBaseUrl: 'https://api.example.com/v1' },
    customProviderApiKey: { customProviderApiKey: 'never-print-this-key' },
    customProviderModel: { customProviderModel: 'example-model' },
    customProviderTools: { customProviderTools: true },
    enableSearch: { enableSearch: false },
    enableLangSmith: { enableLangSmith: false },
    enableMemory: { enableMemory: false },
    connectTelegram: { connectTelegram: false }
  };
  let saved;
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(String(value));
  try {
    await handleConfig({
      loadConfig: defaultConfig,
      saveConfig: (config) => { saved = config; },
      promptBack: async ([question]) => answers[question.name]
    });
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(saved.activeProvider, 'example-api');
  assert.strictEqual(saved.providers[0].apiKey, 'never-print-this-key');
  assert.strictEqual(providers.getActiveProvider(saved).model, 'example-model');
  assert.doesNotMatch(output.join('\n'), /never-print-this-key/);
  assert.match(output.join('\n'), /Provider: Example API/);
});
