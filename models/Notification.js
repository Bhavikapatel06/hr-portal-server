import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  recipientRole: { type: String, default: null }, // e.g., 'admin', 'hr', 'candidate'
  recipientEmail: { type: String, default: null }, // Specific user email
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'INFO' }, // MRF_REQUEST, MRF_APPROVED, STATUS_UPDATE, JOB_POSTED
  link: { type: String, default: null }, // Frontend route to redirect to
  isRead: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('Notification', notificationSchema);
