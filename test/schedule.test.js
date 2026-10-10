'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schedule = require('../src/core/schedule');
const runner = require('../src/core/schedule/runner');

const telegram = { enabled: true,
  botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDE', chatId: '123456789' };

test('schedule prompt requires task, time, recurrence and rejects contradictions', () => {
  assert.equal(schedule.isScheduleRequest('Every day I read at 9 PM?'), false);
  assert.equal(schedule.isScheduleRequest('Today top 3 AI news'), false);
  assert.equal(schedule.isScheduleRequest('Every day at 9 PM, summarize AI news'), true);
  assert.deepEqual(schedule.parsePrompt('Every day at 9 PM, summarize today’s AI news and send it to Telegram'), {
    task: 'summarize today’s AI news', time: '21:00', recurrence: 'daily', day: 'next'
  });
  assert.deepEqual(schedule.parsePrompt('Today at 8 PM, check email'), {
    task: 'check email', time: '20:00', recurrence: 'once', day: 'today'
  });
  assert.deepEqual(schedule.parsePrompt('Every day at 9 PM, summarize today AI news').recurrence, 'daily');
  assert.equal(schedule.parsePrompt('Every day at 9 PM, summarize today AI news').task,
    'summarize today AI news');
  assert.deepEqual(schedule.parsePrompt('At 9 PM, summarize AI news').missing,
    ['recurrence (once or daily)']);
  assert.match(schedule.parsePrompt('Every morning at 9 PM, research AI news').error, /conflicts/);
  assert.deepEqual(schedule.parsePrompt('Daily at 9 PM').missing, ['task']);
  assert.match(schedule.parsePrompt('Daily at 9 PM, delete my email').error, /read-only/);
});

test('misspelled schedule reminder keeps its quoted message and today time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const prompt = 'sehedule a work reminder me at today 1:10 am on telegram " today is my dace job happen"';
  assert.equal(schedule.isScheduleRequest(prompt), true);
  assert.deepEqual(schedule.parsePrompt(prompt), {
    task: 'today is my dace job happen', time: '01:10', recurrence: 'once',
    day: 'today', reminder: true
  });
  const now = new Date(2026, 9, 11, 1, 7);
  const result = schedule.create(prompt, { telegram }, { file, now });
  assert.equal(result.job?.reminder, true);
  assert.equal(result.job?.task, 'today is my dace job happen');
  assert.equal(Date.parse(result.job.nextRunAt) - now.getTime(), 3 * 60_000);
  assert.equal(schedule.parsePrompt('Schedule a reminder today at 1:10 AM: "Take a break"').task,
    'Take a break');
});

test('schedule saves locally with timezone and survives reload, then deletes only selected job', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-schedule-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const now = new Date('2026-10-10T00:00:00Z');
  const first = schedule.create('Every day at 9 PM, summarize AI news and send it to Telegram',
    { telegram }, { file, now });
  assert.ok(first.job);
  assert.equal(first.job.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const second = schedule.create('Once at 8 PM, check email', { telegram }, { file, now });
  assert.equal(schedule.load(file).length, 2);
  assert.match(schedule.describe(first.job), /Daily at 9:00 PM.*Telegram/);
  assert.equal(schedule.remove(first.job.id, file), true);
  assert.deepEqual(schedule.load(file).map((job) => job.id), [second.job.id]);
  assert.equal(schedule.create('Daily at 9 PM, summarize news', { telegram: { enabled: false } },
    { file, now }).error, 'Connect Telegram in /config before scheduling.');
});

test('schedule computes next daily time in the saved timezone', () => {
  assert.equal(schedule.nextRun('21:00', 'Asia/Kolkata',
    new Date('2026-10-10T10:00:00Z')), '2026-10-10T15:30:00.000Z');
  assert.throws(() => schedule.nextRun('09:00', 'Asia/Kolkata',
    new Date('2026-10-10T10:00:00Z'), 'today'), /passed today/);
});

test('runner claims a due one-time job before delivery and advances daily jobs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-schedule-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const dueAt = '2026-10-10T10:00:00.000Z';
  schedule.save([
    { id: 'once', task: 'check mail', recurrence: 'once', time: '15:30',
      timeZone: 'Asia/Kolkata', nextRunAt: dueAt },
    { id: 'daily', task: 'research news', recurrence: 'daily', time: '15:30',
      timeZone: 'Asia/Kolkata', nextRunAt: dueAt }
  ], file);
  const seen = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const service = runner.start({ file, now: () => new Date('2026-10-10T10:01:00Z'),
    prepare: async (job) => job.id,
    deliver: async (job) => { seen.push(job.id); if (seen.length === 2) finish(); },
    pending: async () => {}, failed: async () => {} });
  t.after(() => service.stop());
  await completed;
  assert.deepEqual(seen, ['once', 'daily']);
  const remaining = schedule.load(file);
  assert.deepEqual(remaining.map((job) => job.id), ['daily']);
  assert.ok(Date.parse(remaining[0].nextRunAt) > Date.parse(dueAt));
  await new Promise((resolve) => setImmediate(resolve));
  await service.tick();
  assert.deepEqual(seen, ['once', 'daily']);
});

test('runner keeps due jobs when Telegram is not configured', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-schedule-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  schedule.save([{ id: 'later', task: 'research', recurrence: 'once', time: '09:00',
    timeZone: 'Asia/Kolkata', nextRunAt: '2026-10-10T00:00:00Z' }], file);
  const service = runner.start({ file, canRun: () => false,
    prepare: async () => { throw new Error('must not run'); } });
  t.after(() => service.stop());
  await service.tick();
  assert.equal(schedule.load(file).length, 1);
});

test('runner prepares early but delivers only at the scheduled time', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-schedule-early-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const due = Date.now() + 80;
  schedule.save([{ id: 'early', task: 'news', recurrence: 'once', time: '09:00',
    timeZone: 'Asia/Kolkata', nextRunAt: new Date(due).toISOString() }], file);
  let prepared = false;
  let deliveredAt;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const service = runner.start({ file, prepare: async () => { prepared = true; return 'ready'; },
    deliver: async (_job, answer) => { assert.equal(answer, 'ready'); deliveredAt = Date.now(); finish(); },
    pending: async () => { throw new Error('answer was ready'); }, failed: async () => {} });
  t.after(() => service.stop());
  await completed;
  assert.equal(prepared, true);
  assert.ok(deliveredAt >= due);
  assert.deepEqual(schedule.load(file), []);
});

test('runner retries a failed preparation and sends an on-time status while working', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-schedule-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const due = Date.now() + 50;
  schedule.save([{ id: 'retry', task: 'news', recurrence: 'once', time: '09:00',
    timeZone: 'Asia/Kolkata', nextRunAt: new Date(due).toISOString() }], file);
  const events = [];
  let attempts = 0;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const service = runner.start({ file,
    prepare: async () => { if (++attempts === 1) throw new Error('temporary model failure'); return 'recovered'; },
    pending: async () => { events.push(['pending', Date.now()]); },
    deliver: async (_job, answer) => { events.push(['delivered', answer]); finish(); },
    failed: async () => { throw new Error('should recover'); } });
  t.after(() => service.stop());
  await completed;
  assert.equal(attempts, 2);
  assert.deepEqual(events.map(([event]) => event), ['pending', 'delivered']);
  assert.ok(events[0][1] >= due);
  assert.equal(events[1][1], 'recovered');
  assert.deepEqual(schedule.load(file), []);
});

test('schedule command is registered and accessible from help', () => {
  assert.equal(typeof require('../src/cli/commands').COMMANDS['/schedule'], 'function');
  const help = fs.readFileSync(path.join(__dirname, '..', 'src/cli/ui/banner.js'), 'utf8');
  assert.match(help, /row\('\/schedule'/);
});

test('/schedule lists a job and deletes it only after confirmation', async () => {
  const { handleSchedule } = require('../src/cli/commands/schedule');
  const originalLoad = schedule.load;
  const originalRemove = schedule.remove;
  const originalLog = console.log;
  const job = { id: 'job-1', task: 'research news', recurrence: 'daily', time: '09:00',
    timeZone: 'Asia/Kolkata', nextRunAt: '2026-10-11T03:30:00Z' };
  let removed = 0;
  schedule.load = () => [job];
  schedule.remove = () => { removed++; return true; };
  console.log = () => {};
  try {
    const answers = [{ id: job.id }, { action: 'Delete' }, { confirm: false }];
    await handleSchedule({ promptBack: async () => answers.shift() });
    assert.equal(removed, 0);
    answers.push({ id: job.id }, { action: 'Delete' }, { confirm: true });
    await handleSchedule({ promptBack: async () => answers.shift() });
    assert.equal(removed, 1);
  } finally {
    schedule.load = originalLoad;
    schedule.remove = originalRemove;
    console.log = originalLog;
  }
});
