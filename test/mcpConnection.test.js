'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HANGING_SERVER = path.join(__dirname, 'fixtures', 'hangingMcpServer.js');

test('MCP connect-all times out independent servers in parallel', async () => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-mcp-parallel-'));
  const markerOne = path.join(markerDir, 'one');
  const markerTwo = path.join(markerDir, 'two');
  const config = require('../src/core/mcp/config');
  const originalGetServers = config.getServers;
  config.getServers = () => [
    { name: 'slow-one', type: 'stdio', command: process.execPath, args: [HANGING_SERVER, markerOne], connectTimeoutMs: 300 },
    { name: 'slow-two', type: 'stdio', command: process.execPath, args: [HANGING_SERVER, markerTwo], connectTimeoutMs: 300 }
  ];

  const modulePath = require.resolve('../src/core/mcp');
  delete require.cache[modulePath];
  const mcp = require('../src/core/mcp');
  await require('../src/core/mcp/transports').loadSdk();
  const started = Date.now();
  try {
    const results = await mcp.connectAll();
    const elapsed = Date.now() - started;
    assert.deepStrictEqual(results.map((item) => item.name), ['slow-one', 'slow-two']);
    assert.ok(results.every((item) => item.ok === false));
    assert.ok(results.every((item) => /timed out after 300ms/.test(item.error)));
    const startedApart = Math.abs(
      Number(fs.readFileSync(markerOne, 'utf8')) - Number(fs.readFileSync(markerTwo, 'utf8'))
    );
    assert.ok(startedApart < 275, `connections started ${startedApart}ms apart instead of in parallel`);
    assert.ok(elapsed < 3500, `timeout cleanup took unexpectedly long: ${elapsed}ms`);
  } finally {
    await mcp.disconnectAll();
    config.getServers = originalGetServers;
    delete require.cache[modulePath];
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});
