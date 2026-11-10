import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\nloadPortfolio();')[0];
const context = vm.createContext({ console });
vm.runInContext(source, context);
const run = (code) => vm.runInContext(code, context);

test('daily chart preserves missing data and actual zero observations', () => {
  for (const value of ['{}', '{dayPnlDelta:null}', '{dayPnlDelta:undefined}', '{dayPnlDelta:NaN}', '{dayPnlDelta:10,carriedForward:true}']) {
    assert.equal(run(`recordedDailyPnl(${value})`), null);
  }
  assert.equal(run('recordedDailyPnl({dayPnlDelta:0})'), 0);
  assert.equal(run('recordedDailyPnl({dayPnlDelta:-572.4})'), -572.4);
});

test('selling a profitable holding does not become an invented daily loss', () => {
  const result = run(`performanceObservations([
    {date:'2026-09-01',totalFundValue:1100,totalPaid:1000,pnl:100,dayPnlDelta:10},
    {date:'2026-09-02',totalFundValue:500,totalPaid:500,pnl:0}
  ], 'daily')`);
  assert.equal(result[0].chartValue, 10);
  assert.equal(result[1].chartValue, null);
});

test('P&L charts use historical balances and value charts use historical value', () => {
  assert.equal(run(`performanceObservations([{pnl:-30,totalFundValue:970}], 'pnl')[0].chartValue`), -30);
  assert.equal(run(`performanceObservations([{pnl:-30,totalFundValue:970}], 'value')[0].chartValue`), 970);
});

test('carried values retain their source date but never create daily observations', () => {
  const result = run(`performanceObservations(carryForwardSnapshotsForRange([
    {date:'2026-09-01',pnl:25,totalFundValue:1025,dayPnlDelta:25}
  ], '2026-09-01', '2026-09-03'), 'daily')`);
  assert.equal(result.length, 3);
  assert.equal(result[2].sourceDate, '2026-09-01');
  assert.equal(result[2].chartValue, null);
});

test('axis labels preserve small amounts and apply selected display currency', () => {
  assert.equal(run(`chartAxisLabel(-350, currencyConfig.THB)`), '−฿350');
  assert.equal(run(`chartAxisLabel(1250, currencyConfig.THB)`), '฿1.3K');
  assert.equal(run(`chartAxisLabel(1000, currencyConfig.USD)`), '$27');
});

test('axis range contains both extremes for small, mixed, and large balances', () => {
  for (const [min, max] of [[0,0],[-50,-1],[-4,7],[1,9],[1e6,1.2e6]]) {
    const ticks = run(`computeNiceTicks(${min},${max})`);
    assert.ok(ticks.at(-1) <= min);
    assert.ok(ticks[0] >= max, `${min}..${max} exceeds chart axis ${ticks}`);
    assert.ok(ticks[0] > ticks.at(-1));
  }
});

test('axis stops at the first gridline beyond the data instead of padding out to a fixed count', () => {
  // ฿13.07M–฿31.3M with the chart's padding used to run ฿10M–฿50M.
  assert.equal(run(`computeNiceTicks(10.9e6,33.5e6)`).join(), [35e6,30e6,25e6,20e6,15e6,10e6].join());
  for (const [min, max] of [[10.9e6,33.5e6],[-4,7],[1,9],[1e6,1.2e6],[-62000,415000],[980,1021]]) {
    const ticks = run(`computeNiceTicks(${min},${max})`);
    const step = ticks[0] - ticks[1];
    assert.ok(ticks.length >= 3 && ticks.length <= 6, `${min}..${max} gives ${ticks.length} gridlines`);
    assert.ok(ticks[0] - max < step, `${min}..${max} leaves a spare gridline above: ${ticks}`);
    assert.ok(min - ticks.at(-1) < step, `${min}..${max} leaves a spare gridline below: ${ticks}`);
  }
});

test('normalizing imported snapshots does not turn absent daily amounts into zero', () => {
  const snapshot = run(`normalizePortfolioSnapshots([{date:'2026-09-01',totalFundValue:100,totalPaid:100,dayPnlDelta:''}])[0]`);
  assert.equal(Object.hasOwn(snapshot, 'dayPnlDelta'), false);
});

test('chart renders losses, break-even, sparse and empty history without invalid coordinates', () => {
  const nodes = new Map();
  const makeNode = () => ({innerHTML:'',textContent:'',hidden:false,attrs:{},setAttribute(k,v){this.attrs[k]=v;},querySelectorAll(){return [];},closest(){return {getBoundingClientRect(){return {width:330,height:240};}};}});
  const document = {querySelector(selector){if(!nodes.has(selector)) nodes.set(selector,makeNode()); return nodes.get(selector);},querySelectorAll(){return [];}};
  const chartContext = vm.createContext({console,document});
  vm.runInContext(source,chartContext);
  vm.runInContext(`totals = () => ({list:[]});`,chartContext);
  for (const mode of ['pnl','value','daily']) {
    for (const snapshots of [[], [{date:'2026-09-01',totalFundValue:950,totalPaid:1000,pnl:-50,pnlPct:-5,dayPnlDelta:-50}], [{date:'2026-09-01',totalFundValue:1000,totalPaid:1000,pnl:0,pnlPct:0,dayPnlDelta:0}], [{date:'2026-09-01',totalFundValue:990,totalPaid:1000,pnl:-10,pnlPct:-1,dayPnlDelta:-10},{date:'2026-09-03',totalFundValue:1020,totalPaid:1000,pnl:20,pnlPct:2,dayPnlDelta:20}]]) {
      vm.runInContext(`state.chartMode = '${mode}'; snapshotsForRange = () => ({sourceSnapshots:${JSON.stringify(snapshots)},startKey:'2026-09-01',endKey:'2026-09-03'}); renderChart('1W');`,chartContext);
      const markup=nodes.get('#performanceChart').innerHTML;
      assert.doesNotMatch(markup,/NaN|Infinity/);
      if (mode !== 'value' && snapshots.length) assert.match(markup,/chart-zero/);
      if (!snapshots.length) assert.match(markup,/Add a fund/);
      if(mode === 'daily' && snapshots.length===1) assert.equal((markup.match(/data-chart-point /g)||[]).length,1);
      if (mode === 'value' && snapshots.length) assert.match(markup,/class="capital-area" d="M[^"]+Z"\/><path class="capital-edge"[^>]+><path class="portfolio-line"/);
      assert.doesNotMatch(markup,/cost-line|quiet/);
      const insights=nodes.get('#chartInsights').innerHTML;
      if (snapshots.length) assert.match(insights,/<span>[^<]+ <span class="info-dot"[^>]*>i<span class="info-tooltip" id="chartInfoTooltip">[^<]{20,}<\/span><\/span><\/span>/);
      assert.doesNotMatch(insights,/period end|latest recorded|Period high/);
    }
  }
  // Past 40 points only the latest dot is drawn; every date keeps its hover and keyboard target.
  const long = Array.from({length:60},(_,i)=>({date:`2026-${i<30?'09':'10'}-${String(i%30+1).padStart(2,'0')}`,totalFundValue:1000+i*3,totalPaid:1000,pnl:i*3,pnlPct:i*.3,dayPnlDelta:3}));
  for (const mode of ['value','pnl']) {
    vm.runInContext(`state.chartMode = '${mode}'; snapshotsForRange = () => ({sourceSnapshots:${JSON.stringify(long)},startKey:'2026-09-01',endKey:'2026-10-30'}); renderChart('ALL');`,chartContext);
    const markup=nodes.get('#performanceChart').innerHTML;
    assert.doesNotMatch(markup,/NaN|Infinity/);
    assert.equal((markup.match(/data-chart-point /g)||[]).length,60);
    assert.equal((markup.match(/chart-observation [a-z ]*quiet"/g)||[]).length,59);
    assert.match(markup,/data-date="2026-10-30"[^>]*tabindex="0"[^>]*>(?:(?!<\/g>).)*<circle class="chart-observation [a-z]+" /);
  }
  vm.runInContext(`state.privacyMode=true; renderChart('1W');`,chartContext);
  assert.doesNotMatch(nodes.get('#performanceChart').innerHTML, /aria-label="[^"]*฿/);
});

test('return and risk chain recorded daily moves and skip missing days', () => {
  const metrics = run(`returnRiskMetrics([
    {date:'2026-09-01',totalFundValue:1000,dayPnlDelta:''},
    {date:'2026-09-02',totalFundValue:1100,dayPnlDelta:100,dayPnlDeltaPct:10},
    {date:'2026-09-03',totalFundValue:5990,dayPnlDelta:-110},
    {date:'2026-09-04',totalFundValue:5990,dayPnlDelta:50,carriedForward:true},
    {date:'2026-09-07',totalFundValue:5871,dayPnlDelta:-119.8,dayPnlDeltaPct:-2},
    {date:'2026-09-08',totalFundValue:5929.71,dayPnlDelta:58.71,dayPnlDeltaPct:1}
  ])`);
  // 1.10 × (1 − 110/6100) × 0.98 × 1.01; the deposit on Sep 3 does not count as a gain.
  const expected = (1.1 * (1 - 110 / 6100) * 0.98 * 1.01 - 1) * 100;
  assert.ok(Math.abs(metrics.returnPct - expected) < 1e-9);
  assert.equal(metrics.days, 4);
  assert.equal(metrics.missing, 1);
  assert.equal(metrics.firstDate, '2026-09-02');
  assert.equal(metrics.lastDate, '2026-09-08');
  assert.ok(Math.abs(metrics.marketPnl - (100 - 110 - 119.8 + 58.71)) < 1e-9);
  assert.equal(metrics.upDays, 2);
  assert.equal(metrics.downDays, 2);
  assert.equal(metrics.best.date, '2026-09-02');
  assert.equal(metrics.worst.date, '2026-09-07');
  assert.equal(metrics.drawdown.fromDate, '2026-09-02');
  assert.equal(metrics.drawdown.toDate, '2026-09-07');
  assert.ok(Math.abs(metrics.drawdown.pct - ((1 - 110 / 6100) * 0.98 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(metrics.drawdown.amount - (-110 - 119.8)) < 1e-9);
});

test('return and risk report no drawdown for a rising range and a decline from the period start', () => {
  const rising = run(`returnRiskMetrics([
    {date:'2026-09-01',totalFundValue:1010,dayPnlDelta:10,dayPnlDeltaPct:1},
    {date:'2026-09-02',totalFundValue:1010,dayPnlDelta:0,dayPnlDeltaPct:0}
  ])`);
  assert.equal(rising.drawdown.pct, 0);
  assert.equal(rising.drawdown.toDate, null);
  assert.equal(rising.upDays, 1);
  assert.equal(rising.downDays, 0);

  const falling = run(`returnRiskMetrics([{date:'2026-09-01',totalFundValue:990,dayPnlDelta:-10,dayPnlDeltaPct:-1}])`);
  assert.equal(falling.drawdown.fromDate, null);
  assert.equal(falling.drawdown.toDate, '2026-09-01');
  assert.ok(Math.abs(falling.drawdown.pct + 1) < 1e-9);
  assert.equal(falling.drawdown.amount, -10);

  assert.equal(run(`returnRiskMetrics([{date:'2026-09-01',totalFundValue:1000},{date:'2026-09-02',totalFundValue:1000,dayPnlDelta:5,carriedForward:true}])`), null);
  assert.equal(run('returnRiskMetrics([])'), null);
});

test('realized P&L uses recorded costs and counts uncosted sales as unknown', () => {
  const realizedContext = vm.createContext({ console });
  vm.runInContext(source, realizedContext);
  vm.runInContext(`
    holdings.push(
      {symbol:'CLOSED',units:0,archived:true,archivedDate:'2026-09-03',archivedSaleAmount:500,archivedPnl:40},
      {symbol:'NOCOST',units:0,archived:true,archivedDate:'2026-09-03',archivedSaleAmount:300,archivedPnl:300}
    );
    activities.push(
      {type:'Sell',asset:'A',date:'Sep 1, 2026',amount:1000,cashBasisAmount:900},
      {type:'Sell',asset:'B',date:'September 2, 2026',amount:200,cashBasisAmount:0},
      {type:'Sell',asset:'CLOSED',date:'Sep 3, 2026',amount:500},
      {type:'Sell',asset:'NOCOST',date:'Sep 3, 2026',amount:300},
      {type:'Switch',asset:'C',date:'Sep 4, 2026',amount:100,switch:{amount:100,sourceCostRemoved:130}},
      {type:'Switch',asset:'D',date:'Sep 4, 2026',amount:350,switch:{amount:350,sourceCostRemoved:10,sourceCostRemovedTHB:330}},
      {type:'Switch',asset:'E',date:'Sep 4, 2026',amount:100,switch:{amount:100}},
      {type:'Buy',asset:'A',date:'Sep 4, 2026',amount:999,cashBasisAmount:1},
      {type:'Dividend',asset:'A',date:'Sep 4, 2026',amount:50},
      {type:'Sell',asset:'A',date:'Oct 1, 2026',amount:1000,cashBasisAmount:400}
    );`, realizedContext);
  const result = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, realizedContext));

  assert.deepEqual(result(`realizedPnl('2026-09-01','2026-09-30')`), { amount: 100 + 40 - 30 + 20, counted: 4, unknown: 3 });
  assert.deepEqual(result(`realizedPnl('2026-09-04','2026-09-04')`), { amount: -10, counted: 2, unknown: 1 });
  assert.deepEqual(result(`realizedPnl(null,'2026-12-31')`), { amount: 730, counted: 5, unknown: 3 });
  assert.deepEqual(result(`realizedPnl('2027-01-01','2027-12-31')`), { amount: 0, counted: 0, unknown: 0 });
});

test('return and risk strip renders figures, an empty state and hides money in privacy mode', () => {
  const nodes = new Map();
  const makeNode = () => ({innerHTML:'',textContent:'',hidden:false,setAttribute(){},querySelectorAll(){return [];}});
  const document = {querySelector(selector){if(!nodes.has(selector)) nodes.set(selector,makeNode()); return nodes.get(selector);},querySelectorAll(){return [];}};
  const stripContext = vm.createContext({console,document});
  vm.runInContext(source,stripContext);
  const snapshots = [
    {date:'2026-09-01',totalFundValue:1010,dayPnlDelta:10,dayPnlDeltaPct:1},
    {date:'2026-09-02',totalFundValue:989.8,dayPnlDelta:-20.2,dayPnlDeltaPct:-2},
    {date:'2026-09-10',totalFundValue:2000,dayPnlDelta:500,dayPnlDeltaPct:50}
  ];
  vm.runInContext(`activities.push({type:'Sell',asset:'A',date:'Sep 2, 2026',amount:1000,cashBasisAmount:900},{type:'Sell',asset:'B',date:'Sep 2, 2026',amount:5});
    renderReturnRisk('1W','2026-09-01','2026-09-03',${JSON.stringify(snapshots)});`,stripContext);
  const markup = nodes.get('#returnRisk').innerHTML;
  assert.match(markup, /<p>Sep 1 – Sep 2, 2026<\/p>/);
  // Plain labels: baht leads, with the deposit-proof percentage beside it.
  assert.match(markup, /Gain \/ loss<\/span><strong class="red"><span class="private-value">−฿10<\/span><\/strong><small>−1\.02% return<\/small>/);
  assert.match(markup, /title="[^"<>]*deposits, withdrawals and sales do not count[^"<>]*"><span>Gain \/ loss</);
  assert.match(markup, /Biggest dip<\/span><strong class="red"><span class="private-value">−฿20<\/span><\/strong><small><span class="return-risk-span">Sep 1 – Sep 2<\/span> · −2\.00%<\/small>/);
  assert.match(markup, /Up days<\/span><strong class="neutral">1 of 2<\/strong><small>1 down<\/small>/);
  assert.match(markup, /Profit from sales<\/span><strong class="green"><span class="private-value">\+฿100<\/span><\/strong><small>1 of 2 sales costed<\/small>/);
  assert.equal((markup.match(/class="return-risk-item"/g)||[]).length, 6);
  assert.doesNotMatch(markup, /return-risk-note|Market P&amp;L|Max drawdown|Time-weighted|Realized|title="undefined"/);
  assert.doesNotMatch(markup, /NaN|Infinity|undefined|฿500/);
  for (const amount of markup.match(/[+−]?฿[\d,]+/g)) assert.ok(markup.includes(`<span class="private-value">${amount}</span>`));

  vm.runInContext(`renderReturnRisk('1W','2026-08-01','2026-08-07',${JSON.stringify(snapshots)});`,stripContext);
  const empty = nodes.get('#returnRisk').innerHTML;
  assert.match(empty, /No daily figures in this range/);
  assert.doesNotMatch(empty, /return-risk-grid|฿|NaN/);

  vm.runInContext(`renderReturnRisk('1W','2026-09-02','2026-09-02',[]);`,stripContext);
  const salesOnly = nodes.get('#returnRisk').innerHTML;
  assert.match(salesOnly, /Gain \/ loss<\/span><strong class="neutral">—<\/strong><small>Not recorded/);
  assert.doesNotMatch(salesOnly, /title="undefined"/);

  // A range that only rises has no dip to report.
  vm.runInContext(`renderReturnRisk('1W','2026-09-01','2026-09-01',${JSON.stringify(snapshots)});`,stripContext);
  const rising = nodes.get('#returnRisk').innerHTML;
  assert.match(rising, /Biggest dip<\/span><strong class="neutral">None<\/strong><small>No fall from a high<\/small>/);
  assert.match(rising, /Up days<\/span><strong class="neutral">1 of 1<\/strong><small>0 down<\/small>/);
  assert.match(salesOnly, /1 of 2 sales costed/);
});
