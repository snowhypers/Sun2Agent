'use strict';

const TIME = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i;
const DAILY = /\b(?:daily|every\s+(?:day|morning|afternoon|evening|night))\b/i;

function isScheduleRequest(text) {
  const source = String(text || '').trim();
  if (/^(?:(?:please|can you|could you)\s+)?(?:schedule\b|sehedule\b|remind me\b)/i.test(source)) return true;
  return !source.endsWith('?') &&
    /^(?:daily\b|every\s+(?:day|morning|afternoon|evening|night)\b|once\s+at\s+\d|(?:today|tomorrow)\s+at\s+\d|at\s+\d)/i.test(source);
}

function parsePrompt(text) {
  const source = String(text || '').trim();
  const timeMatch = source.match(TIME);
  const daily = DAILY.test(source);
  const beforeTime = source.slice(0, timeMatch?.index ?? source.length);
  const afterTime = timeMatch ? source.slice(timeMatch.index + timeMatch[0].length) : '';
  const reminder = /\bremind(?:er)?(?:\s+me)?\b/i.test(beforeTime);
  const timeQualifier = beforeTime + (afterTime.match(/^\s*,?\s*(?:in the )?(?:morning|afternoon|evening|night|tonight)\b/i)?.[0] || '');
  // Date words inside the task ("summarize today’s news") are not recurrence.
  const dayCue = beforeTime.match(/\b(today|tomorrow|tonight)\b/i)?.[1] ||
    afterTime.match(/^\s*,?\s*(today|tomorrow|tonight)\b/i)?.[1];
  const once = /\b(?:once|one[- ]time)\b/i.test(source) || Boolean(dayCue);
  const missing = [];
  if (!timeMatch) missing.push('time');
  if (!daily && !once) missing.push('recurrence (once or daily)');
  if (daily && once) return { error: 'Choose either once or daily, not both.' };

  let hour;
  let minute;
  if (timeMatch) {
    if (timeMatch[3]) {
      hour = Number(timeMatch[1]);
      minute = Number(timeMatch[2] || 0);
      if (hour < 1 || hour > 12 || minute > 59) return { error: 'Enter a valid time, such as 9:00 PM.' };
      hour = hour % 12 + (timeMatch[3].toLowerCase() === 'pm' ? 12 : 0);
    } else {
      hour = Number(timeMatch[4]);
      minute = Number(timeMatch[5]);
      if (hour > 23 || minute > 59) return { error: 'Enter a valid time, such as 21:00.' };
    }
    if (/\bmorning\b/i.test(timeQualifier) && hour >= 12 ||
        /\b(?:afternoon|evening|night|tonight)\b/i.test(timeQualifier) && hour < 12) {
      return { error: 'The time conflicts with morning/evening. Which time did you mean?' };
    }
  }

  const quotedReminder = reminder && afterTime.match(/["“]([^"”]+)["”]/);
  const task = quotedReminder ? quotedReminder[1].trim() : source
    .replace(/^\s*(?:(?:please|can you|could you)\s+)?(?:(?:schedule|sehedule)(?:\s+me\s+to)?\s*|remind me(?:\s+to)?\s+)?/i, '')
    .replace(DAILY, '').replace(/\b(?:once|one[- ]time)\b/i, '').replace(dayCue || /$^/, '')
    .replace(timeMatch?.[0] || /$^/, '')
    .replace(/\s*(?:and\s+)?send\s+(?:it|the\s+(?:result|summary))?\s*to\s+telegram\s*[.!]?$/i, '')
    .replace(/^[\s,.:;\-]+|[\s,.:;\-]+$/g, '').trim();
  if (!task || /^(?:send|telegram|to telegram)$/i.test(task)) missing.unshift('task');
  if (missing.length) return { missing };
  if (task.length > 500) return { error: 'Keep the scheduled task under 500 characters.' };
  if (/\b(?:delete|edit|write|create|purchase|buy|upload|post|publish|send\s+(?:an?\s+)?(?:email|message))\b/i.test(task)) {
    return { error: 'Scheduled tasks must be read-only. Ask for a summary, search, or check instead.' };
  }
  return {
    task, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    recurrence: daily ? 'daily' : 'once',
    day: dayCue?.toLowerCase() === 'tomorrow' ? 'tomorrow' : dayCue ? 'today' : 'next',
    ...(reminder ? { reminder: true } : {})
  };
}

module.exports = { isScheduleRequest, parsePrompt };
