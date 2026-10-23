const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const axios = require('axios');
const { chatCompletion, DEFAULT_NVIDIA_TIMEOUT_MS } = require('../src/core/model/api');

test('api: streams assistant text and returns the complete message', async () => {
  const originalPost = axios.post;
  const seen = [];
  axios.post = async (_url, body) => {
    assert.strictEqual(body.stream, true);
    return {
      data: Readable.from([
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    };
  };
  try {
    const message = await chatCompletion('key', 'model', [], [], undefined, (token) => seen.push(token));
    assert.deepStrictEqual(seen, ['Hel', 'lo']);
    assert.deepStrictEqual(message, { role: 'assistant', content: 'Hello' });
  } finally {
    axios.post = originalPost;
  }
});

test('api: assembles streamed tool-call deltas without emitting them as text', async () => {
  const originalPost = axios.post;
  const seen = [];
  axios.post = async () => ({
    data: Readable.from([
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"p"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":\\"x\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n'
    ])
  });
  try {
    const message = await chatCompletion('key', 'model', [], [{}], undefined, (token) => seen.push(token));
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(message.tool_calls[0].function.name, 'read');
    assert.strictEqual(message.tool_calls[0].function.arguments, '{"path":"x"}');
  } finally {
    axios.post = originalPost;
  }
});

test('api: identifies a provider-aborted stream separately from user cancellation', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({
    data: Readable.from((async function* () {
      throw new Error('aborted');
    })())
  });
  try {
    await assert.rejects(
      chatCompletion('key', 'model', [], [], undefined, () => {}),
      (error) => {
        assert.strictEqual(error.code, 'MODEL_STREAM_INTERRUPTED');
        assert.strictEqual(error.hasPartialOutput, false);
        assert.match(error.message, /Model response stream was interrupted/);
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
  }
});

test('api: applies the default 90-second timeout', async () => {
  const originalPost = axios.post;
  const originalTimeout = process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  const originalGenericTimeout = process.env.SUN2AGENT_MODEL_TIMEOUT_MS;
  delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  delete process.env.SUN2AGENT_MODEL_TIMEOUT_MS;
  let requestOptions;
  axios.post = async (_url, _body, options) => {
    requestOptions = options;
    return { data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
  };
  try {
    await chatCompletion('key', 'model', []);
    assert.strictEqual(DEFAULT_NVIDIA_TIMEOUT_MS, 90000);
    assert.strictEqual(requestOptions.timeout, 90000);
  } finally {
    axios.post = originalPost;
    if (originalTimeout === undefined) delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
    else process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = originalTimeout;
    if (originalGenericTimeout === undefined) delete process.env.SUN2AGENT_MODEL_TIMEOUT_MS;
    else process.env.SUN2AGENT_MODEL_TIMEOUT_MS = originalGenericTimeout;
  }
});

test('api: cancellation settles promptly even if the HTTP adapter ignores abort', async () => {
  const originalPost = axios.post;
  const controller = new AbortController();
  axios.post = () => new Promise(() => {});
  try {
    const request = chatCompletion('key', 'model', [], undefined, controller.signal);
    controller.abort();
    await assert.rejects(request, /abort|cancel/i);
  } finally {
    axios.post = originalPost;
  }
});

test('api: NVIDIA timeout is configurable and returns a clear error', async () => {
  const originalPost = axios.post;
  const originalTimeout = process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = '1250';
  let requestOptions;
  axios.post = async (_url, _body, options) => {
    requestOptions = options;
    const error = new Error('timeout of 1250ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  };
  try {
    await assert.rejects(
      chatCompletion('key', 'model', []),
      /Model did not respond within 1\.3 seconds\. Try again or select another model\./
    );
    assert.strictEqual(requestOptions.timeout, 1250);
  } finally {
    axios.post = originalPost;
    if (originalTimeout === undefined) delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
    else process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = originalTimeout;
  }
});

test('api: generic model timeout overrides the legacy NVIDIA setting', async () => {
  const originalPost = axios.post;
  const oldGeneric = process.env.SUN2AGENT_MODEL_TIMEOUT_MS;
  const oldNvidia = process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  process.env.SUN2AGENT_MODEL_TIMEOUT_MS = '2400';
  process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = '1200';
  let timeout;
  axios.post = async (_url, _body, options) => {
    timeout = options.timeout;
    return { data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
  };
  try {
    await chatCompletion('key', 'model', []);
    assert.strictEqual(timeout, 2400);
  } finally {
    axios.post = originalPost;
    if (oldGeneric === undefined) delete process.env.SUN2AGENT_MODEL_TIMEOUT_MS;
    else process.env.SUN2AGENT_MODEL_TIMEOUT_MS = oldGeneric;
    if (oldNvidia === undefined) delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
    else process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = oldNvidia;
  }
});

test('api: sends requests to a selected OpenAI-compatible endpoint', async () => {
  const originalPost = axios.post;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { choices: [{ message: { role: 'assistant', content: 'custom reply' } }] } };
  };
  try {
    const message = await chatCompletion(
      'custom-key',
      'vendor/model',
      [{ role: 'user', content: 'hello' }],
      undefined,
      undefined,
      undefined,
      { url: 'https://provider.example/v1/chat/completions', provider: 'custom' }
    );
    assert.strictEqual(request.url, 'https://provider.example/v1/chat/completions');
    assert.strictEqual(request.body.model, 'vendor/model');
    assert.strictEqual(request.options.headers.Authorization, 'Bearer custom-key');
    assert.strictEqual(message.content, 'custom reply');
  } finally {
    axios.post = originalPost;
  }
});

test('api: HTTP errors expose safe request metadata, not response text or keys', async () => {
  const originalPost = axios.post;
  const responseBody = Readable.from(['private prompt: secret-value']);
  let destroyed = false;
  const originalDestroy = responseBody.destroy.bind(responseBody);
  responseBody.destroy = () => { destroyed = true; return originalDestroy(); };
  axios.post = async () => {
    const error = new Error('Request failed with status code 500');
    error.response = { status: 500, headers: { 'x-request-id': 'req-123' }, data: responseBody };
    throw error;
  };
  try {
    await assert.rejects(
      chatCompletion('secret-api-key', 'model', [{ role: 'user', content: 'private prompt' }], [{}]),
      (error) => {
        assert.match(error.message, /HTTP 500; 1 messages, 1 tools, \d+ KiB request; request ID req-123/);
        assert.doesNotMatch(error.message, /secret-api-key|private prompt|secret-value/);
        return true;
      }
    );
    assert.strictEqual(destroyed, true);
  } finally { axios.post = originalPost; }
});

test('api: reports structured provider reason without echoing provider text', async () => {
  const originalPost = axios.post;
  axios.post = async () => {
    const error = new Error('bad request');
    error.response = { status: 400, headers: { 'x-request-id': 'req-400' }, data: Readable.from([
      JSON.stringify({ error: { code: 'invalid_request_error', param: 'max_tokens',
        message: 'private prompt and secret-value' } })
    ]) };
    throw error;
  };
  try {
    await assert.rejects(chatCompletion('secret-api-key', 'model', [
      { role: 'user', content: 'private prompt' }
    ], undefined, undefined, () => {}), (error) => {
      assert.match(error.message, /provider: invalid_request_error, parameter max_tokens/);
      assert.match(error.message, /request ID req-400/);
      assert.doesNotMatch(error.message, /secret-api-key|private prompt|secret-value/);
      assert.deepStrictEqual(error.providerError, { code: 'invalid_request_error', param: 'max_tokens' });
      return true;
    });
  } finally { axios.post = originalPost; }
});

test('api: labels HTTP 413 as an oversized request while retaining the provider code', async () => {
  const originalPost = axios.post;
  axios.post = async () => {
    const error = new Error('payload too large');
    error.response = {
      status: 413, headers: { 'x-request-id': 'req-413' },
      data: { error: { code: 'rate_limit_exceeded' } }
    };
    throw error;
  };
  try {
    await assert.rejects(chatCompletion('key', 'model', [{ role: 'user', content: 'hi' }], Array(53).fill({})), (error) => {
      assert.match(error.message, /HTTP 413; 1 messages, 53 tools, \d+ KiB request; request ID req-413; provider: request body too large, rate_limit_exceeded/);
      return true;
    });
  } finally { axios.post = originalPost; }
});
