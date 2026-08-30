const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireOwner);

router.get('/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, credits, is_owner, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json({ users });
});

router.get('/instances', (req, res) => {
  const instances = db.prepare(`
    SELECT instances.*, users.username FROM instances
    JOIN users ON users.id = instances.user_id
    ORDER BY started_at DESC LIMIT 100
  `).all();
  res.json({ instances });
});

router.post('/credits/adjust', (req, res) => {
  const { userId, delta, reason } = req.body;
  if (!userId || typeof delta !== 'number') {
    return res.status(400).json({ error: 'userId and numeric delta required' });
  }
  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(delta, userId);
  db.prepare('INSERT INTO ledger (user_id, delta, reason) VALUES (?, ?, ?)')
    .run(userId, delta, reason || 'owner adjustment');
  res.json({ ok: true });
});

// Users can't un-lock their own game choice - only the owner can clear it
// so they can pick again.
router.post('/reset-game', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  db.prepare('UPDATE users SET locked_game_id = NULL WHERE id = ?').run(userId);
  res.json({ ok: true });
});

module.exports = router;
