const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireOwner(req, res, next) {
  if (!req.user?.isOwner) return res.status(403).json({ error: 'Owner access only' });
  next();
}

module.exports = { requireAuth, requireOwner };
