const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const mcp = require('../src/core/mcp');
const registry = require('../src/core/mcp/registry');
const { chatTurn, mavenVerificationNotice } = require('../src/cli/turn');
const { resumeAfterModel500, isProviderRateLimit, providerRateLimitMessage } = require('../src/cli/runtime/modelRecovery');
const { discardFailedTurn } = require('../src/cli/runtime/history');
const { repairInterruptedTools } = require('../src/core/sessions-management/continue');

afterEach(async () => { await registry.disconnectAll(); });

test('workspace: model HTTP 500 retries once without replaying tools', async () => {
  const originalPost = axios.post;
  registry.set('workspace', {
    builtin: true, type: 'stdio', tools: [], client: { close: async () => {} }
  });
  let requests = 0;
  axios.post = async () => {
    requests++;
    if (requests === 1) {
      const error = new Error('upstream failed');
      error.response = { status: 500, headers: {} };
      throw error;
    }
    return { data: { choices: [{ message: { role: 'assistant', content: 'Recovered.' } }] } };
  };
  try {
    const history = [{ role: 'user', content: 'hello' }];
    assert.strictEqual(await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] }, history), 'Recovered.');
    assert.strictEqual(requests, 2);
  } finally { axios.post = originalPost; }
});

test('workspace: completed tool result is checkpointed before a later model 500', async () => {
  const originalPost = axios.post;
  let toolCalls = 0;
  registry.set('fixture', {
    builtin: false, type: 'stdio',
    tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }],
    client: {
      close: async () => {},
      request: async () => { toolCalls++; return { content: [{ type: 'text', text: 'file contents' }] }; }
    }
  });
  let modelCalls = 0;
  axios.post = async () => {
    modelCalls++;
    if (modelCalls === 1) return { data: { choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function',
        function: { name: 'fixture__read_file', arguments: '{}' } }]
    } }] } };
    const error = new Error('upstream failed');
    error.response = { status: 500, headers: {} };
    throw error;
  };
  const checkpoints = [];
  const history = [{ role: 'user', content: 'read the file' }];
  try {
    await assert.rejects(chatTurn(
      { apiKey: 'test', model: 'test', selectedSkills: [] }, history,
      undefined, undefined, undefined,
      (snapshot) => checkpoints.push(structuredClone(snapshot))
    ), /HTTP 500/);
    assert.strictEqual(toolCalls, 1);
    assert.ok(checkpoints.length >= 2);
    assert.match(checkpoints[0].at(-1).content, /not completed before interruption/i);
    assert.strictEqual(checkpoints.at(-1).at(-1).content, 'file contents');
    assert.strictEqual(history.at(-1).tool_call_id, 'read-1');
  } finally { axios.post = originalPost; }
});

test('workspace: Java tests remain partial until Maven reports passing after the last edit', () => {
  const write = (id) => ({ role: 'assistant', tool_calls: [{ id, function: {
    name: 'workspace__write_file', arguments: '{"path":"src/test/java/UserTest.java"}'
  } }] });
  const run = (id) => ({ role: 'assistant', tool_calls: [{ id, function: {
    name: 'workspace__run_maven_tests', arguments: '{}'
  } }] });
  const history = [{ role: 'user', content: 'write tests' }, write('write-1'),
    { role: 'tool', tool_call_id: 'write-1', content: 'Successfully wrote file' }];
  assert.match(mavenVerificationNotice(history), /partial\/unverified/);
  history.push(run('run-1'), { role: 'tool', tool_call_id: 'run-1', content: 'Maven tests FAILED (exit 1).' });
  assert.match(mavenVerificationNotice(history), /did not pass/);
  history.push(run('run-2'), { role: 'tool', tool_call_id: 'run-2', content: 'Maven tests PASSED.' });
  assert.strictEqual(mavenVerificationNotice(history), '');
  history.push(write('write-2'));
  assert.match(mavenVerificationNotice(history), /partial\/unverified/);
});

test('CLI: resumes once after HTTP 500 without repeating a completed tool', async () => {
  const history = [];
  let runs = 0;
  let toolCalls = 0;
  const result = await resumeAfterModel500(async () => {
    runs++;
    if (!history.length) { toolCalls++; history.push('tool result'); }
    if (runs === 1) throw Object.assign(new Error('unavailable'), { response: { status: 500 } });
    return 'done';
  }, { wait: async () => {} });
  assert.strictEqual(result, 'done');
  assert.strictEqual(runs, 2);
  assert.strictEqual(toolCalls, 1);
});

test('CLI: rate limits show the continue guidance and retain the provider request ID', () => {
  const error = Object.assign(new Error('Model request failed (HTTP 429; request ID req-429; provider: rate_limit_exceeded).'), {
    response: { status: 429 }
  });
  assert.equal(isProviderRateLimit(error), true);
  assert.equal(providerRateLimitMessage(error),
    'Provider rate limit reached. Please wait and click /continue, or switch to a different provider.\nRequest ID: req-429');
  assert.equal(isProviderRateLimit({ providerError: { code: 'rate_limit_exceeded' } }), true);
  assert.equal(isProviderRateLimit({ response: { status: 500 } }), false);
});

test('CLI: does not loop on persistent HTTP 500 or retry validation errors', async () => {
  let attempts = 0;
  await assert.rejects(resumeAfterModel500(async () => {
    attempts++;
    throw Object.assign(new Error('unavailable'), { response: { status: 500 } });
  }, { wait: async () => {} }), /unavailable/);
  assert.strictEqual(attempts, 2);

  attempts = 0;
  await assert.rejects(resumeAfterModel500(async () => {
    attempts++;
    throw Object.assign(new Error('bad request'), { response: { status: 400 } });
  }, { wait: async () => {} }), /bad request/);
  assert.strictEqual(attempts, 1);
});

test('model 400 on another parameter does not disable tools', async () => {
  const originalPost = axios.post;
  registry.set('fixture', { builtin: false, type: 'stdio',
    tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {} } });
  let requests = 0;
  axios.post = async (_url, body) => {
    requests++;
    assert.equal(body.tools.length, 1);
    const error = new Error('bad request');
    error.response = { status: 400, headers: {}, data: {
      error: { code: 'invalid_request_error', param: 'max_tokens' }
    } };
    throw error;
  };
  try {
    await assert.rejects(chatTurn({ apiKey: 'test', model: 'test' }, [
      { role: 'user', content: 'read a file' }
    ]), /parameter max_tokens/);
    assert.equal(requests, 1);
  } finally { axios.post = originalPost; }
});

test('tool-parameter 400 retries without tools and preserves the original error', async () => {
  const originalPost = axios.post;
  registry.set('fixture', { builtin: false, type: 'stdio',
    tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {} } });
  const requests = [];
  axios.post = async (_url, body) => {
    requests.push(body);
    const error = new Error('bad request');
    error.response = { status: 400, headers: {}, data: { error: {
      code: 'unsupported_parameter', param: requests.length === 1 ? 'tools' : 'max_tokens'
    } } };
    throw error;
  };
  try {
    await assert.rejects(chatTurn({ apiKey: 'test', model: 'test' }, [
      { role: 'user', content: 'read a file' }
    ]), (error) => {
      assert.equal(error.providerError.param, 'tools');
      return true;
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.length, 1);
    assert.equal(requests[1].tools, undefined);
  } finally { axios.post = originalPost; }
});

test('failed turns without tool results are removed; completed tool work stays in history', () => {
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'done' },
    { role: 'user', content: 'failed' }];
  discardFailedTurn(history, 2);
  assert.equal(history.length, 2);
  history.push({ role: 'user', content: 'write a file' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'one' }] },
    { role: 'tool', tool_call_id: 'one', content: 'file written' });
  discardFailedTurn(history, 2);
  assert.equal(history.length, 5);
  history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'two' }] });
  discardFailedTurn(history, 5);
  assert.equal(repairInterruptedTools(history), 1);
  assert.match(history.at(-1).content, /Inspect current state before retrying/);
});
