const axios = require('axios');
async function test() {
  const response = await axios.post('http://localhost:11434/api/chat', {
    model: 'gemma:2b',
    messages: [
      { role: 'system', content: 'Respond with JSON containing a key "reply"' },
      { role: 'user', content: 'hello' }
    ],
    format: 'json',
    stream: false
  });
  console.log('Result:', response.data.message.content);
}
test();
