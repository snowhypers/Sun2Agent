const axios = require('axios');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function askAI(apiKey, model, messages) {
  const response = await axios.post(
    NIM_URL,
    {
      model: model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: false
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

module.exports = { askAI };