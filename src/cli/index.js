const chalk = require('chalk');
const { loadConfig } = require('../config/appConfig');
const mcp = require('../core/mcp');
const hitl = require('../core/hitl/mcpApproval');
const guardrails = require('../core/guardrails');
const observability = require('../core/observability');
const memory = require('../core/memory');
const { askInput, ESC_BACK } = require('./ui/input');
const { watchEscape, waitEnterOrEsc } = require('./ui/escapeWatcher');
const { printBanner, printIntro } = require('./ui/banner');
const { saveSession, loadSession, clearSession } = require('./session');
const { cleanHistory } = require('./history');
const { COMMANDS, handleConfig } = require('./commands');
const { createTokenHandler, finalFlush } = require('./streaming');
const { chatTurn } = require('./turn');
const { promptBack, printUserLine, sanitizeTerminalText } = require('./prompt');

// Check whether the Docker sandbox is enabled and Docker has gone down.
// (extracted to src/cli/dockerStatus.js so the MCP command can reuse it)
const { dockerDownWarning } = require('./dockerStatus');

// --- Session persistence (Docker outage resume) -----------------------------
//
// The conversation history is saved to ~/.sun2agent/session.json after every
// completed exchange. The file lives in the config dir, which is bind-mounted
// into the sandbox container — so it survives the container dying when the
// Docker engine stops. When the host launcher relaunches the sandbox after
// Docker comes back, it sets SUN2AGENT_RESUME=1 and the agent restores the
// saved messages, continuing exactly where the user was interrupted.

// --- Empty-assistant-message hygiene is in src/cli/history.js -----------------
// (imported at the top of this file)

// --- promptBack / printUserLine / sanitizeTerminalText -----------------------
// All three are in src/cli/prompt.js (imported at the top of this file).

// Main loop
async function startChat() {
  // HITL approvals are scoped to one interactive chat, never to a saved
  // config or a later invocation of the CLI.
  hitl.startPrompt();
  let config = loadConfig();
  printBanner(config);
  printIntro();

  // If no API key, force config first
  if (!config.apiKey) {
    console.log(chalk.yellow('No API key found. Please run /config first.\n'));
    await handleConfig({ promptBack, waitEnterOrEsc, dockerDownWarning });
    config = loadConfig();
  }

  // Enable LangSmith tracing for this session if a saved config has it on.
  if (config.langsmith && config.langsmith.enabled && config.langsmithApiKey) {
    observability.enable(config.langsmithApiKey, config.langsmith.project || 'sun2agent');
  }

  // Local memory is optional. A failed Mem0/NVIDIA initialization never blocks
  // startup; the existing agent continues with memory disabled for this run.
  if (config.memory && config.memory.enabled) {
    const ready = await memory.enable();
    if (!ready) console.log(chalk.yellow('Memory unavailable; continuing without memory.\n'));
  }

  // If the Docker sandbox is enabled, Docker MUST be running. Do NOT silently
  // fall back to host execution — fail clearly so the user knows to start
  // Docker (or disable the sandbox) before continuing. This check only runs
  // on the host; inside the sandbox container the env marker is set instead.
  if (process.env.SUN2AGENT_SANDBOX === '1') {
    console.log(chalk.green('🐳 Docker sandbox active — running isolated at /workspace.\n'));
  } else if (config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker') {
    const { isDockerRunning } = require('../core/sandbox');
    if (!isDockerRunning()) {
      console.log(chalk.red('\nDocker sandbox is enabled, but Docker is not running.'));
      console.log(chalk.gray('\nPlease start Docker Desktop/Engine and run sun2agent again,'));
      console.log(chalk.gray('or run the agent on your host instead: sun2agent sandbox disable\n'));
      process.exit(1);
    }
  }

  const history = [];

  // Relaunch after a Docker outage (the host launcher sets SUN2AGENT_RESUME=1):
  // restore the saved conversation so the session continues where it stopped.
  if (process.env.SUN2AGENT_RESUME === '1') {
    const saved = loadSession();
    if (saved && saved.length) {
      // Defensive: sessions saved by older versions may contain empty
      // assistant messages — never restore those into context.
      history.push(...cleanHistory(saved));
      console.log(chalk.green(`↩ Session restored — continuing your conversation from before the Docker interruption (${saved.length} messages).\n`));
    }
  }

  while (true) {
    const input = await askInput({ model: config.model, tag: mcp.getTag() });

    // Esc on an empty box -> back to simple chat: disconnect MCP, drop the tag.
    if (input === ESC_BACK) {
      if (mcp.getActiveName()) {
        await mcp.disconnectAll();
        console.log(chalk.gray('⎋ Disconnected MCP. Back to simple chat.\n'));
      }
      continue;
    }

    const text = input.trim();
    if (!text) continue;

    // Echo the submitted message as a clean transcript line (the input box
    // itself was erased on submit), with a right-aligned timestamp.
    printUserLine(text);

    // Command handling
    if (text === '/exit') {
      await mcp.disconnectAll();
      clearSession(); // clean exit — nothing to resume next time
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    const handler = COMMANDS[text];
    if (handler) {
      if (text === '/mcp') {
        const before = mcp.getConnectionSignature();
        await handler({ promptBack, waitEnterOrEsc, dockerDownWarning });
        const after = mcp.getConnectionSignature();
        // If the connected set changed, reset the conversation so the model
        // doesn't keep referencing a previous server's tools from history.
        if (before !== after) {
          history.length = 0;
          const tag = mcp.getTag();
          console.log(chalk.gray('(context reset — now using ' + (tag ? '@' + tag : 'no MCP server') + ')\n'));
        }
        if (text === '/config') config = loadConfig();
      } else {
        await handler({ promptBack, waitEnterOrEsc, dockerDownWarning });
        if (text === '/config') config = loadConfig();
      }
      continue;
    }

    // Screen the prompt before it ever reaches the model.
    const inputVerdict = guardrails.inputGuard(text);
    if (!inputVerdict.ok) {
      console.log(chalk.red('⛔ ' + inputVerdict.reason) + '\n');
      continue;
    }

    // Send to AI (with MCP tools if any are connected).
    // While it works, watch for Esc to abort the request/tool call and drop
    // back to an empty input box.
    history.push({ role: 'user', content: text });

    const controller = new AbortController();
    // Streaming render layer lives in src/cli/streaming.js. See the file for
    // the held-back-tail invariant and the secret-mask timing.
    const stream = createTokenHandler(guardrails);
    const onToken = stream.onToken;
    const onToolTurn = stream.onToolTurn;
    const stopWatch = watchEscape(() => controller.abort());
    try {
      const reply = await chatTurn(config, history, controller.signal, onToken, onToolTurn);
      if (controller.signal.aborted) {
        console.log(chalk.gray('⎋ stopped\n'));
      } else {
        finalFlush({
          reply,
          streamRaw: stream.getStreamRaw(),
          streamed: stream.getStreamed(),
          streamPrinted: stream.getStreamPrinted(),
          guardrails,
          sanitizeTerminalText
        });
        if (reply && memory.isEnabled()) {
          await memory.remember([
            { role: 'user', content: text },
            { role: 'assistant', content: reply }
          ]);
        }
      }
      // If LangSmith rejected the last run, print a one-time warning so the
      // user knows tracing is failing (without blocking the conversation or
      // spamming on every subsequent failure). The next postRun() failure
      // re-arms the warning.
      const lsError = observability.consumeError();
      if (lsError) {
        console.log(chalk.yellow(`\n⚠ LangSmith tracing failed: ${lsError.message}`));
        console.log(chalk.gray('  Fix the key with /config, or run with tracing disabled.\n'));
      }
      // Persist after every completed exchange so an abrupt stop (Docker
      // outage, crash) can resume exactly from here. Empty assistant
      // placeholders are stripped so a bad turn never poisons the resume.
      saveSession(cleanHistory(history));
    } catch (err) {
      if (controller.signal.aborted) {
        console.log(chalk.gray('⎋ stopped\n'));
      } else {
        const msg = err.response?.data?.detail || err.message;
        console.log(chalk.red('Error: ' + msg + '\n'));
      }
    } finally {
      stopWatch();
    }
  }
}

module.exports = { startChat };
