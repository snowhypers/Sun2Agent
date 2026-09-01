// /config slash command — re-runs the first-run setup prompts to change
// the NVIDIA NIM API key, model, search, LangSmith, and memory settings.

const chalk = require('chalk');
const { loadConfig, saveConfig, MODELS } = require('../../config/appConfig');
const observability = require('../../core/observability');
const memory = require('../../core/memory');
const search = require('../../core/search');

async function handleConfig(ctx) {
  const config = loadConfig();

  const a1 = await ctx.promptBack([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Paste your NVIDIA NIM API key:  ' + chalk.gray('(esc to cancel)'),
      mask: '*',
      default: config.apiKey || undefined
    }
  ]);
  if (!a1) return;

  const a2 = await ctx.promptBack([
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
  if (!a2) return;

  const newConfig = {
    ...config,
    apiKey: a1.apiKey,
    model: a2.model,
    langsmith: config.langsmith || { enabled: false, project: 'sun2agent' },
    memory: config.memory || { enabled: false },
    search: config.search || { enabled: false, provider: 'tavily', apiKey: '' }
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

  saveConfig(newConfig);
  console.log(chalk.green('\n✔ NVIDIA API key configured'));
  console.log(chalk.green('✔ Model configured'));
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
  console.log(chalk.gray('\nConfiguration complete.\n'));
}

module.exports = { handleConfig };
