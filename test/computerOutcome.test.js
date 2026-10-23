const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Readable } = require('node:stream');
const hitl = require('../src/core/hitl/mcpApproval');
const mcp = require('../src/core/mcp');
const registry = require('../src/core/mcp/registry');
const { chatTurn } = require('../src/cli/turn');
const { resumeAfterModel500 } = require('../src/cli/runtime/modelRecovery');
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
    tool: 'click_element', bundleId: undefined, checked: false, failed: false
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

test('computer outcome: verified window activation does not hide an unverified photo click', () => {
  const history = [
    { role: 'user', content: 'open desktop Photo Booth and click a photo' },
    assistant(call('open', 'open_application', { bundle_id: 'com.apple.PhotoBooth' })),
    result('open', 'Opened com.apple.PhotoBooth (activated: false)'),
    assistant(call('wait', 'sun2agent_wait_for_window', { bundle_id: 'com.apple.PhotoBooth' })),
    result('wait', 'Window ready for com.apple.PhotoBooth: [{"id":42}]'),
    assistant(call('activate', 'activate_window', { window_id: 42 })),
    result('activate', '{"windowId":42,"activated":true,"frontmostAfter":"com.apple.PhotoBooth"}'),
    assistant(call('find', 'find_element', { window_id: 42, role: 'AXButton' })),
    result('find', '[{"label":"take photo"}]'),
    assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' })),
    result('click', 'Clicked AXButton "take photo"')
  ];
  assert.deepEqual(pendingComputerOutcome(history), {
    tool: 'click_element', bundleId: undefined, checked: false, failed: false, windowId: 42
  });
});

test('computer outcome: unchanged target window cannot verify a photo click', () => {
  const history = [
    { role: 'user', content: 'take a photo' },
    assistant(call('before', 'get_ui_tree', { window_id: 42 })),
    result('before', '{"children":[{"label":"take photo"}]}'),
    assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' })),
    result('click', 'Clicked AXButton "take photo"'),
    assistant(call('after', 'get_ui_tree', { window_id: 42 })),
    result('after', '{"children":[{"label":"take photo"}]}')
  ];
  assert.equal(pendingComputerOutcome(history).checked, false);
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

test('computer click refocuses after approval and before the action', async (t) => {
  const events = [];
  t.mock.method(hitl, 'checkApproval', async () => { events.push('approve'); return true; });
  registry.set('computer', { builtin: true, type: 'stdio', tools: [], client: {
    close: async () => {}, request: async (request) => {
      events.push(request.params.name);
      return { content: [{ type: 'text', text: request.params.name === 'activate_window'
        ? '{"activated":true}' : 'Clicked AXButton "take photo"' }] };
    }
  } });
  const routes = new Map([['computer__click_element', { server: 'computer', tool: 'click_element' }]]);
  await mcp.callTool(routes, 'computer__click_element', { window_id: 42, label: 'take photo' });
  assert.deepEqual(events, ['approve', 'activate_window', 'click_element']);
});

test('computer click stops when post-approval focus fails', async (t) => {
  const events = [];
  t.mock.method(hitl, 'checkApproval', async () => { events.push('approve'); return true; });
  registry.set('computer', { builtin: true, type: 'stdio', tools: [], client: {
    close: async () => {}, request: async (request) => {
      events.push(request.params.name);
      return { content: [{ type: 'text', text: '{"activated":false}' }] };
    }
  } });
  const routes = new Map([['computer__click_element', { server: 'computer', tool: 'click_element' }]]);
  await assert.rejects(mcp.callTool(routes, 'computer__click_element',
    { window_id: 42, label: 'take photo' }), /could not be activated/i);
  assert.deepEqual(events, ['approve', 'activate_window']);
});

test('computer turn stops after a failed focus instead of trying more actions', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  const toolsRun = [];
  registry.set('computer', { builtin: true, type: 'stdio', tools: [
    { name: 'click_element', inputSchema: { type: 'object', properties: {} } }
  ], client: { close: async () => {}, request: async (request) => {
    toolsRun.push(request.params.name);
    return { content: [{ type: 'text', text: '{"activated":false}' }] };
  } } });
  let modelCalls = 0;
  t.mock.method(axios, 'post', async () => {
    modelCalls++;
    return { data: { choices: [{ message:
      assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' })) }] } };
  });
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'click a photo in Photo Booth' }]);
  assert.match(reply, /window could not be activated.*click was not attempted/i);
  assert.deepEqual(toolsRun, ['activate_window']);
  assert.equal(modelCalls, 1);
});

test('computer turn: explicit desktop request does not offer browser MCP tools', async (t) => {
  registry.set('computer', { builtin: true, type: 'stdio',
    tools: [{ name: 'open_application', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {} } });
  registry.set('microsoft_playwright-mcp', { builtin: false, type: 'stdio',
    tools: [{ name: 'browser_navigate', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {} } });
  t.mock.method(axios, 'post', async (_url, body) => {
    const names = body.tools.map((tool) => tool.function.name);
    assert.ok(names.includes('computer__open_application'));
    assert.ok(!names.includes('microsoft_playwright-mcp__browser_navigate'));
    return { data: { choices: [{ message: { role: 'assistant', content: 'Need app access.' } }] } };
  });
  await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'open my destop WhatsApp' }]);
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

test('computer turn: photo click checks its target window once before answering', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  const toolsRun = [];
  registry.set('computer', { builtin: true, type: 'stdio', tools: [
    { name: 'click_element', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_ui_tree', inputSchema: { type: 'object', properties: {} } }
  ], client: { close: async () => {}, request: async (request) => {
    toolsRun.push(request.params);
    const text = request.params.name === 'activate_window' ? '{"activated":true}'
      : request.params.name === 'click_element' ? 'Clicked AXButton "take photo"'
        : '{"window_id":42,"children":[{"role":"image","label":"New photo thumbnail"}]}';
    return { content: [{ type: 'text', text }] };
  } } });
  let modelCalls = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    modelCalls++;
    if (modelCalls === 1) return { data: { choices: [{ message:
      assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' })) }] } };
    if (modelCalls === 2) return { data: { choices: [{ message: { role: 'assistant', content: 'Done!' } }] } };
    assert.match(JSON.stringify(body.messages), /New photo thumbnail/);
    return { data: { choices: [{ message: { role: 'assistant', content: 'A new photo thumbnail is visible in Photo Booth.' } }] } };
  });
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'take a photo in Photo Booth' },
      assistant(call('before', 'get_ui_tree', { window_id: 42 })),
      result('before', '{"window_id":42,"children":[{"label":"take photo"}]}')]);
  assert.match(reply, /new photo thumbnail is visible/i);
  assert.deepEqual(toolsRun.map((item) => item.name), ['activate_window', 'click_element', 'get_ui_tree']);
  assert.deepEqual(toolsRun[2].arguments, { window_id: 42 });
});

test('computer turn: failed post-click inspection stays unverified without another click', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  const toolsRun = [];
  registry.set('computer', { builtin: true, type: 'stdio', tools: [
    { name: 'click_element', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_ui_tree', inputSchema: { type: 'object', properties: {} } }
  ], client: { close: async () => {}, request: async (request) => {
    toolsRun.push(request.params.name);
    if (request.params.name === 'activate_window') return { content: [{ type: 'text', text: '{"activated":true}' }] };
    if (request.params.name === 'get_ui_tree') throw new Error('Window inspection timed out');
    return { content: [{ type: 'text', text: 'Clicked AXButton "take photo"' }] };
  } } });
  let modelCalls = 0;
  t.mock.method(axios, 'post', async () => {
    modelCalls++;
    const message = modelCalls === 1
      ? assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' }))
      : { role: 'assistant', content: 'Photo captured!' };
    return { data: { choices: [{ message }] } };
  });
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'take a photo in Photo Booth' }]);
  assert.match(reply, /not verified/i);
  assert.deepEqual(toolsRun, ['activate_window', 'click_element', 'get_ui_tree']);
});

test('computer turn: activates the target window before clicking', async (t) => {
  t.mock.method(hitl, 'checkApproval', async () => true);
  const toolsRun = [];
  registry.set('computer', { builtin: true, type: 'stdio', tools: [
    { name: 'activate_window', inputSchema: { type: 'object', properties: {} } },
    { name: 'click_element', inputSchema: { type: 'object', properties: {} } }
  ], client: { close: async () => {}, request: async (request) => {
    toolsRun.push(request.params.name);
    return { content: [{ type: 'text', text: request.params.name === 'activate_window'
      ? '{"activated":true}' : 'Clicked AXButton "take photo"' }] };
  } } });
  let modelCalls = 0;
  t.mock.method(axios, 'post', async () => ({ data: { choices: [{ message: ++modelCalls === 1
    ? assistant(call('click', 'click_element', { window_id: 42, label: 'take photo' }))
    : { role: 'assistant', content: 'Done' } }] } }));
  await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] },
    [{ role: 'user', content: 'click a photo in Photo Booth' }]);
  assert.deepEqual(toolsRun, ['activate_window', 'click_element']);
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
