// Interactive /config menu. Each section is edited independently and changes
// are persisted only when the user chooses Done.

const chalk = require('chalk');
const { loadConfig, saveConfig } = require('../../config/appConfig');
const observability = require('../../core/observability');
const memory = require('../../core/memory');
const search = require('../../core/search');
const telegram = require('../../core/telegram');
const providers = require('../../core/providers');
const { configureProvider } = require('./providerConfig');

async function ask(ctx, question) {
  return ctx.promptBack([question]);
}

async function configureSearch(ctx, config) {
  const answer = await ask(ctx, {
    type: 'confirm', name: 'enabled', message: 'Enable web search (Tavily)?',
    default: Boolean(config.search.enabled)
  });
  if (!answer) return null;
  if (!answer.enabled) return { ...config.search, enabled: false, provider: 'tavily' };
  const key = await ask(ctx, {
    type: 'password', name: 'apiKey', message: 'Tavily API key (Esc returns to /config):',
    mask: '*', default: config.search.apiKey || undefined
  });
  if (!key) return null;
  return { ...config.search, enabled: true, provider: 'tavily', apiKey: key.apiKey || config.search.apiKey || '' };
}

async function configureLangSmith(ctx, config) {
  const answer = await ask(ctx, {
    type: 'confirm', name: 'enabled', message: 'Enable LangSmith observability?',
    default: Boolean(config.langsmith.enabled)
  });
  if (!answer) return null;
  if (!answer.enabled) return { langsmith: { ...config.langsmith, enabled: false }, langsmithApiKey: '' };
  const key = await ask(ctx, {
    type: 'password', name: 'apiKey', message: 'LangSmith API key (Esc returns to /config):',
    mask: '*', default: config.langsmithApiKey || undefined
  });
  if (!key) return null;
  return {
    langsmith: { ...config.langsmith, enabled: true, project: config.langsmith.project || 'sun2agent' },
    langsmithApiKey: key.apiKey || config.langsmithApiKey || ''
  };
}

async function configureTelegram(ctx, config) {
  const answer = await ask(ctx, {
    type: 'confirm', name: 'enabled', message: 'Connect Telegram?',
    default: Boolean(config.telegram.enabled)
  });
  if (!answer) return null;
  if (!answer.enabled) return { enabled: false, botToken: config.telegram.botToken || '', chatId: config.telegram.chatId || '' };
  const token = await ask(ctx, {
    type: 'password', name: 'botToken', message: 'Telegram bot token (Esc returns to /config):',
    mask: '*', default: config.telegram.botToken || undefined
  });
  if (!token) return null;
  const chat = await ask(ctx, {
    type: 'input', name: 'chatId', message: 'Telegram chat ID (Esc returns to /config):',
    default: config.telegram.chatId || undefined,
    validate: (value) => /^\d+$/.test(String(value || '').trim()) || 'Enter a numeric Telegram chat ID.'
  });
  if (!chat) return null;
  const candidate = { enabled: true, botToken: String(token.botToken || '').trim(), chatId: String(chat.chatId || '').trim() };
  const verify = ctx.verifyTelegramConnection || telegram.verifyConnection;
  try {
    const result = await verify(candidate.botToken, candidate.chatId);
    return { ...candidate, status: { connected: true, username: result && result.username } };
  } catch (error) {
    const message = String(error.message || 'Connection failed.');
    return {
      enabled: false,
      botToken: config.telegram.botToken || '',
      chatId: config.telegram.chatId || '',
      status: { connected: false, error: candidate.botToken ? message.replaceAll(candidate.botToken, '[REDACTED]') : message }
    };
  }
}

function menuChoices(config) {
  const active = providers.getActiveProvider(config);
  return [
    { name: `Provider and model  ${chalk.gray(`(${active.name} · ${active.model})`)}`, value: 'provider' },
    { name: `LangSmith observability: ${config.langsmith.enabled ? 'Enabled' : 'Disabled'}`, value: 'langsmith' },
    { name: `Web Search: ${config.search.enabled ? 'Enabled' : 'Disabled'}`, value: 'search' },
    { name: `Memory: ${config.memory.enabled ? 'Enabled' : 'Disabled'}`, value: 'memory' },
    { name: `Telegram: ${config.telegram.enabled ? 'Connected' : 'Disabled'}`, value: 'telegram' },
    { name: 'Done — save configuration', value: 'done' }
  ];
}

async function handleConfig(ctx) {
  const readConfig = ctx.loadConfig || loadConfig;
  const writeConfig = ctx.saveConfig || saveConfig;
  const initial = readConfig();
  let draft = {
    ...initial,
    langsmith: { enabled: false, project: 'sun2agent', ...(initial.langsmith || {}) },
    memory: { enabled: false, ...(initial.memory || {}) },
    search: { enabled: false, provider: 'tavily', apiKey: '', ...(initial.search || {}) },
    telegram: { enabled: false, botToken: '', chatId: '', ...(initial.telegram || {}) }
  };
  let telegramStatus = null;

  while (true) {
    const selection = await ask(ctx, {
      type: 'list', name: 'section', message: 'Configuration', choices: menuChoices(draft)
    });
    // Esc from the top-level menu exits without saving staged edits.
    if (!selection) return;
    if (selection.section === 'done') break;

    if (selection.section === 'provider') {
      const providerConfig = await configureProvider(ctx, draft);
      if (providerConfig) draft = { ...draft, ...providerConfig };
    } else if (selection.section === 'search') {
      const next = await configureSearch(ctx, draft);
      if (next) draft.search = next;
    } else if (selection.section === 'langsmith') {
      const next = await configureLangSmith(ctx, draft);
      if (next) {
        draft = { ...draft, ...next };
      }
    } else if (selection.section === 'memory') {
      const next = await ask(ctx, {
        type: 'confirm', name: 'enabled', message: 'Enable local memory?', default: Boolean(draft.memory.enabled)
      });
      if (next) draft.memory = { ...draft.memory, enabled: next.enabled };
    } else if (selection.section === 'telegram') {
      const next = await configureTelegram(ctx, draft);
      if (next) {
        telegramStatus = next.status || null;
        delete next.status;
        draft.telegram = next;
      }
    }
  }

  writeConfig(draft);
  if (draft.langsmith.enabled && draft.langsmithApiKey) observability.enable(draft.langsmithApiKey, draft.langsmith.project || 'sun2agent');
  else observability.disable();
  if (draft.memory.enabled) {
    const ready = await memory.enable();
    if (!ready) console.log(chalk.yellow('Memory unavailable; continuing without memory.'));
  } else memory.disable();

  const activeProvider = providers.getActiveProvider(draft);
  console.log(chalk.green(`\n✔ Provider: ${activeProvider.name}`));
  console.log(chalk.green(`✔ Model: ${activeProvider.model}`));
  console.log(chalk.green(`✔ LangSmith observability: ${draft.langsmith.enabled ? 'Enabled' : 'Disabled'}`));
  if (draft.search.enabled) {
    console.log(chalk.green('✔ Web Search: Enabled'));
    console.log(chalk.green('✔ Provider: Tavily'));
    console.log(chalk.green(`✔ API Key: ${search.maskApiKey(process.env.TAVILY_API_KEY || draft.search.apiKey)}`));
  } else console.log(chalk.green('✔ Web Search: Disabled'));
  if (draft.memory.enabled) {
    console.log(chalk.green('✔ Memory: Enabled'));
    console.log(chalk.green(`✔ Local memory: ${memory.getMemoryPath()}`));
  } else console.log(chalk.green('✔ Memory: Disabled'));
  if (telegramStatus && telegramStatus.connected) {
    console.log(chalk.green(`✔ Telegram: Connected${telegramStatus.username ? ` (@${telegramStatus.username})` : ''}`));
  } else if (telegramStatus && telegramStatus.error) {
    console.log(chalk.yellow(`✗ Telegram connection failed: ${telegramStatus.error}`));
    console.log(chalk.green('✔ Telegram: Disabled'));
  } else console.log(chalk.green(`✔ Telegram: ${draft.telegram.enabled ? 'Connected' : 'Disabled'}`));
  console.log(chalk.gray('\nConfiguration complete.\n'));
}

module.exports = { handleConfig, menuChoices };
