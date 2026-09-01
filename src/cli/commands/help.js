// /help (and /?) slash command — show the help panel.
//
// `handleHelp` and `handleHelpShort` are aliases — the dispatch in
// src/cli/index.js treats them identically.

const { printHelp } = require('../ui/banner');

function handleHelp() {
  printHelp();
}

module.exports = { handleHelp, handleHelpShort: handleHelp };
