import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\ninitDates();')[0];
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
    }
  }
  vm.runInContext(`state.privacyMode=true; renderChart('1W');`,chartContext);
  assert.doesNotMatch(nodes.get('#performanceChart').innerHTML, /aria-label="[^"]*฿/);
});
