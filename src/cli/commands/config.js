// /config slash command — re-runs the first-run setup prompts to change
// the active AI provider/model, search, LangSmith, memory, and Telegram settings.

const chalk = require('chalk');
const { loadConfig, saveConfig } = require('../../config/appConfig');
const observability = require('../../core/observability');
const memory = require('../../core/memory');
const search = require('../../core/search');
const telegram = require('../../core/telegram');
const providers = require('../../core/providers');
const { configureProvider } = require('./providerConfig');

async function handleConfig(ctx) {
  const readConfig = ctx.loadConfig || loadConfig;
  const writeConfig = ctx.saveConfig || saveConfig;
  const config = readConfig();

  const providerConfig = await configureProvider(ctx, config);
  if (!providerConfig) return;

  const newConfig = {
    ...config,
    ...providerConfig,
    langsmith: config.langsmith || { enabled: false, project: 'sun2agent' },
    memory: config.memory || { enabled: false },
    search: config.search || { enabled: false, provider: 'tavily', apiKey: '' },
    telegram: config.telegram || { enabled: false, botToken: '', chatId: '' }
  };

  // --- Web search -----------------------------------------------------------
  const aSearch = await ctx.promptBack([
    {
      type: 'confirm',
      name: 'enableSearch',
      message: 'Enable web search (Tavily)?  ' + chalk.gray('(esc to keep current setting)'),
      default: Boolean(config.search && config.search.enabled)
    }
  ]);

  if (aSearch && aSearch.enableSearch) {
    const aSearchKey = await ctx.promptBack([
      {
        type: 'password',
        name: 'tavilyApiKey',
        message: 'Paste your Tavily API key:  ' + chalk.gray('(esc to keep current setting)'),
        mask: '*',
        default: (config.search && config.search.apiKey) || undefined
      }
    ]);
    if (aSearchKey && aSearchKey.tavilyApiKey) {
      newConfig.search = { enabled: true, provider: 'tavily', apiKey: aSearchKey.tavilyApiKey };
    } else {
      // Esc on the key prompt: keep search enabled with the existing key (if any).
      newConfig.search = { ...newConfig.search, enabled: true };
    }
  } else if (aSearch) {
    newConfig.search = { enabled: false, provider: 'tavily', apiKey: newConfig.search.apiKey || '' };
  }

  const a3 = await ctx.promptBack([
    {
      type: 'confirm',
      name: 'enableLangSmith',
      message: 'Enable LangSmith observability?  ' + chalk.gray('(esc to keep current setting)'),
      default: Boolean(config.langsmith && config.langsmith.enabled)
    }
  ]);

  if (a3 && a3.enableLangSmith) {
    // LangSmith API key prompt remains masked and is unrelated to local memory.
    const a4 = await ctx.promptBack([
      {
        type: 'password',
        name: 'langsmithApiKey',
        message: 'Paste your LangSmith API key:  ' + chalk.gray('(esc to keep current setting)'),
        mask: '*',
        default: config.langsmithApiKey || undefined
      }
    ]);
    if (a4) {
      newConfig.langsmithApiKey = a4.langsmithApiKey;
      newConfig.langsmith = { enabled: true, project: 'sun2agent' };
      observability.enable(a4.langsmithApiKey, 'sun2agent');
    }
  } else if (a3) {
    delete newConfig.langsmithApiKey;
    newConfig.langsmith = { enabled: false, project: 'sun2agent' };
    observability.disable();
  }

  const a5 = await ctx.promptBack([
    {
      type: 'confirm',
      name: 'enableMemory',
      message: 'Enable memory?  ' + chalk.gray('(local only; esc keeps current setting)'),
      default: Boolean(config.memory && config.memory.enabled)
    }
  ]);
  if (a5) newConfig.memory = { enabled: a5.enableMemory };

  // --- Telegram ------------------------------------------------------------
  // A "no" answer disables Telegram and skips every credential prompt, but
  // preserves the saved token/chat ID so it can be enabled again later. Esc
  // keeps the current Telegram setting, matching the other optional sections.
  let telegramStatus = null;
  const aTelegram = await ctx.promptBack([
    {
      type: 'confirm',
      name: 'connectTelegram',
      message: 'Connect Telegram?  ' + chalk.gray('(esc to keep current setting)'),
      default: Boolean(config.telegram && config.telegram.enabled)
    }
  ]);

  if (aTelegram && !aTelegram.connectTelegram) {
    newConfig.telegram = {
      enabled: false,
      botToken: newConfig.telegram.botToken || '',
      chatId: newConfig.telegram.chatId || ''
    };
    telegramStatus = { connected: false };
  } else if (aTelegram && aTelegram.connectTelegram) {
    const aToken = await ctx.promptBack([
      {
        type: 'password',
        name: 'telegramBotToken',
        message: 'Paste your Telegram bot token:  ' + chalk.gray('(esc to keep current setting)'),
        mask: '*',
        default: (config.telegram && config.telegram.botToken) || undefined
      }
    ]);
    if (aToken) {
      const aChat = await ctx.promptBack([
        {
          type: 'input',
          name: 'telegramChatId',
          message: 'Enter your Telegram chat ID:  ' + chalk.gray('(esc to keep current setting)'),
          default: (config.telegram && config.telegram.chatId) || undefined,
          validate: (value) => /^\d+$/.test(String(value || '').trim()) || 'Enter a positive numeric Telegram chat ID.'
        }
      ]);
      if (aChat) {
        const candidate = {
          enabled: true,
          botToken: String(aToken.telegramBotToken || '').trim(),
          chatId: String(aChat.telegramChatId || '').trim()
        };
        try {
          const verify = ctx.verifyTelegramConnection || telegram.verifyConnection;
          const result = await verify(candidate.botToken, candidate.chatId);
          newConfig.telegram = candidate;
          telegramStatus = { connected: true, username: result && result.username };
        } catch (error) {
          // Keep previously saved credentials when a new connection attempt
          // fails, but leave Telegram disabled. Never save an unverified new
          // credential or include the attempted token in terminal output.
          newConfig.telegram = {
            enabled: false,
            botToken: config.telegram?.botToken || '',
            chatId: config.telegram?.chatId || ''
          };
          const rawError = String(error.message || 'Connection failed.');
          telegramStatus = {
            connected: false,
            error: candidate.botToken ? rawError.replaceAll(candidate.botToken, '[REDACTED]') : rawError
          };
        }
      }
    }
  }

  writeConfig(newConfig);
  const activeProvider = providers.getActiveProvider(newConfig);
  console.log(chalk.green(`\n✔ Provider: ${activeProvider.name}`));
  console.log(chalk.green(`✔ Model: ${activeProvider.model}`));
  console.log(chalk.green(`✔ LangSmith observability: ${newConfig.langsmith.enabled ? 'Enabled' : 'Disabled'}`));

  // Web search confirmation (never print the full key).
  if (newConfig.search && newConfig.search.enabled) {
    const maskedKey = search.maskApiKey(process.env.TAVILY_API_KEY || newConfig.search.apiKey);
    console.log(chalk.green('✔ Web Search: Enabled'));
    console.log(chalk.green(`✔ Provider: Tavily`));
    console.log(chalk.green(`✔ API Key: ${maskedKey}`));
  } else {
    console.log(chalk.green('✔ Web Search: Disabled'));
  }

  if (newConfig.memory.enabled) {
    const ready = await memory.enable();
    if (ready) {
      console.log(chalk.green('✔ Memory: Enabled'));
      console.log(chalk.green(`✔ Local memory: ${memory.getMemoryPath()}`));
    } else {
      console.log(chalk.yellow('Memory unavailable; continuing without memory.'));
    }
  } else {
    memory.disable();
    console.log(chalk.green('✔ Memory: Disabled'));
  }
  if (telegramStatus && telegramStatus.connected) {
    const username = telegramStatus.username ? ` (@${telegramStatus.username})` : '';
    console.log(chalk.green(`✔ Telegram: Connected${username}`));
  } else if (telegramStatus && telegramStatus.error) {
    console.log(chalk.yellow(`✗ Telegram connection failed: ${telegramStatus.error}`));
    console.log(chalk.green('✔ Telegram: Disabled'));
  } else if (telegramStatus) {
    console.log(chalk.green('✔ Telegram: Disabled'));
  } else if (newConfig.telegram && newConfig.telegram.enabled) {
    console.log(chalk.green('✔ Telegram: Connected'));
  } else {
    console.log(chalk.green('✔ Telegram: Disabled'));
  }
  console.log(chalk.gray('\nConfiguration complete.\n'));
}

module.exports = { handleConfig };
