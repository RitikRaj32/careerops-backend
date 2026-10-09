const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { clerkClient } = require('@clerk/express');

// Prevent 3rd-party unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection Caught:', reason);
});

// Prevent 3rd-party uncaught exceptions from crashing the server
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception Caught:', error);
});

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());
// Custom lightweight JWT decoder (no network requests, won't crash)
app.use((req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const base64Url = token.split('.')[1];
      if (base64Url) {
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
        const decoded = JSON.parse(jsonPayload);
        if (decoded && decoded.sub) {
          req.auth = { userId: decoded.sub };
        }
      }
    }
  } catch (error) {
    console.error("Custom JWT Decode Error:", error.message);
  }
  next();
});

const prisma = new PrismaClient();
const port = process.env.PORT || 5000;

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// --- AUTHENTICATION (Clerk Sync) ---
app.post('/api/auth/sync', async (req, res) => {
  const log = (msg) => fs.appendFileSync('debug.log', new Date().toISOString() + ' ' + msg + '\n');
  log('--- NEW SYNC REQUEST ---');

  const clerkId = req.auth?.userId;
  log('clerkId: ' + clerkId);
  if (!clerkId) {
    log('Failed: No clerkId in req.auth');
    return res.status(401).json({ error: 'Unauthorized: No valid Clerk token provided' });
  }

  const { email, firstName, lastName, imageUrl } = req.body;
  log('body email: ' + email);

  if (!email) {
    log('Failed: Email missing');
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    // SECURITY FIX: Verify that the email provided in the body actually belongs to the authenticated Clerk user!
    let clerkEmails = [];
    let clerkPhones = [];
    let isClerkReachable = true;

    try {
      const clerkUser = await clerkClient.users.getUser(clerkId);
      clerkEmails = clerkUser.emailAddresses.map(e => e.emailAddress);
      clerkPhones = clerkUser.phoneNumbers?.map(p => p.phoneNumber) || [];
      log('clerkEmails: ' + clerkEmails.join(', '));
      log('clerkPhones: ' + clerkPhones.join(', '));
    } catch (clerkErr) {
      console.warn("WARNING: Could not reach Clerk API to verify identity (network error). Bypassing strict verification for hackathon.", clerkErr.message);
      isClerkReachable = false;
    }

    if (isClerkReachable) {
      if (email.endsWith('@phone-user.com')) {
        const phone = email.split('@')[0];
        if (!clerkPhones.includes(phone)) {
          log('Failed: Phone mismatch');
          return res.status(403).json({ error: 'Security violation: Phone mismatch.' });
        }
      } else if (email.endsWith('@clerk-user.com')) {
        const id = email.split('@')[0];
        if (id !== clerkId) {
          log('Failed: ID mismatch');
          return res.status(403).json({ error: 'Security violation: ID mismatch.' });
        }
      } else {
        if (!clerkEmails.includes(email)) {
          log('Failed: Email mismatch');
          return res.status(403).json({ error: 'Security violation: Email mismatch.' });
        }
      }
    }

    // Find user by email
    let user = await prisma.user.findFirst({
      where: { email }
    });

    if (!user) {
      log('Creating new user in Prisma');
      user = await prisma.user.create({
        data: {
          email,
          name: `${firstName || ''} ${lastName || ''}`.trim() || email.split('@')[0],
          firstName: firstName || '',
          lastName: lastName || '',
          role: 'CANDIDATE'
        }
      });
      console.log(`New user created from Clerk sync: ${email}`);
      log('Created new user successfully');
    } else {
      console.log(`Existing user synced from Clerk: ${email}`);
      log('Found existing user');
    }

    log('Success!');
    res.json({ success: true, user });
  } catch (error) {
    console.error('Clerk sync / user creation error:', error);
    log('ERROR in sync: ' + error.message);
    res.status(500).json({ error: 'Failed to sync and authenticate user' });
  }
});

// Generic file upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const fileUrl = '/uploads/' + req.file.filename;
  res.json({ success: true, url: fileUrl });
});

// Update user profile (onboarding)
app.post('/api/users/profile', async (req, res) => {
  const clerkId = req.auth?.userId;
  if (!clerkId) {
    return res.status(401).json({ error: 'Unauthorized: No valid Clerk token provided' });
  }

  const {
    phone, email,
    firstName, lastName, contactNumber, gender, currentCity,
    collegeName, course, branch, skillsList, collegeYear, resumeUrl
  } = req.body;

  // Support both phone and email as identifiers for backward compatibility
  const identifier = phone || email;

  if (!identifier) {
    return res.status(400).json({ error: 'Phone or email is required' });
  }

  try {
    const updateData = {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(), // Keep name synced
      contactNumber,
      gender,
      currentCity,
      collegeName,
      course,
      branch,
      skillsList,
      collegeYear,
      resumeUrl,
      isOnboarded: true
    };

    let user;
    if (phone) {
      await prisma.user.updateMany({
        where: { phone },
        data: updateData
      });
      user = await prisma.user.findFirst({ where: { phone } });
    } else {
      user = await prisma.user.update({
        where: { email },
        data: updateData
      });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Delete user profile
app.delete('/api/users/profile', async (req, res) => {
  const { phone, email } = req.body;
  const identifier = phone || email;
  if (!identifier) return res.status(400).json({ error: 'Phone or email is required' });

  try {
    if (phone) {
      await prisma.user.deleteMany({ where: { phone } });
    } else {
      await prisma.user.deleteMany({ where: { email } }); // using deleteMany in case email isn't unique in schema
    }
    res.json({ success: true, message: 'Profile deleted successfully' });
  } catch (error) {
    console.error('Profile deletion error:', error);
    res.status(500).json({ error: 'Failed to delete profile' });
  }
});

// --- INTERVIEW PREP GENERATOR ---
app.post('/api/interview/prep', async (req, res) => {
  const { role, experience, techStack } = req.body;

  const prompt = `You are an expert technical interviewer. Create an interview question bank for a candidate applying for the role of "${role}".
Experience Level: "${experience}"
Core Tech Stack / Language: "${techStack}"

Output your response ONLY as a valid JSON object with the following structure exactly (no markdown formatting):
{
  "questions": {
    "technical": [
      { "q": "Question 1", "hint": "Hint 1" },
      { "q": "Question 2", "hint": "Hint 2" }
    ],
    "behavioral": [
      { "q": "Question 1", "hint": "Hint 1" },
      { "q": "Question 2", "hint": "Hint 2" }
    ],
    "systemDesign": [
      { "q": "Question 1", "hint": "Hint 1" }
    ]
  }
}

CRITICAL INSTRUCTIONS:
1. Generate exactly 5 technical questions, 3 behavioral questions, and 2 system design questions (10 questions total).
2. The questions MUST be extremely specific to the "${techStack}" programming language. Do NOT ask generic questions.
3. For example, if the stack is "Python", ask about GIL, decorators, or memory management. If "JavaScript", ask about event loop, closures, or prototypical inheritance. If "Rust", ask about borrow checker, etc.
4. Ensure the system design question also incorporates the context of using "${techStack}".`;

  if (!process.env.GROQ_API_KEY) {
    console.log("No GROQ_API_KEY found, using mock interview prep response.");
    await new Promise(resolve => setTimeout(resolve, 1500));
    return res.json({
      success: true,
      questions: {
        technical: [
          { q: `What are the most common memory leaks you encounter when writing ${techStack} applications, and how do you profile them?`, hint: `Discuss memory management in ${techStack}.` },
          { q: `Explain how concurrency and asynchronous execution work under the hood in ${techStack}.`, hint: 'Mention threads, event loops, or async/await.' },
          { q: `What are some lesser-known advanced features of ${techStack} that you use to optimize your code?`, hint: 'Discuss language-specific optimizations.' },
          { q: `How do you handle dependency management and module resolution in ${techStack}?`, hint: 'Discuss tools like npm, pip, cargo, etc.' },
          { q: `What is the most complex bug you have resolved in a ${techStack} application?`, hint: 'Discuss debugging techniques.' }
        ],
        behavioral: [
          { q: `Tell me about a time you had to convince your team to adopt a specific ${techStack} framework or library.`, hint: 'Use the STAR method. Focus on communication.' },
          { q: `Describe a situation where a ${techStack} version upgrade broke your production environment. How did you handle it?`, hint: 'Highlight adaptability and troubleshooting.' },
          { q: `How do you mentor junior developers to get up to speed with ${techStack}?`, hint: 'Discuss teaching and code reviews.' }
        ],
        systemDesign: [
          { q: `Design a high-throughput, low-latency microservice architecture heavily utilizing ${techStack}. How would you scale it?`, hint: `Discuss load balancing and ${techStack} specific scaling limitations.` },
          { q: `How would you architect a real-time data streaming pipeline using ${techStack} and ensure data consistency?`, hint: `Discuss message queues and ${techStack} integration.` }
        ]
      }
    });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.8,
      response_format: { type: "json_object" }
    });

    const aiResponse = completion.choices[0].message.content.trim();
    const parsedData = JSON.parse(aiResponse);
    res.json({ success: true, questions: parsedData.questions });
  } catch (error) {
    console.error('AI Interview Prep error:', error.message);
    // Serve fallback if the network request fails / times out
    return res.json({
      success: true,
      questions: {
        technical: [
          { q: `What are the most common memory leaks you encounter when writing ${techStack} applications, and how do you profile them?`, hint: `Discuss memory management in ${techStack}.` },
          { q: `Explain how concurrency and asynchronous execution work under the hood in ${techStack}.`, hint: 'Mention threads, event loops, or async/await.' },
          { q: `What are some lesser-known advanced features of ${techStack} that you use to optimize your code?`, hint: 'Discuss language-specific optimizations.' },
          { q: `How do you handle dependency management and module resolution in ${techStack}?`, hint: 'Discuss tools like npm, pip, cargo, etc.' },
          { q: `What is the most complex bug you have resolved in a ${techStack} application?`, hint: 'Discuss debugging techniques.' }
        ],
        behavioral: [
          { q: `Tell me about a time you had to convince your team to adopt a specific ${techStack} framework or library.`, hint: 'Use the STAR method. Focus on communication.' },
          { q: `Describe a situation where a ${techStack} version upgrade broke your production environment. How did you handle it?`, hint: 'Highlight adaptability and troubleshooting.' },
          { q: `How do you mentor junior developers to get up to speed with ${techStack}?`, hint: 'Discuss teaching and code reviews.' }
        ],
        systemDesign: [
          { q: `Design a high-throughput, low-latency microservice architecture heavily utilizing ${techStack}. How would you scale it?`, hint: `Discuss load balancing and ${techStack} specific scaling limitations.` },
          { q: `How would you architect a real-time data streaming pipeline using ${techStack} and ensure data consistency?`, hint: `Discuss message queues and ${techStack} integration.` }
        ]
      }
    });
  }
});

// --- AI MOCK INTERVIEW ---
app.post('/api/interview/chat', async (req, res) => {
  console.log("--- INCOMING /api/interview/chat REQUEST ---");
  const { messages, userProfile } = req.body;
    try {
      const systemInstruction = `You are an expert technical interviewer conducting a mock interview.
Candidate: ${userProfile?.name || 'Student'}
Field: ${userProfile?.course} in ${userProfile?.branch}
Skills: ${userProfile?.skillsList}

CRITICAL RULES:
1. Act as the interviewer. Evaluate their answer briefly, then ask the NEXT technical question.
2. You MUST output ONLY a valid JSON object.

JSON FORMAT:
{
  "reply": "Your conversational response as the interviewer, evaluating their answer and asking the next question.",
  "feedback": "A brief constructive critique of their previous answer.",
  "scores": { "content": 8, "clarity": 8, "relevance": 8, "confidence": 8, "overall": 8 },
  "sampleAnswer": "A sample ideal response they could have given.",
  "missedPoints": ["Key point 1 they missed"]
}`;

      // Force strictly valid roles for Groq/Ollama
      const cleanMessages = messages.map(m => ({
        role: (m.role === 'assistant' || m.role === 'system') ? m.role : 'user',
        content: String(m.content || '')
      }));

      const apiMessages = [
        { role: 'system', content: systemInstruction },
        ...cleanMessages
      ];

      let aiResponseText = "";
      let groqApiKey = process.env.GROQ_API_KEY;
      
      // Fallback: manually read .env if missing from process.env
      if (!groqApiKey) {
          try {
              const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
              const match = envContent.match(/GROQ_API_KEY\s*=\s*"?([^"\n]+)"?/);
              if (match && match[1]) groqApiKey = match[1].trim();
          } catch (e) { /* ignore */ }
      }

      if (groqApiKey && groqApiKey.length > 5) {
        console.log("Attempting ultra-fast Groq API...");
        const groq = new Groq({ apiKey: groqApiKey });
        try {
          const completion = await groq.chat.completions.create({
            messages: apiMessages,
            model: 'llama3-8b-8192',
            response_format: { type: 'json_object' },
            temperature: 0.7,
          });
          aiResponseText = completion.choices[0].message.content;
          console.log("Groq Success!");
        } catch (groqErr) {
          console.log("Groq failed, falling back to local Ollama. Error:", groqErr.message);
          groqApiKey = null; // trigger Ollama fallback
        }
      }

      // If Groq isn't configured or failed, use Ollama natively!
      if (!groqApiKey || !aiResponseText) {
        console.log("Using Local Ollama (llama3) API...");
        const modelName = process.env.LOCAL_MODEL || 'llama3';
        const chatHistory = cleanMessages.map(m => `${m.role === 'assistant' ? 'Interviewer' : 'Candidate'}: ${m.content}`).join('\n\n');
        const promptText = `Here is the interview transcript so far:\n\n${chatHistory}\n\nAs the Interviewer, generate your JSON response now.`;

        const response = await axios.post('http://localhost:11434/api/chat', {
          model: modelName,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: promptText }
          ],
          format: 'json',
          stream: false
        });
        aiResponseText = response.data.message.content;
      }

      console.log("Raw AI Output:", aiResponseText);
      let parsed = {};
      try {
        parsed = JSON.parse(aiResponseText);
      } catch (parseError) {
        console.error("Failed to parse JSON:", parseError);
        parsed = {
          reply: "That's an interesting approach. Can you elaborate further?",
          feedback: "Good response, but could use more detail.",
          scores: { content: 8, clarity: 8, relevance: 8, confidence: 8, overall: 8 },
          sampleAnswer: "A comprehensive answer details the trade-offs.",
          missedPoints: ["No missed points identified."]
        };
      }

      return res.json({
        success: true,
        reply: parsed.reply,
        feedback: parsed.feedback,
        scores: parsed.scores || { content: 8, clarity: 8, relevance: 8, confidence: 8, overall: 8 },
        sampleAnswer: parsed.sampleAnswer || "Consider using the STAR method.",
        missedPoints: parsed.missedPoints || ["Provide more structure."]
      });

    } catch (error) {
      console.error('AI Interview error:', error.message);
      
      const fallbackResponses = [
        "I see. That's a good approach. How would you optimize it further?",
        "Can you explain the trade-offs you considered when making that choice?",
        "That makes sense. Let's pivot slightly—what is your experience with writing tests for this kind of feature?",
        "Interesting. If requirements suddenly changed halfway through, how would you adapt?"
      ];
      const randomReply = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];

      return res.json({
        success: true,
        reply: `(Simulated AI) ${randomReply}`,
        feedback: "This is a fallback response because the AI server is busy or unavailable.",
        scores: { content: 6, clarity: 6, relevance: 6, confidence: 6, overall: 6 },
        sampleAnswer: "AI is currently unavailable. Try again in a few seconds.",
        missedPoints: ["AI fallback triggered."]
      });
    }
});

// --- RESUME PARSER & AI OPTIMIZATION ---
app.post('/api/resume/analyze', upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No resume file uploaded' });
  }

  try {
    // 0. Save the file locally
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    const fileName = Date.now() + '-' + req.file.originalname;
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, req.file.buffer);
    const resumeUrl = '/uploads/' + fileName;

    // 1. Parse the actual uploaded PDF file
    let resumeText = "";
    try {
      const pdfData = await pdfParse(req.file.buffer);
      resumeText = pdfData.text || "";
    } catch (parseError) {
      console.warn("PDF parsing failed (bad XRef etc.), using fallback text.", parseError.message);
    }

    // If the PDF library fails to parse it (very common with pdf-parse on modern PDFs), use a robust fallback text
    if (!resumeText || resumeText.trim().length === 0) {
      resumeText = "Software Developer. Worked on the backend API for the main application using Node.js. Fixed bugs in the React frontend. Created database schemas. Strong grammar but lacks impact.";
    }

    // 2. If no Groq API key, return simulated (but semi-dynamic) data
    if (!process.env.GROQ_API_KEY) {
      return res.json({
        success: true,
        score: Math.floor(Math.random() * 30) + 60, // 60-90
        wordCount: resumeText.split(/\s+/).length,
        actionVerbs: 'Needs Work',
        measurableResults: 'Good',
        measurableResults: 'Good',
        recommendations: [
          { category: "Impact", advice: "Quantify your achievements. Instead of saying 'Fixed bugs', say 'Reduced application crash rate by 15% by resolving critical React frontend bugs'." },
          { category: "Keywords", advice: "Include more specific technologies and frameworks relevant to the roles you are applying for." }
        ],
        errors: [
          { type: 'grammar', suggestion: 'Use past tense consistently.', context: 'Worked on backend' }
        ]
      });
    }

    // 3. Send to Mistral AI via Groq for Analysis & Error Checking
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `You are an expert ATS (Applicant Tracking System) and senior recruiter.
I will provide you with the text extracted from a candidate's resume PDF.
Your task is to perform real-time error checking and optimization. Return a JSON object with EXACTLY the following structure:
{
  "score": <number between 1-100 based on quality, keywords, impact, and errors>,
  "actionVerbs": <string: "Needs Work", "Good", or "Excellent">,
  "measurableResults": <string: "Needs Work", "Good", or "Excellent">,
  "recommendations": [
    { 
      "category": "<string: 'Content', 'Structure', 'Impact', 'Keywords'>", 
      "advice": "<your detailed, actionable advice on how to improve this aspect of the candidate's resume>" 
    }
  ],
  "errors": [
    {
      "type": "<string: 'Grammar', 'Formatting', 'Spelling', 'Impact'>",
      "context": "<the exact short phrase from the resume that has the error>",
      "suggestion": "<how to fix it>"
    }
  ]
}
Generate exactly 3 recommendations and up to 3 errors. ONLY output valid JSON. No markdown formatting outside the JSON, no explanations.

RESUME TEXT:
${resumeText.substring(0, 4000)} // limit to avoid token issues
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant', // Fast fallback model
      temperature: 0.2, // low temp for JSON
      response_format: { type: "json_object" }
    });

    const aiResponse = chatCompletion.choices[0].message.content;
    const parsedData = JSON.parse(aiResponse);

    // Save to database if phone or email is provided
    const identifier = req.body.phone || req.body.email;
    if (identifier) {
      try {
        const whereClause = req.body.phone ? { phone: req.body.phone } : { email: req.body.email };
        await prisma.user.update({
          where: whereClause,
          data: {
            resumeUrl,
            resumeScore: parsedData.score || 0
          }
        });
      } catch (dbErr) {
        console.error("Failed to update user resume data:", dbErr.message);
      }
    }

    res.json({
      success: true,
      wordCount: resumeText.split(/\s+/).length,
      resumeUrl,
      ...parsedData
    });

  } catch (error) {
    console.error('Resume Analysis Error:', error);
    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});

// --- RESUME BASED QUESTIONS ---
app.post('/api/resume/questions', async (req, res) => {
  const { resumeUrl } = req.body;
  if (!resumeUrl) return res.status(400).json({ error: 'Resume URL is required' });

  try {
    const fileName = resumeUrl.replace('/uploads/', '');
    const filePath = path.join(__dirname, 'uploads', fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Resume file not found on server' });
    }

    const dataBuffer = fs.readFileSync(filePath);
    let resumeText = "";
    try {
      const pdfData = await pdfParse(dataBuffer);
      resumeText = pdfData.text || "";
    } catch (e) {
      resumeText = "Software Developer with generic experience.";
    }

    if (!process.env.GROQ_API_KEY) {
      return res.json({
        success: true,
        questions: [
          "I see you worked on an E-commerce project. How did you handle the payment gateway integration failures?",
          "Your resume mentions 'Optimized database queries'. Can you walk me through the specific metrics you improved?",
          "You used React context in your last role. Why did you choose it over Redux for that specific use case?"
        ]
      });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `You are an expert technical interviewer. I will provide you with the text extracted from a candidate's resume PDF.
Your task is to generate 3 highly specific, challenging interview questions based ONLY on the projects, skills, or experiences mentioned in this resume.
Act like a hiring manager trying to probe the depth of their actual involvement.

Return ONLY a valid JSON object with EXACTLY the following structure:
{
  "questions": [
    "Question 1",
    "Question 2",
    "Question 3"
  ]
}
No markdown, no explanations outside JSON.

RESUME TEXT:
${resumeText.substring(0, 4000)}
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.5,
      response_format: { type: "json_object" }
    });

    const aiResponse = chatCompletion.choices[0].message.content;
    const parsedData = JSON.parse(aiResponse);

    res.json({ success: true, questions: parsedData.questions });
  } catch (error) {
    console.error('Resume Questions Error:', error);
    res.status(500).json({ error: 'Failed to generate resume questions' });
  }
});
// --- INTERVIEW GAP PREP ---
app.post('/api/interview/gap', async (req, res) => {
  const { gap, role } = req.body;
  if (!gap || !role) {
    return res.status(400).json({ error: 'gap and role are required' });
  }

  const prompt = `You are an expert technical interviewer. The candidate is applying for the role of "${role}", but they have an identified skill gap in "${gap}".
Generate exactly 3 specific, probing interview questions about "${gap}" that they might face in an interview for this role.
Output ONLY a valid JSON object with the following structure:
{
  "questions": [
    { "id": 1, "q": "Question 1..." },
    { "id": 2, "q": "Question 2..." },
    { "id": 3, "q": "Question 3..." }
  ]
}`;

  if (!process.env.GROQ_API_KEY) {
    return res.json({
      success: true,
      questions: [
        { id: 1, q: `What is your understanding of ${gap} and how does it apply to a ${role} position?` },
        { id: 2, q: `Can you explain a basic use case or implementation of ${gap}?` },
        { id: 3, q: `How would you approach learning ${gap} if we hired you today?` }
      ]
    });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.7,
      response_format: { type: "json_object" }
    });
    
    const parsedData = JSON.parse(completion.choices[0].message.content.trim());
    res.json({ success: true, questions: parsedData.questions });
  } catch (err) {
    console.error('Gap questions error:', err.message);
    return res.json({
      success: true,
      questions: [
        { id: 1, q: `What is your understanding of ${gap} and how does it apply to a ${role} position?` },
        { id: 2, q: `Can you explain a basic use case or implementation of ${gap}?` },
        { id: 3, q: `How would you approach learning ${gap} if we hired you today?` }
      ]
    });
  }
});

// --- SKILL GAP ROADMAP AI ---
app.post('/api/roadmap/analyze', async (req, res) => {
  const { targetRole, currentSkills } = req.body;
  if (!targetRole || !currentSkills) {
    return res.status(400).json({ error: 'targetRole and currentSkills are required' });
  }

  if (!process.env.GEMINI_API_KEY) {
    // Fallback for hackathon
    return res.json({
      success: true,
      gaps: [
        {
          id: 1,
          skill: 'System Design',
          importance: 'High',
          status: 'Missing',
          levelRequired: 'Intermediate',
          description: 'Crucial for scalable architectures.',
          resources: [{ title: 'Grokking the System Design Interview', type: 'Course', link: '#' }]
        }
      ]
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `You are an expert career coach and technical recruiter.
I will provide a candidate's current skills and their target role.
Your task is to analyze the gap and return a JSON object with exactly this structure:
{
  "gaps": [
    {
      "id": 1,
      "skill": "<Skill Name>",
      "importance": "<High, Medium, or Low>",
      "status": "<Missing, Learning, or Verified>",
      "levelRequired": "<Basic, Intermediate, or Advanced>",
      "description": "<Brief 1-sentence reason why this is needed for the target role>",
      "resources": [
        { "title": "<Resource title>", "type": "<Course, Video, Article, etc.>", "link": "#" }
      ]
    }
  ]
}
Generate exactly 4 skill gaps. ONLY output valid JSON. No markdown formatting outside the JSON, no explanations.

Current Skills: ${currentSkills.join(', ')}
Target Role: ${targetRole}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const aiResponse = response.text;
    const parsedData = JSON.parse(aiResponse);

    res.json({ success: true, ...parsedData });
  } catch (error) {
    console.error('Roadmap Analysis Error:', error);
    // Return fallback data on rate limit or other errors
    res.json({
      success: true,
      gaps: [
        {
          id: 1,
          skill: 'System Design (Fallback)',
          importance: 'High',
          status: 'Missing',
          levelRequired: 'Intermediate',
          description: 'API limit reached. This is a fallback suggestion.',
          resources: [{ title: 'System Design Primer', type: 'Course', link: '#' }]
        },
        {
          id: 2,
          skill: 'Advanced ' + targetRole + ' Concepts',
          importance: 'Medium',
          status: 'Learning',
          levelRequired: 'Advanced',
          description: 'Deepen your knowledge for ' + targetRole + '.',
          resources: []
        }
      ]
    });
  }
});

app.get('/api/jobs', async (req, res) => {
  res.json([
    {
      id: 1,
      title: 'Senior Frontend Engineer',
      company: 'TechCorp',
      location: 'Remote',
      type: 'Full-time',
      matchScore: 82,
      matchReason: 'Strong overlap in React/Tailwind skills. Gap in 3 years leadership.',
      fitType: 'safe fit'
    },
    {
      id: 2,
      title: 'AI Platform Engineer',
      company: 'DataSys',
      location: 'New York, NY',
      type: 'Full-time',
      matchScore: 65,
      matchReason: 'Good Node.js experience, but missing ML embedding knowledge.',
      fitType: 'stretch'
    }
  ]);
});

// --- INSTITUTION DASHBOARD ---
app.get('/api/institution/students', async (req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: { role: 'CANDIDATE' },
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        course: true,
        branch: true,
        collegeYear: true,
        resumeScore: true,
        resumeUrl: true,
        applications: true,
        mockInterviews: true,
      }
    });
    res.json({ success: true, students });
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

app.delete('/api/institution/students/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Prisma will not auto-cascade if not set up, so let's delete relations first
    await prisma.application.deleteMany({ where: { userId: id } });
    await prisma.mockInterview.deleteMany({ where: { userId: id } });

    await prisma.user.delete({
      where: { id }
    });

    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Error deleting student:", error);
    res.status(500).json({ error: "Failed to delete student" });
  }
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Express Error:", err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
