require('dotenv').config();
fetch('https://api.groq.com/openai/v1/models', {
  headers: {
    'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
  }
}).then(r => r.json()).then(d => console.log(d.data.map(m => m.id))).catch(console.error);
