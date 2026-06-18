import mongoose from 'mongoose';

const candidateSchema = new mongoose.Schema({
  jobOpeningId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobOpening', required: true },
  appliedVia: { type: String, enum: ['resume_upload', 'apply_form'], default: 'apply_form' },
  fileName: { type: String, default: '' },
  filePath: { type: String, default: '' },
  fileSize: Number,
  parseStatus: { type: String, enum: ['pending', 'parsed', 'failed'], default: 'parsed' },
  details: {
    fullName:        { type: String, default: '' },
    email:           { type: String, default: '' },
    phone:           { type: String, default: '' },
    alternatePhone:  { type: String, default: '' },
    currentTitle:    { type: String, default: '' },
    totalExp:        { type: String, default: '' },
    highestQual:     { type: String, default: '' },
    skills:          { type: String, default: '' },
    currentLocation: { type: String, default: '' },
    currentCompany:  { type: String, default: '' },
    currentCtc:      { type: String, default: '' },
    expectedCtc:     { type: String, default: '' },
    noticePeriod:    { type: String, default: '' },
    reasonForChange: { type: String, default: '' },
    notes:           { type: String, default: '' },
  },
  matchScore:  { type: Number, default: null },
  matchLevel:  { type: String, enum: ['Strong', 'Good', 'Partial', 'Low', null], default: null },
  matchBreakdown: {
    skills:        { type: Number, default: 0 },
    experience:    { type: Number, default: 0 },
    qualification: { type: Number, default: 0 },
    jobTitle:      { type: Number, default: 0 },
  },
  overallStatus: {
    type: String,
    enum: ['Applied', 'Screening', 'Interview', 'Offer', 'Joined', 'Rejected', 'new', 'shortlisted', 'scheduled', 'selected', 'on_hold', 'Pending Head Approval', 'Approved by Head'],
    default: 'Applied',
  },
  interview: {
    scheduled: { type: Boolean, default: false },
    date:      { type: String,  default: '' },
    time:      { type: String,  default: '' },
    mode:      { type: String,  enum: ['online', 'offline'], default: 'online' },
    type:      { type: String,  enum: ['Initial', 'Technical', 'HR', 'Final'], default: 'Technical' },
    link:      { type: String,  default: '' },
    venue:     { type: String,  default: '' },
    notes:     { type: String,  default: '' },
  },
  feedback: {
    given:     { type: Boolean, default: false },
    decision:  { type: String, enum: ['shortlisted', 'selected', 'rejected', 'on_hold', ''], default: '' },
    rating:    { type: Number, default: 0 },
    notes:     { type: String, default: '' },
    decidedAt: { type: Date,   default: null },
  },
  createdAt: { type: Date, default: Date.now },
});

candidateSchema.set('toJSON',   { virtuals: true });
candidateSchema.set('toObject', { virtuals: true });

candidateSchema.post('save', async function(doc) {
  try {
    const { syncCandidateToSheet } = await import('../services/googleSheetsService.js');
    await syncCandidateToSheet(doc);
  } catch (err) {
    console.error('[Mongoose Hook] Failed to sync candidate to Google Sheets:', err);
  }
});

candidateSchema.post('findOneAndDelete', async function(doc) {
  if (doc) {
    try {
      const { deleteCandidateFromSheet } = await import('../services/googleSheetsService.js');
      await deleteCandidateFromSheet(doc._id);
    } catch (err) {
      console.error('[Mongoose Hook] Failed to delete candidate from Google Sheets:', err);
    }
  }
});

const Candidate = mongoose.model('Candidate', candidateSchema);
export default Candidate;
