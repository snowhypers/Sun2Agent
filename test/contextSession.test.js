'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const session = require('../src/core/context-management/session');
const { estimateContextTokens, contextLabel } = require('../src/core/context-management/contextMeter');
const { askInput } = require('../src/cli/ui/input');

test('context estimate includes system instructions, history and tool schemas', () => {
  const base = estimateContextTokens('instructions');
  const withHistory = estimateContextTokens('instructions', [{ role: 'user', content: 'hello' }]);
  const withTools = estimateContextTokens('instructions', [{ role: 'user', content: 'hello' }], [
    { type: 'function', function: { name: 'example', description: 'read a file' } }
  ]);
  assert.ok(base > 0);
  assert.ok(withHistory > base);
  assert.ok(withTools > withHistory);
  assert.ok(estimateContextTokens('AGENT.md, Skills, memory', [
    { role: 'tool', content: 'A file result' }
  ]) > base);
  assert.equal(contextLabel(75), 'ctx ~75 used');
  assert.equal(contextLabel(1250), 'ctx ~1.3k used');
  assert.equal(contextLabel(3200, { model: 'nvidia/nemotron-3-ultra-550b-a55b' }), 'ctx ~99.7% left');
  assert.equal(contextLabel(3200, { model: 'meta/muse-glimmer-30b' }), 'ctx ~97.6% left');
  assert.equal(contextLabel(100, { model: 'nvidia/nemotron-3-ultra-550b-a55b' }), 'ctx ~99.9% left');
  assert.equal(contextLabel(262144, { model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' }), 'ctx ~0.0% left');
  const custom = { activeProvider: 'custom', providers: [{ id: 'custom', activeModel: 'model-a',
    contextWindows: { 'model-a': 64000 } }] };
  assert.equal(contextLabel(3200, custom), 'ctx ~95.0% left');
  assert.equal(contextLabel(3200, { activeProvider: 'groq', providers: [{ id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1', activeModel: 'openai/gpt-oss-120b' }] }), 'ctx ~97.6% left');
  assert.equal(contextLabel(3200, { activeProvider: 'custom', providers: [{ id: 'custom', activeModel: 'model-a' }] }), 'ctx ~3.2k used');
});

test('/new archive saves chat privately and clears the resume snapshot', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-session-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  session.saveSession(messages);
  const archived = session.archiveSession(messages);
  assert.deepEqual(JSON.parse(fs.readFileSync(archived, 'utf8')).messages, messages);
  assert.equal(fs.statSync(archived).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(archived)).mode & 0o777, 0o700);
  session.clearSession();
  assert.equal(session.loadSession(), null);
  assert.ok(fs.existsSync(archived));
  assert.equal(session.archiveSession([]), null);
  assert.equal(fs.readdirSync(path.dirname(archived)).length, 1);
});

test('strict session clearing ignores missing snapshots but reports deletion failures', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-clear-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  assert.doesNotThrow(() => session.clearSession(true));
  fs.mkdirSync(path.dirname(session.sessionFile()), { recursive: true });
  fs.mkdirSync(session.sessionFile());
  assert.throws(() => session.clearSession(true));
});

test('input footer shows approximate context without hiding model', async (t) => {
  const oldIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const oldOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let rendered = '';
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.on('data', (chunk) => { rendered += chunk.toString(); });
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
  t.after(() => {
    Object.defineProperty(process, 'stdin', oldIn);
    Object.defineProperty(process, 'stdout', oldOut);
    stdin.destroy();
    stdout.destroy();
  });
  const answer = askInput({ model: 'test-model', contextEstimate: 'ctx ~97.6% left' });
  const footer = stripVTControlCharacters(rendered).trimEnd().split('\n').at(-1);
  stdin.emit('keypress', '\r', { name: 'return' });
  await answer;
  assert.match(footer, /ctx ~97\.6% left/);
  assert.match(footer, /→ test-model/);
  assert.ok(footer.length <= stdout.columns);
});
