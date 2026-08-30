const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const games = require('../games');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ games: games.map(({ id, name }) => ({ id, name })) });
});

// One-time, permanent choice per account. Once set it can't be changed by
// the user - only the owner can clear it (see routes/owner.js).
router.post('/lock', requireAuth, (req, res) => {
  const { gameId } = req.body;
  const game = games.find(g => g.id === gameId);
  if (!game) return res.status(400).json({ error: 'Unknown game' });

  const user = db.prepare('SELECT locked_game_id FROM users WHERE id = ?').get(req.user.id);
  if (user.locked_game_id) {
    return res.status(409).json({ error: 'You already locked in a game for this account' });
  }

  db.prepare('UPDATE users SET locked_game_id = ? WHERE id = ?').run(gameId, req.user.id);
  res.json({ ok: true, gameId });
});

module.exports = router;
