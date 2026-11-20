import crypto from 'node:crypto';
import { tx, localDay, verifyPassword, clamp, money } from './util.js';
import * as G from './gamification.js';
import { aggregate, agrees } from './consensus.js';
import * as M from './model.js';
import { signalsFor, TYPE_LABELS, COUNTRY_NAMES } from './generator.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const REASONS = {
  unusual_amount: 'Unusual amount',
  unfamiliar_location: 'Unfamiliar location',
  new_device: 'New device',
  odd_time: 'Odd time of day',
  high_velocity: 'Lots of recent activity',
  risky_merchant: 'Risky merchant type',
  new_payee: 'New payee / changed bank details',
  other: 'Something else',
};

const QUEUE_SIZE = 10;
const GOLD_PER_QUEUE = 2;

// ---------------------------------------------------------------- auth

export function login(db, username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND is_bot = 0')
    .get(String(username ?? '').trim().toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) throw new ApiError(401, 'Invalid username or password');
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, u.id);
  return token;
}

export function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userForToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) ?? null;
}

const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// ---------------------------------------------------------------- points

export function awardPoints(db, userId, delta, reason, ref = null, ago = '-0 days') {
  db.prepare('UPDATE users SET points = points + ?, lifetime_points = lifetime_points + ? WHERE id = ?')
    .run(delta, Math.max(delta, 0), userId);
  db.prepare("INSERT INTO points_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
    .run(userId, delta, reason, ref, ago);
}

// ---------------------------------------------------------------- profile

export function getMe(db, user) {
  const u = getUser(db, user.id);
  const today = localDay();
  const reviewsToday = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND review_day = ? AND too_fast = 0')
    .get(u.id, today).n;
  const totalReviews = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND too_fast = 0').get(u.id).n;
  const owned = new Map(db.prepare('SELECT badge, earned_at FROM user_badges WHERE user_id = ?').all(u.id)
    .map((r) => [r.badge, r.earned_at]));
  const active = u.last_review_day === today || u.last_review_day === yesterday();
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    segment: u.segment,
    cardLast4: u.card_last4,
    points: u.points,
    lifetimePoints: u.lifetime_points,
    level: G.levelFor(u.lifetime_points),
    trust: u.trust,
    streak: active ? u.streak_days : 0,
    reviewedToday: u.last_review_day === today,
    goldSeen: u.gold_seen,
    goldCorrect: u.gold_correct,
    reviewsToday,
    dailyGoal: G.RULES.DAILY_GOAL,
    dailyGoalBonus: G.RULES.DAILY_GOAL_BONUS,
    totalReviews,
    badges: G.BADGES.map(({ test, ...b }) => ({ ...b, earned: owned.has(b.key), earnedAt: owned.get(b.key) ?? null })),
  };
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDay(d);
}

// ---------------------------------------------------------------- queue

const segmentsFor = (u) => (u.segment === 'business' ? ['business', 'consumer'] : ['consumer']);

function canSee(u, t) {
  if (t.owner_user_id != null) return t.owner_user_id === u.id;
  return segmentsFor(u).includes(t.segment);
}

/** What a reviewer sees. Model score, gold flag, true label and review counts are deliberately withheld. */
function toDto(t, u) {
  const own = t.owner_user_id === u.id;
  const acct = t.segment === 'business' ? 'Business checking' : 'Debit card';
  return {
    id: t.id,
    kind: own ? 'own' : 'community',
    segment: t.segment,
    type: t.type,
    typeLabel: TYPE_LABELS[t.type],
    amount: t.amount,
    typicalAmount: t.avg_amount,
    merchant: t.merchant,
    category: t.category,
    location: `${t.city}, ${COUNTRY_NAMES[t.country]}`,
    channel: t.channel,
    occurredAt: t.occurred_at,
    account: own ? `${acct} •• ${u.card_last4}` : `${t.segment === 'business' ? 'Business customer' : 'Customer'} •• ••••`,
    signals: signalsFor(t),
  };
}

export function getQueue(db, user) {
  const u = getUser(db, user.id);
  if (u.role !== 'customer') throw new ApiError(403, 'Only customers have a review queue');
  const segs = segmentsFor(u);
  const ph = segs.map(() => '?').join(',');
  const notReviewed = 'id NOT IN (SELECT txn_id FROM reviews WHERE user_id = ?)';

  const own = db.prepare(`SELECT * FROM transactions WHERE owner_user_id = ? AND status = 'open' AND ${notReviewed}
    ORDER BY occurred_at DESC`).all(u.id, u.id);

  const gold = db.prepare(`SELECT * FROM transactions WHERE is_gold = 1 AND segment IN (${ph}) AND ${notReviewed}
    ORDER BY random() LIMIT ?`).all(...segs, u.id, GOLD_PER_QUEUE);

  const community = db.prepare(`SELECT * FROM transactions WHERE owner_user_id IS NULL AND is_gold = 0 AND status = 'open'
    AND segment IN (${ph}) AND ${notReviewed}`).all(...segs, u.id);

  // Active learning: prioritise what the model is least sure about, items close to consensus,
  // and items matching the reviewer's own segment (business owners know business payments).
  const priority = (t) => {
    const s = t.model_score ?? 0.5;
    return (1 - Math.abs(s - 0.5) * 2) * 10 + Math.min(t.review_count, 4) * 1.5 + (t.segment === u.segment ? 3 : 0) + Math.random();
  };
  community.sort((a, b) => priority(b) - priority(a));

  const slots = Math.max(QUEUE_SIZE - own.length, 0);
  const goldUse = gold.slice(0, Math.min(gold.length, slots));
  const mixed = community.slice(0, Math.max(slots - goldUse.length, 0));
  for (const g of goldUse) mixed.splice(Math.floor(Math.random() * (mixed.length + 1)), 0, g);

  return { items: [...own, ...mixed].map((t) => toDto(t, u)), reasons: REASONS };
}

// ---------------------------------------------------------------- reviews

function badgeStats(db, u) {
  const s = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN t.owner_user_id = r.user_id THEN 1 ELSE 0 END), 0) AS own,
      COALESCE(SUM(CASE WHEN t.owner_user_id IS NULL AND t.consensus_label = 'fraud' AND r.label != 'legit' THEN 1 ELSE 0 END), 0) AS fraudFound
    FROM reviews r JOIN transactions t ON t.id = r.txn_id WHERE r.user_id = ? AND r.too_fast = 0`).get(u.id);
  return { ...s, goldSeen: u.gold_seen, goldCorrect: u.gold_correct, streak: u.streak_days };
}

export function awardBadges(db, userId) {
  const u = getUser(db, userId);
  const owned = new Set(db.prepare('SELECT badge FROM user_badges WHERE user_id = ?').all(userId).map((r) => r.badge));
  const fresh = G.newlyEarnedBadges(badgeStats(db, u), owned);
  const ins = db.prepare('INSERT INTO user_badges (user_id, badge) VALUES (?, ?)');
  for (const k of fresh) ins.run(userId, k);
  return fresh;
}

/** Community items resolve once enough trust-weighted agreement exists; agreeing reviewers get a bonus. */
export function resolveIfReady(db, txnId) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
  if (!t || t.status !== 'open' || t.is_gold || t.owner_user_id != null) return null;
  const votes = db.prepare(`SELECT r.user_id, r.label, r.confidence, u.trust FROM reviews r
    JOIN users u ON u.id = r.user_id WHERE r.txn_id = ? AND r.too_fast = 0`).all(txnId);
  const agg = aggregate(votes);
  if (!agg.resolved) return { resolved: false, n: agg.n };
  db.prepare(`UPDATE transactions SET status = 'resolved', consensus_label = ?, consensus_confidence = ?,
    resolved_at = datetime('now') WHERE id = ?`).run(agg.label, agg.confidence, txnId);
  const winners = votes.filter((v) => agrees(v.label, agg.label)).map((v) => v.user_id);
  for (const uid of winners) awardPoints(db, uid, G.RULES.CONSENSUS_BONUS, 'consensus_bonus', `txn:${txnId}`);
  return { resolved: true, label: agg.label, confidence: agg.confidence, n: agg.n, winners };
}

/** The account holder is the authority on their own transactions. */
function resolveOwn(db, t, label, u) {
  const acct = toDto(t, u).account;
  if (label === 'suspicious') {
    db.prepare("UPDATE transactions SET status = 'escalated' WHERE id = ?").run(t.id);
    return { tone: 'info', title: 'Escalated to a specialist',
      message: 'No problem — a fraud specialist will contact you within 1 business day. (Simulated)' };
  }
  db.prepare(`UPDATE transactions SET status = 'resolved', consensus_label = ?, consensus_confidence = 1,
    resolved_at = datetime('now') WHERE id = ?`).run(label, t.id);
  if (label === 'legit') {
    return { tone: 'success', title: 'Thanks for confirming',
      message: 'We’ve cleared this transaction and taught our model that this pattern is normal for you.' };
  }
  return { tone: 'alert', title: 'We’re on it',
    message: `We’ve locked ${acct} and opened a dispute for ${money(t.amount)}. A replacement is on its way. (Simulated)` };
}

export function submitReview(db, user, body = {}) {
  const txnId = Number(body.txnId);
  const label = body.label;
  if (!Number.isInteger(txnId)) throw new ApiError(400, 'txnId is required');
  if (!['legit', 'suspicious', 'fraud'].includes(label)) throw new ApiError(400, 'label must be legit, suspicious or fraud');
  const reasons = label === 'legit' ? []
    : [...new Set(Array.isArray(body.reasons) ? body.reasons : [])].filter((r) => Object.hasOwn(REASONS, r));
  const confidence = [1, 2, 3].includes(Number(body.confidence)) ? Number(body.confidence) : 2;
  const durationMs = Math.max(0, Math.round(Number(body.durationMs) || 0));

  return tx(db, () => {
    const u = getUser(db, user.id);
    if (u.role !== 'customer') throw new ApiError(403, 'Only customers can review');
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
    if (!t || !canSee(u, t)) throw new ApiError(404, 'Transaction not found');
    if (t.status !== 'open') throw new ApiError(409, 'This transaction has already been resolved');
    if (db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND txn_id = ?').get(u.id, t.id)) {
      throw new ApiError(409, 'You already reviewed this transaction');
    }

    const today = localDay();
    const reviewsToday = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND review_day = ? AND too_fast = 0')
      .get(u.id, today).n;
    const streak = G.nextStreak(u.last_review_day, today, u.streak_days);
    const score = G.scoreReview({ txn: t, userId: u.id, label, reasons, durationMs, reviewsToday, streak, trust: u.trust });

    db.prepare(`INSERT INTO reviews (user_id, txn_id, label, reasons, confidence, duration_ms, too_fast, points_awarded, review_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, t.id, label, JSON.stringify(reasons), confidence, durationMs, score.tooFast ? 1 : 0, score.points, today);
    db.prepare('UPDATE transactions SET review_count = review_count + 1 WHERE id = ?').run(t.id);

    let trust = u.trust;
    if (t.is_gold) trust = G.updateTrust(trust, score.goldCorrect);
    if (score.tooFast) trust = clamp(trust - G.RULES.TOO_FAST_TRUST_PENALTY, 0.05, 1);
    db.prepare(`UPDATE users SET trust = ?, gold_seen = gold_seen + ?, gold_correct = gold_correct + ?,
        streak_days = ?, last_review_day = ? WHERE id = ?`)
      .run(trust, t.is_gold ? 1 : 0, score.goldCorrect ? 1 : 0,
        score.tooFast ? u.streak_days : streak, score.tooFast ? u.last_review_day : today, u.id);

    const breakdown = [...score.breakdown];
    let total = score.points;
    if (score.points) awardPoints(db, u.id, score.points, 'review', `txn:${t.id}`);

    let dailyGoal = null;
    if (!score.tooFast && reviewsToday + 1 === G.RULES.DAILY_GOAL) {
      awardPoints(db, u.id, G.RULES.DAILY_GOAL_BONUS, 'daily_goal', today);
      breakdown.push({ label: 'Daily goal complete!', points: G.RULES.DAILY_GOAL_BONUS, bonus: true });
      total += G.RULES.DAILY_GOAL_BONUS;
      dailyGoal = { bonus: G.RULES.DAILY_GOAL_BONUS };
    }

    let ownOutcome = null;
    let consensus = null;
    if (t.owner_user_id === u.id) {
      ownOutcome = resolveOwn(db, t, label, u);
    } else if (!t.is_gold && !score.tooFast) {
      const c = resolveIfReady(db, t.id);
      if (c?.resolved) {
        const agreed = c.winners.includes(u.id);
        consensus = { label: c.label, confidence: c.confidence, n: c.n, agreed };
        if (agreed) {
          breakdown.push({ label: 'Community agreed with you', points: G.RULES.CONSENSUS_BONUS, bonus: true });
          total += G.RULES.CONSENSUS_BONUS;
        }
      }
    }

    const newBadges = awardBadges(db, u.id).map(G.badgeDef);
    const after = getUser(db, u.id);
    const lvBefore = G.levelFor(u.lifetime_points);
    const lvAfter = G.levelFor(after.lifetime_points);

    return {
      points: total,
      breakdown,
      tooFast: score.tooFast,
      capped: score.capped,
      gold: t.is_gold ? { correct: score.goldCorrect, truth: t.true_label } : null,
      dailyGoal,
      consensus,
      ownOutcome,
      newBadges,
      levelUp: lvAfter.level > lvBefore.level ? lvAfter : null,
      me: getMe(db, after),
    };
  });
}

// ---------------------------------------------------------------- rewards

const FULFILLMENT = {
  gift_card: () => `Code ${code('GC')} — also emailed to you`,
  swag: () => 'Ships to your address on file in 5–7 business days',
  charity: () => 'Donation made in your name — receipt emailed',
  perk: () => 'Applied to your account on your next statement',
};
function code(prefix) {
  const r = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8)}`;
}

function lockReason(reward, u) {
  if (reward.segment && reward.segment !== u.segment) return `${reward.segment === 'business' ? 'Business' : 'Personal'} customers only`;
  const lv = G.levelFor(u.lifetime_points);
  if (lv.level < reward.min_level) return `Unlocks at level ${reward.min_level} (${G.LEVELS[reward.min_level - 1].name})`;
  if (reward.stock <= 0) return 'Out of stock';
  if (u.points < reward.cost) return `${(reward.cost - u.points).toLocaleString()} more points needed`;
  return null;
}

export function listRewards(db, user) {
  const u = getUser(db, user.id);
  const items = db.prepare('SELECT * FROM rewards ORDER BY cost').all()
    .filter((r) => !r.segment || r.segment === u.segment)
    .map((r) => ({ ...r, locked: lockReason(r, u) }));
  const redemptions = db.prepare(`SELECT d.id, d.cost, d.fulfillment, d.created_at, r.name, r.icon
    FROM redemptions d JOIN rewards r ON r.id = d.reward_id WHERE d.user_id = ? ORDER BY d.id DESC`).all(u.id);
  return { balance: u.points, items, redemptions };
}

export function redeem(db, user, rewardId) {
  return tx(db, () => {
    const u = getUser(db, user.id);
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(Number(rewardId));
    if (!r) throw new ApiError(404, 'Reward not found');
    const lock = lockReason(r, u);
    if (lock) throw new ApiError(400, lock);
    const fulfillment = FULFILLMENT[r.category]();
    db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(r.id);
    const { lastInsertRowid } = db.prepare('INSERT INTO redemptions (user_id, reward_id, cost, fulfillment) VALUES (?, ?, ?, ?)')
      .run(u.id, r.id, r.cost, fulfillment);
    awardPoints(db, u.id, -r.cost, 'redemption', `reward:${r.id}`);
    return { redemptionId: Number(lastInsertRowid), reward: r.name, fulfillment, me: getMe(db, u) };
  });
}

// ---------------------------------------------------------------- leaderboard & activity

export function leaderboard(db, user, period = 'week') {
  const rows = period === 'all'
    ? db.prepare(`SELECT id, display_name, lifetime_points AS pts, lifetime_points FROM users
        WHERE role = 'customer' ORDER BY pts DESC`).all()
    : db.prepare(`SELECT u.id, u.display_name, u.lifetime_points,
          COALESCE(SUM(CASE WHEN l.delta > 0 AND l.reason != 'opening_balance' THEN l.delta END), 0) AS pts
        FROM users u LEFT JOIN points_ledger l ON l.user_id = u.id AND l.created_at >= datetime('now', '-7 days')
        WHERE u.role = 'customer' GROUP BY u.id ORDER BY pts DESC`).all();
  const ranked = rows.map((r, i) => ({
    rank: i + 1, name: r.display_name, points: r.pts, level: G.levelFor(r.lifetime_points).name, isMe: r.id === user.id,
  }));
  return { period, top: ranked.slice(0, 10), me: ranked.find((r) => r.isMe) ?? null };
}

export function activity(db, user) {
  return db.prepare('SELECT delta, reason, ref, created_at FROM points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 25')
    .all(user.id);
}

// ---------------------------------------------------------------- analyst: model, stats, export

export function retrain(db) {
  const labeled = db.prepare('SELECT * FROM transactions WHERE is_gold = 0 AND consensus_label IS NOT NULL').all();
  const pos = labeled.filter((t) => t.consensus_label === 'fraud').length;
  const neg = labeled.length - pos;
  if (labeled.length < 20 || !pos || !neg) throw new ApiError(400, 'Not enough labeled data (need 20+ with both classes)');

  const rows = labeled.map((t) => {
    const y = t.consensus_label === 'fraud' ? 1 : 0;
    const sourceWeight = t.owner_user_id != null ? 1.5 : Math.max(t.consensus_confidence ?? 0.5, 0.2);
    return { x: M.featurize(t), y, w: sourceWeight * (y ? neg / pos : 1) }; // class-balanced
  });
  const model = M.train(rows);

  // Holdout: everything the crowd has NOT labeled, scored against simulated confirmed outcomes.
  const holdout = db.prepare('SELECT * FROM transactions WHERE is_gold = 0 AND consensus_label IS NULL').all();
  const metrics = {
    ...M.evaluate(model, holdout),
    nTrain: labeled.length,
    fraudLabels: pos,
    ownAccountLabels: labeled.filter((t) => t.owner_user_id != null).length,
    labelAccuracy: labeled.filter((t) => t.consensus_label === t.true_label).length / labeled.length,
  };

  return tx(db, () => {
    const { lastInsertRowid } = db.prepare('INSERT INTO model_versions (n_train, weights, bias, metrics) VALUES (?, ?, ?, ?)')
      .run(labeled.length, JSON.stringify(model.weights), model.bias, JSON.stringify(metrics));
    const upd = db.prepare('UPDATE transactions SET model_score = ? WHERE id = ?');
    for (const t of db.prepare('SELECT * FROM transactions').all()) upd.run(M.predict(model, M.featurize(t)), t.id);
    return { version: Number(lastInsertRowid), metrics, topFactors: M.topFactors(model) };
  });
}

export function adminStats(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const versions = db.prepare('SELECT id, created_at, n_train, weights, bias, metrics FROM model_versions ORDER BY id DESC').all();
  const latest = versions[0];
  const labeledSinceTrain = latest
    ? one(`SELECT COUNT(*) AS n FROM transactions WHERE is_gold = 0 AND consensus_label IS NOT NULL
        AND resolved_at > ?`, latest.created_at).n
    : 0;
  const crowd = one(`SELECT COUNT(*) AS n, COALESCE(SUM(consensus_label = true_label), 0) AS correct FROM transactions
    WHERE owner_user_id IS NULL AND is_gold = 0 AND consensus_label IS NOT NULL`);
  const own = one(`SELECT COUNT(*) AS n, COALESCE(SUM(consensus_label = 'fraud'), 0) AS fraud,
      COALESCE(SUM(status = 'escalated'), 0) AS escalated
    FROM transactions WHERE owner_user_id IS NOT NULL AND status != 'open'`);

  return {
    totals: {
      reviews: one('SELECT COUNT(*) AS n FROM reviews WHERE too_fast = 0').n,
      tooFast: one('SELECT COUNT(*) AS n FROM reviews WHERE too_fast = 1').n,
      reviewers: one('SELECT COUNT(DISTINCT user_id) AS n FROM reviews').n,
      open: one("SELECT COUNT(*) AS n FROM transactions WHERE status = 'open' AND is_gold = 0").n,
      resolved: one("SELECT COUNT(*) AS n FROM transactions WHERE status = 'resolved'").n,
      gold: one('SELECT COUNT(*) AS n FROM transactions WHERE is_gold = 1').n,
      pointsIssued: one('SELECT COALESCE(SUM(delta), 0) AS n FROM points_ledger WHERE delta > 0').n,
      pointsRedeemed: -one('SELECT COALESCE(SUM(delta), 0) AS n FROM points_ledger WHERE delta < 0').n,
      redemptions: one('SELECT COUNT(*) AS n FROM redemptions').n,
    },
    crowdAccuracy: crowd.n ? crowd.correct / crowd.n : null,
    crowdResolved: crowd.n,
    ownAccount: own,
    labelMix: db.prepare('SELECT label, COUNT(*) AS n FROM reviews WHERE too_fast = 0 GROUP BY label').all(),
    reviewers: db.prepare(`SELECT u.display_name AS name, u.is_bot, u.segment, u.trust, u.gold_seen, u.gold_correct,
        COUNT(r.id) AS reviews, COALESCE(SUM(r.too_fast), 0) AS too_fast
      FROM users u LEFT JOIN reviews r ON r.user_id = u.id WHERE u.role = 'customer'
      GROUP BY u.id ORDER BY reviews DESC`).all(),
    labeledSinceTrain,
    models: versions.map((v) => ({ id: v.id, createdAt: v.created_at, nTrain: v.n_train, metrics: JSON.parse(v.metrics) })),
    topFactors: latest ? M.topFactors({ weights: JSON.parse(latest.weights), bias: latest.bias }) : [],
  };
}

export function exportTrainingData(db, format = 'jsonl') {
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM reviews r WHERE r.txn_id = t.id AND r.too_fast = 0) AS n_reviews
    FROM transactions t WHERE t.is_gold = 0 AND t.consensus_label IS NOT NULL ORDER BY t.id`).all();
  const records = rows.map((t) => ({
    txn_id: t.id,
    label: t.consensus_label === 'fraud' ? 1 : 0,
    label_confidence: Number((t.consensus_confidence ?? 0).toFixed(3)),
    label_source: t.owner_user_id != null ? 'account_holder' : 'crowd_consensus',
    n_reviews: t.n_reviews,
    ...Object.fromEntries(M.FEATURE_NAMES.map((n, i) => [n, Number(M.featurize(t)[i].toFixed(4))])),
  }));
  if (format === 'csv') {
    const cols = Object.keys(records[0] ?? { txn_id: 0 });
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.map(q).join(','), ...records.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n';
  }
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
