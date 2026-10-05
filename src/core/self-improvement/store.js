// Owner-only storage and keyword retrieval for user-approved lessons.
const fs = require('fs');
const os = require('os');
const path = require('path');
const guardrails = require('../guardrails');
const { containsSensitiveData } = require('../memory/memoryJson');

const STOP = new Set('about after agent create does edit file files from have into make open please that this with write your'.split(' '));
const MAX_LESSONS = 40;

function lessonFile(home = os.homedir()) {
  return path.join(home, '.sun2agent', 'lessons.json');
}

function keywords(text) {
  return [...new Set((String(text).toLowerCase().match(/[a-z0-9_]{4,}/g) || [])
    .filter((word) => !STOP.has(word)))].slice(0, 12);
}

function normalizeLesson(value) {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line || line.length > 180 || containsSensitiveData(line) ||
      /\b(?:token|password|secret|api[_-]?key|credential)\b\s*(?::|=|is)\s*\S+/i.test(line) ||
      !guardrails.inputGuard(line).ok ||
      /(?:disable|bypass|ignore|override).{0,35}(?:approval|guardrail|safety|instruction|policy)/i.test(line)) return null;
  const safe = guardrails.outputGuard(line);
  return safe === line && !safe.includes('REDACTED') ? line : null;
}

function readLessons(home = os.homedir(), strict = false) {
  try {
    const file = lessonFile(home);
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 131072) {
      if (strict) throw new Error('Lesson file is unsafe to overwrite.');
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Lesson file is not an array.');
    return parsed.slice(-MAX_LESSONS).flatMap((item) => {
      const lesson = normalizeLesson(item?.lesson);
      return lesson && Array.isArray(item.keywords)
        ? [{ lesson, keywords: item.keywords.filter((word) =>
          typeof word === 'string' && /^[a-z0-9_]{4,40}$/.test(word)).slice(0, 12) }]
        : [];
    });
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error;
    return [];
  }
}

function saveLesson(task, value, home = os.homedir()) {
  const lesson = normalizeLesson(value);
  if (!lesson) throw new Error('Lesson was not safe to save.');
  if (containsSensitiveData(String(task)) || guardrails.containsSecret(String(task)) ||
      /\b(?:token|password|secret|api[_-]?key|credential)\b\s*(?::|=|is)\s*\S+/i.test(String(task))) {
    throw new Error('Task contains sensitive data; lesson was not saved.');
  }
  const file = lessonFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entries = readLessons(home, true);
  if (!entries.some((item) => item.lesson.toLowerCase() === lesson.toLowerCase())) {
    entries.push({ lesson, keywords: keywords(task) });
  }
  fs.writeFileSync(file, JSON.stringify(entries.slice(-MAX_LESSONS), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function relevantLesson(task, home = os.homedir()) {
  const words = new Set(keywords(task));
  if (!words.size) return null;
  return readLessons(home).reverse().find((item) => item.keywords.some((word) => words.has(word)))?.lesson || null;
}

module.exports = { lessonFile, keywords, normalizeLesson, readLessons, saveLesson, relevantLesson };
