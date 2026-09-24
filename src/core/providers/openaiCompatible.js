'use strict';

function validateBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return 'Use an http:// or https:// URL.';
    if (url.username || url.password) return 'Do not include credentials in the URL.';
    if (url.search || url.hash) return 'Do not include query parameters or a fragment.';
    return true;
  } catch (_) {
    return 'Enter a valid OpenAI-compatible base URL.';
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function chatCompletionsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return /\/chat\/completions$/i.test(normalized)
    ? normalized
    : normalized + '/chat/completions';
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom';
}

function uniqueId(name, existing = []) {
  const used = new Set(existing.map((provider) => provider.id));
  const base = slug(name);
  let id = base;
  let suffix = 2;
  while (used.has(id) || id === 'nvidia') id = `${base}-${suffix++}`;
  return id;
}

function validateProvider(provider) {
  if (!provider || !String(provider.name || '').trim()) return 'Provider name is required.';
  const urlVerdict = validateBaseUrl(provider.baseUrl);
  if (urlVerdict !== true) return urlVerdict;
  if (!String(provider.apiKey || '').trim()) return 'API key is required.';
  if (!Array.isArray(provider.models) || !provider.models.length) return 'At least one model ID is required.';
  if (!String(provider.activeModel || '').trim()) return 'Select an active model.';
  return true;
}

function resolve(provider) {
  const verdict = validateProvider(provider);
  if (verdict !== true) throw new Error(`Custom provider configuration is invalid: ${verdict}`);
  return {
    id: provider.id,
    name: provider.name,
    type: 'openai-compatible',
    apiKey: String(provider.apiKey).trim(),
    model: String(provider.activeModel).trim(),
    url: chatCompletionsUrl(provider.baseUrl),
    supportsTools: provider.supportsTools !== false
  };
}

module.exports = {
  validateBaseUrl,
  normalizeBaseUrl,
  chatCompletionsUrl,
  uniqueId,
  validateProvider,
  resolve
};
