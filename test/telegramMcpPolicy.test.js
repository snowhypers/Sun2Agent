'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRemoteServer } = require('../src/core/mcp/telegramPolicy');

test('Telegram excludes local MCP servers and endpoints', () => {
  assert.equal(isRemoteServer({ type: 'http', url: 'https://mcp.example.com/mcp' }), true);
  assert.equal(isRemoteServer({ type: 'stdio', command: 'npx' }), false);
  for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp',
    'http://192.168.1.8/mcp', 'http://[::1]/mcp', 'http://service.internal/mcp']) {
    assert.equal(isRemoteServer({ type: 'http', url }), false, url);
  }
});

test('Telegram exposes only explicitly trusted remote tools without per-call HITL', async () => {
  const config = require('../src/core/mcp/config');
  const registry = require('../src/core/mcp/registry');
  const hitl = require('../src/core/hitl/mcpApproval');
  const originalServers = config.getServers;
  const originalApproval = hitl.checkApproval;
  const modulePath = require.resolve('../src/core/mcp');
  let servers = [
    { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', telegramTools: [] },
    { name: 'local', type: 'stdio', command: 'npx' }
  ];
  config.getServers = () => servers;
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
    assert.deepEqual(mcp.getTelegramTools().specs, []);
    servers[0].telegramTools = ['search', 'send_message'];
    assert.deepEqual(mcp.getTelegramTools().specs.map((spec) => spec.function.name),
      ['remote__search', 'remote__send_message']);
    assert.match(await mcp.callTelegramTool('remote__search', {}), /Remote result/);
    assert.match(await mcp.callTelegramTool('remote__send_message', {}), /Remote result/);
    await assert.rejects(() => mcp.callTelegramTool('local__search', {}), /unavailable/);
  } finally {
    registry.deleteByName('remote');
    registry.deleteByName('local');
    config.getServers = originalServers;
    hitl.checkApproval = originalApproval;
    delete require.cache[modulePath];
  }
});
