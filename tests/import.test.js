import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\ninitDates();')[0];
const key = 'myFundsPortfolio.v1';
const order = (overrides = {}) => ({ id: 'order-1', date: 'Sep 22, 2026',
  createdAt: '2026-09-22T15:54:24.744Z', type: 'Buy', asset: 'TEST', units: '+10.0000', amount: 100, ...overrides });
const portfolio = (orders = [order()]) => ({ logDate: '2026-09-23',
  holdings: [{ symbol: 'TEST', units: 10, purchaseAmount: 100, buyingNav: 10, currentNav: 11 }],
  activities: orders, portfolioSnapshots: [{date: '2026-09-23', totalFundValue: 110, totalPaid: 100, pnl: 10, pnlPct: 10}] });
function session(initial = portfolio()) {
  const storage = new Map([[key, JSON.stringify(initial)]]);
  const fields = { '#jsonImport': {value: ''}, '#jsonImportMode': {value: 'Merge records'} };
  const ctx = vm.createContext({console, localStorage: {getItem: k => storage.get(k) || null,
    setItem: (k,v) => storage.set(k,v)}, window: {}, document: {querySelector: s => fields[s] || null}});
  vm.runInContext(source,ctx);
  vm.runInContext('renderAll = () => {}; showToast = () => {}; loadPortfolio();',ctx);
  return {storage, run: code => vm.runInContext(code,ctx), data: () => JSON.parse(storage.get(key)),
    import(p, mode = 'Merge records') { fields['#jsonImport'].value = JSON.stringify(p); fields['#jsonImportMode'].value = mode;
      return vm.runInContext('importSampleData()',ctx); }};
}

test('reimporting native orders normalizes defaults without creating duplicate activity', () => {
  const s = session();
  s.run('activities.splice(0,activities.length,...JSON.parse(localStorage.getItem(storageKey)).activities)');
  const before = s.data();
  assert.equal(s.import(portfolio()),true);
  assert.equal(s.import(portfolio()),true);
  assert.equal(s.data().activities.length,1);
  assert.equal(s.data().activities[0].id,'order-1');
  assert.equal(s.data().holdings[0].units,10);
  assert.deepEqual(s.data().portfolioSnapshots,before.portfolioSnapshots);
});
test('same-ID corrections replace the complete transaction including cash and switch fields', () => {
  const s = session(portfolio([order({fromCash:true,cashAmount:100})]));
  s.import(portfolio([order({type:'Switch',amount:150,units:'-15', switch:{fromSymbol:'TEST',toSymbol:'OTHER',sourceCostRemoved:125}})]));
  assert.equal(s.data().activities.length,1);
  assert.equal(s.data().activities[0].amount,150);
  assert.equal(s.data().activities[0].fromCash,false);
  assert.equal(s.data().activities[0].switch.sourceCostRemoved,125);
});
test('legacy rewritten IDs match original timestamp and numeric units once', () => {
  const s = session(portfolio([order({id:'rewritten',units:'10'})]));
  s.import(portfolio());
  assert.equal(s.data().activities.length,1);
  assert.equal(s.data().activities[0].id,'order-1');
});
test('distinct orders at the same price, amount, units and timestamp survive import and reload', () => {
  const p = portfolio([order(),order({id:'order-2'})]);
  const s = session(p);
  s.import(p);s.import(p);s.run('loadPortfolio()');
  assert.equal(s.run('activities.length'),2);
});
test('different switches and separate timestamps are retained', () => {
  const p = portfolio([order(),order({id:'second',createdAt:'2026-09-22T15:55:24.744Z'}),
    order({id:'switch-a',type:'Switch',switch:{fromSymbol:'TEST',toSymbol:'A'}}),
    order({id:'switch-b',type:'Switch',switch:{fromSymbol:'TEST',toSymbol:'B'}})]);
  const s = session(p);s.import(p);assert.equal(s.data().activities.length,4);
});
test('full restore removes old clones and absent assets, retains a recovery copy, and is repeatable', () => {
  const old = portfolio([order(),order({id:'clone',createdAt:'2026-09-22T15:54:24.745Z'})]);
  old.holdings.push({symbol:'OLD',units:1});
  const s = session(old), p = portfolio();
  s.import(p,'Restore full portfolio');
  assert.deepEqual(JSON.parse(s.storage.get(key+'.beforeJsonImport')),old);
  assert.equal(s.data().activities.length,1);assert.equal(s.data().holdings.length,1);
  s.import(p,'Restore full portfolio');
  assert.equal(s.data().activities.length,1);
  assert.deepEqual(s.data().portfolioSnapshots,p.portfolioSnapshots);
  assert.equal(s.data().sync.dirty,true);
});
test('partial restore and malformed data are rejected without changing the portfolio', () => {
  const s=session(), before=s.storage.get(key);
  for (const invalid of [null, {holdings:{}}, {activities:[null]}, {holdings:[[]]}]) {
    assert.equal(s.import(invalid),false);assert.equal(s.storage.get(key),before);
  }
  assert.equal(s.import({holdings:[]},'Restore full portfolio'),false);
  assert.equal(s.storage.get(key),before);
});
test('restore with empty history does not invent an import activity', () => {
  const s=session();s.import(portfolio([]),'Restore full portfolio');
  assert.deepEqual(s.data().activities,[]);
});
test('backup failure cancels import before modifying in-memory records', () => {
  const s=session();s.run('localStorage.setItem = () => {throw new Error("quota")};');
  assert.equal(s.import(portfolio([]),'Restore full portfolio'),false);
  assert.equal(s.run('activities.length'),1);assert.equal(s.run('holdings.length'),1);
});
