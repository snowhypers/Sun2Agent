const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.sun2agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const MODELS = [
  { id: 'meta/llama-3.1-70b-instruct', tag: 'general', name: 'Llama 3.1 70B' },
  { id: 'openai/gpt-oss-120b', tag: 'allrounder-text', name: 'GPT-OSS 120B' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', tag: 'allrounder-text', name: 'Nemotron 3 Super' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', tag: 'multimodel-reasoning', name: 'Nemotron Nano Omni' }
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return { apiKey: '', model: MODELS[0].id, langsmith: { enabled: false, project: 'sun2agent' } };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    // Ensure langsmith section exists for configs saved before the feature.
    if (!raw.langsmith) raw.langsmith = { enabled: false, project: 'sun2agent' };
    return raw;
  } catch (e) {
    return { apiKey: '', model: MODELS[0].id, langsmith: { enabled: false, project: 'sun2agent' } };
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
