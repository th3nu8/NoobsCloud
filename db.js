const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'vmstream.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits REAL NOT NULL DEFAULT 0,
  is_owner INTEGER NOT NULL DEFAULT 0,
  locked_game_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  vmid INTEGER NOT NULL,
  ip TEXT,
  game_id TEXT,
  status TEXT NOT NULL DEFAULT 'starting', -- starting | running | stopped | error
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT,
  minutes_billed REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// Lightweight migration for DBs created before locked_game_id / game_id existed.
try { db.exec('ALTER TABLE users ADD COLUMN locked_game_id TEXT'); } catch {}
try { db.exec('ALTER TABLE instances ADD COLUMN game_id TEXT'); } catch {}

module.exports = db;
