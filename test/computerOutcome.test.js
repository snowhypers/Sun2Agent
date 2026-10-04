const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Readable } = require('node:stream');
const hitl = require('../src/core/hitl/mcpApproval');
const mcp = require('../src/core/mcp');
const registry = require('../src/core/mcp/registry');
const { chatTurn } = require('../src/cli/turn');
const { resumeAfterModel500 } = require('../src/cli/modelRecovery');
const { pendingComputerOutcome } = require('../src/core/computer/outcome');

afterEach(async () => { await registry.disconnectAll(); hitl._resetForTesting(); });

const call = (id, tool, args = {}) => ({ id, type: 'function', function: {
  name: `computer__${tool}`, arguments: JSON.stringify(args)
} });
const assistant = (toolCall) => ({ role: 'assistant', content: '', tool_calls: [toolCall] });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });

test('computer outcome: a click remains unverified even after a generic snapshot', () => {
  const history = [
    { role: 'user', content: 'take a photo' },
    assistant(call('click', 'click_element', { label: 'take photo' })),
    result('click', 'Clicked AXButton "take photo"'),
    assistant(call('shot', 'snapshot', { target_window_id: 42 })),
    result('shot', 'Frontmost: com.apple.Terminal')
  ];
  assert.deepEqual(pendingComputerOutcome(history), {
    tool: 'click_element', bundleId: undefined, checked: true, failed: false
  });
});

test('computer outcome: a matching ready window verifies opening an app', () => {
  const history = [
    { role: 'user', content: 'open the app' },
    assistant(call('open', 'open_application', { bundle_id: 'com.example.App' })),
    result('open', 'Opened com.example.App'),
    assistant(call('wait', 'sun2agent_wait_for_window', { bundle_id: 'com.example.App' })),
    result('wait', 'Window ready for com.example.App: [{"id":42}]')
  ];
  assert.equal(pendingComputerOutcome(history), null);
});

test('computer outcome: a later verified app opening does not erase an earlier unverified click', () => {
  const history = [
    { role: 'user', content: 'take a photo, then open the editor' },
    assistant(call('click', 'click_element', { label: 'take photo' })),
    result('click', 'Clicked AXButton "take photo"'),
    assistant(call('open', 'open_application', { bundle_id: 'com.example.Editor' })),
    result('open', 'Opened com.example.Editor'),
    assistant(call('wait', 'sun2agent_wait_for_window', { bundle_id: 'com.example.Editor' })),
    result('wait', 'Window ready for com.example.Editor: [{"id":42}]')
  ];
  assert.equal(pendingComputerOutcome(history).tool, 'click_element');
});

test('MCP isError is surfaced as a tool failure, not successful text', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  registry.set('computer', { builtin: true, type: 'stdio', tools: [],
    client: { close: async () => {}, request: async () => ({
      isError: true, content: [{ type: 'text', text: 'Camera access denied' }]
    }) }
  });
  const routes = new Map([['computer__click_element', { server: 'computer', tool: 'click_element' }]]);
  await assert.rejects(mcp.callTool(routes, 'computer__click_element', {}), /Camera access denied/);
});

test('computer turn: a click plus snapshot cannot become a false success claim', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  let toolCalls = 0;
  registry.set('computer', { builtin: true, type: 'stdio', tools: [
    { name: 'click_element', inputSchema: { type: 'object', properties: {} } },
    { name: 'snapshot', inputSchema: { type: 'object', properties: {} } }
  ], client: { close: async () => {}, request: async (request) => {
    toolCalls++;
    return { content: [{ type: 'text', text: request.params.name === 'click_element'
      ? 'Clicked AXButton "take photo"' : 'Frontmost: com.apple.Terminal' }] };
  } } });
  let modelCalls = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    modelCalls++;
    if (modelCalls > 1) assert.equal(body.stream, false, 'unverified actions must not stream a success claim');
    if (body.stream) return { data: Readable.from([
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'click', type: 'function', function: {
          name: 'computer__click_element', arguments: '{"label":"take photo"}'
        }
      }] } }] })}\n\n`
    ]) };
    const message = modelCalls === 1 ? assistant(call('click', 'click_element', { label: 'take photo' }))
      : modelCalls === 2 ? assistant(call('shot', 'snapshot', {}))
        : { role: 'assistant', content: 'The photo was captured!' };
    return { data: { choices: [{ message }] } };
  });
  const history = [{ role: 'user', content: 'take a photo' }];
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    history, undefined, () => assert.fail('unverified success must not stream'));
  assert.match(reply, /not verified/i);
  assert.doesNotMatch(reply, /was captured/i);
  assert.equal(history.at(-1).content, reply, 'the saved answer must not preserve the false claim');
  assert.equal(toolCalls, 2, 'the click was not replayed');
});

test('computer turn: no post-action check triggers one nudge, never a duplicate click', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  let toolCalls = 0;
  registry.set('computer', { builtin: true, type: 'stdio',
    tools: [{ name: 'click_element', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {}, request: async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: 'Clicked button' }] };
    } }
  });
  let requests = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    requests++;
    if (requests === 3) assert.match(body.messages[0].content, /inspect the current app state once/);
    const message = requests === 1 ? assistant(call('click', 'click_element'))
      : { role: 'assistant', content: 'Done!' };
    return { data: { choices: [{ message }] } };
  });
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'press the button and check the result' }]);
  assert.match(reply, /not verified/i);
  assert.equal(requests, 3);
  assert.equal(toolCalls, 1);
});

test('computer turn: model recovery preserves the unverified action without replaying it', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  let toolCalls = 0;
  registry.set('computer', { builtin: true, type: 'stdio',
    tools: [{ name: 'click_element', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {}, request: async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: 'Clicked button' }] };
    } }
  });
  let requests = 0;
  t.mock.method(axios, 'post', async () => {
    requests++;
    if (requests === 1) return { data: { choices: [{ message: assistant(call('click', 'click_element')) }] } };
    if (requests === 2 || requests === 3) throw Object.assign(new Error('unavailable'), {
      response: { status: 500, headers: { 'retry-after': '0' } }
    });
    return { data: { choices: [{ message: { role: 'assistant', content: 'Done!' } }] } };
  });
  const history = [{ role: 'user', content: 'press the button' }];
  const reply = await resumeAfterModel500(
    () => chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] }, history),
    { wait: async () => {} }
  );
  assert.match(reply, /not verified/i);
  assert.equal(toolCalls, 1);
  assert.equal(history.at(-1).content, reply);
});
