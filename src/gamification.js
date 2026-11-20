// Pure scoring / progression rules. No DB access here so it is easy to test and tune.
import { clamp, dayOffset } from './util.js';

export const RULES = Object.freeze({
  MIN_REVIEW_MS: 2500,      // faster than this = "click-through", no points
  DAILY_GOAL: 10,           // reviews per day for the daily bonus
  DAILY_GOAL_BONUS: 50,
  DAILY_CAP: 100,           // reviews per day that can earn points (anti-farming)
  GOLD_BONUS: 15,           // correct answer on a hidden known-answer "training case"
  CONSENSUS_BONUS: 5,       // agreed with the crowd once a transaction resolves
  REASON_POINTS: 2,         // per reason tag on a suspicious/fraud label (richer training signal)
  MAX_REASONS_SCORED: 3,
  STREAK_STEP: 0.1,         // +10% per consecutive day...
  STREAK_MAX_STEPS: 5,      // ...up to 1.5x
  TOO_FAST_TRUST_PENALTY: 0.01,
});

export const LEVELS = [
  { name: 'Rookie', min: 0 },
  { name: 'Spotter', min: 250 },
  { name: 'Sleuth', min: 750 },
  { name: 'Detective', min: 2000 },
  { name: 'Inspector', min: 5000 },
  { name: 'Fraud Fighter', min: 10000 },
];

export function levelFor(lifetimePoints) {
  let i = 0;
  while (i + 1 < LEVELS.length && lifetimePoints >= LEVELS[i + 1].min) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1] ?? null;
  return {
    level: i + 1,
    name: cur.name,
    min: cur.min,
    nextMin: next?.min ?? null,
    nextName: next?.name ?? null,
    progress: next ? (lifetimePoints - cur.min) / (next.min - cur.min) : 1,
  };
}

/** Own-account confirmations are the most valuable label; business payments next. */
export function basePoints(txn, userId) {
  if (txn.owner_user_id === userId) return 25;
  if (txn.segment === 'business') return 15;
  return 10;
}

/** "Suspicious" counts as a correct catch on a fraud case, but not on a legit one. */
export function isCorrectLabel(label, truth) {
  return truth === 'fraud' ? label !== 'legit' : label === 'legit';
}

export function nextStreak(lastDay, today, current) {
  if (lastDay === today) return Math.max(current, 1);
  if (lastDay && dayOffset(lastDay, 1) === today) return current + 1;
  return 1;
}

export const streakMultiplier = (streak) =>
  1 + RULES.STREAK_STEP * Math.min(Math.max(streak - 1, 0), RULES.STREAK_MAX_STEPS);

/** Trust 0.05..1 maps to 0.55x..1.5x; a brand-new reviewer (0.5) earns 1.0x. */
export const trustMultiplier = (trust) => 0.5 + trust;

export function updateTrust(trust, correct) {
  const t = correct ? trust + 0.05 * (1 - trust) : trust - 0.12 * trust;
  return clamp(t, 0.05, 1);
}

export function scoreReview({ txn, userId, label, reasons = [], durationMs, reviewsToday, streak, trust }) {
  const goldCorrect = txn.is_gold ? isCorrectLabel(label, txn.true_label) : null;

  if (durationMs < RULES.MIN_REVIEW_MS) {
    return { points: 0, tooFast: true, capped: false, goldCorrect,
      breakdown: [{ label: 'Reviewed too quickly — take a closer look to earn points', points: 0 }] };
  }
  if (reviewsToday >= RULES.DAILY_CAP) {
    return { points: 0, tooFast: false, capped: true, goldCorrect,
      breakdown: [{ label: `Daily cap of ${RULES.DAILY_CAP} scored reviews reached`, points: 0 }] };
  }

  const breakdown = [];
  const base = basePoints(txn, userId);
  breakdown.push({ label: txn.owner_user_id === userId ? 'Your-account confirmation' : 'Review', points: base });
  let pts = base;

  if (label !== 'legit' && reasons.length) {
    const r = Math.min(reasons.length, RULES.MAX_REASONS_SCORED) * RULES.REASON_POINTS;
    breakdown.push({ label: 'Reason tags', points: r });
    pts += r;
  }
  if (goldCorrect) {
    breakdown.push({ label: 'Training case nailed', points: RULES.GOLD_BONUS });
    pts += RULES.GOLD_BONUS;
  }

  const sm = streakMultiplier(streak);
  const tm = trustMultiplier(trust);
  if (sm !== 1) breakdown.push({ label: `${streak}-day streak`, multiplier: round2(sm) });
  breakdown.push({ label: 'Accuracy rating', multiplier: round2(tm) });

  return { points: Math.round(pts * sm * tm), tooFast: false, capped: false, goldCorrect, breakdown };
}

const round2 = (n) => Math.round(n * 100) / 100;

export const BADGES = [
  { key: 'first_look', icon: '🔍', name: 'First Look', description: 'Complete your first review', test: (s) => s.total >= 1 },
  { key: 'warmed_up', icon: '🏃', name: 'Warmed Up', description: 'Complete 10 reviews', test: (s) => s.total >= 10 },
  { key: 'centurion', icon: '💯', name: 'Centurion', description: 'Complete 100 reviews', test: (s) => s.total >= 100 },
  { key: 'guardian', icon: '🛡️', name: 'Account Guardian', description: 'Confirm a transaction on your own account', test: (s) => s.own >= 1 },
  { key: 'fraud_finder', icon: '🎯', name: 'Fraud Finder', description: 'Flag 3 transactions the community confirmed as fraud', test: (s) => s.fraudFound >= 3 },
  { key: 'sharp_eye', icon: '🦅', name: 'Sharp Eye', description: 'Get 5 training cases right', test: (s) => s.goldCorrect >= 5 },
  { key: 'sharpshooter', icon: '🏹', name: 'Sharpshooter', description: '90%+ accuracy over 20 training cases', test: (s) => s.goldSeen >= 20 && s.goldCorrect / s.goldSeen >= 0.9 },
  { key: 'on_fire', icon: '🔥', name: 'On Fire', description: 'Review 3 days in a row', test: (s) => s.streak >= 3 },
  { key: 'week_warrior', icon: '📅', name: 'Week Warrior', description: 'Review 7 days in a row', test: (s) => s.streak >= 7 },
];

export function newlyEarnedBadges(stats, owned) {
  return BADGES.filter((b) => !owned.has(b.key) && b.test(stats)).map((b) => b.key);
}

export const badgeDef = (key) => {
  const { test, ...rest } = BADGES.find((b) => b.key === key);
  return rest;
};
