'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RESPONSE_STYLE } = require('../src/core/rules/responseStyle');
const { BASE_SYSTEM_PROMPT } = require('../src/cli/turn');

test('response style is shared by terminal and Telegram model prompts', () => {
  assert.ok(BASE_SYSTEM_PROMPT.includes(RESPONSE_STYLE));
  const telegramTurn = fs.readFileSync(path.join(__dirname, '../src/core/telegram/turn.js'), 'utf8');
  assert.match(telegramTurn, /require\(['"]\.\.\/rules\/responseStyle['"]\)/);
  assert.match(telegramTurn, /RESPONSE_STYLE/);
  assert.match(RESPONSE_STYLE, /Markdown table/);
  assert.match(RESPONSE_STYLE, /For top-N rankings, use one table with one entity per row/);
  assert.match(RESPONSE_STYLE, /never combine alternatives with “\/” or “or”/);
  assert.match(RESPONSE_STYLE, /show fewer verified rows rather than guessing/);
  assert.match(RESPONSE_STYLE, /Attribute subjective rankings to a named index/);
  assert.match(RESPONSE_STYLE, /write Markdown without escape backslashes/);
  assert.match(RESPONSE_STYLE, /Return JSON only when requested or when a schema is supplied/);
});
