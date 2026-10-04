'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const { askInput, printAboveInput } = require('../src/cli/ui/input');
const { startBusyFooter } = require('../src/cli/ui/busyFooter');

test('busy turn keeps the input frame and context footer below scrolling output', (t) => {
  const originalTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
  });
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 24;
  let output = '';
  stdout.on('data', (chunk) => { output += chunk.toString(); });

  const stop = startBusyFooter({ model: 'test-model', contextEstimate: 'ctx ~97.6% left' }, stdout);
  assert.match(output, /\x1b\[1;20r/);
  assert.match(stripVTControlCharacters(output), /Agent working… press Esc to stop/);
  assert.match(stripVTControlCharacters(output), /ctx ~97\.6% left.*→ test-model/);
  assert.equal(stdout.listenerCount('resize'), 1);

  stdout.rows = 30;
  stdout.emit('resize');
  assert.match(output, /\x1b\[1;26r/);
  stop();
  assert.match(output, /\x1b\[r\x1b\[27;1H\x1b\[0J/);
  assert.equal(stdout.listenerCount('resize'), 0);
  stdout.destroy();
});

test('busy footer leaves non-interactive output unchanged', () => {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 24;
  const stop = startBusyFooter({ model: 'test-model' }, stdout);
  assert.equal(stdout.read(), null);
  stop();
  stdout.destroy();
});

test('busy footer does not reserve rows when terminal height is unavailable', () => {
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  const stop = startBusyFooter({}, stdout);
  assert.equal(stdout.read(), null);
  stop();
  stdout.destroy();
});

test('Telegram notice redraws above active input without losing typed text', async () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = [];
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });

  try {
    const answer = askInput({ model: 'nemotron-3-ultra-550b-a55b' });
    stdin.emit('keypress', 'h', { name: 'h' });
    assert.equal(printAboveInput('Telegram: stopped'), true);
    stdin.emit('keypress', 'i', { name: 'i' });
    stdin.emit('keypress', '\r', { name: 'return' });
    assert.equal(await answer, 'hi');
    assert.equal(printAboveInput('later'), false);

    const rendered = output.join('');
    const notice = rendered.indexOf('Telegram: stopped');
    assert.ok(notice > 0);
    assert.match(rendered.slice(0, notice), /\x1b\[4A\r\x1b\[0J$/);
    assert.match(rendered.slice(notice), /Telegram: stopped\n[^]*╭/);
    assert.match(stripVTControlCharacters(rendered.slice(notice)), / › hi/);
  } finally {
    Object.defineProperty(process, 'stdin', originalStdin);
    Object.defineProperty(process, 'stdout', originalStdout);
    stdin.destroy();
    stdout.destroy();
  }
});
