'use strict';

const { loadConfig } = require('../../config/appConfig');
const providers = require('../providers');
const mcp = require('../mcp');
const telegram = require('../telegram');
const schedule = require('../schedule');
const scheduleRunner = require('../schedule/runner');
const memory = require('../memory');
const observability = require('../observability');
const guardrails = require('../guardrails');

async function startTelegramService(config = loadConfig()) {
  if (config.activeProvider !== providers.NVIDIA_ID &&
      !providers.customProviders(config).some((item) => item.id === config.activeProvider)) {
    throw new Error('The configured model provider is unavailable. Configure it locally before deployment.');
  }
  if (!providers.hasCredentials(config)) {
    throw new Error('Model credentials are missing. Set SUN2AGENT_PROVIDER, SUN2AGENT_MODEL, and SUN2AGENT_API_KEY.');
  }
  const telegramConfig = telegram.validateTelegramConfig(config.telegram);
  if (!telegramConfig.ok) {
    throw new Error('Telegram configuration is missing or invalid. Set SUN2AGENT_TELEGRAM_BOT_TOKEN and SUN2AGENT_TELEGRAM_CHAT_ID.');
  }

  let schedules;
  try {
    if (config.langsmith?.enabled && config.langsmithApiKey) {
      observability.enable(config.langsmithApiKey, config.langsmith.project || 'sun2agent');
    }
    if (config.memory?.enabled && !(await memory.enable())) {
      console.warn('Local memory could not initialize; continuing without it.');
    }

    const ready = mcp.connectRemoteFromConfig().then((results) => {
      for (const result of results) {
        if (!result.ok) console.warn(`Remote MCP ${result.name} unavailable; Telegram will continue without it.`);
      }
    });
    telegram.setMcpReady(ready);
    const connected = await telegram.sync(config);
    if (!connected.enabled) throw new Error('Telegram did not start. Check its configuration.');
    await ready;

    schedules = scheduleRunner.start({
      prepare: (job) => telegram.prepareScheduled(job),
      deliver: (job, answer) => telegram.sendScheduled(job.reminder
        ? `⏰ Reminder: ${answer}` : `⏰ Scheduled: ${job.task}\n\n${answer}`),
      pending: (job) => telegram.sendScheduled(`⏰ Scheduled: ${job.task}\nStill working; I’ll send the result when ready.`),
      failed: (job) => telegram.sendScheduled(`⚠ Scheduled task could not complete: ${job.task}`),
      canRun: () => telegram.validateTelegramConfig(config.telegram).ok,
      onError: (error) => console.error(`Scheduled task failed: ${guardrails.outputGuard(error?.message || String(error))}`)
    });

    console.log(`Sun2Agent Telegram service is running${connected.username ? ` as @${connected.username}` : ''}.`);
  } catch (error) {
    schedules?.stop();
    await telegram.stop();
    await mcp.disconnectAll();
    throw error;
  }

  let stopping;
  const stop = () => stopping ||= (async () => {
    schedules?.stop();
    await telegram.stop();
    await mcp.disconnectAll();
  })();
  void telegram.pollingStopped().then(() => {
    if (stopping) return;
    console.error('Telegram polling stopped unexpectedly; restarting the service.');
    process.exitCode = 1;
    void stop().catch(() => {});
  });
  return { stop };
}

module.exports = { startTelegramService };
