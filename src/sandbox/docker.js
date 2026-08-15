// Docker detection utilities.
//
// Thin wrappers around the `docker` CLI. No config dependency — these are
// pure child_process checks so they can be reused by the CLI subcommands
// (`sun2agent sandbox enable`) and by the startup validation in chat.js.

const { spawnSync } = require('child_process');

// Is the `docker` CLI installed and on PATH?
function isDockerInstalled() {
  try {
    const res = spawnSync('docker', ['--version'], { stdio: 'pipe' });
    return !res.error && res.status === 0;
  } catch (_) {
    return false;
  }
}

// Is the Docker daemon running? `docker info` fails when the daemon is down
// even if the CLI is installed, so this is the right check for "ready to use".
function isDockerRunning() {
  try {
    const res = spawnSync('docker', ['info'], { stdio: 'pipe' });
    return !res.error && res.status === 0;
  } catch (_) {
    return false;
  }
}

// Pull an image so it's available locally. Streams output to the terminal.
// Returns true on success, false on failure.
function pullImage(image) {
  try {
    const res = spawnSync('docker', ['pull', image], { stdio: 'inherit' });
    return !res.error && res.status === 0;
  } catch (_) {
    return false;
  }
}

// Is the image already present in the local Docker image store?
function hasImage(image) {
  try {
    const res = spawnSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
    return !res.error && res.status === 0;
  } catch (_) {
    return false;
  }
}

// Make sure the image exists locally, pulling it only when missing. Returns
// true when the image is ready to run, false otherwise.
function ensureImage(image) {
  if (hasImage(image)) return true;
  return pullImage(image);
}

module.exports = { isDockerInstalled, isDockerRunning, pullImage, hasImage, ensureImage };
