const Groq = require('groq-sdk');
require('dotenv').config();
async function test() {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const sys = `You are an expert technical interviewer conducting a mock interview.
Rules:
1. Ask exactly ONE question at a time.
2. Keep your responses short and conversational.
3. Focus on their specific skills and branch.
4. You MUST respond with ONLY a valid JSON object with EXACTLY the following structure:
   - "reply": Your conversational response to the candidate.
   - "feedback": A brief constructive critique of their previous answer.
   - "scores": An object with 5 keys (content, clarity, relevance, confidence, overall) each containing a number from 1 to 10.
   - "sampleAnswer": A sample ideal response to the question they were asked.
   - "missedPoints": An array of strings containing 1-2 key technical points they missed.`;

  const chatCompletion = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: sys },
      { role: 'assistant', content: 'How do you ensure your code is maintainable and scalable?' },
      { role: 'user', content: 'I just write code fast.' }
    ],
    model: 'qwen/qwen3.8-27b',
    temperature: 0.7,
    max_tokens: 1024,
    response_format: { type: 'json_object' }
  });
  console.log(chatCompletion.choices[0].message.content);
}
test().catch(console.error);
