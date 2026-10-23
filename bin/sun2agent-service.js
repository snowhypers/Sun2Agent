#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { getDataDir } = require('../src/core/deployment/dataDir');

process.env.SUN2AGENT_AGENT_MD ||= path.join(getDataDir(), 'AGENT.md');

const { startTelegramService } = require('../src/core/deployment/telegramService');
const guardrails = require('../src/core/guardrails');

startTelegramService().then(({ stop }) => {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}).catch((error) => {
  console.error(`Sun2Agent service failed: ${guardrails.outputGuard(error?.message || String(error))}`);
  process.exitCode = 1;
});
