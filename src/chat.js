const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const { MODELS, loadConfig, saveConfig, deleteConfig } = require('./config');
const { chatCompletion } = require('./api');
const { getMcpFilePath, openMcpConfig, loadMcpConfig, getServers } = require('./mcpconfig');
const mcp = require('./mcp');
const { version: VERSION } = require('../package.json');
const guardrails = require('../guardrails');
const context = require('./context');
const observability = require('./observability');
const { askInput, watchEscape, waitEnterOrEsc, ESC_BACK } = require('./inputbox');

// Check whether the Docker sandbox is enabled and Docker has gone down.
// Returns a human-readable warning string, or null if everything is fine.
// Used when MCP tool calls or server connections fail unexpectedly.
// Inside the sandbox container there is no docker CLI, so the check is
// skipped — the process is already isolated.
function dockerDownWarning() {
  if (process.env.SUN2AGENT_SANDBOX === '1') return null;
  try {
    const config = loadConfig();
    if (config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker') {
      const { isDockerRunning } = require('./sandbox');
      if (!isDockerRunning()) {
        return 'Docker sandbox is enabled but Docker is not running. MCP tool calls will fail until Docker is restarted.';
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

// --- Session persistence (Docker outage resume) -----------------------------
//
// The conversation history is saved to ~/.sun2agent/session.json after every
// completed exchange. The file lives in the config dir, which is bind-mounted
// into the sandbox container — so it survives the container dying when the
// Docker engine stops. When the host launcher relaunches the sandbox after
// Docker comes back, it sets SUN2AGENT_RESUME=1 and the agent restores the
// saved messages, continuing exactly where the user was interrupted.

const fs = require('fs');
const path = require('path');
const os = require('os');

function sessionFile() {
  return path.join(os.homedir(), '.sun2agent', 'session.json');
}

function saveSession(history) {
  try {
    const dir = path.dirname(sessionFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify({ savedAt: Date.now(), messages: history }), { mode: 0o600 });
  } catch (_) { /* best effort — resume is a nicety, never a hard failure */ }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8'));
    if (Array.isArray(raw.messages) && raw.messages.length) return raw.messages;
  } catch (_) { /* no session or corrupt file — start fresh */ }
  return null;
}

function clearSession() {
  try { fs.unlinkSync(sessionFile()); } catch (_) { /* already gone */ }
}

// Run an inquirer prompt that the user can cancel with Esc ("back").
// Resolves with the answers object, or null if Esc was pressed.
function promptBack(questions) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let done = false;

    // Text prompts need a visible cursor to type; selection prompts (list /
    // confirm) do not — hiding it for those stops the cursor from blinking on
    // the panel.
    const isTextPrompt = questions.some(
      (q) => q.type === 'input' || q.type === 'password' || q.type === 'editor'
    );
    const hideCursor = stdin.isTTY && !isTextPrompt;

    const finish = (value) => {
      if (done) return;
      done = true;
      if (stdin.isTTY) stdin.removeListener('keypress', onKey);
      if (hideCursor) process.stdout.write('\x1b[?25h'); // restore cursor
      resolve(value);
    };

    function onKey(_str, key) {
      if (key && key.name === 'escape') {
        try {
          run.ui.close();
        } catch (_) {
          /* ignore */
        }
        // inquirer leaves its menu rendered with the cursor at the end of a
        // line; move to a fresh line so the next input box doesn't draw on top
        // of the menu text (which caused a garbled / doubled box).
        process.stdout.write('\n');
        finish(null); // Esc => back
      }
    }

    // Clear any stray keypress listener left behind by a previously-closed
    // inquirer prompt, so it doesn't also react to arrow keys and cause
    // double-navigation / glitchy scrolling in this menu.
    if (stdin.isTTY) stdin.removeAllListeners('keypress');
    if (hideCursor) process.stdout.write('\x1b[?25l'); // hide blinking cursor
    const run = inquirer.prompt(questions);
    if (stdin.isTTY) stdin.on('keypress', onKey);
    run.then((answers) => finish(answers)).catch(() => finish(null));
  });
}

function printBanner(config) {
  const sun = chalk.hex('#f5c518'); // bright glow yellow
  const soft = chalk.hex('#b5a642'); // muted yellow
  const model = config && config.model ? String(config.model).split('/').pop() : '—';

  // ASCII robot: antenna, rounded-square head, hexagon eyes, ">_" mouth,
  // T-shaped side ears and a stand. Lines are fixed 13 wide so the head walls,
  // antenna and stand all line up on the same center column.
  const art = [
    '      o      ',
    '      │      ',
    '  ╭───────╮  ',
    ' ─┤ ⬡   ⬡ ├─ ',
    '  │  >_   │  ',
    '  ╰───────╯  ',
    '      │      ',
    '     ─┴─     '
  ];
  const welcome = 'Welcome back!';
  const modelLine = `Model ${model}`;
  const helpLine = 'Tools: /mcp   ·   /help for commands';
  // Width must cover the LONGEST line (incl. footer) so everything centers.
  const W = Math.max(...art.map((l) => l.length), welcome.length, modelLine.length, helpLine.length) + 4;
  const center = (s) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2));
    return ' '.repeat(pad) + s + ' '.repeat(Math.max(0, W - s.length - pad));
  };

  const body = [
    sun.bold(center(welcome)),
    '',
    ...art.map((l) => sun(center(l))),
    '',
    soft(center(modelLine)),
    chalk.gray(center(helpLine))
  ].join('\n');

  console.log(
    boxen(body, {
      title: '☀️  sun2Agent  ' + chalk.gray('v' + VERSION),
      titleAlignment: 'left',
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: '#f5c518'
    })
  );
}

// One-line self-introduction shown between the banner and the input box.
function printIntro() {
  const text =
    'Hi, I am sun2agent, an AI agent with a native MCP client capable of ' +
    'connecting to any MCP server to automate tasks.';
  const width = Math.max(20, Math.min((process.stdout.columns || 80) - 2, 100));

  // Simple word-wrap to the terminal width.
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);

  console.log(lines.map((l) => chalk.white(l)).join('\n') + '\n');
}

// Print the /help panel: all commands + key shortcuts.
function printHelp() {
  const row = (left, right) =>
    '  ' + chalk.cyan(left.padEnd(18)) + chalk.gray(right);

  const lines = [
    chalk.yellow.bold('sun2Agent — Help'),
    '',
    chalk.bold('Commands'),
    row('/help, /?', 'Show this help'),
    row('/config', 'Set your NVIDIA NIM API key and pick a model'),
    row('/mcp', 'Manage MCP servers (add/edit, connect one, disconnect)'),
    row('/agent', 'Edit the project\u2019s AGENT.md instructions in your editor'),
    row('/delete', 'Delete saved config and data'),
    row('/exit', 'Quit sun2Agent'),
    '',
    chalk.bold('Keyboard'),
    row('Enter', 'Send the message'),
    row('Esc (with text)', 'Clear what you are typing'),
    row('Esc (empty box)', 'Disconnect the active MCP and go back to simple chat'),
    row('Esc (while busy)', 'Stop the current reply / tool call'),
    row('Esc (in menus)', 'Go back / cancel'),
    row('Ctrl+C', 'Quit immediately'),
    '',
    chalk.bold('MCP'),
    chalk.gray('  ') + chalk.cyan('/mcp') + chalk.gray(' → Connect MCP: pick one server, or ') +
      chalk.bold('Connect all MCPs') + chalk.gray('.'),
    chalk.gray('  One server shows as ') + chalk.green('@name') +
      chalk.gray('; all servers show as ') + chalk.green('@allMcps') + chalk.gray('.'),
    chalk.gray('  Connected tools are offered to the model automatically — just ask,'),
    chalk.gray('  and the agent picks the right tool from whichever server has it.')
  ];

  console.log(
    '\n' +
      boxen(lines.join('\n'), {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'yellow'
      }) +
      '\n'
  );
}

// Print the user's submitted message as a transcript line: "› text   HH:MM".
function printUserLine(text) {
  const cols = process.stdout.columns || 80;
  const time = new Date().toTimeString().slice(0, 5); // HH:MM
  const left = '› ' + sanitizeTerminalText(text);
  const pad = Math.max(1, cols - left.length - time.length);
  console.log(chalk.magenta('› ') + sanitizeTerminalText(text) + ' '.repeat(pad) + chalk.gray(time));
}

// Strip ANSI escapes and other control characters before writing untrusted
// text to the terminal. Tool output and model replies can both carry them.
function sanitizeTerminalText(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Handle /config command
async function handleConfig() {
  const config = loadConfig();

  const a1 = await promptBack([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Paste your NVIDIA NIM API key:  ' + chalk.gray('(esc to cancel)'),
      mask: '*',
      default: config.apiKey || undefined
    }
  ]);
  if (!a1) return; // esc -> back

  const a2 = await promptBack([
    {
      type: 'list',
      name: 'model',
      message: 'Select a model:  ' + chalk.gray('(esc to cancel)'),
      choices: MODELS.map((m) => ({
        name: `${m.name}  ${chalk.cyan('[' + m.tag + ']')}`,
        value: m.id
      }))
    }
  ]);
  if (!a2) return; // esc -> back

  // LangSmith observability — optional, off by default. Lives in the existing
  // /config flow right after model selection. Never creates a separate command.
  const a3 = await promptBack([
    {
      type: 'confirm',
      name: 'enableLangSmith',
      message: 'Enable LangSmith observability?  ' + chalk.gray('(esc to skip)'),
      default: false
    }
  ]);

  const newConfig = {
    apiKey: a1.apiKey,
    model: a2.model,
    langsmith: config.langsmith || { enabled: false, project: 'sun2agent' }
  };

  if (!a3) {
    // Esc on the LangSmith prompt: keep whatever was previously configured.
    saveConfig(newConfig);
    console.log(chalk.green('\n✔ Config saved successfully!\n'));
    return;
  }

  if (a3.enableLangSmith) {
    // Ask for the LangSmith API key (masked, never printed back).
    const a4 = await promptBack([
      {
        type: 'password',
        name: 'langsmithApiKey',
        message: 'Paste your LangSmith API key:  ' + chalk.gray('(esc to cancel)'),
        mask: '*'
      }
    ]);
    if (!a4) {
      // Esc while entering the key: save what we have, leave LangSmith off.
      saveConfig(newConfig);
      console.log(chalk.green('\n✔ Config saved successfully!\n'));
      return;
    }
    newConfig.langsmithApiKey = a4.langsmithApiKey;
    newConfig.langsmith = { enabled: true, project: 'sun2agent' };
    // Enable tracing for the current process immediately.
    observability.enable(a4.langsmithApiKey, 'sun2agent');
    console.log(chalk.green('\n✔ NVIDIA API key configured'));
    console.log(chalk.green('✔ Model configured'));
    console.log(chalk.green('✔ LangSmith observability enabled\n'));
    console.log(chalk.gray('Configuration complete.\n'));
  } else {
    newConfig.langsmith = { enabled: false, project: 'sun2agent' };
    observability.disable();
    console.log(chalk.green('\n✔ NVIDIA API key configured'));
    console.log(chalk.green('✔ Model configured'));
    console.log(chalk.green('✔ LangSmith observability: Disabled\n'));
    console.log(chalk.gray('Configuration complete.\n'));
  }

  saveConfig(newConfig);
}

// Handle /delete command
async function handleDelete() {
  const ans = await promptBack([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Delete all config and data?  ' + chalk.gray('(esc to cancel)'),
      default: false
    }
  ]);
  if (!ans) return; // esc -> back
  if (ans.confirm) {
    deleteConfig();
    console.log(chalk.red('\n✔ Config deleted.'));
    console.log(chalk.gray('To fully uninstall run: npm uninstall -g sun2agent\n'));
    process.exit(0);
  }
}

// --- MCP: option 1 -> open mcp.json for adding/editing servers ---
async function mcpAddEdit() {
  const file = getMcpFilePath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'Add servers under "mcpServers". See "_examples" in the file for local (stdio)\n' +
        'and remote (http / sse) formats.\n'
    )
  );
  openMcpConfig();
  // GUI editors return immediately, so wait for the user to finish saving.
  // Enter = done, Esc = back to chat (uses our own reliable key reader).
  const key = await waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved mcp.json, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back to simple chat... ')
  );
  if (key === 'escape') {
    // Esc -> back to simple chat, disconnecting any active MCP server.
    if (mcp.getActiveName()) {
      await mcp.disconnectAll();
      console.log(chalk.gray('\nDisconnected MCP. Back to simple chat.\n'));
    } else {
      console.log(chalk.gray('\nBack to simple chat.\n'));
    }
    return;
  }
  console.log(chalk.green('✔ mcp.json ready. Choose "Connect MCP" to connect.\n'));
}

// Handle /agent command -> open the project's AGENT.md in the user's editor.
// Mirrors how /mcp opens mcp.json: GUI editors return immediately, so we wait
// for Enter (saved) / Esc (back to chat). After a save we reload the cache so
// the next turn picks up the edited instructions.
async function handleAgent() {
  const file = context.getAgentMdPath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'AGENT.md holds repository-specific instructions. They are advisory only and\n' +
        'cannot override Sun2Agent\u2019s core instructions, security policies, or guardrails.\n'
    )
  );
  context.openAgentMd();
  // GUI editors return immediately, so wait for the user to finish saving.
  // Enter = reloaded, Esc = back to chat without reloading.
  const key = await waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved AGENT.md, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back to simple chat... ')
  );
  if (key === 'escape') {
    console.log(chalk.gray('\nBack to simple chat.\n'));
    return;
  }
  // Reload so the next turn uses the freshly edited AGENT.md.
  context.reload();
  console.log(chalk.green('✔ AGENT.md reloaded. Its instructions are now active.\n'));
}

// --- MCP: option 2 -> list servers, pick ONE, connect it, show its tag ---
async function mcpConnect() {
  // Catch a broken mcp.json up front so the user sees *why* nothing loads
  // instead of a misleading "no servers defined" message.
  const cfg = loadMcpConfig();
  if (cfg._parseError) {
    console.log(chalk.red('\n✗ mcp.json is not valid JSON: ') + chalk.yellow(cfg._parseError));
    console.log(chalk.gray(`   File: ${getMcpFilePath()}`));
    console.log(
      chalk.gray('   Fix the JSON (use "Add / Edit MCP") — each server is a flat\n') +
        chalk.gray('   "name": { ... } pair with no extra { } around it.\n')
    );
    return;
  }

  const servers = getServers();
  if (servers.length === 0) {
    console.log(
      chalk.yellow('\nNo servers defined in mcp.json yet. Use "Add / Edit MCP" first.\n')
    );
    return;
  }

  // Which servers are connected right now, and are they ALL connected?
  const connectedNames = new Set(mcp.getConnections().map((c) => c.name));
  const allConnected = servers.length > 1 && connectedNames.size === servers.length;
  const connectedTag = chalk.green('  ● connected');

  // Show the list of available servers and let the user pick one (or all).
  const ans = await promptBack([
    {
      type: 'list',
      name: 'choice',
      message: 'Select an MCP server to chat with:  ' + chalk.gray('(esc to go back)'),
      pageSize: Math.min(servers.length + 4, 15),
      loop: false,
      choices: [
        {
          name:
            chalk.bold('Connect all MCPs') +
            chalk.gray(`  (all ${servers.length} servers together)`) +
            (allConnected ? connectedTag : ''),
          value: '__all__'
        },
        { name: 'Disconnect (chat without any MCP)', value: '__disconnect__' },
        new inquirer.Separator(),
        ...servers.map((s) => ({
          name:
            `${s.name}  ${chalk.gray('[' + s.type + ']')}` +
            (!allConnected && connectedNames.has(s.name) ? connectedTag : ''),
          value: s.name
        }))
      ]
    }
  ]);
  if (!ans) return; // esc -> back to chat
  const choice = ans.choice;

  if (choice === '__disconnect__') {
    await mcp.disconnectAll();
    console.log(chalk.gray('\nDisconnected. No MCP server is active.\n'));
    return;
  }

  // Connect ALL servers at once -> tag becomes @allMcps, all tools available.
  if (choice === '__all__') {
    const spinner = ora('Connecting to all MCP servers...').start();
    const results = await mcp.connectAll();
    spinner.stop();
    console.log(chalk.bold('\nConnecting all MCP servers:\n'));
    let totalTools = 0;
    for (const r of results) {
      if (r.ok) {
        totalTools += r.toolCount;
        console.log(chalk.green('  ✔ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) + chalk.cyan(`${r.toolCount} tool(s)`));
      } else {
        console.log(chalk.red('  ✗ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) + chalk.red('failed: ' + r.error));
      }
    }
    const ok = results.filter((r) => r.ok).length;
    if (ok > 0) {
      console.log(
        chalk.green(`\n✔ Connected ${ok}/${results.length} server(s) as `) +
          chalk.bold('@allMcps') +
          chalk.cyan(` — ${totalTools} tools available.`) +
          chalk.gray('\nJust ask; the agent will pick the right tool from any server.\n')
      );
    } else {
      console.log(chalk.red('\n✗ No servers connected.'));
      // If Docker went down, tell the user clearly instead of leaving them
      // to guess why every stdio server failed.
      const dockerWarn = dockerDownWarning();
      if (dockerWarn) {
        console.log(chalk.red('⛔ ' + dockerWarn));
      }
      console.log();
    }
    return;
  }

  const spinner = ora(`Connecting to ${choice}...`).start();
  let r;
  try {
    r = await mcp.connectSelected(choice);
  } catch (e) {
    spinner.stop();
    console.log(chalk.red('Failed to connect: ' + e.message));
    // If Docker went down, tell the user clearly.
    const dockerWarn = dockerDownWarning();
    if (dockerWarn) {
      console.log(chalk.red('⛔ ' + dockerWarn));
    }
    console.log();
    return;
  }
  spinner.stop();

  if (r.ok) {
    const toolNames = r.tools.map((t) => t.name).join(', ') || '(no tools)';
    console.log(
      chalk.green('\n✔ Connected ') +
        chalk.bold('@' + r.name) +
        chalk.gray(` [${r.type}] `) +
        chalk.cyan(`${r.toolCount} tool(s): `) +
        chalk.gray(toolNames)
    );
    console.log(chalk.gray('You are now chatting with this server. Its tools are available.\n'));
  } else {
    console.log(
      chalk.red('\n✗ ') + chalk.bold(r.name) + chalk.gray(` [${r.type}] `) +
        chalk.red('failed: ' + r.error) + '\n'
    );
  }
}

// Handle /mcp command -> 3-option menu
async function handleMcp() {
  const ans = await promptBack([
    {
      type: 'list',
      name: 'action',
      message: 'MCP servers:  ' + chalk.gray('(esc to go back)'),
      choices: [
        { name: 'Add / Edit MCP  (open mcp.json)', value: 'add' },
        { name: 'Connect MCP  (select a server to chat with)', value: 'connect' },
        { name: 'Not connect  (back to chat)', value: 'back' }
      ]
    }
  ]);
  if (!ans) return; // esc -> back to chat

  if (ans.action === 'add') await mcpAddEdit();
  else if (ans.action === 'connect') await mcpConnect();
  // 'back' just returns to the chat loop
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Current usable terminal width (for one-line, width-aware previews).
function termWidth() {
  return process.stdout.columns || 80;
}

// Build a fresh system prompt each turn so it always reflects the tools that
// are connected right now. This is what actually drives the model to *use*
// the MCP tools instead of guessing.
function buildSystemPrompt(specs) {
  const persona =
    'You are sun2Agent, a helpful assistant running in a terminal. ' +
    'Be concise and accurate.';
  if (!specs.length) return persona;
  const list = specs.map((s) => `- ${s.function.name}: ${s.function.description}`).join('\n');
  return (
    persona +
    '\n\nYou have access to the MCP tools listed below. When the user asks for ' +
    'something one of these tools can do, CALL THE TOOL instead of answering from ' +
    'memory, and base your final reply on the tool result. Ask for any required ' +
    'arguments you are missing. If no tool fits, answer normally.\n\nAvailable tools:\n' +
    list
  );
}

// Run one chat turn, resolving any MCP tool calls the model requests.
// `signal` (optional AbortSignal) lets the user interrupt with Esc.
async function chatTurn(config, history, signal) {
  const { specs, routes } = mcp.getOpenAiTools();
  const tools = specs.length ? specs : undefined;
  // Build the base system prompt (persona + tools) and append AGENT.md
  // repository instructions when present. AGENT.md is advisory context only;
  // it cannot override system instructions or the guardrails, which run on
  // separate code paths.
  const system = { role: 'system', content: context.buildSystemPrompt(buildSystemPrompt(specs)) };
  let allowTools = Boolean(tools);

  // Loop so the model can chain tool calls before its final answer. Browser
  // automation and multi-step tasks need many calls, so allow a generous cap.
  const MAX_TOOL_STEPS = 30;
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (signal && signal.aborted) return null; // interrupted between steps

    // System prompt is prepended per-call and kept out of persistent history.
    const messages = [system, ...history];
    const spinner = ora(chalk.gray('sun2Agent is thinking...  (⎋ esc to stop)')).start();
    let msg;
    try {
      msg = await chatCompletion(
        config.apiKey,
        config.model,
        messages,
        allowTools ? tools : undefined,
        signal
      );
      spinner.stop();
    } catch (e) {
      spinner.stop();
      if (signal && signal.aborted) return null; // aborted request
      const detail = e.response?.data?.detail || e.response?.data?.error?.message || e.message || '';
      // Some models reject the `tools` param — retry once without tools.
      if (allowTools && /tool|function/i.test(String(detail))) {
        console.log(
          chalk.yellow(`  ⚠ model "${config.model}" can't use tools — answering without them.`)
        );
        allowTools = false;
        continue;
      }
      throw e;
    }
    history.push(msg);

    if (allowTools && msg.tool_calls && msg.tool_calls.length) {
      for (const call of msg.tool_calls) {
        if (signal && signal.aborted) return null; // interrupted mid tool loop
        const fnName = call.function.name;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (_) {
          /* leave args empty on malformed JSON */
        }
        // Show the action so the user can see the agent working. Keep it to
        // one line that fits the current terminal width.
        const argRoom = Math.max(16, termWidth() - fnName.length - 8);
        console.log(chalk.magenta(`  ⚙ ${fnName}`) + chalk.gray(`(${truncate(JSON.stringify(args), argRoom)})`));
        let content;
        if (!routes.has(fnName)) {
          // Stale/hallucinated tool (e.g. from a previous MCP server). Tell the
          // model exactly which tools exist now so it retries correctly.
          const available = [...routes.keys()].join(', ') || '(none)';
          content =
            `Tool "${fnName}" does not exist. The only available tools are: ${available}. ` +
            `Call one of those, or answer directly if none fit.`;
          console.log(chalk.red(`     ↳ unknown tool; redirected model to available tools`));
        } else {
          try {
            const raw = await mcp.callTool(routes, fnName, args, signal);
            // Mask secrets before the result reaches the terminal, the
            // history, or the next request to the model.
            content = guardrails.outputGuard(raw);
            if (content !== raw) {
              console.log(chalk.yellow('     ⚠ output guard: secrets masked in tool result'));
            }
            console.log(chalk.gray(`     ↳ ${truncate(sanitizeTerminalText(content), Math.max(20, termWidth() - 8))}`));
          } catch (e) {
            if (signal && signal.aborted) return null;
            content = 'Tool error: ' + e.message;
            console.log(chalk.red(`     ↳ ${sanitizeTerminalText(content)}`));
            // If Docker went down mid-session, warn the user clearly.
            const dockerWarn = dockerDownWarning();
            if (dockerWarn) {
              console.log(chalk.red('  ⛔ ' + dockerWarn));
            }
          }
        }
        history.push({ role: 'tool', tool_call_id: call.id, content });
      }
      continue; // ask the model again now that it has tool results
    }

    return msg.content; // final answer
  }

  // Hit the tool-call cap. Don't dead-end — ask the model once more WITHOUT
  // tools so it must summarize a result from everything it gathered.
  if (signal && signal.aborted) return null;
  const spinner = ora(chalk.gray('wrapping up...')).start();
  try {
    const wrapMessages = [
      system,
      ...history,
      {
        role: 'user',
        content:
          'You have reached the tool-call limit. Based on the results you already ' +
          'gathered above, give me your best final answer now. If the task could ' +
          'not be completed, say clearly what worked and what failed.'
      }
    ];
    const finalMsg = await chatCompletion(config.apiKey, config.model, wrapMessages, undefined, signal);
    spinner.stop();
    return finalMsg.content || '(no final answer produced)';
  } catch (e) {
    spinner.stop();
    if (signal && signal.aborted) return null;
    return 'Reached the tool-call limit and could not summarize: ' + (e.message || e);
  }
}

// Main loop
async function startChat() {
  let config = loadConfig();
  printBanner(config);
  printIntro();

  // If no API key, force config first
  if (!config.apiKey) {
    console.log(chalk.yellow('No API key found. Please run /config first.\n'));
    await handleConfig();
    config = loadConfig();
  }

  // Enable LangSmith tracing for this session if a saved config has it on.
  if (config.langsmith && config.langsmith.enabled && config.langsmithApiKey) {
    observability.enable(config.langsmithApiKey, config.langsmith.project || 'sun2agent');
  }

  // If the Docker sandbox is enabled, Docker MUST be running. Do NOT silently
  // fall back to host execution — fail clearly so the user knows to start
  // Docker (or disable the sandbox) before continuing. This check only runs
  // on the host; inside the sandbox container the env marker is set instead.
  if (process.env.SUN2AGENT_SANDBOX === '1') {
    console.log(chalk.green('🐳 Docker sandbox active — running isolated at /workspace.\n'));
  } else if (config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker') {
    const { isDockerRunning } = require('./sandbox');
    if (!isDockerRunning()) {
      console.log(chalk.red('\nDocker sandbox is enabled, but Docker is not running.'));
      console.log(chalk.gray('\nPlease start Docker Desktop/Engine and run sun2agent again,'));
      console.log(chalk.gray('or run the agent on your host instead: sun2agent sandbox disable\n'));
      process.exit(1);
    }
  }

  const history = [];

  // Relaunch after a Docker outage (the host launcher sets SUN2AGENT_RESUME=1):
  // restore the saved conversation so the session continues where it stopped.
  if (process.env.SUN2AGENT_RESUME === '1') {
    const saved = loadSession();
    if (saved && saved.length) {
      history.push(...saved);
      console.log(chalk.green(`↩ Session restored — continuing your conversation from before the Docker interruption (${saved.length} messages).\n`));
    }
  }

  while (true) {
    const input = await askInput({ model: config.model, tag: mcp.getTag() });

    // Esc on an empty box -> back to simple chat: disconnect MCP, drop the tag.
    if (input === ESC_BACK) {
      if (mcp.getActiveName()) {
        await mcp.disconnectAll();
        console.log(chalk.gray('⎋ Disconnected MCP. Back to simple chat.\n'));
      }
      continue;
    }

    const text = input.trim();
    if (!text) continue;

    // Echo the submitted message as a clean transcript line (the input box
    // itself was erased on submit), with a right-aligned timestamp.
    printUserLine(text);

    // Command handling
    if (text === '/help' || text === '/?') {
      printHelp();
      continue;
    }
    if (text === '/exit') {
      await mcp.disconnectAll();
      clearSession(); // clean exit — nothing to resume next time
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    if (text === '/config') {
      await handleConfig();
      config = loadConfig();
      continue;
    }
    if (text === '/mcp') {
      const before = mcp.getConnectionSignature();
      await handleMcp();
      const after = mcp.getConnectionSignature();
      // If the connected set changed, reset the conversation so the model
      // doesn't keep referencing a previous server's tools from history.
      if (before !== after) {
        history.length = 0;
        const tag = mcp.getTag();
        console.log(chalk.gray('(context reset — now using ' + (tag ? '@' + tag : 'no MCP server') + ')\n'));
      }
      continue;
    }
    if (text === '/agent') {
      await handleAgent();
      continue;
    }
    if (text === '/delete') {
      await handleDelete();
      continue;
    }

    // Screen the prompt before it ever reaches the model.
    const inputVerdict = guardrails.inputGuard(text);
    if (!inputVerdict.ok) {
      console.log(chalk.red('⛔ ' + inputVerdict.reason) + '\n');
      continue;
    }

    // Send to AI (with MCP tools if any are connected).
    // While it works, watch for Esc to abort the request/tool call and drop
    // back to an empty input box.
    history.push({ role: 'user', content: text });

    const controller = new AbortController();
    const stopWatch = watchEscape(() => controller.abort());
    try {
      const reply = await chatTurn(config, history, controller.signal);
      if (controller.signal.aborted) {
        console.log(chalk.gray('⎋ stopped\n'));
      } else {
        console.log(chalk.yellow.bold('sun2Agent: ') + sanitizeTerminalText(reply || '') + '\n');
      }
      // Persist after every completed exchange so an abrupt stop (Docker
      // outage, crash) can resume exactly from here.
      saveSession(history);
    } catch (err) {
      if (controller.signal.aborted) {
        console.log(chalk.gray('⎋ stopped\n'));
      } else {
        const msg = err.response?.data?.detail || err.message;
        console.log(chalk.red('Error: ' + msg + '\n'));
      }
    } finally {
      stopWatch();
    }
  }
}

module.exports = { startChat };
