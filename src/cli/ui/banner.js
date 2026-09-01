// Banner / intro / help panel for the sun2Agent REPL.
//
// Pure rendering functions — no I/O orchestration, no state. The chat loop
// (src/cli/index.js) calls these in sequence at startup.

const chalk = require('chalk');
const boxen = require('boxen');
const { version: VERSION } = require('../../../package.json');

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
    row('/agent', 'Edit the project’s AGENT.md instructions in your editor'),
    row('/memory', 'Open and edit local memory.md'),
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

module.exports = { printBanner, printIntro, printHelp };
