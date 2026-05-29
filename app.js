'use strict';

// ── Storage helpers ──────────────────────────────────────────────────────────
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k)
};

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  bunqKey: store.get('bunqKey') || '',
  alpacaKey: store.get('alpacaKey') || '',
  alpacaSecret: store.get('alpacaSecret') || '',
  anthropicKey: store.get('anthropicKey') || '',
  goals: store.get('goals') || defaultGoals(),
  holidays: store.get('holidays') || defaultHolidays(),
  bunqAccounts: [],
  bunqPayments: [],
  alpacaPositions: [],
  alpacaAccount: null,
  charts: {},
  txOffset: 0
};

function defaultGoals() {
  return [
    { id: 1, name: 'Emergency fund', icon: 'ti-shield-check', target: 10000, saved: 8000, color: '#f78faa' },
    { id: 2, name: 'New car fund', icon: 'ti-car', target: 12000, saved: 5200, color: '#f05a84' },
    { id: 3, name: 'Home office', icon: 'ti-device-laptop', target: 1500, saved: 390, color: '#fbc4d4' }
  ];
}

function defaultHolidays() {
  return [
    { id: 1, name: 'Mallorca – Summer', icon: 'ti-plane', target: 3000, saved: 1840, color: '#e7255a', date: 'Sep 2026' }
  ];
}

// ── Navigation ───────────────────────────────────────────────────────────────
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    navItems.forEach(b => b.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');
    if (page === 'transactions') renderTransactions();
    if (page === 'investments') renderInvestments();
  });
});

// ── Settings sheet ───────────────────────────────────────────────────────────
const overlay = document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click', openSettings);
overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

function openSettings() {
  document.getElementById('bunqKeyInput').value = state.bunqKey;
  document.getElementById('alpacaKeyInput').value = state.alpacaKey;
  document.getElementById('alpacaSecretInput').value = state.alpacaSecret;
  document.getElementById('anthropicKeyInput').value = state.anthropicKey;
  updateSettingsStatus();
  overlay.classList.add('open');
}

function closeSettings() { overlay.classList.remove('open'); }

function updateSettingsStatus() {
  const bs = document.getElementById('bunqStatus');
  const as = document.getElementById('alpacaStatus');
  if (state.bunqKey) {
    bs.className = 'conn-status ok';
    bs.innerHTML = '<i class="ti ti-circle-check"></i>Connected';
  } else {
    bs.className = 'conn-status pending';
    bs.innerHTML = '<i class="ti ti-circle-dashed"></i>Not connected';
  }
  if (state.alpacaKey && state.alpacaSecret) {
    as.className = 'conn-status ok';
    as.innerHTML = '<i class="ti ti-circle-check"></i>Connected';
  } else {
    as.className = 'conn-status pending';
    as.innerHTML = '<i class="ti ti-circle-dashed"></i>Not connected';
  }
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  state.bunqKey = document.getElementById('bunqKeyInput').value.trim();
  state.alpacaKey = document.getElementById('alpacaKeyInput').value.trim();
  state.alpacaSecret = document.getElementById('alpacaSecretInput').value.trim();
  state.anthropicKey = document.getElementById('anthropicKeyInput').value.trim();
  store.set('bunqKey', state.bunqKey);
  store.set('alpacaKey', state.alpacaKey);
  store.set('alpacaSecret', state.alpacaSecret);
  store.set('anthropicKey', state.anthropicKey);
  updateSettingsStatus();
  closeSettings();
  await loadAllData();
});

// ── Refresh ──────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.style.animation = 'spin .7s linear infinite';
  await loadAllData();
  btn.style.animation = '';
});

// ── Connection dots ──────────────────────────────────────────────────────────
function setConnDot(id, labelId, status) {
  const dot = document.getElementById(id);
  const lbl = document.getElementById(labelId);
  dot.className = 'dot ' + (status === 'ok' ? '' : status === 'amber' ? 'amber' : 'red');
  lbl.style.color = status === 'ok' ? 'var(--pos)' : status === 'amber' ? '#c97d00' : 'var(--t3)';
}

// ── Format helpers ───────────────────────────────────────────────────────────
const fmt = (n, decimals = 2) => '€' + Number(n).toLocaleString('en-EU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const fmtSign = n => (n >= 0 ? '+' : '') + fmt(n);
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// ── Bunq API ─────────────────────────────────────────────────────────────────
// Bunq requires a registered device and session. We implement a direct REST flow.
const BUNQ_BASE = 'https://api.bunq.com';

async function bunqRequest(method, endpoint, body = null, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'HouseholdCockpit/1.0' };
  if (sessionToken) headers['X-Bunq-Client-Authentication'] = sessionToken;
  else if (state.bunqKey) headers['X-Bunq-Client-Authentication'] = state.bunqKey;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BUNQ_BASE + endpoint, opts);
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.Error?.[0]?.error_description || `Bunq ${res.status}`); }
  return res.json();
}

async function loadBunq() {
  if (!state.bunqKey) { setConnDot('bunqDot', 'bunqLabel', 'red'); return; }
  try {
    // 1. Installation (get server public key)
    let installToken;
    try {
      const inst = await bunqRequest('POST', '/v1/installation', { client_public_key: 'placeholder' });
      installToken = inst.Response?.find(r => r.Token)?.Token?.token;
    } catch (e) {
      // Installation may already exist, continue
    }

    // 2. Device registration
    try {
      await bunqRequest('POST', '/v1/device-server', {
        description: 'Household Cockpit',
        secret: state.bunqKey,
        permitted_ips: ['*']
      });
    } catch (e) { /* device may already be registered */ }

    // 3. Session
    const sessRes = await bunqRequest('POST', '/v1/session-server', { secret: state.bunqKey });
    const sessToken = sessRes.Response?.find(r => r.Token)?.Token?.token;
    const userId = sessRes.Response?.find(r => r.UserPerson || r.UserCompany);
    const uid = userId?.UserPerson?.id || userId?.UserCompany?.id;

    if (!sessToken || !uid) throw new Error('Could not establish session');

    // 4. Accounts
    const accsRes = await bunqRequest('GET', `/v1/user/${uid}/monetary-account`, null, sessToken);
    const accounts = accsRes.Response?.map(r => r.MonetaryAccountBank || r.MonetaryAccount).filter(Boolean) || [];
    state.bunqAccounts = accounts;

    // 5. Total balance
    let total = 0;
    for (const acc of accounts) {
      if (acc.balance) total += parseFloat(acc.balance.value || 0);
    }

    // 6. Payments (transactions) from first account
    if (accounts.length > 0) {
      const pmtsRes = await bunqRequest('GET', `/v1/user/${uid}/monetary-account/${accounts[0].id}/payment?count=50`, null, sessToken);
      state.bunqPayments = pmtsRes.Response?.map(r => r.Payment).filter(Boolean) || [];
    }

    // Update UI
    document.getElementById('bunqBalance').textContent = fmt(total);
    const monthlyChange = calcMonthlyChange(state.bunqPayments);
    const sub = document.getElementById('bunqSub');
    sub.textContent = (monthlyChange >= 0 ? '↑ ' : '↓ ') + fmt(Math.abs(monthlyChange)) + ' this month';
    sub.className = 'metric-sub ' + (monthlyChange >= 0 ? 'pos' : 'neg');
    setConnDot('bunqDot', 'bunqLabel', 'ok');
    updateNetWorth();
    renderSpendingChart();
    renderBudgetChart();
  } catch (err) {
    console.error('Bunq error:', err);
    document.getElementById('bunqBalance').textContent = 'Error';
    document.getElementById('bunqSub').textContent = err.message;
    document.getElementById('bunqSub').className = 'metric-sub neg';
    setConnDot('bunqDot', 'bunqLabel', 'red');
  }
}

function calcMonthlyChange(payments) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let net = 0;
  for (const p of payments) {
    const d = new Date(p.created);
    if (d >= startOfMonth) net += parseFloat(p.amount?.value || 0);
  }
  return net;
}

// ── Alpaca API ────────────────────────────────────────────────────────────────
const ALPACA_BASE = 'https://paper-api.alpaca.markets';

async function alpacaRequest(endpoint) {
  const res = await fetch(ALPACA_BASE + endpoint, {
    headers: {
      'APCA-API-KEY-ID': state.alpacaKey,
      'APCA-API-SECRET-KEY': state.alpacaSecret
    }
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.message || `Alpaca ${res.status}`); }
  return res.json();
}

async function loadAlpaca() {
  if (!state.alpacaKey || !state.alpacaSecret) { setConnDot('alpacaDot', 'alpacaLabel', 'amber'); return; }
  try {
    const [account, positions] = await Promise.all([
      alpacaRequest('/v2/account'),
      alpacaRequest('/v2/positions')
    ]);
    state.alpacaAccount = account;
    state.alpacaPositions = positions;

    const equity = parseFloat(account.equity || 0);
    const todayPL = parseFloat(account.equity || 0) - parseFloat(account.last_equity || 0);
    const pct = account.last_equity ? (todayPL / parseFloat(account.last_equity) * 100) : 0;

    document.getElementById('alpacaValue').textContent = fmt(equity);
    const sub = document.getElementById('alpacaSub');
    sub.textContent = (todayPL >= 0 ? '↑ ' : '↓ ') + fmt(Math.abs(todayPL)) + ' today';
    sub.className = 'metric-sub ' + (todayPL >= 0 ? 'pos' : 'neg');
    setConnDot('alpacaDot', 'alpacaLabel', 'ok');
    updateNetWorth();
    renderPortfolioChart();
  } catch (err) {
    console.error('Alpaca error:', err);
    document.getElementById('alpacaValue').textContent = 'Error';
    document.getElementById('alpacaSub').textContent = err.message;
    document.getElementById('alpacaSub').className = 'metric-sub neg';
    setConnDot('alpacaDot', 'alpacaLabel', 'red');
  }
}

// ── Net worth ─────────────────────────────────────────────────────────────────
function updateNetWorth() {
  const bunqRaw = document.getElementById('bunqBalance').textContent.replace(/[€,]/g, '');
  const alpacaRaw = document.getElementById('alpacaValue').textContent.replace(/[€,]/g, '');
  const bunqVal = parseFloat(bunqRaw) || 0;
  const alpacaVal = parseFloat(alpacaRaw) || 0;
  if (bunqVal || alpacaVal) {
    document.getElementById('netWorth').textContent = fmt(bunqVal + alpacaVal);
  }
}

// ── Spending chart ────────────────────────────────────────────────────────────
function categorise(payment) {
  const desc = (payment.description || payment.counterparty_alias?.display_name || '').toLowerCase();
  if (/rent|mortgage|huur|hypotheek/.test(desc)) return 'Housing';
  if (/mercadona|supermercado|lidl|aldi|carrefour|eroski|grocery|groceries/.test(desc)) return 'Groceries';
  if (/restaurant|cafe|bar|bistro|pizz|burger|sushi|tagliatella|dining/.test(desc)) return 'Dining';
  if (/glovo|uber|taxi|bus|metro|tren|parking|petrol|gasolina|transport/.test(desc)) return 'Transport';
  return 'Other';
}

function renderSpendingChart() {
  const months = getLast5Months();
  const cats = { Housing: [], Groceries: [], Dining: [], Transport: [], Other: [] };

  for (const { start, end } of months) {
    const totals = { Housing: 0, Groceries: 0, Dining: 0, Transport: 0, Other: 0 };
    for (const p of state.bunqPayments) {
      const d = new Date(p.created);
      const amt = parseFloat(p.amount?.value || 0);
      if (d >= start && d < end && amt < 0) {
        const cat = categorise(p);
        totals[cat] += Math.abs(amt);
      }
    }
    for (const cat of Object.keys(cats)) cats[cat].push(Math.round(totals[cat]));
  }

  const labels = months.map(m => m.label);
  const colors = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1'];
  const datasets = Object.entries(cats).map(([label, data], i) => ({
    label, data, backgroundColor: colors[i]
  }));

  const ctx = document.getElementById('spendChart').getContext('2d');
  if (state.charts.spend) state.charts.spend.destroy();
  state.charts.spend = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: chartOpts({ stacked: true, prefix: '€' })
  });
}

function renderBudgetChart() {
  // Build actuals from current month payments
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const actuals = { Housing: 0, Groceries: 0, Dining: 0, Transport: 0, Subscriptions: 0 };
  for (const p of state.bunqPayments) {
    const d = new Date(p.created);
    const amt = parseFloat(p.amount?.value || 0);
    if (d >= start && amt < 0) {
      const cat = categorise(p);
      if (cat === 'Other') {
        const desc = (p.description || '').toLowerCase();
        if (/netflix|spotify|apple|adobe|subscription/.test(desc)) actuals.Subscriptions += Math.abs(amt);
      } else { actuals[cat] += Math.abs(amt); }
    }
  }

  const budgets = store.get('budgets') || { Housing: 950, Groceries: 300, Dining: 200, Transport: 150, Subscriptions: 150 };
  const labels = Object.keys(budgets);
  const budgetData = labels.map(l => budgets[l]);
  const actualData = labels.map(l => Math.round(actuals[l]));
  const actualColors = actualData.map((v, i) => v > budgetData[i] ? '#e7255a' : '#2a7d5f');

  const ctx = document.getElementById('budgetChart').getContext('2d');
  if (state.charts.budget) state.charts.budget.destroy();
  state.charts.budget = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Budget', data: budgetData, backgroundColor: '#ece9e0', borderRadius: 3 },
        { label: 'Actual', data: actualData, backgroundColor: actualColors, borderRadius: 3 }
      ]
    },
    options: chartOpts({ horizontal: true, prefix: '€' })
  });
}

// ── Portfolio chart ───────────────────────────────────────────────────────────
function renderPortfolioChart() {
  if (!state.alpacaPositions.length) return;

  // Group positions by sector/type (simplified)
  const groups = {};
  for (const pos of state.alpacaPositions) {
    const val = parseFloat(pos.market_value || 0);
    const sym = pos.symbol;
    // Simple grouping by first letter for demo; real app would use asset class
    const group = sym.startsWith('V') || sym.startsWith('I') ? 'ETFs'
      : sym.endsWith('USD') ? 'Crypto'
      : 'Stocks';
    groups[group] = (groups[group] || 0) + val;
  }
  const cash = parseFloat(state.alpacaAccount?.cash || 0);
  if (cash > 0) groups['Cash'] = cash;

  const labels = Object.keys(groups);
  const data = Object.values(groups).map(v => Math.round(v));
  const colors = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1'];

  const ctx = document.getElementById('portfolioChart').getContext('2d');
  if (state.charts.portfolio) state.charts.portfolio.destroy();
  state.charts.portfolio = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 0, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '70%',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.label + ': €' + c.parsed.toLocaleString() } } }
    }
  });

  // Positions table
  const container = document.getElementById('invRows');
  const sorted = [...state.alpacaPositions].sort((a, b) => parseFloat(b.market_value) - parseFloat(a.market_value));
  container.innerHTML = sorted.map(p => {
    const pl = parseFloat(p.unrealized_plpc || 0) * 100;
    const cls = pl >= 0 ? 'pos' : 'neg';
    return `<div class="inv-row">
      <span class="inv-tk">${p.symbol}</span>
      <span class="inv-nm">${p.symbol}</span>
      <span class="inv-vl">${fmt(p.market_value)}</span>
      <span class="inv-ch ${cls}">${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%</span>
    </div>`;
  }).join('');

  // Investment metrics
  const equity = parseFloat(state.alpacaAccount?.equity || 0);
  const lastEquity = parseFloat(state.alpacaAccount?.last_equity || 0);
  const todayPL = equity - lastEquity;
  document.getElementById('portfolioVal').textContent = fmt(equity);
  document.getElementById('todayPL').textContent = fmtSign(todayPL);
  document.getElementById('todayPL').className = 'metric-val ' + (todayPL >= 0 ? 'pos' : 'neg');
  document.getElementById('todayPLSub').textContent = lastEquity ? ((todayPL / lastEquity * 100).toFixed(2) + '% today') : '';
}

// ── Transactions ──────────────────────────────────────────────────────────────
function renderTransactions() {
  const container = document.getElementById('txList');
  if (!state.bunqKey) {
    container.innerHTML = '<div class="error-msg"><i class="ti ti-plug"></i>Connect Bunq in Settings to see transactions</div>';
    return;
  }
  if (!state.bunqPayments.length) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';
    return;
  }

  const catIcons = { Housing: 'ti-home', Groceries: 'ti-shopping-cart', Dining: 'ti-tool-kitchen-2', Transport: 'ti-car', Other: 'ti-dots' };
  const catColors = { Housing: '#fdeef2', Groceries: '#fdeef2', Dining: '#fdeef2', Transport: '#fdeef2', Other: '#f2f1ed' };
  const catIconColors = { Housing: '#e7255a', Groceries: '#e7255a', Dining: '#e7255a', Transport: '#e7255a', Other: '#9e9e9e' };

  container.innerHTML = state.bunqPayments.slice(0, 30).map(p => {
    const amt = parseFloat(p.amount?.value || 0);
    const isPos = amt > 0;
    const cat = isPos ? 'Income' : categorise(p);
    const name = p.counterparty_alias?.display_name || p.description || 'Transaction';
    const icon = isPos ? 'ti-arrow-down' : (catIcons[cat] || 'ti-dots');
    const bg = isPos ? '#edf7f3' : (catColors[cat] || '#f2f1ed');
    const iconColor = isPos ? '#2a7d5f' : (catIconColors[cat] || '#9e9e9e');
    return `<div class="tx">
      <div class="tx-ico" style="background:${bg}"><i class="ti ${icon}" style="color:${iconColor}"></i></div>
      <div class="tx-info">
        <div class="tx-name">${name}</div>
        <div class="tx-cat">${cat} · ${fmtDate(p.created)}</div>
      </div>
      <div class="tx-amt ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : '−'}${fmt(Math.abs(amt))}</div>
    </div>`;
  }).join('');
}

// ── Goals ─────────────────────────────────────────────────────────────────────
function renderGoals() {
  renderGoalList('goalsList', state.goals);
  renderGoalList('holidayList', state.holidays);
}

function renderGoalList(containerId, items) {
  const el = document.getElementById(containerId);
  if (!items.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:20px 0">No goals yet — tap + Add to create one</p>';
    return;
  }
  el.innerHTML = items.map(g => {
    const pct = Math.min(100, Math.round(g.saved / g.target * 100));
    const remaining = g.target - g.saved;
    const monthlyNeeded = (remaining / 3).toFixed(0);
    return `<div>
      <div class="goal-top">
        <span class="goal-name"><i class="ti ${g.icon}"></i>${g.name}${g.date ? ' · ' + g.date : ''}</span>
        <span class="goal-amt">${fmt(g.saved)} / ${fmt(g.target)}</span>
      </div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%;background:${g.color}"></div></div>
      <div class="goal-sub">${pct}% · ${fmt(remaining)} remaining</div>
    </div>`;
  }).join('');
}

document.getElementById('addGoalBtn').addEventListener('click', () => promptAddGoal('goals'));
document.getElementById('addHolidayBtn').addEventListener('click', () => promptAddGoal('holidays'));

function promptAddGoal(type) {
  const name = prompt('Goal name:');
  if (!name) return;
  const target = parseFloat(prompt('Target amount (€):'));
  if (!target) return;
  const saved = parseFloat(prompt('Amount already saved (€):') || '0');
  const newGoal = {
    id: Date.now(), name, icon: type === 'holidays' ? 'ti-plane' : 'ti-target',
    target, saved: saved || 0, color: '#e7255a',
    ...(type === 'holidays' ? { date: prompt('Travel date (e.g. Aug 2026):') || '' } : {})
  };
  state[type].push(newGoal);
  store.set(type, state[type]);
  renderGoals();
}

// ── AI Insights ───────────────────────────────────────────────────────────────
document.getElementById('analyzeBtn').addEventListener('click', runAIAnalysis);

async function runAIAnalysis() {
  if (!state.anthropicKey) {
    document.getElementById('aiList').innerHTML = '<div class="error-msg"><i class="ti ti-key"></i>Add your Anthropic API key in Settings to enable AI insights</div>';
    return;
  }

  document.getElementById('aiList').innerHTML = '<div class="loading"><div class="spinner"></div>Analysing your spending…</div>';
  document.getElementById('analyzeBtn').disabled = true;

  try {
    const txSummary = state.bunqPayments.slice(0, 50).map(p => ({
      date: p.created?.slice(0, 10),
      description: p.counterparty_alias?.display_name || p.description,
      amount: parseFloat(p.amount?.value || 0)
    }));

    const portfolioSummary = state.alpacaPositions.map(p => ({
      symbol: p.symbol,
      value: parseFloat(p.market_value || 0),
      pl_pct: (parseFloat(p.unrealized_plpc || 0) * 100).toFixed(1)
    }));

    const goals = [...state.goals, ...state.holidays].map(g => ({
      name: g.name, target: g.target, saved: g.saved, pct: Math.round(g.saved / g.target * 100)
    }));

    const prompt = `You are a personal finance advisor analysing a household's finances. Be specific, helpful, and concise.

Recent transactions (last 50):
${JSON.stringify(txSummary, null, 2)}

Investment portfolio:
${JSON.stringify(portfolioSummary, null, 2)}

Savings goals:
${JSON.stringify(goals, null, 2)}

Provide exactly 4 insights in this JSON format (respond ONLY with valid JSON, no markdown):
[
  { "type": "warn|good|mag", "title": "Short title (max 8 words)", "body": "2-3 sentence insight with specific amounts and actionable advice." },
  ...
]

Types: "warn" = overspending/risk (amber), "good" = positive/on track (green), "mag" = info/tip (magenta).`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '[]';
    const insights = JSON.parse(text.replace(/```json|```/g, '').trim());

    const iconMap = { warn: 'ti-alert-triangle', good: 'ti-circle-check', mag: 'ti-lightbulb' };
    document.getElementById('aiList').innerHTML = insights.map(ins => `
      <div class="ins ins-${ins.type}">
        <i class="ti ${iconMap[ins.type] || 'ti-info-circle'}"></i>
        <div class="ins-body"><div class="ins-title">${ins.title}</div>${ins.body}</div>
      </div>`).join('');

    const now = new Date();
    document.getElementById('aiUpdated').style.display = 'flex';
    document.getElementById('aiUpdatedText').textContent = 'Last analysed ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    console.error('AI error:', err);
    document.getElementById('aiList').innerHTML = `<div class="error-msg"><i class="ti ti-alert-circle"></i>${err.message}</div>`;
  } finally {
    document.getElementById('analyzeBtn').disabled = false;
  }
}

// ── Chart helper ──────────────────────────────────────────────────────────────
function chartOpts({ stacked = false, horizontal = false, prefix = '' } = {}) {
  const gc = 'rgba(0,0,0,0.05)', tc = '#a0a0a0';
  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + prefix + (horizontal ? c.parsed.x : c.parsed.y).toLocaleString() } } },
    scales: {}
  };
  const xKey = horizontal ? 'y' : 'x';
  const yKey = horizontal ? 'x' : 'y';
  opts.scales[xKey] = { stacked, ticks: { color: tc, font: { size: 11 } }, grid: { display: horizontal }, border: { display: false } };
  if (horizontal) opts.scales[xKey].grid = { color: gc };
  opts.scales[yKey] = { stacked, ticks: { color: tc, font: { size: 11 }, callback: v => prefix + v.toLocaleString() }, grid: { color: horizontal ? false : gc }, border: { display: false } };
  if (horizontal) { opts.scales[xKey].grid = { color: gc }; opts.scales[yKey].grid = { display: false }; }
  return opts;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function getLast5Months() {
  const months = [];
  const now = new Date();
  for (let i = 4; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleString('default', { month: 'short' }),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 1)
    });
  }
  return months;
}

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAllData() {
  await Promise.allSettled([loadBunq(), loadAlpaca()]);
  renderGoals();
}

// ── Init ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.warn);
}

// Pre-fill settings status if keys exist
if (state.bunqKey) setConnDot('bunqDot', 'bunqLabel', 'amber');
if (state.alpacaKey) setConnDot('alpacaDot', 'alpacaLabel', 'amber');

// Render goals immediately (they're local)
renderGoals();

// Render fallback charts with sample data until real data loads
renderSpendingChart();
renderBudgetChart();

// Load live data if keys present
if (state.bunqKey || state.alpacaKey) loadAllData();
