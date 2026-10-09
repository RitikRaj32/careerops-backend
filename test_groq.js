require('dotenv').config();
fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'mixtral-8x7b-32768',
    messages: [
      { role: 'system', content: 'You are an interviewer. You MUST respond with ONLY a valid JSON object with exactly the structure: {"reply": "...", "feedback": "...", "scores": {}, "sampleAnswer": "...", "missedPoints": []}' },
      { role: 'user', content: 'Hello' }
    ],
    response_format: { type: 'json_object' }
  })
})
.then(r => r.text())
.then(console.log)
.catch(console.error);
