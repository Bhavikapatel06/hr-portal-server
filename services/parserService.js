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
 * Fallback parser using Regex and standard keyword matchers when Gemini is unavailable.
 */
function fallbackParse(text, fileName) {
  // 1. Email extraction
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}/);
  const email = emailMatch ? emailMatch[0] : '';

  // 2. Phone extraction
  const phoneMatch = text.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/) || 
                     text.match(/\+?\d{10,12}/);
  const phone = phoneMatch ? phoneMatch[0] : '';

  // 3. Name guess
  let fullName = guessName(fileName);
  // Try to find name at the very beginning of the resume (first 2-3 lines)
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length > 0 && lines[0].length > 3 && lines[0].length < 30 && !lines[0].toLowerCase().includes('resume')) {
    fullName = lines[0];
  }

  // 4. Experience guess
  const expMatch = text.match(/(\d+\.?\d*)\s*(years?|yrs?)\b/i);
  const totalExp = expMatch ? `${expMatch[1]} years` : '';

  // 5. Qualification guess
  const quals = ['b.tech', 'b.e.', 'm.tech', 'mba', 'mca', 'bca', 'b.sc', 'm.sc', 'graduate', 'post graduate', 'diploma', 'phd', 'doctorate'];
  let highestQual = '';
  for (const q of quals) {
    if (text.toLowerCase().includes(q)) {
      highestQual = q.toUpperCase();
      break;
    }
  }

  // 6. Skills guess - check for common tech skills
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

  // 7. Current title
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
 * and calls Gemini AI or fallback regex parser to get details.
 */
export async function parseResume(fileBuffer, fileName, mimeType) {
  let rawText = '';

  try {
    if (mimeType.includes('pdf')) {
      const pdfData = await pdfParse(fileBuffer);
      rawText = pdfData.text;
    } else if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml') || fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      rawText = result.value;
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
        console.log(`Using Gemini AI API for parsing resume: ${fileName}`);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        
        const prompt = `You are an expert resume parsing system. Given the text extracted from a candidate's resume, extract their key profile details.
Return ONLY a valid JSON object matching this structure:
{
  "fullName": "Candidate Name (or fallback to file name if not found)",
  "email": "Candidate email address",
  "phone": "Candidate phone number",
  "currentTitle": "Candidate's current or most recent job title/role",
  "totalExp": "Total experience in years (e.g. '3 years', '5 years', or 'Not specified')",
  "highestQual": "Highest education qualification (e.g. 'B.Tech', 'MBA', 'M.Tech', 'Graduate')",
  "skills": "Comma-separated list of key technical and soft skills"
}
Do not include any Markdown blocks, backticks, or prefix. Return raw JSON string ONLY.

Resume Text:
${rawText.slice(0, 10000)} // Truncated to stay safe within model token limits
`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text().trim();
        
        // Clean markdown code blocks if the model accidentally returns them
        let jsonStr = responseText;
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
            notes: 'Successfully parsed using Gemini AI.'
          },
          status: 'parsed'
        };
      } catch (geminiError) {
        console.warn('Gemini AI parsing failed, resorting to fallback parser:', geminiError.message);
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
  const qualOptions = ['10th / SSC', '12th / HSC', 'Diploma', 'Graduate (Any)', 'B.E. / B.Tech', 'MBA / PGDM', 'Post Graduate', 'Doctorate / PhD'];
  for (const opt of qualOptions) {
    if (text.toLowerCase().includes(opt.toLowerCase())) {
      minimumQualification = opt;
      break;
    }
  }

  let otherKeySkills = '';
  const skillsRegex = /(?:skills|key skills|skills required)\s*:\s*([^\n]+)/i;
  const skillsMatch = text.match(skillsRegex);
  if (skillsMatch) otherKeySkills = skillsMatch[1].trim();

  let noOfPositions = '';
  const posRegex = /(?:no\.? of positions|positions|vacancies|vacancy)\s*:\s*(\d+)/i;
  const posMatch = text.match(posRegex);
  if (posMatch) noOfPositions = posMatch[1].trim();

  return {
    designation: designation || guessName(fileName),
    department: department || '',
    location: location || '',
    experience: experience || '',
    minimumQualification: minimumQualification || '',
    otherKeySkills: otherKeySkills || '',
    noOfPositions: noOfPositions || '1',
    urgency: 'Medium',
    purposeOfJob: '',
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
      const pdfData = await pdfParse(fileBuffer);
      rawText = pdfData.text;
    } else if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml') || fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      rawText = result.value;
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
        console.log(`Using Gemini AI API for parsing MRF: ${fileName}`);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        
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
  "preferredIndustries": "Preferred industries (if mentioned)"
}
Do not include any Markdown blocks, backticks, or prefix. Return raw JSON string ONLY.

Document Text:
${rawText.slice(0, 10000)}
`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text().trim();
        
        let jsonStr = responseText;
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
            preferredIndustries: details.preferredIndustries || ''
          },
          status: 'parsed'
        };
      } catch (geminiError) {
        console.warn('Gemini AI MRF parsing failed, resorting to fallback parser:', geminiError.message);
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
        preferredIndustries: ''
      },
      status: 'failed'
    };
  }
}
