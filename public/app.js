'use strict';

// ── Storage ───────────────────────────────────────────────────────────────────
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  accounts:         [],
  payments:         {},   // { accountId: [...payments] }
  alpacaAccount:    null,
  alpacaPositions:  [],
  goals:            store.get('goals')    || [],
  holidays:         store.get('holidays') || [],
  charts:           {},
  lastSync:         null,
};

// ── Account routing (hardcoded by Bunq account ID) ────────────────────────────
const ACCT = {
  flii:    [3408701],           // Flii Media BV
  holding: [3408705],           // SB Holding BV
  budget:  [4172851, 2560176],  // Rekeningen + Vast Samen
  savings: [16714864],          // Bruiloft
};

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS  = ['#e7255a', '#f05a84', '#f78faa', '#fbc4d4', '#ccc9c1', '#a8a8a0'];
const GC      = 'rgba(0,0,0,0.05)';
const TC      = '#a0a0a0';
const VPB_LOW = 0.19;
const VPB_HI  = 0.258;
const VPB_THR = 200_000;

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt         = (n, d = 2) => '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtK        = n => Math.abs(n) >= 1000 ? (n < 0 ? '−' : '') + '€' + (Math.abs(n) / 1000).toFixed(1) + 'k' : fmt(Math.abs(n), 0);
const fmtSign     = (n, d = 2) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), d);
const fmtDate     = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const fmtMon      = m => new Date(m + '-01').toLocaleString('default', { month: 'short', year: 'numeric' });
const fmtMonShort = m => new Date(m + '-01').toLocaleString('default', { month: 'short' });

// ── Account helpers ───────────────────────────────────────────────────────────
const byIds       = ids => state.accounts.filter(a => ids.includes(a.id));
const balance     = accs => accs.reduce((s, a) => s + parseFloat(a.balance?.value || 0), 0);
const paymentsFor = ids => ids.flatMap(id => state.payments[id] || []).sort((a, b) => new Date(b.created) - new Date(a.created));
const amt         = p => parseFloat(p.amount?.value || 0);
const cpName      = p => p.counterparty?.display_name || p.description || 'Unknown';

// ── Date range state ──────────────────────────────────────────────────────────
const DR = {
  // Default: year to date
  start: new Date(new Date().getFullYear(), 0, 1),
  end:   new Date(),
  preset: 'ytd',
};

function drMonths() {
  // Build monthly buckets covering the selected range
  const months = [];
  const cursor = new Date(DR.start.getFullYear(), DR.start.getMonth(), 1);
  const endMon = new Date(DR.end.getFullYear(), DR.end.getMonth(), 1);
  while (cursor <= endMon) {
    months.push({
      label: cursor.toLocaleString('default', { month: 'short' }),
      start: new Date(cursor),
      end:   new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function drFilter(payments) {
  return payments.filter(p => {
    const d = new Date(p.created);
    return d >= DR.start && d <= DR.end;
  });
}

// thisMonth() still used for KPI "this month" figures — unaffected by range
function thisMonth() {
  const now = new Date();
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

// Backwards-compat alias used in renderSavings
function last6Months() { return drMonths(); }

function monthlyTotals(payments, months) {
  return months.map(({ start, end }) => {
    let income = 0, expenses = 0;
    for (const p of payments) {
      const v = amt(p), d = new Date(p.created);
      if (d < start || d >= end) continue;
      if (v > 0) income += v; else expenses += Math.abs(v);
    }
    return { income, expenses, net: income - expenses };
  });
}

function recentMonths(payments, n = 6) {
  return [...new Set(payments.map(p => p.created.slice(0, 7)))].sort().reverse().slice(0, n).reverse();
}

// ── Categorise ────────────────────────────────────────────────────────────────
const CAT_RULES = [
  [/belastingdienst/i,                                                              'Tax'],
  [/salary|salaris|loon|payroll/i,                                                  'Salary'],
  [/rent|mortgage|huur|hypotheek/i,                                                 'Housing'],
  [/mercadona|lidl|aldi|carrefour|eroski|consum|supermercado|grocery|groceries/i,  'Groceries'],
  [/restaurant|cafe|café|bar|bistro|pizza|burger|sushi|dining/i,                   'Dining'],
  [/glovo|uber|taxi|bus|metro|trein|parking|petrol|gasolina|\bbp\b|repsol/i,       'Transport'],
  [/netflix|spotify|apple|adobe|amazon|hbo|disney|subscription/i,                  'Subscriptions'],
];

function categorise(p) {
  const s = p.description || cpName(p);
  for (const [re, cat] of CAT_RULES) if (re.test(s)) return cat;
  return 'Other';
}

// ── Tax helpers ───────────────────────────────────────────────────────────────
const isBelastingdienst = p => /belastingdienst/i.test(cpName(p) + ' ' + (p.description || ''));

function detectTaxType(p) {
  const s = (p.description || '') + ' ' + cpName(p);
  if (/\bbtw\b|omzetbelasting|\bvat\b/i.test(s))     return 'BTW';
  if (/\bvpb\b|vennootschapsbelasting/i.test(s))      return 'VPB';
  if (/\bloonheffing\b|loonbelasting/i.test(s))       return 'Loonheffing';
  if (/\bdividend/i.test(s))                          return 'Dividendbelasting';
  if (/\bib\b|inkomstenbelasting/i.test(s))           return 'IB';
  return 'Unknown';
}

function vatRate(p) {
  const s = (p.description || '') + ' ' + cpName(p);
  if (/transport|taxi|trein|bus|vlieg|flight|\bov\b|\bns\b|ryanair|easyjet/i.test(s)) return 0;
  if (/food|grocery|groceries|supermarkt|mercadona|lidl|aldi|restaurant|cafe|café|dining|lunch|dinner|eten/i.test(s)) return 0.09;
  return 0.21;
}

// BTW aangifte: output VAT (gross amounts received assumed BTW-inclusive at 21%) minus input VAT on expenses
function calcBTW(payments, year, quarter) {
  const start = new Date(year, (quarter - 1) * 3, 1);
  const end   = new Date(year, quarter * 3, 1);
  const qPay  = payments.filter(p => { const d = new Date(p.created); return d >= start && d < end; });

  const outputVAT = qPay.filter(p => amt(p) > 0 && !isBelastingdienst(p))
    .reduce((s, p) => { const g = amt(p); return s + (g - g / 1.21); }, 0);

  const inputVAT = qPay.filter(p => amt(p) < 0 && !isBelastingdienst(p))
    .reduce((s, p) => { const r = vatRate(p); if (!r) return s; const g = Math.abs(amt(p)); return s + (g - g / (1 + r)); }, 0);

  return { outputVAT, inputVAT, due: outputVAT - inputVAT };
}

// VPB: annualise YTD profit and apply tiered Dutch rate
function calcVPB(payments, year) {
  const start = new Date(year, 0, 1), end = new Date(year + 1, 0, 1), now = new Date();
  const yPay    = payments.filter(p => { const d = new Date(p.created); return d >= start && d < end && !isBelastingdienst(p); });
  const revenue = yPay.filter(p => amt(p) > 0).reduce((s, p) => s + amt(p), 0);
  const expenses = yPay.filter(p => amt(p) < 0).reduce((s, p) => s + Math.abs(amt(p)), 0);
  const ytdProfit = revenue - expenses;
  const mElapsed = now.getFullYear() === year ? now.getMonth() + now.getDate() / 30 : 12;
  const projected = mElapsed > 0 ? (ytdProfit / mElapsed) * 12 : 0;
  const vpb = projected <= VPB_THR ? Math.max(0, projected * VPB_LOW) : VPB_THR * VPB_LOW + Math.max(0, projected - VPB_THR) * VPB_HI;
  return { ytdProfit, projected, vpb, mElapsed };
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function baseScales(horizontal = false) {
  const num = { ticks: { color: TC, font: { size: 11 }, callback: v => fmtK(v) }, grid: { color: GC }, border: { display: false } };
  const cat = { ticks: { color: TC, font: { size: 11 } }, grid: { display: false }, border: { display: false } };
  return horizontal ? { x: num, y: cat } : { x: cat, y: num };
}

function mkChart(key, canvasId, type, data, options = {}) {
  destroyChart(key);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  state.charts[key] = new Chart(ctx, { type, data, options: { responsive: true, maintainAspectRatio: false, ...options } });
}

function areaChart(key, canvasId, labels, data, color) {
  mkChart(key, canvasId, 'line', {
    labels,
    datasets: [{ data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: color }],
  }, {
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.y) } } },
    scales: baseScales(),
  });
}

function groupedBar(key, canvasId, labels, incomeData, expenseData) {
  mkChart(key, canvasId, 'bar', {
    labels,
    datasets: [
      { label: 'Revenue',  data: incomeData,  backgroundColor: '#2a7d5f', borderRadius: 3 },
      { label: 'Expenses', data: expenseData, backgroundColor: '#e7255a', borderRadius: 3 },
    ],
  }, {
    plugins: { legend: { position: 'top', labels: { color: TC, font: { size: 11 }, boxWidth: 10, padding: 12 } }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.y) } } },
    scales: baseScales(),
  });
}

function hBar(key, canvasId, labels, data, colors) {
  // Size container to fit all categories comfortably
  const canvas = document.getElementById(canvasId);
  if (canvas) canvas.parentElement.style.height = Math.max(120, labels.length * 36) + 'px';
  mkChart(key, canvasId, 'bar', {
    labels,
    datasets: [{ data, backgroundColor: colors, borderRadius: 3 }],
  }, {
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtK(c.parsed.x) } } },
    scales: baseScales(true),
  });
}

// ── KPI builder ───────────────────────────────────────────────────────────────
const kpi = (label, icon, value, sub = '', subCls = '', full = false) =>
  `<div class="kpi${full ? ' full' : ''}">
    <div class="kpi-lbl"><i class="ti ${icon}" aria-hidden="true"></i>${label}</div>
    <div class="kpi-val">${value}</div>
    ${sub ? `<div class="kpi-sub ${subCls}">${sub}</div>` : ''}
  </div>`;

// ── Transaction list HTML ─────────────────────────────────────────────────────
const CAT_ICONS = { Housing: 'ti-home', Groceries: 'ti-shopping-cart', Dining: 'ti-tool-kitchen-2', Transport: 'ti-car', Subscriptions: 'ti-device-mobile', Tax: 'ti-receipt-tax', Salary: 'ti-arrow-down', Other: 'ti-dots' };

function txHTML(payments, limit = 40) {
  if (!payments.length) return '<p class="empty-msg">No transactions found</p>';
  return payments.slice(0, limit).map(p => {
    const v = amt(p), pos = v > 0;
    const name = cpName(p), cat = categorise(p);
    const icon = pos ? 'ti-arrow-down' : (CAT_ICONS[cat] || 'ti-dots');
    return `<div class="tx">
      <div class="tx-ico" style="background:${pos ? '#edf7f3' : '#fdeef2'}"><i class="ti ${icon}" style="color:${pos ? '#2a7d5f' : '#e7255a'}" aria-hidden="true"></i></div>
      <div class="tx-info"><div class="tx-name">${name}</div><div class="tx-cat">${cat} · ${fmtDate(p.created)}</div></div>
      <div class="tx-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : '−'}${fmt(Math.abs(v))}</div>
    </div>`;
  }).join('');
}

// ── Table helpers ─────────────────────────────────────────────────────────────
function groupBy(payments, keyFn, valFn = p => Math.abs(amt(p))) {
  const map = {};
  for (const p of payments) {
    const k = keyFn(p), m = p.created.slice(0, 7), v = valFn(p);
    if (!map[k]) map[k] = { total: 0, months: {} };
    map[k].total += v;
    map[k].months[m] = (map[k].months[m] || 0) + v;
  }
  return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
}

function renderTable(elId, rows, months, totalLabel, valCls) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p class="table-empty">No data found</p>'; return; }
  const grandTotal = rows.reduce((s, [, d]) => s + d.total, 0);
  el.innerHTML = `<div class="table-scroll"><table class="data-table">
    <thead><tr><th>Name</th>${months.map(m => `<th class="num">${fmtMonShort(m)}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>
      ${rows.map(([name, data]) => `<tr>
        <td class="bold">${name}</td>
        ${months.map(m => `<td class="num">${data.months[m] ? fmt(data.months[m]) : '—'}</td>`).join('')}
        <td class="num ${valCls}">${fmt(data.total)}</td>
      </tr>`).join('')}
      <tr class="total-row">
        <td>${totalLabel}</td>
        ${months.map(m => { const t = rows.reduce((s, [, d]) => s + (d.months[m] || 0), 0); return `<td class="num">${t ? fmt(t) : '—'}</td>`; }).join('')}
        <td class="num ${valCls}">${fmt(grandTotal)}</td>
      </tr>
    </tbody>
  </table></div>`;
}

// ── Tax overview ──────────────────────────────────────────────────────────────
function renderTaxTable(elId, payments) {
  const el = document.getElementById(elId);
  if (!el) return;

  const now  = new Date();
  const year = now.getFullYear();
  const q    = Math.ceil((now.getMonth() + 1) / 3);
  const qLabel = `Q${q} ${year}`;
  const qMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    .slice((q - 1) * 3, q * 3).join('–');

  // ── Gather actuals ──
  const taxPay = payments.filter(p => isBelastingdienst(p) && amt(p) < 0);
  const byType = {};
  for (const p of taxPay) {
    const type = detectTaxType(p);
    const m    = p.created.slice(0, 7);
    if (!byType[type]) byType[type] = { total: 0, months: {} };
    const v = Math.abs(amt(p));
    byType[type].total += v;
    byType[type].months[m] = (byType[type].months[m] || 0) + v;
  }
  const totalPaid = taxPay.reduce((s, p) => s + Math.abs(amt(p)), 0);

  // ── Projections ──
  const btw = calcBTW(payments, year, q);
  const vpb = calcVPB(payments, year);

  // ── Build projection rows per tax type ──
  // Each row: type | total paid YTD | next period due | basis explanation
  const TAX_ROWS = [
    {
      type:       'BTW',
      paid:       byType['BTW']?.total || 0,
      due:        btw.due,
      period:     qLabel,
      frequency:  'Quarterly',
      basis:      `Output (21% of ${fmt(btw.outputVAT / 0.21 * 1.21)} revenue) minus input VAT on expenses`,
    },
    {
      type:       'VPB',
      paid:       byType['VPB']?.total || 0,
      due:        vpb.vpb,
      period:     `${year} (est.)`,
      frequency:  'Annual',
      basis:      `${vpb.mElapsed.toFixed(1)} months annualised → ${fmt(vpb.projected)} profit × ${vpb.projected <= VPB_THR ? '19%' : '19%/25.8%'}`,
    },
    {
      type:       'Loonheffing',
      paid:       byType['Loonheffing']?.total || 0,
      due:        null,
      period:     'Monthly',
      frequency:  'Monthly',
      basis:      'Based on payroll — verify with salary administration',
    },
    {
      type:       'Unknown',
      paid:       byType['Unknown']?.total || 0,
      due:        null,
      period:     '—',
      frequency:  '—',
      basis:      'Tax type could not be detected from payment description',
    },
  ].filter(r => r.paid > 0 || r.due !== null && r.due > 0);

  // ── Summary KPI cards ──
  const btwDue = btw.due > 0 ? btw.due : 0;
  const vpbDue = vpb.vpb;

  let html = `
  <div class="tax-kpi-row">
    <div class="tax-kpi">
      <div class="tax-kpi-lbl">Total paid YTD</div>
      <div class="tax-kpi-val neg-val">${fmt(totalPaid)}</div>
      <div class="tax-kpi-sub">To Belastingdienst</div>
    </div>
    <div class="tax-kpi">
      <div class="tax-kpi-lbl">BTW due — ${qLabel}</div>
      <div class="tax-kpi-val ${btwDue > 0 ? 'neg-val' : 'pos-val'}">${fmt(btwDue)}</div>
      <div class="tax-kpi-sub">${qMonths} · file by end of quarter</div>
    </div>
    <div class="tax-kpi">
      <div class="tax-kpi-lbl">VPB estimate — ${year}</div>
      <div class="tax-kpi-val neg-val">${fmt(vpbDue)}</div>
      <div class="tax-kpi-sub">Annual · based on ${vpb.mElapsed.toFixed(1)} months</div>
    </div>
  </div>`;

  // ── Main table: one row per tax type ──
  html += `
  <div class="table-scroll" style="margin-top:16px">
  <table class="data-table">
    <thead>
      <tr>
        <th>Tax type</th>
        <th class="num">Paid YTD</th>
        <th class="num">Next due</th>
        <th>Period</th>
        <th>Frequency</th>
        <th>Basis</th>
      </tr>
    </thead>
    <tbody>
      ${TAX_ROWS.map(r => `
      <tr>
        <td class="bold"><span class="tax-badge">${r.type}</span></td>
        <td class="num ${r.paid > 0 ? 'neg-val' : 'neu'}">${r.paid > 0 ? fmt(r.paid) : '—'}</td>
        <td class="num ${r.due > 0 ? 'neg-val' : r.due === null ? 'neu' : 'pos-val'}">${r.due !== null ? fmt(r.due) : '—'}</td>
        <td>${r.period}</td>
        <td><span class="freq-tag">${r.frequency}</span></td>
        <td class="tax-basis">${r.basis}</td>
      </tr>`).join('')}
      ${totalPaid > 0 ? `
      <tr class="total-row">
        <td>Total</td>
        <td class="num neg-val">${fmt(totalPaid)}</td>
        <td class="num neg-val">${fmt(btwDue + vpbDue)}</td>
        <td colspan="3"></td>
      </tr>` : ''}
    </tbody>
  </table>
  </div>
  <p class="table-hint">⚠️ Projections are estimates based on transaction data. Always verify with your accountant before filing.</p>`;

  // ── Monthly paid breakdown (collapsed into a smaller supporting table) ──
  if (taxPay.length) {
    const types  = [...new Set(taxPay.map(detectTaxType))].sort();
    const byMonth = {};
    for (const p of taxPay) {
      const m = p.created.slice(0, 7), type = detectTaxType(p);
      if (!byMonth[m]) byMonth[m] = {};
      byMonth[m][type] = (byMonth[m][type] || 0) + Math.abs(amt(p));
    }
    const months = Object.keys(byMonth).sort().reverse();

    html += `
    <p class="table-section-label" style="margin-top:20px">Payment history — Belastingdienst</p>
    <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>Month</th>${types.map(t => `<th class="num">${t}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>
        ${months.map(m => {
          const total = Object.values(byMonth[m]).reduce((s, v) => s + v, 0);
          return `<tr>
            <td class="bold">${fmtMon(m)}</td>
            ${types.map(t => `<td class="num">${byMonth[m][t] ? fmt(byMonth[m][t]) : '—'}</td>`).join('')}
            <td class="num neg-val">${fmt(total)}</td>
          </tr>`;
        }).join('')}
        <tr class="total-row">
          <td>Total</td>
          ${types.map(t => { const tot = months.reduce((s, m) => s + (byMonth[m][t] || 0), 0); return `<td class="num">${tot ? fmt(tot) : '—'}</td>`; }).join('')}
          <td class="num neg-val">${fmt(totalPaid)}</td>
        </tr>
      </tbody>
    </table>
    </div>`;
  } else {
    html += '<p class="table-empty" style="margin-top:12px">No payments to Belastingdienst detected yet</p>';
  }

  el.innerHTML = html;
}

// ── Navigation ────────────────────────────────────────────────────────────────
const RENDERERS = {
  flii:        () => renderBusiness('flii'),
  holding:     () => renderBusiness('holding'),
  budget:      renderBudget,
  savings:     renderSavings,
  investments: renderInvestments,
};

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + btn.dataset.page).classList.add('active');
    RENDERERS[btn.dataset.page]?.();
  });
});

const renderActive = () => RENDERERS[document.querySelector('.nav-item.active')?.dataset.page || 'flii']?.();

// ── Settings ──────────────────────────────────────────────────────────────────
const overlay = document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('lastSyncTime').textContent = state.lastSync
    ? state.lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : 'Not yet';
  overlay.classList.add('open');
});
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
document.getElementById('closeSettingsBtn').addEventListener('click', () => overlay.classList.remove('open'));

// ── Date range ───────────────────────────────────────────────────────────────
const dateOverlay = document.getElementById('dateOverlay');

function setDateRange(start, end, preset) {
  DR.start  = start;
  DR.end    = end;
  DR.preset = preset;
  document.querySelectorAll('.dr-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
  renderActive();
}

function presetRange(preset) {
  const now = new Date();
  const ranges = {
    ytd: [new Date(now.getFullYear(), 0, 1),                         new Date()],
    '3m': [new Date(now.getFullYear(), now.getMonth() - 2, 1),       new Date()],
    '6m': [new Date(now.getFullYear(), now.getMonth() - 5, 1),       new Date()],
    '12m':[new Date(now.getFullYear(), now.getMonth() - 11, 1),      new Date()],
  };
  if (ranges[preset]) setDateRange(...ranges[preset], preset);
}

document.querySelectorAll('.dr-preset[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.preset === 'custom') {
      // Pre-fill inputs with current range
      const pad = n => String(n).padStart(2, '0');
      const toVal = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      document.getElementById('drFrom').value = toVal(DR.start);
      document.getElementById('drTo').value   = toVal(DR.end);
      dateOverlay.classList.add('open');
    } else {
      presetRange(btn.dataset.preset);
    }
  });
});

dateOverlay.addEventListener('click', e => { if (e.target === dateOverlay) dateOverlay.classList.remove('open'); });

document.getElementById('drApplyBtn').addEventListener('click', () => {
  const from = new Date(document.getElementById('drFrom').value);
  const to   = new Date(document.getElementById('drTo').value);
  if (isNaN(from) || isNaN(to) || from > to) return;
  to.setHours(23, 59, 59);
  dateOverlay.classList.remove('open');
  setDateRange(from, to, 'custom');
});

// ── Refresh ───────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const icon = document.querySelector('#refreshBtn i');
  icon.style.animation = 'spin .7s linear infinite';
  await loadAllData();
  icon.style.animation = '';
});

// ── BUSINESS tab ──────────────────────────────────────────────────────────────
function renderBusiness(which) {
  const ids      = ACCT[which];
  const accs     = byIds(ids);
  const payments = drFilter(paymentsFor(ids));
  const months   = drMonths();
  const totals   = monthlyTotals(payments, months);
  const { start } = thisMonth();

  const bal      = balance(accs);
  const thisM    = totals[5];
  const lastM    = totals[4];
  const netDelta = thisM.net - lastM.net;
  const revThisM = payments.filter(p => new Date(p.created) >= start && amt(p) > 0 && !isBelastingdienst(p)).reduce((s, p) => s + amt(p), 0);

  document.getElementById(which + '-kpis').innerHTML =
    kpi('Balance', 'ti-building-bank', fmt(bal)) +
    kpi('Net this month', 'ti-trending-up', fmtSign(thisM.net), (netDelta >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(netDelta)) + ' vs last month', netDelta >= 0 ? 'pos' : 'neg') +
    kpi('Revenue', 'ti-arrow-down', fmt(revThisM), 'This month', 'neu') +
    kpi('Expenses', 'ti-arrow-up', fmt(thisM.expenses), 'This month', 'neu');

  areaChart(which + 'Area', which + 'AreaChart', months.map(m => m.label), totals.map(t => Math.round(t.net)), '#e7255a');
  groupedBar(which + 'Bar', which + 'BarChart', months.map(m => m.label), totals.map(t => Math.round(t.income)), totals.map(t => Math.round(t.expenses)));

  renderTaxTable(which + 'TaxTable', payments);

  if (which === 'flii') {
    const incoming = payments.filter(p => amt(p) > 0 && !isBelastingdienst(p));
    const outgoing = payments.filter(p => amt(p) < 0 && !isBelastingdienst(p));
    renderTable('fliiClientTable',   groupBy(incoming, cpName, p => amt(p)).slice(0, 15), recentMonths(incoming), 'Total revenue',  'pos-val');
    renderTable('fliiProviderTable', groupBy(outgoing, cpName).slice(0, 15),              recentMonths(outgoing), 'Total expenses', 'neg-val');
  }

  document.getElementById(which + 'TxCount').textContent = payments.length + ' transactions';
  document.getElementById(which + 'TxList').innerHTML = txHTML(payments, 50);
}

// ── BUDGET tab ────────────────────────────────────────────────────────────────
function renderBudget() {
  const payments = drFilter(paymentsFor(ACCT.budget));
  const months   = drMonths();
  const totals   = monthlyTotals(payments, months);
  const accs     = byIds(ACCT.budget);
  const { start } = thisMonth();
  const thisM    = totals[5];

  document.getElementById('budget-kpis').innerHTML =
    kpi('Total balance', 'ti-wallet', fmt(balance(accs)), '', '', true) +
    kpi('Income', 'ti-arrow-down', fmt(thisM.income), 'This month', 'pos') +
    kpi('Expenses', 'ti-arrow-up', fmt(thisM.expenses), 'This month', 'neg');

  groupedBar('budgetFlow', 'budgetFlowChart', months.map(m => m.label), totals.map(t => Math.round(t.income)), totals.map(t => Math.round(t.expenses)));

  // Spending by category — this month only
  const cats = {};
  for (const p of payments.filter(p => new Date(p.created) >= start && amt(p) < 0)) {
    const cat = categorise(p);
    cats[cat] = (cats[cat] || 0) + Math.abs(amt(p));
  }
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  hBar('budgetCat', 'budgetCatChart', sorted.map(([k]) => k), sorted.map(([, v]) => Math.round(v)), sorted.map((_, i) => COLORS[i % COLORS.length]));

  // Recurring — detect counterparties appearing in 2+ distinct months
  const recurMap = {};
  for (const p of payments.filter(p => amt(p) < 0)) {
    const key = cpName(p).toLowerCase().trim();
    if (!key) continue;
    const m = p.created.slice(0, 7);
    if (!recurMap[key]) recurMap[key] = { name: cpName(p), months: new Set(), amounts: [] };
    recurMap[key].months.add(m);
    recurMap[key].amounts.push(Math.abs(amt(p)));
  }
  const recurring = Object.values(recurMap)
    .filter(g => g.months.size >= 2)
    .map(g => ({ name: g.name, avg: g.amounts.reduce((s, v) => s + v, 0) / g.amounts.length, count: g.months.size }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 12);
  const recurTotal = recurring.reduce((s, r) => s + r.avg, 0);

  document.getElementById('recurringList').innerHTML = recurring.length
    ? recurring.map(r => `<div class="rec-item"><div><div class="rec-name">${r.name}</div><div class="rec-freq">Detected ${r.count} months</div></div><div class="rec-amt">−${fmt(r.avg)}/mo</div></div>`).join('')
      + `<div class="rec-item rec-total"><div class="rec-name">Total recurring</div><div class="rec-amt">−${fmt(recurTotal)}/mo</div></div>`
    : '<p class="empty-msg">Not enough history to detect recurring payments</p>';

  document.getElementById('budgetTxList').innerHTML = txHTML(payments, 50);
}

// ── SAVINGS tab ───────────────────────────────────────────────────────────────
function renderSavings() {
  const savAccs     = byIds(ACCT.savings);
  const savPayments = drFilter(paymentsFor(ACCT.savings));
  const months      = drMonths();
  const totalSaved  = balance(savAccs);
  const { start }   = thisMonth();

  const budgetPay      = drFilter(paymentsFor(ACCT.budget));
  const monthlyIncome  = budgetPay.filter(p => new Date(p.created) >= start && amt(p) > 0).reduce((s, p) => s + amt(p), 0);
  const monthlySavings = savPayments.filter(p => new Date(p.created) >= start && amt(p) > 0).reduce((s, p) => s + amt(p), 0);
  const savRate        = monthlyIncome > 0 ? ((monthlySavings / monthlyIncome) * 100).toFixed(1) + '%' : '—';

  document.getElementById('savings-kpis').innerHTML =
    kpi('Total saved', 'ti-pig-money', fmt(totalSaved), savAccs.map(a => a.description).join(', '), 'neu', true) +
    kpi('Saved this month', 'ti-arrow-down', fmt(monthlySavings), 'Into savings accounts', 'pos') +
    kpi('Savings rate', 'ti-percentage', savRate, 'vs income this month', 'neu');

  // Reconstruct balance trend from current balance + historical net flows
  const monthFlows = months.map(({ start, end }) =>
    savPayments.filter(p => { const d = new Date(p.created); return d >= start && d < end; }).reduce((s, p) => s + amt(p), 0)
  );
  const trend = [];
  let running = totalSaved;
  for (let i = monthFlows.length - 1; i >= 0; i--) { trend[i] = Math.round(running); running -= monthFlows[i]; }
  areaChart('savingsArea', 'savingsAreaChart', months.map(m => m.label), trend, '#e7255a');

  renderGoalList('goalsList',   state.goals,    'ti-target');
  renderGoalList('holidayList', state.holidays, 'ti-plane');
}

function renderGoalList(elId, items, icon) {
  const el = document.getElementById(elId);
  if (!items.length) { el.innerHTML = '<p class="empty-msg">None yet — tap + Add</p>'; return; }
  el.innerHTML = items.map((g, i) => {
    const pct = g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0;
    return `<div class="goal-item">
      <div class="goal-top">
        <span class="goal-name"><i class="ti ${icon}" aria-hidden="true"></i>${g.name}${g.date ? ' · ' + g.date : ''}</span>
        <span class="goal-amt">${fmt(g.saved)} / ${fmt(g.target)}</span>
      </div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%;background:${COLORS[i % COLORS.length]}"></div></div>
      <div class="goal-sub">${pct}% complete · ${fmt(g.target - g.saved)} remaining</div>
    </div>`;
  }).join('');
}

document.getElementById('addGoalBtn').addEventListener('click',    () => addGoal('goals'));
document.getElementById('addHolidayBtn').addEventListener('click', () => addGoal('holidays'));

function addGoal(type) {
  const name   = prompt('Goal name:');
  if (!name) return;
  const target = parseFloat(prompt('Target amount (€):'));
  if (!target || isNaN(target)) return;
  const saved = parseFloat(prompt('Already saved (€):') || '0') || 0;
  const goal  = { name, target, saved };
  if (type === 'holidays') goal.date = prompt('Travel date (e.g. Aug 2026):') || '';
  state[type].push(goal);
  store.set(type, state[type]);
  renderSavings();
}

// ── INVESTMENTS tab ───────────────────────────────────────────────────────────
function renderInvestments() {
  const { alpacaAccount: acc, alpacaPositions: pos } = state;
  const kpiEl = document.getElementById('invest-kpis');

  if (!acc) {
    kpiEl.innerHTML = '<div class="error-card" style="grid-column:span 2"><i class="ti ti-plug" aria-hidden="true"></i>Alpaca not connected</div>';
    return;
  }

  const equity  = parseFloat(acc.equity      || 0);
  const last    = parseFloat(acc.last_equity  || 0);
  const todayPL = equity - last;
  const totalPL = pos.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);
  const cash    = parseFloat(acc.cash || 0);

  kpiEl.innerHTML =
    kpi('Portfolio value', 'ti-chart-line',   fmt(equity),           '',                                                        '',                      true) +
    kpi("Today's P&L",     'ti-trending-up',  fmtSign(todayPL),      last ? ((todayPL / last * 100).toFixed(2) + '%') : '',     todayPL >= 0 ? 'pos' : 'neg') +
    kpi('Unrealised P&L',  'ti-calculator',   fmtSign(totalPL),      'All open positions',                                      totalPL >= 0 ? 'pos' : 'neg') +
    kpi('Cash available',  'ti-currency-euro', fmt(cash));

  // Allocation donut
  const groups = {};
  for (const p of pos) {
    const v = parseFloat(p.market_value || 0);
    groups[/^(V|I)/.test(p.symbol) ? 'ETFs' : 'Stocks'] = (groups[/^(V|I)/.test(p.symbol) ? 'ETFs' : 'Stocks'] || 0) + v;
  }
  if (cash > 0) groups['Cash'] = cash;
  const gLabels = Object.keys(groups), gValues = Object.values(groups).map(v => Math.round(v));

  destroyChart('alloc');
  const allocCtx = document.getElementById('allocChart');
  if (allocCtx) {
    state.charts.alloc = new Chart(allocCtx, {
      type: 'doughnut',
      data: { labels: gLabels, datasets: [{ data: gValues, backgroundColor: COLORS.slice(0, gLabels.length), borderWidth: 0, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + c.label + ': ' + fmt(c.parsed) } } } },
    });
  }

  document.getElementById('allocLegend').innerHTML = gLabels.map((l, i) =>
    `<div class="alloc-item"><div class="alloc-dot" style="background:${COLORS[i]}"></div><span class="alloc-name">${l}</span><span class="alloc-pct">${equity > 0 ? ((gValues[i] / equity) * 100).toFixed(1) : 0}%</span></div>`
  ).join('');

  const maxVal = Math.max(...pos.map(p => parseFloat(p.market_value || 0)), 1);
  document.getElementById('positionsList').innerHTML = [...pos]
    .sort((a, b) => parseFloat(b.market_value) - parseFloat(a.market_value))
    .map(p => {
      const v = parseFloat(p.market_value || 0), pl = parseFloat(p.unrealized_plpc || 0) * 100;
      const cls = pl >= 0 ? 'pos' : 'neg', barCol = pl >= 0 ? '#2a7d5f' : '#e7255a';
      return `<div class="pos-item">
        <span class="pos-tk">${p.symbol}</span>
        <div class="pos-bar-wrap"><div class="pos-bar-bg"><div class="pos-bar-fill" style="width:${((v / maxVal) * 100).toFixed(1)}%;background:${barCol}"></div></div></div>
        <span class="pos-val">${fmt(v)}</span>
        <span class="pos-pl ${cls}">${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%</span>
      </div>`;
    }).join('');
}

// ── Loading state ─────────────────────────────────────────────────────────────
function showPageLoading(page) {
  const spinner = '<div class="loading"><div class="spinner"></div>Loading data…</div>';
  const ids = {
    flii:        ['flii-kpis', 'fliiTxList'],
    holding:     ['holding-kpis', 'holdingTxList'],
    budget:      ['budget-kpis', 'budgetTxList'],
    savings:     ['savings-kpis'],
    investments: ['invest-kpis'],
  }[page] || [];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = spinner; });
}

// ── API ───────────────────────────────────────────────────────────────────────
async function bunqProxy(action, params = {}, retried = false) {
  const qs  = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`/api/bunq?${qs}`);
  const json = await res.json();
  if (!res.ok && json.expired && !retried) return bunqProxy(action, params, true);
  if (!res.ok) throw new Error(json.error || `Bunq ${res.status}`);
  return json;
}

function setConn(id, status) {
  const dot = document.getElementById(id + 'Dot');
  const lbl = document.getElementById(id + 'Label');
  if (!dot) return;
  dot.className = 'dot' + (status === 'ok' ? '' : status === 'loading' ? ' amber' : ' red');
  if (lbl) lbl.style.color = status === 'ok' ? 'var(--pos)' : status === 'error' ? 'var(--neg)' : '#c97d00';
}

async function loadBunq() {
  setConn('bunq', 'loading');
  showPageLoading('flii');
  try {
    const { accounts } = await bunqProxy('accounts');
    state.accounts = accounts;

    // Fetch all account payments in parallel
    const results = await Promise.allSettled(
      accounts.map(a => bunqProxy('payments', { accountId: a.id, userId: a.userId }).then(r => ({ id: a.id, payments: r.payments })))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') state.payments[r.value.id] = r.value.payments;
    }
    setConn('bunq', 'ok');
    renderActive();
  } catch (err) {
    console.error('Bunq:', err.message);
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
    console.error('Alpaca:', err.message);
    setConn('alpaca', 'error');
  }
}

async function loadAllData() {
  await Promise.allSettled([loadBunq(), loadAlpaca()]);
  state.lastSync = new Date();
}

// ── Init ──────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
setConn('bunq', 'loading');
setConn('alpaca', 'loading');
loadAllData();
