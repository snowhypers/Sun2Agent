'use strict';

const context = require('../rules');
const memory = require('../memory');
const { RESPONSE_STYLE } = require('../rules/responseStyle');
const skills = require('../skills');
const providers = require('../providers');
const guardrails = require('../guardrails');
const { cleanHistory } = require('../../cli/history');
const { TelegramResponseStream } = require('./stream');

async function runTurn(runtime, chatId, text, replyToMessageId) {
  const controller = new AbortController();
  runtime.active.set(chatId, controller);
  const history = runtime.histories.get(chatId) || [];
  const priorHistoryLength = history.length;
  history.push({ role: 'user', content: text });
  runtime.histories.set(chatId, history);
  const stream = new TelegramResponseStream({
    http: runtime.http,
    botToken: runtime.config.telegram.botToken,
    chatId,
    replyToMessageId,
    onError: runtime.onError
  });

  try {
    await stream.startTyping();

    const systemPrompt = await runtime.buildSystemPrompt(text);
    const reply = await runtime.completeWithSearch(systemPrompt, history, controller.signal, stream);
    if (controller.signal.aborted) return;
    const content = reply && typeof reply.content === 'string' ? reply.content.trim() : '';
    if (!content) throw new Error('The model returned an empty response.');
    history.push({ role: 'assistant', content });
    await stream.finish(content);
    if (memory.isEnabled()) {
      await memory.remember([
        { role: 'user', content: text },
        { role: 'assistant', content }
      ]);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      // Do not leave an unanswered user message or orphan tool call in the
      // chat context; the user can retry without accumulating failed turns.
      history.length = priorHistoryLength;
      runtime.onError(error);
      await stream.finish('⚠ Unable to complete that response. Please try again.');
    }
  } finally {
    if (controller.signal.aborted) {
      // A stopped search can leave an assistant tool call without its tool
      // result. Drop this incomplete turn before the next Telegram message.
      history.length = priorHistoryLength;
      await stream.finish('⏹ Response stopped.');
    } else {
      await stream.cancel();
    }
    if (runtime.active.get(chatId) === controller) runtime.active.delete(chatId);
  }
}

async function buildSystemPrompt(runtime, text) {
  const relevantMemories = memory.isEnabled() ? await memory.search(text) : [];
  let prompt = context.buildSystemPrompt(
    'You are Sun2Agent, a helpful AI assistant chatting with the user through Telegram. ' +
    'Answer clearly and concisely. Only connected remote read-only MCP tools are available here; ' +
    'local tools and actions requiring approval are unavailable. ' +
    RESPONSE_STYLE +
    'For web search, research, news, or current-information questions, use web_search first when available. ' +
    'Use another remote search tool only if those results are insufficient.' +
    ` Current local date: ${new Date().toDateString()}. ` +
    'For today\'s news, find the latest available reports as of today, including recent prior days. ' +
    'Search broad topics without forcing today\'s exact date. Cite source URLs and publication dates; ' +
    'never label a prior-day story as published today. Answer with fewer items if only a few can be verified.'
  );
  prompt = skills.buildSkillsContext(prompt, runtime.config);
  return memory.buildMemoryContext(prompt, relevantMemories);
}

async function completeWithSearch(runtime, systemPrompt, history, signal, stream) {
  await runtime.mcpReady;
  const provider = providers.getActiveProvider(runtime.config);
  const searchSpec = runtime.search.getToolSpec(runtime.config);
  const remoteTools = runtime.mcp.getTelegramTools().specs;
  let tools = provider.supportsTools
    ? [searchSpec, ...remoteTools].filter(Boolean) : undefined;
  if (!tools?.length) tools = undefined;
  const system = { role: 'system', content: systemPrompt };
  const requestText = [...history].reverse().find((item) => item.role === 'user')?.content;
  const request = {
    url: provider.url,
    provider: provider.id,
    retryOnce: true,
    onRetry: () => {
      void stream.showStatus('Model unavailable — retrying...').catch(runtime.onError);
    }
  };

  const hasResponse = (message) => Boolean(message && (
    (Array.isArray(message.tool_calls) && message.tool_calls.length) ||
    String(message.content || '').trim()
  ));

  async function completeModel(messages, availableTools) {
    let recovered = false;
    let message;
    try {
      message = await runtime.complete(
        provider.apiKey, provider.model, messages, availableTools, signal,
        (token) => stream.push(token), request
      );
    } catch (error) {
      if (signal.aborted || error.code !== 'MODEL_STREAM_INTERRUPTED' || error.hasPartialOutput) {
        throw error;
      }
      recovered = true;
      await stream.showStatus('Model stream interrupted — retrying...');
      message = await runtime.complete(
        provider.apiKey, provider.model, messages, availableTools, signal, undefined, request
      );
    }

    if (!hasResponse(message) && !recovered && !signal.aborted) {
      await stream.showStatus('Model returned no content — retrying...');
      message = await runtime.complete(
        provider.apiKey, provider.model, messages, availableTools, signal, undefined, request
      );
    }
    return message;
  }

  for (let step = 0; step < 6; step++) {
    let message;
    try {
      message = await completeModel([system, ...cleanHistory(history)], tools);
    } catch (error) {
      if (signal.aborted) return null;
      const detail = error.response?.data?.detail || error.response?.data?.error?.message || error.message || '';
      // Match the terminal behavior for models that reject tool schemas.
      if (tools && /tool|function/i.test(String(detail))) {
        tools = undefined;
        await stream.showStatus('Agent is typing ...');
        continue;
      }
      throw error;
    }

    if (signal.aborted) return null;
    if (!hasResponse(message)) {
      throw new Error('The model returned an empty response.');
    }

    if (tools && message.tool_calls && message.tool_calls.length) {
      history.push(message);
      await stream.showStatus(message.tool_calls.some((call) => call.function?.name === 'web_search')
        ? 'Agent is searching ...' : 'Agent is using a tool ...');
      for (const call of message.tool_calls) {
        const name = call && call.function && call.function.name;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (_) {
          /* malformed arguments become an empty query and a safe tool error */
        }
        let content;
        if (name === 'web_search') {
          content = await runtime.search.executeTool(args.query, runtime.config, signal, requestText);
        } else if (runtime.mcp.getTelegramTools().routes.has(name)) {
          try {
            const result = await runtime.mcp.callTelegramTool(name, args, signal);
            content = guardrails.outputGuard(typeof result === 'string' ? result : result.text);
          } catch (error) {
            if (signal.aborted) return null;
            content = guardrails.outputGuard(`Remote tool failed: ${error.message}`);
          }
        } else {
          content = `Tool "${name || 'unknown'}" is not available in Telegram.`;
        }
        if (signal.aborted) return null;
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: content === null || content === undefined ? 'Search returned no result.' : String(content)
        });
      }
      await stream.showStatus('Agent is typing ...');
      continue;
    }
    return message;
  }

  // Force a final answer after the search-call cap instead of looping.
  return completeModel(
    [
      system,
      ...cleanHistory(history),
      { role: 'user', content: 'Using the search results above, provide the final answer now.' }
    ],
    undefined
  );
}

module.exports = { runTurn, buildSystemPrompt, completeWithSearch };
