'use strict';

const schedule = require('./index');

const EARLY_MS = 60_000;
const RETRY_MS = 5_000;
const ATTEMPTS = 3;

function start({ prepare, deliver, pending, failed, file, now = () => new Date(),
  canRun = () => true, onError = () => {} }) {
  const active = new Set();
  let stopped = false;

  function claim(job) {
    const jobs = schedule.load(file);
    const current = jobs.find((item) => item.id === job.id && item.nextRunAt === job.nextRunAt);
    if (!current) return false;
    const remaining = jobs.filter((item) => item.id !== job.id);
    if (job.recurrence === 'daily') {
      current.nextRunAt = schedule.nextRun(job.time, job.timeZone, now());
      remaining.push(current);
    }
    // Claim before delivery so a restart does not resend an already delivered message.
    schedule.save(remaining, file);
    return true;
  }

  async function run(job) {
    let ready = false;
    const result = (async () => {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (stopped) return null;
        try { return { answer: await prepare(job) }; }
        catch (error) {
          if (attempt === ATTEMPTS) return { error };
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    })().then((value) => { ready = true; return value; });

    const wait = Date.parse(job.nextRunAt) - now().getTime();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (stopped || !schedule.load(file).some((item) =>
      item.id === job.id && item.nextRunAt === job.nextRunAt)) return;
    if (!canRun()) { await result; return; }
    if (!ready) {
      try { await pending(job); } catch (error) { onError(error, job); }
    }
    const outcome = await result;
    if (stopped || !canRun() || !claim(job)) return;
    if (outcome.error) {
      onError(outcome.error, job);
      await failed(job);
    } else {
      await deliver(job, outcome.answer);
    }
  }

  async function tick() {
    if (stopped || !canRun()) return;
    let due;
    try {
      due = schedule.load(file)
        .filter((job) => Date.parse(job.nextRunAt) - now().getTime() <= EARLY_MS)
        .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
    } catch (error) { onError(error); return; }
    const started = [];
    for (const job of due) {
      if (active.has(job.id)) continue;
      active.add(job.id);
      const work = run(job).catch((error) => onError(error, job))
        .finally(() => active.delete(job.id));
      started.push(work);
    }
    await Promise.all(started);
  }

  const timer = setInterval(() => { void tick(); }, 1_000);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

module.exports = { start };
