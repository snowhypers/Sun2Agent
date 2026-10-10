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
const { handleBrowser } = require('./browser');
const { handleComputer, disconnectComputer } = require('./computer');
const { handleNew } = require('./new');
const { handleContinue } = require('./continue');
const { handleSave } = require('./save');
const { handleSchedule } = require('./schedule');

// name -> (ctx) => Promise<void>
const COMMANDS = {
  '/help': handleHelp,
  '/?': handleHelpShort,
  '/config': handleConfig,
  '/new': handleNew,
  '/continue': handleContinue,
  '/save': handleSave,
  '/schedule': handleSchedule,
  '/mcp': handleMcp,
  '/browser': handleBrowser,
  '/computer': handleComputer,
  '/computer disconnect': disconnectComputer,
  '/agent': handleAgent,
  '/memory': handleMemory,
  '/delete': handleDelete,
  '/skills': handleSkills
};

module.exports = { COMMANDS, handleConfig, handleSkills, handleBrowser };
