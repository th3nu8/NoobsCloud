require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./db');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/stream');
const ownerRoutes = require('./routes/owner');
const gamesRoutes = require('./routes/games');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/owner', ownerRoutes);
app.use('/api/games', gamesRoutes);

// Lightweight "who am I" endpoint the frontend polls after login.
app.get('/api/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare(
      'SELECT id, username, credits, is_owner, locked_game_id FROM users WHERE id = ?'
    ).get(payload.id);
    if (!user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user });
  } catch {
    res.json({ loggedIn: false });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`vmstream listening on :${port}`));
