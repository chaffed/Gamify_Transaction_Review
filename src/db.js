import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { seed } from './seed.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','analyst')),
  segment TEXT NOT NULL DEFAULT 'consumer' CHECK (segment IN ('consumer','business')),
  is_bot INTEGER NOT NULL DEFAULT 0,
  card_last4 TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  trust REAL NOT NULL DEFAULT 0.5,
  streak_days INTEGER NOT NULL DEFAULT 0,
  last_review_day TEXT,
  gold_seen INTEGER NOT NULL DEFAULT 0,
  gold_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id),
  segment TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  avg_amount REAL NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  channel TEXT NOT NULL,
  device_new INTEGER NOT NULL,
  new_payee INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  distance_km REAL NOT NULL,
  velocity_24h INTEGER NOT NULL,
  account_age_days INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  is_gold INTEGER NOT NULL DEFAULT 0,
  true_label TEXT NOT NULL,              -- simulated outcome (chargeback/confirmed dispute); never sent to reviewers
  model_score REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','escalated')),
  review_count INTEGER NOT NULL DEFAULT 0,
  consensus_label TEXT,
  consensus_confidence REAL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status, segment);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  txn_id INTEGER NOT NULL REFERENCES transactions(id),
  label TEXT NOT NULL CHECK (label IN ('legit','suspicious','fraud')),
  reasons TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 2,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  too_fast INTEGER NOT NULL DEFAULT 0,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  review_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, txn_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_txn ON reviews(txn_id);
CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, created_at);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  icon TEXT NOT NULL,
  cost INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  min_level INTEGER NOT NULL DEFAULT 1,
  segment TEXT
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  cost INTEGER NOT NULL,
  fulfillment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_badges (
  user_id INTEGER NOT NULL REFERENCES users(id),
  badge TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, badge)
);
CREATE TABLE IF NOT EXISTS model_versions (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  n_train INTEGER NOT NULL,
  weights TEXT NOT NULL,
  bias REAL NOT NULL,
  metrics TEXT NOT NULL
);
`;

export function openDb(file, { reset = false } = {}) {
  const memory = file === ':memory:';
  if (!memory && reset) {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
  const fresh = memory || !fs.existsSync(file);
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (fresh) seed(db);
  return db;
}
