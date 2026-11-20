import crypto from 'node:crypto';

const depth = new WeakMap();

/** Run fn inside a SQLite transaction. Nested calls join the outer transaction. */
export function tx(db, fn) {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  depth.set(db, 1);
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(d = new Date()) {
  return d.toLocaleDateString('en-CA');
}

export function dayOffset(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored ?? '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(pw ?? ''), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

export const money = (n) =>
  Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
