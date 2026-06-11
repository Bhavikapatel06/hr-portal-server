import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Guess candidate name from file name
const guessName = (fileName = '') =>
  fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_\-\.]+/g, ' ')
    .replace(/\b(resume|cv|curriculum|vitae|final|new|updated)\b/gi, '')
    .trim()
    .split(' ')
    .filter(w => w.length > 1)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim() || fileName;

/**
 * Parse PDF text with automatic CRLF corruption repair and raw text fallback.
 */
async function parsePDFText(fileBuffer) {
  try {
    const pdfData = await pdfParse(fileBuffer);
    return pdfData.text;
  } catch (err) {
    console.warn('Initial PDF parsing failed, trying CRLF -> LF cleanup:', err.message);
    try {
      const binaryString = fileBuffer.toString('binary');
      const cleanedBuf = Buffer.from(binaryString.replace(/\r\n/g, '\n'), 'binary');
      const pdfData = await pdfParse(cleanedBuf);
      return pdfData.text;
    } catch (cleanErr) {
      console.warn('Cleaned PDF parsing also failed, trying raw text fallback:', cleanErr.message);
      return fileBuffer.toString('utf-8');
    }
  }
}

/**
 * Universal LLM caller supporting native Gemini keys, OpenRouter keys, and OpenAI keys.
 */
async function callLLM(prompt, apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is empty');
  }

  const keyTrimmed = apiKey.trim();

  // Case 1: OpenRouter Key (starts with sk-or-)
  if (keyTrimmed.startsWith('sk-or-')) {
    console.log('Detected OpenRouter API key. Calling OpenRouter...');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrimmed}`,
        'HTTP-Referer': 'http://localhost:5000',
        'X-Title': 'HR Portal',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Unexpected response format from OpenRouter');
    }
    return data.choices[0].message.content;
  }

  // Case 2: OpenAI Key (starts with sk-proj- or standard sk-)
  if (keyTrimmed.startsWith('sk-proj-') || (keyTrimmed.startsWith('sk-') && !keyTrimmed.startsWith('sk-or-'))) {
    console.log('Detected OpenAI API key. Calling OpenAI...');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyTrimmed}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Unexpected response format from OpenAI');
    }
    return data.choices[0].message.content;
  }

  // Case 3: Native Google Gemini API Key
  console.log('Detected native Google Gemini API key. Calling Google AI...');
  const genAI = new GoogleGenerativeAI(keyTrimmed);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * Fallback parser using Regex and standard keyword matchers when Gemini is unavailable.
 */
function fallbackParse(text, fileName) {
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}/);
  const email = emailMatch ? emailMatch[0] : '';

  const phoneMatch = text.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/) || 
                     text.match(/\+?\d{10,12}/);
  const phone = phoneMatch ? phoneMatch[0] : '';

  let fullName = guessName(fileName);
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length > 0 && lines[0].length > 3 && lines[0].length < 30 && !lines[0].toLowerCase().includes('resume')) {
    fullName = lines[0];
  }

  const expMatch = text.match(/(\d+\.?\d*)\s*(years?|yrs?)\b/i);
  const totalExp = expMatch ? `${expMatch[1]} years` : '';

  const quals = ['b.tech', 'b.e.', 'm.tech', 'mba', 'mca', 'bca', 'b.sc', 'm.sc', 'graduate', 'post graduate', 'diploma', 'phd', 'doctorate'];
  let highestQual = '';
  for (const q of quals) {
    if (text.toLowerCase().includes(q)) {
      highestQual = q.toUpperCase();
      break;
    }
  }

  const commonSkills = [
    'react', 'node', 'express', 'mongodb', 'javascript', 'html', 'css', 'tailwind', 
    'typescript', 'angular', 'vue', 'python', 'django', 'flask', 'sql', 'postgresql', 
    'java', 'c++', 'c#', 'php', 'aws', 'docker', 'kubernetes', 'git', 'excel', 'agile'
  ];
  const matchedSkills = commonSkills.filter(skill => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startB = /^[\w]/.test(skill) ? '\\b' : '';
    const endB = /[\w]$/.test(skill) ? '\\b' : '';
    return new RegExp(`${startB}${escaped}${endB}`, 'i').test(text);
  }).map(s => s[0].toUpperCase() + s.slice(1));
  const skills = matchedSkills.join(', ');

  const titles = ['software engineer', 'developer', 'manager', 'analyst', 'consultant', 'designer', 'lead', 'architect'];
  let currentTitle = '';
  for (const t of titles) {
    if (text.toLowerCase().includes(t)) {
      currentTitle = t.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      break;
    }
  }

  return {
    fullName,
    email,
    phone,
    currentTitle: currentTitle || 'Candidate',
    totalExp: totalExp || 'Not specified',
    highestQual: highestQual || 'Graduate (Any)',
    skills: skills || 'Not parsed',
    notes: 'Parsed using fallback parser.'
  };
}

/**
 * Main parser entry point. Reads file based on mime type, extracts raw text,
 * and calls LLM or fallback regex parser to get details.
 */
export async function parseResume(fileBuffer, fileName, mimeType, mrfRequirements = null) {
  let rawText = '';

  try {
    if (mimeType.includes('pdf')) {
      rawText = await parsePDFText(fileBuffer);
    } else if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml') || fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      try {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        rawText = result.value;
      } catch (mammothErr) {
        console.warn('Mammoth extraction failed, falling back to text representation:', mammothErr.message);
        rawText = fileBuffer.toString('utf-8');
      }
    } else if (mimeType.includes('text') || fileName.endsWith('.txt')) {
      rawText = fileBuffer.toString('utf-8');
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('Could not extract any text from the file.');
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim().length > 0) {
      try {
        let prompt = `You are an expert resume parsing system. Given the text extracted from a candidate's resume, extract their key profile details.
Return ONLY a valid JSON object matching this structure:
{
  "fullName": "Candidate Name (or fallback to file name if not found)",
  "email": "Candidate email address",
  "phone": "Candidate phone number",
  "currentTitle": "Candidate's current or most recent job title/role",
  "totalExp": "Total experience in years (e.g. '3 years', '5 years', or 'Not specified')",
  "highestQual": "Highest education qualification (e.g. 'B.Tech', 'MBA', 'M.Tech', 'Graduate')",
  "skills": "Comma-separated list of key technical and soft skills"`;

        if (mrfRequirements) {
          prompt += `,
  "matchScore": "An integer from 0 to 100 representing how well the candidate matches the requirements",
  "matchLevel": "One of: 'Strong' (80-100), 'Good' (60-79), 'Partial' (35-59), 'Low' (0-34)",
  "matchBreakdown": {
    "skills": "Score out of 100",
    "experience": "Score out of 100",
    "qualification": "Score out of 100",
    "jobTitle": "Score out of 100"
  }
}

The candidate is applying for a job with the following requirements:
${JSON.stringify(mrfRequirements, null, 2)}
Please rigidly evaluate the candidate against these requirements. Be strict and realistic.`
        } else {
          prompt += `\n}`;
        }

        prompt += `
Do not include any Markdown blocks, backticks, or prefix. Return raw JSON string ONLY.

Resume Text:
${rawText.slice(0, 10000)}
`;

        const responseText = await callLLM(prompt, apiKey);
        
        let jsonStr = responseText.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
        }
        
        const details = JSON.parse(jsonStr);
        return {
          details: {
            fullName: details.fullName || guessName(fileName),
            email: details.email || '',
            phone: details.phone || '',
            currentTitle: details.currentTitle || '',
            totalExp: details.totalExp || '',
            highestQual: details.highestQual || '',
            skills: details.skills || '',
            notes: 'Successfully parsed using AI.'
          },
          matchData: mrfRequirements ? {
            score: details.matchScore || 0,
            matchLevel: details.matchLevel || 'Low',
            breakdown: details.matchBreakdown || { skills: 0, experience: 0, qualification: 0, jobTitle: 0 }
          } : null,
          status: 'parsed'
        };
      } catch (geminiError) {
        console.warn('AI parsing failed, resorting to fallback parser:', geminiError.message);
        return {
          details: fallbackParse(rawText, fileName),
          status: 'parsed'
        };
      }
    } else {
      console.log(`No GEMINI_API_KEY config. Using fallback parser for: ${fileName}`);
      return {
        details: fallbackParse(rawText, fileName),
        status: 'parsed'
      };
    }
  } catch (error) {
    console.error(`Error parsing file ${fileName}:`, error);
    return {
      details: {
        fullName: guessName(fileName),
        email: '',
        phone: '',
        currentTitle: '',
        totalExp: '',
        highestQual: '',
        skills: '',
        notes: `Failed to parse file text: ${error.message}`
      },
      status: 'failed'
    };
  }
}

/**
 * Fallback parser using Regex and standard keyword matchers for MRF documents.
 */
function fallbackParseMRF(text, fileName) {
  let designation = '';
  const designationRegex = /(?:designation|job title|role|position)\s*:\s*([^\n]+)/i;
  const desMatch = text.match(designationRegex);
  if (desMatch) designation = desMatch[1].trim();

  let department = '';
  const deptRegex = /(?:department|dept)\s*:\s*([^\n]+)/i;
  const deptMatch = text.match(deptRegex);
  if (deptMatch) department = deptMatch[1].trim();

  let location = '';
  const locRegex = /(?:location|job location|work location)\s*:\s*([^\n]+)/i;
  const locMatch = text.match(locRegex);
  if (locMatch) location = locMatch[1].trim();

  let experience = '';
  const expRegex = /(?:experience|exp required|experience required)\s*:\s*([^\n]+)/i;
  const expMatch = text.match(expRegex);
  if (expMatch) experience = expMatch[1].trim();

  let minimumQualification = '';
  const qualRegex = /(?:minimum qualification|qualifications?|education)\s*:?\s*([\s\S]*?)(?:specializations?|age in range|preferred industries|skills|experience|benefits|$)/i;
  const qualMatch = text.match(qualRegex);
  if (qualMatch) {
    let raw = qualMatch[1].trim();
    if (raw !== '—' && raw !== '-') minimumQualification = raw;
  }

  let otherKeySkills = '';
  const skillsRegex = /(?:other key skills|key skills|skills)(?:\s*&\s*explain.*?)?:?\s*([\s\S]*?)(?:it requirements|laptop|desktop|benefits|salary|$)/i;
  const skillsMatch = text.match(skillsRegex);
  if (skillsMatch) {
    let raw = skillsMatch[1].trim();
    if (raw !== '—' && raw !== '-') otherKeySkills = raw;
  }

  let noOfPositions = '';
  const posRegex = /(?:no\.? of positions|positions|vacancies|vacancy)\s*:\s*(\d+)/i;
  const posMatch = text.match(posRegex);
  if (posMatch) noOfPositions = posMatch[1].trim();
  let purposeOfJob = '';
  // Match "Purpose of the Job" or "Summary" up to the next heading
  const summaryRegex = /(?:summary|purpose(?: of (?:the )?job)?|objective)\s*:?\s*([\s\S]*?)(?:roles and responsibilities|responsibilities|duties|requirements|qualification|4\.\s*Qualification|$)/i;
  const summaryMatch = text.match(summaryRegex);
  if (summaryMatch) {
    let raw = summaryMatch[1].trim();
    if (raw !== '—' && raw !== '-') purposeOfJob = raw;
  }

  let roles = '';
  // Match "Roles and Responsibilities" or "Responsibilities" up to the next heading
  const rolesRegex = /(?:roles and responsibilities.*?|responsibilities|duties|roles)\s*:?\s*([\s\S]*?)(?:qualification|4\.\s*Qualification|requirements|skills|experience|$)/i;
  const rolesMatch = text.match(rolesRegex);
  if (rolesMatch) {
    let raw = rolesMatch[1].trim();
    if (raw !== '—' && raw !== '-') roles = raw;
  }

  return {
    designation: designation || guessName(fileName),
    department: department || '',
    location: location || '',
    experience: experience || '',
    minimumQualification: minimumQualification || '',
    otherKeySkills: otherKeySkills || '',
    noOfPositions: noOfPositions || '1',
    urgency: 'Medium',
    purposeOfJob: purposeOfJob,
    rolesAndResponsibilities: roles,
    preferredIndustries: ''
  };
}

/**
 * Parses an MRF document (PDF, DOCX, TXT) and returns the extracted job requirements.
 */
export async function parseMRF(fileBuffer, fileName, mimeType) {
  let rawText = '';

  try {
    if (mimeType.includes('pdf')) {
      rawText = await parsePDFText(fileBuffer);
    } else if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml') || fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      try {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        rawText = result.value;
      } catch (mammothErr) {
        console.warn('Mammoth extraction failed, falling back to text representation:', mammothErr.message);
        rawText = fileBuffer.toString('utf-8');
      }
    } else if (mimeType.includes('text') || fileName.endsWith('.txt')) {
      rawText = fileBuffer.toString('utf-8');
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('Could not extract any text from the file.');
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim().length > 0) {
      try {
        const prompt = `You are an expert recruitment system. Given the text extracted from a Manpower Requirement Form (MRF) or job description document, extract the job requirements.
Return ONLY a valid JSON object matching this structure:
{
  "designation": "Job Title / Role (e.g. Senior React Developer)",
  "department": "Department (e.g. Engineering, Sales)",
  "location": "Job Location (e.g. Ahmedabad, Mumbai, Remote)",
  "experience": "Experience Required (e.g. '3-5 years', '5+ years')",
  "minimumQualification": "Minimum education qualification required (must be one of: '10th / SSC', '12th / HSC', 'Diploma', 'Graduate (Any)', 'B.E. / B.Tech', 'MBA / PGDM', 'Post Graduate', 'Doctorate / PhD' or similar)",
  "otherKeySkills": "Comma-separated key skills (e.g. React, Node.js, SQL)",
  "noOfPositions": "Number of positions available (as integer or string, e.g. 2 or '2')",
  "urgency": "Level of urgency (High, Medium, Low)",
  "purposeOfJob": "Brief purpose / summary of the role",
  "rolesAndResponsibilities": "A detailed list or paragraph of the roles and responsibilities",
  "preferredIndustries": "Preferred industries (if mentioned)"
}
Do not include any Markdown blocks, backticks, or prefix. Return raw JSON string ONLY.

Document Text:
${rawText.slice(0, 10000)}
`;

        const responseText = await callLLM(prompt, apiKey);
        
        let jsonStr = responseText.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
        }
        
        const details = JSON.parse(jsonStr);
        return {
          details: {
            designation: details.designation || guessName(fileName),
            department: details.department || '',
            location: details.location || '',
            experience: details.experience || '',
            minimumQualification: details.minimumQualification || '',
            otherKeySkills: details.otherKeySkills || '',
            noOfPositions: details.noOfPositions || '1',
            urgency: details.urgency || 'Medium',
            purposeOfJob: details.purposeOfJob || '',
            rolesAndResponsibilities: details.rolesAndResponsibilities || '',
            preferredIndustries: details.preferredIndustries || ''
          },
          status: 'parsed'
        };
      } catch (geminiError) {
        console.warn('AI MRF parsing failed, resorting to fallback parser:', geminiError.message);
        return {
          details: fallbackParseMRF(rawText, fileName),
          status: 'parsed'
        };
      }
    } else {
      console.log(`No GEMINI_API_KEY config. Using fallback parser for MRF: ${fileName}`);
      return {
        details: fallbackParseMRF(rawText, fileName),
        status: 'parsed'
      };
    }
  } catch (error) {
    console.error(`Error parsing MRF file ${fileName}:`, error);
    return {
      details: {
        designation: guessName(fileName),
        department: '',
        location: '',
        experience: '',
        minimumQualification: '',
        otherKeySkills: '',
        noOfPositions: '1',
        urgency: 'Medium',
        purposeOfJob: '',
        rolesAndResponsibilities: '',
        preferredIndustries: ''
      },
      status: 'failed'
    };
  }
}

/**
 * AI Match Scoring for live preview or existing candidates.
 */
export async function scoreCandidateAI(candidateDetails, mrfRequirements) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const prompt = `You are an expert HR matching system. Evaluate the candidate's profile against the job requirements.
Return ONLY a valid JSON object matching this structure:
{
  "score": 0,
  "matchLevel": "One of: 'Strong' (80-100), 'Good' (60-79), 'Partial' (35-59), 'Low' (0-34)",
  "breakdown": {
    "skills": 0,
    "experience": 0,
    "qualification": 0,
    "jobTitle": 0
  }
}
Note: 'score' and breakdown values must be numbers.
Do not include any Markdown blocks or backticks. Return raw JSON string ONLY.

Job Requirements:
${JSON.stringify(mrfRequirements, null, 2)}

Candidate Details:
${JSON.stringify(candidateDetails, null, 2)}
`;

  const responseText = await callLLM(prompt, apiKey);
  let jsonStr = responseText.trim();
  if (jsonStr.startsWith('\`\`\`')) {
    jsonStr = jsonStr.replace(/^\`\`\`(?:json)?\n/, '').replace(/\n\`\`\`$/, '');
  }
  return JSON.parse(jsonStr);
}
// Trigger reload 2
