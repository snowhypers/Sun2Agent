// Test fixture: a tiny in-repo stdio MCP server used by the HITL e2e tests.
// Provides realistic tool latencies + a stats probe so tests can prove which
// calls actually executed on the server. Not shipped behaviour.
'use strict';

const path = require('path');

// The SDK only exports "./server"; the stdio transport + schemas are internal
// files. Resolve the package root from the exported entry, then require the
// files by absolute path (bypasses the exports-map subpath restriction).
// resolved = <root>/dist/cjs/server/index.js  ->  3 ups get back to <root>.
const sdkRoot = path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/server')), '..', '..', '..');
const { Server } = require(`${sdkRoot}/dist/cjs/server/index.js`);
const { StdioServerTransport } = require(`${sdkRoot}/dist/cjs/server/stdio.js`);
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require(`${sdkRoot}/dist/cjs/types.js`);

const counts = { fast_echo: 0, slow_echo: 0, get_stats: 0 };

const TOOLS = [
  {
    name: 'fast_echo',
    description: 'Echo a string back quickly.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
  },
  {
    name: 'slow_echo',
    description: 'Echo a string back after delayMs (default 400).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        delayMs: { type: 'number' }
      }
    }
  },
  {
    name: 'get_stats',
    description: 'Return invocation counts for every tool on this server.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const server = new Server({ name: 'e2e-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  counts[name] = (counts[name] || 0) + 1;
  if (name === 'fast_echo') {
    await sleep(10);
    return { content: [{ type: 'text', text: `fast:${args.text || ''}` }] };
  }
  if (name === 'slow_echo') {
    const d = Math.min(Math.max(Number(args.delayMs) || 400, 50), 2000);
    await sleep(d);
    return { content: [{ type: 'text', text: `slow:${args.text || ''}` }] };
  }
  if (name === 'get_stats') {
    return { content: [{ type: 'text', text: JSON.stringify(counts) }] };
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

server.connect(new StdioServerTransport());