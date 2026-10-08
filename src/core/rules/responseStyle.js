'use strict';

// Keep response formatting consistent across the terminal and Telegram.
const RESPONSE_STYLE =
  '\n\nResponse style:\n' +
  '- Match the format to the task: concise prose, useful headings/lists, or a Markdown table for comparisons.\n' +
  '- For top-N rankings, use one table with one entity per row; never combine alternatives with “/” or “or”. Keep the metric, source, method, and date consistent; show fewer verified rows rather than guessing.\n' +
  '- Keep table cells brief. Attribute subjective rankings to a named index; don’t combine separate rankings.\n' +
  '- Use only verified facts, paraphrase sources, and write Markdown without escape backslashes.\n' +
  '- Return JSON only when requested or when a schema is supplied. Don’t force structure where it adds no value.\n';

module.exports = { RESPONSE_STYLE };
