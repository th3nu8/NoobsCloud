const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const OWNER_USERNAME = 'th3nu8'; // the one account that auto-becomes owner on signup

router.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password (6+ chars) are required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const isOwner = username.toLowerCase() === OWNER_USERNAME ? 1 : 0;
  const hash = bcrypt.hashSync(password, 10);
  const bonus = Number(process.env.SIGNUP_BONUS_CREDITS || 0);

  const info = db.prepare(
    'INSERT INTO users (username, password_hash, credits, is_owner) VALUES (?, ?, ?, ?)'
  ).run(username, hash, bonus, isOwner);

  if (bonus > 0) {
    db.prepare('INSERT INTO ledger (user_id, delta, reason) VALUES (?, ?, ?)')
      .run(info.lastInsertRowid, bonus, 'signup bonus');
  }

  issueToken(res, { id: info.lastInsertRowid, username, isOwner: !!isOwner });
  res.json({ ok: true, isOwner: !!isOwner });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  issueToken(res, { id: user.id, username: user.username, isOwner: !!user.is_owner });
  res.json({ ok: true, isOwner: !!user.is_owner });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

function issueToken(res, payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}

module.exports = router;
