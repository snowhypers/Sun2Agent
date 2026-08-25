const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const axios = require('axios');
const { chatCompletion } = require('../src/api');

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
