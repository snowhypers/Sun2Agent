'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const browser = require('../src/core/mcp/browser');
const registry = require('../src/core/mcp/registry');
const mcp = require('../src/core/mcp');

function fakeConnection(name, builtin, tools = []) {
  return {
    client: { close: async () => {} },
    transport: {},
    tools,
    type: 'stdio',
    builtin
  };
}

afterEach(async () => {
  await mcp.disconnectAll();
});

test('browser: uses the exact pinned Playwright MCP in isolated mode', () => {
  const pkg = require('../package.json');
  const definition = mcp.browserServer();

  assert.strictEqual(pkg.dependencies['@playwright/mcp'], '0.0.82');
  assert.strictEqual(definition.name, 'browser');
  assert.strictEqual(definition.command, process.execPath);
  assert.match(definition.args[0], /@playwright[/\\]mcp[/\\]cli\.js$/);
  assert.ok(definition.args.includes('chrome'));
  assert.ok(definition.args.includes('--isolated'));
  assert.ok(definition.args.includes('--no-webmcp'));
  assert.strictEqual(definition.connectTimeoutMs, 30000);
  assert.strictEqual(definition.builtin, true);
  assert.doesNotMatch(definition.args.join(' '), /@latest/);
});

test('browser: lifecycle is independent from workspace and user MCPs', async () => {
  registry.set('workspace', fakeConnection('workspace', true));
  const result = await browser.connect(async (server) => {
    const tools = [{ name: 'browser_navigate' }];
    registry.set(server.name, fakeConnection(server.name, true, tools));
    return tools;
  });
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(mcp.isBrowserConnected(), true);
  assert.strictEqual(mcp.getTag(), 'workspace @browser');

  registry.set('user-fixture', fakeConnection('user-fixture', false));
  assert.strictEqual(mcp.getTag(), 'browser @user-fixture');
  await mcp.disconnectUserServers();
  assert.deepStrictEqual(
    mcp.getConnections().map((item) => item.name),
    ['workspace', 'browser']
  );

  await mcp.disconnectBrowser();
  assert.strictEqual(mcp.isBrowserConnected(), false);
  assert.strictEqual(mcp.isWorkspaceConnected(), true);
  assert.strictEqual(mcp.getTag(), 'workspace');
});

test('browser: reserved name and workspace-only local tools stay isolated', () => {
  assert.strictEqual(browser.isReservedUserServer({ name: 'browser' }), true);
  assert.strictEqual(browser.isReservedUserServer({ name: 'browser', builtin: true }), false);

  const source = fs.readFileSync(path.join(PROJECT, 'src/core/mcp/index.js'), 'utf8');
  assert.match(source, /const localTools = s\.name === workspace\.NAME/);
  assert.doesNotMatch(source, /const localTools = s\.builtin/);
});

test('browser: /browser is opt-in, registered, documented, and confirms access', async () => {
  const cliSource = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf8');
  assert.doesNotMatch(cliSource, /await mcp\.connectBrowser\(\);/);
  assert.match(cliSource, /text === '\/browser'/);
  assert.match(cliSource, /mcp\.disconnectBrowser\(\)/);

  const commands = require('../src/cli/commands');
  assert.strictEqual(commands.COMMANDS['/browser'], commands.handleBrowser);
  const banner = fs.readFileSync(path.join(PROJECT, 'src/cli/ui/banner.js'), 'utf8');
  assert.ok(banner.includes("row('/browser'"));

  const originalConnected = mcp.isBrowserConnected;
  const originalConnect = mcp.connectBrowser;
  const originalLog = console.log;
  const output = [];
  mcp.isBrowserConnected = () => false;
  mcp.connectBrowser = async () => ({ ok: true, tools: [], toolCount: 0 });
  console.log = (line) => output.push(String(line));
  try {
    await commands.handleBrowser();
  } finally {
    mcp.isBrowserConnected = originalConnected;
    mcp.connectBrowser = originalConnect;
    console.log = originalLog;
  }
  assert.match(output.join('\n'), /Connected \/browser plugin/);
  assert.match(output.join('\n'), /isolated browser/);
});

test('browser: connected prompt requires action instead of manual instructions', () => {
  const { buildTurnSystemPrompt } = require('../src/cli/turn');
  const withoutBrowser = buildTurnSystemPrompt(
    { selectedSkills: [] },
    [],
    { workspaceConnected: false, browserConnected: false }
  );
  const withBrowser = buildTurnSystemPrompt(
    { selectedSkills: [] },
    [],
    { workspaceConnected: false, browserConnected: true }
  );

  assert.doesNotMatch(withoutBrowser, /Browser tool rules/);
  assert.match(withBrowser, /use them to take action/);
  assert.match(withBrowser, /instead of claiming you lack access or giving manual instructions/);
  assert.match(withBrowser, /open the sign-in page/);
  assert.match(withBrowser, /human approval check/);
});
