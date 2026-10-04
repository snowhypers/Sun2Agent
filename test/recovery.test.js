const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const mcp = require('../src/core/mcp');
const registry = require('../src/core/mcp/registry');
const { chatTurn, mavenVerificationNotice } = require('../src/cli/turn');
const { resumeAfterModel500 } = require('../src/cli/modelRecovery');

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
