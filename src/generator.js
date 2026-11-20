// Synthetic transaction generator. Fraud cases are drawn from shifted feature distributions with
// plenty of overlap, so labels are learnable but not trivially separable.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const chance = (rng, p) => rng() < p;
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const round2 = (n) => Math.round(n * 100) / 100;
function lognormal(rng, mu, sigma) {
  const u = 1 - rng();
  const v = rng();
  return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

export const COUNTRY_NAMES = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', NG: 'Nigeria', RO: 'Romania', BR: 'Brazil',
  VN: 'Vietnam', MX: 'Mexico', FR: 'France', JP: 'Japan', PH: 'Philippines',
};
const US_CITIES = ['Austin', 'Denver', 'Chicago', 'Seattle', 'Atlanta', 'Boston', 'Phoenix', 'Portland'];
const FOREIGN = [
  ['Toronto', 'CA'], ['London', 'GB'], ['Lagos', 'NG'], ['Bucharest', 'RO'], ['São Paulo', 'BR'],
  ['Ho Chi Minh City', 'VN'], ['Mexico City', 'MX'], ['Paris', 'FR'], ['Tokyo', 'JP'], ['Manila', 'PH'],
];

const CONSUMER_MERCHANTS = {
  grocery: ['FreshMart Grocery', 'GreenLeaf Market', 'Corner Pantry'],
  dining: ['Bella Cucina', 'Corner Coffee Co.', 'Taco Loco', 'Noodle House'],
  fuel: ['QuickFuel #2231', 'Sunrise Gas'],
  transport: ['Metro Transit', 'RideNow Trip'],
  subscription: ['StreamFlix', 'TuneBox Music', 'CloudDrive Storage'],
  retail: ['Urban Threads', 'HomeGoods Depot', 'PharmaPlus'],
  electronics: ['TechZone Electronics', 'ElectroDeals Intl'],
  gift_cards: ['GiftCardHub Online', 'eGift Express'],
  crypto: ['CryptoQuick Exchange', 'CoinFlash'],
  luxury: ['LuxeWatch Outlet', 'Diamond District Online'],
};
const CONSUMER_NORMAL = ['grocery', 'dining', 'fuel', 'transport', 'subscription', 'retail', 'electronics'];
const CONSUMER_RISKY = ['electronics', 'gift_cards', 'crypto', 'luxury'];

const BUSINESS_PAYEES = {
  supplies: ['Summit Office Supply', 'ProParts Wholesale'],
  logistics: ['Pacific Freight Logistics', 'Redline Couriers'],
  software: ['CloudHost Services', 'LedgerLite SaaS'],
  payroll: ['Northside Payroll', 'Payday Staffing Partners'],
  utilities: ['Metro Utilities', 'City Water & Power'],
  insurance: ['Brightline Insurance'],
  money_transfer: ['Global Trade Settlements Ltd', 'Apex Consulting Intl'],
  crypto: ['CoinFlash Business'],
};
const BUSINESS_NORMAL = ['supplies', 'logistics', 'software', 'payroll', 'utilities', 'insurance'];

export const TYPE_LABELS = {
  card_present: 'In-person card purchase',
  card_not_present: 'Online card purchase',
  atm_withdrawal: 'ATM withdrawal',
  p2p: 'Person-to-person transfer',
  ach: 'ACH payment',
  wire: 'Wire transfer',
};

export function generateTransaction(rng, { segment = 'consumer', fraud = false, ownerUserId = null, now = Date.now() } = {}) {
  const biz = segment === 'business';
  const avg = biz ? round2(lognormal(rng, Math.log(3000), 0.8)) : round2(lognormal(rng, Math.log(55), 0.5));
  let type, channel, category, merchant;

  if (biz) {
    type = fraud ? (chance(rng, 0.7) ? 'wire' : 'ach') : pick(rng, ['ach', 'ach', 'ach', 'wire', 'card_not_present']);
    channel = type === 'wire' && chance(rng, 0.3) ? 'branch' : 'online';
    // Half of business fraud is BEC-style: a known vendor name, but new/changed bank details.
    category = fraud && chance(rng, 0.5) ? pick(rng, ['money_transfer', 'crypto']) : pick(rng, BUSINESS_NORMAL);
    merchant = pick(rng, BUSINESS_PAYEES[category]);
  } else {
    type = fraud
      ? pick(rng, ['card_not_present', 'card_not_present', 'card_present', 'atm_withdrawal', 'p2p'])
      : pick(rng, ['card_present', 'card_present', 'card_present', 'card_not_present', 'card_not_present', 'atm_withdrawal', 'p2p']);
    channel = { card_present: 'pos', card_not_present: 'online', atm_withdrawal: 'atm', p2p: 'mobile' }[type];
    if (type === 'atm_withdrawal') {
      category = 'cash';
      merchant = pick(rng, ['ATM #4471', 'ATM - Main St Branch', 'Non-network ATM']);
    } else if (type === 'p2p') {
      category = 'money_transfer';
      merchant = pick(rng, ['QuickSend P2P', 'ZapPay Transfer', 'TopUp Wallet Services']);
    } else {
      category = fraud && chance(rng, 0.6) ? pick(rng, CONSUMER_RISKY) : pick(rng, CONSUMER_NORMAL);
      merchant = pick(rng, CONSUMER_MERCHANTS[category]);
    }
  }

  let ratio;
  if (fraud) ratio = chance(rng, 0.7) ? lognormal(rng, Math.log(5), 0.5) : lognormal(rng, 0, 0.5);
  else ratio = chance(rng, 0.05) ? lognormal(rng, Math.log(4), 0.4) : lognormal(rng, 0, 0.45);
  let amount = round2(Math.max(1, avg * ratio));
  if (biz && fraud && chance(rng, 0.5)) amount = Math.max(1000, Math.round(amount / 1000) * 1000);

  const foreign = chance(rng, fraud ? 0.45 : 0.05);
  const [city, country] = foreign ? pick(rng, FOREIGN) : [pick(rng, US_CITIES), 'US'];

  const physical = channel === 'pos' || channel === 'atm';
  let distance = 0;
  if (physical) {
    if (foreign) distance = int(rng, 2000, 9000);
    else if (fraud && chance(rng, 0.5)) distance = int(rng, 300, 2000);
    else distance = Math.round(lognormal(rng, Math.log(8), 1));
  }

  const deviceNew = !physical && chance(rng, fraud ? 0.6 : 0.06) ? 1 : 0;
  const newPayee = chance(rng, fraud ? 0.8 : biz ? 0.1 : 0.25) ? 1 : 0;
  const hour = (fraud ? chance(rng, 0.4) : chance(rng, 0.04)) ? int(rng, 0, 5) : int(rng, 7, 22);
  const velocity = fraud && chance(rng, 0.5) ? int(rng, 6, 20) : int(rng, 1, biz ? 4 : 6);
  const accountAge = (fraud ? chance(rng, 0.2) : chance(rng, 0.03)) ? int(rng, 3, 60) : int(rng, 60, 4000);

  const when = new Date(now - int(rng, 0, 6) * 86400000);
  when.setHours(hour, int(rng, 0, 59), int(rng, 0, 59), 0);

  return {
    owner_user_id: ownerUserId,
    segment,
    type,
    amount,
    avg_amount: avg,
    merchant,
    category,
    country,
    city,
    channel,
    device_new: deviceNew,
    new_payee: newPayee,
    hour,
    distance_km: distance,
    velocity_24h: velocity,
    account_age_days: accountAge,
    occurred_at: when.toISOString(),
    true_label: fraud ? 'fraud' : 'legit',
  };
}

/** Human-readable risk/context signals shown to reviewers. Same for fraud and legit — reviewers must judge. */
export function signalsFor(t) {
  const out = [];
  const ratio = t.amount / t.avg_amount;
  if (ratio >= 2) out.push({ key: 'unusual_amount', text: `${ratio.toFixed(1)}× typical amount` });
  if (t.country !== 'US') out.push({ key: 'unfamiliar_location', text: `Outside home country (${COUNTRY_NAMES[t.country]})` });
  else if (t.distance_km >= 300) out.push({ key: 'unfamiliar_location', text: `${t.distance_km.toLocaleString()} km from home` });
  if (t.device_new) out.push({ key: 'new_device', text: 'New device' });
  if (t.new_payee) out.push({ key: 'new_payee', text: t.segment === 'business' ? 'First payment to these bank details' : 'First time at this merchant' });
  if (t.hour < 6) out.push({ key: 'odd_time', text: 'Overnight activity' });
  if (t.velocity_24h >= 6) out.push({ key: 'high_velocity', text: `${t.velocity_24h} transactions in 24h` });
  if (t.account_age_days < 60) out.push({ key: 'new_account', text: `Account opened ${t.account_age_days} days ago` });
  return out;
}

export const riskSignalCount = (t) => signalsFor(t).filter((s) => s.key !== 'new_payee').length;

/** Generate until predicate holds — used for "clear-cut" gold cases and own-account items worth asking about. */
export function generateWhere(rng, opts, predicate, maxTries = 500) {
  for (let i = 0; i < maxTries; i++) {
    const t = generateTransaction(rng, opts);
    if (predicate(t)) return t;
  }
  return generateTransaction(rng, opts);
}
