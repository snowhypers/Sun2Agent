// Public interface for the search module.
//
// chat.js imports only this module; tavily.js and searchTool.js stay internal.

const { WEB_SEARCH_SPEC, executeWebSearch } = require('./searchTool');

// True when search is enabled in the saved config.
function isEnabled(config) {
  return Boolean(config && config.search && config.search.enabled);
}

// Resolve the Tavily API key. Environment variable takes precedence over the
// config file so the user can override without editing config.json.
// The key is never logged or injected into prompts.
function getApiKey(config) {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  return (config && config.search && config.search.apiKey) || '';
}

// Return the web_search tool spec when search is enabled, or null otherwise.
// chat.js spreads this into the tools array only when it is non-null.
function getToolSpec(config) {
  return isEnabled(config) ? WEB_SEARCH_SPEC : null;
}

// Execute a web_search tool call. Always resolves — never throws — so a
// search failure cannot crash the agent loop.
async function executeTool(query, config) {
  const apiKey = getApiKey(config);
  return executeWebSearch(query, apiKey);
}

// Mask the API key for display in config confirmation messages.
// Shows the provider prefix and the last 4 characters only.
function maskApiKey(key) {
  if (!key || key.length < 8) return '(not set)';
  return key.slice(0, 5) + '…' + key.slice(-4);
}

module.exports = { isEnabled, getApiKey, getToolSpec, executeTool, maskApiKey };
