import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import { parseResume, scoreCandidateAI } from '../services/parserService.js';
import { scoreCandidate } from '../services/matchService.js';
import { buildCandidateCSV } from '../services/csvService.js';

const router = express.Router();

// ── Multer for resume uploads ──────────────────────────────────────────────
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// ── POST /mrf/:jobOpeningId/resumes — batch resume upload (HR side) ────────
router.post('/mrf/:jobOpeningId/resumes', upload.array('resumes'), async (req, res) => {
  const { jobOpeningId } = req.params;
  try {
    const opening = await JobOpening.findById(jobOpeningId);
    if (!opening) {
      if (req.files) req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
      return res.status(404).json({ message: 'Job opening not found' });
    }

    const candidates = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const fileBuffer = fs.readFileSync(file.path);
          const requirements = {
            designation:          opening.designation,
            department:           opening.department,
            experience:           opening.experience,
            minimumQualification: opening.minimumQualification,
            otherKeySkills:       opening.otherKeySkills,
          };

          const parsed = await parseResume(fileBuffer, file.originalname, file.mimetype, requirements);

          let match;
          if (parsed.matchData) {
            match = parsed.matchData;
          } else {
            const combined = { ...parsed.details, notes: `${parsed.details.skills || ''} ${parsed.details.notes || ''}` };
            match = scoreCandidate(combined, requirements);
          }

          const candidate = new Candidate({
            jobOpeningId,
            appliedVia:   'resume_upload',
            fileName:     file.originalname,
            filePath:     file.path,
            fileSize:     file.size,
            parseStatus:  parsed.status,
            details:      parsed.details,
            matchScore:   match.score,
            matchLevel:   match.matchLevel,
            matchBreakdown: match.breakdown,
            overallStatus: 'new',
          });

          await candidate.save();
          candidates.push(candidate);
        } catch (fileError) {
          console.error(`Error parsing file ${file.originalname}:`, fileError);
          const candidate = new Candidate({
            jobOpeningId,
            appliedVia:   'resume_upload',
            fileName:     file.originalname,
            filePath:     file.path,
            fileSize:     file.size,
            parseStatus:  'failed',
            details:      { fullName: file.originalname, notes: `Parsing failed: ${fileError.message}` },
            matchScore:   0,
            matchLevel:   'Low',
            overallStatus: 'new',
          });
          await candidate.save();
          candidates.push(candidate);
        }
      }
    }

    const allCandidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });
    res.status(201).json(allCandidates);
  } catch (error) {
    console.error('Error in batch resume upload:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf/:jobOpeningId/parse-resume — parse resume, return fields, do NOT save ──
router.post('/mrf/:jobOpeningId/parse-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No resume file uploaded' });

    const fileBuffer = fs.readFileSync(req.file.path);
    const parsed = await parseResume(fileBuffer, req.file.originalname, req.file.mimetype);

    res.json({
      details: parsed.details,
      fileName: req.file.originalname,
      filePath: req.file.path,
      fileSize: req.file.size,
    });
  } catch (error) {
    console.error('Error parsing resume:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf/:jobOpeningId/apply — candidate apply via form ───────────────
router.post('/mrf/:jobOpeningId/apply', async (req, res) => {
  const { jobOpeningId } = req.params;
  try {
    const opening = await JobOpening.findById(jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const {
      fullName, email, phone, alternatePhone, currentTitle,
      totalExp, highestQual, skills, currentLocation,
      currentCompany, currentCtc, expectedCtc, noticePeriod,
      reasonForChange, notes,
      fileName, filePath, fileSize,
    } = req.body;

    if (!fullName?.trim()) return res.status(400).json({ message: 'Candidate name is required' });

    const requirements = {
      designation:          opening.designation,
      department:           opening.department,
      experience:           opening.experience,
      minimumQualification: opening.minimumQualification,
      otherKeySkills:       opening.otherKeySkills,
    };

    const details = {
      fullName: fullName.trim(),
      email:           email           || '',
      phone:           phone           || '',
      alternatePhone:  alternatePhone  || '',
      currentTitle:    currentTitle    || opening.designation,
      totalExp:        totalExp        || '',
      highestQual:     highestQual     || '',
      skills:          skills          || '',
      currentLocation: currentLocation || '',
      currentCompany:  currentCompany  || '',
      currentCtc:      currentCtc      || '',
      expectedCtc:     expectedCtc     || '',
      noticePeriod:    noticePeriod    || '',
      reasonForChange: reasonForChange || '',
      notes:           notes           || '',
    };

    const combined = { ...details, notes: `${details.skills || ''} ${details.notes || ''}` };
    const match = scoreCandidate(combined, requirements);

    const candidate = new Candidate({
      jobOpeningId,
      appliedVia:   filePath ? 'resume_upload' : 'apply_form',
      fileName:     fileName || '',
      filePath:     filePath || '',
      fileSize:     fileSize || 0,
      parseStatus:  'parsed',
      details,
      matchScore:   match.score,
      matchLevel:   match.matchLevel,
      matchBreakdown: match.breakdown,
      overallStatus:  'new',
    });

    await candidate.save();
    res.status(201).json(candidate);
  } catch (error) {
    console.error('Error saving candidate application:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:jobOpeningId/candidates — list candidates for an opening ─────
router.get('/mrf/:jobOpeningId/candidates', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });
    const candidates = await Candidate.find({ jobOpeningId: req.params.jobOpeningId }).sort({ matchScore: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving candidates:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:jobOpeningId/download-csv — stream CSV download ─────────────
router.get('/mrf/:jobOpeningId/download-csv', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const candidates = await Candidate.find({ jobOpeningId: req.params.jobOpeningId }).sort({ createdAt: 1 });
    const csv = buildCandidateCSV(opening, candidates);

    const safeName = opening.designation.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="MRF-${safeName}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV download:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PUT /candidates/:id/details — update candidate details & re-score ──────
router.put('/candidates/:id/details', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    candidate.details = { ...candidate.details.toObject(), ...req.body };
    candidate.parseStatus = 'parsed';

    const opening = await JobOpening.findById(candidate.jobOpeningId);
    if (opening) {
      const requirements = {
        designation:          opening.designation,
        department:           opening.department,
        experience:           opening.experience,
        minimumQualification: opening.minimumQualification,
        otherKeySkills:       opening.otherKeySkills,
      };
      const combined = { ...candidate.details, notes: `${candidate.details.skills || ''} ${candidate.details.notes || ''}` };
      const match = scoreCandidate(combined, requirements);
      candidate.matchScore    = match.score;
      candidate.matchLevel    = match.matchLevel;
      candidate.matchBreakdown = match.breakdown;
    }

    await candidate.save();
    res.json(candidate);
  } catch (error) {
    console.error('Error updating candidate details:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PUT /candidates/:id/interview — schedule interview ─────────────────────
router.put('/candidates/:id/interview', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    candidate.interview = { ...candidate.interview.toObject(), ...req.body };
    if (candidate.interview.scheduled) candidate.overallStatus = 'scheduled';

    await candidate.save();
    res.json(candidate);
  } catch (error) {
    console.error('Error scheduling interview:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PUT /candidates/:id/feedback — record decision ─────────────────────────
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
    res.json(candidate);
  } catch (error) {
    console.error('Error updating feedback:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── DELETE /candidates/:id — delete candidate ──────────────────────────────
router.delete('/candidates/:id', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    if (candidate.filePath && fs.existsSync(candidate.filePath)) {
      try { fs.unlinkSync(candidate.filePath); } catch (e) { /* ignore */ }
    }

    await Candidate.findByIdAndDelete(req.params.id);
    res.json({ message: 'Candidate deleted successfully' });
  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates — all candidates globally (dashboard stats) ────────────
router.get('/candidates', async (req, res) => {
  try {
    const candidates = await Candidate.find().populate('jobOpeningId').sort({ createdAt: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving all candidates:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/download-all — global FIFO CSV across all openings ─────
router.get('/candidates/download-all', async (req, res) => {
  try {
    // FIFO: oldest application first
    const candidates = await Candidate.find()
      .populate('jobOpeningId')
      .sort({ createdAt: 1 });

    const STATUS_MAP = {
      new: 'New', shortlisted: 'Shortlisted', scheduled: 'Scheduled',
      selected: 'Selected', rejected: 'Rejected', on_hold: 'On Hold',
    };

    const HEADERS = [
      'Sr. No', 'Candidate Name', 'Contact No', 'Alternate Number', 'Mail ID',
      'Current Opening', 'Department', 'Job Location', 'Qualification', 'Total Experience',
      'Current Location', 'Current Company', 'Current CTC', 'Expected CTC', 'Notice Period',
      'Reason For Change', 'Candidate Status', 'Remarks',
    ];

    const escapeCell = (val) => {
      const str = String(val === null || val === undefined ? '' : val).replace(/"/g, '""');
      return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
    };

    const rows = candidates.map((c, i) => {
      const d  = c.details || {};
      const jo = c.jobOpeningId || {};
      return [
        i + 1,
        d.fullName        || '',
        d.phone           || '',
        d.alternatePhone  || '',
        d.email           || '',
        (typeof jo === 'object' ? jo.designation : '') || '',
        (typeof jo === 'object' ? jo.department  : '') || '',
        (typeof jo === 'object' ? jo.location    : '') || '',
        d.highestQual     || '',
        d.totalExp        || '',
        d.currentLocation || '',
        d.currentCompany  || '',
        d.currentCtc      || '',
        d.expectedCtc     || '',
        d.noticePeriod    || '',
        d.reasonForChange || '',
        STATUS_MAP[c.overallStatus] || c.overallStatus || 'New',
        d.notes           || '',
      ].map(escapeCell).join(',');
    });

    const csv = [HEADERS.map(escapeCell).join(','), ...rows].join('\n');
    const now = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="All-Candidates-${now}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating all-candidates CSV:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/status/:email — get status for all applications by email ──
router.get('/candidates/status/:email', async (req, res) => {
  try {
    const candidates = await Candidate.find({ 'details.email': req.params.email })
      .populate('jobOpeningId')
      .sort({ createdAt: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving candidates by email:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /score-preview — Live AI match scoring for frontend preview ───────
router.post('/score-preview', async (req, res) => {
  try {
    const { candidateDetails, requirements } = req.body;
    if (!candidateDetails || !requirements) {
      return res.status(400).json({ message: 'Missing candidateDetails or requirements' });
    }
    
    try {
      const matchData = await scoreCandidateAI(candidateDetails, requirements);
      res.json(matchData);
    } catch (aiError) {
      console.warn('AI scoring failed, falling back to rule-based engine:', aiError.message);
      const combined = { ...candidateDetails, notes: `${candidateDetails.skills || ''} ${candidateDetails.notes || ''}` };
      const match = scoreCandidate(combined, requirements);
      res.json({
        score: match.score,
        matchLevel: match.matchLevel,
        breakdown: match.breakdown
      });
    }
  } catch (error) {
    console.error('Error in score preview:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
