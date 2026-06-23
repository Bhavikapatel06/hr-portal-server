import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import Notification from '../models/Notification.js';
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
    
    // Notifications for HR Manager
    let highMatches = candidates.filter(c => c.matchScore > 80).length;
    await Notification.create({
      recipientRole: 'hr',
      title: 'New Candidates Applied',
      message: `${candidates.length} new candidate(s) added for ${opening.designation}.`,
      type: 'CANDIDATE_APPLIED',
      link: `/recruitment/job/${opening._id}`
    });
    if (highMatches > 0) {
      await Notification.create({
        recipientRole: 'hr',
        title: 'High Match Candidates',
        message: `${highMatches} candidate(s) match the job requirements (>80%) for ${opening.designation}.`,
        type: 'HIGH_MATCH_CANDIDATE',
        link: `/recruitment/job/${opening._id}`
      });
    }

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

    const normalizedPath = req.file.path.replace(/\\/g, '/');
    let parsed;
    try {
      const fileBuffer = fs.readFileSync(req.file.path);
      parsed = await parseResume(fileBuffer, req.file.originalname, req.file.mimetype);
    } catch (parseError) {
      console.error('Inner resume parsing exception:', parseError);
      parsed = {
        details: {
          fullName: req.file.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
          notes: `Parsing failed: ${parseError.message}`
        },
        status: 'failed'
      };
    }

    res.json({
      details: parsed.details || {},
      fileName: req.file.originalname,
      filePath: normalizedPath,
      fileSize: req.file.size,
      parseStatus: parsed.status || 'failed',
    });
  } catch (error) {
    console.error('Fatal error in parse-resume route:', error);
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

    // Notify HR Manager about the application
    await Notification.create({
      recipientRole: 'hr',
      title: 'New Candidate Applied',
      message: `A new candidate applied for ${opening.designation}.`,
      type: 'CANDIDATE_APPLIED',
      link: `/recruitment/job/${opening._id}`
    });

    if (match.score > 80) {
      await Notification.create({
        recipientRole: 'hr',
        title: 'High Match Candidate',
        message: `A candidate matching the job requirements (>80%) applied for ${opening.designation}.`,
        type: 'HIGH_MATCH_CANDIDATE',
        link: `/recruitment/job/${opening._id}`
      });
    }

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
    
    // Flatten details + map overallStatus to stage for frontend
    const mapped = candidates.map(c => {
      const obj = c.toJSON();
      const d = obj.details || {};
      return {
        ...obj,
        // Flatten details to top-level fields expected by frontend
        name:                 d.fullName         || obj.fileName || 'Unknown',
        email:                d.email            || '',
        phone:                d.phone            || '',
        currentDesignation:   d.currentTitle     || '',
        currentOrganization:  d.currentCompany   || '',
        experience:           d.totalExp         || '',
        currentCTC:           d.currentCtc       || '',
        expectedCTC:          d.expectedCtc      || '',
        noticePeriod:         d.noticePeriod     || '',
        qualification:        d.highestQual      || '',
        skills:               d.skills           || '',
        currentLocation:      d.currentLocation  || '',
        hrNotes:              d.notes            || '',
        // Map interview fields
        interviewDate:        obj.interview?.date          || '',
        interviewTime:        obj.interview?.time          || '',
        interviewMode:        obj.interview?.mode === 'online' ? 'Video Call' : 'In-Person',
        interviewLocation:    obj.interview?.venue         || '',
        interviewNotes:       obj.interview?.notes         || '',
        interviewRound:       obj.interview?.type ? `Round 1 – ${obj.interview.type}` : 'Round 1',
        interviewStatus:      obj.interview?.scheduled ? 'Scheduled' : 'Not Scheduled',
        // Map resume url
        resumeUrl:            obj.filePath ? `http://localhost:5000/${obj.filePath}` : null,
        // Map stage
        stage:                obj.overallStatus || 'Applied',
      };
    });

    res.json(mapped);
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

    let statusChanged = false;
    let oldStatus = candidate.overallStatus;
    
    // Extract stage if sent from frontend
    if (req.body.stage && req.body.stage !== candidate.overallStatus) {
      candidate.overallStatus = req.body.stage;
      statusChanged = true;
    }
    if (req.body.hrNotes !== undefined) {
      candidate.details.notes = req.body.hrNotes;
    }

    // Map flat frontend field names to nested details fields
    const fieldMap = {
      name:                 'fullName',
      email:                'email',
      phone:                'phone',
      currentDesignation:   'currentTitle',
      currentOrganization:  'currentCompany',
      experience:           'totalExp',
      currentCTC:           'currentCtc',
      expectedCTC:          'expectedCtc',
      noticePeriod:         'noticePeriod',
      qualification:        'highestQual',
      skills:               'skills',
      currentLocation:      'currentLocation',
    };
    Object.entries(fieldMap).forEach(([frontKey, backKey]) => {
      if (req.body[frontKey] !== undefined) {
        candidate.details[backKey] = req.body[frontKey];
      }
    });

    // Also accept direct details patch (for backward compat)
    const directFields = ['fullName', 'email', 'phone', 'currentTitle', 'totalExp', 'highestQual', 
      'skills', 'currentLocation', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod'];
    directFields.forEach(key => {
      if (req.body[key] !== undefined) candidate.details[key] = req.body[key];
    });

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
      const combined = { ...candidate.details.toObject(), notes: `${candidate.details.skills || ''} ${candidate.details.notes || ''}` };
      const match = scoreCandidate(combined, requirements);
      candidate.matchScore    = match.score;
      candidate.matchLevel    = match.matchLevel;
      candidate.matchBreakdown = match.breakdown;

      // Sync to MRF and Google Sheet if candidate is offered/joined
      if (candidate.overallStatus === 'Offer' || candidate.overallStatus === 'Joined') {
        opening.offeredCandidateName = candidate.details.fullName || '';
        opening.offeredCTC = candidate.details.expectedCtc || '';
        opening.lastCTC = candidate.details.currentCtc || '';
        opening.lastOrganization = candidate.details.currentCompany || '';
        opening.lastDesignation = candidate.details.currentTitle || '';
        opening.totalPreviousExp = candidate.details.totalExp || '';
        opening.candidateLocation = candidate.details.currentLocation || '';
        if (candidate.overallStatus === 'Joined') {
          opening.actualDOJ = new Date();
          opening.positionStatus = 'Closed';
          opening.requirementStatus = 'Fulfilled';
          opening.offerStatus = 'Joined';
          opening.closedAt = new Date();
        } else {
          opening.offerDate = new Date();
          opening.offerStatus = 'Offered';
        }
        await opening.save();
        
        const { updateMRFInSheet } = await import('../services/googleSheetsService.js');
        await updateMRFInSheet(opening, opening.sheetRowIndex);
      }
    }

    await candidate.save();
    
    // Send Notifications
    if (statusChanged && candidate.details.email) {
      await Notification.create({
        recipientEmail: candidate.details.email,
        title: 'Application Status Updated',
        message: `Your application status for ${opening ? opening.designation : 'the job'} has been updated to ${candidate.overallStatus}.`,
        type: 'STATUS_UPDATE',
        link: '/status'
      });
    }

    // Notify Department Head if candidate is sent for approval
    if (statusChanged && (candidate.overallStatus === 'Pending Head Approval' || candidate.overallStatus === 'Shared with HOD')) {
      const msg = `Candidate ${candidate.details.fullName} is awaiting your approval for ${opening ? opening.designation : 'the job'}.`;
      await Notification.create({
        recipientRole: 'department_head',
        title: 'Candidate Awaiting Approval',
        message: msg,
        type: 'CANDIDATE_APPROVAL_REQUEST',
        link: `/recruitment/candidate/${candidate._id}`
      });
    }

    // Notify HR if candidate is approved by Head
    if (statusChanged && (candidate.overallStatus === 'Approved by Head' || candidate.overallStatus === 'Approved by HOD')) {
      const msg = `Candidate ${candidate.details.fullName} has been approved by the Department Head for ${opening ? opening.designation : 'the job'}. You can now schedule an interview.`;
      await Notification.create({
        recipientRole: 'hr',
        title: 'Candidate Approved by Head',
        message: msg,
        type: 'CANDIDATE_APPROVED_BY_HEAD',
        link: `/recruitment/job/${opening ? opening._id : ''}`
      });
    }

    // Notify HR if candidate is rejected by Head
    if (statusChanged && (oldStatus === 'Pending Head Approval' || oldStatus === 'Shared with HOD') && candidate.overallStatus === 'Rejected') {
      const msg = `Candidate ${candidate.details.fullName} was rejected by the Department Head for ${opening ? opening.designation : 'the job'}.`;
      await Notification.create({
        recipientRole: 'hr',
        title: 'Candidate Rejected by Head',
        message: msg,
        type: 'CANDIDATE_REJECTED_BY_HEAD',
        link: `/recruitment/job/${opening ? opening._id : ''}`
      });
    }

    // Notify HR and Dept Head if hired
    if (statusChanged && (candidate.overallStatus === 'Offer' || candidate.overallStatus === 'Joined')) {
      const msg = candidate.overallStatus === 'Joined' 
        ? `Candidate ${candidate.details.fullName} selected for ${opening.designation}. Job posting closed.`
        : `Candidate ${candidate.details.fullName} was offered the ${opening.designation} role.`;
      await Notification.create({ recipientRole: 'admin', title: 'Candidate Selected', message: msg, type: 'CANDIDATE_HIRED', link: '/dashboard' });
      await Notification.create({ recipientRole: 'department_head', title: 'Candidate Selected', message: msg, type: 'CANDIDATE_HIRED', link: '/my-mrfs' });
    }
    
    // Return flattened object for frontend
    const obj = candidate.toJSON();
    const d = obj.details || {};
    const ret = {
      ...obj,
      name:                d.fullName         || obj.fileName || 'Unknown',
      email:               d.email            || '',
      phone:               d.phone            || '',
      currentDesignation:  d.currentTitle     || '',
      currentOrganization: d.currentCompany   || '',
      experience:          d.totalExp         || '',
      currentCTC:          d.currentCtc       || '',
      expectedCTC:         d.expectedCtc      || '',
      noticePeriod:        d.noticePeriod     || '',
      qualification:       d.highestQual      || '',
      skills:              d.skills           || '',
      currentLocation:     d.currentLocation  || '',
      hrNotes:             d.notes            || '',
      stage:               obj.overallStatus  || 'Applied',
    };
    
    res.json(ret);
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

    const {
      interviewDate, interviewTime, interviewMode, interviewLocation,
      interviewerName, interviewRound, interviewNotes, interviewStatus,
    } = req.body;

    // Map flat frontend fields to the nested interview schema
    const modeMap = { 'In-Person': 'offline', 'Video Call': 'online', 'Phone Screen': 'online', 'Panel': 'offline' };
    const typeMap = {
      'Round 1 – HR Screen': 'HR', 'Round 1': 'HR',
      'Round 2 – Technical': 'Technical', 'Technical': 'Technical',
      'Round 3 – Managerial': 'HR', 'Final Round': 'Final',
    };

    candidate.interview = {
      scheduled: true,
      date:  interviewDate  || candidate.interview?.date  || '',
      time:  interviewTime  || candidate.interview?.time  || '',
      mode:  modeMap[interviewMode] || 'offline',
      type:  typeMap[interviewRound] || 'Technical',
      venue: interviewLocation || candidate.interview?.venue || '',
      notes: interviewNotes   || candidate.interview?.notes || '',
      link:  candidate.interview?.link || '',
    };

    // Move stage to Interview when scheduled
    if (candidate.overallStatus === 'Applied' || candidate.overallStatus === 'Screening' || candidate.overallStatus === 'new' || candidate.overallStatus === 'Approved by Head') {
      candidate.overallStatus = 'Interview';
    }

    await candidate.save();

    if (candidate.details?.email) {
      const dateStr = candidate.interview.date ? ` on ${candidate.interview.date}` : '';
      await Notification.create({
        recipientEmail: candidate.details.email,
        title: 'Interview Scheduled',
        message: `An interview has been scheduled for your application${dateStr}.`,
        type: 'INTERVIEW_SCHEDULED',
        link: '/status'
      });
    }

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

// ── GET /candidates/:id — get single candidate with populated job details ──
router.get('/candidates/:id', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id).populate('jobOpeningId');
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
    
    const obj = candidate.toJSON();
    const d = obj.details || {};
    const ret = {
      ...obj,
      name:                 d.fullName         || obj.fileName || 'Unknown',
      email:                d.email            || '',
      phone:                d.phone            || '',
      currentDesignation:   d.currentTitle     || '',
      currentOrganization:  d.currentCompany   || '',
      experience:           d.totalExp         || '',
      currentCTC:           d.currentCtc       || '',
      expectedCTC:          d.expectedCtc      || '',
      noticePeriod:         d.noticePeriod     || '',
      qualification:        d.highestQual      || '',
      skills:               d.skills           || '',
      currentLocation:      d.currentLocation  || '',
      hrNotes:              d.notes            || '',
      interviewDate:        obj.interview?.date          || '',
      interviewTime:        obj.interview?.time          || '',
      interviewMode:        obj.interview?.mode === 'online' ? 'Video Call' : 'In-Person',
      interviewLocation:    obj.interview?.venue         || '',
      interviewNotes:       obj.interview?.notes         || '',
      interviewRound:       obj.interview?.type ? `Round 1 – ${obj.interview.type}` : 'Round 1',
      interviewStatus:      obj.interview?.scheduled ? 'Scheduled' : 'Not Scheduled',
      resumeUrl:            obj.filePath ? `http://localhost:5000/${obj.filePath}` : null,
      stage:                obj.overallStatus || 'Applied',
    };
    
    res.json(ret);
  } catch (error) {
    console.error('Error retrieving candidate details:', error);
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
    const mapped = candidates.map(c => {
      const obj = c.toJSON();
      obj.stage = obj.overallStatus;
      return obj;
    });
    res.json(mapped);
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
