// Keep image bytes out of plain-text history, terminal output and secret masking.
function formatToolResult(result, includeImages = false) {
  const images = [];
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      const valid = ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
        && typeof block.data === 'string' && block.data.length <= 4 * 1024 * 1024
        && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data);
      if (includeImages && valid && images.length < 1) {
        images.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
        return '[Screenshot attached for visual inspection; not proof of task completion.]';
      }
      return '[Screenshot omitted: use accessibility/UI-tree tools. Do not claim to have seen this image.]';
    }
    return '[Non-text MCP content omitted]';
  }).join('\n') || JSON.stringify(result.structuredContent || result);
  return includeImages ? { text, images } : text;
}
module.exports = { formatToolResult };
