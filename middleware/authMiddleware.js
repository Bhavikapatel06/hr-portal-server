import jwt from 'jsonwebtoken';
import User from '../models/User.js';

/** Verifies JWT and attaches req.user */
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorized. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'hr_portal_secret_key');

    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalid or expired. Please login again.' });
  }
};

/** Legacy: admin only */
export const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. HR Admin only.' });
  }
};

/**
 * Role-based access control — pass one or more allowed roles.
 * Usage: router.patch('/approve', protect, requireRole('admin'), handler)
 */
export const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({
      message: `Access denied. Required role(s): ${roles.join(', ')}. Your role: ${req.user?.role || 'none'}.`,
    });
  }
};