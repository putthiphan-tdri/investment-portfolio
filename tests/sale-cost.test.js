import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\nloadPortfolio();')[0];
const fund = { symbol: 'THB-FUND', bank: 'SCB', port: 'Main', units: 10000, purchaseAmount: 100000, buyingNav: 10, currentNav: 12 };
const cash = { symbol: 'CASH', bank: 'SCB', port: 'Main', category: 'Cash', isCash: true, cashBalance: 0 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

function session() {
  const storage = new Map();
  const fields = new Map();
  let message;
  const ctx = vm.createContext({ console, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    window: {}, document: { querySelector: selector => fields.get(selector) || null } });
  vm.runInContext(source, ctx);
  const run = code => vm.runInContext(code, ctx);
  run(`holdings.push(...${JSON.stringify([fund, cash])}); state.logDate = '2026-11-06'; renderAll = () => {};`);
  ctx.captureMessage = text => { message = text; };
  run('showToast = captureMessage;');
  fields.set('#actionDialog', { close() {} });
  return { run,
    json: code => JSON.parse(run(`JSON.stringify(${code})`)),
    get message() { return message; },
    confirm(values, editId = '') {
      for (const key of [...fields.keys()]) if (key !== '#actionDialog') fields.delete(key);
      for (const [key, value] of Object.entries({ transactionDate: '2026-11-06', transactionType: 'Sell', transactionAsset: 'THB-FUND', ...values })) {
        fields.set(`#${key}`, typeof value === 'boolean' ? { checked: value } : { value: String(value) });
      }
      run(`state.action = '${editId ? 'Edit Transaction' : 'Add Transaction'}'; state.editingActivityId = '${editId}'; handleConfirm({preventDefault(){}});`);
    },
  };
}

test('a new sale stores the cost of the units sold, and realized P&L counts it', () => {
  const s = session();
  s.confirm({ transactionUnits: 2500, transactionAmount: 30000 });
  assert.equal(s.run('activities.length'), 1, s.message);
  near(s.run('activities[0].cashBasisAmount'), 25000);
  near(s.run('holdings[0].purchaseAmount'), 75000);
  assert.deepEqual(s.json('realizedPnl(null, null)'), { amount: 5000, counted: 1, unknown: 0 });
});

test('editing only the proceeds of a sale keeps its stored cost', () => {
  const s = session();
  s.confirm({ transactionUnits: 2500, transactionAmount: 30000 });
  s.confirm({ transactionUnits: 2500, transactionAmount: 31000 }, s.run('activities[0].id'));
  near(s.run('activities[0].cashBasisAmount'), 25000);
  near(s.run('holdings[0].units'), 7500);
  near(s.run('holdings[0].purchaseAmount'), 75000);
  assert.deepEqual(s.json('realizedPnl(null, null)'), { amount: 6000, counted: 1, unknown: 0 });
});

test('editing a sale to more units than are left stores the cost of the corrected units', () => {
  const s = session();
  s.confirm({ transactionUnits: 2500, transactionAmount: 30000 });
  s.confirm({ transactionUnits: 8000, transactionAmount: 96000 }, s.run('activities[0].id'));
  assert.equal(s.run('activities.length'), 1, s.message);
  near(s.run('activities[0].cashBasisAmount'), 80000);
  near(s.run('holdings[0].units'), 2000);
  near(s.run('holdings[0].purchaseAmount'), 20000);
  near(s.run('cashBalance()'), 96000);
  assert.deepEqual(s.json('realizedPnl(null, null)'), { amount: 16000, counted: 1, unknown: 0 });
  assert.equal(s.run('reverseActivityEffect(activities[0])'), true);
  near(s.run('holdings[0].units'), 10000);
  near(s.run('holdings[0].purchaseAmount'), 100000);
});

test('editing a closing sale down to a partial sale stores its cost instead of zero', () => {
  const s = session();
  s.confirm({ transactionUnits: 10000, transactionAmount: 120000, transactionSellAll: true });
  near(s.run('activities[0].cashBasisAmount'), 100000);
  assert.equal(s.run('holdings[0].archived'), true);
  s.confirm({ transactionUnits: 6000, transactionAmount: 72000, transactionSellAll: false }, s.run('activities[0].id'));
  assert.equal(s.run('activities.length'), 1, s.message);
  near(s.run('activities[0].cashBasisAmount'), 60000);
  near(s.run('holdings[0].units'), 4000);
  near(s.run('holdings[0].purchaseAmount'), 40000);
  assert.equal(s.run('Boolean(holdings[0].archived)'), false);
  assert.deepEqual(s.json('realizedPnl(null, null)'), { amount: 12000, counted: 1, unknown: 0 });
});

// A sale into Cash followed by a buy at a different price: the fund's average cost has moved
// since the sale, so putting the sale back by re-applying it would not restore the same cost.
function movedAverage(s, { buyFromCash }) {
  s.confirm({ transactionUnits: 2500, transactionAmount: 30000 });
  s.confirm({ transactionType: 'Buy', transactionUnits: 1000, transactionAmount: 30000, transactionUseCash: buyFromCash });
  near(s.run('holdings[0].units'), 8500);
  near(s.run('holdings[0].purchaseAmount'), 105000);
  return s.run('activities.find(item => item.type === "Sell").id');
}
const sale = "activities.find(item => item.type === 'Sell')";

test('an edit that cannot take the sale proceeds back out of Cash leaves the holding cost untouched', () => {
  const s = session();
  const id = movedAverage(s, { buyFromCash: true });
  near(s.run('cashBalance()'), 0);
  s.confirm({ transactionUnits: 2500, transactionAmount: 31000 }, id);
  assert.match(s.message, /Could not undo the old order/);
  near(s.run('holdings[0].units'), 8500);
  near(s.run('holdings[0].purchaseAmount'), 105000);
  near(s.run('cashBalance()'), 0);
  near(s.run(`${sale}.amount`), 30000);
  near(s.run(`${sale}.cashBasisAmount`), 25000);
});

test('an edit to more units than the fund holds puts the old sale back exactly', () => {
  const s = session();
  const id = movedAverage(s, { buyFromCash: false });
  near(s.run('cashBalance()'), 30000);
  s.confirm({ transactionUnits: 12000, transactionAmount: 144000 }, id);
  assert.match(s.message, /Could not apply the corrected order/);
  assert.equal(s.run('activities.length'), 2);
  near(s.run('holdings[0].units'), 8500);
  near(s.run('holdings[0].purchaseAmount'), 105000);
  near(s.run('cashBalance()'), 30000);
  near(s.run(`${sale}.amount`), 30000);
  near(s.run(`${sale}.cashBasisAmount`), 25000);
});

test('a delete that cannot take the sale proceeds back out of Cash leaves the holding cost untouched', () => {
  const s = session();
  const id = movedAverage(s, { buyFromCash: true });
  s.run(`state.action = 'Edit Transaction'; state.editingActivityId = '${id}'; deleteEditingActivity();`);
  assert.equal(s.run('activities.length'), 2);
  near(s.run('holdings[0].units'), 8500);
  near(s.run('holdings[0].purchaseAmount'), 105000);
  near(s.run('cashBalance()'), 0);
});
