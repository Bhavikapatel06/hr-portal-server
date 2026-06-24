import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import Notification from '../models/Notification.js';
import { parseResume, scoreCandidateAI } from '../services/parserService.js';
import { scoreCandidate } from '../services/matchService.js';
import { buildCandidateCSV } from '../services/csvService.js';
import { syncCandidateToSheet, deleteCandidateFromSheet } from '../services/googleSheetsService.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

const flattenCandidate = (candidate) => {
  const obj = candidate.toJSON();
  const d = obj.details || {};
  const interview = obj.interview || {};
  return {
    ...obj,
    name: d.fullName || obj.fileName || 'Unknown',
    email: d.email || '',
    phone: d.phone || '',
    currentDesignation: d.currentTitle || '',
    currentOrganization: d.currentCompany || '',
    experience: d.totalExp || '',
    currentCTC: d.currentCtc || '',
    expectedCTC: d.expectedCtc || '',
    noticePeriod: d.noticePeriod || '',
    qualification: d.highestQual || '',
    skills: d.skills || '',
    currentLocation: d.currentLocation || '',
    hrNotes: d.notes || '',
    interviewDate: interview.date || '',
    interviewTime: interview.time || '',
    interviewMode: interview.mode === 'online' ? 'Video Call' : 'In-Person',
    interviewLocation: interview.venue || interview.link || '',
    interviewNotes: interview.notes || '',
    interviewRound: interview.type ? `Round 1 - ${interview.type}` : 'Round 1',
    interviewStatus: interview.scheduled ? 'Scheduled' : 'Not Scheduled',
    interviewerName: interview.interviewerName || '',
    interviewerEmail: interview.interviewerEmail || '',
    interviewerAvailabilityStatus: interview.availabilityStatus || '',
    interviewerReason: interview.interviewerReason || '',
    candidateNotified: !!interview.candidateNotified,
    resumeUrl: obj.filePath ? `http://localhost:5000/${obj.filePath}` : null,
    stage: obj.overallStatus || 'Applied',
  };
};

// Optional auth helper: attaches req.user if a valid token is present, but never blocks.
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  // Re-use protect logic but swallow errors
  try {
    await new Promise((resolve, reject) => {
      protect(req, res, (err) => (err ? reject(err) : resolve()));
    });
  } catch (_) { /* ignore */ }
  next();
};

// ── Multer for resume uploads ──────────────────────────────────────────────
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
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
            designation: opening.designation,
            department: opening.department,
            experience: opening.experience,
            minimumQualification: opening.minimumQualification,
            otherKeySkills: opening.otherKeySkills,
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
            appliedVia: 'resume_upload',
            fileName: file.originalname,
            filePath: file.path,
            fileSize: file.size,
            parseStatus: parsed.status,
            details: parsed.details,
            matchScore: match.score,
            matchLevel: match.matchLevel,
            matchBreakdown: match.breakdown,
            overallStatus: 'new',
          });

          await candidate.save();
          candidates.push(candidate);
          await syncCandidateToSheet(candidate);
        } catch (fileError) {
          console.error(`Error parsing file ${file.originalname}:`, fileError);
          const candidate = new Candidate({
            jobOpeningId,
            appliedVia: 'resume_upload',
            fileName: file.originalname,
            filePath: file.path,
            fileSize: file.size,
            parseStatus: 'failed',
            details: { fullName: file.originalname, notes: `Parsing failed: ${fileError.message}` },
            matchScore: 0,
            matchLevel: 'Low',
            overallStatus: 'new',
          });
          await candidate.save();
          candidates.push(candidate);
          await syncCandidateToSheet(candidate);
        }
      }
    }

    const allCandidates = await Candidate.find({ jobOpeningId }).sort({ matchScore: -1 });

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

// ── POST /mrf/:jobOpeningId/parse-resume — parse resume, do NOT save ───────
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
//
// Data Isolation: if a candidate is logged in, the candidate's user email
// from the JWT is used as the authoritative email on the application,
// preventing impersonation of other candidates.
router.post('/mrf/:jobOpeningId/apply', protect, async (req, res) => {
  const { jobOpeningId } = req.params;
  try {
    if (req.user.role !== 'candidate') {
      return res.status(403).json({ message: 'Only candidate accounts may apply.' });
    }

    const opening = await JobOpening.findById(jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const {
      fullName, phone, alternatePhone, currentTitle,
      totalExp, highestQual, skills, currentLocation,
      currentCompany, currentCtc, expectedCtc, noticePeriod,
      reasonForChange, notes,
      fileName, filePath, fileSize,
    } = req.body;

    const candidateName = (fullName || req.user.name || '').trim();
    if (!candidateName) return res.status(400).json({ message: 'Candidate name is required' });

    // Prevent duplicate applications by the same candidate for the same job
    const existing = await Candidate.findOne({
      jobOpeningId,
      'details.email': req.user.email,
    });
    if (existing) {
      return res.status(409).json({ message: 'You have already applied to this position.' });
    }

    const requirements = {
      designation: opening.designation,
      department: opening.department,
      experience: opening.experience,
      minimumQualification: opening.minimumQualification,
      otherKeySkills: opening.otherKeySkills,
    };

    const details = {
      fullName: candidateName,
      email: req.user.email, // <-- AUTHORITATIVE: from logged-in user
      phone: phone || '',
      alternatePhone: alternatePhone || '',
      currentTitle: currentTitle || opening.designation,
      totalExp: totalExp || '',
      highestQual: highestQual || '',
      skills: skills || '',
      currentLocation: currentLocation || '',
      currentCompany: currentCompany || '',
      currentCtc: currentCtc || '',
      expectedCtc: expectedCtc || '',
      noticePeriod: noticePeriod || '',
      reasonForChange: reasonForChange || '',
      notes: notes || '',
    };

    const combined = { ...details, notes: `${details.skills || ''} ${details.notes || ''}` };
    const match = scoreCandidate(combined, requirements);

    const candidate = new Candidate({
      jobOpeningId,
      appliedVia: filePath ? 'resume_upload' : 'apply_form',
      fileName: fileName || '',
      filePath: filePath || '',
      fileSize: fileSize || 0,
      parseStatus: 'parsed',
      details,
      matchScore: match.score,
      matchLevel: match.matchLevel,
      matchBreakdown: match.breakdown,
      overallStatus: 'new',
    });

    await candidate.save();
    await syncCandidateToSheet(candidate);

    await Notification.create({
      recipientRole: 'hr',
      title: 'New Candidate Applied',
      message: `${details.fullName} applied for ${opening.designation}.`,
      type: 'CANDIDATE_APPLIED',
      link: `/recruitment/job/${opening._id}`
    });

    // Confirmation notification only to THIS candidate
    await Notification.create({
      recipientEmail: req.user.email,
      title: 'Application Submitted',
      message: `Your application for ${opening.designation} has been received. We will keep you posted.`,
      type: 'APPLICATION_SUBMITTED',
      link: '/status',
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

    const mapped = candidates.map(c => {
      const obj = c.toJSON();
      const d = obj.details || {};
      return {
        ...obj,
        name: d.fullName || obj.fileName || 'Unknown',
        email: d.email || '',
        phone: d.phone || '',
        currentDesignation: d.currentTitle || '',
        currentOrganization: d.currentCompany || '',
        experience: d.totalExp || '',
        currentCTC: d.currentCtc || '',
        expectedCTC: d.expectedCtc || '',
        noticePeriod: d.noticePeriod || '',
        qualification: d.highestQual || '',
        skills: d.skills || '',
        currentLocation: d.currentLocation || '',
        hrNotes: d.notes || '',
        interviewDate: obj.interview?.date || '',
        interviewTime: obj.interview?.time || '',
        interviewMode: obj.interview?.mode === 'online' ? 'Video Call' : 'In-Person',
        interviewLocation: obj.interview?.venue || '',
        interviewNotes: obj.interview?.notes || '',
        interviewRound: obj.interview?.type ? `Round 1 – ${obj.interview.type}` : 'Round 1',
        interviewStatus: obj.interview?.scheduled ? 'Scheduled' : 'Not Scheduled',
        interviewerName: obj.interview?.interviewerName || '',
        interviewerEmail: obj.interview?.interviewerEmail || '',
        interviewerAvailabilityStatus: obj.interview?.availabilityStatus || '',
        interviewerReason: obj.interview?.interviewerReason || '',
        candidateNotified: !!obj.interview?.candidateNotified,
        resumeUrl: obj.filePath ? `http://localhost:5000/${obj.filePath}` : null,
        stage: obj.overallStatus || 'Applied',
      };
    });

    res.json(mapped);
  } catch (error) {
    console.error('Error retrieving candidates:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:jobOpeningId/download-csv — stream CSV download ──────────────
router.get('/mrf/:jobOpeningId/download-csv', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.jobOpeningId);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const candidates = await Candidate.find({ jobOpeningId: req.params.jobOpeningId }).sort({ createdAt: 1 });
    const csv = buildCandidateCSV(opening, candidates);

    const safeName = opening.designation.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"MRF-${safeName}.csv\"`);
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

    if (req.body.stage && req.body.stage !== candidate.overallStatus) {
      candidate.overallStatus = req.body.stage;
      statusChanged = true;
    }
    if (req.body.hrNotes !== undefined) {
      candidate.details.notes = req.body.hrNotes;
    }

    const fieldMap = {
      name: 'fullName',
      email: 'email',
      phone: 'phone',
      currentDesignation: 'currentTitle',
      currentOrganization: 'currentCompany',
      experience: 'totalExp',
      currentCTC: 'currentCtc',
      expectedCTC: 'expectedCtc',
      noticePeriod: 'noticePeriod',
      qualification: 'highestQual',
      skills: 'skills',
      currentLocation: 'currentLocation',
    };
    Object.entries(fieldMap).forEach(([frontKey, backKey]) => {
      if (req.body[frontKey] !== undefined) {
        candidate.details[backKey] = req.body[frontKey];
      }
    });

    const directFields = ['fullName', 'email', 'phone', 'currentTitle', 'totalExp', 'highestQual',
      'skills', 'currentLocation', 'currentCompany', 'currentCtc', 'expectedCtc', 'noticePeriod'];
    directFields.forEach(key => {
      if (req.body[key] !== undefined) candidate.details[key] = req.body[key];
    });

    candidate.parseStatus = 'parsed';

    const opening = await JobOpening.findById(candidate.jobOpeningId);
    if (opening) {
      const requirements = {
        designation: opening.designation,
        department: opening.department,
        experience: opening.experience,
        minimumQualification: opening.minimumQualification,
        otherKeySkills: opening.otherKeySkills,
      };
      const combined = { ...candidate.details.toObject(), notes: `${candidate.details.skills || ''} ${candidate.details.notes || ''}` };
      const match = scoreCandidate(combined, requirements);
      candidate.matchScore = match.score;
      candidate.matchLevel = match.matchLevel;
      candidate.matchBreakdown = match.breakdown;

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
    await syncCandidateToSheet(candidate);

    // Targeted notifications — sent ONLY to the affected candidate by email
    if (statusChanged && candidate.details.email) {
      await Notification.create({
        recipientEmail: candidate.details.email,
        title: 'Application Status Updated',
        message: `Your application status for ${opening ? opening.designation : 'the job'} has been updated to ${candidate.overallStatus}.`,
        type: 'STATUS_UPDATE',
        link: '/status'
      });
    }

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

    if (statusChanged && (candidate.overallStatus === 'Offer' || candidate.overallStatus === 'Joined')) {
      const msg = candidate.overallStatus === 'Joined'
        ? `Candidate ${candidate.details.fullName} selected for ${opening.designation}. Job posting closed.`
        : `Candidate ${candidate.details.fullName} was offered the ${opening.designation} role.`;
      await Notification.create({ recipientRole: 'admin', title: 'Candidate Selected', message: msg, type: 'CANDIDATE_HIRED', link: '/dashboard' });
      await Notification.create({ recipientRole: 'department_head', title: 'Candidate Selected', message: msg, type: 'CANDIDATE_HIRED', link: '/my-mrfs' });
    }

    const obj = candidate.toJSON();
    const d = obj.details || {};
    const ret = {
      ...obj,
      name: d.fullName || obj.fileName || 'Unknown',
      email: d.email || '',
      phone: d.phone || '',
      currentDesignation: d.currentTitle || '',
      currentOrganization: d.currentCompany || '',
      experience: d.totalExp || '',
      currentCTC: d.currentCtc || '',
      expectedCTC: d.expectedCtc || '',
      noticePeriod: d.noticePeriod || '',
      qualification: d.highestQual || '',
      skills: d.skills || '',
      currentLocation: d.currentLocation || '',
      hrNotes: d.notes || '',
      stage: obj.overallStatus || 'Applied',
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
      interviewerName, interviewerEmail, interviewRound, interviewNotes,
    } = req.body;

    const modeMap = { 'In-Person': 'offline', 'Video Call': 'online', 'Phone Screen': 'online', 'Panel': 'offline' };
    const typeMap = {
      'Round 1 – HR Screen': 'HR', 'Round 1': 'HR',
      'Round 2 – Technical': 'Technical', 'Technical': 'Technical',
      'Round 3 – Managerial': 'HR', 'Final Round': 'Final',
    };

    candidate.interview = {
      scheduled: true,
      date: interviewDate || candidate.interview?.date || '',
      time: interviewTime || candidate.interview?.time || '',
      mode: modeMap[interviewMode] || 'offline',
      type: typeMap[interviewRound] || 'Technical',
      venue: interviewLocation || candidate.interview?.venue || '',
      notes: interviewNotes || candidate.interview?.notes || '',
      link: (interviewLocation || '').startsWith('http') ? interviewLocation : candidate.interview?.link || '',
      interviewerName: interviewerName || candidate.interview?.interviewerName || '',
      interviewerEmail: (interviewerEmail || candidate.interview?.interviewerEmail || 'interviewer@hrportal.com').toLowerCase(),
      availabilityStatus: 'pending',
      interviewerReason: '',
      respondedAt: null,
      candidateNotified: false,
      candidateNotifiedAt: null,
    };

    if (candidate.overallStatus === 'Applied' || candidate.overallStatus === 'Screening' || candidate.overallStatus === 'new' || candidate.overallStatus === 'Approved by Head') {
      candidate.overallStatus = 'Interview';
    }

    await candidate.save();
    await syncCandidateToSheet(candidate);

    const opening = await JobOpening.findById(candidate.jobOpeningId);
    // Interviewer-specific notification (single recipient)
    await Notification.create({
      recipientEmail: candidate.interview.interviewerEmail,
      title: 'Interview Availability Requested',
      message: `Please confirm availability for ${candidate.details?.fullName || 'a candidate'} on ${candidate.interview.date || 'the selected date'} at ${candidate.interview.time || 'the selected time'}${opening ? ` for ${opening.designation}` : ''}.`,
      type: 'INTERVIEW_AVAILABILITY_REQUEST',
      link: '/interviews'
    });

    res.json(flattenCandidate(candidate));
  } catch (error) {
    console.error('Error scheduling interview:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /interviews/me - interviewer dashboard requests
router.get('/interviews/me', async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase();
    if (!email) return res.status(400).json({ message: 'Interviewer email is required' });

    const candidates = await Candidate.find({
      'interview.scheduled': true,
      'interview.interviewerEmail': email,
    }).populate('jobOpeningId').sort({ 'interview.date': 1, 'interview.time': 1, createdAt: -1 });

    res.json(candidates.map(flattenCandidate));
  } catch (error) {
    console.error('Error loading interviewer requests:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /candidates/:id/interview-response - interviewer accepts/rejects slot
router.patch('/candidates/:id/interview-response', async (req, res) => {
  try {
    const { status, reason = '' } = req.body;
    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be accepted or rejected' });
    }

    const candidate = await Candidate.findById(req.params.id).populate('jobOpeningId');
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    candidate.interview.availabilityStatus = status;
    candidate.interview.interviewerReason = reason;
    candidate.interview.respondedAt = new Date();
    await candidate.save();
    await syncCandidateToSheet(candidate);

    const candidateName = candidate.details?.fullName || 'Candidate';
    const jobName = candidate.jobOpeningId?.designation || 'the job';
    await Notification.create({
      recipientRole: 'hr',
      title: status === 'accepted' ? 'Interviewer Accepted Slot' : 'Interviewer Rejected Slot',
      message: status === 'accepted'
        ? `${candidate.interview.interviewerName || 'Interviewer'} accepted the interview slot for ${candidateName} (${jobName}).`
        : `${candidate.interview.interviewerName || 'Interviewer'} rejected the interview slot for ${candidateName} (${jobName}). Reason: ${reason || 'No reason provided'}`,
      type: status === 'accepted' ? 'INTERVIEWER_ACCEPTED' : 'INTERVIEWER_REJECTED',
      link: `/recruitment/candidate/${candidate._id}`
    });

    res.json(flattenCandidate(candidate));
  } catch (error) {
    console.error('Error saving interviewer response:', error);
    res.status(500).json({ message: error.message });
  }
});

// POST /candidates/:id/notify-candidate - HR confirms interview to candidate
//
// Data Isolation: notification recipient is the specific candidate's email
// (stored on the Candidate document). No other candidate will see it.
router.post('/candidates/:id/notify-candidate', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id).populate('jobOpeningId');
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
    if (candidate.interview?.availabilityStatus !== 'accepted') {
      return res.status(400).json({ message: 'Candidate can be notified only after interviewer accepts the slot.' });
    }
    if (!candidate.details?.email) {
      return res.status(400).json({ message: 'Candidate email is missing.' });
    }

    const dateStr = candidate.interview.date ? ` on ${candidate.interview.date}` : '';
    const timeStr = candidate.interview.time ? ` at ${candidate.interview.time}` : '';
    const place = candidate.interview.venue || candidate.interview.link || '';
    await Notification.create({
      recipientEmail: candidate.details.email, // <-- targets ONLY this candidate
      title: 'Interview Scheduled',
      message: `Your interview for ${candidate.jobOpeningId?.designation || 'the role'} is confirmed${dateStr}${timeStr}${place ? `. Location/link: ${place}` : ''}.`,
      type: 'INTERVIEW_SCHEDULED',
      link: '/status'
    });

    candidate.interview.candidateNotified = true;
    candidate.interview.candidateNotifiedAt = new Date();
    await candidate.save();
    await syncCandidateToSheet(candidate);

    res.json(flattenCandidate(candidate));
  } catch (error) {
    console.error('Error notifying candidate:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PUT /candidates/:id/feedback ───────────────────────────────────────────
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
    await syncCandidateToSheet(candidate);
    res.json(candidate);
  } catch (error) {
    console.error('Error updating feedback:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/download-all (must precede /candidates/:id) ────────────
router.get('/candidates/download-all', async (req, res) => {
  try {
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
      const str = String(val === null || val === undefined ? '' : val).replace(/\"/g, '\"\"');
      return str.includes(',') || str.includes('\n') || str.includes('"')
  ? `"${str}"`
  : str;
    };

    const rows = candidates.map((c, i) => {
      const d = c.details || {};
      const jo = c.jobOpeningId || {};
      return [
        i + 1,
        d.fullName || '',
        d.phone || '',
        d.alternatePhone || '',
        d.email || '',
        (typeof jo === 'object' ? jo.designation : '') || '',
        (typeof jo === 'object' ? jo.department : '') || '',
        (typeof jo === 'object' ? jo.location : '') || '',
        d.highestQual || '',
        d.totalExp || '',
        d.currentLocation || '',
        d.currentCompany || '',
        d.currentCtc || '',
        d.expectedCtc || '',
        d.noticePeriod || '',
        d.reasonForChange || '',
        STATUS_MAP[c.overallStatus] || c.overallStatus || 'New',
        d.notes || '',
      ].map(escapeCell).join(',');
    });

  const csv = [HEADERS.map(escapeCell).join(','), ...rows].join("\n");
    const now = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"All-Candidates-${now}.csv\"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating all-candidates CSV:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/me — return the logged-in candidate's applications ─────
// Used by the candidate dashboard. Strictly scoped to the JWT user's email.
router.get('/candidates/me', protect, async (req, res) => {
  try {
    if (req.user.role !== 'candidate') {
      return res.status(403).json({ message: 'Only candidate accounts may use this endpoint.' });
    }
    const candidates = await Candidate.find({ 'details.email': req.user.email })
      .populate('jobOpeningId')
      .sort({ createdAt: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving my candidate applications:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/status/:email ──────────────────────────────────────────
//
// Data Isolation:
//   - Candidates may only query their OWN email; any other email returns 403.
//   - Staff (hr/admin/department_head/interviewer) may query any email.
router.get('/candidates/status/:email', protect, async (req, res) => {
  try {
    const queried = (req.params.email || '').toLowerCase();
    const myEmail = (req.user.email || '').toLowerCase();
    const isStaff = ['hr', 'admin', 'department_head', 'interviewer'].includes(req.user.role);

    if (!isStaff && queried !== myEmail) {
    return res.status(403).json({
  message: "Forbidden: cannot view another candidate's data."
});
    }

    const candidates = await Candidate.find({ 'details.email': queried })
      .populate('jobOpeningId')
      .sort({ createdAt: -1 });
    res.json(candidates);
  } catch (error) {
    console.error('Error retrieving candidates by email:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates/:id — single candidate ─────────────────────────────────
//
// Data Isolation: a candidate may only read a record whose details.email
// matches their own logged-in email.
router.get('/candidates/:id', optionalAuth, async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id).populate('jobOpeningId');
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    if (req.user && req.user.role === 'candidate') {
      if ((candidate.details?.email || '').toLowerCase() !== (req.user.email || '').toLowerCase()) {
        return res.status(403).json({
  message: "Forbidden: cannot view another candidate's data."
});
      }
    }

    const obj = candidate.toJSON();
    const d = obj.details || {};
    const ret = {
      ...obj,
      name: d.fullName || obj.fileName || 'Unknown',
      email: d.email || '',
      phone: d.phone || '',
      currentDesignation: d.currentTitle || '',
      currentOrganization: d.currentCompany || '',
      experience: d.totalExp || '',
      currentCTC: d.currentCtc || '',
      expectedCTC: d.expectedCtc || '',
      noticePeriod: d.noticePeriod || '',
      qualification: d.highestQual || '',
      skills: d.skills || '',
      currentLocation: d.currentLocation || '',
      hrNotes: d.notes || '',
      interviewDate: obj.interview?.date || '',
      interviewTime: obj.interview?.time || '',
      interviewMode: obj.interview?.mode === 'online' ? 'Video Call' : 'In-Person',
      interviewLocation: obj.interview?.venue || '',
      interviewNotes: obj.interview?.notes || '',
      interviewRound: obj.interview?.type ? `Round 1 – ${obj.interview.type}` : 'Round 1',
      interviewStatus: obj.interview?.scheduled ? 'Scheduled' : 'Not Scheduled',
      interviewerName: obj.interview?.interviewerName || '',
      interviewerEmail: obj.interview?.interviewerEmail || '',
      interviewerAvailabilityStatus: obj.interview?.availabilityStatus || '',
      interviewerReason: obj.interview?.interviewerReason || '',
      candidateNotified: !!obj.interview?.candidateNotified,
      resumeUrl: obj.filePath ? `http://localhost:5000/${obj.filePath}` : null,
      stage: obj.overallStatus || 'Applied',
    };

    res.json(ret);
  } catch (error) {
    console.error('Error retrieving candidate details:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── DELETE /candidates/:id ─────────────────────────────────────────────────
router.delete('/candidates/:id', async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.id);
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    if (candidate.filePath && fs.existsSync(candidate.filePath)) {
      try { fs.unlinkSync(candidate.filePath); } catch (e) { /* ignore */ }
    }

    await Candidate.findByIdAndDelete(req.params.id);
    await deleteCandidateFromSheet(req.params.id);
    res.json({ message: 'Candidate deleted successfully' });
  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /candidates ────────────────────────────────────────────────────────
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

// ── POST /score-preview ────────────────────────────────────────────────────
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