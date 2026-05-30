'use strict';

// ── Storage ───────────────────────────────────────────────────────────────────
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  accounts: [], payments: {}, alpacaAccount: null, alpacaPositions: [],
  goals: store.get('goals') || [], holidays: store.get('holidays') || [],
  charts: {}, lastSync: null,
};

// ── Account routing ───────────────────────────────────────────────────────────
const ACCT = {
  flii:    [3408701],
  holding: [3408705],
  budget:  [4172851, 2560176],
  savings: [16714864],
};

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS  = ['#e7255a','#f05a84','#f78faa','#fbc4d4','#ccc9c1','#a8a8a0'];
const GC = 'rgba(0,0,0,0.05)', TC = '#a0a0a0';
const VPB_LOW = 0.19, VPB_HI = 0.258, VPB_THR = 200_000;

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt         = (n, d=2) => '€' + Number(n).toLocaleString('nl-NL', {minimumFractionDigits:d, maximumFractionDigits:d});
const fmtK        = n => Math.abs(n) >= 1000 ? (n<0?'−':'')+'€'+(Math.abs(n)/1000).toFixed(1)+'k' : fmt(Math.abs(n),0);
const fmtSign     = (n,d=2) => (n>=0?'+':'−')+fmt(Math.abs(n),d);
const fmtPct      = n => n.toFixed(1)+'%';
const fmtDate     = d => new Date(d).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
const fmtMon      = m => new Date(m+'-01').toLocaleString('default',{month:'short',year:'numeric'});
const fmtMonShort = m => new Date(m+'-01').toLocaleString('default',{month:'short'});

// ── Account helpers ───────────────────────────────────────────────────────────
const byIds       = ids => state.accounts.filter(a => ids.includes(a.id));
const balance     = accs => accs.reduce((s,a) => s + parseFloat(a.balance?.value||0), 0);
const paymentsFor = ids => ids.flatMap(id => state.payments[id]||[]).sort((a,b) => new Date(b.created)-new Date(a.created));
const amt         = p => parseFloat(p.amount?.value||0);
const cpName      = p => p.counterparty?.display_name || p.description || 'Unknown';

// ── Date range ────────────────────────────────────────────────────────────────
const DR = { start: new Date(new Date().getFullYear(),0,1), end: new Date(), preset:'ytd' };

function drMonths() {
  const months=[], cursor=new Date(DR.start.getFullYear(),DR.start.getMonth(),1);
  const endMon=new Date(DR.end.getFullYear(),DR.end.getMonth(),1);
  while(cursor<=endMon){
    months.push({label:cursor.toLocaleString('default',{month:'short'}),start:new Date(cursor),end:new Date(cursor.getFullYear(),cursor.getMonth()+1,1)});
    cursor.setMonth(cursor.getMonth()+1);
  }
  return months;
}
const drFilter    = ps => ps.filter(p=>{const d=new Date(p.created);return d>=DR.start&&d<=DR.end;});
const thisMonth   = () => {const n=new Date();return{start:new Date(n.getFullYear(),n.getMonth(),1),end:new Date(n.getFullYear(),n.getMonth()+1,1)};};

function monthlyTotals(payments, months) {
  return months.map(({start,end}) => {
    let income=0,expenses=0;
    for(const p of payments){const v=amt(p),d=new Date(p.created);if(d<start||d>=end)continue;if(v>0)income+=v;else expenses+=Math.abs(v);}
    return {income,expenses,net:income-expenses};
  });
}
const recentMonths = (ps,n=6) => [...new Set(ps.map(p=>p.created.slice(0,7)))].sort().reverse().slice(0,n).reverse();

// ── Categorise ────────────────────────────────────────────────────────────────
// Business labels (used for Flii Media + SB Holding accounts)
const BIZ_RULES = [
  [/belastingdienst/i, p => {
    const s=(p.description||'').toLowerCase();
    if(/btw|omzetbelasting/i.test(s))   return 'Tax — BTW';
    if(/vpb|vennootschap/i.test(s))     return 'Tax — VPB';
    if(/loonheffing|loonbelasting/i.test(s)) return 'Tax — Loonheffing';
    if(/inkomstenbelasting|ib/i.test(s)) return 'Tax — IB';
    return 'Tax';
  }],
  [/salary|salaris|loon|management fee|dga|directeur|bezoldiging/i, () => 'Wage'],
  [/dividend/i, () => 'Dividend'],
  [/accountant|boekhouder|administratie|notaris|juridisch|legal|audit/i, () => 'Professional services'],
  [/verzekering|insurance/i, () => 'Insurance'],
  [/reclame|marketing|advertentie|google ads|meta ads|linkedin/i, () => 'Marketing'],
  [/software|saas|hosting|domain|cloudflare|aws|azure|vercel|github/i, () => 'Software & hosting'],
  [/telefoon|mobiel|internet|kpn|vodafone|t-mobile|tele2/i, () => 'Telecom'],
  [/lease|huur|rent|kantoor|office/i, () => 'Rent & facilities'],
  [/reizen|travel|hotel|vlieg|flight|trein|ns |booking|airbnb/i, () => 'Travel'],
  [/zakelijk|business|inkoop|material|supplies/i, () => 'Business expense'],
];

// Personal labels (used for Budget + Savings accounts)
const PERSONAL_RULES = [
  // Housing
  [/huur|hypotheek|mortgage|rent|nuon|vattenfall|eneco|essent|iberdrola|endesa|naturgy|water|gas en elektra/i, () => 'Housing'],
  // Groceries — NL + ES vendors
  [/albert heijn|ah|jumbo|lidl|aldi|plus supermarkt|dirk|coop|spar|vomar|picnic|gorillas|getir|mercadona|dia|eroski|carrefour|consum|alcampo|el corte ingles|supeco/i, () => 'Groceries'],
  // Dining
  [/restaurant|cafe|café|bar|bistro|pizz|burger|mcdonalds|kfc|subway|domino|sushi|thuisbezorgd|just eat|uber eats|deliveroo|glovo|takeaway|eten\.nl/i, () => 'Dining'],
  // Transport — fuel
  [/shell|bp|esso|total|texaco|tinq|tamoil|repsol|cepsa|q8|argos tankstation/i, () => 'Fuel'],
  // Transport — public/ride
  [/ns\.nl|ns groep|ov|ov-chipkaart|gvb|ret|htm|connexxion|arriva|uber|bolt|taxi|cabify|blablacar/i, () => 'Transport'],
  // Transport — parking/tolls
  [/parking|parkeer|q-park|p\+r|autopistas|peaje|vignette/i, () => 'Parking'],
  // Subscriptions & streaming
  [/netflix|spotify|apple|disney\+|videoland|npo plus|hbo|amazon prime|youtube premium|deezer|tidal/i, () => 'Streaming'],
  // Telecom
  [/kpn|vodafone|t-mobile|tele2|simpel|ben|lebara|movistar|orange|yoigo|masmovil/i, () => 'Telecom'],
  // Insurance
  [/verzekering|centraal beheer|nationale nederlanden|aegon|allianz|axa|generali|mapfre|mutua/i, () => 'Insurance'],
  // Health
  [/apotheek|pharmacy|dokter|huisarts|tandarts|ziekenhuis|hospital|farmacia|clinica|drogist|etos|kruidvat|boots/i, () => 'Health'],
  // Clothing & personal
  [/zara|h&m|uniqlo|primark|mango|cos|nike|adidas|zalando|bol\.com|coolblue|decathlon|ikea|mediamarkt/i, () => 'Shopping'],
  // Financial
  [/rente|interest|aflossing|spaar|savings|belegging|degiro|etoro/i, () => 'Financial'],
  // Salary in
  [/salaris|salary|loon|payroll|bezoldiging/i, () => 'Salary'],
  // Tax
  [/belastingdienst/i, p => {
    const s=(p.description||'').toLowerCase();
    if(/btw/i.test(s)) return 'Tax — BTW';
    if(/vpb/i.test(s)) return 'Tax — VPB';
    if(/loonheffing/i.test(s)) return 'Tax — Loonheffing';
    return 'Tax';
  }],
];

// Route to correct ruleset based on account ID
const BIZ_IDS = new Set([...ACCT.flii, ...ACCT.holding]);

function categorise(p, accountId) {
  const s = (p.description || '') + ' ' + cpName(p);
  const rules = (accountId && BIZ_IDS.has(accountId)) ? BIZ_RULES : PERSONAL_RULES;
  for (const [re, fn] of rules) if (re.test(s)) return fn(p);
  return 'Other';
}

// Detect intercompany flows
const isIntercompany = p => {
  const s = cpName(p).toLowerCase();
  return s.includes('flii') || s.includes('holding') || s.includes('sb ');
};

// ── Tax helpers ───────────────────────────────────────────────────────────────
const isBelastingdienst = p => /belastingdienst/i.test(cpName(p)+' '+(p.description||''));

function detectTaxType(p) {
  const s=(p.description||'')+' '+cpName(p);
  if(/\bbtw\b|omzetbelasting|\bvat\b/i.test(s))  return 'BTW';
  if(/\bvpb\b|vennootschapsbelasting/i.test(s))   return 'VPB';
  if(/\bloonheffing\b|loonbelasting/i.test(s))    return 'Loonheffing';
  if(/\bdividend/i.test(s))                       return 'Dividendbelasting';
  if(/\bib\b|inkomstenbelasting/i.test(s))        return 'IB';
  return 'Unknown';
}

function vatRate(p) {
  const s=(p.description||'')+' '+cpName(p);
  if(/transport|taxi|trein|bus|vlieg|flight|\bov\b|\bns\b|ryanair|easyjet/i.test(s)) return 0;
  if(/food|grocery|supermarkt|mercadona|lidl|aldi|restaurant|cafe|café|dining|lunch|dinner|eten/i.test(s)) return 0.09;
  return 0.21;
}

function calcBTW(payments, year, quarter) {
  const start=new Date(year,(quarter-1)*3,1), end=new Date(year,quarter*3,1);
  const qPay=payments.filter(p=>{const d=new Date(p.created);return d>=start&&d<end;});
  const outputVAT=qPay.filter(p=>amt(p)>0&&!isBelastingdienst(p)).reduce((s,p)=>{const g=amt(p);return s+(g-g/1.21);},0);
  const inputVAT=qPay.filter(p=>amt(p)<0&&!isBelastingdienst(p)).reduce((s,p)=>{const r=vatRate(p);if(!r)return s;const g=Math.abs(amt(p));return s+(g-g/(1+r));},0);
  return {outputVAT,inputVAT,due:outputVAT-inputVAT};
}

function calcVPB(payments, year) {
  const start=new Date(year,0,1),now=new Date();
  const yPay=payments.filter(p=>{const d=new Date(p.created);return d>=start&&!isBelastingdienst(p);});
  const revenue=yPay.filter(p=>amt(p)>0).reduce((s,p)=>s+amt(p),0);
  const expenses=yPay.filter(p=>amt(p)<0).reduce((s,p)=>s+Math.abs(amt(p)),0);
  const ytdProfit=revenue-expenses;
  const mElapsed=now.getFullYear()===year?now.getMonth()+now.getDate()/30:12;
  const projected=mElapsed>0?(ytdProfit/mElapsed)*12:0;
  const vpb=projected<=VPB_THR?Math.max(0,projected*VPB_LOW):VPB_THR*VPB_LOW+Math.max(0,projected-VPB_THR)*VPB_HI;
  return {ytdProfit,projected,vpb,mElapsed};
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
function destroyChart(key){if(state.charts[key]){state.charts[key].destroy();delete state.charts[key];}}

function baseScales(horizontal=false){
  const num={ticks:{color:TC,font:{size:11},callback:v=>fmtK(v)},grid:{color:GC},border:{display:false}};
  const cat={ticks:{color:TC,font:{size:11}},grid:{display:false},border:{display:false}};
  return horizontal?{x:num,y:cat}:{x:cat,y:num};
}

function mkChart(key,canvasId,type,data,options={}){
  destroyChart(key);
  const ctx=document.getElementById(canvasId);
  if(!ctx)return;
  state.charts[key]=new Chart(ctx,{type,data,options:{responsive:true,maintainAspectRatio:false,...options}});
}

function areaChart(key,canvasId,labels,data,color){
  mkChart(key,canvasId,'line',{labels,datasets:[{data,borderColor:color,backgroundColor:color+'22',fill:true,tension:0.4,pointRadius:3,pointBackgroundColor:color}]},
    {plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmtK(c.parsed.y)}}},scales:baseScales()});
}

function groupedBar(key,canvasId,labels,incData,expData){
  mkChart(key,canvasId,'bar',{labels,datasets:[
    {label:'In',data:incData,backgroundColor:'#2a7d5f',borderRadius:3},
    {label:'Out',data:expData,backgroundColor:'#e7255a',borderRadius:3},
  ]},{plugins:{legend:{position:'top',labels:{color:TC,font:{size:11},boxWidth:8,padding:10}},tooltip:{callbacks:{label:c=>' '+fmtK(c.parsed.y)}}},scales:baseScales()});
}

function hBar(key,canvasId,labels,data,colors){
  const canvas=document.getElementById(canvasId);
  if(canvas)canvas.parentElement.style.height=Math.max(120,labels.length*34)+'px';
  mkChart(key,canvasId,'bar',{labels,datasets:[{data,backgroundColor:colors,borderRadius:3}]},
    {indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmtK(c.parsed.x)}}},scales:baseScales(true)});
}

function donut(key,canvasId,labels,data,colors){
  destroyChart(key);
  const ctx=document.getElementById(canvasId);
  if(!ctx)return;
  state.charts[key]=new Chart(ctx,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:0,hoverOffset:4}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+c.label+': '+fmtK(c.parsed)}}}}});
}

// ── KPI builder ───────────────────────────────────────────────────────────────
const kpi=(label,icon,value,sub='',subCls='',full=false)=>
  `<div class="kpi${full?' full':''}"><div class="kpi-lbl"><i class="ti ${icon}" aria-hidden="true"></i>${label}</div><div class="kpi-val">${value}</div>${sub?`<div class="kpi-sub ${subCls}">${sub}</div>`:''}</div>`;

// ── Transactions ──────────────────────────────────────────────────────────────
const CAT_ICONS={Housing:'ti-home',Groceries:'ti-shopping-cart',Dining:'ti-tool-kitchen-2',Transport:'ti-car',Subscriptions:'ti-device-mobile',Tax:'ti-receipt-tax',Salary:'ti-arrow-down',Other:'ti-dots'};

function txHTML(payments, limit=40, accountId=null){
  if(!payments.length)return '<p class="empty-msg">No transactions</p>';
  return payments.slice(0,limit).map(p=>{
    const v=amt(p),pos=v>0,name=cpName(p),cat=categorise(p,accountId),icon=pos?'ti-arrow-down':(CAT_ICONS[cat]||'ti-dots');
    return `<div class="tx"><div class="tx-ico" style="background:${pos?'#edf7f3':'#fdeef2'}"><i class="ti ${icon}" style="color:${pos?'#2a7d5f':'#e7255a'}" aria-hidden="true"></i></div><div class="tx-info"><div class="tx-name">${name}</div><div class="tx-cat">${cat} · ${fmtDate(p.created)}</div></div><div class="tx-amt ${pos?'pos':'neg'}">${pos?'+':'−'}${fmt(Math.abs(v))}</div></div>`;
  }).join('');
}

// ── Table helpers ─────────────────────────────────────────────────────────────
function groupBy(payments,keyFn,valFn=p=>Math.abs(amt(p))){
  const map={};
  for(const p of payments){const k=keyFn(p),m=p.created.slice(0,7),v=valFn(p);if(!map[k])map[k]={total:0,months:{}};map[k].total+=v;map[k].months[m]=(map[k].months[m]||0)+v;}
  return Object.entries(map).sort((a,b)=>b[1].total-a[1].total);
}

function renderTable(elId,rows,months,totalLabel,valCls){
  const el=document.getElementById(elId);if(!el)return;
  if(!rows.length){el.innerHTML='<p class="table-empty">No data</p>';return;}
  const grand=rows.reduce((s,[,d])=>s+d.total,0);
  el.innerHTML=`<div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th>${months.map(m=>`<th class="num">${fmtMonShort(m)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${rows.map(([name,data])=>`<tr><td class="bold">${name}</td>${months.map(m=>`<td class="num">${data.months[m]?fmt(data.months[m]):'—'}</td>`).join('')}<td class="num ${valCls}">${fmt(data.total)}</td></tr>`).join('')}<tr class="total-row"><td>${totalLabel}</td>${months.map(m=>{const t=rows.reduce((s,[,d])=>s+(d.months[m]||0),0);return`<td class="num">${t?fmt(t):'—'}</td>`;}).join('')}<td class="num ${valCls}">${fmt(grand)}</td></tr></tbody></table></div>`;
}

// ── Tax table ─────────────────────────────────────────────────────────────────
function renderTaxTable(elId, payments) {
  const el=document.getElementById(elId);if(!el)return;
  const now=new Date(),year=now.getFullYear(),q=Math.ceil((now.getMonth()+1)/3);
  const btw=calcBTW(payments,year,q), vpb=calcVPB(payments,year);
  const taxPay=payments.filter(p=>isBelastingdienst(p)&&amt(p)<0);
  const totalPaid=taxPay.reduce((s,p)=>s+Math.abs(amt(p)),0);
  const byType={};
  for(const p of taxPay){const t=detectTaxType(p),v=Math.abs(amt(p));if(!byType[t])byType[t]={total:0,months:{}};byType[t].total+=v;const m=p.created.slice(0,7);byType[t].months[m]=(byType[t].months[m]||0)+v;}

  // Summary KPIs
  let html=`<div class="tax-kpi-row">
    <div class="tax-kpi"><div class="tax-kpi-lbl">Paid YTD</div><div class="tax-kpi-val neg-val">${fmt(totalPaid)}</div><div class="tax-kpi-sub">Belastingdienst</div></div>
    <div class="tax-kpi"><div class="tax-kpi-lbl">BTW · Q${q}</div><div class="tax-kpi-val ${btw.due>0?'neg-val':'pos-val'}">${fmt(Math.max(0,btw.due))}</div><div class="tax-kpi-sub">Quarterly · file Q end</div></div>
    <div class="tax-kpi"><div class="tax-kpi-lbl">VPB · ${year}</div><div class="tax-kpi-val neg-val">${fmt(vpb.vpb)}</div><div class="tax-kpi-sub">Annual · ${vpb.mElapsed.toFixed(1)}mo data</div></div>
  </div>`;

  // Main projection table
  const rows=[
    {type:'BTW',paid:byType['BTW']?.total||0,due:Math.max(0,btw.due),basis:`Output ${fmt(btw.outputVAT)} − Input ${fmt(btw.inputVAT)}`},
    {type:'VPB',paid:byType['VPB']?.total||0,due:vpb.vpb,basis:`${fmt(vpb.projected)} projected profit × ${vpb.projected<=VPB_THR?'19%':'19/25.8%'}`},
    byType['Loonheffing']&&{type:'Loonheffing',paid:byType['Loonheffing'].total,due:null,basis:'Monthly payroll'},
    byType['Unknown']&&{type:'Unknown',paid:byType['Unknown'].total,due:null,basis:'Type undetected'},
  ].filter(Boolean).filter(r=>r.paid>0||(r.due??0)>0);

  html+=`<div class="table-scroll" style="margin-top:14px"><table class="data-table">
    <thead><tr><th>Type</th><th class="num">Paid YTD</th><th class="num">Projected due</th><th>Basis</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td><span class="tax-badge">${r.type}</span></td>
      <td class="num ${r.paid>0?'neg-val':'neu'}">${r.paid>0?fmt(r.paid):'—'}</td>
      <td class="num ${r.due>0?'neg-val':'neu'}">${r.due!=null?fmt(r.due):'—'}</td>
      <td class="tax-basis">${r.basis}</td>
    </tr>`).join('')}
    ${totalPaid>0?`<tr class="total-row"><td>Total</td><td class="num neg-val">${fmt(totalPaid)}</td><td class="num neg-val">${fmt(Math.max(0,btw.due)+vpb.vpb)}</td><td></td></tr>`:''}
    </tbody></table></div>`;

  // Payment history
  if(taxPay.length){
    const types=[...new Set(taxPay.map(detectTaxType))].sort();
    const byMonth={};
    for(const p of taxPay){const m=p.created.slice(0,7),t=detectTaxType(p);if(!byMonth[m])byMonth[m]={};byMonth[m][t]=(byMonth[m][t]||0)+Math.abs(amt(p));}
    const months=Object.keys(byMonth).sort().reverse();
    html+=`<p class="table-section-label" style="margin-top:18px">Payment history</p><div class="table-scroll"><table class="data-table"><thead><tr><th>Month</th>${types.map(t=>`<th class="num">${t}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
    ${months.map(m=>{const total=Object.values(byMonth[m]).reduce((s,v)=>s+v,0);return`<tr><td class="bold">${fmtMon(m)}</td>${types.map(t=>`<td class="num">${byMonth[m][t]?fmt(byMonth[m][t]):'—'}</td>`).join('')}<td class="num neg-val">${fmt(total)}</td></tr>`;}).join('')}
    <tr class="total-row"><td>Total</td>${types.map(t=>{const tot=months.reduce((s,m)=>s+(byMonth[m][t]||0),0);return`<td class="num">${tot?fmt(tot):'—'}</td>`;}).join('')}<td class="num neg-val">${fmt(totalPaid)}</td></tr>
    </tbody></table></div>`;
  }

  el.innerHTML=html;
}

// ── Navigation ────────────────────────────────────────────────────────────────
const RENDERERS={flii:()=>renderFlii(),holding:()=>renderHolding(),budget:renderBudget,savings:renderSavings,investments:renderInvestments};
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-'+btn.dataset.page).classList.add('active');
    RENDERERS[btn.dataset.page]?.();
  });
});
const renderActive=()=>RENDERERS[document.querySelector('.nav-item.active')?.dataset.page||'flii']?.();

// ── Settings ──────────────────────────────────────────────────────────────────
const overlay=document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click',()=>{
  document.getElementById('lastSyncTime').textContent=state.lastSync?state.lastSync.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'—';
  overlay.classList.add('open');
});
overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open');});
document.getElementById('closeSettingsBtn').addEventListener('click',()=>overlay.classList.remove('open'));

// ── Date range ────────────────────────────────────────────────────────────────
const dateOverlay=document.getElementById('dateOverlay');
function setDateRange(start,end,preset){DR.start=start;DR.end=end;DR.preset=preset;document.querySelectorAll('.dr-preset').forEach(b=>b.classList.toggle('active',b.dataset.preset===preset));renderActive();}
function presetRange(preset){const now=new Date();const ranges={ytd:[new Date(now.getFullYear(),0,1),new Date()],'3m':[new Date(now.getFullYear(),now.getMonth()-2,1),new Date()],'6m':[new Date(now.getFullYear(),now.getMonth()-5,1),new Date()],'12m':[new Date(now.getFullYear(),now.getMonth()-11,1),new Date()]};if(ranges[preset])setDateRange(...ranges[preset],preset);}
document.querySelectorAll('.dr-preset[data-preset]').forEach(btn=>{btn.addEventListener('click',()=>{if(btn.dataset.preset==='custom'){const pad=n=>String(n).padStart(2,'0'),toVal=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;document.getElementById('drFrom').value=toVal(DR.start);document.getElementById('drTo').value=toVal(DR.end);dateOverlay.classList.add('open');}else presetRange(btn.dataset.preset);});});
dateOverlay.addEventListener('click',e=>{if(e.target===dateOverlay)dateOverlay.classList.remove('open');});
document.getElementById('drApplyBtn').addEventListener('click',()=>{const from=new Date(document.getElementById('drFrom').value),to=new Date(document.getElementById('drTo').value);if(isNaN(from)||isNaN(to)||from>to)return;to.setHours(23,59,59);dateOverlay.classList.remove('open');setDateRange(from,to,'custom');});

// ── Refresh ───────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').addEventListener('click',async()=>{const icon=document.querySelector('#refreshBtn i');icon.style.animation='spin .7s linear infinite';await loadAllData();icon.style.animation='';});

// ── FLII MEDIA ────────────────────────────────────────────────────────────────
function renderFlii() {
  const payments=drFilter(paymentsFor(ACCT.flii));
  const months=drMonths(), totals=monthlyTotals(payments,months);
  const accs=byIds(ACCT.flii), bal=balance(accs);
  const {start}=thisMonth();

  const thisM=totals[totals.length-1]||{income:0,expenses:0,net:0};
  const lastM=totals[totals.length-2]||{income:0,expenses:0,net:0};
  const incoming=payments.filter(p=>amt(p)>0&&!isBelastingdienst(p));
  const outgoing=payments.filter(p=>amt(p)<0&&!isBelastingdienst(p));
  const totalRev=incoming.reduce((s,p)=>s+amt(p),0);
  const totalExp=outgoing.reduce((s,p)=>s+Math.abs(amt(p)),0);
  const grossMargin=totalRev>0?((totalRev-totalExp)/totalRev*100):0;

  // Revenue concentration: top client as % of total
  const byClient=groupBy(incoming,cpName,p=>amt(p));
  const topClientPct=byClient.length&&totalRev>0?((byClient[0][1].total/totalRev)*100):0;
  const topClientName=byClient[0]?.[0]||'—';

  document.getElementById('flii-kpis').innerHTML=
    kpi('Balance','ti-building-bank',fmt(bal))+
    kpi('Net','ti-trending-up',fmtSign(thisM.net),(thisM.net>=lastM.net?'▲ ':'▼ ')+fmt(Math.abs(thisM.net-lastM.net))+' vs last month',thisM.net>=lastM.net?'pos':'neg')+
    kpi('Revenue','ti-arrow-down',fmt(totalRev),'In period')+
    kpi('Gross margin','ti-percentage',fmtPct(grossMargin),'Revenue − expenses',grossMargin>=50?'pos':grossMargin>=30?'neu':'neg');

  // Cashflow trend
  areaChart('fliiArea','fliiAreaChart',months.map(m=>m.label),totals.map(t=>Math.round(t.net)),'#e7255a');

  // Revenue vs expenses
  groupedBar('fliiBar','fliiBarChart',months.map(m=>m.label),totals.map(t=>Math.round(t.income)),totals.map(t=>Math.round(t.expenses)));

  // Revenue concentration donut
  const topClients=byClient.slice(0,5);
  const otherRev=totalRev-topClients.reduce((s,[,d])=>s+d.total,0);
  const concLabels=[...topClients.map(([n])=>n),otherRev>0?'Other':null].filter(Boolean);
  const concData=[...topClients.map(([,d])=>Math.round(d.total)),otherRev>0?Math.round(otherRev):null].filter(v=>v!==null);
  donut('fliiConc','fliiConcChart',concLabels,concData,COLORS.slice(0,concLabels.length));
  document.getElementById('fliiConcLegend').innerHTML=concLabels.map((l,i)=>`<div class="alloc-item"><div class="alloc-dot" style="background:${COLORS[i]}"></div><span class="alloc-name">${l}</span><span class="alloc-pct">${totalRev>0?fmtPct(concData[i]/totalRev*100):'—'}</span></div>`).join('');
  // Concentration warning
  document.getElementById('fliiConcWarn').innerHTML=topClientPct>40?`<div class="flag flag-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i>${topClientName} = ${fmtPct(topClientPct)} of revenue</div>`:'';

  // Expense breakdown by category
  const expCats={};
  for(const p of outgoing){const cat=categorise(p,ACCT.flii[0]);expCats[cat]=(expCats[cat]||0)+Math.abs(amt(p));}
  const expSorted=Object.entries(expCats).sort((a,b)=>b[1]-a[1]);
  hBar('fliiExpCat','fliiExpCatChart',expSorted.map(([k])=>k),expSorted.map(([,v])=>Math.round(v)),expSorted.map((_,i)=>COLORS[i%COLORS.length]));

  // Tax
  renderTaxTable('fliiTaxTable',payments);

  // Client & provider tables
  renderTable('fliiClientTable',byClient.slice(0,15),recentMonths(incoming),'Total','pos-val');
  renderTable('fliiProviderTable',groupBy(outgoing,cpName).slice(0,15),recentMonths(outgoing),'Total','neg-val');

  document.getElementById('fliiTxCount').textContent=payments.length+' transactions';
  document.getElementById('fliiTxList').innerHTML=txHTML(payments,200,ACCT.flii[0]);
}

// ── SB HOLDING ────────────────────────────────────────────────────────────────
function renderHolding() {
  const payments=drFilter(paymentsFor(ACCT.holding));
  const months=drMonths(), totals=monthlyTotals(payments,months);
  const accs=byIds(ACCT.holding), bal=balance(accs);

  // Management fees in, wages/salary out
  const mgmtFees=payments.filter(p=>amt(p)>0&&!isBelastingdienst(p));
  const wages=payments.filter(p=>amt(p)<0&&!isBelastingdienst(p)&&/salary|salaris|loon|management|dga|directeur/i.test((p.description||'')+cpName(p)));
  const intercompany=payments.filter(p=>isIntercompany(p));
  const totalFees=mgmtFees.reduce((s,p)=>s+amt(p),0);
  const totalWages=wages.reduce((s,p)=>s+Math.abs(amt(p)),0);
  const thisM=totals[totals.length-1]||{income:0,expenses:0,net:0};
  const lastM=totals[totals.length-2]||{income:0,expenses:0,net:0};

  // Running balance trend
  const monthFlows=months.map(({start,end})=>payments.filter(p=>{const d=new Date(p.created);return d>=start&&d<end;}).reduce((s,p)=>s+amt(p),0));
  const balTrend=[];let running=bal;
  for(let i=monthFlows.length-1;i>=0;i--){balTrend[i]=Math.round(running);running-=monthFlows[i];}

  document.getElementById('holding-kpis').innerHTML=
    kpi('Balance','ti-building-bank',fmt(bal))+
    kpi('Net','ti-trending-up',fmtSign(thisM.net),(thisM.net>=lastM.net?'▲ ':'▼ ')+fmt(Math.abs(thisM.net-lastM.net))+' vs last month',thisM.net>=lastM.net?'pos':'neg')+
    kpi('Management fees','ti-arrow-down',fmt(totalFees),'In period')+
    kpi('Wages paid','ti-arrow-up',fmt(totalWages),'DGA salary');

  // Balance over time (primary metric for a holding)
  areaChart('holdingBal','holdingBalChart',months.map(m=>m.label),balTrend,'#e7255a');

  // Cash flow in vs out
  groupedBar('holdingBar','holdingBarChart',months.map(m=>m.label),totals.map(t=>Math.round(t.income)),totals.map(t=>Math.round(t.expenses)));

  // Intercompany flows
  const icEl=document.getElementById('holdingIntercompany');
  if(intercompany.length){
    icEl.innerHTML=`<div class="table-scroll"><table class="data-table"><thead><tr><th>Counterparty</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>${intercompany.slice(0,20).map(p=>`<tr><td class="bold">${cpName(p)}</td><td>${fmtDate(p.created)}</td><td class="num ${amt(p)>0?'pos-val':'neg-val'}">${amt(p)>0?'+':'−'}${fmt(Math.abs(amt(p)))}</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    icEl.innerHTML='<p class="empty-msg">No intercompany flows detected</p>';
  }

  // Tax
  renderTaxTable('holdingTaxTable',payments);

  document.getElementById('holdingTxCount').textContent=payments.length+' transactions';
  document.getElementById('holdingTxList').innerHTML=txHTML(payments,200,ACCT.holding[0]);
}

// ── BUDGET ────────────────────────────────────────────────────────────────────
function renderBudget() {
  const payments=drFilter(paymentsFor(ACCT.budget));
  const months=drMonths(), totals=monthlyTotals(payments,months);
  const accs=byIds(ACCT.budget);
  const {start}=thisMonth();
  const thisM=totals[totals.length-1]||{income:0,expenses:0,net:0};

  // Income variance (std dev / mean)
  const incomes=totals.map(t=>t.income).filter(v=>v>0);
  const meanInc=incomes.length?incomes.reduce((s,v)=>s+v,0)/incomes.length:0;
  const incVariance=incomes.length>1?Math.sqrt(incomes.reduce((s,v)=>s+(v-meanInc)**2,0)/incomes.length)/meanInc*100:0;

  document.getElementById('budget-kpis').innerHTML=
    kpi('Balance','ti-wallet',fmt(balance(accs)),'','',true)+
    kpi('Income','ti-arrow-down',fmt(thisM.income),'This month','pos')+
    kpi('Expenses','ti-arrow-up',fmt(thisM.expenses),'This month','neg')+
    kpi('Income variance','ti-activity',fmtPct(incVariance),'Month-to-month',incVariance<15?'pos':incVariance<30?'neu':'neg');

  // Income vs expenses (6m)
  groupedBar('budgetFlow','budgetFlowChart',months.map(m=>m.label),totals.map(t=>Math.round(t.income)),totals.map(t=>Math.round(t.expenses)));

  // Month-end balance trend (approximate from flows)
  const monthFlows=months.map(({start,end})=>payments.filter(p=>{const d=new Date(p.created);return d>=start&&d<end;}).reduce((s,p)=>s+amt(p),0));
  const balTrend=[];let running=balance(accs);
  for(let i=monthFlows.length-1;i>=0;i--){balTrend[i]=Math.round(running);running-=monthFlows[i];}
  areaChart('budgetBal','budgetBalChart',months.map(m=>m.label),balTrend,'#e7255a');

  // Spending by category — in range
  const cats={};
  for(const p of payments.filter(p=>amt(p)<0)){const cat=categorise(p,null);cats[cat]=(cats[cat]||0)+Math.abs(amt(p));}
  const catSorted=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  hBar('budgetCat','budgetCatChart',catSorted.map(([k])=>k),catSorted.map(([,v])=>Math.round(v)),catSorted.map((_,i)=>COLORS[i%COLORS.length]));

  // Fixed vs variable split
  // Recurring detection: group by counterparty, require 3+ occurrences,
  // detect period (monthly ≈ 25-35 day gap, quarterly ≈ 80-100, yearly ≈ 340-390)
  const recurMap={};
  // Use all payments (not just drFiltered) for better period detection
  const allBudgetPay=paymentsFor(ACCT.budget).filter(p=>amt(p)<0);
  for(const p of allBudgetPay){
    const key=cpName(p).toLowerCase().trim();
    if(!key||key==='unknown')continue;
    const d=new Date(p.created);
    if(!recurMap[key])recurMap[key]={name:cpName(p),dates:[],amounts:[]};
    recurMap[key].dates.push(d);
    recurMap[key].amounts.push(Math.abs(amt(p)));
  }

  function detectPeriod(dates){
    if(dates.length<2)return null;
    const sorted=[...dates].sort((a,b)=>a-b);
    const gaps=[];
    for(let i=1;i<sorted.length;i++)gaps.push((sorted[i]-sorted[i-1])/(1000*60*60*24));
    const avgGap=gaps.reduce((s,v)=>s+v,0)/gaps.length;
    if(avgGap>=25&&avgGap<=40)return'Monthly';
    if(avgGap>=80&&avgGap<=100)return'Quarterly';
    if(avgGap>=340&&avgGap<=390)return'Yearly';
    return null;
  }

  const allRecur=Object.values(recurMap)
    .map(g=>{
      const period=detectPeriod(g.dates);
      const lastDate=g.dates.reduce((a,b)=>a>b?a:b);
      const lastAmt=g.amounts[g.dates.indexOf(lastDate)]||g.amounts[g.amounts.length-1];
      return{name:g.name,period,count:g.dates.length,avg:g.amounts.reduce((s,v)=>s+v,0)/g.amounts.length,lastAmt,lastDate};
    })
    .filter(g=>g.period!==null&&g.count>=3)
    .sort((a,b)=>b.avg-a.avg)
    .slice(0,15);

  // Normalise to monthly equivalent for totals
  const periodMult={'Monthly':1,'Quarterly':1/3,'Yearly':1/12};
  const fixedTotal=allRecur.filter(r=>r.period==='Monthly').reduce((s,r)=>s+r.avg,0);
  const varTotal=allRecur.filter(r=>r.period!=='Monthly').reduce((s,r)=>s+(r.avg*periodMult[r.period]),0);
  const recurTotal=fixedTotal+varTotal;

  const recurEl=document.getElementById('recurringList');
  if(allRecur.length){
    recurEl.innerHTML=
      `<div class="fixed-var-row"><div class="fv-item"><div class="fv-lbl">Monthly fixed</div><div class="fv-val neg-val">−${fmt(fixedTotal)}/mo</div></div><div class="fv-div"></div><div class="fv-item"><div class="fv-lbl">Other (normalised)</div><div class="fv-val neg-val">−${fmt(varTotal)}/mo</div></div><div class="fv-div"></div><div class="fv-item"><div class="fv-lbl">Total/month</div><div class="fv-val neg-val">−${fmt(recurTotal)}/mo</div></div></div>`+
      `<div class="table-scroll" style="margin-top:12px"><table class="data-table">
        <thead><tr><th>Name</th><th>Frequency</th><th class="num">Last paid</th><th class="num">Amount</th></tr></thead>
        <tbody>${allRecur.map(r=>`<tr>
          <td class="bold">${r.name}</td>
          <td><span class="freq-tag">${r.period}</span></td>
          <td class="num">${fmtDate(r.lastDate)}</td>
          <td class="num neg-val">−${fmt(r.lastAmt)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } else {
    recurEl.innerHTML='<p class="empty-msg">Not enough history — needs 3+ occurrences at consistent intervals</p>';
  }

  document.getElementById('budgetTxList').innerHTML=txHTML(payments,200);
}

// ── SAVINGS ───────────────────────────────────────────────────────────────────
function renderSavings() {
  const savAccs=byIds(ACCT.savings);
  const savPayments=drFilter(paymentsFor(ACCT.savings));
  const months=drMonths(), totalSaved=balance(savAccs);
  const {start}=thisMonth();
  const budgetPay=drFilter(paymentsFor(ACCT.budget));
  const monthlyIncome=budgetPay.filter(p=>new Date(p.created)>=start&&amt(p)>0).reduce((s,p)=>s+amt(p),0);
  const monthlySavings=savPayments.filter(p=>new Date(p.created)>=start&&amt(p)>0).reduce((s,p)=>s+amt(p),0);
  const savRate=monthlyIncome>0?fmtPct(monthlySavings/monthlyIncome*100):'—';

  // Monthly contributions for bar chart
  const contribs=months.map(({start,end})=>savPayments.filter(p=>{const d=new Date(p.created);return d>=start&&d<end&&amt(p)>0;}).reduce((s,p)=>s+amt(p),0));

  // Balance trend
  const monthFlows=months.map(({start,end})=>savPayments.filter(p=>{const d=new Date(p.created);return d>=start&&d<end;}).reduce((s,p)=>s+amt(p),0));
  const balTrend=[];let running=totalSaved;
  for(let i=monthFlows.length-1;i>=0;i--){balTrend[i]=Math.round(running);running-=monthFlows[i];}

  document.getElementById('savings-kpis').innerHTML=
    kpi('Saved','ti-pig-money',fmt(totalSaved),savAccs.map(a=>a.description).join(', '),'neu',true)+
    kpi('This month','ti-arrow-down',fmt(monthlySavings),'Added to savings','pos')+
    kpi('Savings rate','ti-percentage',savRate,'vs income','neu');

  // Balance trend
  areaChart('savingsArea','savingsAreaChart',months.map(m=>m.label),balTrend,'#e7255a');

  // Monthly contributions bar
  mkChart('savingsContrib','savingsContribChart','bar',{labels:months.map(m=>m.label),datasets:[{data:contribs.map(v=>Math.round(v)),backgroundColor:'#e7255a',borderRadius:3}]},{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmtK(c.parsed.y)}}},scales:baseScales()});

  renderGoalList('goalsList',state.goals,'ti-target');
  renderGoalList('holidayList',state.holidays,'ti-plane');
}

function renderGoalList(elId,items,icon){
  const el=document.getElementById(elId);if(!el)return;
  if(!items.length){el.innerHTML='<p class="empty-msg">None — tap + Add</p>';return;}

  // Monthly savings rate for forecasting
  const {start}=thisMonth();
  const savPayments=paymentsFor(ACCT.savings);
  const last3Months=3;
  const cutoff=new Date();cutoff.setMonth(cutoff.getMonth()-last3Months);
  const avgMonthlySav=savPayments.filter(p=>new Date(p.created)>=cutoff&&amt(p)>0).reduce((s,p)=>s+amt(p),0)/last3Months;

  el.innerHTML=items.map((g,i)=>{
    const pct=g.target>0?Math.min(100,Math.round(g.saved/g.target*100)):0;
    const remaining=g.target-g.saved;
    const monthsToGo=avgMonthlySav>0?Math.ceil(remaining/avgMonthlySav):null;
    const completionDate=monthsToGo!=null?new Date(new Date().getFullYear(),new Date().getMonth()+monthsToGo,1).toLocaleString('default',{month:'short',year:'numeric'}):null;
    return `<div class="goal-item">
      <div class="goal-top"><span class="goal-name"><i class="ti ${icon}" aria-hidden="true"></i>${g.name}${g.date?' · '+g.date:''}</span><span class="goal-amt">${fmt(g.saved)} / ${fmt(g.target)}</span></div>
      <div class="bar-bg"><div class="bar" style="width:${pct}%;background:${COLORS[i%COLORS.length]}"></div></div>
      <div class="goal-sub">${pct}% · ${fmt(remaining)} remaining${completionDate?' · reach by ~'+completionDate:''}</div>
    </div>`;
  }).join('');
}

document.getElementById('addGoalBtn').addEventListener('click',()=>addGoal('goals'));
document.getElementById('addHolidayBtn').addEventListener('click',()=>addGoal('holidays'));
function addGoal(type){
  const name=prompt('Goal name:');if(!name)return;
  const target=parseFloat(prompt('Target (€):'));if(!target||isNaN(target))return;
  const saved=parseFloat(prompt('Saved so far (€):')??'0')||0;
  const goal={name,target,saved};
  if(type==='holidays')goal.date=prompt('Travel date (e.g. Aug 2026):')||'';
  state[type].push(goal);store.set(type,state[type]);renderSavings();
}

// ── INVESTMENTS ───────────────────────────────────────────────────────────────
function renderInvestments(){
  const {alpacaAccount:acc,alpacaPositions:pos}=state;
  const kpiEl=document.getElementById('invest-kpis');
  if(!acc){kpiEl.innerHTML='<div class="error-card" style="grid-column:span 2"><i class="ti ti-plug" aria-hidden="true"></i>Alpaca not connected</div>';return;}

  const equity=parseFloat(acc.equity||0),last=parseFloat(acc.last_equity||0);
  const todayPL=equity-last,totalPL=pos.reduce((s,p)=>s+parseFloat(p.unrealized_pl||0),0);
  const cash=parseFloat(acc.cash||0);
  const cashPct=equity>0?cash/equity*100:0;

  kpiEl.innerHTML=
    kpi('Portfolio','ti-chart-line',fmt(equity),'','',true)+
    kpi("Today's P&L",'ti-trending-up',fmtSign(todayPL),last?fmtPct(todayPL/last*100):'',todayPL>=0?'pos':'neg')+
    kpi('Unrealised P&L','ti-calculator',fmtSign(totalPL),'All positions',totalPL>=0?'pos':'neg')+
    kpi('Cash','ti-currency-euro',fmt(cash),fmtPct(cashPct)+' of portfolio',cashPct>15?'neg':'neu');

  // Cash drag warning
  const flagEl=document.getElementById('investFlags');
  const flags=[];
  if(cashPct>15)flags.push(`<div class="flag flag-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Cash drag: ${fmtPct(cashPct)} (${fmt(cash)}) uninvested</div>`);
  // Concentration: any single position >30%
  for(const p of pos){const v=parseFloat(p.market_value||0),pct=equity>0?v/equity*100:0;if(pct>30)flags.push(`<div class="flag flag-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i>${p.symbol} = ${fmtPct(pct)} of portfolio</div>`);}
  flagEl.innerHTML=flags.join('');

  // Allocation donut
  const groups={};
  for(const p of pos){const v=parseFloat(p.market_value||0),grp=/^(V|I)/.test(p.symbol)?'ETFs':'Stocks';groups[grp]=(groups[grp]||0)+v;}
  if(cash>0)groups['Cash']=cash;
  const gL=Object.keys(groups),gV=Object.values(groups).map(v=>Math.round(v));
  donut('alloc','allocChart',gL,gV,COLORS.slice(0,gL.length));
  document.getElementById('allocLegend').innerHTML=gL.map((l,i)=>`<div class="alloc-item"><div class="alloc-dot" style="background:${COLORS[i]}"></div><span class="alloc-name">${l}</span><span class="alloc-pct">${equity>0?fmtPct(gV[i]/equity*100):'—'}</span></div>`).join('');

  // Positions
  const maxVal=Math.max(...pos.map(p=>parseFloat(p.market_value||0)),1);
  document.getElementById('positionsList').innerHTML=[...pos].sort((a,b)=>parseFloat(b.market_value)-parseFloat(a.market_value)).map(p=>{
    const v=parseFloat(p.market_value||0),pl=parseFloat(p.unrealized_plpc||0)*100,cls=pl>=0?'pos':'neg';
    return `<div class="pos-item"><span class="pos-tk">${p.symbol}</span><div class="pos-bar-wrap"><div class="pos-bar-bg"><div class="pos-bar-fill" style="width:${(v/maxVal*100).toFixed(1)}%;background:${pl>=0?'#2a7d5f':'#e7255a'}"></div></div></div><span class="pos-val">${fmt(v)}</span><span class="pos-pl ${cls}">${pl>=0?'+':''}${pl.toFixed(1)}%</span></div>`;
  }).join('');
}

// ── Loading ───────────────────────────────────────────────────────────────────
function showPageLoading(page){
  const s='<div class="loading"><div class="spinner"></div></div>';
  ({flii:['flii-kpis','fliiTxList'],holding:['holding-kpis','holdingTxList'],budget:['budget-kpis','budgetTxList'],savings:['savings-kpis'],investments:['invest-kpis']}[page]||[]).forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=s;});
}

// ── API ───────────────────────────────────────────────────────────────────────
async function bunqProxy(action,params={},retried=false){const qs=new URLSearchParams({action,...params}).toString();const res=await fetch(`/api/bunq?${qs}`);const json=await res.json();if(!res.ok&&json.expired&&!retried)return bunqProxy(action,params,true);if(!res.ok)throw new Error(json.error||`Bunq ${res.status}`);return json;}

function setConn(id,status){const dot=document.getElementById(id+'Dot'),lbl=document.getElementById(id+'Label');if(!dot)return;dot.className='dot'+(status==='ok'?'':status==='loading'?' amber':' red');if(lbl)lbl.style.color=status==='ok'?'var(--pos)':status==='error'?'var(--neg)':'#c97d00';}

async function loadBunq(){
  setConn('bunq','loading');showPageLoading('flii');
  try{
    const{accounts}=await bunqProxy('accounts');state.accounts=accounts;
    const results=await Promise.allSettled(accounts.map(a=>bunqProxy('payments',{accountId:a.id,userId:a.userId}).then(r=>({id:a.id,payments:r.payments}))));
    for(const r of results)if(r.status==='fulfilled')state.payments[r.value.id]=r.value.payments;
    setConn('bunq','ok');renderActive();
  }catch(err){console.error('Bunq:',err.message);setConn('bunq','error');}
}

async function loadAlpaca(){
  setConn('alpaca','loading');
  try{const res=await fetch('/api/alpaca?action=portfolio');const json=await res.json();if(!res.ok)throw new Error(json.error||`Alpaca ${res.status}`);state.alpacaAccount=json.account;state.alpacaPositions=json.positions;setConn('alpaca','ok');if(document.querySelector('.nav-item.active')?.dataset.page==='investments')renderInvestments();}
  catch(err){console.error('Alpaca:',err.message);setConn('alpaca','error');}
}

async function loadAllData(){await Promise.allSettled([loadBunq(),loadAlpaca()]);state.lastSync=new Date();}

// ── Init ──────────────────────────────────────────────────────────────────────
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(console.warn);
setConn('bunq','loading');setConn('alpaca','loading');loadAllData();
