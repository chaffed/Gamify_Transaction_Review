import { tx, localDay, dayOffset, hashPassword } from './util.js';
import { mulberry32, generateTransaction, generateWhere, riskSignalCount } from './generator.js';
import { awardPoints, awardBadges, resolveIfReady, retrain } from './services.js';

const REWARDS = [
  ['“Fraud Fighter” enamel pin', 'Limited-run pin for your jacket or bag', 'swag', '📌', 300, 200, 1, null],
  ['$5 coffee gift card', 'Redeemable at participating coffee shops', 'gift_card', '☕', 500, 500, 1, null],
  ['Insulated water bottle', 'Bank-branded 20oz stainless bottle', 'swag', '🧴', 800, 150, 1, null],
  ['$10 donation to a food bank', 'We donate on your behalf and send a receipt', 'charity', '💚', 900, 9999, 1, null],
  ['$10 retail gift card', 'Use at thousands of online and in-store retailers', 'gift_card', '🎁', 1000, 500, 1, null],
  ['Waived monthly maintenance fee', 'One month of business checking, fee-free', 'perk', '🏢', 1500, 9999, 1, 'business'],
  ['$25 dining gift card', 'Treat yourself — accepted at 10,000+ restaurants', 'gift_card', '🍽️', 2400, 300, 2, null],
  ['Fraud Fighter hoodie', 'Heavyweight hoodie, only for Sleuths and up', 'swag', '🧥', 3000, 75, 3, null],
  ['+0.25% CD rate boost', 'Bonus APY on your next 12-month CD', 'perk', '📈', 5000, 9999, 4, 'consumer'],
];

// Simulated crowd: accuracy drives their votes; trust is what the system has learned about them.
const BOTS = [
  ['Sentinel42', 0.94, 0.9], ['LedgerHawk', 0.91, 0.86], ['NightOwl', 0.88, 0.8], ['CardShark', 0.86, 0.76],
  ['PennyWise', 0.83, 0.7], ['AuditAce', 0.9, 0.84], ['GuardDog', 0.8, 0.64], ['ClickFast99', 0.5, 0.12],
];

export function seed(db, { seed: s = 42 } = {}) {
  const rng = mulberry32(s);
  const now = Date.now();
  const today = localDay();
  const pw = hashPassword('demo');

  tx(db, () => {
    const insUser = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, segment, is_bot, card_last4,
      trust, streak_days, last_review_day, gold_seen, gold_correct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const id = (r) => Number(r.lastInsertRowid);

    const alice = id(insUser.run('alice', 'Alice M.', pw, 'customer', 'consumer', 0, '4821', 0.72, 4, dayOffset(today, -1), 9, 8));
    const bob = id(insUser.run('bob', 'Bob T.', pw, 'customer', 'consumer', 0, '1937', 0.5, 0, null, 0, 0));
    const acme = id(insUser.run('acme', 'Acme Plumbing LLC', pw, 'customer', 'business', 0, '7710', 0.8, 1, dayOffset(today, -1), 12, 11));
    insUser.run('analyst', 'Fraud Ops Analyst', pw, 'analyst', 'consumer', 0, null, 0.5, 0, null, 0, 0);
    const bots = BOTS.map(([name, acc, trust]) => ({
      id: id(insUser.run(name.toLowerCase(), name, '!', 'customer', 'consumer', 1, null, trust, 0, null, 0, 0)),
      acc, spammer: acc < 0.6,
    }));

    const insReward = db.prepare(`INSERT INTO rewards (name, description, category, icon, cost, stock, min_level, segment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of REWARDS) insReward.run(...r);

    const insTxn = db.prepare(`INSERT INTO transactions (owner_user_id, segment, type, amount, avg_amount, merchant, category,
      country, city, channel, device_new, new_payee, hour, distance_km, velocity_24h, account_age_days, occurred_at, is_gold, true_label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const save = (t, gold = 0) => id(insTxn.run(t.owner_user_id, t.segment, t.type, t.amount, t.avg_amount, t.merchant,
      t.category, t.country, t.city, t.channel, t.device_new, t.new_payee, t.hour, t.distance_km, t.velocity_24h,
      t.account_age_days, t.occurred_at, gold, t.true_label));

    // Own-account items: transactions the model flagged on the customer's own account ("Did you make this?").
    for (const [owner, segment] of [[alice, 'consumer'], [bob, 'consumer'], [acme, 'business']]) {
      for (let i = 0; i < 5; i++) {
        const fraud = i < 2;
        save(generateWhere(rng, { segment, fraud, ownerUserId: owner, now }, (t) => riskSignalCount(t) >= (fraud ? 2 : 1)));
      }
    }

    // Gold / training cases: clear-cut examples with known outcomes, mixed invisibly into queues.
    for (const [segment, nFraud, nLegit] of [['consumer', 8, 16], ['business', 6, 10]]) {
      for (let i = 0; i < nFraud + nLegit; i++) {
        const fraud = i < nFraud;
        save(generateWhere(rng, { segment, fraud, now }, (t) => (fraud ? riskSignalCount(t) >= 3 : riskSignalCount(t) === 0)), 1);
      }
    }

    // Community pool (anonymized).
    const community = [];
    for (const [segment, n, rate] of [['consumer', 380, 0.14], ['business', 140, 0.16]]) {
      for (let i = 0; i < n; i++) {
        const t = generateTransaction(rng, { segment, fraud: rng() < rate, now });
        community.push({ id: save(t), ...t });
      }
    }

    // Historical crowd reviews on ~60% of the pool; Alice and Acme have some history too.
    const insReview = db.prepare(`INSERT INTO reviews (user_id, txn_id, label, reasons, confidence, duration_ms, too_fast,
      points_awarded, review_day, created_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, datetime('now', ?))`);
    const bumpCount = db.prepare('UPDATE transactions SET review_count = review_count + 1 WHERE id = ?');
    const humans = { consumer: { id: alice, acc: 0.9, left: 14 }, business: { id: acme, acc: 0.92, left: 16 } };

    const vote = (truth, acc) => {
      if (rng() < acc) return truth === 'fraud' ? (rng() < 0.8 ? 'fraud' : 'suspicious') : 'legit';
      return truth === 'fraud' ? 'legit' : rng() < 0.6 ? 'suspicious' : 'fraud';
    };

    const reviewed = community.filter(() => rng() < 0.6);
    for (const t of reviewed) {
      const n = rng() < 0.3 ? 1 + Math.floor(rng() * 2) : 3 + Math.floor(rng() * 3);
      const pool = [...bots].sort(() => rng() - 0.5).slice(0, n);
      const human = humans[t.segment];
      if (human.left > 0 && rng() < 0.15) { pool[0] = human; human.left--; }
      for (const r of pool) {
        const daysAgo = 1 + Math.floor(rng() * 20);
        const tooFast = r.spammer && rng() < 0.5 ? 1 : 0;
        const pts = tooFast ? 0 : t.segment === 'business' ? 15 : 10;
        insReview.run(r.id, t.id, vote(t.true_label, r.acc), 1 + Math.floor(rng() * 3),
          tooFast ? 900 : 5000 + Math.floor(rng() * 20000), tooFast, pts, dayOffset(today, -daysAgo), `-${daysAgo} days`);
        bumpCount.run(t.id);
        if (pts) awardPoints(db, r.id, pts, 'review', `txn:${t.id}`, `-${daysAgo} days`);
      }
    }
    for (const t of reviewed) resolveIfReady(db, t.id);

    // Demo balances & history.
    awardPoints(db, alice, 1000, 'opening_balance', 'demo', '-30 days');
    awardPoints(db, acme, 2200, 'opening_balance', 'demo', '-30 days');
    awardPoints(db, bob, 120, 'opening_balance', 'demo', '-5 days');
    const insRedemption = db.prepare(`INSERT INTO redemptions (user_id, reward_id, cost, fulfillment, created_at)
      VALUES (?, ?, ?, ?, datetime('now', '-12 days'))`);
    insRedemption.run(alice, 1, 300, 'Ships to your address on file in 5–7 business days');
    awardPoints(db, alice, -300, 'redemption', 'reward:1', '-12 days');
    insRedemption.run(acme, 3, 800, 'Ships to your address on file in 5–7 business days');
    awardPoints(db, acme, -800, 'redemption', 'reward:3', '-12 days');

    for (const u of [alice, acme, ...bots.map((b) => b.id)]) awardBadges(db, u);
  });

  retrain(db); // model v1 from the historical crowd labels
}
