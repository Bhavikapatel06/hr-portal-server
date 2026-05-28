import mongoose from 'mongoose';

const jobOpeningSchema = new mongoose.Schema({
  designation: { type: String, required: true },
  department: String,
  reportsTo: String,
  location: String,
  experience: String, // e.g., "3-5 years"
  proposedSalary: String,
  levelOfUrgency: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' },
  reasonForRequest: String, // "New" or "Replacement"
  noOfPositions: { type: Number, default: 1 },
  replacementFor: String,
  justification: String,
  purposeOfJob: String,
  rolesResponsibilities: String,
  minimumQualification: String,
  otherKeySkills: String,
  createdAt: { type: Date, default: Date.now }
});

jobOpeningSchema.set('toJSON', { virtuals: true });
jobOpeningSchema.set('toObject', { virtuals: true });

const JobOpening = mongoose.model('JobOpening', jobOpeningSchema);
export default JobOpening;
