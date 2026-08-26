// web_search tool definition and execution handler.
//
// Provides the OpenAI-format tool spec the model uses to decide when to
// search, and the handler that calls Tavily and returns a formatted string.

const { tavilySearch } = require('./tavily');
const guardrails      = require('../guardrails');

// The tool spec injected into the model's tools array when search is enabled.
// The description is intentionally instructive: tell the model *when* to use
// search (current / recent / external info) and when NOT to (things it already
// knows reliably).
const WEB_SEARCH_SPEC = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current, recent, or external information that you do not ' +
      'reliably know. Use this tool when the user asks about recent events, live data, ' +
      'latest versions, news, or any topic where your training data may be outdated. ' +
      'Do NOT use this tool when you can answer accurately and confidently from your ' +
      'training knowledge (e.g. programming concepts, well-established facts).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up.'
        }
      },
      required: ['query']
    }
  }
};

// Format normalized Tavily results as a readable string for the model.
// Each result is one block with title, URL, and a content snippet.
function formatResults(results) {
  if (!results.length) return 'No results found.';
  return results
    .map((r, i) =>
      `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`
    )
    .join('\n\n');
}

// Execute a web_search tool call.
// Returns a plain string (the formatted, sanitized search results) or a safe
// error message — never throws, so the agent loop stays alive.
async function executeWebSearch(query, apiKey) {
  if (!query || !String(query).trim()) {
    return 'Search failed: query must not be empty.';
  }

  try {
    const results = await tavilySearch(String(query).trim(), apiKey);
    const raw = formatResults(results);
    // Sanitize through outputGuard so any secrets that happen to appear in
    // search snippets are masked before they reach the model or the terminal.
    return guardrails.outputGuard(raw);
  } catch (err) {
    // err.message is already a safe user-facing string from tavily.js.
    return err.message || 'Search failed: unknown error.';
  }
}

module.exports = { WEB_SEARCH_SPEC, executeWebSearch };
