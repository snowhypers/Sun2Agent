const stringWidth = require('string-width');

// Keep rendered lines one column short so terminals do not soft-wrap them.
function terminalWidth(output = process.stdout, maximum = 120) {
  const columns = Number(output && output.columns);
  const available = Number.isFinite(columns) && columns > 1 ? Math.floor(columns) - 1 : 79;
  return Math.max(4, Math.min(available, maximum));
}

function sliceToWidth(value, maximum) {
  if (maximum <= 0) return '';
  let result = '';
  let used = 0;
  for (const char of String(value || '')) {
    const charWidth = stringWidth(char);
    if (used + charWidth > maximum) break;
    result += char;
    used += charWidth;
  }
  return result;
}

function truncateToWidth(value, maximum) {
  const text = String(value || '');
  if (maximum <= 0) return '';
  if (stringWidth(text) <= maximum) return text;
  if (maximum === 1) return '…';
  return sliceToWidth(text, maximum - 1) + '…';
}

function wrapText(value, maximum) {
  const text = String(value || '');
  if (!text) return [''];
  const width = Math.max(1, maximum);
  const lines = [];
  let current = '';

  for (let word of text.split(' ')) {
    while (stringWidth(word) > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      const part = sliceToWidth(word, width);
      lines.push(part);
      word = word.slice(part.length);
    }
    if (!current) current = word;
    else if (stringWidth(`${current} ${word}`) <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function centerToWidth(value, width) {
  const text = truncateToWidth(value, width);
  const remaining = Math.max(0, width - stringWidth(text));
  const left = Math.floor(remaining / 2);
  return ' '.repeat(left) + text + ' '.repeat(remaining - left);
}

function padToWidth(value, width) {
  const text = truncateToWidth(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

module.exports = {
  centerToWidth,
  padToWidth,
  sliceToWidth,
  terminalWidth,
  truncateToWidth,
  wrapText
};
