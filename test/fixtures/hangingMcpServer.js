'use strict';

// Deliberately consumes stdio without answering MCP initialization. The
// connection-timeout test verifies that Sun2Agent terminates this child.
const fs = require('node:fs');

const marker = process.argv[2];
let marked = false;
process.stdin.on('data', () => {
  if (!marked && marker) {
    marked = true;
    fs.writeFileSync(marker, String(Date.now()));
  }
});
process.stdin.resume();
setInterval(() => {}, 1000);
