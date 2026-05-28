import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import { parseResume } from '../services/parserService.js';
import { scoreCandidate } from '../services/matchService.js';
import { readCandidatesFromCSV, writeCandidatesToCSV, getCSVPath } from '../services/csvService.js';


const router = express.Router();

// Configure multer for file uploads
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique name keeping original extension
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Upload batch of resumes for a specific MRF
router.post('/mrf/:jobOpeningId/resumes', upload.array('resumes'), async (req, res) => {
  const { jobOpeningId } = req.params;
  try {
    const opening = await JobOpening.findById(jobOpeningId);
    if (!opening) {
      // Cleanup uploaded files on error
      if (req.files) {
        req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
      }
      return res.status(404).json({ message: 'Job opening not found' });
    }

    const candidates = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const fileBuffer = fs.readFileSync(file.path);
          const parsed = await parseResume(fileBuffer, file.originalname, file.mimetype);

          // Score against Job Opening requirements
          const requirements = {
            designation: opening.designation,
            department: opening.department,
            experience: opening.experience,
            minimumQualification: opening.minimumQualification,
            otherKeySkills: opening.otherKeySkills
          };
          const combinedDetails = {
            ...parsed.details,
            notes: `${parsed.details.skills || ''} ${parsed.details.notes || ''}`
          };
          const match = scoreCandidate(combinedDetails, requirements);

          const candidate = new Candidate({
            jobOpeningId,
            fileName: file.originalname,
            filePath: file.path,
            fileSize: file.size,
            parseStatus: parsed.status,
            details: parsed.details,
            matchScore: match.score,
            matchLevel: match.matchLevel,
            matchBreakdown: match.breakdown,
            overallStatus: 'new'
          });

          await candidate.save();
          candidates.push(candidate);
        } catch (fileError) {
          console.error(`Error parsing file ${file.originalname}:`, fileError);
          // Save with failed status so user knows it failed but still can view it
          const candidate = new Candidate({
            jobOpeningId,
            fileName: file.originalname,
            filePath: file.path,
            fileSize: file.size,
            parseStatus: 'failed',
            details: {
              fullName: file.originalname,
              notes: `Parsing failed: ${fileError.message}`
            },
            matchScore: 0,
            matchLevel: 'Low',
            overallStatus: 'new'
          });
          await candidate.save();
          candidates.push(candidate);
        }
      }
    }

    // Return all candidates for this opening sorted by matchScore descending
    const allCandidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });
    await writeCandidatesToCSV(jobOpeningId, opening.designation, allCandidates);
    res.status(201).json(allCandidates);
  } catch (error) {
    console.error('Error in batch resume upload:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get all candidates for a specific MRF
router.get('/mrf/:jobOpeningId/candidates', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });
    const candidates = await readCandidatesFromCSV(req.params.jobOpeningId, opening.designation);
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving candidates:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update candidate parsed details manually & re-score
router.put('/candidates/:id/details', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    // Update details properties
    candidate.details = { ...candidate.details.toObject(), ...req.body };
    candidate.parseStatus = 'parsed'; // Mark as parsed since user entered info

    // Re-score candidate against original opening
    const opening = await JobOpening.findById(candidate.jobOpeningId);
    if (opening) {
      const requirements = {
        designation: opening.designation,
        department: opening.department,
        experience: opening.experience,
        minimumQualification: opening.minimumQualification,
        otherKeySkills: opening.otherKeySkills
      };
      const combinedDetails = {
        ...candidate.details,
        notes: `${candidate.details.skills || ''} ${candidate.details.notes || ''}`
      };
      const match = scoreCandidate(combinedDetails, requirements);
      candidate.matchScore = match.score;
      candidate.matchLevel = match.matchLevel;
      candidate.matchBreakdown = match.breakdown;
    }

    await candidate.save();

    if (opening) {
      const candidates = await Candidate.find({ jobOpeningId: candidate.jobOpeningId }).sort({ matchScore: -1 });
      await writeCandidatesToCSV(candidate.jobOpeningId, opening.designation, candidates);
    }

    res.json(candidate);
  } catch (error) {
    console.error('Error updating candidate details:', error);
    res.status(500).json({ message: error.message });
  }
});

// Schedule interview
router.put('/candidates/:id/interview', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    candidate.interview = { ...candidate.interview.toObject(), ...req.body };
    if (candidate.interview.scheduled) {
      candidate.overallStatus = 'scheduled';
    }

    await candidate.save();

    const opening = await JobOpening.findById(candidate.jobOpeningId);
    if (opening) {
      const candidates = await Candidate.find({ jobOpeningId: candidate.jobOpeningId }).sort({ matchScore: -1 });
      await writeCandidatesToCSV(candidate.jobOpeningId, opening.designation, candidates);
    }

    res.json(candidate);
  } catch (error) {
    console.error('Error scheduling interview:', error);
    res.status(500).json({ message: error.message });
  }
});

// Record feedback & make final decision
router.put('/candidates/:id/feedback', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    candidate.feedback = { ...candidate.feedback.toObject(), ...req.body };
    if (candidate.feedback.given) {
      candidate.feedback.decidedAt = new Date();
      if (candidate.feedback.decision && candidate.feedback.decision !== 'shortlisted') {
        candidate.overallStatus = candidate.feedback.decision;
      }
    }

    await candidate.save();

    const opening = await JobOpening.findById(candidate.jobOpeningId);
    if (opening) {
      const candidates = await Candidate.find({ jobOpeningId: candidate.jobOpeningId }).sort({ matchScore: -1 });
      await writeCandidatesToCSV(candidate.jobOpeningId, opening.designation, candidates);
    }

    res.json(candidate);
  } catch (error) {
    console.error('Error updating feedback:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete candidate & resume file
router.delete('/candidates/:id', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    // Remove resume file from disk
    if (candidate.filePath && fs.existsSync(candidate.filePath)) {
      try {
        fs.unlinkSync(candidate.filePath);
      } catch (fileErr) {
        console.warn(`Failed to delete physical file at ${candidate.filePath}:`, fileErr.message);
      }
    }

    const jobOpeningId = candidate.jobOpeningId;
    await Candidate.findByIdAndDelete(req.params.id);

    const opening = await JobOpening.findById(jobOpeningId);
    if (opening) {
      const candidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });
      await writeCandidatesToCSV(jobOpeningId, opening.designation, candidates);
    }

    res.json({ message: 'Candidate deleted successfully' });
  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get all candidates across all openings (for general metrics/dashboard)
router.get('/candidates', async (req, res) => {
  try {
    const candidates = await Candidate.find().populate('jobOpeningId').sort({ createdAt: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving all candidates:', error);
    res.status(500).json({ message: error.message });
  }
});

// Export candidates to local CSV file directly on user's hard drive
router.post('/candidates/export-local', async (req, res) => {
  const { jobOpeningId } = req.body;
  try {
    const candidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });
    const opening = await JobOpening.findById(jobOpeningId);

    // Headers matching user's photo report format
    const headers = [
      'Sr No', 'Candidate Name', 'Contact No', 'Alternet number', 'Mail ID',
      'Current Opening', 'Department', 'Job Location', 'Qualification', 'Total Experience',
      'Current Location', 'Current Company', 'Current CTC', 'Expected CTC', 'Notice Period',
      'Reason For Change', 'Candidate Status', 'Remarks'
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
        d.notes || ''
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row =>
        row.map(val => {
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
        }).join(',')
      )
    ].join('\n');

    // Write directly to local path!
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }
    const targetPath = path.join(exportsDir, 'Book1.csv');
    fs.writeFileSync(targetPath, csvContent, 'utf-8');

    res.json({ message: `Data successfully exported to ${targetPath}` });
  } catch (error) {
    console.error('Error exporting to local path:', error);
    res.status(500).json({ message: error.message });
  }
});

// Download the local CSV file directly for a specific MRF
router.get('/mrf/:jobOpeningId/download-csv', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const filePath = getCSVPath(opening._id.toString(), opening.designation);

    // If the file doesn't exist, read from DB and write it first
    if (!fs.existsSync(filePath)) {
      await readCandidatesFromCSV(opening._id.toString(), opening.designation);
    }

    res.download(filePath, `MRF-${opening.designation.replace(/[^a-zA-Z0-9]/g, '_')}-${opening._id}.csv`);
  } catch (error) {
    console.error('Error downloading CSV:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
