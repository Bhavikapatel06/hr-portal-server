import express from 'express';
import multer from 'multer';
import fs from 'fs';
import JobOpening from '../models/JobOpening.js';
import Candidate from '../models/Candidate.js';
import { parseMRF } from '../services/parserService.js';

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
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Upload and parse MRF file
router.post('/parse', upload.single('mrfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const fileBuffer = fs.readFileSync(req.file.path);
    const parsed = await parseMRF(fileBuffer, req.file.originalname, req.file.mimetype);

    // Clean up uploaded file from disk after parsing
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    if (parsed.status === 'failed') {
      return res.status(422).json({ message: parsed.details.notes });
    }

    res.json(parsed.details);
  } catch (error) {
    console.error('Error parsing MRF file:', error);
    // Cleanup if file still exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: error.message });
  }
});

// Create new MRF / opening
router.post('/', async (req, res) => {
  try {
    const jobOpening = new JobOpening(req.body);
    const saved = await jobOpening.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error creating job opening:', error);
    res.status(400).json({ message: error.message });
  }
});

// Get all active openings
router.get('/', async (req, res) => {
  try {
    const openings = await JobOpening.find().sort({ createdAt: -1 });
    const enriched = await Promise.all(openings.map(async (opening) => {
      const count = await Candidate.countDocuments({ jobOpeningId: opening._id });
      // Keep it serializable & include virtual ID
      const obj = opening.toJSON();
      return { ...obj, candidateCount: count };
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Error getting job openings:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get single opening by ID
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

// Delete opening and all of its associated candidates
router.delete('/:id', async (req, res) => {
  try {
    const opening = await JobOpening.findByIdAndDelete(req.params.id);
    if (!opening) return res.status(404).json({ message: 'Job opening not found' });
    // Cascade delete candidates
    await Candidate.deleteMany({ jobOpeningId: req.params.id });
    res.json({ message: 'Job opening and associated candidates deleted successfully' });
  } catch (error) {
    console.error('Error deleting job opening:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
