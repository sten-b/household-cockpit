'use strict';

// ── Storage ───────────────────────────────────────────────────────────────────
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  accounts: [],   // all Bunq accounts
  payments: {},   // { accountId: [...payments] }
  alpacaAccount: null,
  alpacaPositions: [],
  goals: store.get('goals') || [],
  holidays: store.get('holidays') || [],
  charts: {},
  mapping: store.get('mapping') || { flii: 'Flii Media', holding: 'SB Holding', savings: '' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n, d = 2) => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtK = n => Math.abs(n) >= 1000 ? '€' + (n / 1000).toFixed(1) + 'k' : fmt(n, 0);
const fmtSign = n => (n >= 0 ? '+' : '') + fmt(n);
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const gc = 'rgba(0,0,0,0.05)', tc = '#a0a0a0';
const COLORS = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1', '#a8a8a0'];

// ── Account lookup ────────────────────────────────────────────────────────────
function accountsByName(...names) {
  const lower = names.map(n => n.toLowerCase().trim());
  return state.accounts.filter(a => lower.some(n => a.description?.toLowerCase().includes(n)));
}

function personalAccounts() {
  const biz = [state.mapping.flii, state.mapping.holding].map(n => n.toLowerCase().trim()).filter(Boolean);
  return state.accounts.filter(a => !biz.some(n => a.description?.toLowerCase().includes(n)));
}

function savingsAccounts() {
  const names = state.mapping.savings.split(',').map(n => n.toLowerCase().trim()).filter(Boolean);
  if (!names.length) return [];
  return state.accounts.filter(a => names.some(n => a.description?.toLowerCase().includes(n)));
}

function paymentsFor(accounts) {
  return accounts.flatMap(a => state.payments[a.id] || [])
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function getLast6Months() {
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i));
    return {
      label: d.toLocaleString('default', { month: 'short' }),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end:   new Date(d.getFullYear(), d.getMonth() + 1, 1),
    };
  });
}

function thisMonthRange() {
  const now = new Date();
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

function monthlyTotals(payments, months) {
  return months.map(({ start, end }) => {
    let income = 0, expenses = 0;
    for (const p of payments) {
      const amt = parseFloat(p.amount?.value || 0);
      const d   = new Date(p.created);
      if (d < start || d >= end) continue;
      if (amt > 0) income += amt;
      else expenses += Math.abs(amt);
    }
    return { income, expenses, net: income - expenses };
  });
}

// ── Connection dots ───────────────────────────────────────────────────────────
function setConn(id, status) {
  const dot = document.getElementById(id + 'Dot');
  const lbl = document.getElementById(id + 'Label');
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
    renderActivePage(btn.dataset.page);
  });
});

function renderActivePage(page) {
  if (page === 'flii')        renderBusiness('flii');
  if (page === 'holding')     renderBusiness('holding');
  if (page === 'budget')      renderBudget();
  if (page === 'savings')     renderSavings();
  if (page === 'investments') renderInvestments();
}

// ── Settings ──────────────────────────────────────────────────────────────────
const overlay = document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingFlii').value    = state.mapping.flii;
  document.getElementById('settingHolding').value = state.mapping.holding;
  document.getElementById('settingSavings').value = state.mapping.savings;
  overlay.classList.add('open');
});
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  state.mapping = {
    flii:    document.getElementById('settingFlii').value.trim(),
    holding: document.getElementById('settingHolding').value.trim(),
    savings: document.getElementById('settingSavings').value.trim(),
  };
  store.set('mapping', state.mapping);
  overlay.classList.remove('open');
  renderAllPages();
});

// ── Refresh ───────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const icon = document.querySelector('#refreshBtn i');
  icon.style.animation = 'spin .7s linear infinite';
  await loadAllData();
  icon.style.animation = '';
});

// ── KPI builder ──────────────────────────────────────────────────────────────
function kpi(label, icon, value, sub = '', subClass = '', full = false) {
  return `<div class="kpi${full ? ' full' : ''}">
    <div class="kpi-lbl"><i class="ti ${icon}"></i>${label}</div>
    <div class="kpi-val">${value}</div>
    ${sub ? `<div class="kpi-sub ${subClass}">${sub}</div>` : ''}
  </div>`;
}

// ── TX renderer ───────────────────────────────────────────────────────────────
function txHTML(payments, limit = 30) {
  if (!payments.length) return '<p class="empty-msg">No transactions yet</p>';
  const catIcons = { Housing: 'ti-home', Groceries: 'ti-shopping-cart', Dining: 'ti-tool-kitchen-2', Transport: 'ti-car', Subscriptions: 'ti-device-mobile', Tax: 'ti-receipt-tax', Salary: 'ti-arrow-down', Other: 'ti-dots' };
  return payments.slice(0, limit).map(p => {
    const amt   = parseFloat(p.amount?.value || 0);
    const isPos = amt > 0;
    const name  = p.counterparty?.display_name || p.description || 'Transaction';
    const cat   = categorise(p);
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

// ── Categorise ────────────────────────────────────────────────────────────────
function categorise(p) {
  const s = (p.description || p.counterparty?.display_name || '').toLowerCase();
  if (/belasting|tax|btw|vat/.test(s))                                            return 'Tax';
  if (/salary|salaris|loon|payroll/.test(s))                                      return 'Salary';
  if (/rent|mortgage|huur|hypotheek/.test(s))                                     return 'Housing';
  if (/mercadona|lidl|aldi|carrefour|eroski|consum|supermercado|grocery/.test(s)) return 'Groceries';
  if (/restaurant|cafe|bar|bistro|pizza|burger|sushi|dining/.test(s))             return 'Dining';
  if (/glovo|uber|taxi|bus|metro|parking|petrol|gasolina|bp |repsol/.test(s))    return 'Transport';
  if (/netflix|spotify|apple|adobe|amazon|hbo|disney|subscription/.test(s))      return 'Subscriptions';
  return 'Other';
}

// ── Area chart helper ─────────────────────────────────────────────────────────
function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function areaChart(canvasId, key, months, data, label, color) {
  destroyChart(key);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  state.charts[key] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months.map(m => m.label),
      datasets: [{
        label, data, borderColor: color, backgroundColor: color + '22',
        fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: color,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: tc, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: tc, font: { size: 11 }, callback: v => fmtK(v) }, grid: { color: gc }, border: { display: false } },
      },
    },
  });
}

function groupedBarChart(canvasId, key, months, totals) {
  destroyChart(key);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  state.charts[key] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Revenue', data: totals.map(t => Math.round(t.income)),   backgroundColor: '#2a7d5f', borderRadius: 3 },
        { label: 'Expenses', data: totals.map(t => Math.round(t.expenses)), backgroundColor: '#e7255a', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { color: tc, font: { size: 11 }, boxWidth: 10, padding: 12 } }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: tc, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
        y: { ticks: { color: tc, font: { size: 11 }, callback: v => fmtK(v) }, grid: { color: gc }, border: { display: false } },
      },
    },
  });
}

function hBarChart(canvasId, key, labels, data, colors) {
  destroyChart(key);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  state.charts[key] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 3 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.x) } } },
      scales: {
        x: { ticks: { color: tc, font: { size: 11 }, callback: v => fmtK(v) }, grid: { color: gc }, border: { display: false } },
        y: { ticks: { color: tc, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
      },
    },
  });
}

// ── BUSINESS tab renderer ─────────────────────────────────────────────────────
function renderBusiness(which) {
  const name     = which === 'flii' ? state.mapping.flii : state.mapping.holding;
  const accs     = accountsByName(name);
  const payments = paymentsFor(accs);
  const months   = getLast6Months();
  const totals   = monthlyTotals(payments, months);
  const { start, end } = thisMonthRange();

  const balance    = accs.reduce((s, a) => s + parseFloat(a.balance?.value || 0), 0);
  const thisMonth  = totals[5];
  const lastMonth  = totals[4];
  const netChange  = thisMonth.net - lastMonth.net;

  // Revenue this month (from real data)
  const revenueThisMonth = payments
    .filter(p => new Date(p.created) >= start && new Date(p.created) < end && parseFloat(p.amount?.value || 0) > 0)
    .reduce((s, p) => s + parseFloat(p.amount.value), 0);

  // KPIs
  const kpiEl = document.getElementById(which + '-kpis');
  kpiEl.innerHTML =
    kpi('Balance', 'ti-building-bank', fmt(balance), '', '') +
    kpi('Net this month', 'ti-trending-up', fmtSign(thisMonth.net), netChange >= 0 ? '▲ vs last month' : '▼ vs last month', netChange >= 0 ? 'pos' : 'neg') +
    kpi('Revenue', 'ti-arrow-down', fmt(revenueThisMonth), 'This month', 'neu') +
    kpi('Expenses', 'ti-arrow-up', fmt(thisMonth.expenses), 'This month', 'neu');

  // Cashflow area chart
  areaChart(which + 'AreaChart', which + 'Area', months, totals.map(t => Math.round(t.net)), 'Net cashflow', '#e7255a');

  // Revenue vs expenses grouped bar
  groupedBarChart(which + 'BarChart', which + 'Bar', months, totals);

  // VAT reserve (only for Flii Media)
  if (which === 'flii') {
    const vatReserve = revenueThisMonth * 0.21;
    const vatEl = document.getElementById('fliiVat');
    const vatCoverage = balance > 0 ? Math.min(100, (balance / vatReserve) * 100) : 0;
    vatEl.innerHTML = `
      <div class="vat-row"><span class="vat-label">Reserve needed (21% of revenue)</span><span class="vat-val">${fmt(vatReserve)}</span></div>
      <div class="vat-bar-bg"><div class="vat-bar" style="width:${vatCoverage.toFixed(0)}%"></div></div>
      <div class="vat-hint">${vatCoverage >= 100 ? '✓ Fully covered' : `${vatCoverage.toFixed(0)}% covered by current balance`}</div>`;
  }

  // Transactions
  const txEl = document.getElementById(which + 'TxList');
  document.getElementById(which + 'TxCount').textContent = payments.length + ' total';
  txEl.innerHTML = txHTML(payments, 40);
}

// ── BUDGET tab ────────────────────────────────────────────────────────────────
function renderBudget() {
  const accs     = personalAccounts();
  const payments = paymentsFor(accs);
  const { start, end } = thisMonthRange();
  const months   = getLast6Months();

  const totalBalance = accs.reduce((s, a) => s + parseFloat(a.balance?.value || 0), 0);
  const thisMonthPay = payments.filter(p => new Date(p.created) >= start && new Date(p.created) < end);
  const income       = thisMonthPay.filter(p => parseFloat(p.amount?.value || 0) > 0).reduce((s, p) => s + parseFloat(p.amount.value), 0);
  const expenses     = thisMonthPay.filter(p => parseFloat(p.amount?.value || 0) < 0).reduce((s, p) => s + Math.abs(parseFloat(p.amount.value)), 0);

  // KPIs
  document.getElementById('budget-kpis').innerHTML =
    kpi('Total balance', 'ti-wallet', fmt(totalBalance), '', '', true) +
    kpi('Income', 'ti-arrow-down', fmt(income), 'This month', 'pos') +
    kpi('Expenses', 'ti-arrow-up', fmt(expenses), 'This month', 'neg');

  // Income vs expenses — single grouped bar for current month
  destroyChart('budgetFlow');
  const flowCtx = document.getElementById('budgetFlowChart');
  if (flowCtx) {
    state.charts.budgetFlow = new Chart(flowCtx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          { label: 'Income',   data: monthlyTotals(payments, months).map(t => Math.round(t.income)),   backgroundColor: '#2a7d5f', borderRadius: 3 },
          { label: 'Expenses', data: monthlyTotals(payments, months).map(t => Math.round(t.expenses)), backgroundColor: '#e7255a', borderRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { color: tc, font: { size: 11 }, boxWidth: 10, padding: 12 } }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.y) } } },
        scales: {
          x: { ticks: { color: tc, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
          y: { ticks: { color: tc, font: { size: 11 }, callback: v => fmtK(v) }, grid: { color: gc }, border: { display: false } },
        },
      },
    });
  }

  // Spending by category — horizontal bar
  const cats = {};
  for (const p of thisMonthPay.filter(p => parseFloat(p.amount?.value || 0) < 0)) {
    const cat = categorise(p);
    cats[cat] = (cats[cat] || 0) + Math.abs(parseFloat(p.amount.value));
  }
  const sorted  = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const catLabels = sorted.map(([k]) => k);
  const catData   = sorted.map(([, v]) => Math.round(v));
  const catColors = catLabels.map((_, i) => COLORS[i % COLORS.length]);
  hBarChart('budgetCatChart', 'budgetCat', catLabels, catData, catColors);

  // Recurring payments — detect by description appearing 2+ months
  const monthlyGroups = {};
  for (const p of payments.filter(p => parseFloat(p.amount?.value || 0) < 0)) {
    const key = (p.counterparty?.display_name || p.description || '').toLowerCase().trim();
    if (!key) continue;
    const month = new Date(p.created).toISOString().slice(0, 7);
    if (!monthlyGroups[key]) monthlyGroups[key] = { name: p.counterparty?.display_name || p.description, months: new Set(), amounts: [] };
    monthlyGroups[key].months.add(month);
    monthlyGroups[key].amounts.push(Math.abs(parseFloat(p.amount.value)));
  }
  const recurring = Object.values(monthlyGroups)
    .filter(g => g.months.size >= 2)
    .map(g => ({ name: g.name, avg: g.amounts.reduce((s, v) => s + v, 0) / g.amounts.length, count: g.months.size }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  document.getElementById('recurringList').innerHTML = recurring.length
    ? recurring.map(r => `<div class="rec-item">
        <div><div class="rec-name">${r.name}</div><div class="rec-freq">${r.count} months detected</div></div>
        <div class="rec-amt">−${fmt(r.avg)}/mo</div>
      </div>`).join('')
    : '<p class="empty-msg">Not enough data to detect recurring payments yet</p>';

  // Transactions
  document.getElementById('budgetTxList').innerHTML = txHTML(payments, 40);
}

// ── SAVINGS tab ───────────────────────────────────────────────────────────────
function renderSavings() {
  const savAccs  = savingsAccounts();
  const allPers  = personalAccounts();
  const months   = getLast6Months();

  const totalSaved = savAccs.reduce((s, a) => s + parseFloat(a.balance?.value || 0), 0);

  // Savings rate — income vs what ended up in savings accounts
  const persPay   = paymentsFor(allPers);
  const { start, end } = thisMonthRange();
  const income    = persPay.filter(p => new Date(p.created) >= start && parseFloat(p.amount?.value || 0) > 0)
    .reduce((s, p) => s + parseFloat(p.amount.value), 0);
  const savingsRate = income > 0 ? ((totalSaved / income) * 100).toFixed(1) : '—';

  document.getElementById('savings-kpis').innerHTML =
    kpi('Total saved', 'ti-pig-money', fmt(totalSaved), '', '', true) +
    kpi('Savings rate', 'ti-percentage', savingsRate + '%', 'Saved vs income', 'neu') +
    kpi('Savings accounts', 'ti-building-bank', savAccs.length.toString(), savAccs.map(a => a.description).join(', ') || 'None mapped', 'neu');

  // Savings trend — balance of savings accounts over 6 months approximated from payments
  const savPayments = paymentsFor(savAccs);
  const currentBal  = totalSaved;
  // Work backwards from current balance
  const monthNetFlows = months.map(({ start, end }) =>
    savPayments.filter(p => new Date(p.created) >= start && new Date(p.created) < end)
      .reduce((s, p) => s + parseFloat(p.amount?.value || 0), 0)
  );
  // Reconstruct approximate balances
  const trendData = [];
  let runningBal = currentBal;
  for (let i = monthNetFlows.length - 1; i >= 0; i--) {
    trendData[i] = Math.round(runningBal);
    runningBal -= monthNetFlows[i];
  }
  areaChart('savingsAreaChart', 'savingsArea', months, trendData, 'Savings balance', '#e7255a');

  // Goals
  renderGoalList('goalsList', state.goals, false);
  renderGoalList('holidayList', state.holidays, true);
}

function renderGoalList(elId, items, isHoliday) {
  const el = document.getElementById(elId);
  if (!items.length) { el.innerHTML = '<p class="empty-msg">None yet — tap + Add</p>'; return; }
  el.innerHTML = items.map((g, i) => {
    const pct = g.target > 0 ? Math.min(100, Math.round(g.saved / g.target * 100)) : 0;
    return `<div class="goal-item">
      <div class="goal-top">
        <span class="goal-name"><i class="ti ${isHoliday ? 'ti-plane' : 'ti-target'}"></i>${g.name}${g.date ? ' · ' + g.date : ''}</span>
        <span class="goal-amt">${fmt(g.saved)} / ${fmt(g.target)}</span>
      </div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%;background:${COLORS[i % COLORS.length]}"></div></div>
      <div class="goal-sub">${pct}% · ${fmt(g.target - g.saved)} remaining</div>
    </div>`;
  }).join('');
}

document.getElementById('addGoalBtn').addEventListener('click', () => addGoal('goals'));
document.getElementById('addHolidayBtn').addEventListener('click', () => addGoal('holidays'));

function addGoal(type) {
  const name   = prompt('Goal name:');               if (!name)   return;
  const target = parseFloat(prompt('Target (€):'));   if (!target) return;
  const saved  = parseFloat(prompt('Saved so far (€):') || '0') || 0;
  const goal   = { name, target, saved };
  if (type === 'holidays') goal.date = prompt('Travel date (e.g. Sep 2026):') || '';
  state[type].push(goal);
  store.set(type, state[type]);
  renderSavings();
}

// ── INVESTMENTS tab ───────────────────────────────────────────────────────────
function renderInvestments() {
  const { alpacaAccount: acc, alpacaPositions: positions } = state;

  if (!acc) {
    document.getElementById('invest-kpis').innerHTML = '<div class="error-card"><i class="ti ti-plug"></i>Alpaca not connected</div>';
    return;
  }

  const equity     = parseFloat(acc.equity      || 0);
  const lastEquity = parseFloat(acc.last_equity  || 0);
  const todayPL    = equity - lastEquity;
  const totalPL    = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);
  const cash       = parseFloat(acc.cash || 0);

  document.getElementById('invest-kpis').innerHTML =
    kpi('Portfolio value', 'ti-chart-line', fmt(equity), '', '', true) +
    kpi("Today's P&L", 'ti-trending-up', fmtSign(todayPL), lastEquity ? ((todayPL / lastEquity * 100).toFixed(2) + '%') : '', todayPL >= 0 ? 'pos' : 'neg') +
    kpi('Unrealised P&L', 'ti-calculator', fmtSign(totalPL), 'All positions', totalPL >= 0 ? 'pos' : 'neg') +
    kpi('Cash available', 'ti-currency-euro', fmt(cash), '', 'neu');

  // Allocation donut
  const groups = {};
  for (const p of positions) {
    const val = parseFloat(p.market_value || 0);
    const grp = /^V|^I/.test(p.symbol) ? 'ETFs' : 'Stocks';
    groups[grp] = (groups[grp] || 0) + val;
  }
  if (cash > 0) groups['Cash'] = cash;
  const labels = Object.keys(groups);
  const values = Object.values(groups).map(v => Math.round(v));

  destroyChart('alloc');
  const allocCtx = document.getElementById('allocChart');
  if (allocCtx) {
    state.charts.alloc = new Chart(allocCtx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 0, hoverOffset: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.label + ': ' + fmt(c.parsed) } } },
      },
    });
  }

  // Alloc legend
  document.getElementById('allocLegend').innerHTML = labels.map((l, i) => {
    const pct = equity > 0 ? ((values[i] / equity) * 100).toFixed(1) : 0;
    return `<div class="alloc-item"><div class="alloc-dot" style="background:${COLORS[i]}"></div><span class="alloc-name">${l}</span><span class="alloc-pct">${pct}%</span></div>`;
  }).join('');

  // Positions with inline bar
  const maxVal = Math.max(...positions.map(p => parseFloat(p.market_value || 0)));
  document.getElementById('positionsList').innerHTML = positions
    .sort((a, b) => parseFloat(b.market_value) - parseFloat(a.market_value))
    .map(p => {
      const val  = parseFloat(p.market_value || 0);
      const pl   = parseFloat(p.unrealized_plpc || 0) * 100;
      const barW = maxVal > 0 ? ((val / maxVal) * 100).toFixed(1) : 0;
      const cls  = pl >= 0 ? 'pos' : 'neg';
      return `<div class="pos-item">
        <span class="pos-tk">${p.symbol}</span>
        <span class="pos-nm">${p.symbol}</span>
        <div class="pos-bar-wrap"><div class="pos-bar-bg"><div class="pos-bar-fill" style="width:${barW}%;background:${pl >= 0 ? '#2a7d5f' : '#e7255a'}"></div></div></div>
        <span class="pos-val">${fmt(val)}</span>
        <span class="pos-pl ${cls}">${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%</span>
      </div>`;
    }).join('');
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function bunqProxy(action, params = {}, retried = false) {
  const qs  = new URLSearchParams({ action, ...params }).toString();
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
    state.accounts = accounts;

    // Fetch payments for all accounts in parallel
    const results = await Promise.allSettled(
      accounts.map(a => bunqProxy('payments', { accountId: a.id, userId: a.userId })
        .then(r => ({ id: a.id, payments: r.payments }))
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') state.payments[r.value.id] = r.value.payments;
    }

    setConn('bunq', 'ok');
    renderAllPages();
  } catch (err) {
    console.error('Bunq:', err);
    setConn('bunq', 'error');
  }
}

async function loadAlpaca() {
  setConn('alpaca', 'loading');
  try {
    const res  = await fetch('/api/alpaca?action=portfolio');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Alpaca ${res.status}`);
    state.alpacaAccount   = json.account;
    state.alpacaPositions = json.positions;
    setConn('alpaca', 'ok');
    if (document.querySelector('.nav-item.active')?.dataset.page === 'investments') renderInvestments();
  } catch (err) {
    console.error('Alpaca:', err);
    setConn('alpaca', 'error');
  }
}

async function loadAllData() {
  await Promise.allSettled([loadBunq(), loadAlpaca()]);
}

function renderAllPages() {
  const active = document.querySelector('.nav-item.active')?.dataset.page || 'flii';
  renderActivePage(active);
}

// ── Init ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
setConn('bunq', 'loading');
setConn('alpaca', 'loading');
loadAllData();
