import express from 'express';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/notifications
// Fetch notifications for the logged-in user based on email or role
router.get('/', protect, async (req, res) => {
  try {
    const filter = {
      $or: [
        { recipientEmail: req.user.email },
        { recipientRole: req.user.role }
      ]
    };
    
    // Sort by newest first
    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/notifications/:id/read
// Mark a specific notification as read
router.patch('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true }
    );
    res.json(notification);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/notifications/read-all
// Mark all notifications as read for the user
router.patch('/read-all', protect, async (req, res) => {
  try {
    const filter = {
      $or: [
        { recipientEmail: req.user.email },
        { recipientRole: req.user.role }
      ]
    };
    await Notification.updateMany(filter, { isRead: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/notifications/clear-all
// Clear all notifications for the user
router.delete('/clear-all', protect, async (req, res) => {
  try {
    const filter = {
      $or: [
        { recipientEmail: req.user.email },
        { recipientRole: req.user.role }
      ]
    };
    await Notification.deleteMany(filter);
    res.json({ message: 'All notifications cleared' });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/notifications/:id
// Delete a specific notification
router.delete('/:id', protect, async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
