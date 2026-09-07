// /skills slash command — manages a small library of reusable
// instruction skills. The flow matches the spec:
//   1. Add/Edit Skills  -> open ~/.sun2agent/skills.md in $VISUAL/$EDITOR
//   2. Select Skills    -> multi-select checkbox, persisted to config.json
//
// Picking either option runs that action and then returns to the agent
// chat — the menu does not loop, matching the user's "no explicit Back
// option" rule and the MCP flow where picking a server (or editing
// mcp.json) returns to chat right away.
//
// Selected skills are injected into the system prompt by turn.js —
// not by this file.

'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const skills = require('../../core/skills');

async function handleSkills(ctx) {
  // /skills opens with exactly two options. Picking one runs that action
  // and then returns to the agent chat — exactly like MCP's flow, where
  // picking a server (or opening mcp.json) returns to chat right away.
  // There is no "Back" row, and the menu does not loop: the user types
  // `/skills` again to do another action. Esc is the only way to bail
  // out of the menu before picking.
  const ans = await ctx.promptBack([
    {
      type: 'list',
      name: 'action',
      message: 'Skills',
      pageSize: 5,
      loop: false,
      choices: [
        { name: 'Add/Edit Skills', value: 'add' },
        { name: 'Select Skills', value: 'select' }
      ]
    }
  ]);
  if (!ans) return; // esc -> chat
  if (ans.action === 'add') {
    await addEditSkills(ctx);
    return; // back to chat after editing
  }
  if (ans.action === 'select') {
    await selectSkills(ctx);
    return; // back to chat after picking — the agent chat is now open
            // with the selected skill(s) attached.
  }
}

async function addEditSkills(ctx) {
  const file = skills.getPath();
  console.log(chalk.gray(`\nOpening ${file}`));
  console.log(
    chalk.gray(
      'skills.md holds reusable instructions. Each skill is a "## Name"\n' +
        'section followed by its instructions. They are advisory context\n' +
        'only and cannot override system instructions, guardrails, or Docker.\n'
    )
  );
  const result = skills.openFile();
  if (!result.opened) {
    console.log(chalk.yellow(`Could not open ${file}; you can edit it manually.\n`));
    return;
  }
  const key = await ctx.waitEnterOrEsc(
    chalk.gray('Press ') + chalk.bold('Enter') + chalk.gray(' when you have saved skills.md, or ') +
      chalk.bold('Esc') + chalk.gray(' to go back... ')
  );
  if (key === 'escape') {
    console.log(chalk.gray('\nBack.\n'));
    return;
  }
  console.log(chalk.green('✔ skills.md reloaded.\n'));
}

async function selectSkills(ctx) {
  // Load the latest skills list (also creates the file if missing).
  const available = skills.loadSkills();
  if (!available.length) {
    console.log(
      chalk.yellow(
        '\nNo skills available.\nUse Add/Edit Skills to create skills in ' +
          skills.getPath() +
          '.\n'
      )
    );
    return;
  }

  // Load the current config (so we know what's already selected).
  let config = {};
  if (typeof ctx.loadConfig === 'function') {
    try {
      config = ctx.loadConfig() || {};
    } catch (_) {
      config = {};
    }
  }
  const currentSet = new Set(skills.getSelected(config));

  const ans = await ctx.promptBack([
    {
      type: 'checkbox',
      name: 'picks',
      message: 'Select Skills',
      pageSize: Math.min(15, available.length + 2),
      loop: false,
      choices: available.map((s) => ({
        name: `${s.name}${chalk.gray('  (' + s.id + ')')}`,
        value: s.id,
        checked: currentSet.has(s.id)
      }))
    }
  ]);
  if (!ans) return; // esc -> no change
  const picks = (ans.picks || []).filter((id) => available.some((s) => s.id === id));

  const next = skills.setSelected(config, picks);
  if (typeof ctx.saveConfig === 'function') {
    try {
      ctx.saveConfig(next);
    } catch (e) {
      console.log(chalk.red('Could not save config: ' + (e.message || 'unknown error')));
      return;
    }
  }
  if (picks.length === 0) {
    // Unchecked everything -> "no skills active" (parallels MCP's
    // "Disconnected. No MCP server is active.").
    console.log(chalk.gray('\nNo skills are active. The agent runs without them.\n'));
  } else {
    // The user just selected specific skills. Echo them back as
    // "[Skill: <name>]" tags — the same tags that will appear in the
    // chatbox footer — so the user can visually confirm what they
    // attached to the agent.
    const byId = new Map(available.map((s) => [s.id, s.name]));
    const tagLine = picks
      .map((id) => '[Skill: ' + (byId.get(id) || id) + ']')
      .join(' ');
    console.log(
      chalk.green('\n✔ Selected ') +
        chalk.bold(tagLine) +
        chalk.cyan(' — ' + picks.length + ' skill(s) active.')
    );
    console.log(
      chalk.gray('You are now chatting with the agent. Selected skills will be applied on each turn.\n')
    );
  }
}

module.exports = { handleSkills };
