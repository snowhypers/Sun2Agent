'use strict';

const context = require('../context');
const memory = require('../memory');
const skills = require('../skills');
const providers = require('../providers');
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
    'Answer clearly and concisely. MCP and terminal tools are unavailable in this channel. ' +
    'A built-in read-only web_search tool may be available for current information.'
  );
  prompt = skills.buildSkillsContext(prompt, runtime.config);
  return memory.buildMemoryContext(prompt, relevantMemories);
}

async function completeWithSearch(runtime, systemPrompt, history, signal, stream) {
  const provider = providers.getActiveProvider(runtime.config);
  const searchSpec = runtime.search.getToolSpec(runtime.config);
  let tools = provider.supportsTools && searchSpec ? [searchSpec] : undefined;
  const system = { role: 'system', content: systemPrompt };

  for (let step = 0; step < 6; step++) {
    let message;
    try {
      message = await runtime.complete(
        provider.apiKey,
        provider.model,
        [system, ...cleanHistory(history)],
        tools,
        signal,
        (token) => stream.push(token),
        { url: provider.url, provider: provider.id }
      );
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
    if (!message || ((!message.tool_calls || !message.tool_calls.length) && !String(message.content || '').trim())) {
      throw new Error('The model returned an empty response.');
    }

    if (tools && message.tool_calls && message.tool_calls.length) {
      history.push(message);
      await stream.showStatus('Agent is searching ...');
      for (const call of message.tool_calls) {
        const name = call && call.function && call.function.name;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (_) {
          /* malformed arguments become an empty query and a safe tool error */
        }
        const content = name === 'web_search'
          ? await runtime.search.executeTool(args.query, runtime.config, signal)
          : `Tool "${name || 'unknown'}" is not available in Telegram.`;
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
  return runtime.complete(
    provider.apiKey,
    provider.model,
    [
      system,
      ...cleanHistory(history),
      { role: 'user', content: 'Using the search results above, provide the final answer now.' }
    ],
    undefined,
    signal,
    (token) => stream.push(token),
    { url: provider.url, provider: provider.id }
  );
}

module.exports = { runTurn, buildSystemPrompt, completeWithSearch };
