import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import { parseMRF } from '../services/parserService.js';
import { buildCandidateCSV } from '../services/csvService.js';
import { generateMrfPDF } from '../services/pdfService.js';

const router = express.Router();

// Configure multer for file uploads
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, uploadDir); },
  filename:    (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname}`); },
});
const upload = multer({ storage });

// ── POST /mrf/parse — parse MRF PDF, return fields, do NOT save ───────────
router.post('/parse', upload.single('mrfFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const fileBuffer = fs.readFileSync(req.file.path);
    const parsed = await parseMRF(fileBuffer, req.file.originalname, req.file.mimetype);

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    if (parsed.status === 'failed') {
      return res.status(422).json({ message: parsed.details.notes });
    }
    res.json(parsed.details);
  } catch (error) {
    console.error('Error parsing MRF file:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ message: error.message });
  }
});

// ── POST /mrf — create new job opening ────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    // Validate that designation is provided and not empty/gibberish
    const designation = (req.body.designation || '').trim();
    if (!designation) {
      return res.status(400).json({ message: 'Designation is required to create a job opening.' });
    }
    const jobOpening = new JobOpening({ ...req.body, designation });
    const saved = await jobOpening.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error creating job opening:', error);
    res.status(400).json({ message: error.message });
  }
});

// ── PUT /mrf/:id — update existing job opening ────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const designation = (req.body.designation || '').trim();
    if (!designation) {
      return res.status(400).json({ message: 'Designation is required to update a job opening.' });
    }
    const updated = await JobOpening.findByIdAndUpdate(
      req.params.id,
      { ...req.body, designation },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Job opening not found' });
    res.json(updated);
  } catch (error) {
    console.error('Error updating job opening:', error);
    res.status(400).json({ message: error.message });
  }
});

// ── GET /mrf — list all openings with candidate count ─────────────────────
router.get('/', async (req, res) => {
  try {
    const openings = await JobOpening.find().sort({ createdAt: -1 });
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

// ── GET /mrf/:id/download-mrf — download MRF as formatted PDF file ───────
router.get('/:id/download-mrf', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    const safeName = (opening.designation || 'MRF').replace(/[^a-zA-Z0-9]/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="MRF-${safeName}.pdf"`);
    
    generateMrfPDF(opening, res);
  } catch (error) {
    console.error('Error generating MRF PDF download:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── GET /mrf/:id/download-csv — stream candidate CSV for a single MRF ─────
router.get('/:id/download-csv', async (req, res) => {
  try {
    const opening = await JobOpening.findById(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });

    // FIFO order (first applied first)
    const candidates = await Candidate.find({ jobOpeningId: req.params.id }).sort({ createdAt: 1 });
    const csv = buildCandidateCSV(opening, candidates);
    const safeName = (opening.designation || 'MRF').replace(/[^a-zA-Z0-9]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Candidates-${safeName}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating candidate CSV:', error);
    res.status(500).json({ message: error.message });
  }
});

// ── DELETE /mrf/:id — delete opening + cascade candidates ─────────────────
router.delete('/:id', async (req, res) => {
  try {
    const opening = await JobOpening.findByIdAndDelete(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });
    await Candidate.deleteMany({ jobOpeningId: req.params.id });
    res.json({ message: 'Job opening and associated candidates deleted successfully' });
  } catch (error) {
    console.error('Error deleting job opening:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
