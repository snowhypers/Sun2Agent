const axios = require('axios');
const observability = require('./observability');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Low-level call. Returns the full assistant message object so callers can see
// tool_calls when MCP tools are attached. `tools` is optional (OpenAI format).
// `signal` is an optional AbortSignal so the request can be cancelled (Esc).
async function chatCompletion(apiKey, model, messages, tools, signal) {
  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
    stream: false
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Wrap the actual LLM call with LangSmith tracing when enabled.
  // The response format returned to callers is unchanged.
  return observability.traceLLM(async () => {
    const response = await axios.post(NIM_URL, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal
    });
    return response.data.choices[0].message;
  }, { model, provider: 'nvidia', messages });
}

// Backward-compatible helper that returns just the reply text.
async function askAI(apiKey, model, messages) {
  const msg = await chatCompletion(apiKey, model, messages);
  return msg.content;
}

module.exports = { askAI, chatCompletion };
