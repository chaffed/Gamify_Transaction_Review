# FraudQuest — gamified transaction review (PoC)

Online-banking customers (consumer and business) sign in and work through a queue of transactions, judging each as
**legit / suspicious / fraud**. Good reviews earn points, streaks, levels and badges, and points are redeemed for gift
cards, bank swag, charity donations and account perks. Behind the game, every review becomes a **weighted training label**
for the bank's fraud model, and analysts can retrain and export from a console.

Zero dependencies: Node's built-in `node:http` + `node:sqlite`, vanilla JS front end, no build step.

## Run it

```bash
node --version      # needs >= 22.13 (built-in node:sqlite)
npm start           # http://localhost:3000  (first run seeds data/fraudquest.db)
npm run reset       # wipe and re-seed
npm test
```

Demo logins (password `demo`):

| User | Who | Try this |
|---|---|---|
| `alice` | Personal customer, Lv 3, 4-day streak | Answer her own-account items ("Did you make this?"), then community items |
| `bob` | Brand-new personal customer | First-review badges, level 1 → 2, locked rewards |
| `acme` | Business customer (Acme Plumbing LLC) | ACH/wire queue, BEC-style "changed bank details" fraud, business-only perks |
| `analyst` | Bank fraud-ops analyst | Reviewer quality, crowd label accuracy, **Retrain model**, CSV/JSONL export |

Keyboard: `1` `2` `3` to answer, `Enter` to submit / next.

## How it works

```
 customers ──review──▶ reviews ──trust-weighted consensus──▶ labels ──▶ train model ──▶ re-score queue
     ▲                    │                                     │                         │
     └──points/badges◀────┘                                     └──export CSV/JSONL       │
     └──────────────── active learning: model-uncertain items are served first ◀──────────┘
```

### Two kinds of queue item
- **Your account**: transactions the model flagged on the customer's *own* account. The account holder is the
  authority here, so one answer resolves it: "not me" opens a (simulated) card lock and dispute, "not sure" escalates
  to a specialist. These are the highest-value labels (25 pts) and get extra weight in training.
- **Community**: anonymized transactions from other customers (no names, masked account numbers, city-level
  location). Consumers see consumer transactions; business users also see business payments, where their domain
  knowledge helps.

### Keeping labels honest (the hard part of crowdsourcing)
| Mechanism | Where |
|---|---|
| **Hidden training cases** ("gold"): clear-cut items with known outcomes mixed into every queue (2 per 10). They set each reviewer's **accuracy rating** (trust). | `services.getQueue`, `gamification.updateTrust` |
| **Trust-weighted consensus**: a community item resolves at ≥3 reviews with ≥0.6 agreement strength, or at 5 reviews. Low-trust votes barely count. | `consensus.aggregate` |
| **Trust multiplies points** (0.55×–1.5×), so careless clicking doesn't pay | `gamification.scoreReview` |
| **Too-fast reviews** (< 2.5 s) score 0 points, don't count toward consensus, and cost a little trust | same |
| **Daily cap** of 100 scored reviews (anti-farming) | same |
| **Model score is never shown** to reviewers (avoids anchoring), nor are gold flags or vote counts | `services.toDto` |
| **Points ledger**: every change is an append-only row, and the balance always reconciles | `points_ledger` table |

The seeded crowd includes `ClickFast99`, a low-quality click-farmer. The analyst console shows how the system rates
them and ignores them.

### Gamification rules (all in `src/gamification.js`)
- Points: +10 review (+15 business payment, +25 own account), +2 per reason tag (max 3), +15 training case correct,
  +5 when the community later agrees with you, +50 daily goal (10 reviews).
- Multipliers: streak (+10%/day up to ×1.5) × accuracy rating (×0.55–×1.5).
- Levels: Rookie → Spotter (250) → Sleuth (750) → Detective (2k) → Inspector (5k) → Fraud Fighter (10k). Some rewards
  are level-gated.
- Badges: First Look, Warmed Up, Centurion, Account Guardian, Fraud Finder, Sharp Eye, Sharpshooter, On Fire, Week Warrior.

### Model loop
`src/model.js` is a small logistic regression, standing in for the bank's real pipeline. Retraining:
1. Takes every resolved label (crowd consensus weighted by confidence; account-holder answers weighted 1.5×; classes balanced).
2. Evaluates on transactions the crowd **hasn't** labeled, against simulated confirmed outcomes (in production these
   would be chargebacks or confirmed disputes): AUC, precision and recall.
3. Re-scores every transaction, which changes what gets served next (uncertain items first).

Export (`/api/admin/export?format=csv|jsonl`) emits features, label, label confidence, label source and review count,
ready for an external training pipeline.

## Layout
```
server.js            HTTP server, routing, auth cookie, static files, security headers
src/services.js      queue, review submission, consensus resolution, rewards, leaderboard, analyst functions
src/gamification.js  scoring, streaks, trust, levels, badges (pure functions)
src/consensus.js     trust-weighted label aggregation
src/model.js         features, logistic regression, AUC/metrics
src/generator.js     synthetic consumer + business transactions (incl. BEC-style fraud)
src/seed.js          demo users, simulated crowd history, rewards catalog, model v1
src/db.js            SQLite schema
public/              single-page app (review, rewards, leaderboard, progress, analyst console)
test/core.test.js    rules + end-to-end tests
```

## What a production version would need to address
- **Privacy and consent.** Showing real customers' transactions to other customers, even masked, needs legal review,
  explicit opt-in and tight minimization (GLBA and state privacy laws; GDPR where applicable). A safer default is to keep
  the community queue to synthetic or heavily generalized cases and get the real label volume from own-account reviews.
- **Adversaries in the crowd.** Fraudsters may join to poison labels or learn what gets flagged. Mitigations: trust
  weighting, gold cases, rate limits, never revealing model logic, delaying feedback, and watching for collusion
  (correlated votes, shared devices).
- **Regulation of rewards and disputes.** Rewards may be taxable income (1099 thresholds); sweepstakes and
  rewards-program rules apply; own-account "not me" answers must flow into Reg E / Reg Z dispute handling, not just a label.
- **Model risk management.** Crowd labels are weak supervision. Track label noise, monitor bias across customer
  segments, version the data, and run models through the bank's model-risk validation (e.g. SR 11-7).
- **Engineering.** Real auth (SSO from online banking, MFA), session expiry and rotation, CSRF tokens, a durable
  database, a queue service, audit logging, accessibility audit, fraud-ops case management integration, and A/B
  testing of the incentive economics (cost per useful label vs. reward spend).

PoC shortcuts: plain demo passwords, an in-process SQLite database, synthetic data only, a simulated card lock,
simulated dispute and gift-card codes, and no email or shipping integration.
