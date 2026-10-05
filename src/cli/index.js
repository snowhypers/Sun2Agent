const chalk = require('chalk');
const { loadConfig, saveConfig } = require('../config/appConfig');
const mcp = require('../core/mcp');
const computer = require('../core/computer');
const hitl = require('../core/hitl/mcpApproval');
const guardrails = require('../core/guardrails');
const observability = require('../core/observability');
const memory = require('../core/memory');
const selfImprovement = require('../core/self-improvement');
const skills = require('../core/skills');
const providers = require('../core/providers');
const telegram = require('../core/telegram');
const { askInput, ESC_BACK } = require('./ui/input');
const { notify, flushNotices } = require('./ui/utils');
const { startTurnDisplay } = require('./ui/busyFooter');
const { watchEscape, waitEnterOrEsc } = require('./ui/escapeWatcher');
const { printBanner, printIntro } = require('./ui/banner');
const { saveSession, loadSession, clearSession, archiveSession } = require('../core/context-management/session');
const { cleanHistory } = require('./history');
const { estimateContextTokens, contextLabel } = require('../core/context-management/contextMeter');
const { COMMANDS, handleConfig } = require('./commands');
const { createTokenHandler, finalFlush } = require('./streaming');
const { chatTurn, buildTurnSystemPrompt } = require('./turn');
const { selectToolSpecs } = require('./computerTools');
const search = require('../core/search');
const { resumeAfterModel500 } = require('./modelRecovery');
const { promptBack, printUserLine, sanitizeTerminalText } = require('./prompt');

// Check whether the Docker sandbox is enabled and Docker has gone down.
// (extracted to src/cli/dockerStatus.js so the MCP command can reuse it)
const { dockerDownWarning } = require('./dockerStatus');

async function syncTelegram(config) {
  try {
    // Telegram starts quietly like the other configured background services.
    // Keep failures visible so a broken connection is still diagnosable.
    await telegram.sync(config);
  } catch (error) {
    notify(chalk.yellow(`⚠ Telegram could not start: ${error.message || 'connection failed'}`));
  }
}

async function estimateFooter(config, history, userText) {
  const provider = providers.getActiveProvider(config);
  const { specs, routes } = mcp.getOpenAiTools();
  const searchSpec = search.getToolSpec(config);
  const allTools = searchSpec ? [...specs, searchSpec] : specs;
  const tools = !provider.supportsTools ? [] : computer.isConnected()
    ? selectToolSpecs(allTools, routes, new Set()) : allTools;
  const memories = userText && memory.isEnabled() ? await memory.search(userText) : [];
  const system = selfImprovement.addLessonToPrompt(
    buildTurnSystemPrompt(config, memories), userText && selfImprovement.relevantLesson(userText)
  );
  return contextLabel(estimateContextTokens(system, cleanHistory(history), tools), config);
}

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
  if (!providers.hasCredentials(config)) {
    console.log(chalk.yellow('No provider credentials found. Please run /config first.\n'));
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

  // Telegram is optional. Start it in the background so its network handshake
  // never delays the first chat box. Errors redraw safely above active input.
  // The listener remains restricted to the private chat ID saved by /config.
  void syncTelegram(config);

  // Prepare the built-in filesystem tools in the background. The first input
  // box appears immediately; an ordinary chat turn waits for this connection
  // before offering tools to the model. Workspace access stays scoped to cwd.
  const workspaceReady = mcp.connectWorkspace().catch((error) => ({
    ok: false, error: error.message
  }));
  let workspaceWarningShown = false;

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
    flushNotices();
    const contextEstimate = await estimateFooter(config, history);
    const input = await askInput({
      model: providers.getActiveModel(config),
      tag: mcp.getTag(),
      // Skills tag is shown in the chatbox footer (MCP-style) when any
      // skills are selected. The selected skills' content is injected
      // into the system prompt by turn.js, so the model applies them
      // automatically — no need to reference them in the typed message.
      skillTag: skills.getTag(config),
      contextEstimate
    });

    // Esc on an empty box leaves desktop control first, then user MCPs,
    // browser and Skills. Automatic workspace tools remain available.
    if (input === ESC_BACK) {
      if (mcp.isComputerConnected()) {
        await mcp.disconnectComputer();
        history.length = 0;
        console.log(chalk.gray('⎋ Disconnected /computer. Other plugins remain unchanged.\n'));
        continue;
      }
      if (mcp.hasUserConnections()) {
        await mcp.disconnectUserServers();
        const builtinNote = mcp.isBrowserConnected() ? ' Browser tools remain available.' : '';
        console.log(chalk.gray(`⎋ Disconnected user MCP.${builtinNote}\n`));
        continue;
      }
      if (mcp.isBrowserConnected()) {
        await mcp.disconnectBrowser();
        console.log(chalk.gray('⎋ Disconnected /browser. Browser tools are unavailable.\n'));
        continue;
      }
      if (skills.getSelected(config).length) {
        try {
          saveConfig(skills.clearSelected(config));
        } catch (_) {
          /* best effort — the tag below still clears for this session */
        }
        config = loadConfig();
        console.log(chalk.gray('⎋ Skills cleared. Back to simple chat.\n'));
      }
      continue;
    }

    const text = input.trim();
    if (!text) continue;

    // Commands do not reserve a busy footer, so echo them immediately.
    const handler = COMMANDS[text];
    if (text === '/exit' || text === '/new' || handler) printUserLine(text);

    // Command handling
    if (text === '/exit') {
      await telegram.stop();
      await workspaceReady;
      await mcp.disconnectAll();
      clearSession(); // clean exit — nothing to resume next time
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    if (text === '/new') {
      try {
        const archived = archiveSession(cleanHistory(history));
        clearSession(true);
        history.length = 0;
        hitl.startPrompt();
        console.log(chalk.green(archived
          ? 'New conversation started. Previous chat saved locally.\n'
          : 'New conversation started.\n'));
      } catch (error) {
        console.log(chalk.red(`Could not save the previous chat; context was not cleared: ${error.message}\n`));
      }
      continue;
    }
    if (handler) {
      if (text === '/mcp' || text === '/browser' || text === '/computer' || text === '/computer disconnect') {
        const before = mcp.getConnectionSignature();
        await handler({ promptBack, waitEnterOrEsc, dockerDownWarning, loadConfig, saveConfig });
        const after = mcp.getConnectionSignature();
        // If the connected set changed, reset the conversation so the model
        // doesn't keep referencing a previous server's tools from history.
        if (before !== after) {
          history.length = 0;
          if (text === '/mcp') {
            const tag = mcp.getTag();
            console.log(chalk.gray('(context reset — now using ' + (tag ? '@' + tag : 'no MCP server') + ')\n'));
          }
        }
      } else {
        await handler({ promptBack, waitEnterOrEsc, dockerDownWarning, loadConfig, saveConfig });
        if (text === '/config') {
          config = loadConfig();
          await syncTelegram(config);
        }
        // /skills writes selectedSkills via saveConfig; reload so the next
        // input box shows the updated skill tags immediately.
        if (text === '/skills') config = loadConfig();
      }
      continue;
    }

    // Screen the prompt before it ever reaches the model.
    const inputVerdict = guardrails.inputGuard(text);
    if (!inputVerdict.ok) {
      printUserLine(text);
      console.log(chalk.red('⛔ ' + inputVerdict.reason) + '\n');
      continue;
    }

    // Send to AI (with MCP tools if any are connected).
    // While it works, watch for Esc to abort the request/tool call and drop
    // back to an empty input box.
    // HITL approvals are scoped to this user prompt, including model retries.
    hitl.startPrompt();
    const turnStart = history.length;
    history.push({ role: 'user', content: text });
    saveSession(cleanHistory(history));

    const busyContext = await estimateFooter(config, history, text);
    const stopBusyFooter = startTurnDisplay(text, {
      model: providers.getActiveModel(config),
      tag: mcp.getTag(),
      skillTag: skills.getTag(config),
      contextEstimate: busyContext
    });

    const controller = new AbortController();
    // Streaming render layer lives in src/cli/streaming.js. See the file for
    // the held-back-tail invariant and the secret-mask timing.
    const stream = createTokenHandler(guardrails);
    const onToken = stream.onToken;
    const onToolTurn = stream.onToolTurn;
    const stopWatch = watchEscape(() => controller.abort());
    let proposedLesson = null;
    let turnError = null;
    try {
      const workspaceResult = await workspaceReady;
      stopBusyFooter.updateContext?.(await estimateFooter(config, history, text));
      if (!workspaceResult.ok && !workspaceWarningShown) {
        workspaceWarningShown = true;
        console.log(chalk.yellow(`⚠ Workspace tools unavailable: ${workspaceResult.error}\n`));
      }
      const reply = await resumeAfterModel500(
        () => chatTurn(config, history, controller.signal, onToken, onToolTurn,
          (snapshot) => saveSession(cleanHistory(snapshot))),
        {
          signal: controller.signal,
          onRetry: () => {
            onToolTurn();
            console.log(chalk.yellow('Model unavailable — resuming once from saved tool progress...'));
          }
        }
      );
      if (controller.signal.aborted) {
        turnError = chalk.gray('⎋ stopped');
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
      if (!controller.signal.aborted) {
        const failure = selfImprovement.failureFromTurn(history.slice(turnStart), reply);
        proposedLesson = selfImprovement.draftLesson(failure);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        turnError = chalk.gray('⎋ stopped');
      } else {
        turnError = chalk.red('Error: ' + err.message);
      }
    } finally {
      stopWatch();
      stopBusyFooter();
    }
    if (turnError) console.log(turnError + '\n');
    if (proposedLesson) {
      console.log(chalk.yellow(`\nSuggested lesson: ${proposedLesson}`));
      const choice = await promptBack([{
        type: 'confirm', name: 'saveLesson',
        message: 'Save this lesson for similar future tasks?', default: false
      }]);
      if (choice?.saveLesson) {
        try {
          selfImprovement.saveLesson(text, proposedLesson);
          console.log(chalk.green('Lesson saved locally.\n'));
        } catch (error) {
          console.log(chalk.yellow(`Could not save lesson: ${error.message}\n`));
        }
      }
    }
  }
}

module.exports = { startChat };
