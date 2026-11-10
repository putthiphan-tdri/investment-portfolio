import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\nloadPortfolio();')[0];

function panel(list, setup = '') {
  const nodes = new Map();
  const makeNode = () => ({innerHTML:'',textContent:'',className:'',hidden:false,attrs:{},setAttribute(k,v){this.attrs[k]=v;}});
  const document = {querySelector(selector){if(!nodes.has(selector)) nodes.set(selector,makeNode()); return nodes.get(selector);},querySelectorAll(){return [];}};
  const context = vm.createContext({console,document});
  vm.runInContext(source,context);
  vm.runInContext(`totals = () => ({list:${JSON.stringify(list)}}); ${setup} renderBreakdown();`,context);
  return {markup:nodes.get('.pnl-list').innerHTML, toggle:nodes.get('#pnlToggle')};
}

const fund = (symbol, pnlBaht, pnlPct = pnlBaht / 10) => ({symbol, category:'Equity', pnlBaht, pnlPct});
const rows = (markup, column) => {
  const section = markup.split(`class="pnl-column ${column}"`)[1].split('class="pnl-column')[0];
  return [...section.matchAll(/data-fund-insight="([^"]+)"/g)].map((match) => match[1]);
};
const widths = (markup) => [...markup.matchAll(/style="width:([\d.]+)%"/g)].map((match) => Number(match[1]));

test('P&L by fund totals gainers and losers and ranks each side biggest first', () => {
  const {markup, toggle} = panel([fund('A', 100), fund('B', -400), fund('C', 300), fund('D', -50), fund('CASH', 0)].map((item) => item.symbol === 'CASH' ? {...item, isCash:true} : item));
  assert.match(markup, /<span>2 up<\/span><strong class="green"><span class="private-value">\+฿400<\/span>/);
  assert.match(markup, /<span>2 down<\/span><strong class="red"><span class="private-value">−฿450<\/span>/);
  assert.match(markup, /<span>Net<\/span><strong class="red"><span class="private-value">−฿50<\/span>/);
  assert.equal(rows(markup, 'losses').join(), 'B,D');
  assert.equal(rows(markup, 'gains').join(), 'C,A');
  assert.doesNotMatch(markup, /CASH/);
  // Every bar shares one scale: the largest move, here a loss, is the full width.
  assert.equal(widths(markup).join(), '100,12.5,75,25');
  assert.match(markup, /class="negative" style="width:100.00%"/);
  assert.match(markup, /class="positive" style="width:75.00%"/);
  assert.equal(toggle.hidden, true);
});

test('P&L by fund shows five a side until Show all is chosen', () => {
  const list = [...Array.from({length:7}, (_, i) => fund(`UP${i}`, (i + 1) * 10)), ...Array.from({length:6}, (_, i) => fund(`DOWN${i}`, -(i + 1) * 10))];
  const collapsed = panel(list);
  assert.equal(rows(collapsed.markup, 'gains').join(), 'UP6,UP5,UP4,UP3,UP2');
  assert.equal(rows(collapsed.markup, 'losses').join(), 'DOWN5,DOWN4,DOWN3,DOWN2,DOWN1');
  assert.match(collapsed.markup, /<h3>Biggest losses<\/h3>/);
  assert.equal(collapsed.toggle.hidden, false);
  assert.equal(collapsed.toggle.textContent, 'Show all 13');
  assert.equal(collapsed.toggle.attrs['aria-expanded'], 'false');
  assert.equal(collapsed.toggle.className, 'pnl-toggle');

  const expanded = panel(list, 'state.pnlShowAll = true;');
  assert.equal(rows(expanded.markup, 'gains').length, 7);
  assert.equal(rows(expanded.markup, 'losses').length, 6);
  assert.match(expanded.markup, /class="pnl-columns is-all"/);
  assert.equal(expanded.toggle.textContent, 'Show fewer');
  assert.equal(expanded.toggle.attrs['aria-expanded'], 'true');
});

test('P&L by fund offers Show all only on a narrow panel when four or five funds share a side', () => {
  const {toggle} = panel([fund('A', 1), fund('B', 2), fund('C', 3), fund('D', 4), fund('E', -1)]);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.className, 'pnl-toggle narrow-only');
});

test('P&L by fund handles one-sided, flat and empty portfolios', () => {
  const allUp = panel([fund('A', 100), fund('B', 0)]);
  assert.match(allUp.markup, /<span>1 up<\/span>/);
  assert.match(allUp.markup, /<span>0 down<\/span><strong class=""><span class="private-value">฿0<\/span>/);
  assert.match(allUp.markup, /<span>Net · 1 flat<\/span>/);
  assert.match(allUp.markup, /No fund is down\./);
  assert.equal(rows(allUp.markup, 'gains').join(), 'A,B');
  assert.match(allUp.markup, /class="flat" style="width:0.00%"/);

  const empty = panel([]);
  assert.match(empty.markup, /No P&amp;L contribution yet|No P&L contribution yet/);
  assert.equal(empty.toggle.hidden, true);
});
