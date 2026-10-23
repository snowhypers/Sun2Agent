'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.sun2agent', '.cache', 'dist', 'build', '.next', '.turbo', '.gemini', '.idea', '.vscode'
]);

async function scanWorkspaceCodebase(root) {
  if (!root || typeof root !== 'string') return '';
  try {
    const resolvedRoot = await fsp.realpath(path.resolve(root));
    let entries;
    try {
      entries = await fsp.readdir(resolvedRoot, { withFileTypes: true });
    } catch (_) {
      return '';
    }

    const visible = entries.filter((e) =>
      !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env.example'
    );
    if (!visible.length) return '';

    const rootFiles = [];
    const rootDirs = [];
    for (const entry of visible) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) rootDirs.push(entry.name);
      } else if (entry.isFile()) {
        rootFiles.push(entry.name);
      }
    }

    if (!rootFiles.length && !rootDirs.length) return '';

    const lines = [];
    lines.push('\nExisting workspace codebase context:');
    if (rootFiles.length) {
      lines.push(`- Root files: ${rootFiles.slice(0, 25).join(', ')}`);
    }

    // Inspect root package.json if present
    try {
      const pkgPath = path.join(resolvedRoot, 'package.json');
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      const scripts = Object.keys(pkg.scripts || {});
      if (scripts.length) lines.push(`- Root npm scripts: ${scripts.join(', ')}`);
      const deps = Object.keys(pkg.dependencies || {});
      if (deps.length) lines.push(`- Root dependencies: ${deps.slice(0, 15).join(', ')}`);
    } catch (_) {}

    // Inspect direct subdirectories (e.g. backend, frontend, src)
    for (const dirName of rootDirs.slice(0, 8)) {
      const subPath = path.join(resolvedRoot, dirName);
      try {
        const subEntries = await fsp.readdir(subPath, { withFileTypes: true });
        const subItems = subEntries
          .filter((e) => !IGNORED_DIRECTORIES.has(e.name) && !e.name.startsWith('.'))
          .map((e) => e.isDirectory() ? `${e.name}/` : e.name)
          .slice(0, 12);

        let subPkgInfo = '';
        try {
          const subPkg = JSON.parse(await fsp.readFile(path.join(subPath, 'package.json'), 'utf8'));
          const subScripts = Object.keys(subPkg.scripts || {});
          if (subScripts.length) subPkgInfo = ` [scripts: ${subScripts.join(', ')}]`;
        } catch (_) {}

        lines.push(`- Subdirectory ${dirName}/: ${subItems.join(', ')}${subPkgInfo}`);
      } catch (_) {
        lines.push(`- Subdirectory ${dirName}/`);
      }
    }

    lines.push('Instructions for planning: The codebase above already exists in the workspace. Read this context and build a task-specific plan for the user\'s latest prompt tailored to this existing codebase. Do not assume an empty project when files already exist.');
    return lines.join('\n');
  } catch (_) {
    return '';
  }
}

module.exports = { scanWorkspaceCodebase };
