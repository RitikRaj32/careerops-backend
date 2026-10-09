const axios = require('axios');
async function test() {
  const systemInstruction = `You are an expert technical interviewer conducting a mock interview.
Candidate: Ritik
Field: B.Tech in CSE
Skills: React, Node.js

Rules:
1. Ask exactly ONE question at a time.
2. Keep your responses short and conversational, as if spoken aloud.
3. Focus on their specific skills and branch.
4. You MUST respond with ONLY a valid JSON object with EXACTLY the following structure:
   - "reply": Your conversational response to the candidate.
   - "feedback": A brief constructive critique of their previous answer.
   - "scores": An object with 5 keys (content, clarity, relevance, confidence, overall) each containing a number from 1 to 10.
   - "sampleAnswer": A sample ideal response to the question they were asked.
   - "missedPoints": An array of strings containing 1-2 key technical points they missed.`;

  const promptText = `Here is the interview transcript so far:

Interviewer: Hello Ritik, let's start. Can you explain what a React Hook is?

Candidate: It's a function that lets you use state.

Generate your response JSON now.`;

  const response = await axios.post('http://localhost:11434/api/chat', {
    model: 'gemma:2b',
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptText }
    ],
    format: 'json',
    stream: false
  });
  console.log('Result:', response.data.message.content);
}
test();
