// Banner / intro / help panel for the sun2Agent REPL.
//
// Pure rendering functions — no I/O orchestration, no state. The chat loop
// (src/cli/index.js) calls these in sequence at startup.

const chalk = require('chalk');
const boxen = require('boxen');
const stringWidth = require('string-width');
const { version: VERSION } = require('../../../package.json');
const providers = require('../../core/providers');
const { centerToWidth, padToWidth, terminalWidth, truncateToWidth, wrapText } = require('./layout');

function printBanner(config) {
  const sun = chalk.hex('#f5c518'); // bright glow yellow
  const soft = chalk.hex('#b5a642'); // muted yellow
  const activeModel = providers.getActiveModel(config);
  const model = activeModel ? String(activeModel).split('/').pop() : '—';
  const boxWidth = terminalWidth(process.stdout, 100);
  const padding = boxWidth < 32 ? 0 : 1;

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
  const fullModelLine = `Model ${model}`;
  const fullHelpLine = 'Tools: /mcp   ·   /help for commands';
  const preferredContentWidth = Math.max(
    ...art.map((line) => stringWidth(line)),
    stringWidth(welcome),
    stringWidth(fullModelLine),
    stringWidth(fullHelpLine)
  ) + 4;
  const contentWidth = Math.max(1, Math.min(preferredContentWidth, boxWidth - 2 - padding * 2));
  const modelLine = truncateToWidth(fullModelLine, contentWidth);
  const helpLine = truncateToWidth(fullHelpLine, contentWidth);
  const center = (value) => centerToWidth(value, contentWidth);

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
      title: truncateToWidth('☀ sun2Agent', Math.max(1, boxWidth - 4)) +
        (boxWidth >= 28 ? chalk.gray(`  v${VERSION}`) : ''),
      titleAlignment: 'left',
      padding: { top: 0, bottom: 0, left: padding, right: padding },
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
  const width = terminalWidth(process.stdout, 100);
  const lines = wrapText(text, width);

  console.log(lines.map((l) => chalk.white(l)).join('\n') + '\n');
}

// Print the /help panel: all commands + key shortcuts.
function printHelp() {
  const boxWidth = terminalWidth(process.stdout, 100);
  const padding = boxWidth < 32 ? 0 : 1;
  const contentWidth = Math.max(1, boxWidth - 2 - padding * 2);
  const wide = contentWidth >= 58;
  const lines = [];

  const add = (value = '') => lines.push(padToWidth(value, contentWidth));
  const addWrapped = (value, indent = '') => {
    const available = Math.max(1, contentWidth - indent.length);
    for (const line of wrapText(value, available)) add(indent + chalk.gray(line));
  };
  const row = (left, right) => {
    if (!wide) {
      add(chalk.cyan(left));
      addWrapped(right, contentWidth > 4 ? '  ' : '');
      return;
    }
    const leftWidth = 20;
    const descriptionWidth = contentWidth - leftWidth;
    const descriptions = wrapText(right, descriptionWidth);
    descriptions.forEach((description, index) => {
      const command = index === 0 ? left : '';
      add(chalk.cyan(command.padEnd(leftWidth)) + chalk.gray(description));
    });
  };

  add(chalk.yellow.bold('sun2Agent — Help'));
  add();
  add(chalk.bold('Commands'));
  row('/help, /?', 'Show this help');
  row('/config', 'Select NVIDIA or a custom AI provider and model');
  row('/workspace', 'Connect filesystem tools for the current folder');
  row('/browser', 'Connect isolated Playwright browser tools');
  row('/mcp', 'Manage MCP servers (add/edit, connect one, disconnect)');
  row('/agent', 'Edit the project’s AGENT.md instructions in your editor');
  row('/memory', 'Open and edit local memory.md');
  row('/skills', 'Manage reusable instruction skills (skills.md)');
  row('/delete', 'Delete saved config and data');
  row('/exit', 'Quit sun2Agent');
  add();
  add(chalk.bold('Keyboard'));
  row('Enter', 'Send the message');
  row('Esc (with text)', 'Clear what you are typing');
  row('Esc (empty box)', 'Disconnect MCP/browser/workspace or clear skills');
  row('Esc (while busy)', 'Stop the current reply / tool call');
  row('Esc (in menus)', 'Go back / cancel');
  row('Ctrl+C', 'Quit immediately');
  add();
  add(chalk.bold('MCP'));
  addWrapped('/mcp → Connect MCP: pick one server, or Connect all MCPs.');
  addWrapped('One server shows as @name; all servers show as @allMcps.');
  addWrapped('Connected tools are offered to the model automatically — just ask, and the agent picks the right tool.');

  console.log(
    '\n' +
      boxen(lines.join('\n'), {
        padding: { top: padding, bottom: padding, left: padding, right: padding },
        borderStyle: 'round',
        borderColor: 'yellow'
      }) +
      '\n'
  );
}

module.exports = { printBanner, printIntro, printHelp };
