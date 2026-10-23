const axios = require('axios');
const { requestWithRetry } = require('./modelRetry');
const observability = require('../observability');
const { sanitizeOutput } = require('../guardrails/outputGuard');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL_TIMEOUT_MS = 90000;
const DEFAULT_NVIDIA_TIMEOUT_MS = DEFAULT_MODEL_TIMEOUT_MS;
const MAX_REQUEST_BYTES = 48 * 1024;

function fitToolSchemas(tools, maxBytes = MAX_REQUEST_BYTES) {
  const selected = [];
  let bytes = 0;
  for (const tool of tools || []) {
    const size = Buffer.byteLength(JSON.stringify(tool));
    if (bytes + size > maxBytes) continue;
    selected.push(tool);
    bytes += size;
  }
  return selected;
}

function modelTimeoutMs() {
  const configured = Number(
    process.env.SUN2AGENT_MODEL_TIMEOUT_MS || process.env.SUN2AGENT_NVIDIA_TIMEOUT_MS
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MODEL_TIMEOUT_MS;
}

function timeoutSeconds(timeoutMs) {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function settleOnAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Model request cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Model request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function providerErrorInfo(data) {
  let body = data;
  if (data && typeof data[Symbol.asyncIterator] === 'function') {
    let text = '';
    try {
      for await (const chunk of data) {
        text += chunk.toString();
        if (text.length > 4096) break;
      }
      body = JSON.parse(text);
    } catch (_) { body = null; }
    finally { data.destroy?.(); }
  }
  const issue = body?.error || body?.detail || body;
  const safe = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value) &&
    sanitizeOutput(value) === value ? value : '';
  return { code: safe(issue?.code || issue?.type), param: safe(issue?.param) };
}

// Low-level call. Returns the full assistant message object so callers can see
// tool_calls when MCP tools are attached. `tools` is optional (OpenAI format).
// `signal` is an optional AbortSignal so the request can be cancelled (Esc).
// `onToken` receives streamed assistant text as it arrives.
async function chatCompletion(apiKey, model, messages, tools, signal, onToken, request = {}) {
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
  if (request.body && typeof request.body === 'object') Object.assign(body, request.body);
  if (Array.isArray(body.tools)) {
    const { tools: requestedTools, tool_choice: requestedChoice, ...base } = body;
    const toolBudget = Math.max(0, MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(base)));
    body.tools = fitToolSchemas(requestedTools, toolBudget);
    if (!body.tools.length) delete body.tools;
    else body.tool_choice = requestedChoice || 'auto';
  }
  if (!body.tools?.length) {
    delete body.tools;
    delete body.tool_choice;
  }
  const requestBytes = Buffer.byteLength(JSON.stringify(body));

  // Wrap the actual LLM call with LangSmith tracing when enabled.
  // The response format returned to callers is unchanged.
  return observability.traceLLM(async () => {
    const timeout = modelTimeoutMs();
    let response;
    try {
      response = await settleOnAbort(requestWithRetry(() => axios.post(request.url || NIM_URL, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal,
        timeout,
        responseType: body.stream ? 'stream' : 'json'
      }), { enabled: request.retryOnce === true, signal, onRetry: request.onRetry }), signal);
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
      const status = error?.response?.status;
      if (status) {
        // Only expose machine-readable error fields; provider messages can echo prompts.
        const headers = error.response.headers || {};
        const rawId = headers['x-request-id'] || headers['x-correlation-id'] || headers['nv-request-id'];
        const requestId = typeof rawId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(rawId)
          ? `; request ID ${rawId}` : '';
        error.providerError = await providerErrorInfo(error.response.data);
        const { code, param } = error.providerError;
        const reason = [status === 413 ? 'request body too large' : '', code,
          param && `parameter ${param}`].filter(Boolean).join(', ');
        error.message = `Model request failed (HTTP ${status}; ${messages.length} messages, ` +
          `${body.tools?.length || 0} tools, ${Math.ceil(requestBytes / 1024)} KiB request${requestId}` +
          `${reason ? `; provider: ${reason}` : ''}).`;
        error.response.data?.destroy?.();
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
  }, { model, provider: request.provider || 'nvidia', messages });
}

// Backward-compatible helper that returns just the reply text.
async function askAI(apiKey, model, messages) {
  const msg = await chatCompletion(apiKey, model, messages);
  return msg.content;
}

module.exports = { askAI, chatCompletion, fitToolSchemas, DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_NVIDIA_TIMEOUT_MS };
