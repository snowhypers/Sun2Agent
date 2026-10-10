'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRemoteServer, isReadOnlyTool } = require('../src/core/mcp/telegramPolicy');

test('Telegram excludes local MCP servers and endpoints', () => {
  assert.equal(isRemoteServer({ type: 'http', url: 'https://mcp.example.com/mcp' }), true);
  assert.equal(isRemoteServer({ type: 'stdio', command: 'npx' }), false);
  for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp',
    'http://192.168.1.8/mcp', 'http://[::1]/mcp', 'http://service.internal/mcp']) {
    assert.equal(isRemoteServer({ type: 'http', url }), false, url);
  }
});

test('Telegram admits remote read tools, not approval-required tools', () => {
  for (const name of ['search', 'tavily_search', 'firecrawl_search', 'list_pages']) {
    assert.equal(isReadOnlyTool({ tool: name, annotations: {} }), true, name);
  }
  for (const name of ['send_message', 'get_and_delete', 'do_anything']) {
    assert.equal(isReadOnlyTool({ tool: name, annotations: { readOnlyHint: true } }), false, name);
  }
  assert.equal(isReadOnlyTool({ tool: 'read_file', annotations: { destructiveHint: true } }), false);
});

test('Telegram remote MCP calls bypass HITL only for an allowed read tool', async () => {
  const config = require('../src/core/mcp/config');
  const registry = require('../src/core/mcp/registry');
  const hitl = require('../src/core/hitl/mcpApproval');
  const originalServers = config.getServers;
  const originalApproval = hitl.checkApproval;
  const modulePath = require.resolve('../src/core/mcp');
  config.getServers = () => [
    { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' },
    { name: 'local', type: 'stdio', command: 'npx' }
  ];
  hitl.checkApproval = () => { throw new Error('HITL must not run in Telegram'); };
  const tools = [
    { name: 'search', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_message', inputSchema: { type: 'object', properties: {} } }
  ];
  registry.set('remote', { type: 'http', builtin: false, tools,
    client: { request: async () => ({ content: [{ type: 'text', text: 'Remote result' }] }) } });
  registry.set('local', { type: 'stdio', builtin: false, tools });
  delete require.cache[modulePath];
  const mcp = require('../src/core/mcp');
  try {
    assert.deepEqual(mcp.getTelegramTools().specs.map((spec) => spec.function.name), ['remote__search']);
    assert.match(await mcp.callTelegramTool('remote__search', {}), /Remote result/);
    await assert.rejects(() => mcp.callTelegramTool('remote__send_message', {}), /unavailable/);
    await assert.rejects(() => mcp.callTelegramTool('local__search', {}), /unavailable/);
  } finally {
    registry.deleteByName('remote');
    registry.deleteByName('local');
    config.getServers = originalServers;
    hitl.checkApproval = originalApproval;
    delete require.cache[modulePath];
  }
});
