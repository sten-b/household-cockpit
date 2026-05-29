'use strict';

// ── Storage helpers ───────────────────────────────────────────────────────────
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  goals: store.get('goals') || defaultGoals(),
  holidays: store.get('holidays') || defaultHolidays(),
  bunqAccounts: [],
  bunqPayments: [],
  alpacaPositions: [],
  alpacaAccount: null,
  charts: {},
};

function defaultGoals() {
  return [
    { id: 1, name: 'Emergency fund',  icon: 'ti-shield-check', target: 10000, saved: 8000, color: '#f78faa' },
    { id: 2, name: 'New car fund',    icon: 'ti-car',          target: 12000, saved: 5200, color: '#f05a84' },
    { id: 3, name: 'Home office',     icon: 'ti-device-laptop',target: 1500,  saved: 390,  color: '#fbc4d4' },
  ];
}
function defaultHolidays() {
  return [
    { id: 1, name: 'Mallorca – Summer', icon: 'ti-plane', target: 3000, saved: 1840, color: '#e7255a', date: 'Sep 2026' },
  ];
}

// ── Format helpers ────────────────────────────────────────────────────────────
const fmt = (n, d = 2) => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSign = n => (n >= 0 ? '+' : '') + fmt(n);
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// ── Connection status dots ────────────────────────────────────────────────────
function setConn(service, status) {
  // status: 'loading' | 'ok' | 'error'
  const dot = document.getElementById(service + 'Dot');
  const lbl = document.getElementById(service + 'Label');
  if (!dot) return;
  dot.className = 'dot' + (status === 'ok' ? '' : status === 'loading' ? ' amber' : ' red');
  if (lbl) lbl.style.color = status === 'ok' ? 'var(--pos)' : status === 'error' ? 'var(--neg)' : '#c97d00';
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + btn.dataset.page).classList.add('active');
    if (btn.dataset.page === 'transactions') renderTransactions();
    if (btn.dataset.page === 'investments')  renderInvestments();
  });
});

// ── Settings sheet (budget only) ──────────────────────────────────────────────
const overlay = document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click', openSettings);
overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

function openSettings() {
  const b = store.get('budgets') || {};
  document.getElementById('budgetHousing').value       = b.Housing       || 950;
  document.getElementById('budgetGroceries').value     = b.Groceries     || 300;
  document.getElementById('budgetDining').value        = b.Dining        || 200;
  document.getElementById('budgetTransport').value     = b.Transport     || 150;
  document.getElementById('budgetSubscriptions').value = b.Subscriptions || 150;
  overlay.classList.add('open');
}
function closeSettings() { overlay.classList.remove('open'); }

document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  const budgets = {
    Housing:       parseInt(document.getElementById('budgetHousing').value)       || 950,
    Groceries:     parseInt(document.getElementById('budgetGroceries').value)     || 300,
    Dining:        parseInt(document.getElementById('budgetDining').value)        || 200,
    Transport:     parseInt(document.getElementById('budgetTransport').value)     || 150,
    Subscriptions: parseInt(document.getElementById('budgetSubscriptions').value) || 150,
  };
  store.set('budgets', budgets);
  closeSettings();
  renderBudgetChart();
});

// ── Refresh button ────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.querySelector('i').style.animation = 'spin .7s linear infinite';
  await loadAllData();
  btn.querySelector('i').style.animation = '';
});

// ── Bunq proxy calls ──────────────────────────────────────────────────────────
async function bunqProxy(action, params = {}, retried = false) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`/api/bunq?${qs}`);
  const json = await res.json();
  if (!res.ok && json.expired && !retried) return bunqProxy(action, params, true);
  if (!res.ok) throw new Error(json.error || `Bunq error ${res.status}`);
  return json;
}

async function loadBunq() {
  setConn('bunq', 'loading');
  try {
    const { accounts } = await bunqProxy('accounts');
    state.bunqAccounts = accounts;

    let total = 0;
    for (const acc of accounts) {
      if (acc.balance) total += parseFloat(acc.balance.value || 0);
    }

    state.bunqPayments = [];
    for (const acc of accounts) {
      try {
        const { payments } = await bunqProxy('payments', { accountId: acc.id });
        state.bunqPayments.push(...payments);
      } catch (e) { console.warn('Payments error', acc.id, e.message); }
    }
    state.bunqPayments.sort((a, b) => new Date(b.created) - new Date(a.created));

    document.getElementById('bunqBalance').textContent = fmt(total);
    const change = calcMonthlyChange(state.bunqPayments);
    const sub = document.getElementById('bunqSub');
    sub.textContent = (change >= 0 ? '↑ ' : '↓ ') + fmt(Math.abs(change)) + ' this month';
    sub.className = 'metric-sub ' + (change >= 0 ? 'pos' : 'neg');
    setConn('bunq', 'ok');
    updateNetWorth();
    renderSpendingChart();
    renderBudgetChart();
    renderTransactions();
  } catch (err) {
    console.error('Bunq:', err.message);
    document.getElementById('bunqBalance').textContent = 'Error';
    document.getElementById('bunqSub').textContent = err.message;
    document.getElementById('bunqSub').className = 'metric-sub neg';
    setConn('bunq', 'error');
  }
}

function calcMonthlyChange(payments) {
  const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
  return payments
    .filter(p => new Date(p.created) >= start)
    .reduce((sum, p) => sum + parseFloat(p.amount?.value || 0), 0);
}

// ── Alpaca proxy calls ────────────────────────────────────────────────────────
async function loadAlpaca() {
  setConn('alpaca', 'loading');
  try {
    const { account, positions } = await fetch('/api/alpaca?action=portfolio').then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Alpaca error ${r.status}`);
      return j;
    });
    state.alpacaAccount = account;
    state.alpacaPositions = positions;

    const equity  = parseFloat(account.equity      || 0);
    const todayPL = parseFloat(account.equity      || 0) - parseFloat(account.last_equity || 0);

    document.getElementById('alpacaValue').textContent = fmt(equity);
    const sub = document.getElementById('alpacaSub');
    sub.textContent = (todayPL >= 0 ? '↑ ' : '↓ ') + fmt(Math.abs(todayPL)) + ' today';
    sub.className = 'metric-sub ' + (todayPL >= 0 ? 'pos' : 'neg');
    setConn('alpaca', 'ok');
    updateNetWorth();
    renderPortfolioChart();
  } catch (err) {
    console.error('Alpaca:', err.message);
    document.getElementById('alpacaValue').textContent = 'Error';
    document.getElementById('alpacaSub').textContent = err.message;
    document.getElementById('alpacaSub').className = 'metric-sub neg';
    setConn('alpaca', 'error');
  }
}

// ── Net worth ─────────────────────────────────────────────────────────────────
function updateNetWorth() {
  const b = parseFloat(document.getElementById('bunqBalance').textContent.replace(/[€.,\s]/g, '').replace(',', '.')) || 0;
  const a = parseFloat(document.getElementById('alpacaValue').textContent.replace(/[€.,\s]/g, '').replace(',', '.')) || 0;
  if (b || a) document.getElementById('netWorth').textContent = fmt(b + a);
}

// ── Categorise transactions ───────────────────────────────────────────────────
function categorise(p) {
  const s = (p.description || p.counterparty?.display_name || '').toLowerCase();
  if (/rent|mortgage|huur|hypotheek/.test(s))                                         return 'Housing';
  if (/mercadona|lidl|aldi|carrefour|eroski|consum|supermercado|grocery/.test(s))     return 'Groceries';
  if (/restaurant|cafe|bar|bistro|pizza|burger|sushi|tagliatella|dining/.test(s))     return 'Dining';
  if (/glovo|uber|taxi|bus|metro|tren|parking|petrol|gasolina|bp |repsol/.test(s))   return 'Transport';
  if (/netflix|spotify|apple|adobe|amazon prime|hbo|disney/.test(s))                 return 'Subscriptions';
  return 'Other';
}

// ── Spending chart ────────────────────────────────────────────────────────────
function getLast5Months() {
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (4 - i));
    return {
      label: d.toLocaleString('default', { month: 'short' }),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end:   new Date(d.getFullYear(), d.getMonth() + 1, 1),
    };
  });
}

function renderSpendingChart() {
  const months = getLast5Months();
  const cats   = { Housing: [], Groceries: [], Dining: [], Transport: [], Other: [] };

  for (const { start, end } of months) {
    const totals = { Housing: 0, Groceries: 0, Dining: 0, Transport: 0, Other: 0 };
    for (const p of state.bunqPayments) {
      const amt = parseFloat(p.amount?.value || 0);
      if (new Date(p.created) >= start && new Date(p.created) < end && amt < 0) {
        const cat = categorise(p);
        const key = cat === 'Subscriptions' ? 'Other' : (totals[cat] !== undefined ? cat : 'Other');
        totals[key] += Math.abs(amt);
      }
    }
    Object.keys(cats).forEach(k => cats[k].push(Math.round(totals[k])));
  }

  // Use sample data if no real data yet
  const hasData = state.bunqPayments.length > 0;
  const sampleData = {
    Housing:   [950, 950, 950, 950, 950],
    Groceries: [310, 280, 330, 295, 340],
    Dining:    [180, 200, 210, 195, 276],
    Transport: [120, 140, 110, 130, 105],
    Other:     [280, 310, 260, 290, 450],
  };

  const colors = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1'];
  const datasets = Object.entries(hasData ? cats : sampleData).map(([label, data], i) => ({
    label, data, backgroundColor: colors[i],
  }));

  const ctx = document.getElementById('spendChart').getContext('2d');
  if (state.charts.spend) state.charts.spend.destroy();
  state.charts.spend = new Chart(ctx, {
    type: 'bar',
    data: { labels: months.map(m => m.label), datasets },
    options: chartOpts({ stacked: true }),
  });
}

// ── Budget chart ──────────────────────────────────────────────────────────────
function renderBudgetChart() {
  const budgets = store.get('budgets') || { Housing: 950, Groceries: 300, Dining: 200, Transport: 150, Subscriptions: 150 };
  const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), 1);
  const actuals = Object.fromEntries(Object.keys(budgets).map(k => [k, 0]));

  for (const p of state.bunqPayments) {
    if (new Date(p.created) < start) continue;
    const amt = parseFloat(p.amount?.value || 0);
    if (amt >= 0) continue;
    const cat = categorise(p);
    if (actuals[cat] !== undefined) actuals[cat] += Math.abs(amt);
    else if (cat === 'Subscriptions' && actuals.Subscriptions !== undefined) actuals.Subscriptions += Math.abs(amt);
  }

  const labels      = Object.keys(budgets);
  const budgetData  = labels.map(l => budgets[l]);
  const actualData  = labels.map(l => Math.round(actuals[l]));
  const actualColors = actualData.map((v, i) => v > budgetData[i] ? '#e7255a' : '#2a7d5f');

  const ctx = document.getElementById('budgetChart').getContext('2d');
  if (state.charts.budget) state.charts.budget.destroy();
  state.charts.budget = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Budget', data: budgetData, backgroundColor: '#ece9e0', borderRadius: 3 },
        { label: 'Actual', data: actualData, backgroundColor: actualColors, borderRadius: 3 },
      ],
    },
    options: chartOpts({ horizontal: true }),
  });
}

// ── Portfolio chart ───────────────────────────────────────────────────────────
function renderInvestments() {
  if (!state.alpacaAccount) return;
  renderPortfolioChart();

  const equity    = parseFloat(state.alpacaAccount.equity      || 0);
  const lastEquity = parseFloat(state.alpacaAccount.last_equity || 0);
  const todayPL   = equity - lastEquity;
  document.getElementById('portfolioVal').textContent  = fmt(equity);
  document.getElementById('todayPL').textContent       = fmtSign(todayPL);
  document.getElementById('todayPL').className         = 'metric-val ' + (todayPL >= 0 ? 'pos' : 'neg');
  document.getElementById('todayPLSub').textContent    = lastEquity
    ? ((todayPL / lastEquity * 100).toFixed(2) + '% today') : '';
}

function renderPortfolioChart() {
  if (!state.alpacaPositions.length) return;

  const groups = {};
  for (const p of state.alpacaPositions) {
    const val   = parseFloat(p.market_value || 0);
    const group = /^V|^I/.test(p.symbol) ? 'ETFs' : 'Stocks';
    groups[group] = (groups[group] || 0) + val;
  }
  const cash = parseFloat(state.alpacaAccount?.cash || 0);
  if (cash > 0) groups['Cash'] = cash;

  const labels = Object.keys(groups);
  const colors = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1'];

  const ctx = document.getElementById('portfolioChart').getContext('2d');
  if (state.charts.portfolio) state.charts.portfolio.destroy();
  state.charts.portfolio = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: Object.values(groups).map(v => Math.round(v)), backgroundColor: colors.slice(0, labels.length), borderWidth: 0, hoverOffset: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '70%',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.label + ': ' + fmt(c.parsed) } } },
    },
  });

  const sorted = [...state.alpacaPositions].sort((a, b) => parseFloat(b.market_value) - parseFloat(a.market_value));
  document.getElementById('invRows').innerHTML = sorted.map(p => {
    const pl  = parseFloat(p.unrealized_plpc || 0) * 100;
    const cls = pl >= 0 ? 'pos' : 'neg';
    return `<div class="inv-row">
      <span class="inv-tk">${p.symbol}</span>
      <span class="inv-nm">${p.symbol}</span>
      <span class="inv-vl">${fmt(p.market_value)}</span>
      <span class="inv-ch ${cls}">${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%</span>
    </div>`;
  }).join('');
}

// ── Transactions ──────────────────────────────────────────────────────────────
function renderTransactions() {
  const el = document.getElementById('txList');
  if (!state.bunqPayments.length) {
    el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading transactions…</div>';
    return;
  }
  const catIcons  = { Housing: 'ti-home', Groceries: 'ti-shopping-cart', Dining: 'ti-tool-kitchen-2', Transport: 'ti-car', Subscriptions: 'ti-device-mobile', Other: 'ti-dots' };
  el.innerHTML = state.bunqPayments.slice(0, 40).map(p => {
    const amt   = parseFloat(p.amount?.value || 0);
    const isPos = amt > 0;
    const cat   = isPos ? 'Income' : categorise(p);
    const name  = p.counterparty?.display_name || p.description || 'Transaction';
    const icon  = isPos ? 'ti-arrow-down' : (catIcons[cat] || 'ti-dots');
    const bg    = isPos ? '#edf7f3' : '#fdeef2';
    const ic    = isPos ? '#2a7d5f' : '#e7255a';
    return `<div class="tx">
      <div class="tx-ico" style="background:${bg}"><i class="ti ${icon}" style="color:${ic}"></i></div>
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
  renderGoalList('goalsList',   state.goals);
  renderGoalList('holidayList', state.holidays);
}

function renderGoalList(id, items) {
  const el = document.getElementById(id);
  if (!items.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--t3);text-align:center;padding:20px 0">No goals yet — tap + Add</p>';
    return;
  }
  el.innerHTML = items.map(g => {
    const pct = Math.min(100, Math.round(g.saved / g.target * 100));
    return `<div>
      <div class="goal-top">
        <span class="goal-name"><i class="ti ${g.icon}"></i>${g.name}${g.date ? ' · ' + g.date : ''}</span>
        <span class="goal-amt">${fmt(g.saved)} / ${fmt(g.target)}</span>
      </div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%;background:${g.color}"></div></div>
      <div class="goal-sub">${pct}% · ${fmt(g.target - g.saved)} remaining</div>
    </div>`;
  }).join('');
}

document.getElementById('addGoalBtn').addEventListener('click',    () => promptAddGoal('goals'));
document.getElementById('addHolidayBtn').addEventListener('click', () => promptAddGoal('holidays'));

function promptAddGoal(type) {
  const name   = prompt('Goal name:');             if (!name)   return;
  const target = parseFloat(prompt('Target (€):')); if (!target) return;
  const saved  = parseFloat(prompt('Saved so far (€):') || '0');
  const goal   = { id: Date.now(), name, icon: type === 'holidays' ? 'ti-plane' : 'ti-target', target, saved: saved || 0, color: '#e7255a' };
  if (type === 'holidays') goal.date = prompt('Travel date (e.g. Aug 2026):') || '';
  state[type].push(goal);
  store.set(type, state[type]);
  renderGoals();
}

// ── AI Insights ───────────────────────────────────────────────────────────────
document.getElementById('analyzeBtn').addEventListener('click', runAI);

async function runAI() {
  const aiList = document.getElementById('aiList');
  const btn    = document.getElementById('analyzeBtn');
  aiList.innerHTML = '<div class="loading"><div class="spinner"></div>Analysing your spending…</div>';
  btn.disabled = true;

  const txSummary        = state.bunqPayments.slice(0, 50).map(p => ({
    date: p.created?.slice(0, 10),
    description: p.counterparty?.display_name || p.description,
    amount: parseFloat(p.amount?.value || 0),
  }));
  const portfolioSummary = state.alpacaPositions.map(p => ({
    symbol: p.symbol, value: parseFloat(p.market_value || 0),
    pl_pct: (parseFloat(p.unrealized_plpc || 0) * 100).toFixed(1),
  }));
  const goals = [...state.goals, ...state.holidays].map(g => ({
    name: g.name, target: g.target, saved: g.saved, pct: Math.round(g.saved / g.target * 100),
  }));

  const prompt = `You are a personal finance advisor. Analyse this household's finances and give specific, actionable insights.

Transactions (last 50): ${JSON.stringify(txSummary)}
Portfolio: ${JSON.stringify(portfolioSummary)}
Goals: ${JSON.stringify(goals)}

Respond ONLY with a JSON array of exactly 4 insight objects, no markdown:
[{"type":"warn|good|mag","title":"Short title max 8 words","body":"2-3 sentences with specific amounts."}]
Types: warn=overspending/risk, good=positive/on track, mag=info/tip`;

  try {
    const res  = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI error');

    const insights = JSON.parse(data.text.replace(/```json|```/g, '').trim());
    const iconMap  = { warn: 'ti-alert-triangle', good: 'ti-circle-check', mag: 'ti-lightbulb' };
    aiList.innerHTML = insights.map(ins => `
      <div class="ins ins-${ins.type}">
        <i class="ti ${iconMap[ins.type] || 'ti-info-circle'}"></i>
        <div class="ins-body"><div class="ins-title">${ins.title}</div>${ins.body}</div>
      </div>`).join('');

    document.getElementById('aiUpdated').style.display = 'flex';
    document.getElementById('aiUpdatedText').textContent =
      'Last analysed ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    aiList.innerHTML = `<div class="error-msg"><i class="ti ti-alert-circle"></i>${err.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ── Chart helper ──────────────────────────────────────────────────────────────
function chartOpts({ stacked = false, horizontal = false } = {}) {
  const gc = 'rgba(0,0,0,0.05)', tc = '#a0a0a0';
  const xKey = horizontal ? 'y' : 'x';
  const yKey = horizontal ? 'x' : 'y';
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ' €' + (horizontal ? c.parsed.x : c.parsed.y).toLocaleString() } },
    },
    scales: {
      [xKey]: { stacked, ticks: { color: tc, font: { size: 11 } }, grid: { color: horizontal ? gc : false }, border: { display: false } },
      [yKey]: { stacked, ticks: { color: tc, font: { size: 11 }, callback: v => '€' + v.toLocaleString() }, grid: { color: horizontal ? false : gc }, border: { display: false } },
    },
  };
}

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAllData() {
  await Promise.allSettled([loadBunq(), loadAlpaca()]);
  renderGoals();
}

// ── Init ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);

setConn('bunq',   'loading');
setConn('alpaca', 'loading');
renderGoals();
renderSpendingChart();
renderBudgetChart();
loadAllData();
