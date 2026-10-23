const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { getDataDir } = require('../core/deployment/dataDir');
const CONFIG_DIR = getDataDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', tag: 'fast-reasoning', name: 'Nemotron 3.5 Lightning 30B' },
  { id: 'meta/muse-glimmer-30b', tag: 'creative', name: 'Muse Glimmer 30B' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', tag: 'advanced-reasoning', name: 'Nemotron 3 Ultra 550B' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', tag: 'allrounder-text', name: 'Nemotron 3 Super' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', tag: 'multimodel-reasoning', name: 'Nemotron Nano Omni' }
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function defaultConfig() {
  return {
    apiKey: '',
    model: MODELS[0].id,
    activeProvider: 'nvidia',
    providers: [],
    langsmith: { enabled: false, project: 'sun2agent' },
    sandbox: { enabled: false, mode: 'host' },
    memory: { enabled: false },
    hitl: { mcpApproval: true },
    search: { enabled: false, provider: 'tavily', apiKey: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    selectedSkills: []
  };
}

function normalizeProviders(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((provider) => {
    if (!provider || typeof provider !== 'object') return [];
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    const name = typeof provider.name === 'string' ? provider.name.trim() : '';
    const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : '';
    const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
    const models = [...new Set(
      (Array.isArray(provider.models) ? provider.models : [])
        .map((model) => typeof model === 'string' ? model.trim() : '')
        .filter(Boolean)
    )];
    if (!id || id === 'nvidia' || !name || !baseUrl || !models.length) return [];
    const requestedModel = typeof provider.activeModel === 'string'
      ? provider.activeModel.trim()
      : '';
    const activeModel = models.includes(requestedModel) ? requestedModel : models[0];
    return [{
      id,
      name,
      type: 'openai-compatible',
      baseUrl,
      apiKey,
      models,
      activeModel,
      supportsTools: provider.supportsTools !== false
    }];
  });
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return applyEnvironment(defaultConfig());
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    raw.providers = normalizeProviders(raw.providers);
    if (
      typeof raw.activeProvider !== 'string' ||
      (raw.activeProvider !== 'nvidia' && !raw.providers.some((provider) => provider.id === raw.activeProvider))
    ) {
      raw.activeProvider = 'nvidia';
    }
    // Ensure langsmith section exists for configs saved before the feature.
    if (!raw.langsmith) raw.langsmith = { enabled: false, project: 'sun2agent' };
    // Ensure sandbox section exists for configs saved before the feature.
    if (!raw.sandbox) raw.sandbox = { enabled: false, mode: 'host' };
    // Memory is optional and remains off for configs saved before the feature.
    if (!raw.memory) raw.memory = { enabled: false };
    // HITL (MCP approval) defaults to on for configs saved before the feature.
    if (!raw.hitl) raw.hitl = { mcpApproval: true };
    // Web search is optional and remains off for configs saved before the feature.
    if (!raw.search) raw.search = { enabled: false, provider: 'tavily', apiKey: '' };
    // Telegram is optional and remains off for configs saved before the feature.
    raw.telegram = {
      enabled: Boolean(raw.telegram && raw.telegram.enabled),
      botToken: typeof raw.telegram?.botToken === 'string' ? raw.telegram.botToken : '',
      chatId: typeof raw.telegram?.chatId === 'string' ? raw.telegram.chatId : ''
    };
    // Selected skills is an empty list for configs saved before the feature.
    if (!Array.isArray(raw.selectedSkills)) raw.selectedSkills = [];
    return applyEnvironment(raw);
  } catch (e) {
    throw new Error(`Cannot load ${CONFIG_FILE}: ${e.message}. Fix or restore this file before starting Sun2Agent.`);
  }
}

function applyEnvironment(config) {
  const env = process.env;
  const provider = env.SUN2AGENT_PROVIDER || config.activeProvider;
  const model = env.SUN2AGENT_MODEL;
  const apiKey = env.SUN2AGENT_API_KEY;
  config.activeProvider = provider;
  if (provider === 'nvidia') {
    if (model) config.model = model;
    if (apiKey) config.apiKey = apiKey;
  } else if (Array.isArray(config.providers)) {
    const selected = config.providers.find((item) => item.id === provider);
    if (selected) {
      if (model) selected.activeModel = model;
      if (apiKey) selected.apiKey = apiKey;
    }
  }
  const token = env.SUN2AGENT_TELEGRAM_BOT_TOKEN;
  const chatId = env.SUN2AGENT_TELEGRAM_CHAT_ID;
  if (token || chatId) {
    config.telegram = { ...config.telegram,
      botToken: token || config.telegram.botToken,
      chatId: chatId || config.telegram.chatId,
      enabled: Boolean((token || config.telegram.botToken) && (chatId || config.telegram.chatId))
    };
  }
  if (env.TAVILY_API_KEY) config.search = { ...config.search, enabled: true, apiKey: env.TAVILY_API_KEY };
  if (env.LANGSMITH_API_KEY) config.langsmithApiKey = env.LANGSMITH_API_KEY;
  if (env.LANGSMITH_TRACING) {
    config.langsmith = { ...config.langsmith, enabled: env.LANGSMITH_TRACING === 'true' };
  }
  return config;
}

function saveConfig(config) {
  ensureConfigDir();
  // The API key lives here — keep the file owner-only (0600) so other local
  // users cannot read it.
  const temp = `${CONFIG_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, CONFIG_FILE);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  if (fs.existsSync(CONFIG_DIR)) fs.rmdirSync(CONFIG_DIR, { recursive: true });
}

module.exports = { MODELS, loadConfig, saveConfig, deleteConfig, CONFIG_FILE, defaultConfig, normalizeProviders, applyEnvironment };
