// Slash-command registry.
//
// Maps a command name (or names) to its handler. Each handler receives a
// shared `ctx` object that bundles every chat-loop dependency the handlers
// need (prompter, dockerDownWarning, etc.). Handlers live in their own files
// to keep this module a thin dispatcher.

const { handleConfig } = require('./config');
const { handleMcp } = require('./mcp');
const { handleAgent } = require('./agent');
const { handleMemory } = require('./memory');
const { handleDelete } = require('./delete');
const { handleHelp, handleHelpShort } = require('./help');
const { handleSkills } = require('./skills');
const { handleWorkspace } = require('./workspace');

// name -> (ctx) => Promise<void>
const COMMANDS = {
  '/help': handleHelp,
  '/?': handleHelpShort,
  '/config': handleConfig,
  '/mcp': handleMcp,
  '/workspace': handleWorkspace,
  '/agent': handleAgent,
  '/memory': handleMemory,
  '/delete': handleDelete,
  '/skills': handleSkills
};

module.exports = { COMMANDS, handleConfig, handleSkills, handleWorkspace };
