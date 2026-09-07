// File I/O and parser for ~/.sun2agent/skills.md.
//
// skills.md is a hand-edited Markdown file. Each skill starts with a
// level-2 heading "## Name" and runs until the next "## ...". The
// format is intentionally simple — no YAML, no JSON, no frontmatter —
// so the user can edit it like AGENT.md.
//
// The parser is pure: parseSkills(text) -> [skill, ...]. File I/O is
// isolated in this module so the rest of the app talks to a tiny
// facade (src/core/skills/index.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILLS_FILENAME = 'skills.md';

const SKILLS_STARTER = [
  '# Sun2Agent Skills',
  '',
  '<!-- Add skills using this format:',
  '',
  '## Skill Name',
  '',
  'Write instructions for the agent here.',
  '',
  '-->',
  ''
].join('\n');

// Build a stable id from a display name. Used to match the user's
// `selectedSkills` config against the skills defined in skills.md.
// First skill with a given id wins; later duplicates are dropped.
function normalizeId(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getSkillsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.sun2agent', SKILLS_FILENAME);
}

// Create ~/.sun2agent/skills.md with the starter template if it does
// not exist. Mode 0600 to match the rest of the home-dir files. The
// starter is intentionally safe to overwrite — a real skill file
// already on disk is never replaced.
function ensureSkillsFile(homeDir = os.homedir()) {
  const file = getSkillsPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, SKILLS_STARTER, { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* best effort — Windows ignores chmod */
  }
  return file;
}

// Parse a skills.md string into [{ id, name, content }, ...].
// Pure function; does not touch the filesystem.
//
//   "## Foo\nA\n\n## Bar\nB\n"  ->  [
//     { id: 'foo', name: 'Foo', content: 'A' },
//     { id: 'bar', name: 'Bar', content: 'B' }
//   ]
//
// Empty content is dropped. Two skills that normalize to the same id
// (e.g. "Code Style" and "code style") are de-duplicated — first wins.
function parseSkills(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').replace(/^\s+|\s+$/g, '');
    if (content && !current.dropped) {
      out.push({ id: current.id, name: current.name, content });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const name = m[1].trim();
      const id = normalizeId(name);
      current = { name, id, lines: [], dropped: !id };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  // De-dupe by id (first wins). Stable order.
  const seen = new Set();
  return out.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

// Load and parse the user's skills.md. Returns [] if the file is
// missing, unreadable, or malformed — never throws. The file is
// auto-created with the starter template so the first call always
// returns a sane value.
function loadSkills(homeDir = os.homedir()) {
  const file = ensureSkillsFile(homeDir);
  try {
    return parseSkills(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    return [];
  }
}

// Open skills.md in the user's editor. Mirrors memoryJson.openMemoryFile
// exactly — same VISUAL/EDITOR/platform fallback, same stdio: 'inherit'.
// The block is intentionally duplicated rather than refactored so the
// memory module's tests stay untouched.
function openSkillsFile(homeDir = os.homedir()) {
  const file = ensureSkillsFile(homeDir);
  const editor = process.env.VISUAL || process.env.EDITOR;
  let command;
  let args;

  if (editor) {
    command = editor;
    args = [file];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = ['-t', file];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', file];
  } else {
    command = 'xdg-open';
    args = [file];
  }

  const result = spawnSync(command, args, { stdio: 'inherit' });
  return { opened: !result.error && result.status === 0, file };
}

module.exports = {
  SKILLS_FILENAME,
  SKILLS_STARTER,
  getSkillsPath,
  ensureSkillsFile,
  parseSkills,
  normalizeId,
  loadSkills,
  openSkillsFile
};
