import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gamification.js';
import { aggregate } from '../src/consensus.js';
import { auc } from '../src/model.js';
import { openDb } from '../src/db.js';
import * as S from '../src/services.js';

const txn = (o = {}) => ({ owner_user_id: null, segment: 'consumer', is_gold: 0, true_label: 'legit', ...o });
const base = { userId: 1, reasons: [], durationMs: 8000, reviewsToday: 0, streak: 1, trust: 0.5 };

test('scoring: base, reasons, gold bonus and multipliers', () => {
  assert.equal(G.scoreReview({ ...base, txn: txn(), label: 'legit' }).points, 10);
  assert.equal(G.scoreReview({ ...base, txn: txn({ segment: 'business' }), label: 'legit' }).points, 15);
  assert.equal(G.scoreReview({ ...base, txn: txn({ owner_user_id: 1 }), label: 'legit' }).points, 25);
  // 10 + 3 reasons scored (4 given) * 2 = 16
  assert.equal(G.scoreReview({ ...base, txn: txn(), label: 'fraud', reasons: ['a', 'b', 'c', 'd'] }).points, 16);
  // gold correct: (10 + 15) * streak 1.2 (3 days) * trust 1.5 (1.0) = 45
  const r = G.scoreReview({ ...base, txn: txn({ is_gold: 1, true_label: 'fraud' }), label: 'suspicious', streak: 3, trust: 1 });
  assert.equal(r.goldCorrect, true);
  assert.equal(r.points, 45);
});

test('scoring: anti-gaming', () => {
  const fast = G.scoreReview({ ...base, txn: txn({ is_gold: 1 }), label: 'fraud', durationMs: 800 });
  assert.equal(fast.points, 0);
  assert.equal(fast.tooFast, true);
  assert.equal(fast.goldCorrect, false, 'gold accuracy still tracked when too fast');
  const capped = G.scoreReview({ ...base, txn: txn(), label: 'legit', reviewsToday: G.RULES.DAILY_CAP });
  assert.equal(capped.points, 0);
  assert.equal(capped.capped, true);
});

test('streaks, trust and levels', () => {
  assert.equal(G.nextStreak('2026-01-01', '2026-01-02', 4), 5);
  assert.equal(G.nextStreak('2026-01-02', '2026-01-02', 4), 4);
  assert.equal(G.nextStreak('2025-12-30', '2026-01-02', 4), 1);
  assert.equal(G.streakMultiplier(99), 1.5);
  assert.ok(G.updateTrust(0.5, true) > 0.5);
  assert.ok(G.updateTrust(0.5, false) < 0.5);
  assert.equal(G.updateTrust(0.05, false), 0.05);
  assert.equal(G.levelFor(0).name, 'Rookie');
  assert.equal(G.levelFor(750).level, 3);
  assert.equal(G.levelFor(99999).progress, 1);
});

test('consensus is trust-weighted', () => {
  const v = (label, trust) => ({ label, trust, confidence: 3 });
  // two low-trust fraud votes cannot outvote one high-trust legit + one mid
  const a = aggregate([v('fraud', 0.1), v('fraud', 0.1), v('legit', 0.9), v('legit', 0.6)]);
  assert.equal(a.label, 'legit');
  assert.equal(a.resolved, true);
  assert.equal(aggregate([v('fraud', 0.9), v('fraud', 0.9)]).resolved, false, 'needs >= 3 reviews');
  assert.equal(aggregate([v('fraud', 0.9), v('legit', 0.9), v('suspicious', 0.9)]).resolved, false, 'ambiguous stays open');
});

test('auc', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [false, false, true, true]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [false, false, true, true]), 0);
  assert.equal(auc([0.5, 0.5], [false, true]), 0.5);
});

test('end to end: queue → review → consensus → redeem → retrain', () => {
  const db = openDb(':memory:');
  const bob = db.prepare("SELECT * FROM users WHERE username = 'bob'").get();
  const analyst = db.prepare("SELECT * FROM users WHERE username = 'analyst'").get();

  assert.equal(S.userForToken(db, S.login(db, 'bob', 'demo')).id, bob.id);
  assert.throws(() => S.login(db, 'bob', 'nope'), /Invalid/);
  assert.throws(() => S.getQueue(db, analyst), /Only customers/);

  const q = S.getQueue(db, bob);
  assert.equal(q.items.length, 10);
  assert.equal(q.items[0].kind, 'own');
  for (const i of q.items) {
    for (const hidden of ['true_label', 'model_score', 'is_gold', 'review_count']) assert.ok(!(hidden in i), `${hidden} leaked`);
  }

  // Own-account "not me" → resolved as fraud immediately, badge awarded.
  const own = S.submitReview(db, bob, { txnId: q.items[0].id, label: 'fraud', reasons: ['new_device'], durationMs: 5000 });
  assert.equal(own.ownOutcome.tone, 'alert');
  assert.ok(own.newBadges.some((b) => b.key === 'guardian'));
  assert.throws(() => S.submitReview(db, bob, { txnId: q.items[0].id, label: 'legit', durationMs: 5000 }), /already/);

  // Other customers' own-account items are invisible.
  const alicesTxn = db.prepare("SELECT t.id FROM transactions t JOIN users u ON u.id = t.owner_user_id WHERE u.username = 'alice'").get();
  assert.throws(() => S.submitReview(db, bob, { txnId: alicesTxn.id, label: 'legit', durationMs: 5000 }), /not found/);

  // A community item with 2 prior agreeing votes resolves on the 3rd.
  const pending = db.prepare(`SELECT t.id, t.true_label FROM transactions t WHERE t.status = 'open' AND t.is_gold = 0
    AND t.owner_user_id IS NULL AND t.segment = 'consumer'
    AND (SELECT COUNT(*) FROM reviews r WHERE r.txn_id = t.id) = 2
    AND (SELECT COUNT(*) FROM reviews r WHERE r.txn_id = t.id AND r.too_fast = 0 AND r.label = 'legit') = 2`).all();
  assert.ok(pending.length, 'seed should contain items one vote from consensus');
  const r = S.submitReview(db, bob, { txnId: pending[0].id, label: 'legit', durationMs: 6000, confidence: 3 });
  assert.ok(r.consensus, 'consensus reached');
  assert.equal(r.consensus.agreed, true);
  assert.ok(r.breakdown.some((b) => b.label === 'Community agreed with you'));

  // Too-fast reviews earn nothing.
  const next = S.getQueue(db, bob).items.find((i) => i.kind === 'community');
  assert.equal(S.submitReview(db, bob, { txnId: next.id, label: 'legit', durationMs: 300 }).points, 0);

  // Ledger always matches the cached balance.
  const sum = db.prepare('SELECT SUM(delta) AS s FROM points_ledger WHERE user_id = ?').get(bob.id).s;
  assert.equal(db.prepare('SELECT points FROM users WHERE id = ?').get(bob.id).points, sum);

  // Rewards: Bob can't afford the hoodie (and it's level-locked); Alice can redeem a coffee card.
  assert.throws(() => S.redeem(db, bob, 8), /Unlocks at level|more points/);
  const alice = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
  const red = S.redeem(db, alice, 2);
  assert.match(red.fulfillment, /^Code GC-/);
  assert.equal(red.me.points, alice.points - 500);

  const v = S.retrain(db);
  assert.equal(v.version, 2);
  assert.ok(v.metrics.auc > 0.8, `AUC ${v.metrics.auc}`);
  const csv = S.exportTrainingData(db, 'csv');
  assert.match(csv.split('\n')[0], /^txn_id,label,label_confidence,label_source/);
  assert.ok(csv.includes('account_holder'));
});
