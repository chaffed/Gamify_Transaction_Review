// FraudQuest PoC front end — vanilla JS, hash routing, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const num = (n) => Number(n).toLocaleString('en-US');
const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const fmtDate = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (sqlTs) => new Date(`${sqlTs.replace(' ', 'T')}Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error ?? res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

const state = {
  me: null,
  queue: [],
  reasons: {},
  idx: 0,
  choice: null,
  picked: new Set(),
  confidence: 2,
  startedAt: 0,
  result: null,
  busy: false,
  lbPeriod: 'week',
};

// ------------------------------------------------------------------ toasts & modals

function toast(html, tone = '') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = html;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
}

const modalQueue = [];
function modal(html) {
  modalQueue.push(html);
  if (modalQueue.length === 1) showModal();
}
function showModal() {
  const html = modalQueue[0];
  if (!html) return;
  $('#modal').innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}
    <button class="btn primary" data-close>Awesome</button></div></div>`;
  $('[data-close]', $('#modal')).focus();
  $('#modal').onclick = (e) => {
    if (e.target.matches('[data-close], .modal-backdrop')) {
      $('#modal').innerHTML = '';
      modalQueue.shift();
      showModal();
    }
  };
}
const modalOpen = () => modalQueue.length > 0;

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#0f766e', '#f59e0b', '#2563eb', '#db2777', '#16a34a'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2600);
}

// ------------------------------------------------------------------ shell

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    state.me = null;
  }
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', onKey);
  render();
}

function route() {
  const r = location.hash.replace(/^#\/?/, '');
  if (state.me?.role === 'analyst') return 'admin';
  return ['review', 'rewards', 'leaderboard', 'profile'].includes(r) ? r : 'review';
}

function render() {
  if (!state.me) return renderLogin();
  const r = route();
  const nav = state.me.role === 'analyst'
    ? [['admin', 'Fraud Ops Console']]
    : [['review', 'Review'], ['rewards', 'Rewards'], ['leaderboard', 'Leaderboard'], ['profile', 'My Progress']];
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="logo">🛡️</span> FraudQuest <span class="tag">PoC</span></div>
      <nav>${nav.map(([k, label]) => `<a href="#/${k}" class="${k === r ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="hud" id="hud"></div>
    </header>
    <main id="view" class="view"></main>`;
  renderHud();
  ({ review: renderReview, rewards: renderRewards, leaderboard: renderLeaderboard, profile: renderProfile, admin: renderAdmin })[r]($('#view'));
}

function renderHud() {
  const me = state.me;
  const hud = $('#hud');
  if (!hud) return;
  const user = `<div class="user"><span>${esc(me.displayName)}</span><button class="link" id="logout">Sign out</button></div>`;
  if (me.role === 'analyst') {
    hud.innerHTML = user;
  } else {
    const lv = me.level;
    hud.innerHTML = `
      <div class="streak ${me.streak ? '' : 'cold'}" title="Daily streak">🔥 ${me.streak}</div>
      <div class="level-chip" title="${lv.nextMin ? `${num(lv.nextMin - me.lifetimePoints)} pts to ${esc(lv.nextName)}` : 'Max level'}">
        <span>Lv ${lv.level} · ${esc(lv.name)}</span>
        <div class="bar"><div style="width:${Math.round(lv.progress * 100)}%"></div></div>
      </div>
      <div class="points" id="points-pill">⭐ ${num(me.points)}</div>
      ${user}`;
  }
  $('#logout').onclick = async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    state.me = null;
    state.queue = [];
    location.hash = '';
    render();
  };
}

// ------------------------------------------------------------------ login

function renderLogin() {
  const demos = [
    ['alice', 'Alice', 'Personal · Lv 3 · 4-day streak'],
    ['bob', 'Bob', 'Personal · brand new'],
    ['acme', 'Acme Plumbing', 'Business banking'],
    ['analyst', 'Fraud Ops', 'Bank analyst console'],
  ];
  $('#app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-hero">
          <div class="logo big">🛡️</div>
          <h1>FraudQuest</h1>
          <p>Help keep our community safe. Review transactions, spot fraud, earn rewards.</p>
        </div>
        <form id="login-form">
          <label>Username <input name="username" autocomplete="username" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <p class="error" id="login-error"></p>
          <button class="btn primary wide">Sign in</button>
        </form>
        <div class="demo">
          <div class="muted small">Demo accounts (password <code>demo</code>)</div>
          <div class="demo-grid">
            ${demos.map(([u, n, d]) => `<button class="demo-btn" data-user="${u}"><strong>${n}</strong><span>${d}</span></button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  const doLogin = async (username, password) => {
    try {
      state.me = await api('/api/login', { method: 'POST', body: { username, password } });
      state.queue = [];
      state.idx = 0;
      const target = state.me.role === 'analyst' ? '#/admin' : '#/review';
      if (location.hash === target) render();
      else location.hash = target; // hashchange triggers render
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  };
  $('#login-form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    doLogin(f.get('username'), f.get('password'));
  };
  $$('.demo-btn').forEach((b) => (b.onclick = () => doLogin(b.dataset.user, 'demo')));
}

// ------------------------------------------------------------------ review

function resetCard() {
  state.choice = null;
  state.picked = new Set();
  state.confidence = 2;
  state.result = null;
  state.startedAt = 0;
}

async function renderReview(el) {
  if (state.idx >= state.queue.length) {
    el.innerHTML = '<div class="loading">Loading your queue…</div>';
    try {
      const q = await api('/api/queue');
      state.queue = q.items;
      state.reasons = q.reasons;
      state.idx = 0;
      resetCard();
    } catch (e) {
      el.innerHTML = `<div class="empty"><p class="error">${esc(e.message)}</p></div>`;
      return;
    }
  }
  if (!el.isConnected || route() !== 'review') return;
  if (!state.queue.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🎉</div>
        <h2>You're all caught up!</h2>
        <p>No transactions need your eyes right now. Check back tomorrow to keep your streak alive.</p>
        <a class="btn" href="#/rewards">Browse rewards</a>
      </div>`;
    return;
  }
  drawReview(el);
}

function drawReview(el = $('#view')) {
  const t = state.queue[state.idx];
  const me = state.me;
  const goalPct = Math.min(me.reviewsToday / me.dailyGoal, 1);
  el.innerHTML = `
    <div class="review-layout">
      <section>
        <div class="queue-progress">
          <span>Transaction ${state.idx + 1} of ${state.queue.length}</span>
          <div class="dots">${state.queue.map((_, i) => `<i class="${i < state.idx ? 'done' : i === state.idx ? 'cur' : ''}"></i>`).join('')}</div>
        </div>
        ${txnCard(t)}
        <div id="panel">${state.result ? resultPanel(state.result, t) : decisionPanel(t)}</div>
      </section>
      <aside class="side">
        <div class="card goal">
          <h3>Daily goal</h3>
          <div class="ring" style="--p:${goalPct}"><span>${Math.min(me.reviewsToday, me.dailyGoal)}/${me.dailyGoal}</span></div>
          <p class="muted small">${me.reviewsToday >= me.dailyGoal ? 'Goal complete — nice work! Keep going for more points.' : `Finish ${me.dailyGoal} reviews today for a <strong>+${me.dailyGoalBonus}</strong> bonus.`}</p>
        </div>
        <div class="card tips">
          <h3>How points work</h3>
          <ul>
            <li><b>+10</b> per review <span class="muted">(+15 business, +25 your own account)</span></li>
            <li><b>+2</b> per reason you tag on a flag</li>
            <li><b>+5</b> when the community agrees with you</li>
            <li><b>Streaks</b> up to ×1.5 · <b>Accuracy rating</b> up to ×1.5</li>
          </ul>
          <p class="muted small">Some items are training cases with known answers. They keep the game fair and raise your accuracy rating.</p>
        </div>
      </aside>
    </div>`;
  if (!state.result && !state.startedAt) state.startedAt = performance.now();
  wireReview(el, t);
}

function txnCard(t) {
  const own = t.kind === 'own';
  const d = new Date(t.occurredAt);
  return `
    <article class="txn-card ${own ? 'own' : ''}">
      <div class="txn-top">
        <span class="pill ${own ? 'pill-own' : ''}">${own ? '🔒 Your account' : '👥 Community review'}</span>
        ${t.segment === 'business' ? '<span class="pill pill-biz">Business</span>' : ''}
        <span class="muted small right">${esc(t.account)}</span>
      </div>
      <div class="txn-main">
        <div>
          <div class="merchant">${esc(t.merchant)}</div>
          <div class="muted">${esc(t.typeLabel)} · ${esc(t.location)}</div>
          <div class="muted small">${esc(fmtDate(d))}</div>
        </div>
        <div class="amount">${money(t.amount)}<div class="muted small">typical ${money(t.typicalAmount)}</div></div>
      </div>
      <div class="signals">
        ${t.signals.length ? t.signals.map((s) => `<span class="signal">⚠️ ${esc(s.text)}</span>`).join('') : '<span class="signal calm">No unusual signals</span>'}
      </div>
    </article>`;
}

function decisionPanel(t) {
  const own = t.kind === 'own';
  const opts = own
    ? [['legit', '✓', 'Yes, that was me'], ['suspicious', '?', 'Not sure'], ['fraud', '✕', "No, that wasn't me"]]
    : [['legit', '✓', 'Looks legit'], ['suspicious', '?', 'Suspicious'], ['fraud', '⚑', 'Fraud']];
  return `
    <div class="decision">
      <h2>${own ? 'Did you make this transaction?' : 'How does this transaction look to you?'}</h2>
      <div class="choices">
        ${opts.map(([k, icon, label], i) => `
          <button class="choice ${k} ${state.choice === k ? 'selected' : ''}" data-label="${k}">
            <span class="ic">${icon}</span>${label}<kbd>${i + 1}</kbd>
          </button>`).join('')}
      </div>
      ${state.choice && state.choice !== 'legit' ? `
        <div class="reasons">
          <div class="muted small">What tipped you off? <span class="hint">+2 pts each, up to 3</span></div>
          <div class="chips">${Object.entries(state.reasons).map(([k, label]) => `
            <button class="chip ${state.picked.has(k) ? 'on' : ''}" data-reason="${k}">${esc(label)}</button>`).join('')}</div>
        </div>` : ''}
      ${state.choice ? `
        <div class="submit-row">
          <div class="seg" role="radiogroup" aria-label="Confidence">
            <span class="muted small">Confidence</span>
            ${[[1, 'Low'], [2, 'Medium'], [3, 'High']].map(([v, l]) => `<button class="${state.confidence === v ? 'on' : ''}" data-conf="${v}">${l}</button>`).join('')}
          </div>
          <button class="btn primary" id="submit" ${state.busy ? 'disabled' : ''}>Submit <kbd>Enter</kbd></button>
        </div>` : '<p class="muted small center">Tip: press 1, 2 or 3 to answer, then Enter to submit.</p>'}
    </div>`;
}

function resultPanel(r, t) {
  const rows = r.breakdown.map((b) => `
    <li class="${b.bonus ? 'bonus' : ''}"><span>${esc(b.label)}</span><b>${b.multiplier ? `×${b.multiplier}` : `+${b.points}`}</b></li>`).join('');
  const notes = [];
  if (r.ownOutcome) notes.push(`<div class="note ${r.ownOutcome.tone}"><b>${esc(r.ownOutcome.title)}</b><p>${esc(r.ownOutcome.message)}</p></div>`);
  if (r.gold) {
    notes.push(r.gold.correct
      ? `<div class="note success"><b>🎓 Training case — you got it!</b><p>This was a confirmed ${r.gold.truth === 'fraud' ? 'fraud' : 'legitimate'} transaction. Your accuracy rating went up.</p></div>`
      : `<div class="note warn"><b>🎓 Training case</b><p>This one was actually ${r.gold.truth === 'fraud' ? 'confirmed fraud' : 'legitimate'}. Look closely at the signals (and the lack of them) next time.</p></div>`);
  }
  if (r.consensus) {
    notes.push(`<div class="note info"><b>👥 Community consensus reached: ${r.consensus.label === 'fraud' ? 'Fraud' : 'Legit'}</b>
      <p>${r.consensus.n} reviewers · ${pct(r.consensus.confidence)} agreement strength. ${r.consensus.agreed ? 'You called it!' : 'The crowd saw it differently this time.'} This label is now training our fraud model.</p></div>`);
  }
  if (r.tooFast) notes.push('<div class="note warn"><b>⏱ That was quick!</b><p>Reviews done in under a few seconds don’t earn points. Take a moment to check the details.</p></div>');
  return `
    <div class="result">
      <div class="result-points ${r.points ? '' : 'zero'}">+${num(r.points)}<span> pts</span></div>
      <ul class="breakdown">${rows}</ul>
      ${notes.join('')}
      <button class="btn primary wide" id="next">${state.idx + 1 < state.queue.length ? 'Next transaction' : 'Finish this batch'} <kbd>Enter</kbd></button>
    </div>`;
}

function wireReview(el, t) {
  $$('[data-label]', el).forEach((b) => (b.onclick = () => choose(b.dataset.label)));
  $$('[data-reason]', el).forEach((b) => (b.onclick = () => {
    const k = b.dataset.reason;
    state.picked.has(k) ? state.picked.delete(k) : state.picked.add(k);
    redrawPanel(t);
  }));
  $$('[data-conf]', el).forEach((b) => (b.onclick = () => { state.confidence = Number(b.dataset.conf); redrawPanel(t); }));
  $('#submit', el)?.addEventListener('click', submit);
  $('#next', el)?.addEventListener('click', next);
}

function redrawPanel(t) {
  const panel = $('#panel');
  panel.innerHTML = state.result ? resultPanel(state.result, t) : decisionPanel(t);
  wireReview(panel, t);
}

function choose(label) {
  state.choice = label;
  if (label === 'legit') state.picked.clear();
  redrawPanel(state.queue[state.idx]);
}

async function submit() {
  if (state.busy || !state.choice) return;
  const t = state.queue[state.idx];
  state.busy = true;
  try {
    const r = await api('/api/reviews', {
      method: 'POST',
      body: {
        txnId: t.id,
        label: state.choice,
        reasons: [...state.picked],
        confidence: state.confidence,
        durationMs: Math.round(performance.now() - state.startedAt),
      },
    });
    state.result = r;
    state.me = r.me;
    renderHud();
    drawReview();
    if (r.points) {
      toast(`<b>+${num(r.points)}</b> points`, 'gain');
      $('#points-pill')?.classList.add('bump');
    }
    for (const b of r.newBadges) {
      modal(`<div class="badge-big">${b.icon}</div><h2>Badge unlocked!</h2><h3>${esc(b.name)}</h3><p class="muted">${esc(b.description)}</p>`);
    }
    if (r.levelUp) {
      confetti();
      modal(`<div class="badge-big">🏆</div><h2>Level up!</h2><h3>Level ${r.levelUp.level} · ${esc(r.levelUp.name)}</h3>
        <p class="muted">New rewards may now be unlocked in the catalog.</p>`);
    }
    if (r.dailyGoal) confetti();
  } catch (e) {
    toast(esc(e.message), 'error');
    if (e.status === 409) next();
  } finally {
    state.busy = false;
  }
}

function next() {
  state.idx++;
  resetCard();
  renderReview($('#view'));
}

function onKey(e) {
  if (!state.me || route() !== 'review' || modalOpen()) return;
  if (e.target.closest?.('input, textarea')) return;
  const t = state.queue[state.idx];
  if (!t) return;
  if (state.result) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
    return;
  }
  const map = { 1: 'legit', 2: 'suspicious', 3: 'fraud' };
  if (map[e.key]) { e.preventDefault(); choose(map[e.key]); }
  else if (e.key === 'Enter' && state.choice) { e.preventDefault(); submit(); }
}

// ------------------------------------------------------------------ rewards

async function renderRewards(el) {
  el.innerHTML = '<div class="loading">Loading rewards…</div>';
  const data = await api('/api/rewards');
  if (!el.isConnected) return;
  const catLabel = { gift_card: 'Gift card', swag: 'Bank swag', charity: 'Give back', perk: 'Account perk' };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Rewards</h1><p class="muted">Redeem your points for gift cards, swag, donations and account perks.</p></div>
      <div class="balance"><span class="muted small">Available</span><b>⭐ ${num(data.balance)}</b></div>
    </div>
    <div class="reward-grid">
      ${data.items.map((r) => `
        <div class="reward ${r.locked ? 'locked' : ''}">
          <div class="reward-icon">${r.icon}</div>
          <div class="pill small">${catLabel[r.category]}</div>
          <h3>${esc(r.name)}</h3>
          <p class="muted small">${esc(r.description)}</p>
          <div class="reward-foot">
            <b>⭐ ${num(r.cost)}</b>
            ${r.locked ? `<span class="lock">🔒 ${esc(r.locked)}</span>` : `<button class="btn primary sm" data-redeem="${r.id}" data-name="${esc(r.name)}" data-cost="${r.cost}">Redeem</button>`}
          </div>
        </div>`).join('')}
    </div>
    <h2>Your redemptions</h2>
    ${data.redemptions.length ? `<table class="table">
      <thead><tr><th>Reward</th><th>Points</th><th>Details</th><th>Date</th></tr></thead>
      <tbody>${data.redemptions.map((d) => `<tr><td>${d.icon} ${esc(d.name)}</td><td>${num(d.cost)}</td><td>${esc(d.fulfillment)}</td><td>${fmtDay(d.created_at)}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="muted">Nothing redeemed yet.</p>'}`;
  $$('[data-redeem]', el).forEach((b) => (b.onclick = async () => {
    if (!confirm(`Redeem "${b.dataset.name}" for ${num(b.dataset.cost)} points?`)) return;
    try {
      const r = await api('/api/rewards/redeem', { method: 'POST', body: { rewardId: Number(b.dataset.redeem) } });
      state.me = r.me;
      renderHud();
      modal(`<div class="badge-big">🎁</div><h2>Enjoy!</h2><h3>${esc(r.reward)}</h3><p>${esc(r.fulfillment)}</p>`);
      renderRewards(el);
    } catch (e) {
      toast(esc(e.message), 'error');
    }
  }));
}

// ------------------------------------------------------------------ leaderboard

async function renderLeaderboard(el) {
  el.innerHTML = '<div class="loading">Loading…</div>';
  const lb = await api(`/api/leaderboard?period=${state.lbPeriod}`);
  if (!el.isConnected) return;
  const row = (r) => `<tr class="${r.isMe ? 'me' : ''}"><td class="rank">${['🥇', '🥈', '🥉'][r.rank - 1] ?? r.rank}</td>
    <td>${esc(r.name)}${r.isMe ? ' <span class="pill small">You</span>' : ''}</td><td class="muted">${esc(r.level)}</td><td class="num">⭐ ${num(r.points)}</td></tr>`;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Leaderboard</h1><p class="muted">Top fraud spotters. Display names only — no account details are ever shown.</p></div>
      <div class="seg">${[['week', 'This week'], ['all', 'All time']].map(([k, l]) => `<button data-period="${k}" class="${state.lbPeriod === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <table class="table lb"><thead><tr><th>#</th><th>Reviewer</th><th>Level</th><th class="num">Points</th></tr></thead>
      <tbody>${lb.top.map(row).join('')}
      ${lb.me && !lb.top.some((r) => r.isMe) ? `<tr class="gap"><td colspan="4">⋯</td></tr>${row(lb.me)}` : ''}</tbody>
    </table>`;
  $$('[data-period]', el).forEach((b) => (b.onclick = () => { state.lbPeriod = b.dataset.period; renderLeaderboard(el); }));
}

// ------------------------------------------------------------------ profile

async function renderProfile(el) {
  const [me, act] = await Promise.all([api('/api/me'), api('/api/activity')]);
  if (!el.isConnected) return;
  state.me = me;
  renderHud();
  const lv = me.level;
  const reasonLabel = { review: 'Review', daily_goal: 'Daily goal bonus', consensus_bonus: 'Community agreed with you', redemption: 'Redeemed reward', opening_balance: 'Welcome balance' };
  el.innerHTML = `
    <div class="page-head"><div><h1>My progress</h1><p class="muted">${esc(me.displayName)} · ${me.segment === 'business' ? 'Business' : 'Personal'} banking</p></div></div>
    <div class="profile-grid">
      <div class="card level-card">
        <div class="lv-num">${lv.level}</div>
        <div class="lv-body">
          <h2>${esc(lv.name)}</h2>
          <div class="bar big"><div style="width:${Math.round(lv.progress * 100)}%"></div></div>
          <p class="muted small">${lv.nextMin ? `${num(me.lifetimePoints)} / ${num(lv.nextMin)} lifetime points — ${num(lv.nextMin - me.lifetimePoints)} to <b>${esc(lv.nextName)}</b>` : 'Max level reached!'}</p>
        </div>
      </div>
      <div class="stats">
        ${stat('Reviews', num(me.totalReviews))}
        ${stat('Day streak', `🔥 ${me.streak}`)}
        ${stat('Accuracy rating', pct(me.trust), 'Earned on training cases; multiplies your points and weights your votes')}
        ${stat('Training cases', me.goldSeen ? `${me.goldCorrect}/${me.goldSeen}` : '—')}
      </div>
    </div>
    <h2>Badges</h2>
    <div class="badges">${me.badges.map((b) => `
      <div class="badge ${b.earned ? '' : 'locked'}" title="${esc(b.description)}">
        <div class="b-icon">${b.earned ? b.icon : '🔒'}</div><b>${esc(b.name)}</b><span class="muted small">${esc(b.description)}</span>
      </div>`).join('')}</div>
    <h2>Recent activity</h2>
    <table class="table"><tbody>${act.map((a) => `<tr><td>${fmtDay(a.created_at)}</td><td>${esc(reasonLabel[a.reason] ?? a.reason)}</td>
      <td class="num ${a.delta < 0 ? 'neg' : 'pos'}">${a.delta > 0 ? '+' : ''}${num(a.delta)}</td></tr>`).join('')}</tbody></table>`;
}

const stat = (label, value, hint = '') => `<div class="card stat" title="${esc(hint)}"><span class="muted small">${label}</span><b>${value}</b></div>`;

// ------------------------------------------------------------------ analyst console

async function renderAdmin(el) {
  el.innerHTML = '<div class="loading">Loading console…</div>';
  const s = await api('/api/admin/stats');
  if (!el.isConnected) return;
  const t = s.totals;
  const m = s.models[0]?.metrics;
  const mix = Object.fromEntries(s.labelMix.map((x) => [x.label, x.n]));
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const maxW = Math.max(...s.topFactors.map((f) => Math.abs(f.weight)), 0.01);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Fraud Ops Console</h1><p class="muted">Crowd label pipeline, reviewer quality and model training.</p></div>
      <div class="actions">
        <a class="btn" href="/api/admin/export?format=csv">⬇ Export CSV</a>
        <a class="btn" href="/api/admin/export?format=jsonl">⬇ Export JSONL</a>
        <button class="btn primary" id="retrain">↻ Retrain model${s.labeledSinceTrain ? ` (+${s.labeledSinceTrain} new labels)` : ''}</button>
      </div>
    </div>
    <div class="kpis">
      ${stat('Scored reviews', num(t.reviews))}
      ${stat('Rejected (too fast)', num(t.tooFast))}
      ${stat('Labels produced', num(t.resolved))}
      ${stat('Crowd label accuracy', pct(s.crowdAccuracy), 'Consensus label vs. simulated confirmed outcome')}
      ${stat('Own-account confirmations', `${num(s.ownAccount.n)} <small class="muted">(${s.ownAccount.fraud} fraud, ${s.ownAccount.escalated} escalated)</small>`)}
      ${stat('Points issued / redeemed', `${num(t.pointsIssued)} / ${num(t.pointsRedeemed)}`)}
    </div>
    <div class="admin-grid">
      <div class="card">
        <h3>Current model · v${s.models[0]?.id ?? '–'}</h3>
        ${m ? `<div class="metrics">
          ${metric('ROC AUC', m.auc?.toFixed(3))}${metric('Precision @0.5', pct(m.precision))}${metric('Recall @0.5', pct(m.recall))}${metric('Training labels', num(m.nTrain))}
        </div>
        <p class="muted small">Evaluated on ${num(m.n)} transactions the crowd has <em>not</em> labeled, against simulated confirmed outcomes (chargebacks / disputes).</p>` : ''}
        <h4>Top learned risk factors</h4>
        <div class="factors">${s.topFactors.map((f) => `
          <div class="factor"><span>${esc(f.name)}</span>
            <div class="fbar"><div class="${f.weight < 0 ? 'neg' : ''}" style="width:${Math.abs(f.weight) / maxW * 100}%"></div></div>
            <code>${f.weight >= 0 ? '+' : ''}${f.weight.toFixed(2)}</code></div>`).join('')}</div>
      </div>
      <div class="card">
        <h3>Model history</h3>
        <table class="table compact"><thead><tr><th>Ver</th><th>Trained</th><th class="num">Labels</th><th class="num">AUC</th><th class="num">Prec</th><th class="num">Recall</th></tr></thead>
          <tbody>${s.models.map((v) => `<tr><td>v${v.id}</td><td>${fmtDay(v.createdAt)} ${new Date(`${v.createdAt.replace(' ', 'T')}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</td>
            <td class="num">${num(v.nTrain)}</td><td class="num">${v.metrics.auc?.toFixed(3) ?? '—'}</td><td class="num">${pct(v.metrics.precision)}</td><td class="num">${pct(v.metrics.recall)}</td></tr>`).join('')}</tbody></table>
        <h3>Reviewer label mix</h3>
        <div class="stack">${['legit', 'suspicious', 'fraud'].map((k) => `<div class="${k}" style="width:${(mix[k] ?? 0) / mixTotal * 100}%" title="${k}: ${mix[k] ?? 0}"></div>`).join('')}</div>
        <div class="legend"><span class="legit">Legit ${num(mix.legit ?? 0)}</span><span class="suspicious">Suspicious ${num(mix.suspicious ?? 0)}</span><span class="fraud">Fraud ${num(mix.fraud ?? 0)}</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Reviewer quality</h3>
      <p class="muted small">Accuracy rating is learned from hidden training cases and weights each reviewer's vote in consensus. Low-rated reviewers earn fewer points and barely move labels.</p>
      <table class="table compact"><thead><tr><th>Reviewer</th><th>Type</th><th class="num">Reviews</th><th class="num">Too fast</th><th class="num">Training cases</th><th>Accuracy rating</th></tr></thead>
        <tbody>${s.reviewers.map((r) => `<tr class="${r.trust < 0.3 ? 'flag' : ''}"><td>${esc(r.name)}${r.trust < 0.3 ? ' <span class="pill small warn">Low quality</span>' : ''}</td>
          <td class="muted">${r.is_bot ? 'Simulated' : r.segment}</td><td class="num">${num(r.reviews)}</td><td class="num">${num(r.too_fast)}</td>
          <td class="num">${r.gold_seen ? `${r.gold_correct}/${r.gold_seen}` : '—'}</td>
          <td><div class="trust"><div class="bar"><div style="width:${r.trust * 100}%"></div></div><span>${pct(r.trust)}</span></div></td></tr>`).join('')}</tbody></table>
    </div>`;

  $('#retrain', el).onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Training…';
    try {
      const r = await api('/api/admin/retrain', { method: 'POST', body: {} });
      toast(`Model v${r.version} trained · AUC ${r.metrics.auc?.toFixed(3)}`, 'gain');
      renderAdmin(el);
    } catch (err) {
      toast(esc(err.message), 'error');
      e.target.disabled = false;
    }
  };
}

const metric = (l, v) => `<div class="metric"><b>${v ?? '—'}</b><span class="muted small">${l}</span></div>`;

boot();
