import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import JobOpening from '../models/JobOpening.js';
import { scoreCandidate } from './matchService.js';

<<<<<<< Updated upstream
const EXPORTS_DIR = path.join(process.cwd(), 'exports');
=======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixed path — uses local exports folder inside project
const EXPORTS_DIR = process.env.CSV_OUTPUT_PATH
  ? path.resolve(process.env.CSV_OUTPUT_PATH)
  : path.join(__dirname, '..', 'exports');
>>>>>>> Stashed changes

// Get clean filename path
export function getCSVPath(jobOpeningId, designation = 'Position') {
  const cleanName = designation.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(EXPORTS_DIR, `MRF-${cleanName}-${jobOpeningId}.csv`);
}

/**
 * Standard CSV parser (RFC 4180 compliant)
 */
function parseCSV(text) {
  const lines = [];
  let row = [''];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        row[row.length - 1] += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push('');
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      lines.push(row);
      row = [''];
    } else {
      row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || row[0] !== '') {
    lines.push(row);
  }
  return lines;
}

/**
 * Helper to escape CSV cell values
 */
function escapeCSV(val) {
  const str = String(val === null || val === undefined ? '' : val).replace(/"/g, '""');
  return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
}

/**
 * Writes candidates list to the local CSV file
 */
export async function writeCandidatesToCSV(jobOpeningId, designation, candidates) {
  try {
    if (!fs.existsSync(EXPORTS_DIR)) {
      fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    }

    const filePath = getCSVPath(jobOpeningId, designation);
    const opening = await JobOpening.findById(jobOpeningId);

    const headers = [
      'Sr No', 'Candidate Name', 'Contact No', 'Alternet number', 'Mail ID',
      'Current Opening', 'Department', 'Job Location', 'Qualification', 'Total Experience',
      'Current Location', 'Current Company', 'Current CTC', 'Expected CTC', 'Notice Period',
      'Reason For Change', 'Candidate Status', 'Remarks', 'Candidate ID'
    ];

    const statusMap = {
      new: 'New', shortlisted: 'Shortlisted', scheduled: 'Scheduled',
      selected: 'Selected', rejected: 'Rejected', on_hold: 'On Hold'
    };

    const rows = candidates.map((c, index) => {
      const d = c.details || {};
      return [
        index + 1,
        d.fullName || '',
        d.phone || '',
        d.alternatePhone || '',
        d.email || '',
        opening?.designation || '',
        opening?.department || '',
        opening?.location || '',
        d.highestQual || '',
        d.totalExp || '',
        d.currentLocation || '',
        d.currentCompany || '',
        d.currentCtc || '',
        d.expectedCtc || '',
        d.noticePeriod || '',
        d.reasonForChange || '',
        statusMap[c.overallStatus] || c.overallStatus || 'New',
        d.notes || '',
        c._id.toString()
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    fs.writeFileSync(filePath, csvContent, 'utf-8');
    console.log(`Successfully sync-wrote to CSV: ${filePath}`);
    return filePath;
  } catch (error) {
    console.error('Error writing candidates to CSV:', error);
    throw error;
  }
}

/**
 * Reads candidates from local CSV file, syncs them back to DB on change
 */
export async function readCandidatesFromCSV(jobOpeningId, designation) {
  try {
    const filePath = getCSVPath(jobOpeningId, designation);

<<<<<<< Updated upstream
    // If file doesn't exist, retrieve from database, generate it, and return candidates
=======
>>>>>>> Stashed changes
    if (!fs.existsSync(filePath)) {
      const candidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });
      await writeCandidatesToCSV(jobOpeningId, designation, candidates);
      return candidates;
    }

    console.log(`Sync-reading from local CSV: ${filePath}`);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(fileContent);

    if (rows.length <= 1) return [];

    const headers = rows[0].map(h => h.trim());
    const idIdx = headers.indexOf('Candidate ID');
    const nameIdx = headers.indexOf('Candidate Name');
    const phoneIdx = headers.indexOf('Contact No');
    const altPhoneIdx = headers.indexOf('Alternet number');
    const emailIdx = headers.indexOf('Mail ID');
    const qualIdx = headers.indexOf('Qualification');
    const expIdx = headers.indexOf('Total Experience');
    const locIdx = headers.indexOf('Current Location');
    const compIdx = headers.indexOf('Current Company');
    const ctcIdx = headers.indexOf('Current CTC');
    const expCtcIdx = headers.indexOf('Expected CTC');
    const noticeIdx = headers.indexOf('Notice Period');
    const reasonIdx = headers.indexOf('Reason For Change');
    const statusIdx = headers.indexOf('Candidate Status');
    const remarksIdx = headers.indexOf('Remarks');

    const statusReverseMap = {
      'New': 'new', 'Shortlisted': 'shortlisted', 'Scheduled': 'scheduled',
      'Selected': 'selected', 'Rejected': 'rejected', 'On Hold': 'on_hold'
    };

    const opening = await JobOpening.findById(jobOpeningId);
    if (!opening) throw new Error('Associated Job Opening not found');

    const requirements = {
      designation: opening.designation,
      department: opening.department,
      experience: opening.experience,
      minimumQualification: opening.minimumQualification,
      otherKeySkills: opening.otherKeySkills
    };

    const candidates = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < 2 || !row.some(val => val.trim())) continue;

      const candIdStr = idIdx !== -1 ? row[idIdx]?.trim() : '';
      const fullName = nameIdx !== -1 ? row[nameIdx]?.trim() : '';
      const phone = phoneIdx !== -1 ? row[phoneIdx]?.trim() : '';
      const alternatePhone = altPhoneIdx !== -1 ? row[altPhoneIdx]?.trim() : '';
      const email = emailIdx !== -1 ? row[emailIdx]?.trim() : '';
      const highestQual = qualIdx !== -1 ? row[qualIdx]?.trim() : '';
      const totalExp = expIdx !== -1 ? row[expIdx]?.trim() : '';
      const currentLocation = locIdx !== -1 ? row[locIdx]?.trim() : '';
      const currentCompany = compIdx !== -1 ? row[compIdx]?.trim() : '';
      const currentCtc = ctcIdx !== -1 ? row[ctcIdx]?.trim() : '';
      const expectedCtc = expCtcIdx !== -1 ? row[expCtcIdx]?.trim() : '';
      const noticePeriod = noticeIdx !== -1 ? row[noticeIdx]?.trim() : '';
      const reasonForChange = reasonIdx !== -1 ? row[reasonIdx]?.trim() : '';
      const statusStr = statusIdx !== -1 ? row[statusIdx]?.trim() : 'New';
      const notes = remarksIdx !== -1 ? row[remarksIdx]?.trim() : '';

      const overallStatus = statusReverseMap[statusStr] || statusStr.toLowerCase() || 'new';

      let candidate = null;

      if (candIdStr && mongoose.Types.ObjectId.isValid(candIdStr)) {
        candidate = await Candidate.findById(candIdStr);
      }

      if (!candidate) {
        candidate = new Candidate({
          jobOpeningId,
          fileName: `${fullName || 'Offline'}_Resume.pdf`,
          filePath: 'uploads/offline-added',
          parseStatus: 'parsed'
        });
      }

      candidate.details = {
        fullName,
        email,
        phone,
        alternatePhone,
        currentTitle: candidate.details?.currentTitle || opening.designation,
        totalExp,
        highestQual,
        skills: candidate.details?.skills || '',
        currentLocation,
        currentCompany,
        currentCtc,
        expectedCtc,
        noticePeriod,
        reasonForChange,
        notes
      };

      candidate.overallStatus = overallStatus;

<<<<<<< Updated upstream
      // 3. Recalculate score on load in case CSV values edited offline
=======
>>>>>>> Stashed changes
      const combinedDetails = {
        ...candidate.details,
        notes: `${candidate.details.skills || ''} ${candidate.details.notes || ''}`
      };
      const match = scoreCandidate(combinedDetails, requirements);
      candidate.matchScore = match.score;
      candidate.matchLevel = match.matchLevel;
      candidate.matchBreakdown = match.breakdown;

      await candidate.save();
      candidates.push(candidate);
    }

    candidates.sort((a, b) => b.matchScore - a.matchScore);
    return candidates;
  } catch (error) {
    console.error('Error reading candidates from CSV:', error);
    throw error;
  }
}