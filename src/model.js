// Minimal logistic-regression fraud model trained on crowd/consensus labels.
// Stand-in for whatever the bank's real modeling pipeline is; the point is the label feedback loop.

export const CHANNELS = ['pos', 'online', 'mobile', 'atm', 'branch'];
export const TYPES = ['card_present', 'card_not_present', 'atm_withdrawal', 'p2p', 'ach', 'wire'];
export const CATEGORIES = [
  'grocery', 'dining', 'fuel', 'transport', 'subscription', 'retail', 'electronics', 'cash',
  'gift_cards', 'crypto', 'luxury', 'money_transfer',
  'supplies', 'logistics', 'software', 'payroll', 'utilities', 'insurance',
];

export const FEATURE_NAMES = [
  'log_amount', 'amount_vs_typical', 'foreign', 'new_device', 'new_payee', 'overnight',
  'distance_from_home', 'velocity_24h', 'account_age',
  ...CHANNELS.map((c) => `channel:${c}`),
  ...TYPES.map((t) => `type:${t}`),
  ...CATEGORIES.map((c) => `category:${c}`),
];

export function featurize(t) {
  const ratio = t.amount / Math.max(t.avg_amount, 0.01);
  return [
    Math.log1p(t.amount) / 10,
    Math.max(-3, Math.min(3, Math.log(ratio))),
    t.country !== 'US' ? 1 : 0,
    t.device_new ? 1 : 0,
    t.new_payee ? 1 : 0,
    t.hour < 6 ? 1 : 0,
    Math.log1p(t.distance_km) / 8,
    Math.min(t.velocity_24h, 30) / 10,
    Math.log1p(t.account_age_days) / 8,
    ...CHANNELS.map((c) => (t.channel === c ? 1 : 0)),
    ...TYPES.map((x) => (t.type === x ? 1 : 0)),
    ...CATEGORIES.map((c) => (t.category === c ? 1 : 0)),
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (w, x) => {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
};

/** rows: [{ x: number[], y: 0|1, w: sampleWeight }] — full-batch gradient descent with L2. */
export function train(rows, { epochs = 600, lr = 0.5, l2 = 0.02 } = {}) {
  const d = rows[0].x.length;
  const w = new Array(d).fill(0);
  let b = 0;
  const W = rows.reduce((s, r) => s + r.w, 0);
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (const r of rows) {
      const err = (sigmoid(dot(w, r.x) + b) - r.y) * r.w;
      for (let j = 0; j < d; j++) gw[j] += err * r.x[j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / W + l2 * w[j]);
    b -= (lr * gb) / W;
  }
  return { weights: w, bias: b };
}

export const predict = (model, x) => sigmoid(dot(model.weights, x) + model.bias);

/** Rank-based ROC AUC with tie handling. */
export function auc(scores, labels) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(scores.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  let nPos = 0;
  let sumPos = 0;
  labels.forEach((l, i) => {
    if (l) { nPos++; sumPos += ranks[i]; }
  });
  const nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return null;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Evaluate against outcome-confirmed truth (in production: chargebacks / confirmed disputes). */
export function evaluate(model, txns, threshold = 0.5) {
  const scores = txns.map((t) => predict(model, featurize(t)));
  const labels = txns.map((t) => t.true_label === 'fraud');
  let tp = 0, fp = 0, fn = 0, tn = 0;
  scores.forEach((s, i) => {
    const p = s >= threshold;
    if (p && labels[i]) tp++;
    else if (p) fp++;
    else if (labels[i]) fn++;
    else tn++;
  });
  return {
    n: txns.length,
    positives: tp + fn,
    auc: auc(scores, labels),
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    accuracy: txns.length ? (tp + tn) / txns.length : null,
  };
}

export function topFactors(model, k = 8) {
  return FEATURE_NAMES.map((name, i) => ({ name, weight: model.weights[i] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, k);
}
