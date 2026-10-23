const chalk = require('chalk');

// Application services shared with other interfaces.
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
const schedule = require('../core/schedule');
const scheduleRunner = require('../core/schedule/runner');

// Interactive CLI presentation and command handling.
const { askInput, ESC_BACK } = require('./ui/input');
const { notify, flushNotices } = require('./ui/utils');
const { startTurnDisplay } = require('./ui/busyFooter');
const { watchEscape, waitEnterOrEsc } = require('./ui/escapeWatcher');
const { printBanner, printIntro } = require('./ui/banner');
const { COMMANDS, handleConfig } = require('./commands');
const codingMode = require('../core/coding/mode');
const codingWorkflow = require('../core/coding/workflow');

// Conversation lifecycle and model/tool turn helpers.
const { saveSession, loadSession, clearSession } = require('../core/sessions-management/new');
const { repairInterruptedTools } = require('../core/sessions-management/continue');
const { estimateConversationTokens, tokenLabel } = require('../core/tracking/tokenMeter');
const { cleanHistory, discardFailedTurn } = require('./runtime/history');
const { createTokenHandler, finalFlush } = require('./runtime/streaming');
const { chatTurn } = require('./turn');
const { resumeAfterModel500, isProviderRateLimit, providerRateLimitMessage } = require('./runtime/modelRecovery');
const { promptBack, printUserLine, sanitizeTerminalText } = require('./runtime/prompt');

// Check whether the Docker sandbox is enabled and Docker has gone down.
// The MCP command reuses this helper from the CLI runtime folder.
const { dockerDownWarning } = require('./runtime/dockerStatus');

async function syncTelegram(config) {
  try {
    // Telegram starts quietly like the other configured background services.
    // Keep failures visible so a broken connection is still diagnosable.
    return Boolean((await telegram.sync(config)).enabled);
  } catch (error) {
    notify(chalk.yellow(`⚠ Telegram could not start: ${error.message || 'connection failed'}`));
    return false;
  }
}

function estimateFooter(history) {
  return tokenLabel(estimateConversationTokens(cleanHistory(history)));
}

// --- Session persistence (Docker outage resume) -----------------------------
//
// The conversation history is saved to ~/.sun2agent/session.json after every
// completed exchange. The file lives in the config dir, which is bind-mounted
// into the sandbox container — so it survives the container dying when the
// Docker engine stops. When the host launcher relaunches the sandbox after
// Docker comes back, it sets SUN2AGENT_RESUME=1 and the agent restores the
// saved messages, continuing exactly where the user was interrupted.

// --- Empty-assistant-message hygiene is in src/cli/runtime/history.js ----------
// (imported at the top of this file)

// --- promptBack / printUserLine / sanitizeTerminalText -------------------------
// All three are in src/cli/runtime/prompt.js (imported at the top of this file).

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
  // Prepare the built-in filesystem tools in the background. The first input
  // box appears immediately; an ordinary chat turn waits for this connection
  // before offering tools to the model. Workspace access stays scoped to cwd.
  const workspaceReady = mcp.connectWorkspace().catch((error) => ({
    ok: false, error: error.message
  }));
  const userMcpReady = mcp.connectFromConfig().then((results) => {
    for (const result of results) {
      if (!result.ok) notify(chalk.yellow(`⚠ MCP ${result.name} unavailable: ${result.error}`));
    }
  }).catch((error) => notify(chalk.yellow(`⚠ MCP auto-connect failed: ${error.message}`)));
  telegram.setMcpReady(userMcpReady);
  let telegramReadyForSchedule = false;
  void syncTelegram(config).then((ready) => { telegramReadyForSchedule = ready; });
  const schedules = scheduleRunner.start({
    prepare: (job) => telegram.prepareScheduled(job),
    deliver: (job, answer) => telegram.sendScheduled(job.reminder
      ? `⏰ Reminder: ${answer}` : `⏰ Scheduled: ${job.task}\n\n${answer}`),
    pending: (job) => telegram.sendScheduled(`⏰ Scheduled: ${job.task}\nStill working; I’ll send the result when ready.`),
    failed: (job) => telegram.sendScheduled(`⚠ Scheduled task could not complete: ${job.task}`),
    canRun: () => telegramReadyForSchedule && telegram.validateTelegramConfig(config.telegram).ok,
    onError: (error) => notify(chalk.yellow(`⚠ Scheduled task failed: ${guardrails.outputGuard(error?.message || String(error))}`))
  });
  let workspaceWarningShown = false;
  let escReadyForMcp = false;

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
    const contextEstimate = estimateFooter(history);
    const input = await askInput({
      model: providers.getActiveModel(config),
      tag: mcp.getTag(),
      // Skills tag is shown in the chatbox footer (MCP-style) when any
      // skills are selected. The selected skills' content is injected
      // into the system prompt by turn.js, so the model applies them
      // automatically — no need to reference them in the typed message.
      skillTag: skills.getTag(config),
      modeTag: codingMode.isEnabled() ? '@codeMode' : '',
      contextEstimate
    });

    // Back out of opt-in features first; require a second Esc for automatic MCPs.
    if (input === ESC_BACK) {
      await userMcpReady;
      if (mcp.isComputerConnected()) {
        await mcp.disconnectComputer();
        escReadyForMcp = mcp.hasUserConnections();
        history.length = 0;
        console.log(chalk.gray('⎋ Disconnected /computer. Other plugins remain unchanged.\n'));
        continue;
      }
      if (mcp.isBrowserConnected()) {
        await mcp.disconnectBrowser();
        escReadyForMcp = mcp.hasUserConnections();
        console.log(chalk.gray('⎋ Disconnected /browser. Browser tools are unavailable.\n'));
        continue;
      }
      if (codingMode.isEnabled()) {
        codingMode.toggle();
        console.log(chalk.gray('⎋ Coding mode disabled. Back to normal chat.\n'));
        continue;
      }
      if (skills.getSelected(config).length) {
        try {
          saveConfig(skills.clearSelected(config));
        } catch (_) {
          /* best effort — the tag below still clears for this session */
        }
        config = loadConfig();
        escReadyForMcp = mcp.hasUserConnections();
        console.log(chalk.gray('⎋ Skills cleared. Back to simple chat.\n'));
        continue;
      }
      if (mcp.hasUserConnections()) {
        if (escReadyForMcp) {
          await mcp.disconnectUserServers();
          escReadyForMcp = false;
          console.log(chalk.gray('⎋ Disconnected @allMcps.\n'));
        } else {
          escReadyForMcp = true;
          console.log(chalk.gray('Press Esc again to disconnect @allMcps.\n'));
        }
      }
      continue;
    }
    escReadyForMcp = false;

    let text = input.trim();
    const visibleText = text;
    let approvedCodingPlan = null;
    let codingPlanEdit = null;
    if (!text) continue;

    // Commands do not reserve a busy footer, so echo them immediately.
    let handler = COMMANDS[text];
    if (text === '/continue' && codingMode.isEnabled() && (codingMode.getPendingPlan() || codingMode.hasInterruptedPlan())) {
      text = 'continue';
      handler = null;
    }
    if (text === '/new') codingMode.clearAll();

    // Command handling
    if (text === '/exit') {
      printUserLine(text);
      schedules?.stop();
      await telegram.stop();
      await workspaceReady;
      await userMcpReady;
      await mcp.stopProjectServer();
      await mcp.disconnectAll();
      clearSession(); // clean exit — nothing to resume next time
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    if (handler || visibleText === '/continue') printUserLine(visibleText);
    if (text === '/new' || text === '/continue' || text === '/save') {
      const result = await handler({ history, config, promptBack, loadConfig, saveConfig });
      if (!result?.prompt) continue;
      text = result.prompt;
    } else if (handler) {
      if (text === '/mcp' || text === '/browser' || text === '/computer' || text === '/computer disconnect') {
        await userMcpReady;
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
          telegramReadyForSchedule = false;
          telegramReadyForSchedule = await syncTelegram(config);
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

    const planDecision = codingMode.isEnabled() ? codingMode.decidePendingPlan(text) : null;
    if (planDecision) {
      if (planDecision.action === 'approve') {
        approvedCodingPlan = planDecision.plan;
        text = `${planDecision.plan.task}\n\nImplement this user-approved plan without expanding its scope:\n${planDecision.plan.plan}`;
      } else if (planDecision.action === 'resume') {
        approvedCodingPlan = planDecision.plan;
        const guidance = planDecision.userGuidance ? `User guidance for this retry: ${planDecision.userGuidance}\n\n` : '';
        text = `Resume implementing the approved plan for "${planDecision.plan.task}" exactly where it stopped or failed.\n\n${guidance}Check the current workspace state first; do not recreate files that already exist unless they need edits. Pick up from the current state and complete the remaining implementation and verification steps.\n\nApproved plan:\n${planDecision.plan.plan}`;
      } else if (planDecision.action === 'edit') {
        codingPlanEdit = planDecision.plan;
        text = `Revise the proposed plan for this task only.\nOriginal task: ${planDecision.plan.task}\nUser's requested plan change: ${planDecision.instruction || 'Please suggest an improved version.'}\nCurrent plan:\n${planDecision.plan.plan}`;
      } else if (planDecision.action === 'cancel') {
        console.log(chalk.gray('Coding plan discarded. No project changes were made.\n'));
        continue;
      } else {
        console.log(chalk.yellow('Review the pending plan: type “continue” to implement, “edit plan: …” to revise, or “cancel”.\n'));
        continue;
      }
    }

    if (schedule.isScheduleRequest(text)) {
      printUserLine(text);
      try {
        const result = schedule.create(text, config);
        const message = result.job ? `✔ Scheduled: ${schedule.describe(result.job)}` :
          result.error || `I need ${result.missing.join(', ')} to schedule this task.`;
        console.log((result.job ? chalk.green : chalk.yellow)(message) + '\n');
      } catch (error) {
        console.log(chalk.red(`Could not save schedule: ${error.message}\n`));
      }
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

    const busyContext = estimateFooter(history);
    const stopBusyFooter = startTurnDisplay(visibleText, {
      model: providers.getActiveModel(config),
      tag: mcp.getTag(),
      skillTag: skills.getTag(config),
      modeTag: codingMode.isEnabled() ? '@codeMode' : '',
      contextEstimate: busyContext
    });

    const controller = new AbortController();
    // Streaming render layer lives in src/cli/runtime/streaming.js. See the file for
    // the held-back-tail invariant and the secret-mask timing.
    const stream = createTokenHandler(guardrails);
    const onToken = stream.onToken;
    const onToolTurn = stream.onToolTurn;
    const stopWatch = watchEscape(() => controller.abort());
    let proposedLesson = null;
    let turnError = null;
    try {
      const workspaceResult = await workspaceReady;
      await userMcpReady;
      stopBusyFooter.updateContext?.(estimateFooter(history));
      if (!workspaceResult.ok && !workspaceWarningShown) {
        workspaceWarningShown = true;
        console.log(chalk.yellow(`⚠ Workspace tools unavailable: ${workspaceResult.error}\n`));
      }
      let reply = await resumeAfterModel500(
        () => chatTurn(config, history, controller.signal, onToken, onToolTurn,
          (snapshot) => saveSession(cleanHistory(snapshot)), {
            codingMode: codingMode.isEnabled(),
            approvedPlan: Boolean(approvedCodingPlan),
            pendingPlan: codingPlanEdit,
            planReviewOnly: Boolean(codingPlanEdit)
          }),
        {
          signal: controller.signal,
          onRetry: () => {
            onToolTurn();
            console.log(chalk.yellow('Model unavailable — resuming once from saved tool progress...'));
          }
        }
      );
      if (codingPlanEdit && !controller.signal.aborted) {
        if (reply && codingWorkflow.hasPlanHeading(reply)) {
          codingMode.setPendingPlan({ task: codingPlanEdit.task, plan: reply.trim() });
          reply += '\n\nUpdated plan is awaiting approval. Type “continue” to implement it, edit it again, or cancel.';
        } else {
          reply = `${reply || ''}\n\nI could not identify a revised plan, so the previous plan is still pending. Type “edit plan: …” or “continue”.`;
        }
      }
      if (controller.signal.aborted) {
        if (codingMode.isEnabled() && approvedCodingPlan) {
          codingMode.markInterrupted();
        }
        turnError = chalk.gray('⎋ stopped');
      } else {
        if (codingMode.isEnabled() && approvedCodingPlan) {
          codingMode.markCompleted();
        }
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
      if (codingMode.isEnabled() && approvedCodingPlan) {
        codingMode.markInterrupted();
      }
      const rateLimited = isProviderRateLimit(err);
      if (!rateLimited) discardFailedTurn(history, turnStart);
      repairInterruptedTools(history);
      saveSession(cleanHistory(history));
      if (controller.signal.aborted) {
        turnError = chalk.gray('⎋ stopped');
      } else if (rateLimited) {
        turnError = chalk.yellow(providerRateLimitMessage(err));
      } else {
        turnError = chalk.red('Error: ' + err.message);
      }
    } finally {
      stopWatch();
      stopBusyFooter();
      const cleanup = await Promise.allSettled([
        mcp.disconnectCodingBrowser(),
        mcp.stopProjectServer()
      ]);
      for (const result of cleanup) {
        if (result.status === 'rejected') {
          console.log(chalk.yellow(`Coding cleanup warning: ${result.reason?.message || result.reason}`));
        }
      }
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
