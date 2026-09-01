// Tests for the web search feature.
//
// Uses node:test + node:assert — no extra test dependencies.
// Run with: npm test

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// ── helpers ──────────────────────────────────────────────────────────────────

// Stub axios so we never make real HTTP calls.
const axios = require('axios');

function stubPost(fn) {
  const original = axios.post;
  axios.post = fn;
  return () => { axios.post = original; };
}

// ── search/index.js ──────────────────────────────────────────────────────────

const searchModule = require('../src/core/search');

test('search: disabled config → getToolSpec returns null', () => {
  const config = { search: { enabled: false, provider: 'tavily', apiKey: '' } };
  assert.strictEqual(searchModule.getToolSpec(config), null);
});

test('search: enabled config → getToolSpec returns web_search spec', () => {
  const config = { search: { enabled: true, provider: 'tavily', apiKey: 'tvly-test1234' } };
  const spec = searchModule.getToolSpec(config);
  assert.ok(spec, 'spec should be non-null');
  assert.strictEqual(spec.type, 'function');
  assert.strictEqual(spec.function.name, 'web_search');
  assert.ok(spec.function.description.length > 10, 'description should be informative');
  assert.ok(spec.function.parameters.properties.query, 'query parameter must exist');
});

test('search: missing config → getToolSpec returns null', () => {
  assert.strictEqual(searchModule.getToolSpec(null), null);
  assert.strictEqual(searchModule.getToolSpec({}), null);
  assert.strictEqual(searchModule.getToolSpec({ search: {} }), null);
});

test('search: TAVILY_API_KEY env var takes precedence over config key', () => {
  const original = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-env-override';
  const config = { search: { enabled: true, provider: 'tavily', apiKey: 'tvly-config-key' } };
  assert.strictEqual(searchModule.getApiKey(config), 'tvly-env-override');
  if (original === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = original;
});

test('search: config key used when env var is absent', () => {
  const original = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  const config = { search: { enabled: true, provider: 'tavily', apiKey: 'tvly-config-key' } };
  assert.strictEqual(searchModule.getApiKey(config), 'tvly-config-key');
  if (original !== undefined) process.env.TAVILY_API_KEY = original;
});

test('search: maskApiKey masks correctly and never exposes full key', () => {
  const key = 'tvly-abcdefgh12345678';
  const masked = searchModule.maskApiKey(key);
  assert.ok(!masked.includes(key), 'full key must not appear');
  assert.ok(masked.includes('…'), 'masked key should include ellipsis');
  // last 4 chars should be visible
  assert.ok(masked.endsWith(key.slice(-4)), 'last 4 chars should be visible');
});

test('search: maskApiKey handles short / empty keys gracefully', () => {
  assert.strictEqual(searchModule.maskApiKey(''), '(not set)');
  assert.strictEqual(searchModule.maskApiKey(null), '(not set)');
  assert.strictEqual(searchModule.maskApiKey('abc'), '(not set)');
});

// ── search/tavily.js ─────────────────────────────────────────────────────────

const { tavilySearch, MAX_RESULTS, MAX_CONTENT_CHARS } = require('../src/core/search/tavily');

test('tavily: throws safe error when no API key provided', async () => {
  await assert.rejects(
    () => tavilySearch('test query', ''),
    (err) => {
      assert.ok(err.message.includes('Tavily API key'));
      return true;
    }
  );
});

test('tavily: normalizes results and truncates long content', async () => {
  const longContent = 'x'.repeat(MAX_CONTENT_CHARS + 100);
  const restore = stubPost(async () => ({
    data: {
      results: [
        { title: 'Test Title', url: 'https://example.com', content: longContent },
        { title: 'Second', url: 'https://second.com', content: 'Short content' }
      ]
    }
  }));
  try {
    const results = await tavilySearch('test', 'tvly-fakekey12345678');
    assert.strictEqual(results[0].title, 'Test Title');
    assert.strictEqual(results[0].url, 'https://example.com');
    assert.ok(results[0].content.length <= MAX_CONTENT_CHARS + 1, 'content should be truncated'); // +1 for …
    assert.ok(results[0].content.endsWith('…'), 'truncated content should end with ellipsis');
    assert.strictEqual(results[1].content, 'Short content');
  } finally {
    restore();
  }
});

test('tavily: limits results to MAX_RESULTS', async () => {
  const manyResults = Array.from({ length: 10 }, (_, i) => ({
    title: `Result ${i}`, url: `https://example.com/${i}`, content: 'content'
  }));
  const restore = stubPost(async () => ({ data: { results: manyResults } }));
  try {
    const results = await tavilySearch('test', 'tvly-fakekey12345678');
    assert.ok(results.length <= MAX_RESULTS, `should return at most ${MAX_RESULTS} results`);
  } finally {
    restore();
  }
});

test('tavily: throws safe error on HTTP 401', async () => {
  const restore = stubPost(async () => {
    const err = new Error('Request failed');
    err.response = { status: 401 };
    throw err;
  });
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-badkey1234567890'),
      (err) => {
        assert.ok(err.message.includes('invalid'), `expected 'invalid' in: ${err.message}`);
        assert.ok(!err.message.includes('tvly-'), 'API key must not appear in error message');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('tavily: throws safe error on HTTP 429 (rate limit)', async () => {
  const restore = stubPost(async () => {
    const err = new Error('Rate limited');
    err.response = { status: 429 };
    throw err;
  });
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-fakekey12345678'),
      (err) => {
        assert.ok(err.message.includes('rate limit'));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('tavily: throws safe error on generic HTTP error', async () => {
  const restore = stubPost(async () => {
    const err = new Error('Server error');
    err.response = { status: 500 };
    throw err;
  });
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-fakekey12345678'),
      (err) => {
        assert.ok(err.message.includes('HTTP 500'));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('tavily: throws safe error on timeout', async () => {
  const restore = stubPost(async () => {
    const err = new Error('timeout of 10000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  });
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-fakekey12345678'),
      (err) => {
        assert.ok(err.message.includes('timed out'));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('tavily: throws safe error on network failure', async () => {
  const restore = stubPost(async () => {
    throw new Error('ENOTFOUND api.tavily.com');
  });
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-fakekey12345678'),
      (err) => {
        assert.ok(err.message.includes('network error'));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('tavily: throws safe error on malformed response (no results array)', async () => {
  const restore = stubPost(async () => ({ data: { unexpected: true } }));
  try {
    await assert.rejects(
      () => tavilySearch('test', 'tvly-fakekey12345678'),
      (err) => {
        assert.ok(err.message.includes('unexpected response'));
        return true;
      }
    );
  } finally {
    restore();
  }
});

// ── search/searchTool.js — executeTool (does not throw) ───────────────────────

const { executeWebSearch } = require('../src/core/search/searchTool');

test('searchTool: empty query returns safe error string without throwing', async () => {
  const result = await executeWebSearch('', 'tvly-fakekey12345678');
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('empty') || result.includes('Search failed'));
});

test('searchTool: missing API key returns safe error string without throwing', async () => {
  const result = await executeWebSearch('latest Node.js', '');
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('API key') || result.includes('Search failed'));
});

test('searchTool: Tavily error returns safe string without throwing', async () => {
  const restore = stubPost(async () => {
    const err = new Error('Network down');
    throw err;
  });
  try {
    const result = await executeWebSearch('test query', 'tvly-fakekey12345678');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Search failed') || result.includes('network'));
  } finally {
    restore();
  }
});

test('searchTool: API key is never present in formatted results', async () => {
  const fakeKey = 'tvly-secretkey1234567890';
  const restore = stubPost(async () => ({
    data: {
      results: [
        { title: 'Some result', url: 'https://example.com', content: 'Interesting content here' }
      ]
    }
  }));
  try {
    const result = await executeWebSearch('some query', fakeKey);
    assert.ok(!result.includes(fakeKey), 'API key must not appear in results');
  } finally {
    restore();
  }
});

test('searchTool: outputGuard masks secrets appearing in search results', async () => {
  const secretInResult = 'nvapi-' + 'a'.repeat(20);
  const restore = stubPost(async () => ({
    data: {
      results: [
        { title: 'Leaked', url: 'https://example.com', content: `Found key: ${secretInResult}` }
      ]
    }
  }));
  try {
    const result = await executeWebSearch('some query', 'tvly-fakekey12345678');
    assert.ok(!result.includes(secretInResult), 'secrets in results must be masked');
    assert.ok(result.includes('REDACTED'), 'masked result should show REDACTED');
  } finally {
    restore();
  }
});

// ── integration: existing guardrails still work ───────────────────────────────

test('existing guardrails: tavily_search tool call still passes validateToolCall', () => {
  const guardrails = require('../src/core/guardrails');
  const result = guardrails.validateToolCall('web_search', { query: 'latest Node.js version' });
  assert.strictEqual(result.ok, true);
});

test('existing guardrails: destructive args still blocked regardless of tool name', () => {
  const guardrails = require('../src/core/guardrails');
  const result = guardrails.validateToolCall('web_search', { query: 'rm -rf /' });
  assert.strictEqual(result.ok, false);
});
