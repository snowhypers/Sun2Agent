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
      'For current news, use recent dated sources and report their actual dates. ' +
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
      `[${i + 1}] ${r.title}\n${r.url}${r.publishedDate ? `\nPublished: ${r.publishedDate}` : ''}\n${r.content}`
    )
    .join('\n\n');
}

// Execute a web_search tool call.
// Returns formatted results or a safe error message. An aborted turn rejects
// so the caller can stop immediately instead of asking the model to continue.
async function executeWebSearch(query, apiKey, signal, requestText) {
  if (!query || !String(query).trim()) {
    return 'Search failed: query must not be empty.';
  }

  try {
    const recentNews = /\b(news|headlines)\b|\btop\s+\d+\s+new\b/i.test(requestText || '') &&
      /\b(today|latest|recent|breaking)\b/i.test(requestText || '');
    const range = recentNews ? 'week' : null;
    if (range) {
      const requestYears = new Set(String(requestText).match(/\b(?:19|20)\d{2}\b/g) || []);
      const queryYears = String(query).match(/\b(?:19|20)\d{2}\b/g) || [];
      if (queryYears.some((year) => year !== String(new Date().getFullYear()) && !requestYears.has(year))) {
        return 'Search skipped: use the requested current period, not an unrelated older year.';
      }
    }
    const results = await tavilySearch(String(query).trim(), apiKey, signal, range);
    const raw = recentNews && !results.length
      ? 'No recent dated news results found. Answer from earlier results or say what could not be verified.'
      : formatResults(results);
    // Sanitize through outputGuard so any secrets that happen to appear in
    // search snippets are masked before they reach the model or the terminal.
    return guardrails.outputGuard(raw);
  } catch (err) {
    // Cancellation belongs to the active turn; do not turn it into a search
    // result that the model might continue processing after /stop.
    if (signal?.aborted) throw err;
    // err.message is already a safe user-facing string from tavily.js.
    return err.message || 'Search failed: unknown error.';
  }
}

module.exports = { WEB_SEARCH_SPEC, executeWebSearch };
