'use strict';

const chalk = require('chalk');
const schedule = require('../../core/schedule');

async function handleSchedule(ctx) {
  let jobs;
  try { jobs = schedule.load(); }
  catch (error) { console.log(chalk.red(`Cannot read schedules: ${error.message}\n`)); return; }
  if (!jobs.length) {
    console.log(chalk.gray('No schedules yet. Try: Every day at 9 PM, summarize AI news and send it to Telegram.\n'));
    return;
  }
  const picked = await ctx.promptBack([{ type: 'list', name: 'id', message: 'Schedules',
    choices: [...jobs.map((job) => ({ name: schedule.describe(job), value: job.id })),
      { name: 'Back', value: 'back' }] }]);
  if (!picked || picked.id === 'back') return;
  const job = jobs.find((item) => item.id === picked.id);
  if (!job) return;
  const action = await ctx.promptBack([{ type: 'list', name: 'action',
    message: schedule.describe(job), choices: ['Details', 'Delete', 'Back'] }]);
  if (!action || action.action === 'Back') return;
  if (action.action === 'Details') {
    console.log(chalk.cyan(`\n${schedule.describe(job)}\nNext run: ${job.nextRunAt}\n`));
    return;
  }
  const answer = await ctx.promptBack([{ type: 'confirm', name: 'confirm', default: false,
    message: `Delete this schedule? ${job.task}` }]);
  if (answer?.confirm) {
    schedule.remove(job.id);
    console.log(chalk.green('✔ Schedule deleted.\n'));
  }
}

module.exports = { handleSchedule };
