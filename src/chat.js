const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const { MODELS, loadConfig, saveConfig, deleteConfig } = require('./config');
const { askAI } = require('./api');

function printBanner() {
  console.log(
    boxen(chalk.yellow.bold('☀️  sun2Agent') + chalk.gray('\nTerminal AI Chat'), {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'yellow'
    })
  );
  console.log(chalk.gray('Commands: /config  /delete  /exit\n'));
}

// Handle /config command
async function handleConfig() {
  const config = loadConfig();

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Paste your NVIDIA NIM API key:',
      mask: '*',
      default: config.apiKey || undefined
    }
  ]);

  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Select a model:',
      choices: MODELS.map((m) => ({
        name: `${m.name}  ${chalk.cyan('[' + m.tag + ']')}`,
        value: m.id
      }))
    }
  ]);

  saveConfig({ apiKey, model });
  console.log(chalk.green('\n✔ Config saved successfully!\n'));
}

// Handle /delete command
async function handleDelete() {
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Delete all config and data?',
      default: false
    }
  ]);
  if (confirm) {
    deleteConfig();
    console.log(chalk.red('\n✔ Config deleted.'));
    console.log(chalk.gray('To fully uninstall run: npm uninstall -g sun2agent\n'));
    process.exit(0);
  }
}

// Main loop
async function startChat() {
  printBanner();

  let config = loadConfig();

  // If no API key, force config first
  if (!config.apiKey) {
    console.log(chalk.yellow('No API key found. Please run /config first.\n'));
    await handleConfig();
    config = loadConfig();
  }

  const history = [];

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.green('You:')
      }
    ]);

    const text = input.trim();
    if (!text) continue;

    // Command handling
    if (text === '/exit') {
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    if (text === '/config') {
      await handleConfig();
      config = loadConfig();
      continue;
    }
    if (text === '/delete') {
      await handleDelete();
      continue;
    }

    // Send to AI
    history.push({ role: 'user', content: text });
    const spinner = ora('sun2Agent is thinking...').start();

    try {
      const reply = await askAI(config.apiKey, config.model, history);
      spinner.stop();
      history.push({ role: 'assistant', content: reply });
      console.log(chalk.yellow.bold('sun2Agent: ') + reply + '\n');
    } catch (err) {
      spinner.stop();
      const msg = err.response?.data?.detail || err.message;
      console.log(chalk.red('Error: ' + msg + '\n'));
    }
  }
}

module.exports = { startChat };