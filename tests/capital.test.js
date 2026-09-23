import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\ninitDates();')[0];
const key = 'myFundsPortfolio.v1';
const order = (id, date, overrides = {}) => ({ id, date, createdAt: '2026-09-24T10:00:00.000Z',
  type: 'Buy', asset: 'TEST', units: '+10.0000', amount: 100, ...overrides });
function session(extra = {}) {
  const storage = new Map([[key, JSON.stringify({ logDate: '2026-09-25',
    holdings: [{ symbol: 'TEST', units: 10, purchaseAmount: 100, buyingNav: 10, currentNav: 11 }],
    activities: [], portfolioSnapshots: [], ...extra })]]);
  const ctx = vm.createContext({console, localStorage: {getItem: k => storage.get(k) || null,
    setItem: (k,v) => storage.set(k,v)}, window: {}, document: {querySelector: () => null}});
  vm.runInContext(source, ctx);
  vm.runInContext('renderAll = () => {}; showToast = () => {}; loadPortfolio();', ctx);
  return { run: code => vm.runInContext(code, ctx), data: () => JSON.parse(storage.get(key)) };
}

test('only money entering or leaving the portfolio moves capital', () => {
  const s = session({ capitalAnchor: { date: '2026-09-23', amount: 1000 }, activities: [
    order('before-anchor', 'Sep 23, 2026', { amount: 999 }),
    order('new-money', 'Sep 24, 2026', { amount: 300 }),
    order('cash-buy', 'Sep 24, 2026', { amount: 50, fromCash: true }),
    order('sell-to-cash', 'Sep 24, 2026', { type: 'Sell', amount: 70, depositedToCash: true }),
    order('switch', 'Sep 24, 2026', { type: 'Switch', amount: 80, switch: { fromSymbol: 'TEST', toSymbol: 'B', amount: 80 } }),
    order('dividend', 'Sep 24, 2026', { type: 'Dividend', amount: 5, depositedToCash: true }),
    order('withdraw', 'Sep 25, 2026', { type: 'Withdraw', asset: 'CASH', amount: 40 }),
    order('sell-out', 'Sep 25, 2026', { type: 'Sell', amount: 60 }),
  ] });
  assert.equal(s.run('capitalOn("2026-09-23")'), 1000);
  assert.equal(s.run('capitalOn("2026-09-24")'), 1300);
  assert.equal(s.run('capitalOn("2026-09-25")'), 1200);
  const snapshot = s.run('currentSnapshot("2026-09-24")');
  assert.equal(snapshot.totalPaid, 1300);
  assert.equal(snapshot.pnl, snapshot.totalFundValue - 1300);
});

test('without an anchor, snapshots keep the cost-of-holdings basis', () => {
  const s = session();
  assert.equal(s.run('capitalOn("2026-09-25")'), null);
  assert.equal(s.run('currentSnapshot("2026-09-25").totalPaid'), 100);
  assert.equal(s.run('chartLabels().pnl'), 'Unrealized P&L');
});

test('the capital anchor survives save, export and full restore', () => {
  const s = session({ capitalAnchor: { date: '2026-09-23', amount: 1000 } });
  s.run('savePortfolio({ captureSnapshot: false })');
  assert.deepEqual(s.data().capitalAnchor, { date: '2026-09-23', amount: 1000 });
  assert.deepEqual(s.run('JSON.stringify(buildExportPayload().capitalAnchor)'), JSON.stringify({ date: '2026-09-23', amount: 1000 }));
  assert.equal(s.run('chartLabels().cost'), 'Capital invested');
});
