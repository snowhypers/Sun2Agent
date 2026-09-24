'use strict';

const ID = 'nvidia';
const NAME = 'NVIDIA NIM';
const CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

function resolve(config) {
  return {
    id: ID,
    name: NAME,
    type: 'nvidia',
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || '').trim(),
    url: CHAT_COMPLETIONS_URL,
    supportsTools: true
  };
}

module.exports = { ID, NAME, CHAT_COMPLETIONS_URL, resolve };
