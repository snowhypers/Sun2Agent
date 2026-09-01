// Tavily API client.
//
// One exported function: tavilySearch(query, apiKey).
// Returns a compact array of { title, url, content } objects.
// Throws a safe, user-facing Error on any failure — callers do not need to
// inspect the response shape; they just catch and forward the message.

const axios = require('axios');

const TAVILY_URL = 'https://api.tavily.com/search';

// How many results to request and how much content to keep per result.
// Kept small to avoid blowing up the model's context window.
const MAX_RESULTS = 5;
const MAX_CONTENT_CHARS = 500;

// Normalize one raw Tavily result into the compact shape we pass to the model.
function normalizeResult(r) {
  const content = String(r.content || r.snippet || '').trim();
  return {
    title:   String(r.title   || '').trim(),
    url:     String(r.url     || '').trim(),
    content: content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS) + '…'
      : content
  };
}

// POST a search to Tavily and return normalized results.
// `apiKey` must never appear in logs or error messages.
async function tavilySearch(query, apiKey) {
  if (!apiKey) {
    throw new Error(
      'Web search is enabled but no Tavily API key is configured. ' +
      'Run /config to add your key, or set the TAVILY_API_KEY environment variable.'
    );
  }

  let response;
  try {
    response = await axios.post(
      TAVILY_URL,
      {
        query,
        max_results:      MAX_RESULTS,
        include_answer:   false,
        include_raw_content: false
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000   // 10 s — never block the agent indefinitely
      }
    );
  } catch (err) {
    // Axios wraps HTTP errors in err.response; network/timeout errors have no response.
    if (err.response) {
      const status = err.response.status;
      if (status === 401 || status === 403) {
        throw new Error('Search failed: Tavily API key is invalid or unauthorized.');
      }
      if (status === 429) {
        throw new Error('Search failed: Tavily rate limit reached. Try again shortly.');
      }
      throw new Error(`Search failed: Tavily returned HTTP ${status}.`);
    }
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      throw new Error('Search failed: Tavily request timed out.');
    }
    throw new Error('Search failed: network error reaching Tavily.');
  }

  const raw = response.data;
  if (!raw || !Array.isArray(raw.results)) {
    throw new Error('Search failed: unexpected response from Tavily.');
  }

  return raw.results.slice(0, MAX_RESULTS).map(normalizeResult);
}

module.exports = { tavilySearch, MAX_RESULTS, MAX_CONTENT_CHARS };
