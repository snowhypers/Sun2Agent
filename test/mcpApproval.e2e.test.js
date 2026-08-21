// Integration (e2e) test: HITL + a REAL stdio MCP server through the actual
// execution boundary — src/mcp.js callTool -> guardrails -> hitl gate -> tool.
//
// The interactive panel needs a TTY, so these tests drive the real non-TTY
// gate and patch only the human decision (allow/deny) the way a user would.
// Counters on the fixture server prove denial really prevents execution.
//
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'e2eMcpServer.js');

// Patch the server list DEFINITION before `mcp` loads: mcp.js captures
// `getServers` by destructuring at require time, so this must happen first to
// point it at the local fixture instead of the real ~/.sun2agent/mcp.json.
const mcpconfig = require('../src/mcpconfig');
mcpconfig.getServers = () => [
  { name: 'e2e', type: 'stdio', command: process.execPath, args: [FIXTURE] }
];

const mcp = require('../src/mcp');
const hitl = require('../src/HITL/mcpApproval');

before(async () => {
  const results = await mcp.connectAll();
  const ok = results.find((r) => r.name === 'e2e');
  if (!ok || !ok.ok) {
    throw new Error('fixture MCP server failed to connect: ' + JSON.stringify(results));
  }
});

after(async () => {
  // Restore anything the tests patched.
  await mcp.disconnectAll();
  hitl.startPrompt();
});

async function stats() {
  const routes = mcp.getOpenAiTools().routes;
  const raw = await mcp.callTool(routes, 'e2e__get_stats', {});
  try {
    return JSON.parse(raw.trim());
  } catch (_) {
    return {};
  }
}

test('e2e: a call reaches the real server after an explicit approval', async () => {
  hitl.startPrompt();
  const real = hitl.checkApproval;
  hitl.checkApproval = async () => true;
  try {
  const routes = mcp.getOpenAiTools().routes;
  const out = await mcp.callTool(routes, 'e2e__fast_echo', { text: 'hi' });
  assert.match(out, /fast:hi/);
  } finally {
    hitl.checkApproval = real;
  }
});

test('e2e: a denied call is refused BEFORE it executes on the server', async () => {
  hitl.startPrompt();
  const real = hitl.checkApproval;
  // Simulate a user pressing "Don't allow" for slow_echo and Allow for the
  // independent follow-up call.
  hitl.checkApproval = async (o) => o.tool !== 'slow_echo';
  try {
    const before_ = await stats();
    const routes = mcp.getOpenAiTools().routes;
    const denied = await mcp.callTool(routes, 'e2e__slow_echo', { text: 'boom', delayMs: 50 });
    assert.match(denied, /NOT executed/);
    assert.match(denied, /slow_echo/);
    // The same server stays fully usable for approved calls.
    const ok = await mcp.callTool(routes, 'e2e__fast_echo', { text: 'still-works' });
    assert.match(ok, /fast:still-works/);

    const after_ = await stats();
    assert.strictEqual(after_.slow_echo, before_.slow_echo, 'denied slow_echo must never run');
    assert.ok(after_.fast_echo > before_.fast_echo, 'approved fast_echo ran');
  } finally {
    hitl.checkApproval = real;
  }
});

test('e2e: parallel calls run concurrently, not serially', async () => {
  hitl.startPrompt();
  const real = hitl.checkApproval;
  hitl.checkApproval = async () => true;
  try {
  const routes = mcp.getOpenAiTools().routes;
  const t0 = Date.now();
  const [slow, fast] = await Promise.all([
    mcp.callTool(routes, 'e2e__slow_echo', { text: 's', delayMs: 600 }),
    mcp.callTool(routes, 'e2e__fast_echo', { text: 'f' })
  ]);
  const elapsed = Date.now() - t0;
  assert.match(slow, /slow:s/);
  assert.match(fast, /fast:f/);
  // 600ms slow + 10ms fast in parallel must complete well under the 610ms
  // serial sum (parallel wall-time ≈ max, not sum).
  assert.ok(elapsed < 1000, `expected ~600ms parallel, took ${elapsed}ms`);
  } finally {
    hitl.checkApproval = real;
  }
});

test('e2e: denying one call in a concurrent batch does not block its siblings', async () => {
  hitl.startPrompt();
  const real = hitl.checkApproval;
  hitl.checkApproval = async (o) => o.tool !== 'slow_echo';
  try {
    const routes = mcp.getOpenAiTools().routes;
    const before_ = await stats();
    const [denied, ok1, ok2] = await Promise.all([
      mcp.callTool(routes, 'e2e__slow_echo', { text: 'd', delayMs: 50 }),
      mcp.callTool(routes, 'e2e__fast_echo', { text: 'f1' }),
      mcp.callTool(routes, 'e2e__fast_echo', { text: 'f2' })
    ]);
    assert.match(denied, /NOT executed/);
    assert.match(ok1, /fast:f1/);
    assert.match(ok2, /fast:f2/);

    const after_ = await stats();
    assert.strictEqual(after_.slow_echo, before_.slow_echo, 'denied slow_echo must never run');
    assert.ok(after_.fast_echo >= before_.fast_echo + 2, 'approved siblings ran');
  } finally {
    hitl.checkApproval = real;
  }
});
