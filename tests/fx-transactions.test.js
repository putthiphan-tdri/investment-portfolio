import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\ninitDates();')[0];
const usd = { symbol: 'SCBUSDYIELD', bank: 'SCB', port: 'Main', navCurrency: 'USD',
  units: 100, purchaseAmount: 1000, buyingNav: 10, currentNav: 10, fxRate: 36, buyFxRate: 32 };
const thb = { symbol: 'THB-FUND', bank: 'SCB', port: 'Main', units: 10000, purchaseAmount: 100000, buyingNav: 10, currentNav: 10 };
const cash = { symbol: 'CASH', bank: 'SCB', port: 'Main', category: 'Cash', isCash: true, cashBalance: 100000 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
function session() {
  const storage = new Map();
  const fields = new Map();
  let message;
  const ctx = vm.createContext({ console, localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v) },
    window: {}, document: { querySelector: selector => fields.get(selector) || null } });
  vm.runInContext(source, ctx);
  const run = code => vm.runInContext(code, ctx);
  run(`holdings.push(...${JSON.stringify([usd, thb, cash])}); state.logDate = '2026-11-06';
    state.capitalAnchor = {date:'2026-11-05', amount:232000}; renderAll = () => {};`);
  ctx.captureMessage = text => { message = text; };
  run('showToast = captureMessage;');
  fields.set('#actionDialog', { close() {} });
  return { run, storage,
    json: code => JSON.parse(run(`JSON.stringify(${code})`)),
    get message() { return message; },
    confirm(values, editId = '') {
      for (const key of [...fields.keys()]) if (key !== '#actionDialog') fields.delete(key);
      for (const [key, value] of Object.entries({ transactionDate:'2026-11-06', ...values })) {
        fields.set(`#${key}`, typeof value === 'boolean' ? { checked:value } : { value:String(value) });
      }
      run(`state.action = '${editId ? 'Edit Transaction' : 'Add Transaction'}'; state.editingActivityId = '${editId}'; handleConfirm({preventDefault(){}});`);
    },
  };
}
const buyFields = { transactionType:'Buy', transactionAsset:'SCBUSDYIELD', transactionUnits:10,
  transactionAmount:3500, transactionNativeAmount:100 };

test('USD buy records native units/cost, THB cash/capital and a locked rate; undo restores the balance', () => {
  const s = session();
  s.confirm(buyFields);
  near(s.run('holdings[0].units'), 110);
  near(s.run('holdings[0].purchaseAmount'), 1100);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 35500);
  near(s.run('deriveFund(holdings[0]).currentValue'), 39600);
  near(s.run('holdings[0].fxRate'), 36);
  near(s.run('capitalOn("2026-11-06")'), 235500);
  assert.deepEqual(s.json('activities[0].fx'), { currency:'USD', nativeAmount:100, rate:35 });
  s.run('holdings[0].fxRate = 40');
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 35500);
  assert.equal(s.run('reverseActivityEffect(activities[0])'), true);
  near(s.run('holdings[0].purchaseAmount'), 1000);
  near(s.run('holdings[0].buyFxRate'), 32);
});

test('USD cash-funded buy debits THB and edits correctly even with no remaining cash', () => {
  const s = session();
  s.run('holdings[2].cashBalance = 3500');
  s.confirm({ ...buyFields, transactionUseCash:true });
  near(s.run('cashBalance()'), 0);
  near(s.run('capitalOn("2026-11-06")'), 232000);
  const id = s.run('activities[0].id');
  s.confirm({ ...buyFields, transactionAmount:3400, transactionUseCash:true }, id);
  near(s.run('cashBalance()'), 100);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 35400);
  assert.equal(s.run('activities.length'), 1);
  assert.equal(s.run('reverseActivityEffect(activities[0])'), true);
  near(s.run('cashBalance()'), 3500);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 32000);
});

for (const intoUsd of [true, false]) {
  test(`switch ${intoUsd ? 'into' : 'out of'} USD uses each native amount and preserves/reverses THB cost`, () => {
    const s = session();
    s.confirm({ transactionType:'Switch', transactionAsset: intoUsd ? 'THB-FUND' : 'SCBUSDYIELD',
      transactionDestAsset: intoUsd ? 'SCBUSDYIELD' : 'THB-FUND', transactionAmount:3500,
      transactionSourceAmount:100, transactionDestAmount:100, transactionSwitchOutNav:10, transactionBuyingNav:10 });
    assert.equal(s.run('activities.length'), 1, s.message);
    const data = s.json('activities[0].switch');
    near(data.sourceUnits, intoUsd ? 350 : 10);
    near(data.destUnits, intoUsd ? 10 : 350);
    near(s.run('deriveFund(holdings[0]).purchaseAmount'), intoUsd ? 35500 : 28800);
    near(s.run('holdings[1].purchaseAmount'), intoUsd ? 96500 : 103500);
    near(s.run('capitalOn("2026-11-06")'), 232000);
    near(s.run('cashBalance()'), 100000);
    assert.equal(s.run('reverseActivityEffect(activities[0])'), true);
    near(s.run('holdings[0].units'), 100);
    near(s.run('deriveFund(holdings[0]).purchaseAmount'), 32000);
    near(s.run('holdings[1].purchaseAmount'), 100000);
    near(s.run('holdings[1].units'), 10000);
  });
}

test('USD sell removes native cost and deposits actual THB; full sale reports THB profit and can be reversed', () => {
  const s = session();
  s.confirm({ transactionType:'Sell', transactionAsset:'SCBUSDYIELD', transactionUnits:100,
    transactionAmount:35000, transactionNativeAmount:1000, transactionSellAll:true });
  near(s.run('cashBalance()'), 135000);
  near(s.run('holdings[0].archivedPnl'), 3000);
  near(s.run('activities[0].cashBasisAmount'), 32000);
  assert.equal(s.run('holdings[0].archived'), true);
  assert.equal(s.run('reverseActivityEffect(activities[0])'), true);
  near(s.run('cashBalance()'), 100000);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 32000);
  assert.equal(s.run('holdings[0].archived'), false);
});

test('editing a USD buy replaces its native amount, THB amount and FX without doubling holdings', () => {
  const s = session();
  s.confirm(buyFields);
  const id = s.run('activities[0].id');
  s.confirm({ ...buyFields, transactionUnits:20, transactionNativeAmount:200, transactionAmount:6800 }, id);
  near(s.run('holdings[0].units'), 120);
  near(s.run('holdings[0].purchaseAmount'), 1200);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 38800);
  near(s.run('activities[0].fx.rate'), 34);
  assert.equal(s.run('activities.length'), 1);
});

test('failed cash purchase leaves native and THB cost unchanged', () => {
  const s = session();
  s.run('holdings[2].cashBalance = 0');
  s.confirm({ ...buyFields, transactionUseCash:true });
  near(s.run('holdings[0].units'), 100);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 32000);
  assert.equal(s.run('activities.length'), 0);
});

test('foreign amounts are required and no holding is changed for an incomplete transaction', () => {
  const s = session();
  s.confirm({ ...buyFields, transactionNativeAmount:'' });
  assert.equal(s.run('activities.length'), 0);
  s.confirm({ transactionType:'Switch', transactionAsset:'THB-FUND', transactionDestAsset:'SCBUSDYIELD',
    transactionAmount:3500, transactionSwitchOutNav:10, transactionBuyingNav:10 });
  assert.equal(s.run('activities.length'), 0);
  near(s.run('holdings[0].units'), 100);
});

test('THB orders and same-currency switches retain their original math', () => {
  const s = session();
  s.confirm({ transactionType:'Buy', transactionAsset:'THB-FUND', transactionUnits:10, transactionAmount:100 });
  near(s.run('holdings[1].purchaseAmount'), 100100);
  assert.equal(s.run('activities[0].fx'), undefined);
  const data = s.json('buildSwitchData(holdings[1], holdings[1], 1000, 10, 20)');
  near(data.sourceUnits, 100);
  near(data.destUnits, 50);
});

test('FX and switch metadata survive save, backup, normalization and reload', () => {
  const s = session();
  s.confirm(buyFields);
  const fx = s.json('activities[0].fx');
  assert.deepEqual(s.json('normalizeActivities(buildExportPayload().activities)[0].fx'), fx);
  s.run('loadPortfolio()');
  assert.deepEqual(s.json('activities[0].fx'), fx);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 35500);
});

test('form labels separate USD investment from THB cash and let archived USD funds receive new purchases', () => {
  const s = session();
  s.run('holdings[0].archived = true');
  const buy = s.run('transactionFieldMarkup("Buy", {asset:"SCBUSDYIELD"})');
  assert.match(buy, /Amount paid \(THB\)/);
  assert.match(buy, /Amount invested \(USD\)/);
  assert.match(buy, /transactionNativeAmount/);
  assert.ok(s.json('transactionFundOptions([], true)').includes('SCBUSDYIELD'));
  const markup = s.run('transactionFieldMarkup("Switch", {asset:"THB-FUND",destAsset:"SCBUSDYIELD"})');
  assert.match(markup, /Destination investment \(USD\)/);
  assert.match(markup, /Buying NAV \(USD\)/);
  assert.doesNotMatch(markup, /transactionSourceAmount/);
});

test('editing and deleting a cross-currency switch restores both sides without an extra capital flow', () => {
  const s = session();
  const fields = { transactionType:'Switch', transactionAsset:'THB-FUND', transactionDestAsset:'SCBUSDYIELD',
    transactionAmount:3500, transactionDestAmount:100, transactionSwitchOutNav:10, transactionBuyingNav:10 };
  s.confirm(fields);
  const id = s.run('activities[0].id');
  s.confirm({ ...fields, transactionAmount:6800, transactionDestAmount:200 }, id);
  near(s.run('holdings[0].units'), 120);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 38800);
  near(s.run('holdings[1].purchaseAmount'), 93200);
  near(s.run('capitalOn("2026-11-06")'), 232000);
  s.run(`state.action = 'Edit Transaction'; state.editingActivityId = activities[0].id; deleteEditingActivity()`);
  near(s.run('holdings[0].units'), 100);
  near(s.run('holdings[0].buyFxRate'), 32);
  near(s.run('holdings[1].purchaseAmount'), 100000);
  assert.equal(s.run('activities.length'), 0);
});

test('failed switch edit keeps the previous activity and both balances', () => {
  const s = session();
  const fields = { transactionType:'Switch', transactionAsset:'THB-FUND', transactionDestAsset:'SCBUSDYIELD',
    transactionAmount:3500, transactionDestAmount:100, transactionSwitchOutNav:10, transactionBuyingNav:10 };
  s.confirm(fields);
  const previous = s.json('activities[0]');
  s.confirm({ ...fields, transactionAmount:200000 }, previous.id);
  assert.deepEqual(s.json('activities[0]'), previous);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 35500);
  near(s.run('holdings[1].purchaseAmount'), 96500);
});

test('switch metadata survives reload and full USD switch-out can be deleted', () => {
  const s = session();
  s.confirm({ transactionType:'Switch', transactionAsset:'SCBUSDYIELD', transactionDestAsset:'THB-FUND',
    transactionAmount:35000, transactionSourceAmount:1000, transactionSwitchOutNav:10, transactionBuyingNav:10 });
  const data = s.json('activities[0].switch');
  near(s.run('holdings[0].archivedPnl'), 3000);
  s.run('loadPortfolio()');
  assert.deepEqual(s.json('activities[0].switch'), data);
  s.run(`state.action = 'Edit Transaction'; state.editingActivityId = activities[0].id; deleteEditingActivity()`);
  near(s.run('deriveFund(holdings[0]).purchaseAmount'), 32000);
  assert.equal(s.run('holdings[0].archived'), false);
});

const switchToNew = {
  transactionType: 'Switch', transactionAsset: 'THB-FUND', transactionDestAsset: '__new_switch_destination__',
  transactionAmount: 3500, transactionSwitchOutNav: 10, transactionBuyingNav: 10,
  switchFundSymbol: 'new-fund(a)', switchFundName: 'New fund', switchFundCategory: 'Global Equity',
};

for (const currency of ['THB', 'USD']) {
  test(`switch into a new ${currency} fund creates one holding and one activity`, () => {
    const s = session();
    const isUSD = currency === 'USD';
    const expectedUnits = isUSD ? 10 : 350;
    s.confirm({ ...switchToNew, switchFundCurrency: currency, transactionDestAmount: isUSD ? 100 : '' });
    assert.equal(s.run('activities.length'), 1, s.message);
    s.run('loadPortfolio()');
    const dest = s.json('holdings.find(f => f.symbol === "NEW-FUND(A)")');
    assert.equal(dest.bank, thb.bank);
    assert.equal(dest.port, thb.port);
    assert.equal(dest.category, 'Global Equity');
    assert.equal(dest.navCurrency, currency);
    near(dest.units, expectedUnits);
    near(s.run('deriveFund(holdings.find(f => f.symbol === "NEW-FUND(A)")).currentValue'), 3500);
    near(s.run('holdings.find(f => f.symbol === "THB-FUND").units'), 9650);
    near(s.run('capitalOn("2026-11-06")'), 232000);
    near(s.run('cashBalance()'), 100000);
    const order = s.json('activities[0]');
    assert.equal(order.type, 'Switch');
    assert.equal(order.switch.toSymbol, dest.symbol);
    near(order.switch.destUnits, expectedUnits);
  });
}

test('a duplicate code, missing USD amount, or insufficient source units leaves no new holding', () => {
  const s = session();
  s.confirm({ ...switchToNew, switchFundSymbol: 'scbusdyield' });
  assert.match(s.message, /already exists/);
  s.confirm({ ...switchToNew, switchFundCurrency: 'USD' });
  assert.match(s.message, /foreign-currency amounts/);
  s.confirm({ ...switchToNew, transactionAmount: 110000 });
  assert.match(s.message, /enough units/);
  assert.equal(s.run('holdings.length'), 3);
  assert.equal(s.run('activities.length'), 0);
  near(s.run('holdings[1].units'), 10000);
});

test('editing a switch can replace its new destination, and deleting it restores source units', () => {
  const s = session();
  s.confirm(switchToNew);
  const id = s.run('activities[0].id');
  s.confirm({ ...switchToNew, switchFundSymbol: 'OTHER', transactionAmount: 110000 }, id);
  assert.equal(s.run('holdings.some(f => f.symbol === "OTHER")'), false);
  near(s.run('holdings.find(f => f.symbol === "NEW-FUND(A)").units'), 350);
  near(s.run('holdings[1].units'), 9650);
  s.confirm({ ...switchToNew, switchFundSymbol: 'OTHER' }, id);
  assert.equal(s.run('activities.length'), 1);
  assert.equal(s.run('activities[0].switch.toSymbol'), 'OTHER');
  assert.equal(s.run('holdings.some(f => f.symbol === "NEW-FUND(A)")'), false);
  s.run(`state.action = 'Edit Transaction'; state.editingActivityId = activities[0].id; deleteEditingActivity()`);
  assert.equal(s.run('holdings.length'), 3);
  assert.equal(s.run('activities.length'), 0);
  near(s.run('holdings[1].units'), 10000);
});
