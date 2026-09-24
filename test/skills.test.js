// Test suite for the /skills feature and the skills.md parser.
// Run with: npm test (picked up via the test/*.test.js glob).
//
// All tests use node:test + node:assert. Each test creates a tmp HOME
// so config and skills files can't leak between cases.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PassThrough } = require('node:stream');
const { askInput } = require('../src/cli/ui/input');

const PROJECT = path.join(__dirname, '..');
const skills = require('../src/core/skills');
const skillsMd = require('../src/core/skills/skillsMd');

// --- helpers ---------------------------------------------------------------

let counter = 0;
function tmpHome() {
  const dir = path.join(os.tmpdir(), `sun2agent-skills-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkills(home, text) {
  const file = path.join(home, '.sun2agent', 'skills.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// Run `fn` with `os.homedir()` patched to `home` and the relevant modules
// freshly required (so appConfig's CONFIG_FILE constant resolves against
// the patched home). Mirrors the pattern in test/memory.test.js.
//
// `fn` receives fresh references to loadConfig/saveConfig and to the
// skills modules so it can use them without re-binding to a cached
// closure.
function withHome(home, fn) {
  const original = os.homedir;
  os.homedir = () => home;
  const appConfigPath = require.resolve('../src/config/appConfig');
  const skillsPath = require.resolve('../src/core/skills');
  const skillsMdPath = require.resolve('../src/core/skills/skillsMd');
  delete require.cache[appConfigPath];
  delete require.cache[skillsPath];
  delete require.cache[skillsMdPath];
  try {
    const freshApp = require('../src/config/appConfig');
    const freshSkills = require('../src/core/skills');
    const freshSkillsMd = require('../src/core/skills/skillsMd');
    return fn({
      loadConfig: freshApp.loadConfig,
      saveConfig: freshApp.saveConfig,
      skills: freshSkills,
      skillsMd: freshSkillsMd
    });
  } finally {
    os.homedir = original;
    delete require.cache[appConfigPath];
    delete require.cache[skillsPath];
    delete require.cache[skillsMdPath];
  }
}

// --- skills.md file lifecycle ---------------------------------------------

test('skills: skills.md is created when missing', () => {
  const home = tmpHome();
  const file = withHome(home, () => skills.ensureFile());
  assert.ok(fs.existsSync(file));
  const onDisk = fs.readFileSync(file, 'utf-8');
  assert.ok(onDisk.includes('# Sun2Agent Skills'));
  assert.ok(onDisk.includes('## Skill Name'));
});

test('skills: starter template is the documented example', () => {
  assert.match(skillsMd.SKILLS_STARTER, /Add skills using this format/);
  assert.match(skillsMd.SKILLS_STARTER, /## Skill Name/);
});

test('skills: ensureFile does not overwrite an existing file', () => {
  const home = tmpHome();
  const file = writeSkills(home, '## My Skill\ncustom content\n');
  withHome(home, () => skills.ensureFile());
  const onDisk = fs.readFileSync(file, 'utf-8');
  assert.ok(onDisk.includes('custom content'));
  assert.ok(!onDisk.includes('# Sun2Agent Skills'));
});

// --- parser ----------------------------------------------------------------

test('skills: parseSkills extracts ## Skill Name headings', () => {
  const result = skillsMd.parseSkills(
    '## Foo\nDo foo things.\n\n## Bar\nDo bar things.\n'
  );
  assert.deepStrictEqual(result.map((s) => s.id), ['foo', 'bar']);
  assert.deepStrictEqual(result.map((s) => s.name), ['Foo', 'Bar']);
  assert.strictEqual(result[0].content, 'Do foo things.');
  assert.strictEqual(result[1].content, 'Do bar things.');
});

test('skills: parseSkills preserves order across multiple skills', () => {
  const result = skillsMd.parseSkills(
    '## Alpha\na\n\n## Beta\nb\n\n## Gamma\nc\n'
  );
  assert.deepStrictEqual(result.map((s) => s.id), ['alpha', 'beta', 'gamma']);
  assert.deepStrictEqual(result.map((s) => s.content), ['a', 'b', 'c']);
});

test('skills: parseSkills normalizes ids (lowercase, dashes)', () => {
  const result = skillsMd.parseSkills('## Code Style!\nMake it clean.\n');
  assert.strictEqual(result[0].id, 'code-style');
  assert.strictEqual(result[0].name, 'Code Style!');
});

test('skills: parseSkills drops skills with empty content', () => {
  const result = skillsMd.parseSkills('## Foo\n\n## Bar\ncontent\n');
  assert.deepStrictEqual(result.map((s) => s.id), ['bar']);
});

test('skills: parseSkills drops skills that normalize to empty id', () => {
  const result = skillsMd.parseSkills('## !!!\nstuff\n## Real\nreal\n');
  assert.deepStrictEqual(result.map((s) => s.id), ['real']);
});

test('skills: parseSkills de-duplicates by id (first wins)', () => {
  const result = skillsMd.parseSkills(
    '## Coding\nfirst\n\n## coding\nduplicate\n'
  );
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].content, 'first');
});

test('skills: parseSkills returns [] for empty / non-string input', () => {
  assert.deepStrictEqual(skillsMd.parseSkills(''), []);
  assert.deepStrictEqual(skillsMd.parseSkills(null), []);
  assert.deepStrictEqual(skillsMd.parseSkills(undefined), []);
});

test('skills: parseSkills returns [] when there are no headings', () => {
  assert.deepStrictEqual(skillsMd.parseSkills('just a paragraph\nno headings here'), []);
});

test('skills: loadSkills returns the saved file content', () => {
  const home = tmpHome();
  writeSkills(
    home,
    '## Coding\nWrite clean code.\n\n## Debugging\nFind the root cause.\n'
  );
  const result = withHome(home, ({ skills }) => skills.loadSkills());
  assert.deepStrictEqual(result.map((s) => s.id), ['coding', 'debugging']);
});

// --- selection persistence -------------------------------------------------

test('skills: getSelected returns [] for a config without selectedSkills', () => {
  assert.deepStrictEqual(skills.getSelected({}), []);
  assert.deepStrictEqual(skills.getSelected({ selectedSkills: 'oops' }), []);
  assert.deepStrictEqual(skills.getSelected(null), []);
});

test('skills: setSelected returns a new config with selectedSkills', () => {
  const next = skills.setSelected({ apiKey: 'k' }, ['coding', 'debugging']);
  assert.deepStrictEqual(next.selectedSkills, ['coding', 'debugging']);
  // Original object is not mutated.
  assert.strictEqual(next.apiKey, 'k');
  assert.deepStrictEqual({}.selectedSkills, undefined);
});

test('skills: setSelected filters non-string ids and clears when given []', () => {
  const next = skills.setSelected({}, ['coding', 42, null, 'debugging']);
  assert.deepStrictEqual(next.selectedSkills, ['coding', 'debugging']);
  const cleared = skills.setSelected({ selectedSkills: ['x'] }, []);
  assert.deepStrictEqual(cleared.selectedSkills, []);
});

test('skills: config.json round-trip preserves selectedSkills', () => {
  const home = tmpHome();
  withHome(home, ({ loadConfig, saveConfig, skills }) => {
    const config = loadConfig();
    const next = skills.setSelected(config, ['coding', 'debugging']);
    saveConfig(next);
  });
  const reloaded = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(reloaded.selectedSkills, ['coding', 'debugging']);
});

// --- context integration ---------------------------------------------------

test('skills: buildSkillsContext returns base unchanged when nothing selected', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nstuff\n');
  const out = withHome(home, () => skills.buildSkillsContext('BASE_PROMPT', {}, home));
  assert.strictEqual(out, 'BASE_PROMPT');
});

test('skills: buildSkillsContext injects ONLY selected skills', () => {
  const home = tmpHome();
  writeSkills(
    home,
    '## Coding\nWrite clean code.\n\n## Debugging\nFind the root cause.\n\n## Git\nUse rebases.\n'
  );
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE_PROMPT', { selectedSkills: ['coding', 'debugging'] }, home)
  );
  assert.ok(out.includes('### Coding'));
  assert.ok(out.includes('Write clean code.'));
  assert.ok(out.includes('### Debugging'));
  assert.ok(out.includes('Find the root cause.'));
  assert.ok(!out.includes('### Git'), 'unselected skill must not be in context');
  assert.ok(!out.includes('Use rebases.'), 'unselected skill content must not be in context');
});

test('skills: buildSkillsContext does not include unselected skills', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n\n## Debugging\nd\n');
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE_PROMPT', { selectedSkills: ['coding'] }, home)
  );
  assert.ok(out.includes('### Coding'));
  assert.ok(!out.includes('### Debugging'));
});

test('skills: buildSkillsContext silently drops deleted/missing selected ids', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n');
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE_PROMPT', { selectedSkills: ['coding', 'deleted'] }, home)
  );
  assert.ok(out.includes('### Coding'));
  assert.ok(!out.includes('### deleted'));
  assert.ok(!out.includes('## deleted'));
});

test('skills: buildSkillsContext returns base unchanged when no skills file', () => {
  const home = tmpHome();
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE_PROMPT', { selectedSkills: ['coding'] }, home)
  );
  // ensureFile creates the starter, but the starter has no skills, so no
  // selected skill is matched -> base returned unchanged.
  assert.strictEqual(out, 'BASE_PROMPT');
});

test('skills: buildSkillsContext preserves the user-selected order', () => {
  const home = tmpHome();
  writeSkills(
    home,
    '## Alpha\na\n\n## Beta\nb\n\n## Gamma\nc\n'
  );
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE', { selectedSkills: ['gamma', 'alpha'] }, home)
  );
  const gammaAt = out.indexOf('### Gamma');
  const alphaAt = out.indexOf('### Alpha');
  assert.ok(gammaAt > 0 && alphaAt > 0);
  assert.ok(gammaAt < alphaAt, 'gamma must come before alpha in the rendered context');
});

test('skills: buildSkillsContext frames the section as advisory + safety wins', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n');
  const out = withHome(home, () =>
    skills.buildSkillsContext('BASE', { selectedSkills: ['coding'] }, home)
  );
  assert.ok(out.includes('Selected Skills'));
  assert.ok(out.includes('advisory'));
  assert.ok(out.includes('safety rule wins'));
});

test('skills: buildSkillsContext never echoes the original base content altered', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n');
  const base = 'BASE\nshould stay at the top';
  const out = withHome(home, () =>
    skills.buildSkillsContext(base, { selectedSkills: ['coding'] }, home)
  );
  assert.ok(out.startsWith(base));
  assert.ok(out.includes('should stay at the top'));
});

// --- config backfill -------------------------------------------------------

test('skills: loadConfig backfills selectedSkills=[] on old configs', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.sun2agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.sun2agent', 'config.json'),
    JSON.stringify({ apiKey: 'k', model: 'm' })
  );
  const config = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(config.selectedSkills, []);
  assert.strictEqual(config.apiKey, 'k');
});

test('skills: loadConfig coerces non-array selectedSkills to []', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.sun2agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.sun2agent', 'config.json'),
    JSON.stringify({ apiKey: 'k', selectedSkills: 'coding' })
  );
  const config = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(config.selectedSkills, []);
});

test('skills: default config has empty selectedSkills', () => {
  const home = tmpHome();
  const config = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(config.selectedSkills, []);
});

// --- command registration & wiring -----------------------------------------

test('skills: /skills is registered in the command index', () => {
  const cmds = require('../src/cli/commands');
  assert.strictEqual(typeof cmds.handleSkills, 'function');
  assert.strictEqual(cmds.COMMANDS['/skills'], cmds.handleSkills);
});

// --- getTag (chatbox footer tag, "[Skill: <name>]" format) ------------------
//
// Each selected skill is rendered as "[Skill: <name>]" using the human
// name from skills.md (e.g. "[Skill: Coding]") rather than the normalized
// id ("coding"). The wrapper makes the role of the tag obvious to the
// user and lets it sit alongside the MCP tag without ambiguity.

test('skills: getTag returns "" when no skills are selected', () => {
  assert.strictEqual(skills.getTag({}), '');
  assert.strictEqual(skills.getTag({ selectedSkills: [] }), '');
  assert.strictEqual(skills.getTag(null), '');
});

test('skills: getTag returns a single "[Skill: <name>]" for one selected skill', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nWrite clean code.\n');
  const out = withHome(home, () => skills.getTag({ selectedSkills: ['coding'] }));
  assert.strictEqual(out, '[Skill: Coding]');
});

test('skills: getTag returns space-separated "[Skill: <name>]" for multiple skills', () => {
  const home = tmpHome();
  writeSkills(
    home,
    '## Coding\nc\n\n## Debugging\nd\n'
  );
  const out = withHome(home, () =>
    skills.getTag({ selectedSkills: ['coding', 'debugging'] })
  );
  assert.strictEqual(out, '[Skill: Coding] [Skill: Debugging]');
});

test('skills: getTag uses the human name, not the normalized id', () => {
  // "## Code Review" -> name "Code Review", id "code-review". The tag
  // must use the human name, with spaces preserved.
  const home = tmpHome();
  writeSkills(home, '## Code Review\ncr\n');
  const out = withHome(home, () =>
    skills.getTag({ selectedSkills: ['code-review'] })
  );
  assert.strictEqual(out, '[Skill: Code Review]');
});

test('skills: getTag collapses long lists with "+N more" after the cap', () => {
  const home = tmpHome();
  writeSkills(
    home,
    '## A\na\n\n## B\nb\n\n## C\nc\n\n## D\nd\n\n## E\ne\n'
  );
  const out = withHome(home, () =>
    skills.getTag({ selectedSkills: ['a', 'b', 'c', 'd', 'e'] })
  );
  assert.strictEqual(out, '[Skill: A] [Skill: B] [Skill: C] +2 more');
  // max is configurable
  const out2 = withHome(home, () =>
    skills.getTag({ selectedSkills: ['a', 'b', 'c', 'd'] }, { max: 2 })
  );
  assert.strictEqual(out2, '[Skill: A] [Skill: B] +2 more');
});

test('skills: getTag falls back to the id when the skill name is missing (deleted skill)', () => {
  // If config.selectedSkills contains an id that no longer exists in
  // skills.md, the tag must still render — using the id as the name so
  // the user knows *something* is attached.
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n');
  const out = withHome(home, () =>
    skills.getTag({ selectedSkills: ['coding', 'deleted-skill'] })
  );
  assert.strictEqual(out, '[Skill: Coding] [Skill: deleted-skill]');
});

test('skills: getTag filters non-string entries from config (defense in depth)', () => {
  const home = tmpHome();
  writeSkills(home, '## Coding\nc\n\n## Debugging\nd\n');
  const out = withHome(home, () =>
    skills.getTag({ selectedSkills: ['coding', 42, null, 'debugging'] })
  );
  assert.strictEqual(out, '[Skill: Coding] [Skill: Debugging]');
});

// --- wiring: input box + cli/index.js accept the skills tag ---------------

async function renderInputFooter(options) {
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
    const answer = askInput(options);
    const frame = output.join('').split('\x1b[0J').at(-1);
    stdin.emit('keypress', '\r', { name: 'return' });
    await answer;
    return frame.trimEnd().split('\n').at(-1).replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    Object.defineProperty(process, 'stdin', originalStdin);
    Object.defineProperty(process, 'stdout', originalStdout);
    stdin.destroy();
    stdout.destroy();
  }
}

test('skills: input footer shows both MCP and skill tags', async () => {
  const footer = await renderInputFooter({
    tag: 'browser', skillTag: '[Skill: Coding]', model: 'test-model', hint: '/help · /exit'
  });
  assert.match(footer, /@browser\s+\[Skill: Coding\]/);
  assert.match(footer, /→ test-model/);
});

test('skills: input footer separates the skill tag from the hint without MCP', async () => {
  const footer = await renderInputFooter({ skillTag: '[Skill: Coding]', hint: '/help · /exit' });
  assert.match(footer, /\[Skill: Coding\] {2,}\/help/);
});

test('skills: cli/index.js passes both mcp tag and skills tag to askInput', () => {
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  assert.match(cli, /mcp\.getTag\(\)/);
  assert.match(cli, /skills\.getTag\(config\)/);
  // Both must be passed in the same askInput call.
  const ask = cli.match(/askInput\(\{[\s\S]*?\}\)/);
  assert.ok(ask, 'expected a single askInput({...}) call');
  assert.ok(ask[0].includes('tag: mcp.getTag()'), 'askInput must receive mcp tag');
  assert.ok(ask[0].includes('skillTag: skills.getTag(config)'), 'askInput must receive skills tag');
});

// --- chatbox behavior: pure MCP-style, no typed-text prefix ---------------
//
// Selected skills behave like an added MCP server: the @<id> tags appear in
// the input-box footer as a status indicator, and the skill content is
// injected into the system prompt. The user does NOT need to type @<id>
// tokens in their message — typing anything just works.

test('skills: input.js does NOT prepend skill tags into the typed text', () => {
  const input = fs.readFileSync(path.join(PROJECT, 'src/cli/ui/input.js'), 'utf-8');
  // The old `options.initial` / `let text = initial` plumbing must be gone:
  // pure MCP behavior means the input box starts empty, just like when no
  // MCP server is connected.
  assert.doesNotMatch(input, /options\.initial/);
  assert.doesNotMatch(input, /let text = initial/);
  // The starting text is the same as before the skills feature.
  assert.match(input, /let text = ''/);
});

test('skills: cli/index.js does NOT pass any initial / prefix text to askInput', () => {
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  const ask = cli.match(/askInput\(\{[\s\S]*?\}\)/);
  assert.ok(ask, 'expected a single askInput({...}) call');
  // The only keys passed must be the MCP-style ones: model, tag, skillTag.
  // Critically, no `initial:` key — the user starts from a clean box.
  assert.doesNotMatch(ask[0], /\binitial\s*:/);
  assert.match(ask[0], /tag:\s*mcp\.getTag\(\)/);
  assert.match(ask[0], /skillTag:\s*skills\.getTag\(config\)/);
});

test('skills: cli/index.js still wires MCP-style: footer tag only, no typed-text prefix', () => {
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  // Footer tag — present.
  assert.match(cli, /skillTag:\s*skills\.getTag\(config\)/);
  // No concatenation with the typed message anywhere in cli/index.js.
  assert.doesNotMatch(cli, /getTag\(config\)\s*\+\s*' '/);
  assert.doesNotMatch(cli, /getTag\(config\)\s*\+/);
});

test('skills: the skills content is still injected into the system prompt (MCP behavior)', () => {
  // Pure MCP behavior = the user doesn't type @<id>, but the model still
  // sees the skill content via the system prompt. This is the load-bearing
  // wiring — without it, selecting a skill would have no effect.
  const turn = fs.readFileSync(path.join(PROJECT, 'src/cli/turn.js'), 'utf-8');
  assert.match(turn, /skills\.buildSkillsContext\(/);
});

test('skills: getTag is still used as the chatbox footer tag (visible to the user)', () => {
  // Even though the tag is NOT prepended to the typed message, it is
  // shown in the footer as a status indicator. The user sees which skills
  // are currently active at a glance.
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  assert.match(cli, /skillTag:\s*skills\.getTag\(config\)/);
});

test('skills: cli/index.js reloads config after /skills so the new selection applies', () => {
  // /skills writes selectedSkills via saveConfig. The chat loop must
  // reload the in-memory `config` so the next iteration of the loop sees
  // the new selection (and the footer tag updates immediately).
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  assert.match(cli, /if \(text === '\/skills'\) config = loadConfig\(\);/);
});

test('skills: /skills appears in /help', () => {
  const banner = fs.readFileSync(path.join(PROJECT, 'src/cli/ui/banner.js'), 'utf-8');
  assert.ok(banner.includes("row('/skills'"));
});

test('skills: handler file exports only handleSkills (no extra public API)', () => {
  const mod = require('../src/cli/commands/skills');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['handleSkills']);
});

test('skills: turn.js requires ../core/skills and calls buildSkillsContext', () => {
  const turn = fs.readFileSync(path.join(PROJECT, 'src/cli/turn.js'), 'utf-8');
  assert.match(turn, /require\(['"]\.\.\/core\/skills['"]\)/);
  assert.match(turn, /skills\.buildSkillsContext\(/);
});

test('skills: existing commands still intact after /skills added', () => {
  const cmds = require('../src/cli/commands');
  for (const name of ['/help', '/?', '/config', '/mcp', '/workspace', '/agent', '/memory', '/delete', '/skills']) {
    assert.strictEqual(typeof cmds.COMMANDS[name], 'function', `${name} must still be registered`);
  }
  assert.strictEqual(typeof require('../src/cli/commands/memory').handleMemory, 'function');
  assert.strictEqual(typeof require('../src/cli/commands/mcp').handleMcp, 'function');
  assert.strictEqual(typeof require('../src/cli/commands/config').handleConfig, 'function');
  assert.strictEqual(typeof require('../src/cli/commands/delete').handleDelete, 'function');
});

test('skills: chat-loop still calls MCP and search tools (no regression)', () => {
  const turn = fs.readFileSync(path.join(PROJECT, 'src/cli/turn.js'), 'utf-8');
  assert.match(turn, /mcp\.getOpenAiTools\(\)/);
  assert.match(turn, /search\.getToolSpec\(config\)/);
  assert.match(turn, /mcp\.callTool\(routes, fnName, args, signal\)/);
  assert.match(turn, /search\.executeTool/);
  assert.match(turn, /memory\.buildMemoryContext/);
});

test('skills: no new npm dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf-8'));
  for (const banned of ['skills', 'semantic', 'vector', 'embedding', 'faiss', 'pinecone', 'weaviate', 'chromadb']) {
    assert.strictEqual(pkg.dependencies[banned], undefined, `${banned} must not be added`);
  }
});

test('skills: no API keys or LLM calls are introduced by the skills module', () => {
  const source = fs.readFileSync(path.join(PROJECT, 'src/core/skills/index.js'), 'utf-8');
  const mdSource = fs.readFileSync(path.join(PROJECT, 'src/core/skills/skillsMd.js'), 'utf-8');
  const cmdsSource = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  for (const [label, src] of [['index', source], ['skillsMd', mdSource], ['commands/skills', cmdsSource]]) {
    assert.ok(!/api[-_]?key/i.test(src), `${label} must not mention api keys`);
    assert.ok(!/chat[_-]?completion|integrate\.api\.nvidia\.com|axios|fetch\(/.test(src), `${label} must not make network calls`);
  }
});

test('skills: cli/index.js passes loadConfig + saveConfig into the handler ctx', () => {
  const cli = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  assert.match(cli, /saveConfig/);
  // Both /mcp branch and the else branch must pass both.
  const handlerCalls = cli.match(/handler\(\{[^}]+\}\)/g) || [];
  assert.ok(handlerCalls.length >= 2, 'expected at least two handler() invocations');
  for (const call of handlerCalls) {
    assert.ok(call.includes('loadConfig'), `handler() must receive loadConfig: ${call}`);
    assert.ok(call.includes('saveConfig'), `handler() must receive saveConfig: ${call}`);
  }
});

// --- /skills menu mirrors MCP's UX ----------------------------------------
//
// MCP has a 3-line main menu with parenthetical context on every option
// ("Add / Edit MCP  (open mcp.json)" etc.) and a one-click "Disconnect"
// choice in the server-pick list. The /skills menu mirrors that shape.

test('skills: /skills menu has exactly TWO options — no Back, no Clear selection, no separator', () => {
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  // The user's spec is explicit: "No explicit Back option." The menu
  // contains only the two required actions.
  assert.match(src, /'Add\/Edit Skills'/);
  assert.match(src, /'Select Skills'/);
  // None of the extras may exist.
  assert.doesNotMatch(src, /'Back'/);
  assert.doesNotMatch(src, /'clear'/);
  assert.doesNotMatch(src, /Clear selection/);
  assert.doesNotMatch(src, /inquirer\.Separator/);
});

test('skills: /skills menu wording matches the spec exactly (no spaces around /)', () => {
  // The spec shows "Add/Edit Skills" — no spaces around the slash — and
  // "Select Skills" — no parenthetical context. The earlier
  // MCP-parallel wording is gone.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /name: 'Add\/Edit Skills'/);
  assert.match(src, /name: 'Select Skills'/);
  // The old "Add / Edit Skills  (open skills.md)" and "Select Skills
  //  (choose which to chat with)" must not return.
  assert.doesNotMatch(src, /'Add \/ Edit Skills'/);
  assert.doesNotMatch(src, /\(open skills\.md\)/);
  assert.doesNotMatch(src, /\(choose which to chat with\)/);
  assert.doesNotMatch(src, /\(chat without any skills\)/);
});

test('skills: /skills menu message is just "Skills" (no esc hint per spec)', () => {
  // The spec shows the menu title as plain "Skills". The earlier
  // "Skills:  (esc to go back)" hint is removed to match.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /message: 'Skills'/);
  assert.doesNotMatch(src, /'Skills:\s*'\s*\+/);
  assert.doesNotMatch(src, /esc to go back/);
});

test('skills: Select Skills prompt message is just "Select Skills" (no hint per spec)', () => {
  // The spec shows the title as plain "Select Skills" with checkboxes
  // below. The earlier "(space to toggle, enter to confirm, esc to
  // cancel)" hint is removed to match.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /message: 'Select Skills'/);
  assert.doesNotMatch(src, /Select which skills the agent can use/);
  assert.doesNotMatch(src, /space to toggle, enter to confirm/);
});

test('skills: Esc on the main /skills menu returns to chat', () => {
  // Without a "Back" choice, Esc on the main menu is the sole exit.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /if \(!ans\) return; \/\/ esc -> chat/);
});

test('skills: /skills returns to chat AFTER each action (no menu loop)', () => {
  // MCP flow: pick a server (or open mcp.json) and the handler returns
  // to chat right away. The user types `/mcp` again to do another
  // action. The /skills handler must mirror that — picking "Add/Edit
  // Skills" or "Select Skills" and pressing Enter on the sub-prompt
  // must return control to the chat loop, NOT loop back to the /skills
  // menu.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  // The handleSkills function must NOT contain a `for (;;)` loop — the
  // old version looped the menu, making the user press Esc after every
  // action to get back to chat. That's gone.
  const handleMatch = src.match(/async function handleSkills[\s\S]*?\n\}\n/);
  assert.ok(handleMatch, 'expected to find handleSkills function');
  assert.doesNotMatch(handleMatch[0], /for\s*\(\s*;;\s*\)/);
  // Each action must explicitly return to chat. The "add" branch ends
  // with `return;` and the "select" branch ends with `return;`.
  assert.match(handleMatch[0], /if \(ans\.action === 'add'\)[\s\S]*?await addEditSkills\(ctx\);[\s\S]*?return;/);
  assert.match(handleMatch[0], /if \(ans\.action === 'select'\)[\s\S]*?await selectSkills\(ctx\);[\s\S]*?return;/);
});

test('skills: selectSkills itself returns to /skills caller (no internal loop)', () => {
  // The Select Skills prompt is a single checkbox — it does not loop.
  // Pressing Enter saves and returns; Esc cancels and returns. The
  // caller (handleSkills) then returns to the chat loop.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  const selectMatch = src.match(/async function selectSkills[\s\S]*?\n\}\n/);
  assert.ok(selectMatch, 'expected to find selectSkills function');
  assert.doesNotMatch(selectMatch[0], /for\s*\(\s*;;\s*\)/);
  // The function must save and print its confirmation, then return.
  assert.match(selectMatch[0], /✔ Selected/);
});

test('skills: unchecking all skills in the checkbox clears the selection', () => {
  // With no "Clear selection" menu row, the way to clear is the
  // checkbox itself: uncheck everything, press Enter, saves [].
  // The persistence path is the same as selecting non-empty.
  const home = tmpHome();
  withHome(home, ({ loadConfig, saveConfig, skills }) => {
    saveConfig(skills.setSelected({}, ['coding', 'debugging']));
  });
  // Simulate the user unchecking everything.
  withHome(home, ({ loadConfig, saveConfig, skills }) => {
    saveConfig(skills.setSelected(loadConfig(), []));
  });
  const final = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(final.selectedSkills, []);
});

// --- Select Skills confirmation mirrors MCP's "Connected @<name>" shape ----

test('skills: selectSkills confirms with "[Skill: <name>]" tag echo', () => {
  // After the user toggles specific skills in the checkbox, the success
  // message must echo the tag(s) they just picked in the same format
  // that will appear in the chatbox footer — so the user sees one
  // consistent visual marker everywhere.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /✔ Selected/);
  // The bold tag line must be a space-separated "[Skill: <name>]" list.
  assert.match(src, /'\[Skill: ' \+ \(byId\.get\(id\) \|\| id\) \+ '\]'/);
  // And the count + "skill(s) active." follow MCP's "N tool(s)" pattern.
  assert.match(src, /skill\(s\) active\./);
});

test('skills: selectSkills shows a "You are now chatting..." follow-up line (MCP shape)', () => {
  // MCP prints: "You are now chatting with this server. Its tools are
  // available." right after the "✔ Connected" line. Skills must mirror
  // that with a parallel "chatting with the agent ... skills will be
  // applied" line.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /You are now chatting with the agent\./);
  assert.match(src, /Selected skills will be applied on each turn\./);
});

test('skills: empty selection confirms with the "no skills active" message', () => {
  // After the user unchecks every box in the Select Skills prompt and
  // presses Enter, the agent must be told explicitly that no skills
  // are active — this is the equivalent of MCP's "Disconnected. No MCP
  // server is active." but trimmed to the spec's two-row menu.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/commands/skills.js'), 'utf-8');
  assert.match(src, /No skills are active\. The agent runs without them\./);
});

test('skills: end-to-end flow — selecting a skill makes its "[Skill: <name>]" appear in getTag', () => {
  // This is the load-bearing test: when the user picks specific skills
  // in the checkbox, the same "[Skill: <name>]" tags must be returned
  // by getTag() (so the chatbox footer shows them) and the same
  // content must be injected into the system prompt (so the model
  // uses them). The two channels (footer + system prompt) MUST stay
  // in sync, or the user sees one set of skills while the model uses
  // another.
  const home = tmpHome();
  writeSkills(
    home,
    '## Coding\nWrite clean code.\n\n## Debugging\nFind the root cause.\n'
  );
  withHome(home, ({ loadConfig, saveConfig, skills }) => {
    // Simulate the user picking Coding + Debugging in the checkbox.
    saveConfig(skills.setSelected(loadConfig(), ['coding', 'debugging']));
  });
  // After save, the footer tag must include both "[Skill: <name>]" tokens.
  const config = withHome(home, ({ loadConfig }) => loadConfig());
  const tag = skills.getTag(config);
  assert.strictEqual(tag, '[Skill: Coding] [Skill: Debugging]');
  // And the system-prompt context must include the skill content.
  const ctx = withHome(home, () => skills.buildSkillsContext('BASE', config));
  assert.ok(ctx.includes('### Coding'));
  assert.ok(ctx.includes('### Debugging'));
  assert.ok(ctx.includes('Write clean code.'));
  assert.ok(ctx.includes('Find the root cause.'));
});

// --- Esc-on-empty-box clears the skills tag --------------------------------

test('skills: clearSelected() returns a config with an empty selection', () => {
  // The core helper the Esc handler uses: same shape as setSelected —
  // a NEW config object, never a mutation of the input.
  const config = { apiKey: 'k', selectedSkills: ['coding', 'debugging'] };
  const next = skills.clearSelected(config);
  assert.deepStrictEqual(next.selectedSkills, []);
  // Other fields survive untouched.
  assert.strictEqual(next.apiKey, 'k');
  // The input object must not be mutated.
  assert.deepStrictEqual(config.selectedSkills, ['coding', 'debugging']);
  // Safe on null/undefined configs too.
  assert.deepStrictEqual(skills.clearSelected(null).selectedSkills, []);
  assert.deepStrictEqual(skills.clearSelected(undefined).selectedSkills, []);
});

test('skills: clearSelected persists — the tag is gone after a reload', () => {
  // Esc clears skills by SAVING an empty selection, so the tag must stay
  // cleared even after the process restarts (unlike MCP, whose
  // connections are in-memory only).
  const home = tmpHome();
  writeSkills(home, '## Coding\nWrite clean code.\n');
  withHome(home, ({ loadConfig, saveConfig, skills: s }) => {
    saveConfig(s.setSelected(loadConfig(), ['coding']));
  });
  // ...user chats with the skill attached, then presses Esc on an empty
  // box. The chat loop does: saveConfig(skills.clearSelected(config)).
  withHome(home, ({ loadConfig, saveConfig, skills: s }) => {
    saveConfig(s.clearSelected(loadConfig()));
  });
  const config = withHome(home, ({ loadConfig }) => loadConfig());
  assert.deepStrictEqual(config.selectedSkills, []);
  assert.strictEqual(skills.getTag(config), '');
  // And the system prompt carries no skill section either.
  const ctx = withHome(home, () => skills.buildSkillsContext('BASE', config));
  assert.strictEqual(ctx, 'BASE');
});

test('skills: Esc handler in the chat loop clears skills (and saves) when MCP is not active', () => {
  // The ESC_BACK block must clear the skills selection when no MCP
  // server is connected — pressing Esc on an empty box always returns
  // the user to the plain agent chat.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  assert.match(src, /skills\.getSelected\(config\)/);
  assert.match(src, /skills\.clearSelected\(config\)/);
  // It must persist the cleared selection so the tag stays gone.
  assert.match(src, /saveConfig\(skills\.clearSelected\(config\)\)/);
  // And reload the in-memory config so the next input box loses the tag.
  assert.match(src, /config = loadConfig\(\);/);
});

test('skills: Esc handler keeps MCP and workspace precedence before clearing skills', () => {
  // User MCPs disconnect first, then the opt-in workspace. Skills are cleared
  // only when neither tool layer is active.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/index.js'), 'utf-8');
  const escBlock = src.match(/if \(input === ESC_BACK\) \{[\s\S]*?\n    \}/);
  assert.ok(escBlock, 'expected to find the ESC_BACK block');
  const block = escBlock[0];
  // MCP disconnect comes first…
  assert.match(block, /mcp\.hasUserConnections\(\)/);
  assert.match(block, /mcp\.disconnectUserServers\(\)/);
  // Workspace comes next, and Skills remain last.
  const mcpIndex = block.indexOf('mcp.disconnectUserServers()');
  const workspaceIndex = block.indexOf('mcp.disconnectWorkspace()');
  const skillsIndex = block.indexOf('skills.clearSelected');
  assert.ok(mcpIndex !== -1 && workspaceIndex !== -1 && skillsIndex !== -1);
  assert.ok(mcpIndex < workspaceIndex, 'user MCP branch must be checked before workspace');
  assert.ok(workspaceIndex < skillsIndex, 'workspace branch must be checked before skills');
  assert.match(block, /continue;\s*\}\s*\n\s*if \(mcp\.isWorkspaceConnected\(\)\)/);
  assert.match(block, /disconnectWorkspace\(\);[\s\S]*?continue;\s*\}\s*\n\s*if \(skills\.getSelected/);
});

test('skills: Esc hint in the input-box footer mentions back behavior', () => {
  // The footer hint tells the user Esc exists before they discover it.
  const src = fs.readFileSync(path.join(PROJECT, 'src/cli/ui/input.js'), 'utf-8');
  assert.match(src, /esc back/);
});
