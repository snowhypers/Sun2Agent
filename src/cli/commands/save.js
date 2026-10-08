const chalk = require('chalk');
const guardrails = require('../../core/guardrails');
const { draftSessionSummary, saveSummary, hasSensitiveSummary } = require('../../core/memory/sessionMemory');
const { sanitizeTerminalText } = require('../prompt');

async function handleSave({ history, config, promptBack, draft = draftSessionSummary, save = saveSummary }) {
  if (!history?.some((item) => item.role === 'user')) {
    console.log(chalk.yellow('No conversation to save yet.\n'));
    return;
  }
  try {
    const summary = await draft(config, history);
    if (summary.length > 2000 || hasSensitiveSummary(summary) ||
        guardrails.sanitizeOutput(summary) !== summary) {
      console.log(chalk.yellow('Summary may contain sensitive data or is too long. Nothing was saved.\n'));
      return;
    }
    console.log(chalk.gray(`\nDraft session memory:\n${sanitizeTerminalText(summary)}\n`));
    const choice = await promptBack([{
      type: 'confirm', name: 'saveSummary', message: 'Save this session memory?', default: false
    }]);
    if (!choice?.saveSummary) {
      console.log(chalk.gray('Session memory discarded.\n'));
      return;
    }
    save(summary, process.cwd());
    console.log(chalk.green('Session memory saved for this workspace.\n'));
  } catch (error) {
    console.log(chalk.red(`Could not save session memory: ${error.message}\n`));
  }
}

module.exports = { handleSave };
