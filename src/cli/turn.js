// One chat turn: assemble the prompt, call the LLM, dispatch any tool calls
// the model requests, return the final answer (or null on Esc).
//
// `signal` (optional AbortSignal) lets the user interrupt with Esc.
// Uses a single continuous spinner: thinking → waiting for approval → running tool.
//
// `onToken(token)` is called per streamed chunk from the LLM (see
// src/cli/streaming.js for the safe-print contract).
// `onToolTurn()` is called whenever the streaming buffers should be reset
// (between tool-call iterations and on empty-response retries).

const chalk = require('chalk');
const ora = require('ora');

const mcp = require('../core/mcp');
const hitl = require('../core/hitl/mcpApproval');
const guardrails = require('../core/guardrails');
const context = require('../core/context');
const memory = require('../core/memory');
const search = require('../core/search');
const { chatCompletion } = require('../core/api');
const { dockerDownWarning } = require('./dockerStatus');
const { isEmptyAssistantMessage, cleanHistory } = require('./history');
const { sanitizeTerminalText } = require('./prompt');

// Terminal helpers used for tool-call batch + result rendering.
function termWidth() {
  return process.stdout.columns || 80;
}
function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

async function chatTurn(config, history, signal, onToken, onToolTurn) {
  const { specs, routes } = mcp.getOpenAiTools();

  // Merge web_search spec when search is enabled. MCP tools are unchanged.
  const searchSpec = search.getToolSpec(config);
  const allSpecs = searchSpec ? [...specs, searchSpec] : specs;
  const tools = allSpecs.length ? allSpecs : undefined;

  const currentUserMessage = [...history].reverse().find((item) => item.role === 'user');
  const relevantMemories = memory.isEnabled() && currentUserMessage
    ? await memory.search(currentUserMessage.content)
    : [];

  // Memory is appended to the base prompt as contextual information, then the
  // existing AGENT.md builder adds repository instructions. Neither layer can
  // alter guardrails, tool validation, or Docker restrictions.
  const withMemory = memory.buildMemoryContext(context.buildSystemPrompt(allSpecs), relevantMemories);
  const system = { role: 'system', content: context.buildSystemPrompt(withMemory) };
  let allowTools = Boolean(tools);

  // Continuous spinner for the entire turn.
  const spinner = ora(chalk.gray('sun2Agent is thinking...  (⎋ esc to stop)')).start();
  hitl.setSpinner(spinner);
  const streamText = typeof onToken === 'function'
    ? (token) => {
        // Keep generated text clean. If this response later turns out to be
        // a tool-call turn, the spinner is reattached immediately before the
        // HITL/tool boundary below.
        if (spinner.isSpinning) spinner.stop();
        hitl.setSpinner(null);
        onToken(token);
      }
    : undefined;

  const ensureIndicator = (text) => {
    if (!spinner.isSpinning) spinner.start();
    spinner.text = chalk.gray(text);
    hitl.setSpinner(spinner);
  };

  // Loop so the model can chain tool calls before its final answer.
  const MAX_TOOL_STEPS = 30;
  // One silent retry when the model answers with a completely empty message
  // (no content, no tool calls). The retry runs in NON-STREAMING mode: an
  // empty reply is almost always a prematurely closed SSE stream, and a plain
  // JSON response cannot suffer chunk loss the way a stream can.
  const EMPTY_RESPONSE_RETRIES = 1;
  let emptyRetries = 0;
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (signal && signal.aborted) {
      spinner.stop();
      hitl.setSpinner(null);
      return null;
    }

    // System prompt is prepended per-call and kept out of persistent history.
    // cleanHistory guards against messages saved by older versions of the app.
    const messages = [system, ...cleanHistory(history)];
    let msg;
    try {
      msg = await chatCompletion(
        config.apiKey,
        config.model,
        messages,
        allowTools ? tools : undefined,
        signal,
        // Retry attempts run NON-STREAMING: a plain JSON response cannot lose
        // chunks the way a prematurely closed SSE stream can.
        emptyRetries ? undefined : streamText
      );
    } catch (e) {
      if (signal && signal.aborted) {
        spinner.stop();
        hitl.setSpinner(null);
        return null;
      }
      const detail = e.response?.data?.detail || e.response?.data?.error?.message || e.message || '';
      // Some models reject the `tools` param — retry once without tools.
      if (allowTools && /tool|function/i.test(String(detail))) {
        spinner.text = chalk.gray(`model "${config.model}" can't use tools — continuing without them...`);
        allowTools = false;
        continue;
      }
      spinner.stop();
      hitl.setSpinner(null);
      throw e;
    }

    // Empty-response recovery. If the model returned nothing at all (no
    // content, no tool calls), silently retry ONCE; if it is still empty,
    // fail with a clear message instead of printing a bare "sun2Agent:"
    // label. Nothing is pushed to history, so the blank turn never poisons
    // later requests.
    if (
      (!msg.tool_calls || !msg.tool_calls.length) &&
      !(typeof msg.content === 'string' && msg.content.trim())
    ) {
      if (signal && signal.aborted) {
        spinner.stop();
        hitl.setSpinner(null);
        return null;
      }
      if (emptyRetries < EMPTY_RESPONSE_RETRIES) {
        emptyRetries += 1;
        // Reset the streamed-output buffers for the retried attempt.
        if (typeof onToolTurn === 'function') onToolTurn();
        continue;
      }
      spinner.stop();
      hitl.setSpinner(null);
      throw new Error('Model returned an empty response — please try again.');
    }

    history.push(msg);

    if (allowTools && msg.tool_calls && msg.tool_calls.length) {
      // Tokens received while the model was constructing a tool call are not
      // assistant output. Start a fresh output buffer for the answer that is
      // generated after the tool result is returned.
      if (typeof onToolTurn === 'function') onToolTurn();
      // Show every proposed action up front so the user sees the batch.
      const batch = msg.tool_calls.map((call) => {
        const fnName = call.function.name;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (_) {
          /* leave args empty on malformed JSON */
        }
        const argRoom = Math.max(16, termWidth() - fnName.length - 8);
        console.log(chalk.magenta(`  ⚙ ${fnName}`) + chalk.gray(`(${truncate(JSON.stringify(args), argRoom)})`));
        return { call, fnName, args };
      });

      // Run tools sequentially so spinner updates cleanly: waiting → running → thinking...
      const contents = [];
      for (const { call, fnName, args } of batch) {
        if (signal && signal.aborted) {
          contents.push('interrupted');
          continue;
        }

        // --- web_search: built-in tool, no HITL needed (read-only API call) ---
        if (fnName === 'web_search') {
          ensureIndicator(`searching the web: ${args.query || ''}...`);
          const content = await search.executeTool(args.query, config);
          console.log(chalk.gray(`     ↳ ${truncate(sanitizeTerminalText(content), Math.max(20, termWidth() - 8))}`));
          contents.push(content);
          spinner.text = chalk.gray('sun2Agent is thinking...  (⎋ esc to stop)');
          continue;
        }

        // --- MCP tools ---
        if (!routes.has(fnName)) {
          const available = [...routes.keys()].join(', ') || '(none)';
          console.log(chalk.red(`     ↳ unknown tool; redirected model to available tools`));
          contents.push(
            `Tool "${fnName}" does not exist. The only available tools are: ${available}. ` +
            `Call one of those, or answer directly if none fit.`
          );
          continue;
        }
        try {
          // A streamed partial response may have stopped the spinner for
          // clean output. Reattach it before HITL asks for approval, so the
          // indicator is active for the complete approval/execution phase.
          ensureIndicator(`thinking... deciding whether to run ${fnName}...`);
          const raw = await mcp.callTool(routes, fnName, args, signal);
          const content = guardrails.outputGuard(raw);
          if (content !== raw) {
            console.log(chalk.yellow('     ⚠ output guard: secrets masked in tool result'));
          }
          console.log(chalk.gray(`     ↳ ${truncate(sanitizeTerminalText(content), Math.max(20, termWidth() - 8))}`));
          contents.push(content);
          // Spinner updates back to "thinking" for next model call.
          spinner.text = chalk.gray('sun2Agent is thinking...  (⎋ esc to stop)');
        } catch (e) {
          if (signal && signal.aborted) {
            contents.push('interrupted');
            continue;
          }
          const content = 'Tool error: ' + e.message;
          console.log(chalk.red(`     ↳ ${sanitizeTerminalText(content)}`));
          // If Docker went down mid-session, warn the user clearly.
          const dockerWarn = dockerDownWarning();
          if (dockerWarn) {
            console.log(chalk.red('  ⛔ ' + dockerWarn));
          }
          contents.push(content);
        }
      }

      // Inject results back into the running agent, preserving the model's
      // original call order.
      for (let i = 0; i < batch.length; i++) {
        history.push({
          role: 'tool',
          tool_call_id: batch[i].call.id,
          content: contents[i] === null || contents[i] === undefined ? 'interrupted' : contents[i]
        });
      }
      continue; // ask the model again now that it has tool results
    }

    spinner.stop();
    hitl.setSpinner(null);
    return msg.content; // final answer
  }

  // Hit the tool-call cap. Don't dead-end — ask the model once more WITHOUT
  // tools so it must summarize a result from everything it gathered.
  if (signal && signal.aborted) {
    spinner.stop();
    hitl.setSpinner(null);
    return null;
  }
  spinner.text = chalk.gray('wrapping up...');
  try {
    const wrapMessages = [
      system,
      ...cleanHistory(history),
      {
        role: 'user',
        content:
          'You have reached the tool-call limit. Based on the results you already ' +
          'gathered above, give me your best final answer now. If the task could ' +
          'not be completed, say clearly what worked and what failed.'
      }
    ];
    const finalMsg = await chatCompletion(config.apiKey, config.model, wrapMessages, undefined, signal, streamText);
    spinner.stop();
    hitl.setSpinner(null);
    return finalMsg.content || '(no final answer produced)';
  } catch (e) {
    spinner.stop();
    hitl.setSpinner(null);
    if (signal && signal.aborted) return null;
    return 'Reached the tool-call limit and could not summarize: ' + (e.message || e);
  }
}

module.exports = { chatTurn };
