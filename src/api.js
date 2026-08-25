const axios = require('axios');
const observability = require('./observability');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Low-level call. Returns the full assistant message object so callers can see
// tool_calls when MCP tools are attached. `tools` is optional (OpenAI format).
// `signal` is an optional AbortSignal so the request can be cancelled (Esc).
// `onToken` receives streamed assistant text as it arrives.
async function chatCompletion(apiKey, model, messages, tools, signal, onToken) {
  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
    stream: typeof onToken === 'function'
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
      signal,
      responseType: body.stream ? 'stream' : 'json'
    });
    if (!body.stream) return response.data.choices[0].message;

    const message = { role: 'assistant', content: '', tool_calls: [] };
    let pending = '';
    const consume = (line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(data); } catch (_) { return; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.role) message.role = delta.role;
      if (typeof delta.content === 'string') {
        message.content += delta.content;
        onToken(delta.content);
      }
      for (const part of delta.tool_calls || []) {
        const index = Number.isInteger(part.index) ? part.index : message.tool_calls.length;
        const call = message.tool_calls[index] || {
          id: '', type: 'function', function: { name: '', arguments: '' }
        };
        if (part.id) call.id += part.id;
        if (part.type) call.type = part.type;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        message.tool_calls[index] = call;
      }
    };
    for await (const chunk of response.data) {
      pending += Buffer.from(chunk).toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(consume);
    }
    if (pending) consume(pending);
    if (!message.tool_calls.length) delete message.tool_calls;
    return message;
  }, { model, provider: 'nvidia', messages });
}

// Backward-compatible helper that returns just the reply text.
async function askAI(apiKey, model, messages) {
  const msg = await chatCompletion(apiKey, model, messages);
  return msg.content;
}

module.exports = { askAI, chatCompletion };
