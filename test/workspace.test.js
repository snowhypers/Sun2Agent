const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'e2eMcpServer.js');
const originalCwd = process.cwd();
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-workspace-'));

// Load guardrails after changing directory so this disposable folder is the
// process workspace, matching a user who launches Sun2Agent from any folder.
process.chdir(workspaceRoot);
const actualWorkspaceRoot = process.cwd();

const sandbox = require(path.join(PROJECT, 'src/core/sandbox'));
const realWrapStdioCommand = sandbox.wrapStdioCommand;
sandbox.wrapStdioCommand = (command, args) => ({ command, args });

const mcpconfig = require(path.join(PROJECT, 'src/core/mcp/config'));
mcpconfig.getServers = () => [
  { name: 'user-fixture', type: 'stdio', command: process.execPath, args: [FIXTURE] }
];

const mcp = require(path.join(PROJECT, 'src/core/mcp'));
const hitl = require(path.join(PROJECT, 'src/core/hitl/mcpApproval'));

after(async () => {
  await mcp.disconnectAll();
  sandbox.wrapStdioCommand = realWrapStdioCommand;
  process.chdir(originalCwd);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('workspace: bundled MCP creates and reads files in any launch folder', async () => {
  const definition = mcp.workspaceServer();
  assert.strictEqual(definition.command, process.execPath);
  assert.strictEqual(definition.args.at(-1), actualWorkspaceRoot);
  assert.doesNotMatch(definition.args.join(' '), /\bnpx\b/);

    const connected = await mcp.connectWorkspace();
    assert.strictEqual(connected.ok, true, connected.error);
    assert.strictEqual(mcp.getTag(), 'workspace');
  assert.ok(connected.tools.some((tool) => tool.name === 'create_directory'));
  assert.ok(connected.tools.some((tool) => tool.name === 'write_file'));
  assert.ok(connected.tools.some((tool) => tool.name === 'delete_file'));
  assert.ok(connected.tools.some((tool) => tool.name === 'delete_directory'));

  const realApproval = hitl.checkApproval;
  hitl.checkApproval = async () => true;
  try {
    let routes = mcp.getOpenAiTools().routes;
    const folder = path.join(actualWorkspaceRoot, 'created-by-agent');
    const file = path.join(folder, 'hello.txt');

    await mcp.callTool(routes, 'workspace__create_directory', { path: folder });
    await mcp.callTool(routes, 'workspace__write_file', {
      path: file,
      content: 'Hello from Sun2Agent'
    });
    const output = await mcp.callTool(routes, 'workspace__read_text_file', { path: file });

    assert.strictEqual(output.trim(), 'Hello from Sun2Agent');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'Hello from Sun2Agent');

    await mcp.callTool(routes, 'workspace__delete_file', { path: file });
    assert.strictEqual(fs.existsSync(file), false);

    const removable = path.join(actualWorkspaceRoot, 'remove-this-directory');
    fs.mkdirSync(removable);
    fs.writeFileSync(path.join(removable, 'nested.txt'), 'delete me');
    await mcp.callTool(routes, 'workspace__delete_directory', {
      path: removable,
      recursive: true
    });
    assert.strictEqual(fs.existsSync(removable), false);

    const emptyDirectory = path.join(actualWorkspaceRoot, 'empty-directory');
    fs.mkdirSync(emptyDirectory);
    await mcp.callTool(routes, 'workspace__delete_directory', { path: emptyDirectory });
    assert.strictEqual(fs.existsSync(emptyDirectory), false);

    await assert.rejects(
      mcp.callTool(routes, 'workspace__delete_directory', {
        path: actualWorkspaceRoot,
        recursive: true
      }),
      /refusing to delete the workspace root/
    );

    const protectedFile = path.join(actualWorkspaceRoot, '.env');
    fs.writeFileSync(protectedFile, 'SECRET=not-a-real-secret');
    await assert.rejects(
      mcp.callTool(routes, 'workspace__delete_file', { path: protectedFile }),
      /protected credential material/
    );
    assert.strictEqual(fs.existsSync(protectedFile), true);

    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-outside-'));
    try {
      const outsideFile = path.join(outsideDirectory, 'keep.txt');
      fs.writeFileSync(outsideFile, 'keep');
      const linkedDirectory = path.join(actualWorkspaceRoot, 'outside-link');
      fs.symlinkSync(outsideDirectory, linkedDirectory, 'dir');
      await assert.rejects(
        mcp.callTool(routes, 'workspace__delete_file', {
          path: path.join(linkedDirectory, 'keep.txt')
        }),
        /refusing to delete outside the workspace/
      );
      assert.strictEqual(fs.existsSync(outsideFile), true);
    } finally {
      fs.rmSync(outsideDirectory, { recursive: true, force: true });
    }

    const users = await mcp.connectAll();
    assert.strictEqual(users[0].ok, true, users[0].error);
    assert.ok(mcp.getConnections().some((item) => item.name === 'workspace'));
    assert.ok(mcp.getConnections().some((item) => item.name === 'user-fixture'));
    assert.strictEqual(
      mcp.getTag(),
      'user-fixture',
      'the built-in workspace must not make one selected user MCP appear as @allMcps'
    );

    await mcp.disconnectUserServers();
    assert.deepStrictEqual(mcp.getConnections().map((item) => item.name), ['workspace']);

    routes = mcp.getOpenAiTools().routes;
    await assert.rejects(
      mcp.callTool(routes, 'workspace__read_text_file', {
        path: path.join(actualWorkspaceRoot, '..', 'outside-workspace.txt')
      }),
      /outside the project root/
    );

    await mcp.disconnectWorkspace();
    assert.strictEqual(mcp.isWorkspaceConnected(), false);
  } finally {
    hitl.checkApproval = realApproval;
  }
});

test('workspace: package is pinned and Telegram does not receive workspace tools', () => {
  const pkg = require(path.join(PROJECT, 'package.json'));
  assert.strictEqual(pkg.dependencies['@modelcontextprotocol/server-filesystem'], '2026.8.31');

  const telegramTurn = fs.readFileSync(
    path.join(PROJECT, 'src/core/telegram/turn.js'),
    'utf8'
  );
  assert.doesNotMatch(telegramTurn, /connectWorkspace|getOpenAiTools/);
});

test('workspace: refuses to expose the filesystem root', () => {
  const root = path.parse(process.cwd()).root;
  assert.throws(() => mcp.workspaceServer(root), /refusing to expose the filesystem root/);
});

test('workspace: /workspace is opt-in, registered, documented, and confirms access', async () => {
  const cliSource = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf8');
  assert.doesNotMatch(cliSource, /await mcp\.connectWorkspace\(\);/);

  const commands = require(path.join(PROJECT, 'src/cli/commands'));
  assert.strictEqual(commands.COMMANDS['/workspace'], commands.handleWorkspace);

  const banner = fs.readFileSync(path.join(PROJECT, 'src/cli/ui/banner.js'), 'utf8');
  assert.ok(banner.includes("row('/workspace'"));

  const realLog = console.log;
  const output = [];
  if (mcp.isWorkspaceConnected()) await mcp.disconnectWorkspace();
  console.log = (line) => output.push(String(line));
  try {
    await commands.handleWorkspace();
    assert.strictEqual(mcp.isWorkspaceConnected(), true);
  } finally {
    console.log = realLog;
    await mcp.disconnectWorkspace();
  }
  assert.match(output.join('\n'), /Connected \/workspace plugin — agent can access your workspace/);
});

test('workspace: prompt requires direct operations and exact-name deletion', () => {
  const { buildTurnSystemPrompt } = require(path.join(PROJECT, 'src/cli/turn'));
  const withoutWorkspace = buildTurnSystemPrompt(
    { selectedSkills: [] },
    [],
    { workspaceConnected: false }
  );
  const withWorkspace = buildTurnSystemPrompt(
    { selectedSkills: [] },
    [],
    { workspaceConnected: true }
  );

  assert.doesNotMatch(withoutWorkspace, /Workspace tool rules/);
  assert.match(withWorkspace, /fewest direct filesystem calls/);
  assert.match(withWorkspace, /complete requested content/);
  assert.match(withWorkspace, /Never simulate deletion by moving/);
  assert.match(withWorkspace, /similar name does, ask the user to confirm/);
});
