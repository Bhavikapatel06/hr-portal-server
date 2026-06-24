import express from 'express';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

/**
 * Build the recipient filter for the current logged-in user.
 *
 * IMPORTANT (Data Isolation):
 *   - Candidates: ONLY see notifications whose `recipientEmail` matches their own email.
 *                 They never receive role-based ('candidate') notifications, which would
 *                 otherwise leak across all candidate accounts.
 *   - Staff (hr/admin/department_head/interviewer): see role-based notifications AND any
 *                 notifications addressed directly to their email.
 */
const buildRecipientFilter = (user) => {
  if (user.role === 'candidate') {
    return { recipientEmail: user.email };
  }
  return {
    $or: [
      { recipientEmail: user.email },
      { recipientRole: user.role },
    ],
  };
};

// GET /api/notifications — fetch notifications for the logged-in user
router.get('/', protect, async (req, res) => {
  try {
    const filter = buildRecipientFilter(req.user);
    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/notifications/read-all  (must be declared BEFORE /:id/read)
router.patch('/read-all', protect, async (req, res) => {
  try {
    const filter = buildRecipientFilter(req.user);
    await Notification.updateMany(filter, { isRead: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/notifications/clear-all  (must be declared BEFORE /:id)
router.delete('/clear-all', protect, async (req, res) => {
  try {
    const filter = buildRecipientFilter(req.user);
    await Notification.deleteMany(filter);
    res.json({ message: 'All notifications cleared' });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/notifications/:id/read — mark a specific notification as read
router.patch('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    // Authorization: the notification must belong to the user
    const isOwner =
      notification.recipientEmail === req.user.email ||
      (req.user.role !== 'candidate' && notification.recipientRole === req.user.role);
    if (!isOwner) {
      return res.status(403).json({
  message: "Forbidden: cannot modify another user's notification."
});
    }

    notification.isRead = true;
    await notification.save();
    res.json(notification);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/notifications/:id — delete a specific notification
router.delete('/:id', protect, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    const isOwner =
      notification.recipientEmail === req.user.email ||
      (req.user.role !== 'candidate' && notification.recipientRole === req.user.role);
    if (!isOwner) {
      return res.status(403).json({ message: "Forbidden: cannot delete another user's notification." });
    }

    await Notification.findByIdAndDelete(req.params.id);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
