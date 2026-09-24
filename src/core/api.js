const axios = require('axios');
const observability = require('./observability');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_NVIDIA_TIMEOUT_MS = 60000;

function nvidiaTimeoutMs() {
  const configured = Number(process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_NVIDIA_TIMEOUT_MS;
}

function timeoutSeconds(timeoutMs) {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

// Low-level call. Returns the full assistant message object so callers can see
// tool_calls when MCP tools are attached. `tools` is optional (OpenAI format).
// `signal` is an optional AbortSignal so the request can be cancelled (Esc).
// `onToken` receives streamed assistant text as it arrives.
async function chatCompletion(apiKey, model, messages, tools, signal, onToken) {
  const body = {
    model,
    messages,
    temperature: 0.7,
    // Reasoning-style models spend hidden "thinking" tokens before any visible
    // content; a tight cap here produced empty replies when the budget ran out
    // mid-thought. 4096 leaves room for the answer after the thinking phase.
    max_tokens: 4096,
    stream: typeof onToken === 'function'
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Wrap the actual LLM call with LangSmith tracing when enabled.
  // The response format returned to callers is unchanged.
  return observability.traceLLM(async () => {
    const timeout = nvidiaTimeoutMs();
    let response;
    try {
      response = await axios.post(NIM_URL, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal,
        timeout,
        responseType: body.stream ? 'stream' : 'json'
      });
    } catch (error) {
      const timedOut = !signal?.aborted && (
        error?.code === 'ECONNABORTED' ||
        error?.code === 'ETIMEDOUT' ||
        /timeout/i.test(String(error?.message || ''))
      );
      if (timedOut) {
        const timeoutError = new Error(
          `Model did not respond within ${timeoutSeconds(timeout)} seconds. ` +
          'Try again or select another model.'
        );
        timeoutError.code = 'MODEL_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    }
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
    try {
      for await (const chunk of response.data) {
        pending += Buffer.from(chunk).toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        lines.forEach(consume);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const interrupted = /aborted|premature|terminated|econnreset|socket hang up/i.test(
        String(error?.code || '') + ' ' + String(error?.message || '')
      );
      if (!interrupted) throw error;
      const streamError = new Error(
        'Model response stream was interrupted. Try again or select another model.'
      );
      streamError.code = 'MODEL_STREAM_INTERRUPTED';
      streamError.hasPartialOutput = Boolean(message.content || message.tool_calls.length);
      throw streamError;
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

module.exports = { askAI, chatCompletion, DEFAULT_NVIDIA_TIMEOUT_MS };
