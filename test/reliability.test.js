'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const schedule = require('../src/core/schedule');
const runner = require('../src/core/schedule/runner');
const registry = require('../src/core/mcp/registry');
const { pollLoop } = require('../src/core/telegram/polling');

test('MCP tool names remain unique after sanitizing', () => {
  const entry = { tools: [{ name: 'get.data' }], builtin: false };
  registry.set('a.b', entry);
  registry.set('a_b', entry);
  try {
    const { specs, routes } = registry.getOpenAiTools();
    assert.equal(specs.length, 2);
    assert.equal(routes.size, 2);
    assert.deepEqual([...routes.values()].map((route) => route.server), ['a.b', 'a_b']);
  } finally {
    registry.deleteByName('a.b');
    registry.deleteByName('a_b');
  }
});

test('failed Telegram delivery preserves a prepared schedule across restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const now = new Date('2026-10-10T10:01:00Z');
  schedule.save([{ id: 'once', task: 'research', recurrence: 'once', time: '15:30',
    timeZone: 'Asia/Kolkata', nextRunAt: '2026-10-10T10:00:00Z' }], file);
  const first = runner.start({ file, now: () => now, prepare: async () => 'finished answer',
    deliver: async () => { throw new Error('Telegram unavailable'); },
    pending: async () => {}, failed: async () => {} });
  await first.tick();
  await new Promise((resolve) => setImmediate(resolve));
  first.stop();
  assert.equal(schedule.load(file)[0].preparedAnswer, 'finished answer');
  let delivered;
  const second = runner.start({ file, now: () => new Date(now.getTime() + 61_000),
    prepare: async () => { throw new Error('must reuse answer'); },
    deliver: async (_job, answer) => { delivered = answer; },
    pending: async () => {}, failed: async () => {} });
  await second.tick();
  await new Promise((resolve) => setImmediate(resolve));
  second.stop();
  assert.equal(delivered, 'finished answer');
  assert.deepEqual(schedule.load(file), []);
});

test('Telegram persists an update before confirming its offset and replays it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-poll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pendingFile = path.join(dir, 'pending.json');
  const update = { update_id: 7, message: { text: 'hello' } };
  let calls = 0;
  const runtime = { running: true, offset: 0, pendingFile,
    config: { telegram: { botToken: 'test' } },
    http: { post: async () => {
      calls++;
      if (calls === 2) runtime.running = false;
      return { data: { ok: true, result: calls === 1 ? [update] : [] } };
    } },
    handleUpdate: () => new Promise(() => {}), onError: (error) => { throw error; } };
  await pollLoop(runtime, new AbortController().signal);
  assert.equal(JSON.parse(fs.readFileSync(pendingFile)).pending.length, 1);
  let replayed = 0;
  const restarted = { ...runtime, running: true, offset: 0,
    http: { post: async () => { restarted.running = false;
      return { data: { ok: true, result: [] } }; } },
    handleUpdate: async () => { replayed++; } };
  await pollLoop(restarted, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.offset, 8);
  assert.equal(replayed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile)).pending, []);
});

test('malformed config is never silently replaced', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.sun2agent', 'config.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  const modulePath = path.join(__dirname, '..', 'src/config/appConfig.js');
  const script = `const c=require(${JSON.stringify(modulePath)}); try { c.loadConfig(); process.exit(2); } catch(e) { if (!e.message.includes('Cannot load')) process.exit(3); }`;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: dir } });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
