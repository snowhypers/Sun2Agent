const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const axios = require('axios');
const { chatCompletion, DEFAULT_NVIDIA_TIMEOUT_MS } = require('../src/core/api');

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

test('api: applies the default 60-second NVIDIA timeout', async () => {
  const originalPost = axios.post;
  const originalTimeout = process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
  let requestOptions;
  axios.post = async (_url, _body, options) => {
    requestOptions = options;
    return { data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
  };
  try {
    await chatCompletion('key', 'model', []);
    assert.strictEqual(DEFAULT_NVIDIA_TIMEOUT_MS, 60000);
    assert.strictEqual(requestOptions.timeout, 60000);
  } finally {
    axios.post = originalPost;
    if (originalTimeout === undefined) delete process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS;
    else process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS = originalTimeout;
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
