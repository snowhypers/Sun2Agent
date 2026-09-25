'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { stripVTControlCharacters } = require('node:util');
const { askInput, printAboveInput } = require('../src/cli/ui/input');

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
