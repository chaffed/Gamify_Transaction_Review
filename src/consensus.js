// Trust-weighted aggregation of crowd labels into a single training label.

export const VOTE_VALUE = { legit: 0, suspicious: 0.65, fraud: 1 };
export const MIN_REVIEWS = 3;
export const MAX_REVIEWS = 5;
export const RESOLVE_CONFIDENCE = 0.6;

/**
 * votes: [{ label, trust, confidence (1..3) }]
 * Returns a fraud probability p, the resulting label, a 0..1 confidence and whether it can be resolved.
 */
export function aggregate(votes) {
  let num = 0;
  let den = 0;
  for (const v of votes) {
    const w = v.trust * (0.5 + v.confidence / 6); // self-reported confidence scales weight 0.67..1.0
    num += w * VOTE_VALUE[v.label];
    den += w;
  }
  const p = den > 0 ? num / den : 0.5;
  const label = p >= 0.5 ? 'fraud' : 'legit';
  const confidence = Math.abs(p - 0.5) * 2;
  const n = votes.length;
  const resolved = n >= MAX_REVIEWS || (n >= MIN_REVIEWS && confidence >= RESOLVE_CONFIDENCE);
  return { p, label, confidence, n, resolved };
}

export const agrees = (label, consensusLabel) =>
  consensusLabel === 'fraud' ? label !== 'legit' : label === 'legit';
