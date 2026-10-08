'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const session = require('../src/core/sessions-management/new');
const { repairInterruptedTools } = require('../src/core/sessions-management/continue');
const { handleNew } = require('../src/cli/commands/new');
const { handleContinue } = require('../src/cli/commands/continue');
const { COMMANDS } = require('../src/cli/commands');
const { estimateConversationTokens, tokenLabel } = require('../src/core/tracking/tokenMeter');
const { askInput } = require('../src/cli/ui/input');

test('conversation token estimate counts retained messages and resets with /new', () => {
  const history = [{ role: 'user', content: 'hello' }];
  assert.equal(estimateConversationTokens([]), 0);
  const first = estimateConversationTokens(history);
  assert.ok(first > 0);
  assert.ok(estimateConversationTokens([...history, { role: 'assistant', content: 'hi' }]) > first);
  assert.ok(estimateConversationTokens([...history, { role: 'tool', content: 'A file result' }]) > first);
  assert.equal(tokenLabel(0), 'chat ~0 tokens');
  assert.equal(tokenLabel(75), 'chat ~75 tokens');
  assert.equal(tokenLabel(1250), 'chat ~1.3k tokens');
  assert.equal(tokenLabel(3200), 'chat ~3.2k tokens');
});

test('/new clears the active chat and snapshot without creating an archive', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-session-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  session.saveSession(history);
  handleNew({ history });
  assert.deepEqual(history, []);
  assert.equal(session.loadSession(), null);
  assert.equal(fs.existsSync(path.join(home, '.sun2agent', 'sessions')), false);
});

test('/continue repairs a trailing interrupted tool batch without replaying tools', () => {
  const history = [{ role: 'user', content: 'edit file' },
    { role: 'assistant', tool_calls: [{ id: 'one' }, { id: 'two' }] },
    { role: 'tool', tool_call_id: 'one', content: 'done' }];
  assert.equal(repairInterruptedTools(history), 1);
  assert.equal(history.at(-1).tool_call_id, 'two');
  assert.match(history.at(-1).content, /Inspect current state/);
  assert.equal(repairInterruptedTools(history), 0);
});

test('/new and /continue handlers use the current session, not an archive', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-command-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  assert.equal(COMMANDS['/new'], handleNew);
  assert.equal(COMMANDS['/continue'], handleContinue);
  const history = [{ role: 'user', content: 'build a page' }];
  const result = handleContinue({ history });
  assert.match(result.prompt, /current unfinished task/);
  assert.equal(history.length, 1);
  session.saveSession(history);
  handleNew({ history });
  assert.equal(history.length, 0);
  assert.equal(handleContinue({ history }), undefined);
  assert.equal(history.length, 0);
  assert.equal(fs.existsSync(path.join(home, '.sun2agent', 'sessions')), false);
});

test('/continue can restore the current unfinished snapshot after a crash', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-crash-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  session.saveSession([{ role: 'user', content: 'unfinished task' }]);
  const history = [];
  assert.match(handleContinue({ history }).prompt, /current unfinished task/);
  assert.deepEqual(history, [{ role: 'user', content: 'unfinished task' }]);
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

test('input footer shows approximate conversation tokens without hiding model', async (t) => {
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
  const answer = askInput({ model: 'test-model', contextEstimate: 'chat ~3.2k tokens' });
  const footer = stripVTControlCharacters(rendered).trimEnd().split('\n').at(-1);
  stdin.emit('keypress', '\r', { name: 'return' });
  await answer;
  assert.match(footer, /chat ~3\.2k tokens/);
  assert.match(footer, /→ test-model/);
  assert.ok(footer.length <= stdout.columns);
});
