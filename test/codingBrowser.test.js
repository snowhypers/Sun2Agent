'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const codingBrowser = require('../src/core/coding/browser');
const registry = require('../src/core/mcp/registry');
const mcp = require('../src/core/mcp');
const hitl = require('../src/core/hitl/mcpApproval');

async function loopbackListenerAvailable() {
  const net = require('node:net');
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

afterEach(async () => { await mcp.disconnectAll(); });

test('local Playwright smoke test opens the UI and verifies one todo interaction', async (t) => {
  const playwright = require('playwright');
  if (!fs.existsSync(playwright.chromium.executablePath())) {
    t.skip('Playwright Chromium is not installed; install the pinned browser before running this smoke test');
    return;
  }
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks loopback listeners; run this UI smoke test where localhost networking is enabled');
    return;
  }
  const server = http.createServer((_request, response) => response.end(`<!doctype html>
    <label for="todo">Todo</label><input id="todo"><button id="add">Add todo</button>
    <ul id="items"></ul><script>
      document.querySelector('#add').onclick = () => {
        const input = document.querySelector('#todo');
        const item = document.createElement('li'); item.textContent = input.value;
        document.querySelector('#items').append(item); input.value = '';
      };
    </script>`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('textbox', { name: 'Todo' }).fill('smoke test item');
    await page.getByRole('button', { name: 'Add todo' }).click();
    assert.equal(await page.getByRole('listitem').textContent(), 'smoke test item');
    assert.deepEqual(browserErrors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('coding browser is visible on host and headless in Docker, always isolated', () => {
  const visible = codingBrowser.createServer({ headless: false });
  const sandboxed = codingBrowser.createServer({ headless: true });
  assert.equal(require('../package.json').dependencies['@playwright/mcp'], '0.0.82');
  assert.equal(visible.name, 'coding-browser');
  assert.equal(visible.command, process.execPath);
  assert.match(visible.args[0], /@playwright[/\\]mcp[/\\]cli\.js$/);
  for (const flag of ['--browser', 'chrome', '--isolated', '--no-webmcp']) {
    assert.ok(visible.args.includes(flag));
  }
  assert.ok(!visible.args.includes('--headless'));
  assert.ok(sandboxed.args.includes('--headless'));
  assert.equal(visible.connectTimeoutMs, 20000);
  assert.equal(visible.builtin, true);
  assert.equal(visible.internal, undefined);
});

test('coding browser is private from MCP UI but its tools are available to coding turns', async (t) => {
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks the loopback proxy; run this integration test where localhost networking is enabled');
    return;
  }
  const connected = await codingBrowser.connect(async (server, _signal, options) => {
    registry.set(server.name, {
      client: { close: async () => {} }, transport: {},
      tools: [{ name: 'browser_navigate' }], type: server.type,
      builtin: server.builtin, internal: options.internal
    });
    return [{ name: 'browser_navigate' }];
  });
  assert.equal(connected.ok, true);
  assert.equal(mcp.isCodingBrowserConnected(), true);
  assert.equal(mcp.getTag(), null);
  assert.equal(mcp.getActiveName(), null);
  assert.deepEqual(mcp.getConnections(), []);
  assert.ok(mcp.getOpenAiTools().specs.some((item) =>
    item.function.name === 'coding-browser__browser_navigate'));

  await mcp.disconnectCodingBrowser();
  assert.equal(mcp.isCodingBrowserConnected(), false);
});

test('private browser and project server are cleaned up at the end of a CLI turn', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli/index.js'), 'utf8');
  assert.match(cli, /finally \{[\s\S]*?Promise\.allSettled\([\s\S]*?mcp\.disconnectCodingBrowser\(\)[\s\S]*?mcp\.stopProjectServer\(\)/);
});

test('only local coding-browser actions skip HITL; remote and normal browser actions do not', async () => {
  const originalApproval = hitl.checkApproval;
  let approvals = 0;
  hitl.checkApproval = async () => { approvals++; return false; };
  const fakeClient = { close: async () => {}, request: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
  registry.set('coding-browser', { client: fakeClient, transport: {}, tools: [], type: 'stdio', builtin: true, internal: true });
  registry.set('browser', { client: fakeClient, transport: {}, tools: [], type: 'stdio', builtin: true, internal: false });
  try {
    const local = await mcp.callTool(new Map([['coding-browser__browser_navigate', {
      server: 'coding-browser', tool: 'browser_navigate'
    }]]), 'coding-browser__browser_navigate', { url: 'http://localhost:3000' });
    assert.match(local, /ok/);
    assert.equal(approvals, 0);

    const localNetworkInspection = await mcp.callTool(new Map([['coding-browser__browser_network_requests', {
      server: 'coding-browser', tool: 'browser_network_requests'
    }]]), 'coding-browser__browser_network_requests', {});
    assert.match(localNetworkInspection, /ok/);
    assert.equal(approvals, 0);

    for (const tool of ['browser_network_request']) {
      const result = await mcp.callTool(new Map([[`coding-browser__${tool}`, {
        server: 'coding-browser', tool
      }]]), `coding-browser__${tool}`, {});
      assert.match(result, /outside the safe local coding-browser policy/);
    }
    assert.equal(approvals, 0);

    const codingTest = await mcp.callTool(new Map([['coding-browser__browser_navigate', {
      server: 'coding-browser', tool: 'browser_navigate'
    }]]), 'coding-browser__browser_navigate', { url: 'http://localhost:3000' }, undefined, { codingMode: true });
    assert.match(codingTest, /NOT executed/);
    assert.equal(approvals, 1, 'coding-mode local Playwright uses the explicit test approval');

    const remote = await mcp.callTool(new Map([['coding-browser__browser_navigate', {
      server: 'coding-browser', tool: 'browser_navigate'
    }]]), 'coding-browser__browser_navigate', { url: 'https://example.com' });
    assert.match(remote, /outside the safe local coding-browser policy/);
    assert.equal(approvals, 1);

    const normalBrowser = await mcp.callTool(new Map([['browser__browser_click', {
      server: 'browser', tool: 'browser_click'
    }]]), 'browser__browser_click', {});
    assert.match(normalBrowser, /NOT executed/);
    assert.equal(approvals, 2);
  } finally {
    hitl.checkApproval = originalApproval;
  }
});

test('localAddresses resolves both IPv4 and IPv6 loopback candidates', async () => {
  const getAddrs = (host) => new Promise((resolve) => codingBrowser.localAddresses(host, (_, addrs) => resolve(addrs)));
  
  const localhostAddrs = await getAddrs('localhost');
  assert.ok(localhostAddrs.includes('127.0.0.1'));
  assert.ok(localhostAddrs.includes('::1'));

  const ipv4Addrs = await getAddrs('127.0.0.1');
  assert.equal(ipv4Addrs[0], '127.0.0.1');
  assert.ok(ipv4Addrs.includes('::1'));

  const remote = await getAddrs('example.com');
  assert.deepEqual(remote, []);

  const lan = await getAddrs('192.168.1.1');
  assert.deepEqual(lan, []);
});
