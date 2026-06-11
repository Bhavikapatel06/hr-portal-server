import mongoose from 'mongoose';

const jobOpeningSchema = new mongoose.Schema({
  // ── Core MRF fields (Step 1 – Department Head) ──────────────────────────
  designation:          { type: String, required: true },       // col 2
  department:           { type: String, default: '' },          // col 3
  section:              { type: String, default: '' },          // col 4
  location:             { type: String, default: '' },          // col 1 / 23
  noOfPositions:        { type: Number, default: 1 },           // col 5
  requirementType:      { type: String, enum: ['Lateral', 'Campus', ''], default: '' }, // col 11
  experience:           { type: String, default: '' },
  proposedSalary:       { type: String, default: '' },
  levelOfUrgency:       { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' },
  reasonForRequest:     { type: String, default: '' },          // New / Replacement / Transfer / Retirement
  replacementFor:       { type: String, default: '' },
  justification:        { type: String, default: '' },
  purposeOfJob:         { type: String, default: '' },
  rolesResponsibilities:{ type: String, default: '' },
  minimumQualification: { type: String, default: '' },          // col 21
  otherKeySkills:       { type: String, default: '' },
  reportsTo:            { type: String, default: '' },
  processOwnerName:     { type: String, default: '' },          // col 10

  requestType: { type: String, enum: ['MRF', 'JD'], default: 'MRF' },

  mrfFileName:          { type: String, default: '' },
  mrfFilePath:          { type: String, default: '' },
  jdFileName:           { type: String, default: '' },
  jdFilePath:           { type: String, default: '' },


  // ── Workflow Status (3-Step MRF) ────────────────────────────────────────
  mrfStatus: {
    type: String,
    enum: ['Draft', 'Pending Owner Approval', 'Approved', 'Rejected'],
    default: 'Draft',
  },
  submittedBy:  { type: String, default: '' },   // name of department head
  approvedBy:   { type: String, default: '' },   // name of owner
  rejectedBy:   { type: String, default: '' },
  rejectionNote:{ type: String, default: '' },
  approvedAt:   { type: Date,   default: null },

  // ── Position / Vacancy Status (col 6) ──────────────────────────────────
  positionStatus: {
    type: String,
    enum: ['Open', 'On Hold', 'Closed', 'In Progress'],
    default: 'Open',
  },

  // ── Requirement Status (col 7) ──────────────────────────────────────────
  requirementStatus: {
    type: String,
    enum: ['Pending', 'In Progress', 'Fulfilled', 'Cancelled', 'Closed'],
    default: 'Pending',
  },

  // ── Offer / Post-Offer tracking (col 8, 12-18) ──────────────────────────
  offerStatus: {
    type: String,
    enum: ['Not Offered', 'Offered', 'Accepted', 'Joined', 'Declined', 'Withdrawn'],
    default: 'Not Offered',
  },
  preEmploymentMedicalStatus: { type: String, enum: ['Pending', 'Fit', 'Unfit', 'Not Required', ''], default: '' }, // col 12
  offerDate:            { type: Date, default: null },         // col 13
  tentativeDOJ:         { type: Date, default: null },         // col 14
  tat:                  { type: Number, default: null },        // col 15 (days, auto-calculated)
  offeredCandidateName: { type: String, default: '' },         // col 16
  offeredDesignation:   { type: String, default: '' },         // col 17
  actualDOJ:            { type: Date, default: null },         // col 18

  // ── Source / Hiring Details (col 19-20) ─────────────────────────────────
  sourceOfHiring:       { type: String, default: '' },
  internalRefName:      { type: String, default: '' },

  // ── Candidate Background (col 22-31) ────────────────────────────────────
  lastOrganization:     { type: String, default: '' },         // col 22
  lastDesignation:      { type: String, default: '' },         // col 24
  totalPreviousExp:     { type: String, default: '' },         // col 25
  lastCTC:              { type: String, default: '' },         // col 26
  offeredCTC:           { type: String, default: '' },         // col 27
  costOfCompany:        { type: String, default: '' },         // col 28
  ctcDifferenceAmount:  { type: Number, default: null },        // col 29 (auto-calculated)
  ctcDifferencePercent: { type: Number, default: null },        // col 30 (auto-calculated)
  recruitmentRemarks:   { type: String, default: '' },         // col 31

  // ── Vacancy reason / Employee details (col 32-35) ───────────────────────
  vacancyRemarks:       { type: String, default: '' },         // col 9
  employeeName:         { type: String, default: '' },         // col 32 (Retirement/Resignation/Transfer)
  employeeDesignation:  { type: String, default: '' },         // col 33
  positionStartDate:    { type: Date,   default: null },        // col 34
  additionalRemarks:    { type: String, default: '' },         // col 35

  // ── Company Name (col 36) ───────────────────────────────────────────────
  companyName:          { type: String, default: '' },

  // ── Sheet Row tracking ──────────────────────────────────────────────────
  sheetRowIndex:        { type: Number, default: null }, // row # in Google Sheet

  createdAt: { type: Date, default: Date.now },
  closedAt:  { type: Date, default: null },
});

// Auto-calculate TAT, CTC diffs before save
jobOpeningSchema.pre('save', function (next) {
  // TAT: days between offerDate and actualDOJ
  if (this.offerDate && this.actualDOJ) {
    const diff = new Date(this.actualDOJ) - new Date(this.offerDate);
    this.tat = Math.round(diff / (1000 * 60 * 60 * 24));
  }
  // CTC Difference (numeric parsing: strip non-numeric except dots)
  const parse = (v) => parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || null;
  const last    = parse(this.lastCTC);
  const offered = parse(this.offeredCTC);
  if (last !== null && offered !== null) {
    this.ctcDifferenceAmount  = parseFloat((offered - last).toFixed(2));
    this.ctcDifferencePercent = parseFloat((((offered - last) / last) * 100).toFixed(2));
  }
  next();
});

jobOpeningSchema.set('toJSON',   { virtuals: true });
jobOpeningSchema.set('toObject', { virtuals: true });

const JobOpening = mongoose.model('JobOpening', jobOpeningSchema);
export default JobOpening;
