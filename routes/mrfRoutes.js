import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import Notification from '../models/Notification.js';
import { parseMRF } from '../services/parserService.js';
import { buildCandidateCSV } from '../services/csvService.js';
import { generateMrfPDF } from '../services/pdfService.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';
import { appendMRFToSheet, updateMRFInSheet, fetchAllFromSheet, syncCandidateToSheet } from '../services/googleSheetsService.js';

const router = express.Router();

// ── Multer ─────────────────────────────────────────────────────────────────
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, uploadDir); },
  filename:    (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname}`); },
});
const upload = multer({ storage });

// ── POST /mrf/parse — parse MRF PDF ────────────────────────────────────────
router.post('/parse', upload.single('mrfFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const fileBuffer = fs.readFileSync(req.file.path);
    const parsed = await parseMRF(fileBuffer, req.file.originalname, req.file.mimetype);

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    if (parsed.status === 'failed') {
      // Return 200 with empty details so frontend can still show confirmation modal
      return res.json({
        designation: '',
        department: '',
        location: '',
        experience: '',
        minimumQualification: '',
        otherKeySkills: '',
        noOfPositions: 1,
        urgency: 'Medium',
        purposeOfJob: '',
        rolesAndResponsibilities: '',
        preferredIndustries: '',
        _parseNote: parsed.details?.notes || 'Could not extract details from this file.',
      });
    }
    res.json(parsed.details);
  } catch (error) {
    console.error('Error parsing MRF file:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf/upload-attachment — upload MRF/JD attachment (HOD side) ──────
router.post('/upload-attachment', protect, requireRole('department_head'), upload.single('attachment'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    // Normalize path to use forward slashes so frontend can read/access easily
    const normalizedPath = req.file.path.replace(/\\/g, '/');
    
    res.json({
      fileName: req.file.originalname,
      filePath: normalizedPath,
    });
  } catch (error) {
    console.error('Error uploading attachment:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf — Department Head submits a new MRF ──────────────────────────
// Allowed: department_head only (Create MRF)
router.post('/', protect, requireRole('department_head'), async (req, res) => {
  try {
    const designation = (req.body.designation || '').trim();
    if (!designation) {
      return res.status(400).json({ message: 'Designation is required to create an MRF.' });
    }

    const jobOpening = new JobOpening({
      ...req.body,
      designation,
      mrfStatus: 'Pending Owner Approval',
      submittedBy: req.user.name,
      positionStatus: 'Open',
    });

    const saved = await jobOpening.save();

    // Sync to Google Sheets — append new row
    const rowIndex = await appendMRFToSheet(saved);
    if (rowIndex) {
      saved.sheetRowIndex = rowIndex;
      await saved.save();
    }

    // Notify HR Admin
    await Notification.create({
      recipientRole: 'admin',
      title: 'New MRF Submitted',
      message: `1 pending approval: ${req.user.name} submitted a new MRF for ${saved.designation}.`,
      type: 'MRF_CREATED',
      link: '/mrf-approvals'
    });

    res.status(201).json(saved);
  } catch (error) {
    console.error('Error creating MRF:', error);
    res.status(400).json({ message: error.message });
  }
});

// ── POST /mrf/draft — Department Head saves a DRAFT MRF ────────────────────
router.post('/draft', protect, requireRole('department_head'), async (req, res) => {
  try {
    const designation = (req.body.designation || '').trim();
    if (!designation) {
      return res.status(400).json({ message: 'Designation is required.' });
    }
    const jobOpening = new JobOpening({
      ...req.body,
      designation,
      mrfStatus: 'Draft',
      submittedBy: req.user.name,
    });
    const saved = await jobOpening.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving MRF draft:', error);
    res.status(400).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/submit — Department Head submits a draft ────────────────
router.patch('/:id/submit', protect, requireRole('department_head'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });
    if (mrf.mrfStatus !== 'Draft') {
      return res.status(400).json({ message: 'Only Draft MRFs can be submitted.' });
    }
    mrf.mrfStatus = 'Pending Owner Approval';
    const saved = await mrf.save();

    // Append to sheet now that it's officially submitted
    const rowIndex = await appendMRFToSheet(saved);
    if (rowIndex) {
      saved.sheetRowIndex = rowIndex;
      await saved.save();
    }

    // Notify HR Admin
    await Notification.create({
      recipientRole: 'admin',
      title: 'Draft MRF Submitted',
      message: `1 pending approval: ${req.user.name} submitted an MRF for ${saved.designation}.`,
      type: 'MRF_CREATED',
      link: '/mrf-approvals'
    });

    res.json(saved);
  } catch (error) {
    console.error('Error submitting MRF:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/approve — Admin approves MRF ────────────────────────────
router.patch('/:id/approve', protect, requireRole('admin'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });
    if (mrf.mrfStatus !== 'Pending Owner Approval') {
      return res.status(400).json({ message: 'Only Pending MRFs can be approved.' });
    }

    mrf.mrfStatus   = 'Approved';
    mrf.approvedBy  = req.user.name;
    mrf.approvedAt  = new Date();
    mrf.requirementStatus = 'Pending';
    // NOTE: positionStatus stays as is — HR Manager must explicitly Post as Job

    const saved = await mrf.save();

    // Update sheet row
    await updateMRFInSheet(saved, saved.sheetRowIndex);

    // Notify HR Manager
    await Notification.create({
      recipientRole: 'hr',
      title: 'MRF Approved',
      message: `The MRF for ${saved.designation} was approved by ${req.user.name}. Please create a job posting.`,
      type: 'MRF_APPROVED',
      link: '/my-mrfs'
    });

    // Notify Dept Head
    await Notification.create({
      recipientRole: 'department_head',
      title: 'MRF Request Approved',
      message: `Your MRF request for ${saved.designation} has been approved.`,
      type: 'MRF_APPROVED',
      link: '/my-mrfs'
    });

    res.json(saved);
  } catch (error) {
    console.error('Error approving MRF:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/reject — Admin rejects MRF ─────────────────────────────
router.patch('/:id/reject', protect, requireRole('admin'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });
    if (mrf.mrfStatus !== 'Pending Owner Approval') {
      return res.status(400).json({ message: 'Only Pending MRFs can be rejected.' });
    }

    mrf.mrfStatus    = 'Rejected';
    mrf.rejectedBy   = req.user.name;
    mrf.rejectionNote = (req.body.note || '').trim();
    mrf.requirementStatus = 'Cancelled';

    const saved = await mrf.save();

    await updateMRFInSheet(saved, saved.sheetRowIndex);

    // Notify Dept Head (Submitter)
    if (mrf.submittedBy) {
      await Notification.create({
        recipientRole: 'department_head',
        title: 'MRF Rejected',
        message: `Your MRF for ${saved.designation} was rejected by ${req.user.name}. Note: ${saved.rejectionNote || 'None'}`,
        type: 'MRF_REJECTED',
        link: '/my-mrfs'
      });
    }

    res.json(saved);
  } catch (error) {
    console.error('Error rejecting MRF:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/create-job — HR creates active Job Opening from approved MRF
router.patch('/:id/create-job', protect, requireRole('hr', 'admin'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });
    if (mrf.mrfStatus !== 'Approved') {
      return res.status(400).json({ message: 'Only Approved MRFs can be activated as job openings.' });
    }

    mrf.positionStatus    = 'In Progress';
    mrf.requirementStatus = 'In Progress';
    // Merge any extra HR data (e.g. source, salary, skills)
    const allowed = [
      'sourceOfHiring', 'processOwnerName', 'otherKeySkills', 'proposedSalary',
      'levelOfUrgency', 'purposeOfJob', 'rolesResponsibilities', 'minimumQualification',
    ];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) mrf[field] = req.body[field];
    });

    const saved = await mrf.save();

    if (saved.sheetRowIndex) {
      await updateMRFInSheet(saved, saved.sheetRowIndex);
    }

    // Notify all candidates
    await Notification.create({
      recipientRole: 'candidate',
      title: 'New Job Posting',
      message: `A new role for ${saved.designation} is now open!`,
      type: 'JOB_POSTED',
      link: '/dashboard'
    });

    // Notify Dept Head and Admin
    await Notification.create({
      recipientRole: 'department_head',
      title: 'Job Posted Successfully',
      message: `Job posting for ${saved.designation} has been created successfully.`,
      type: 'JOB_POSTED',
      link: '/my-mrfs'
    });
    
    await Notification.create({
      recipientRole: 'admin',
      title: 'Job Posted Successfully',
      message: `Job posting for ${saved.designation} has been created successfully.`,
      type: 'JOB_POSTED',
      link: '/dashboard'
    });

    res.json(saved);
  } catch (error) {
    console.error('Error creating job from MRF:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/close — HR manually closes an active job opening ────────
router.patch('/:id/close', protect, requireRole('hr', 'admin'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });
    if (mrf.positionStatus === 'Closed') {
      return res.status(400).json({ message: 'Job is already closed.' });
    }

    mrf.positionStatus = 'Closed';
    mrf.requirementStatus = 'Closed';
    mrf.closedAt = new Date();
    const saved = await mrf.save();

    if (saved.sheetRowIndex) {
      await updateMRFInSheet(saved, saved.sheetRowIndex);
    }
    res.json(saved);
  } catch (error) {
    console.error('Error closing job opening:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PATCH /mrf/:id/offer — HR records offer details ───────────────────────
router.patch('/:id/offer', protect, requireRole('hr', 'admin'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'MRF not found' });

    const offerFields = [
      'offeredCandidateName', 'offeredDesignation', 'offerDate', 'tentativeDOJ',
      'actualDOJ', 'offerStatus', 'preEmploymentMedicalStatus',
      'sourceOfHiring', 'internalRefName', 'lastOrganization', 'lastDesignation',
      'totalPreviousExp', 'lastCTC', 'offeredCTC', 'costOfCompany',
      'recruitmentRemarks', 'requirementStatus',
    ];
    offerFields.forEach(f => { if (req.body[f] !== undefined) mrf[f] = req.body[f]; });

    const saved = await mrf.save(); // pre-save hook auto-calculates TAT & CTC diff

    if (saved.sheetRowIndex) {
      await updateMRFInSheet(saved, saved.sheetRowIndex);
    }

    res.json(saved);
  } catch (error) {
    console.error('Error updating offer details:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── PUT /mrf/:id — update existing job opening (HR Admin) ─────────────────
router.put('/:id', protect, requireRole('hr', 'admin', 'department_head'), async (req, res) => {
  try {
    const designation = (req.body.designation || '').trim();
    if (!designation) {
      return res.status(400).json({ message: 'Designation is required to update.' });
    }
    const updated = await JobOpening.findByIdAndUpdate(
      req.params.id,
      { ...req.body, designation },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Job opening not found' });

    if (updated.sheetRowIndex) {
      await updateMRFInSheet(updated, updated.sheetRowIndex);
    }

    res.json(updated);
  } catch (error) {
    console.error('Error updating job opening:', error);
    res.status(400).json({ message: error.message });
  }
});

// ── GET /mrf — list all openings with candidate count ─────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, mrfStatus } = req.query;
    const filter = {};
    if (mrfStatus) filter.mrfStatus = mrfStatus;
    if (status)    filter.positionStatus = status;

    const openings = await JobOpening.find(filter).sort({ createdAt: -1 });
    const enriched = await Promise.all(openings.map(async (opening) => {
      const count = await Candidate.countDocuments({ jobOpeningId: opening._id });
      return { ...opening.toJSON(), candidateCount: count };
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Error getting job openings:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/sheet — fetch all rows from Google Sheet ─────────────────────
// MUST be before /:id to avoid Express treating 'sheet' as an ObjectId
router.get('/sheet', async (req, res) => {
  try {
    const rows = await fetchAllFromSheet();
    res.json(rows);
  } catch (error) {
    console.error('Error fetching from sheet:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/sheet/config — retrieve linked sheet ID ──────────────────────
router.get('/sheet/config', protect, requireRole('admin', 'hr'), (req, res) => {
  res.json({ sheetId: process.env.GOOGLE_SHEET_ID || '' });
});

// ── POST /mrf/sheet/config — update linked sheet ID ───────────────────────
router.post('/sheet/config', protect, requireRole('admin'), async (req, res) => {
  try {
    const { sheetId } = req.body;
    if (!sheetId) {
      return res.status(400).json({ message: 'Spreadsheet ID is required.' });
    }

    // Update in process.env
    process.env.GOOGLE_SHEET_ID = sheetId.trim();

    // Persist to .env file
    const envPath = fs.existsSync('.env') ? '.env' : '../.env';
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      if (content.includes('GOOGLE_SHEET_ID=')) {
        content = content.replace(/GOOGLE_SHEET_ID=.*/, `GOOGLE_SHEET_ID=${sheetId.trim()}`);
      } else {
        content += `\nGOOGLE_SHEET_ID=${sheetId.trim()}\n`;
      }
      fs.writeFileSync(envPath, content);
      console.log(`[Config] GOOGLE_SHEET_ID updated to ${sheetId.trim()} in .env`);
    } else {
      fs.writeFileSync('.env', `GOOGLE_SHEET_ID=${sheetId.trim()}\n`);
    }

    res.json({ message: 'Google Sheet configuration updated successfully.', sheetId: process.env.GOOGLE_SHEET_ID });
  } catch (error) {
    console.error('Error updating sheet config:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf/sheet/sync-all — manually sync all DB records to sheet ──────────
router.post('/sheet/sync-all', protect, requireRole('admin', 'hr'), async (req, res) => {
  try {
    const mrfs = await JobOpening.find({}).sort({ createdAt: 1 });
    let mrfUpdated = 0;
    let mrfAppended = 0;

    for (const mrf of mrfs) {
      if (mrf.sheetRowIndex || mrf.mrfSheetRowIndex) {
        await updateMRFInSheet(mrf, mrf.mrfSheetRowIndex || mrf.sheetRowIndex);
        mrfUpdated++;
      } else {
        const rowIndex = await appendMRFToSheet(mrf);
        if (rowIndex) mrfAppended++;
      }
    }

    const candidates = await Candidate.find({}).sort({ createdAt: 1 });
    let candSynced = 0;

    for (const cand of candidates) {
      await syncCandidateToSheet(cand);
      candSynced++;
    }

    res.json({
      message: 'Database synced successfully with Google Sheets.',
      mrfTotal: mrfs.length,
      mrfUpdated,
      mrfAppended,
      candidatesSynced: candSynced
    });
  } catch (error) {
    console.error('Error during manual sync:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:id — single opening ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    res.json(opening);
  } catch (error) {
    console.error('Error getting job opening details:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:id/download-mrf ─────────────────────────────────────────────
router.get('/:id/download-mrf', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const safeName = (opening.designation || 'MRF').replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="MRF-${safeName}.pdf"`);
    generateMrfPDF(opening, res);
  } catch (error) {
    console.error('Error generating MRF PDF:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:id/download-csv ─────────────────────────────────────────────
router.get('/:id/download-csv', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const candidates = await Candidate.find({ jobOpeningId: req.params.id }).sort({ createdAt: 1 });
    const csv = buildCandidateCSV(opening, candidates);
    const safeName = (opening.designation || 'MRF').replace(/[^a-zA-Z0-9]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Candidates-${safeName}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating CSV:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── DELETE /mrf/:id ────────────────────────────────────────────────────────
router.delete('/:id', protect, requireRole('admin', 'department_head'), async (req, res) => {
  try {
    const mrf = await JobOpening.findById(req.params.id);
    if (!mrf) return res.status(404).json({ message: 'Job opening not found' });

    // Restrict department head to only delete their own draft MRFs (or unowned/seeded ones)
    if (req.user.role === 'department_head') {
      const ownedByUser = !mrf.submittedBy || mrf.submittedBy === req.user.name;
      if (!ownedByUser || mrf.mrfStatus !== 'Draft') {
        return res.status(403).json({ message: 'Access denied. You can only delete your own draft MRFs.' });
      }
    }

    await JobOpening.findByIdAndDelete(req.params.id);
    await Candidate.deleteMany({ jobOpeningId: req.params.id });
    res.json({ message: 'Job opening deleted successfully' });
  } catch (error) {
    console.error('Error deleting job opening:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
