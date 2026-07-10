import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.sun2agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const MODELS = [
  { id: 'meta/llama-3.1-70b-instruct', tag: 'general', name: 'Llama 3.1 70B' },
  { id: 'openai/gpt-oss-120b', tag: 'allrounder-text', name: 'GPT-OSS 120B' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', tag: 'allrounder-text', name: 'Nemotron 3 Super' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', tag: 'multimodel-reasoning', name: 'Nemotron Nano Omni' }
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return { apiKey: '', model: MODELS[0].id };
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return { apiKey: '', model: MODELS[0].id };
  }
}

export function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  if (fs.existsSync(CONFIG_DIR)) fs.rmdirSync(CONFIG_DIR, { recursive: true });
}