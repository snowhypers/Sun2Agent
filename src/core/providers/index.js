'use strict';

const nvidia = require('./nvidia');
const openaiCompatible = require('./openaiCompatible');

function customProviders(config) {
  return Array.isArray(config && config.providers) ? config.providers : [];
}

function getActiveProvider(config = {}) {
  const activeId = config.activeProvider || nvidia.ID;
  if (activeId === nvidia.ID) return nvidia.resolve(config);
  const custom = customProviders(config).find((provider) => provider.id === activeId);
  if (!custom) return nvidia.resolve(config);
  return openaiCompatible.resolve(custom);
}

function hasCredentials(config = {}) {
  try {
    const provider = getActiveProvider(config);
    return Boolean(provider.apiKey && provider.model);
  } catch (_) {
    return false;
  }
}

function getActiveModel(config = {}) {
  try { return getActiveProvider(config).model; } catch (_) { return ''; }
}

function getActiveProviderName(config = {}) {
  try { return getActiveProvider(config).name; } catch (_) { return ''; }
}

module.exports = {
  NVIDIA_ID: nvidia.ID,
  NVIDIA_NAME: nvidia.NAME,
  customProviders,
  getActiveProvider,
  hasCredentials,
  getActiveModel,
  getActiveProviderName,
  openaiCompatible
};
