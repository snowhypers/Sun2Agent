'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const guardrails = require('../guardrails');
const { validateTelegramConfig } = require('../telegram/config');
const { isScheduleRequest, parsePrompt } = require('./parse');

const FILE = path.join(os.homedir(), '.sun2agent', 'schedules.json');

function load(file = FILE) {
  if (!fs.existsSync(file)) return [];
  const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(jobs)) throw new Error('schedules.json must contain an array.');
  return jobs;
}

function save(jobs, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(jobs, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}` };
}

function nextRun(time, timeZone, after = new Date(), day = 'next') {
  const now = after.getTime();
  const today = localParts(after, timeZone).date;
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const targetDate = day === 'today' ? today : day === 'tomorrow'
    ? tomorrow.toISOString().slice(0, 10) : null;
  // Scan wall-clock minutes so DST shifts respect the saved IANA timezone.
  for (let tick = Math.floor(now / 60000) * 60000 + 60000;
    tick < now + 72 * 60 * 60000; tick += 60000) {
    const local = localParts(new Date(tick), timeZone);
    if (local.time === time && (!targetDate || local.date === targetDate)) return new Date(tick).toISOString();
    if (targetDate && local.date > targetDate) break;
  }
  throw new Error(day === 'today' ? 'That time has already passed today.' :
    'That local time does not occur on the requested day.');
}

function create(text, config, options = {}) {
  const parsed = parsePrompt(text);
  if (parsed.error || parsed.missing) return parsed;
  if (!validateTelegramConfig(config?.telegram).ok) {
    return { error: 'Connect Telegram in /config before scheduling.' };
  }
  const verdict = guardrails.inputGuard(parsed.task);
  if (!verdict.ok) return { error: verdict.reason };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.now || new Date();
  let nextRunAt;
  try { nextRunAt = nextRun(parsed.time, timeZone, now, parsed.day); }
  catch (error) { return { error: error.message }; }
  const job = { id: randomUUID(), task: parsed.task, time: parsed.time,
    recurrence: parsed.recurrence, timeZone, nextRunAt,
    ...(parsed.reminder ? { reminder: true } : {}) };
  save([...load(options.file), job], options.file);
  return { job };
}

function remove(id, file = FILE) {
  const jobs = load(file);
  if (!jobs.some((job) => job.id === id)) return false;
  save(jobs.filter((job) => job.id !== id), file);
  return true;
}

function describe(job) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: job.timeZone,
    hour: 'numeric', minute: '2-digit' }).format(new Date(job.nextRunAt));
  const day = job.recurrence === 'daily' ? 'Daily' :
    new Intl.DateTimeFormat('en-US', { timeZone: job.timeZone,
      month: 'short', day: 'numeric' }).format(new Date(job.nextRunAt));
  return `${day} at ${when} (${job.timeZone}) → ${job.task} → Telegram`;
}

module.exports = { FILE, isScheduleRequest, parsePrompt, load, save, nextRun, create, remove, describe };
