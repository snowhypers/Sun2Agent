const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const { MODELS, loadConfig, saveConfig, deleteConfig } = require('./config');
const { chatCompletion } = require('./api');
const { getMcpFilePath, openMcpConfig, loadMcpConfig, getServers } = require('./mcpconfig');
const mcp = require('./mcp');
const { askInput, watchEscape, waitEnterOrEsc, ESC_BACK } = require('./inputbox');

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
      title: '☀️  sun2Agent  ' + chalk.gray('v1.0.0'),
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
  const left = '› ' + text;
  const pad = Math.max(1, cols - left.length - time.length);
  console.log(chalk.magenta('› ') + text + ' '.repeat(pad) + chalk.gray(time));
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

  saveConfig({ apiKey: a1.apiKey, model: a2.model });
  console.log(chalk.green('\n✔ Config saved successfully!\n'));
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
      console.log(chalk.red('\n✗ No servers connected.\n'));
    }
    return;
  }

  const spinner = ora(`Connecting to ${choice}...`).start();
  let r;
  try {
    r = await mcp.connectSelected(choice);
  } catch (e) {
    spinner.stop();
    console.log(chalk.red('Failed to connect: ' + e.message + '\n'));
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
  const system = { role: 'system', content: buildSystemPrompt(specs) };
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
            content = await mcp.callTool(routes, fnName, args, signal);
            console.log(chalk.gray(`     ↳ ${truncate(content, Math.max(20, termWidth() - 8))}`));
          } catch (e) {
            if (signal && signal.aborted) return null;
            content = 'Tool error: ' + e.message;
            console.log(chalk.red(`     ↳ ${content}`));
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

  const history = [];

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
    if (text === '/delete') {
      await handleDelete();
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
        console.log(chalk.yellow.bold('sun2Agent: ') + (reply || '') + '\n');
      }
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
