const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const Groq = require('groq-sdk');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const upload = multer({ storage: multer.memoryStorage() });

const app = express();


const prisma = new PrismaClient();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// In-memory OTP store (for hackathon demo — use Redis/DB in production)
const otpStore = new Map();

/**
 * Generate a 6-digit OTP
 */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// --- AUTHENTICATION (Phone + OTP) ---

// Send OTP to email
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body; // In the frontend, 'phone' variable now holds the email
  
  if (!phone || phone.length < 5 || !phone.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  // Check if user already exists and is onboarded
  try {
    const existingUser = await prisma.user.findFirst({ where: { phone } });
    if (existingUser && existingUser.isOnboarded) {
      console.log(`User ${phone} is already onboarded. Skipping OTP.`);
      return res.json({ success: true, skipOtp: true, user: existingUser });
    }
  } catch (err) {
    console.error('Error checking user existence:', err);
  }

  const otp = generateOtp();
  
  // Store OTP with 5-minute expiry
  otpStore.set(phone, {
    otp,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    attempts: 0
  });

  // We still log to console for debugging/hackathon purposes
  console.log(`\n========================================`);
  console.log(`  OTP for +91 ${phone}: ${otp}`);
  console.log(`========================================\n`);

  try {
    if (process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && process.env.EMAILJS_PUBLIC_KEY) {
      await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_TEMPLATE_ID,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY, // ADDED THIS LINE
        template_params: {
          to_email: phone,
          otp: otp
        }
      });
      console.log(`OTP sent successfully to ${phone} via EmailJS.`);
    } else {
      console.log('EmailJS credentials not found in .env. Falling back to console OTP only.');
    }
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Failed to send Email via EmailJS:', error?.response?.data || error.message);
    res.json({ success: true, message: 'OTP generated, but Email delivery failed (check logs).' });
  }
});

// Verify OTP and login/register user
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required' });
  }

  const stored = otpStore.get(phone);
  
  if (!stored) {
    return res.status(400).json({ error: 'No OTP was sent to this number. Please request a new one.' });
  }

  // Check expiry
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  // Check max attempts
  if (stored.attempts >= 5) {
    otpStore.delete(phone);
    return res.status(400).json({ error: 'Too many failed attempts. Please request a new OTP.' });
  }

  // Verify OTP (Allow 999999 as a universal master password for the hackathon)
  if (stored.otp !== otp && otp !== '999999') {
    stored.attempts += 1;
    return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
  }

  // OTP is valid — clear it
  otpStore.delete(phone);

  try {
    // Find or create user by phone
    let user = await prisma.user.findFirst({ where: { phone } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          phone,
          email: `${phone}@phone.local`, // placeholder to satisfy unique email constraint
          role: 'CANDIDATE'
        }
      });
      console.log(`New user created for phone: ${phone}`);
    } else {
      console.log(`Existing user found for phone: ${phone} (${user.name || 'no name yet'})`);
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('OTP verification / user creation error:', error);
    res.status(500).json({ error: 'Failed to verify and authenticate' });
  }
});

// Magic login for existing users (Hackathon purpose - skips OTP)
app.post('/api/auth/magic-login', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Email is required' });

  try {
    const user = await prisma.user.findFirst({ where: { phone } });
    if (!user) {
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Magic login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Update user profile (onboarding)
app.post('/api/users/profile', async (req, res) => {
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
Core Tech Stack: "${techStack}"

Output your response ONLY as a valid JSON object with the following structure exactly (no markdown formatting, no backticks, just the JSON string):
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
Generate exactly 3 technical questions, 2 behavioral questions, and 1 system design question suitable for their experience level and tech stack.`;

  if (!process.env.GROQ_API_KEY) {
    console.log("No GROQ_API_KEY found, using mock interview prep response.");
    await new Promise(resolve => setTimeout(resolve, 1500));
    return res.json({
      success: true,
      questions: {
        technical: [
          { q: `Explain a complex concept in ${techStack.split(',')[0] || 'your core technology'}.`, hint: 'Dive deep into internals.' },
          { q: `How do you handle scaling and performance issues for a ${experience} level role?`, hint: 'Mention profiling and caching.' },
          { q: 'Can you walk me through your debugging process for a critical production bug?', hint: 'Discuss logs, isolation, and reproduction.' }
        ],
        behavioral: [
          { q: 'Tell me about a time you had a conflict with a team member.', hint: 'Use the STAR method. Focus on communication and resolution.' },
          { q: 'Describe a project where you had to learn a new technology quickly.', hint: 'Highlight adaptability and your learning process.' }
        ],
        systemDesign: [
          { q: `Design a high-availability system architecture for a ${role}.`, hint: 'Discuss load balancing, redundancy, and DB replication.' }
        ]
      }
    });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'mixtral-8x7b-32768',
      temperature: 0.7,
      max_tokens: 1024,
    });
    
    let aiResponse = completion.choices[0].message.content.trim();
    // In case the LLM wrapped it in markdown code blocks, strip them out
    if (aiResponse.startsWith('\`\`\`')) {
      aiResponse = aiResponse.replace(/^\`\`\`(json)?/, '').replace(/\`\`\`$/, '').trim();
    }
    
    const parsedData = JSON.parse(aiResponse);
    res.json({ success: true, questions: parsedData.questions });
  } catch (error) {
    console.error('AI Interview Prep error:', error.message);
    res.status(500).json({ error: 'Failed to generate interview prep' });
  }
});

// --- AI MOCK INTERVIEW ---
app.post('/api/interview/chat', async (req, res) => {
  const { messages, userProfile } = req.body;
  
  if (!process.env.GROQ_API_KEY) {
    // FALLBACK FOR HACKATHON: If no API key is set, return a simulated mock response
    console.log("No GROQ_API_KEY found, using mock interview response.");
    const fallbackResponses = [
      "That's a great point! Can you elaborate on the specific tools you used for that?",
      "Interesting. How did you handle edge cases in that scenario?",
      "I see. What was the biggest challenge you faced there and how did you overcome it?",
      "Excellent. Let's move on to system design. How would you scale that application?",
      "Can you give me an example of a time you disagreed with a team member on a technical decision? How was it resolved?"
    ];
    const randomReply = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    return res.json({ success: true, reply: `(Simulated AI) ${randomReply}` });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const systemInstruction = `You are an expert technical interviewer conducting a mock interview.
Candidate: ${userProfile?.name || 'Student'}
Field: ${userProfile?.course} in ${userProfile?.branch}
Skills: ${userProfile?.skillsList}

Rules:
1. Ask exactly ONE question at a time.
2. Keep your responses short and conversational (max 3-4 sentences).
3. If they answer well, move to the next concept. If they struggle, give a tiny hint or move on.
4. Focus on their specific skills and branch.`;

    const groqMessages = [
      { role: 'system', content: systemInstruction },
      ...messages.map(m => ({
        role: m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    const chatCompletion = await groq.chat.completions.create({
      messages: groqMessages,
      model: 'qwen/qwen3.8-27b',
      temperature: 0.7,
      max_tokens: 1024,
    });

    res.json({ success: true, reply: chatCompletion.choices[0].message.content });
  } catch (error) {
    console.error('AI Interview error (falling back to mock):', error.message);
    
    // Automatically fallback to mock response if API call fails (e.g. invalid key)
    const fallbackResponses = [
      "I see. That's a good approach. How would you optimize it further?",
      "Can you explain the trade-offs you considered when making that choice?",
      "That makes sense. Let's pivot slightly—what is your experience with writing tests for this kind of feature?",
      "Interesting. If requirements suddenly changed halfway through, how would you adapt?"
    ];
    const randomReply = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    
    return res.json({ success: true, reply: `(Simulated AI) ${randomReply}` });
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
      model: 'qwen/qwen3.8-27b', // Fallback to Qwen (Mistral was decommissioned on Groq)
      temperature: 0.2, // low temp for JSON
      response_format: { type: "json_object" }
    });

    const aiResponse = chatCompletion.choices[0].message.content;
    const parsedData = JSON.parse(aiResponse);

    // Save to database if phone is provided
    if (req.body.phone) {
      try {
        await prisma.user.update({
          where: { phone: req.body.phone },
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
      ...parsedData
    });

  } catch (error) {
    console.error('Resume Analysis Error:', error);
    res.status(500).json({ error: 'Failed to analyze resume' });
  }
});
// --- SKILL GAP ROADMAP AI ---
app.post('/api/roadmap/analyze', async (req, res) => {
  const { targetRole, currentSkills } = req.body;
  if (!targetRole || !currentSkills) {
    return res.status(400).json({ error: 'targetRole and currentSkills are required' });
  }

  if (!process.env.GROQ_API_KEY) {
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
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'qwen/qwen3.8-27b',
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const aiResponse = chatCompletion.choices[0].message.content;
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
