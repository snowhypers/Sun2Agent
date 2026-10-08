'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveSummary, loadSavedSessions, sessionMemoryFile } = require('../src/core/memory/sessionMemory');
const { relevantSavedSession, addSavedSessionContext } = require('../src/core/sessions-management/save');
const { handleSave } = require('../src/cli/commands/save');
const { handleNew } = require('../src/cli/commands/new');
const { COMMANDS } = require('../src/cli/commands');
const axios = require('axios');
const { chatTurn } = require('../src/cli/turn');

test('saved task memory is private, workspace-scoped, and used only for relevant queries', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-saved-memory-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  saveSummary('Goal: implement Java CRUD tests. Progress: UserRepositoryTest written. Next: run Maven.', '/tmp/project-a');
  const file = sessionMemoryFile();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadSavedSessions().length, 1);
  assert.ok(relevantSavedSession('continue Java CRUD tests', '/tmp/project-a'));
  assert.equal(relevantSavedSession('continue Java CRUD tests', '/tmp/project-b'), null);
  assert.equal(relevantSavedSession('hello', '/tmp/project-a'), null);
  assert.match(addSavedSessionContext('BASE', 'fix Java CRUD tests', '/tmp/project-a'), /UserRepositoryTest written/);
  assert.equal(addSavedSessionContext('BASE', 'hello', '/tmp/project-a'), 'BASE');
  assert.throws(() => saveSummary('API key: abc123', '/tmp/project-a'), /sensitive/);
  const history = [{ role: 'user', content: 'new task' }];
  handleNew({ history });
  assert.equal(loadSavedSessions().length, 1);
});

test('/save previews the summary and writes only after approval', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-save-command-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  assert.equal(COMMANDS['/save'], handleSave);
  const history = [{ role: 'user', content: 'write a Java test' }];
  const draft = async () => 'Goal: write Java test. Next: run Maven.';
  await handleSave({ history, config: {}, draft, promptBack: async () => ({ saveSummary: false }) });
  assert.equal(loadSavedSessions().length, 0);
  await handleSave({ history, config: {}, draft, promptBack: async () => ({ saveSummary: true }) });
  assert.equal(loadSavedSessions().length, 1);
  await handleSave({ history, config: {}, draft: async () => 'API key: abc123',
    promptBack: async () => ({ saveSummary: true }) });
  assert.equal(loadSavedSessions().length, 1);
});

test('a later relevant turn receives one saved task memory as contextual data', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sun2agent-saved-context-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  saveSummary('Goal: finish Java CRUD tests. Progress: repository test written. Next: run Maven.', process.cwd());
  const originalPost = axios.post;
  let systemPrompt = '';
  axios.post = async (_url, body) => {
    systemPrompt = body.messages[0].content;
    return { data: { choices: [{ message: { role: 'assistant', content: 'I will inspect the tests.' } }] } };
  };
  try {
    const history = [{ role: 'user', content: 'continue the Java CRUD tests' }];
    assert.equal(await chatTurn({ apiKey: 'test', model: 'test' }, history), 'I will inspect the tests.');
    assert.match(systemPrompt, /Saved task memory for this workspace/);
    assert.match(systemPrompt, /repository test written/);
    assert.match(systemPrompt, /Check current files and state/);
  } finally { axios.post = originalPost; }
});
