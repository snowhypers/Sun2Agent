const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.sun2agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', tag: 'fast-reasoning', name: 'Nemotron 3.5 Lightning 30B' },
  { id: 'meta/muse-glimmer-30b', tag: 'creative', name: 'Muse Glimmer 30B' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', tag: 'advanced-reasoning', name: 'Nemotron 3 Ultra 550B' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', tag: 'allrounder-text', name: 'Nemotron 3 Super' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', tag: 'multimodel-reasoning', name: 'Nemotron Nano Omni' }
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function defaultConfig() {
  return {
    apiKey: '',
    model: MODELS[0].id,
    langsmith: { enabled: false, project: 'sun2agent' },
    sandbox: { enabled: false, mode: 'host' },
    memory: { enabled: false },
    hitl: { mcpApproval: true },
    search: { enabled: false, provider: 'tavily', apiKey: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    selectedSkills: []
  };
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
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
    return raw;
  } catch (e) {
    return defaultConfig();
  }
}

function saveConfig(config) {
  ensureConfigDir();
  // The API key lives here — keep the file owner-only (0600) so other local
  // users cannot read it.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600); // enforce even if the file pre-existed
  } catch (e) {
    /* best effort */
  }
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  if (fs.existsSync(CONFIG_DIR)) fs.rmdirSync(CONFIG_DIR, { recursive: true });
}

module.exports = { MODELS, loadConfig, saveConfig, deleteConfig, CONFIG_FILE };
