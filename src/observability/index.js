// One simple interface for the LangSmith observability feature.
//
// chat.js imports only this module. When LangSmith is disabled (default),
// every function is a zero-overhead no-op pass-through.
//
// This module is independent of guardrails, AGENT.md, and MCP. It only
// observes — it never allows, blocks, or modifies any operation.

const langsmith = require('./langsmith');

module.exports = {
  enable: langsmith.enable,
  disable: langsmith.disable,
  isEnabled: langsmith.isEnabled,
  traceLLM: langsmith.traceLLM,
  traceTool: langsmith.traceTool
};
