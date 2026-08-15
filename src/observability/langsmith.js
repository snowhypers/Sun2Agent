// LangSmith observability wrappers for Sun2Agent.
//
// Two thin wrappers — traceLLM() and traceTool() — that create LangSmith
// runs around LLM calls and MCP tool executions. When LangSmith is disabled
// they are pure pass-throughs with zero overhead.
//
// Security: input/output is sanitized via outputGuard before tracing so
// secrets never leave the machine. The guardrails remain the authority on
// what is allowed; this module only observes.

const { RunTree } = require('langsmith');
const guardrails = require('../../guardrails');

let enabled = false;

// Enable LangSmith tracing. Called once at startup from /config.
function enable(apiKey, project) {
  process.env.LANGSMITH_TRACING = 'true';
  process.env.LANGSMITH_PROJECT = project || 'sun2agent';
  process.env.LANGSMITH_API_KEY = apiKey;
  enabled = true;
}

// Disable LangSmith tracing.
function disable() {
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_PROJECT;
  delete process.env.LANGSMITH_API_KEY;
  enabled = false;
}

// Whether LangSmith tracing is currently active.
function isEnabled() {
  return enabled;
}

// Sanitize data before sending to LangSmith. Reuses the outputGuard to mask
// any secrets that might appear in prompts, completions, or tool results.
function sanitize(text) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') return text;
  return guardrails.outputGuard(text);
}

// Sanitize structured tool arguments: round-trip through JSON so the output
// guard's secret patterns run over every string value, then parse back.
// If anything goes wrong, fall back to a redacted placeholder rather than
// sending raw secrets to LangSmith.
function sanitizeArgs(args) {
  if (args === null || args === undefined) return args;
  try {
    return JSON.parse(sanitize(JSON.stringify(args)));
  } catch (_) {
    return { redacted: 'arguments could not be sanitized for tracing' };
  }
}

// Sanitize messages array for tracing: keep role + content, mask secrets.
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => ({
    role: m.role,
    content: sanitize(m.content)
  }));
}

// Trace an LLM call. Wraps the actual API request in a LangSmith "llm" run.
// `fn` is an async function that performs the LLM call and returns the
// assistant message object. All other args are metadata for the trace.
//
// Returns whatever `fn` returns — the LLM response is untouched.
async function traceLLM(fn, { model, provider, messages } = {}) {
  if (!enabled) return fn();

  const run = new RunTree({
    name: 'chat_completion',
    run_type: 'llm',
    inputs: {
      provider: provider || 'nvidia',
      model: model || 'unknown',
      messages: sanitizeMessages(messages)
    }
  });

  const start = Date.now();
  let output;
  let error;
  try {
    output = await fn();
    run.end({
      outputs: {
        content: sanitize(output?.content),
        tool_calls: output?.tool_calls ? output.tool_calls.map((tc) => ({
          name: tc.function?.name,
          arguments: tc.function?.arguments
        })) : undefined
      },
      extra: {
        latency_ms: Date.now() - start
      }
    });
  } catch (e) {
    error = e;
    run.end({
      outputs: { error: e.message },
      extra: { latency_ms: Date.now() - start }
    });
  }

  // Fire-and-forget post to LangSmith — never block the user.
  run.postRun().catch(() => {});

  if (error) throw error;
  return output;
}

// Trace an MCP tool call. Wraps the actual tool execution in a LangSmith
// "tool" run. `fn` is an async function that calls the MCP tool and returns
// the text result.
//
// Returns whatever `fn` returns — the tool result is untouched.
async function traceTool(fn, { toolName, server, args } = {}) {
  if (!enabled) return fn();

  const run = new RunTree({
    name: toolName || 'unknown_tool',
    run_type: 'tool',
    inputs: {
      server: server || 'unknown',
      arguments: sanitizeArgs(args) || {}
    }
  });

  const start = Date.now();
  let output;
  let error;
  try {
    output = await fn();
    run.end({
      outputs: { result: sanitize(output) },
      extra: { latency_ms: Date.now() - start }
    });
  } catch (e) {
    error = e;
    run.end({
      outputs: { error: e.message },
      extra: { latency_ms: Date.now() - start }
    });
  }

  run.postRun().catch(() => {});

  if (error) throw error;
  return output;
}

module.exports = { enable, disable, isEnabled, traceLLM, traceTool, sanitize };
