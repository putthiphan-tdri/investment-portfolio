// Categorical palette stays away from green/red so P&L colors keep their meaning.
const categoryPalette = {
  "Cash": "#d57600",
  "Government Bonds": "#315dff",
  "Money Market": "#2fa9bd",
  "Thai Equity": "#ec4899",
  "Asian Equity": "#f59e0b",
  "US Equity": "#0ea5e9",
  "European Equity": "#6366f1",
  "Global Equity": "#8b5cf6",
  "Commodities": "#f97316",
  "Mixed Allocation": "#64748b",
};

const CASH_SYMBOL = "CASH";
const CASH_CATEGORY = "Cash";

const holdings = [];

const activities = [];
const portfolioSnapshots = [];

const state = {
  currency: "THB",
  action: "",
  editingSymbol: "",
  editingActivityId: "",
  logDate: "",
  calendarMonth: "",
  privacyMode: false,
};

const currencyConfig = {
  THB: { symbol: "฿", rate: 1 },
  USD: { symbol: "$", rate: 0.027 },
};

const sortState = { col: null, dir: "asc" };
const storageKey = "myFundsPortfolio.v1";

function savePortfolio({ captureSnapshot = true } = {}) {
  try {
    if (captureSnapshot) syncTodaySnapshot();
    portfolioSnapshots.splice(0, portfolioSnapshots.length, ...normalizePortfolioSnapshots(portfolioSnapshots));
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      currency: state.currency,
      logDate: activeDateKey(),
      privacyMode: state.privacyMode,
      holdings,
      activities,
      portfolioSnapshots,
    }));
    scheduleCloudPush();
  } catch {
    showToast("Could not save changes in this browser.");
  }
}

// --- Cloud sync (Vercel Blob via /api/portfolio) ---
// localStorage stays the working copy; the private blob is the durable one.
// Reads/writes are authenticated with a sync key the user enters once.
const CLOUD_KEY_STORAGE = "myFundsPortfolio.syncKey";
const cloudState = { pushTimer: 0 };

function cloudKey() {
  try {
    return localStorage.getItem(CLOUD_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

async function cloudRequest(method, body) {
  if (!cloudKey()) return null;
  return fetch("/api/portfolio", {
    method,
    headers: {
      Authorization: `Bearer ${cloudKey()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function scheduleCloudPush() {
  if (!cloudKey()) return;
  window.clearTimeout(cloudState.pushTimer);
  cloudState.pushTimer = window.setTimeout(pushPortfolioToCloud, 2500);
}

async function pushPortfolioToCloud() {
  try {
    const response = await cloudRequest("PUT", buildExportPayload());
    if (response?.status === 401) showToast("Cloud sync key was rejected. Check it in cloud sync settings.");
  } catch {
    // Offline or running without the Vercel API (e.g. local python server) — stay quiet.
  }
}

async function pullPortfolioFromCloud({ silent = false } = {}) {
  try {
    const response = await cloudRequest("GET");
    if (!response) return;

    if (response.status === 404) {
      if (holdings.length > 0) {
        pushPortfolioToCloud();
        if (!silent) showToast("No cloud copy yet — uploading this portfolio.");
      }
      return;
    }

    if (!response.ok) {
      if (!silent) {
        const detail = await response.json().catch(() => ({}));
        showToast(detail.error || "Cloud sync is not ready yet.");
      }
      return;
    }

    const parsed = await response.json();
    const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const localSavedAt = stored.savedAt || "";
    const cloudSavedAt = parsed.exportedAt || "";

    if (cloudSavedAt > localSavedAt || holdings.length === 0) {
      applyStoredPayload(parsed);
      savePortfolio({ captureSnapshot: false });
      applyPrivacyMode();
      document.querySelector("#currencyLabel").textContent = state.currency;
      renderAll();
      showToast("Portfolio loaded from cloud.");
    } else {
      pushPortfolioToCloud();
    }
  } catch {
    // Offline or no API available — local data keeps working.
  }
}

function openCloudSyncDialog() {
  const dialog = document.querySelector("#actionDialog");
  const fields = document.querySelector("#dialogFields");
  state.action = "Cloud Sync";
  state.editingSymbol = "";
  state.editingActivityId = "";

  document.querySelector("#dialogTitle").textContent = "Cloud Sync";
  document.querySelector("#dialogCopy").textContent = cloudKey()
    ? "Cloud sync is on. The portfolio is stored as a private blob on Vercel and loads on any device with this key. Clear the key to turn sync off."
    : "Enter your sync key to store the portfolio as a private blob on Vercel and load it on any device.";
  document.querySelector("#confirmAction").textContent = "Save";
  document.querySelector("#deleteFund").hidden = true;
  fields.className = "dialog-fields";
  fields.innerHTML = fieldMarkup([
    { id: "syncKeyInput", label: "Sync key", value: cloudKey() },
  ]);

  if (dialog.showModal) dialog.showModal();
}

function applyStoredPayload(parsed) {
  state.logDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.logDate || "") ? parsed.logDate : todayKey();
  holdings.splice(0, holdings.length, ...((parsed.holdings || []).map((fund) => ({
    ...(isCashHolding(fund)
      ? normalizeCashHolding(fund)
      : {
          ...fund,
          navLagDays: Math.max(0, Math.round(Number(fund.navLagDays ?? fund.navLag ?? fund.navDateLag ?? 0))),
          navHistory: normalizeNavHistory(fund),
        }),
  }))));
  activities.splice(0, activities.length, ...normalizeActivities(parsed.activities || []));
  portfolioSnapshots.splice(0, portfolioSnapshots.length, ...normalizePortfolioSnapshots(parsed.portfolioSnapshots || parsed.snapshots || []));
  if (parsed.currency && currencyConfig[parsed.currency]) state.currency = parsed.currency;
  if ("privacyMode" in parsed) state.privacyMode = Boolean(parsed.privacyMode);
}

function loadPortfolio() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    applyStoredPayload(JSON.parse(stored));
  } catch {
    console.warn("Saved portfolio data could not be loaded.");
  }
}

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function todayKey() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function activeDateKey() {
  if (!state.logDate) state.logDate = todayKey();
  if (isWeekendDate(state.logDate)) state.logDate = previousWeekdayKey(state.logDate);
  return state.logDate;
}

function syncLogDateInput() {
  const input = document.querySelector("#logDateInput");
  if (!input) return;
  input.value = activeDateKey();
  input.title = `Log date: ${readableDate(activeDateKey())}`;
}

function readableDate(dateKey) {
  if (!dateKey) return todayLabel();
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function parseDateKey(dateKey) {
  return new Date(`${dateKey}T00:00:00`);
}

function dateKeyFromDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDate(dateKey, amount, unit) {
  const date = parseDateKey(dateKey);
  if (unit === "day") date.setDate(date.getDate() + amount);
  if (unit === "month") date.setMonth(date.getMonth() + amount);
  if (unit === "year") date.setFullYear(date.getFullYear() + amount);
  return dateKeyFromDate(date);
}

function isWeekendDate(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return false;
  const day = parseDateKey(dateKey).getDay();
  return day === 0 || day === 6;
}

function previousWeekdayKey(dateKey) {
  let safeDate = dateKey;
  while (isWeekendDate(safeDate)) {
    safeDate = shiftDate(safeDate, -1, "day");
  }
  return safeDate;
}

function navEffectiveDate(fund, date = activeDateKey()) {
  const lag = Math.max(0, Math.round(Number(fund.navLagDays || 0)));
  return shiftDate(date, -lag, "day");
}

function monthKeyFromDate(dateKey = activeDateKey()) {
  return String(dateKey).slice(0, 7);
}

function shiftMonth(monthKey, amount) {
  const [year, month] = String(monthKey || monthKeyFromDate()).split("-").map(Number);
  const date = new Date(year || new Date().getFullYear(), (month || 1) - 1 + amount, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
  const [year, month] = String(monthKey || monthKeyFromDate()).split("-").map(Number);
  return new Date(year || new Date().getFullYear(), (month || 1) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function makeId(prefix = "item") {
  if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dateKeyFromActivityDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? activeDateKey() : dateKeyFromDate(parsed);
}

function normalizeActivities(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: item.id || `activity-${dateKeyFromActivityDate(item.date || todayLabel())}-${String(item.type || "activity").toLowerCase()}-${String(item.asset || "fund").replace(/[^a-z0-9]+/gi, "-")}-${index}`,
    date: String(item.date || readableDate(activeDateKey())),
    createdAt: item.createdAt || item.created_at || item.timestamp || new Date(`${dateKeyFromActivityDate(item.date || todayLabel())}T23:59:59.${String(999 - index).padStart(3, "0")}`).toISOString(),
    type: String(item.type || "Import"),
    asset: String(item.asset || item.symbol || item.fundCode || "Imported"),
    units: String(item.units || ""),
    amount: Number(item.amount ?? item.netAmount ?? item.netDividend ?? 0),
    grossAmount: Number(item.grossAmount ?? item.grossDividend ?? item.dividendGross ?? 0),
    taxAmount: Number(item.taxAmount ?? item.withholdingTax ?? item.dividendTax ?? 0),
    netAmount: Number(item.netAmount ?? item.netDividend ?? item.amount ?? 0),
    cashAmount: Number(item.cashAmount ?? 0),
    cashBasisAmount: Number(item.cashBasisAmount ?? item.holdingCostBasisAmount ?? 0),
    depositedToCash: Boolean(item.depositedToCash || item.toCash),
    fromCash: Boolean(item.fromCash || item.useCash),
    ...(item.switch ? { switch: item.switch } : {}),
  }));
}

function activitySortValue(activity) {
  const dateValue = parseDateKey(dateKeyFromActivityDate(activity.date)).getTime();
  const createdValue = new Date(activity.createdAt || 0).getTime();
  return dateValue * 100000000 + (Number.isFinite(createdValue) ? createdValue % 100000000 : 0);
}

function sortedActivities() {
  return [...activities].sort((a, b) => activitySortValue(b) - activitySortValue(a));
}

function dividendNetAmount(activity) {
  return Number(activity.netAmount ?? activity.amount ?? 0) || 0;
}

function dividendTaxAmount(activity) {
  return Number(activity.taxAmount ?? activity.withholdingTax ?? 0) || 0;
}

function dividendGrossAmount(activity) {
  const gross = Number(activity.grossAmount ?? activity.grossDividend ?? 0) || 0;
  if (gross > 0) return gross;
  return dividendNetAmount(activity) + dividendTaxAmount(activity);
}

function dividendTotalsForFund(symbol) {
  return activities
    .filter((activity) => activity.type === "Dividend" && activity.asset === symbol && !activity.depositedToCash)
    .reduce((totals, activity) => {
      totals.net += dividendNetAmount(activity);
      totals.tax += dividendTaxAmount(activity);
      totals.gross += dividendGrossAmount(activity);
      return totals;
    }, { net: 0, tax: 0, gross: 0 });
}

function money(value, decimals = 2) {
  const config = currencyConfig[state.currency];
  return `${config.symbol}${(value * config.rate).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function nav(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function pct(value) {
  if (Math.abs(value) < 0.005) return "0.00%";
  return `${value >= 0 ? "▲ " : "▼ "}${Math.abs(value).toFixed(2)}%`;
}

function bracketPct(value) {
  if (Math.abs(value) < 0.005) return "(0.00%)";
  return `(${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%)`;
}

function rangeChangeMarkup(delta, pctValue) {
  const tone = delta >= 0 ? "up" : "down";
  const arrow = delta >= 0 ? "▲" : "▼";
  const amount = state.privacyMode ? "" : `<span class="private-value">${money(Math.abs(delta), 0)}</span>`;
  return `<span class="range-change-value">${amount}<span class="range-change-pct ${tone}">${arrow} ${bracketPct(pctValue)}</span></span>`;
}

function shortMoney(value) {
  const config = currencyConfig[state.currency];
  const converted = value * config.rate;
  if (converted >= 1_000_000) return `${config.symbol}${(converted / 1_000_000).toFixed(1)}M`;
  if (converted >= 1_000) return `${config.symbol}${Math.round(converted / 1_000)}K`;
  return money(value);
}

function colorForCategory(category) {
  return categoryPalette[category] || "#6b7a99";
}

function isCashHolding(item = {}) {
  return Boolean(item.isCash) || item.symbol === CASH_SYMBOL || item.category === CASH_CATEGORY;
}

function normalizeCashHolding(item = {}) {
  const balance = Number(item.cashBalance ?? item.currentValue ?? item.updatedAmount ?? item.purchaseAmount ?? 0);
  const safeBalance = Number.isFinite(balance) ? Math.max(balance, 0) : 0;
  return {
    ...item,
    symbol: CASH_SYMBOL,
    name: item.name || "Available Cash",
    bank: item.bank || "Cash",
    port: item.port || "Uninvested",
    category: CASH_CATEGORY,
    isCash: true,
    navCurrency: "THB",
    cashBalance: safeBalance,
    cashBasis: safeBalance,
    purchaseAmount: safeBalance,
    frontFeeRate: 0,
    navLagDays: 0,
    units: safeBalance,
    buyingNav: 1,
    currentNav: 1,
    baseNav: 1,
    dailyChangePct: 0,
    navHistory: [],
  };
}

function cashHolding({ create = false } = {}) {
  let holding = holdings.find(isCashHolding);
  if (!holding && create) {
    holding = normalizeCashHolding();
    holdings.push(holding);
  }
  if (holding) Object.assign(holding, normalizeCashHolding(holding));
  return holding;
}

function cashBalance() {
  return Number(cashHolding()?.cashBalance || 0);
}

function cashBasisForWithdrawal(amount) {
  return Math.max(Number(amount || 0), 0);
}

function applyCashDelta(valueDelta, basisDelta) {
  const cash = cashHolding({ create: valueDelta > 0 || basisDelta > 0 });
  if (!cash) return Math.abs(valueDelta) < 0.005;

  const nextBalance = Number(cash.cashBalance || 0) + valueDelta;
  if (nextBalance < -0.005) return false;

  cash.cashBalance = Math.max(nextBalance, 0);
  cash.cashBasis = cash.cashBalance;
  cash.purchaseAmount = cash.cashBalance;
  cash.units = cash.cashBalance;
  cash.currentNav = 1;
  cash.buyingNav = 1;
  cash.baseNav = 1;
  cash.category = CASH_CATEGORY;
  cash.isCash = true;
  return true;
}

function cashEffectForActivity(activity) {
  const amount = Number(activity.cashAmount || activity.amount || 0);
  const basis = Number(activity.cashBasisAmount || 0);

  if (activity.type === "Dividend" && activity.depositedToCash) {
    return { value: dividendNetAmount(activity), basis: 0 };
  }
  if (activity.type === "Sell" && activity.depositedToCash) {
    return { value: amount, basis };
  }
  if (activity.type === "Buy" && activity.fromCash) {
    return { value: -amount, basis: -basis };
  }
  if (activity.type === "Deposit") {
    return { value: amount, basis: amount };
  }
  if (activity.type === "Withdraw") {
    return { value: -amount, basis: -basis };
  }
  return null;
}

function applyCashEffect(activity, direction = 1) {
  const effect = cashEffectForActivity(activity);
  if (!effect) return true;
  return applyCashDelta(effect.value * direction, effect.basis * direction);
}

function normalizeNavHistory(fund, { includeLegacy = true } = {}) {
  const entries = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  const byDate = new Map();

  entries.forEach((entry) => {
    const date = String(entry.date || entry.navDate || "").trim();
    if (!date) return;
    const pctValue = Number(entry.pct ?? entry.dailyChangePct ?? entry.changePct ?? 0);
    const navValue = Number(entry.nav ?? entry.currentNav ?? entry.value ?? 0);
    byDate.set(date, {
      date,
      pct: Number.isFinite(pctValue) ? pctValue : 0,
      nav: Number.isFinite(navValue) && navValue > 0 ? navValue : undefined,
    });
  });

  if (includeLegacy && byDate.size === 0 && Number(fund.dailyChangePct || 0) !== 0) {
    byDate.set(fund.navDate || activeDateKey(), { date: fund.navDate || activeDateKey(), pct: Number(fund.dailyChangePct || 0), nav: undefined });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizedNavLagDays(fund = {}) {
  return Math.max(0, Math.round(Number(fund.navLagDays ?? fund.navLag ?? fund.navDateLag ?? 0)));
}

function upsertNavHistory(fund, date, pctValue, navValue) {
  const history = normalizeNavHistory(fund, { includeLegacy: false }).filter((entry) => entry.date !== date);
  const pctNumber = Number(pctValue || 0);
  const navNumber = Number(navValue || 0);

  if (Math.abs(pctNumber) >= 0.005 || navNumber > 0) {
    history.push({
      date,
      pct: pctNumber,
      nav: navNumber > 0 ? navNumber : undefined,
    });
  }

  return history.sort((a, b) => a.date.localeCompare(b.date));
}

function navBeforeDate(fund, date = activeDateKey()) {
  const baseNav = Number(fund.baseNav ?? fund.currentNav ?? fund.buyingNav ?? 0);
  return normalizeNavHistory(fund)
    .filter((entry) => entry.date < date)
    .reduce((value, entry) => Number(entry.nav || 0) > 0 ? Number(entry.nav) : value * (1 + Number(entry.pct || 0) / 100), baseNav);
}

// A fund's NAV/units/cost are stored in its native currency (navCurrency). Value-style
// outputs (invested, value, fees, P&L) are converted to the THB base here so every fund
// aggregates in THB. THB funds use fxRate 1 and behave exactly as before.
function fundNavCurrency(fund) {
  return fund.navCurrency || "THB";
}

function fundCurrentFx(fund) {
  return fundNavCurrency(fund) === "THB" ? 1 : Number(fund.fxRate || fund.currentFxRate || 0) || 1;
}

function fundBuyFx(fund) {
  if (fundNavCurrency(fund) === "THB") return 1;
  return Number(fund.buyFxRate || fund.fxRate || 0) || fundCurrentFx(fund);
}

function deriveFund(fund) {
  if (isCashHolding(fund)) {
    const cash = normalizeCashHolding(fund);
    const currentValue = Number(cash.cashBalance || 0);
    const purchaseAmount = currentValue;
    const pnlBaht = 0;
    const pnlPct = 0;
    return {
      ...cash,
      units: currentValue,
      purchaseAmount,
      purchaseAmountNative: purchaseAmount,
      navCurrency: "THB",
      fxRate: 1,
      buyFxRate: 1,
      frontFeeRate: 0,
      navLagDays: 0,
      dailyChangePct: 0,
      navHistory: [],
      navDate: activeDateKey(),
      logDate: activeDateKey(),
      baseNav: 1,
      offerNav: 1,
      capitalInvested: purchaseAmount,
      feePaid: 0,
      currentNav: 1,
      baseValue: currentValue,
      currentValue,
      updatedAmount: currentValue,
      dividends: { net: 0, tax: 0, gross: 0 },
      pnlBaht,
      pnlPct,
    };
  }

  const frontFeeRate = Number(fund.frontFeeRate || 0);
  const navCurrency = fundNavCurrency(fund);
  const currentFxRate = fundCurrentFx(fund);
  const buyFxRate = fundBuyFx(fund);
  const purchaseAmountNative = Number(fund.purchaseAmount ?? fund.capitalInvested ?? 0);
  const baseNav = Number(fund.baseNav ?? fund.currentNav ?? fund.buyingNav ?? 0);
  const navLagDays = normalizedNavLagDays(fund);
  const navDate = navEffectiveDate({ navLagDays });
  const navHistory = normalizeNavHistory(fund);
  const navEntry = navHistory.find((entry) => entry.date === navDate);
  const dailyChangePct = Number(navEntry?.pct || 0);
  const offerNav = fund.buyingNav * (1 + frontFeeRate / 100);
  const enteredUnits = Number(fund.units || 0);
  const units = enteredUnits > 0 ? enteredUnits : offerNav > 0 ? purchaseAmountNative / offerNav : 0;
  const previousNav = navBeforeDate(fund, navDate);
  const currentNav = navHistory
    .filter((entry) => entry.date <= navDate)
    .reduce((value, entry) => Number(entry.nav || 0) > 0 ? Number(entry.nav) : value * (1 + Number(entry.pct || 0) / 100), baseNav);

  // Native -> THB base. Cost basis locks in the purchase FX; value marks at current FX,
  // so THB P&L captures both NAV performance and the USD/THB move.
  const purchaseAmount = purchaseAmountNative * buyFxRate;
  const capitalInvested = units * Number(fund.buyingNav || 0) * buyFxRate;
  const feePaid = Math.max(purchaseAmount - capitalInvested, 0);
  const currentValue = units * currentNav * currentFxRate;
  const baseValue = units * previousNav * currentFxRate;
  const dividends = dividendTotalsForFund(fund.symbol);
  const pnlBaht = currentValue - purchaseAmount;
  const pnlPct = purchaseAmount > 0 ? (pnlBaht / purchaseAmount) * 100 : 0;
  return { ...fund, units, purchaseAmount, purchaseAmountNative, navCurrency, fxRate: currentFxRate, buyFxRate, frontFeeRate, navLagDays, dailyChangePct, navHistory, navDate, logDate: activeDateKey(), baseNav, offerNav, capitalInvested, feePaid, currentNav, baseValue, currentValue, updatedAmount: currentValue, dividends, pnlBaht, pnlPct };
}

function isArchivedFund(fund) {
  if (isCashHolding(fund)) return Number(fund.cashBalance ?? fund.currentValue ?? fund.purchaseAmount ?? 0) <= 0;
  return Boolean(fund.archived) || (Number(fund.units || 0) <= 0 && Number(fund.purchaseAmount || 0) <= 0);
}

function activeRawHoldings() {
  return holdings.filter((item) => !isArchivedFund(item));
}

function activeFundHoldings() {
  return activeRawHoldings().filter((item) => !isCashHolding(item));
}

function archivedRawHoldings() {
  return holdings.filter((item) => !isCashHolding(item) && isArchivedFund(item));
}

function funds() {
  const raw = activeRawHoldings().map(deriveFund);
  const investedValue = raw.reduce((sum, item) => sum + item.updatedAmount, 0);
  return raw.map((item) => ({
    ...item,
    allocation: investedValue > 0 ? (item.updatedAmount / investedValue) * 100 : 0,
  }));
}

function totals() {
  const list = funds();
  const fundValue = list.reduce((sum, item) => sum + item.updatedAmount, 0);
  const baseFundValue = list.reduce((sum, item) => sum + item.baseValue, 0);
  const invested = list.reduce((sum, item) => sum + item.capitalInvested, 0);
  const paid = list.reduce((sum, item) => sum + item.purchaseAmount, 0);
  const fees = list.reduce((sum, item) => sum + item.feePaid, 0);
  const pnl = fundValue - paid;
  const pnlPct = paid > 0 ? (pnl / paid) * 100 : 0;
  return {
    list,
    fundValue,
    baseFundValue,
    invested,
    paid,
    fees,
    pnl,
    pnlPct,
  };
}

function normalizePortfolioSnapshots(snapshots) {
  const byDate = new Map();

  (Array.isArray(snapshots) ? snapshots : []).forEach((snapshot) => {
    const date = String(snapshot.date || snapshot.snapshotDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (isWeekendDate(date)) return;

    const totalFundValue = Number(snapshot.totalFundValue ?? snapshot.fundValue ?? snapshot.currentValue ?? 0);
    const totalPaid = Number(snapshot.totalPaid ?? snapshot.paid ?? snapshot.investedAmount ?? 0);
    const pnl = Number(snapshot.pnl ?? totalFundValue - totalPaid);
    const pnlPct = Number(snapshot.pnlPct ?? (totalPaid > 0 ? (pnl / totalPaid) * 100 : 0));
    const dayPnlDelta = Number(snapshot.dayPnlDelta ?? snapshot.dailyPnlDelta ?? snapshot.marketPnlDelta);
    const dayPnlDeltaPct = Number(snapshot.dayPnlDeltaPct ?? snapshot.dailyPnlDeltaPct ?? snapshot.marketPnlDeltaPct);

    byDate.set(date, {
      date,
      totalFundValue: Number.isFinite(totalFundValue) ? totalFundValue : 0,
      totalPaid: Number.isFinite(totalPaid) ? totalPaid : 0,
      pnl: Number.isFinite(pnl) ? pnl : 0,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
      ...(Number.isFinite(dayPnlDelta) ? { dayPnlDelta } : {}),
      ...(Number.isFinite(dayPnlDeltaPct) ? { dayPnlDeltaPct } : {}),
    });
  });

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function currentSnapshot(date = activeDateKey()) {
  const total = totals();
  const dayPnlDelta = total.fundValue - total.baseFundValue;
  const dayPnlDeltaPct = total.baseFundValue > 0 ? (dayPnlDelta / total.baseFundValue) * 100 : 0;
  return {
    date,
    totalFundValue: total.fundValue,
    totalPaid: total.paid,
    pnl: total.pnl,
    pnlPct: total.pnlPct,
    dayPnlDelta,
    dayPnlDeltaPct,
  };
}

function snapshotsWithLiveCurrent(snapshots, date = activeDateKey()) {
  const normalized = normalizePortfolioSnapshots(snapshots);
  if (holdings.length === 0) return normalized;

  const snapshotDate = previousWeekdayKey(date);
  const liveSnapshot = currentSnapshot(snapshotDate);
  let found = false;
  const merged = normalized.map((snapshot) => {
    if (snapshot.date !== liveSnapshot.date) return snapshot;
    found = true;
    return liveSnapshot;
  });

  if (!found) merged.push(liveSnapshot);
  return normalizePortfolioSnapshots(merged);
}

function syncTodaySnapshot() {
  if (holdings.length === 0) {
    return;
  }

  const snapshotDate = previousWeekdayKey(activeDateKey());
  const todaySnapshot = currentSnapshot(snapshotDate);
  const existingIndex = portfolioSnapshots.findIndex((snapshot) => snapshot.date === todaySnapshot.date);

  if (existingIndex >= 0) {
    portfolioSnapshots[existingIndex] = todaySnapshot;
  } else {
    portfolioSnapshots.push(todaySnapshot);
  }

  portfolioSnapshots.sort((a, b) => a.date.localeCompare(b.date));
}

function groupBy(list, keyFn) {
  return list.reduce((acc, item) => {
    const key = keyFn(item);
    const existing = acc.get(key) || { key, amount: 0, invested: 0, items: [] };
    existing.amount += item.updatedAmount;
    existing.invested += item.capitalInvested;
    existing.items.push(item);
    acc.set(key, existing);
    return acc;
  }, new Map());
}

function sortedGroups(map, baseTotal) {
  return [...map.values()]
    .map((group) => ({
      ...group,
      pct: baseTotal > 0 ? (group.amount / baseTotal) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function getSortedHoldings() {
  const list = funds();
  if (!sortState.col) return list;

  return [...list].sort((a, b) => {
    const av = a[sortState.col];
    const bv = b[sortState.col];
    const cmp = typeof av === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
    return sortState.dir === "asc" ? cmp : -cmp;
  });
}

function setText(selector, text) {
  const node = document.querySelector(selector);
  if (node) node.textContent = text;
}

function navDateCaption(fund) {
  return readableDate(fund.navDate);
}

function applyPrivacyMode() {
  document.documentElement.classList.toggle("privacy-mode", state.privacyMode);
  const button = document.querySelector("#privacyToggle");
  if (!button) return;

  button.setAttribute("aria-pressed", String(state.privacyMode));
  button.setAttribute("aria-label", state.privacyMode ? "Show investment figures" : "Hide investment figures");
  button.title = state.privacyMode ? "Show investment figures" : "Hide investment figures";
  button.innerHTML = state.privacyMode
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.3A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a17.8 17.8 0 0 1-3.1 4.3" /><path d="M6.1 6.1C3.4 7.9 2 12 2 12s3.5 8 10 8a10.7 10.7 0 0 0 5.9-1.8" /></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>`;
}

function fundFieldMarkup(fund = {}, currencyOverride) {
  const navLagDays = normalizedNavLagDays(fund);
  const navDate = navEffectiveDate({ navLagDays });
  const navCurrency = currencyOverride || fundNavCurrency(fund);
  const isForeign = navCurrency !== "THB";
  const navUnit = isForeign ? ` (${navCurrency})` : "";

  const fields = [
    { id: "assetSymbol", label: "Fund code", value: fund.symbol || "" },
    { id: "assetName", label: "Fund name", value: fund.name || "" },
    { id: "assetBank", label: "Bank / channel", value: fund.bank || "" },
    { id: "assetPort", label: "Port", value: fund.port || "" },
    { id: "assetCategory", label: "Category", kind: "select", options: Object.keys(categoryPalette), value: fund.category || "Government Bonds" },
    { id: "assetNavCurrency", label: "NAV currency", kind: "select", options: Object.keys(currencyConfig), value: navCurrency },
    { id: "assetPurchase", label: isForeign ? "Invested amount (THB)" : "Invested amount", type: "number", step: "0.01", value: fund.purchaseAmount ?? "", min: "0" },
    { id: "assetFeeRate", label: "Front fee (%)", type: "number", step: "0.01", value: fund.frontFeeRate ?? "0", min: "0" },
    { id: "assetUnits", label: "Units owned", type: "number", step: "0.0001", value: fund.units ?? "", min: "0" },
    { id: "assetBuyingNav", label: `Buying NAV${navUnit}`, type: "number", step: "0.0001", value: fund.buyingNav ?? "", min: "0" },
    { id: "assetNavLagDays", label: "NAV lag (days)", type: "number", step: "1", value: navLagDays, min: "0" },
    { id: "assetCurrentNav", label: `Current NAV${navUnit}`, type: "number", step: "0.0001", value: fund.currentNav ?? fund.baseNav ?? "", min: "0" },
    { id: "assetDailyChange", label: `Daily NAV change for NAV date ${readableDate(navDate)} (%)`, type: "number", step: "0.01", value: fund.dailyChangePct ?? "0.00" },
  ];

  if (isForeign) {
    fields.push(
      { id: "assetBuyFxRate", label: `Buy FX rate (THB per ${navCurrency})`, type: "number", step: "0.0001", value: fund.buyFxRate ?? "", min: "0" },
      { id: "assetCurrentFxRate", label: `Current FX rate (THB per ${navCurrency})`, type: "number", step: "0.0001", value: fund.fxRate ?? fund.currentFxRate ?? "", min: "0" },
    );
  }

  return fieldMarkup(fields);
}

function cashAssetFieldMarkup(cash = {}) {
  return fieldMarkup([
    { id: "assetCategory", label: "Category", kind: "select", options: Object.keys(categoryPalette), value: CASH_CATEGORY },
    { id: "cashName", label: "Cash label", value: cash.name || cash.assetName || "Available Cash" },
    { id: "cashBank", label: "Bank / channel", value: cash.bank || cash.assetBank || "Cash" },
    { id: "cashPort", label: "Port", value: cash.port || cash.assetPort || "Uninvested" },
    { id: "cashBalance", label: "Cash balance", type: "number", step: "0.01", value: cash.cashBalance ?? cash.assetPurchase ?? "", min: "0" },
  ]);
}

function readAssetFormValues() {
  const field = (id) => document.querySelector(`#${id}`);
  return {
    symbol: field("assetSymbol")?.value,
    name: field("assetName")?.value,
    bank: field("assetBank")?.value,
    port: field("assetPort")?.value,
    category: field("assetCategory")?.value,
    navCurrency: field("assetNavCurrency")?.value,
    purchaseAmount: field("assetPurchase")?.value,
    frontFeeRate: field("assetFeeRate")?.value,
    units: field("assetUnits")?.value,
    buyingNav: field("assetBuyingNav")?.value,
    navLagDays: field("assetNavLagDays")?.value,
    currentNav: field("assetCurrentNav")?.value,
    dailyChangePct: field("assetDailyChange")?.value,
    buyFxRate: field("assetBuyFxRate")?.value,
    fxRate: field("assetCurrentFxRate")?.value,
  };
}

// Re-render the asset form when its type changes so Cash does not ask for fund-only
// fields, and foreign-currency funds can still show/hide FX fields.
function bindAssetFormHelpers() {
  const categoryInput = document.querySelector("#assetCategory");
  const currencyInput = document.querySelector("#assetNavCurrency");

  categoryInput?.addEventListener("change", () => {
    const fields = document.querySelector("#dialogFields");
    if (!fields) return;
    const values = readAssetFormValues();
    fields.innerHTML = categoryInput.value === CASH_CATEGORY
      ? cashAssetFieldMarkup({ ...values, ...readCashFormValues() })
      : fundFieldMarkup({ ...values, category: categoryInput.value });
    bindAssetFormHelpers();
  });

  currencyInput?.addEventListener("change", () => {
    const fields = document.querySelector("#dialogFields");
    if (!fields) return;
    const values = readAssetFormValues();
    fields.innerHTML = fundFieldMarkup(values, currencyInput.value);
    bindAssetFormHelpers();
  });
}

function cashFieldMarkup(cash = {}) {
  return fieldMarkup([
    { id: "cashName", label: "Cash label", value: cash.name || "Available Cash" },
    { id: "cashBank", label: "Bank / channel", value: cash.bank || "Cash" },
    { id: "cashPort", label: "Port", value: cash.port || "Uninvested" },
    { id: "cashBalance", label: "Cash balance", type: "number", step: "0.01", value: cash.cashBalance ?? "", min: "0" },
  ]);
}

function readCashFormValues() {
  const field = (id) => document.querySelector(`#${id}`);
  return {
    name: field("cashName")?.value || "Available Cash",
    bank: field("cashBank")?.value || "Cash",
    port: field("cashPort")?.value || "Uninvested",
    cashBalance: Number(field("cashBalance")?.value || 0),
    cashBasis: Number(field("cashBalance")?.value || 0),
  };
}

function renderHero() {
  syncLogDateInput();
  const total = totals();
  const navMove = total.fundValue - total.baseFundValue;
  const navMovePct = total.baseFundValue > 0 ? (navMove / total.baseFundValue) * 100 : 0;
  const pnlNode = document.querySelector(".primary-value .metric-up");
  const pnlPercentNode = document.querySelector("#pnlPercent");
  const dayChangeNode = document.querySelector("#dayChange");
  const dayChangePctNode = document.querySelector("#dayChangePct");

  const pnlDirection = total.pnl === 0 ? "" : total.pnl >= 0 ? "▲ " : "▼ ";
  const pnlAmount = `${pnlDirection}${money(Math.abs(total.pnl))}`;
  const pnlPercent = `(${Math.abs(total.pnlPct).toFixed(2)}%)`;

  document.querySelector(".primary-value strong").innerHTML = `<span class="private-value">${money(total.fundValue)}</span>`;
  if (pnlNode) pnlNode.innerHTML = `<span class="private-value">${pnlAmount}</span> <span>${pnlPercent}</span>`;
  pnlNode?.classList.toggle("red", total.pnl < 0);
  pnlNode?.classList.toggle("neutral", total.pnl === 0);
  setText("#pnlPercent", pct(total.pnlPct));
  pnlPercentNode?.classList.toggle("green", total.pnlPct > 0);
  pnlPercentNode?.classList.toggle("red", total.pnlPct < 0);
  pnlPercentNode?.classList.toggle("neutral", total.pnlPct === 0);
  if (dayChangeNode) dayChangeNode.innerHTML = `<span class="private-value">${navMove === 0 ? "" : navMove >= 0 ? "▲ " : "▼ "}${money(Math.abs(navMove))}</span>`;
  dayChangeNode?.classList.toggle("green", navMove > 0);
  dayChangeNode?.classList.toggle("red", navMove < 0);
  dayChangeNode?.classList.toggle("neutral", navMove === 0);
  setText("#dayChangePct", `${navMove === 0 ? "" : navMove >= 0 ? "▲ " : "▼ "}${Math.abs(navMovePct).toFixed(2)}%`);
  dayChangePctNode?.classList.toggle("green", navMove > 0);
  dayChangePctNode?.classList.toggle("red", navMove < 0);
  dayChangePctNode?.classList.toggle("neutral", navMove === 0);

  const heroCard = document.querySelector(".hero-card");
  if (heroCard) {
    heroCard.classList.remove("hero-up", "hero-down");
    if (navMove > 0) heroCard.classList.add("hero-up");
    else if (navMove < 0) heroCard.classList.add("hero-down");
  }
}

function renderHoldings() {
  const body = document.querySelector("#holdingsBody");
  const sorted = getSortedHoldings();
  const total = totals();

  if (sorted.length === 0) {
    body.innerHTML = `
      <tr class="empty-table-row">
        <td colspan="12">
          <div class="empty-table-state">
            <strong>No investments or cash yet</strong>
            <span>Add a fund, deposit cash, or import JSON to start tracking portfolio value.</span>
          </div>
        </td>
      </tr>
    `;
  } else {
    body.innerHTML = sorted.map((item) => isCashHolding(item) ? `
    <tr data-symbol="${item.symbol}" class="cash-row">
      <td data-label="Fund">
        <div class="asset-cell">
          <span class="asset-name"><strong>${item.symbol} <span class="ccy-chip cash-chip" title="Available cash">Cash</span></strong><span>${item.name}</span></span>
        </div>
      </td>
      <td data-label="Bank / Port"><strong>${item.bank}</strong><span class="cell-note">${item.port}</span></td>
      <td data-label="Category"><span class="category-pill" style="--pill-color:${colorForCategory(item.category)}">${item.category}</span></td>
      <td class="private-value" data-label="Cash Basis">${money(item.purchaseAmount)}</td>
      <td data-label="Front Fee">N/A</td>
      <td data-label="Units">N/A</td>
      <td data-label="Buying NAV">N/A</td>
      <td data-label="Daily NAV %"><span class="neutral">0.00%</span></td>
      <td data-label="Current NAV">N/A</td>
      <td class="private-value" data-label="Current Value">${money(item.currentValue)}</td>
      <td class="${item.pnlPct >= 0 ? "green" : "red"}" data-label="P&L">${pct(item.pnlPct)}</td>
      <td data-label="">
        <button class="table-action-button" type="button" data-edit-fund="${item.symbol}" aria-label="Edit Cash">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          <span>Edit</span>
        </button>
      </td>
    </tr>
  ` : `
    <tr data-symbol="${item.symbol}">
      <td data-label="Fund">
        <div class="asset-cell">
          <span class="asset-name"><strong>${item.symbol}${item.navCurrency && item.navCurrency !== "THB" ? ` <span class="ccy-chip" title="NAV in ${item.navCurrency}, valued at ${nav(item.fxRate)} THB/${item.navCurrency}">${item.navCurrency}</span>` : ""}</strong><span>${item.name}</span></span>
        </div>
      </td>
      <td data-label="Bank / Port"><strong>${item.bank}</strong><span class="cell-note">${item.port}</span></td>
      <td data-label="Category"><span class="category-pill" style="--pill-color:${colorForCategory(item.category)}">${item.category}</span></td>
      <td class="private-value" data-label="Invested">${money(item.purchaseAmount)}</td>
      <td data-label="Front Fee">${item.frontFeeRate.toFixed(2)}%</td>
      <td class="private-value" data-label="Units">${item.units.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
      <td class="private-value" data-label="Buying NAV">${nav(item.buyingNav)}</td>
      <td data-label="Daily NAV %">
        <span class="nav-change-cell">
          <input class="nav-change-input ${item.dailyChangePct < 0 ? "negative" : ""}" type="number" step="0.01" value="${item.dailyChangePct.toFixed(2)}" data-symbol="${item.symbol}" title="NAV date: ${navDateCaption(item)}" aria-label="${item.symbol} daily NAV change percent for ${readableDate(item.navDate)}" />
        </span>
      </td>
      <td data-label="Current NAV">
        <span class="current-nav-cell">
          <input class="current-nav-input private-input" type="number" step="0.0001" min="0" value="${item.currentNav.toFixed(4)}" data-symbol="${item.symbol}" title="NAV date: ${navDateCaption(item)}" aria-label="${item.symbol} current NAV for ${readableDate(item.navDate)}" />
        </span>
      </td>
      ${item.navCurrency && item.navCurrency !== "THB" ? `
      <td data-label="Current Value">
        <span class="fund-value-cell">
          <input class="fund-value-input private-input" type="text" inputmode="decimal" value="${money(item.currentValue)}" data-symbol="${item.symbol}" title="Type the value shown in your bank app. The FX rate (currently ${nav(item.fxRate)} THB/${item.navCurrency}) is derived automatically." aria-label="${item.symbol} current value in ${state.currency}" />
        </span>
      </td>` : `
      <td class="private-value" data-label="Current Value">${money(item.currentValue)}</td>`}
      <td class="${item.pnlPct >= 0 ? "green" : "red"}" data-label="P&L">${pct(item.pnlPct)}</td>
      <td data-label="">
        <button class="table-action-button" type="button" data-edit-fund="${item.symbol}" aria-label="Edit ${item.symbol}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          <span>Edit</span>
        </button>
      </td>
    </tr>
  `).join("") + `
    <tr class="total-row">
      <td>Total</td>
      <td></td>
      <td>${sorted.length} assets</td>
      <td class="private-value">${money(total.paid)}</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td class="private-value">${money(total.fundValue)}</td>
      <td class="${total.pnlPct >= 0 ? "green" : "red"}">${pct(total.pnlPct)}</td>
      <td></td>
    </tr>
  `;
  }

  document.querySelectorAll("th[data-col]").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === sortState.col) {
      th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  body.querySelectorAll("tr[data-symbol]").forEach((row) => {
    row.addEventListener("click", () => openEditFundDialog(row.dataset.symbol));
  });

  body.querySelectorAll(".nav-change-input").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", () => updateDailyChange(input.dataset.symbol, Number(input.value || 0)));
  });

  body.querySelectorAll("[data-edit-fund]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditFundDialog(button.dataset.editFund);
    });
  });

  body.querySelectorAll(".current-nav-input").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", () => updateCurrentNav(input.dataset.symbol, Number(input.value || 0)));
  });

  body.querySelectorAll(".fund-value-input").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("focus", () => input.select());
    input.addEventListener("change", () => updateFundValueTHB(input.dataset.symbol, input.value));
  });
}

// For foreign-currency funds: the user types the THB value straight from their
// bank app and the implied FX rate is back-solved, so P&L, charts, and totals
// stay consistent without anyone looking up exchange rates.
function updateFundValueTHB(symbol, rawValue) {
  const fund = holdings.find((item) => item.symbol === symbol);
  if (!fund) return;

  // Accept formatted input like "฿492,676.85" or plain "492676.85", in the
  // currently displayed currency, and convert back to the THB base.
  const parsed = Number(String(rawValue).replace(/[^0-9.-]/g, ""));
  const value = parsed / currencyConfig[state.currency].rate;

  if (!Number.isFinite(value) || value <= 0) {
    showToast("Current value needs a positive amount.");
    renderAll();
    return;
  }

  const derived = deriveFund(fund);
  const nativeValue = derived.units * derived.currentNav;
  if (nativeValue <= 0) {
    showToast("Set units and current NAV before entering a THB value.");
    renderAll();
    return;
  }

  fund.fxRate = value / nativeValue;
  savePortfolio();
  renderAll();
  showToast(`${symbol} valued at ${money(value)} (implies ${nav(fund.fxRate)} THB/${fundNavCurrency(fund)}).`);
}

function updateDailyChange(symbol, value) {
  const fund = holdings.find((item) => item.symbol === symbol);
  if (!fund) return;
  const nextValue = Number.isFinite(value) ? value : 0;
  const navDate = navEffectiveDate(fund);
  const previousNav = navBeforeDate(fund, navDate);
  const nextNav = previousNav > 0 ? previousNav * (1 + nextValue / 100) : 0;
  fund.navHistory = upsertNavHistory(fund, navDate, nextValue, nextNav);
  fund.dailyChangePct = nextValue;
  savePortfolio();
  renderAll();
  showToast(`${symbol} NAV change for ${readableDate(navDate)} saved at ${nextValue.toFixed(2)}%.`);
}

function updateCurrentNav(symbol, value) {
  const fund = holdings.find((item) => item.symbol === symbol);
  if (!fund) return;

  if (!Number.isFinite(value) || value <= 0) {
    showToast("Current NAV needs a positive value.");
    renderAll();
    return;
  }

  const navDate = navEffectiveDate(fund);
  const previousNav = navBeforeDate(fund, navDate);
  if (previousNav <= 0) {
    fund.baseNav = value;
    fund.currentNav = value;
    fund.navHistory = upsertNavHistory(fund, navDate, 0, value);
  } else {
    const impliedChangePct = ((value / previousNav) - 1) * 100;
    fund.navHistory = upsertNavHistory(fund, navDate, impliedChangePct, value);
    fund.dailyChangePct = impliedChangePct;
  }

  savePortfolio();
  renderAll();
  showToast(`${symbol} current NAV for ${readableDate(navDate)} saved at ${nav(value)}. Daily NAV is ${Number(fund.dailyChangePct || 0).toFixed(2)}%.`);
}

function renderActivities() {
  const list = document.querySelector("#activityList");
  const visibleActivities = sortedActivities();
  if (visibleActivities.length === 0) {
    list.innerHTML = `
      <div class="empty-panel-state">
        <strong>No fund activity yet</strong>
        <span>Your buys, sells, dividends, cash movements, and imports will appear here.</span>
      </div>
    `;
    return;
  }

  list.innerHTML = visibleActivities.map((item) => `
    <div class="activity-row" data-edit-activity="${item.id}">
      <span class="activity-date">${item.date}</span>
      <span class="badge ${{ Buy: "", Sell: "sell", Switch: "switch-type", Dividend: "dividend", Transfer: "transfer", Import: "import-type", Deposit: "deposit", Withdraw: "withdraw" }[item.type] ?? "import-type"}">${item.type}</span>
      <strong>${item.type === "Switch" && item.switch ? `${item.switch.fromSymbol} → ${item.switch.toSymbol}` : item.asset}</strong>
      <span class="activity-transaction">
        <b class="private-value">${activityAmountLabel(item)}</b>
        <small class="private-value">${activityDetailLabel(item)}</small>
      </span>
      <span class="row-chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m7 4 6 6-6 6" /></svg></span>
    </div>
  `).join("");

  list.querySelectorAll("[data-edit-activity]").forEach((row) => {
    row.addEventListener("click", () => openEditActivityDialog(row.dataset.editActivity));
  });
}

function formatActivityUnits(value) {
  const cleaned = String(value || "").replace(/^\+/, "").trim();
  return cleaned ? `${cleaned} units` : "";
}

function activityAmountLabel(activity) {
  if (activity.type === "Withdraw") return `-${money(activity.amount)}`;
  if (activity.type === "Dividend") return money(dividendNetAmount(activity));
  return money(activity.amount);
}

function activityDetailLabel(activity) {
  if (activity.type === "Sell" && activity.depositedToCash) return "Deposited to Cash";
  if (activity.type === "Buy" && activity.fromCash) return `Paid from Cash${activity.units ? ` · ${formatActivityUnits(activity.units)}` : ""}`;
  if (activity.type === "Deposit") return "Added to Cash";
  if (activity.type === "Withdraw") return "Removed from Cash";
  if (activity.type !== "Dividend") return formatActivityUnits(activity.units);
  const tax = dividendTaxAmount(activity);
  const prefix = activity.depositedToCash ? "Deposited to Cash" : "Dividend received";
  return tax > 0 ? `${prefix} · Tax ${money(tax)}` : prefix;
}

function parseUnits(value) {
  const parsed = Number(String(value || "").replace(/[,+]/g, "").trim());
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function activityUnitCount(activity) {
  return parseUnits(activity.units);
}

function signedUnits(type, units) {
  const sign = type === "Sell" ? "-" : "+";
  return `${sign}${units.toFixed(4)}`;
}

function activityAffectsHolding(type) {
  return type === "Buy" || type === "Sell";
}

function sellCostBasis(holding, units) {
  const currentUnits = Number(holding.units || 0);
  const currentAmount = Number(holding.purchaseAmount || 0);
  if (units >= currentUnits - 0.0001) return currentAmount;
  return currentUnits > 0 ? currentAmount * (units / currentUnits) : 0;
}

function previewOrderEffect(holding, type, units, amount, direction = 1, costBasisOverride) {
  const currentUnits = Number(holding.units || 0);
  const currentAmount = Number(holding.purchaseAmount || 0);
  let nextUnits = currentUnits;
  let nextAmount = currentAmount;

  if (type === "Sell" && direction === 1) {
    if (units > currentUnits + 0.0001) return null;
    const isFullSell = units >= currentUnits - 0.0001;
    const costReduction = isFullSell ? currentAmount : currentUnits > 0 ? currentAmount * (units / currentUnits) : 0;
    nextUnits = isFullSell ? 0 : currentUnits - units;
    nextAmount = isFullSell ? 0 : currentAmount - costReduction;
  } else if (type === "Sell" && direction === -1) {
    nextUnits = currentUnits + units;
    nextAmount = currentAmount + Number(costBasisOverride ?? amount);
  } else {
    const unitMove = type === "Buy" ? units : 0;
    const amountMove = type === "Buy" ? amount : 0;
    nextUnits = currentUnits + unitMove * direction;
    nextAmount = currentAmount + amountMove * direction;
  }

  if (nextUnits < -0.0001 || nextAmount < -0.01) return null;

  return {
    units: Math.max(nextUnits, 0),
    purchaseAmount: Math.max(nextAmount, 0),
  };
}

function applyOrderToHolding(holding, type, units, amount, direction = 1, costBasisOverride) {
  const wasArchived = {
    archived: Boolean(holding.archived),
    archivedAt: holding.archivedAt,
    archivedDate: holding.archivedDate,
    archivedSaleAmount: holding.archivedSaleAmount,
    archivedUnits: holding.archivedUnits,
    archivedPnl: holding.archivedPnl,
    archivedPnlPct: holding.archivedPnlPct,
  };
  const previousUnits = Number(holding.units || 0);
  const previousAmount = Number(holding.purchaseAmount || 0);
  const next = previewOrderEffect(holding, type, units, amount, direction, costBasisOverride);
  if (!next) return false;

  holding.units = next.units;
  holding.purchaseAmount = next.purchaseAmount;
  if (next.units > 0) holding.buyingNav = next.purchaseAmount / next.units;
  if (next.units === 0) holding.buyingNav = Number(holding.buyingNav || 0);
  if (next.units === 0 && type === "Sell" && direction === 1) {
    holding.archived = true;
    holding.archivedAt = readableDate(activeDateKey());
    holding.archivedDate = activeDateKey();
    holding.archivedSaleAmount = amount;
    holding.archivedUnits = previousUnits || units;
    holding.archivedPnl = amount - previousAmount;
    holding.archivedPnlPct = previousAmount > 0 ? ((amount - previousAmount) / previousAmount) * 100 : 0;
  } else if (next.units > 0) {
    holding.archived = false;
    delete holding.archivedAt;
    delete holding.archivedDate;
    delete holding.archivedSaleAmount;
    delete holding.archivedUnits;
    delete holding.archivedPnl;
    delete holding.archivedPnlPct;
  } else if (type === "Sell" && direction === -1) {
    Object.assign(holding, wasArchived);
  }
  return true;
}

// Build the full math for a fund-to-fund switch from the few values the user types.
// Switching OUT (source) carries no front fee — like a sell. Switching IN (destination)
// incurs the destination fund's front fee, so units are priced at the marked-up NAV.
function buildSwitchData(source, dest, invested, switchOutNav, destBuyingNav) {
  const destFeeRate = Number(dest.frontFeeRate || 0);
  const destOfferNav = destBuyingNav * (1 + destFeeRate / 100);
  const sourceUnits = switchOutNav > 0 ? invested / switchOutNav : 0;
  const destUnits = destOfferNav > 0 ? invested / destOfferNav : 0;
  return {
    fromSymbol: source.symbol,
    toSymbol: dest.symbol,
    amount: invested,
    switchOutNav,
    sourceUnits,
    destBuyingNav,
    destFeeRate,
    destOfferNav,
    destUnits,
  };
}

const ARCHIVE_KEYS = ["archivedAt", "archivedDate", "archivedSaleAmount", "archivedUnits", "archivedPnl", "archivedPnlPct"];

function clearArchiveState(holding) {
  holding.archived = false;
  ARCHIVE_KEYS.forEach((key) => delete holding[key]);
}

// Apply (direction 1) or reverse (direction -1) a switch across both holdings.
// Reversal relies on the cost/unit figures captured into `data` when first applied.
function applySwitch(data, direction = 1) {
  const source = holdings.find((item) => item.symbol === data.fromSymbol);
  const dest = holdings.find((item) => item.symbol === data.toSymbol);
  if (!source || !dest) return false;

  if (direction === 1) {
    const srcUnits = Number(source.units || 0);
    if (data.sourceUnits > srcUnits + 0.0001) return false;
    const srcAmount = Number(source.purchaseAmount || 0);
    const isFull = data.sourceUnits >= srcUnits - 0.0001;
    const costRemoved = isFull ? srcAmount : srcUnits > 0 ? srcAmount * (data.sourceUnits / srcUnits) : 0;
    const destCapitalAdded = data.destUnits * data.destBuyingNav;

    // Capture what's needed to reverse this exact switch later.
    data.sourceCostRemoved = costRemoved;
    data.sourceEmptied = isFull;
    data.destCapitalAdded = destCapitalAdded;

    // Source side — switch out (no fee), mirroring a partial/full sell.
    source.units = isFull ? 0 : srcUnits - data.sourceUnits;
    source.purchaseAmount = isFull ? 0 : srcAmount - costRemoved;
    if (isFull) {
      source.archived = true;
      source.archivedAt = readableDate(activeDateKey());
      source.archivedDate = activeDateKey();
      source.archivedSaleAmount = data.amount;
      source.archivedUnits = srcUnits;
      source.archivedPnl = data.amount - srcAmount;
      source.archivedPnlPct = srcAmount > 0 ? ((data.amount - srcAmount) / srcAmount) * 100 : 0;
    }

    // Destination side — switch in (with front fee baked into the marked-up NAV).
    const destPrevUnits = Number(dest.units || 0);
    const destPrevAmount = Number(dest.purchaseAmount || 0);
    const destPrevCapital = destPrevUnits * Number(dest.buyingNav || 0);
    const newDestUnits = destPrevUnits + data.destUnits;
    dest.units = newDestUnits;
    dest.purchaseAmount = destPrevAmount + data.amount;
    // Keep buyingNav as the fee-free base NAV (units-weighted) so feePaid stays accurate.
    dest.buyingNav = newDestUnits > 0 ? (destPrevCapital + destCapitalAdded) / newDestUnits : data.destBuyingNav;
    if (dest.archived) clearArchiveState(dest);
    return true;
  }

  // Reverse: restore the source units/cost, then pull the destination units/cost back out.
  const srcUnits = Number(source.units || 0);
  const srcAmount = Number(source.purchaseAmount || 0);
  source.units = srcUnits + data.sourceUnits;
  source.purchaseAmount = srcAmount + Number(data.sourceCostRemoved || 0);
  if (data.sourceEmptied) clearArchiveState(source);

  const destPrevUnits = Number(dest.units || 0);
  const destPrevAmount = Number(dest.purchaseAmount || 0);
  const destPrevCapital = destPrevUnits * Number(dest.buyingNav || 0);
  const newDestUnits = Math.max(destPrevUnits - data.destUnits, 0);
  dest.units = newDestUnits;
  dest.purchaseAmount = Math.max(destPrevAmount - data.amount, 0);
  dest.buyingNav = newDestUnits > 0
    ? Math.max(destPrevCapital - Number(data.destCapitalAdded || 0), 0) / newDestUnits
    : Number(dest.buyingNav || 0);
  return true;
}

// Forward/reverse an activity's effect on holdings, routing switches to applySwitch
// and buys/sells to applyOrderToHolding.
function reverseHoldingEffect(activity) {
  if (activity.type === "Switch" && activity.switch) return applySwitch(activity.switch, -1);
  const holding = holdings.find((item) => item.symbol === activity.asset);
  if (!activityAffectsHolding(activity.type) || !holding) return true;
  return applyOrderToHolding(holding, activity.type, activityUnitCount(activity), Number(activity.amount || 0), -1, Number(activity.cashBasisAmount || 0) || undefined);
}

function applyHoldingEffect(activity) {
  if (activity.type === "Switch" && activity.switch) return applySwitch(activity.switch, 1);
  const holding = holdings.find((item) => item.symbol === activity.asset);
  if (!activityAffectsHolding(activity.type) || !holding) return true;
  return applyOrderToHolding(holding, activity.type, activityUnitCount(activity), Number(activity.amount || 0), 1);
}

function reverseActivityEffect(activity) {
  if (!reverseHoldingEffect(activity)) return false;
  if (!applyCashEffect(activity, -1)) {
    applyHoldingEffect(activity);
    return false;
  }
  return true;
}

function applyActivityEffect(activity) {
  if (!applyHoldingEffect(activity)) return false;
  if (!applyCashEffect(activity, 1)) {
    reverseHoldingEffect(activity);
    return false;
  }
  return true;
}

function computeNiceTicks(dataMin, dataMax, count = 5) {
  const range = Math.max(dataMax - dataMin, 1);
  const rawStep = range / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceMultipliers = [1, 2, 2.5, 5, 10];
  const multiplier = niceMultipliers.find((m) => m * magnitude >= rawStep) ?? 10;
  const step = multiplier * magnitude;
  const niceMin = Math.floor(dataMin / step) * step;
  return Array.from({ length: count }, (_, i) => niceMin + (count - 1 - i) * step);
}

function rangeStartKey(range, endKey) {
  if (range === "1W") return shiftDate(endKey, -6, "day");
  if (range === "1M") return shiftDate(endKey, -1, "month");
  if (range === "3M") return shiftDate(endKey, -3, "month");
  if (range === "6M") return shiftDate(endKey, -6, "month");
  if (range === "YTD") return `${endKey.slice(0, 4)}-01-01`;
  if (range === "1Y") return shiftDate(endKey, -1, "year");
  return null;
}

function formatChartDate(dateKey, range) {
  const date = parseDateKey(dateKey);
  if (range === "ALL") return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// X-axis ticks. The 1W view labels the selected seven-day window, even when
// only some days have logs, so the date picker and chart always agree.
// Longer ranges use evenly spaced ticks snapped to whole days.
function chartTickMarks(chartSnapshots, startMs, endMs, range, count = 5) {
  const span = Math.max(endMs - startMs, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  const marks = range === "1W"
    ? Array.from({ length: Math.floor(span / dayMs) + 1 }, (_, index) => {
      const key = dateKeyFromDate(new Date(startMs + index * dayMs));
      return { ms: parseDateKey(key).getTime(), label: formatChartDate(key, range) };
    })
    : Array.from({ length: count }, (_, index) => {
      const key = dateKeyFromDate(new Date(startMs + (span * index) / (count - 1)));
      return { ms: parseDateKey(key).getTime(), label: formatChartDate(key, range) };
    });

  const seen = new Set();
  return marks.filter((mark) => {
    if (seen.has(mark.label) || mark.ms < startMs || mark.ms > endMs) return false;
    seen.add(mark.label);
    return true;
  });
}

function snapshotPath(snapshots, valueKey, min, max, startMs, endMs, width, height, left, top) {
  return snapshots.map((snapshot, index) => {
    const snapshotMs = parseDateKey(snapshot.date).getTime();
    const x = left + ((snapshotMs - startMs) / Math.max(endMs - startMs, 1)) * width;
    const y = top + height - ((snapshot[valueKey] - min) / Math.max(max - min, 1)) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function snapshotsForRange(range) {
  const snapshots = snapshotsWithLiveCurrent(portfolioSnapshots);
  if (snapshots.length === 0) return { snapshots: [], startKey: activeDateKey(), endKey: activeDateKey() };

  const endKey = activeDateKey();
  const firstKey = snapshots[0].date;
  const requestedStartKey = rangeStartKey(range, endKey);
  const startKey = requestedStartKey ? requestedStartKey : firstKey;
  const visible = snapshots.filter((snapshot) => snapshot.date >= startKey && snapshot.date <= endKey);
  const fallback = [...snapshots].reverse().find((snapshot) => snapshot.date <= endKey) || snapshots[0];
  const usable = visible.length > 0 ? visible : [fallback];

  return { snapshots: usable, startKey, endKey };
}

function renderChart(range = "1W") {
  const svg = document.querySelector("#performanceChart");
  const insights = document.querySelector("#chartInsights");
  // Match the viewBox to the container's aspect ratio so the plot fills the
  // panel instead of letterboxing inside a fixed 1400x500 box. This must run
  // AFTER the insight cards are in the DOM, because they change the chart
  // area's height — measuring too early leaves the plot narrow.
  const fitChartWidth = () => {
    const wrap = svg.closest(".line-chart");
    const rect = wrap ? wrap.getBoundingClientRect() : null;
    const fitted = rect && rect.width > 0 && rect.height > 40
      ? Math.round(Math.min(Math.max((rect.width / rect.height) * 500, 600), 2800))
      : 1400;
    svg.setAttribute("viewBox", `0 0 ${fitted} 500`);
    return fitted;
  };
  const left = 74;
  const right = 32;
  const top = 26;
  const height = 382;
  const total = totals();
  if (total.list.length === 0) {
    if (insights) {
      insights.innerHTML = [
        ["Range Change", "0.00%"],
        ["High", "No data"],
        ["Low", "No data"],
        ["Logged Days", "0"],
      ].map(([label, value]) => `<div class="chart-insight"><span>${label}</span><strong class="neutral">${value}</strong></div>`).join("");
    }
    const chartWidth = fitChartWidth();
    const width = chartWidth - left - right;
    svg.innerHTML = `
      <line class="chart-grid" x1="${left}" y1="${top}" x2="${left + width}" y2="${top}" />
      <line class="chart-grid" x1="${left}" y1="${top + 96}" x2="${left + width}" y2="${top + 96}" />
      <line class="chart-grid" x1="${left}" y1="${top + 192}" x2="${left + width}" y2="${top + 192}" />
      <line class="chart-grid" x1="${left}" y1="${top + 288}" x2="${left + width}" y2="${top + 288}" />
      <text class="chart-axis" x="${chartWidth / 2}" y="${top + 192}" text-anchor="middle">Add funds to see performance</text>
    `;
    return;
  }

  const { snapshots, startKey, endKey } = snapshotsForRange(range);
  const latestSavedSnapshot = snapshots[snapshots.length - 1];
  const displaySnapshots = latestSavedSnapshot && latestSavedSnapshot.date < endKey
    ? [...snapshots, currentSnapshot(endKey)]
    : snapshots;
  const startMs = parseDateKey(startKey).getTime();
  let endMs = parseDateKey(endKey).getTime();
  if (endMs <= startMs) endMs = parseDateKey(shiftDate(startKey, 1, "day")).getTime();

  const chartSnapshots = displaySnapshots.length === 1
    ? [
      { ...displaySnapshots[0], date: startKey },
      { ...displaySnapshots[0], date: dateKeyFromDate(new Date(endMs)) },
    ]
    : displaySnapshots;

  const rangeStart = displaySnapshots[0];
  const rangeEnd = displaySnapshots[displaySnapshots.length - 1];
  const rangeDelta = rangeEnd.totalFundValue - rangeStart.totalFundValue;
  const rangePct = rangeStart.totalFundValue > 0 ? (rangeDelta / rangeStart.totalFundValue) * 100 : 0;
  const high = displaySnapshots.reduce((maxSnapshot, snapshot) => snapshot.totalFundValue > maxSnapshot.totalFundValue ? snapshot : maxSnapshot, displaySnapshots[0]);
  const low = displaySnapshots.reduce((minSnapshot, snapshot) => snapshot.totalFundValue < minSnapshot.totalFundValue ? snapshot : minSnapshot, displaySnapshots[0]);
  if (insights) {
    insights.innerHTML = [
      { label: "Range Change", value: rangeChangeMarkup(rangeDelta, rangePct), tone: rangeDelta >= 0 ? "green" : "red" },
      { label: "High", value: `<span class="private-value">${money(high.totalFundValue, 0)}</span>`, tone: "" },
      { label: "Low", value: `<span class="private-value">${money(low.totalFundValue, 0)}</span>`, tone: "" },
      { label: "Logged Days", value: `${displaySnapshots.length}`, tone: "" },
    ].map((item) => `<div class="chart-insight"><span>${item.label}</span><strong class="${item.tone}">${item.value}</strong></div>`).join("");
  }

  const chartWidth = fitChartWidth();
  const width = chartWidth - left - right;
  const all = chartSnapshots.flatMap((snapshot) => [snapshot.totalFundValue, snapshot.totalPaid]);
  const rawMin = Math.min(...all) - Math.max(total.fundValue, total.paid, 1) * 0.035;
  const rawMax = Math.max(...all) + Math.max(total.fundValue, total.paid, 1) * 0.025;
  const yLabels = computeNiceTicks(rawMin, rawMax, 5);
  const min = yLabels[yLabels.length - 1];
  const max = yLabels[0];
  const portfolioPath = snapshotPath(chartSnapshots, "totalFundValue", min, max, startMs, endMs, width, height, left, top);
  const costPath = snapshotPath(chartSnapshots, "totalPaid", min, max, startMs, endMs, width, height, left, top);
  const latest = chartSnapshots[chartSnapshots.length - 1];
  const latestMs = parseDateKey(latest.date).getTime();
  const latestX = left + ((latestMs - startMs) / Math.max(endMs - startMs, 1)) * width;
  const latestY = top + height - ((latest.totalFundValue - min) / Math.max(max - min, 1)) * height;
  const areaPath = `${portfolioPath} L${latestX.toFixed(1)},${top + height} L${left},${top + height} Z`;
  const tickMarks = chartTickMarks(chartSnapshots, startMs, endMs, range);
  const config = currencyConfig[state.currency];
  const fmtY = (v) => {
    if (state.privacyMode) return "••••";
    const c = v * config.rate;
    if (Math.abs(c) >= 1_000_000) return `${config.symbol}${(c / 1_000_000).toFixed(1)}M`;
    return `${config.symbol}${Math.round(c / 1_000)}K`;
  };
  const pointForSnapshot = (snapshot) => {
    const snapshotMs = parseDateKey(snapshot.date).getTime();
    return {
      x: left + ((snapshotMs - startMs) / Math.max(endMs - startMs, 1)) * width,
      y: top + height - ((snapshot.totalFundValue - min) / Math.max(max - min, 1)) * height,
    };
  };
  const pointMarkers = chartSnapshots.map((snapshot, index) => {
    const point = pointForSnapshot(snapshot);
    const previous = chartSnapshots[index - 1];
    const delta = previous ? snapshot.totalFundValue - previous.totalFundValue : 0;
    const tone = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    return `<circle class="chart-point ${tone}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${index === chartSnapshots.length - 1 ? "5.2" : "4.4"}"><title>${readableDate(snapshot.date)} · ${tone === "up" ? "up" : tone === "down" ? "down" : "flat"} ${pct(previous && previous.totalFundValue > 0 ? (delta / previous.totalFundValue) * 100 : 0)}</title></circle>`;
  }).join("");

  svg.innerHTML = `
    <defs>
      <linearGradient id="portfolioFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#315dff" stop-opacity="0.14" />
        <stop offset="100%" stop-color="#315dff" stop-opacity="0" />
      </linearGradient>
    </defs>
    ${yLabels.map((label, index) => {
      const y = top + index * (height / (yLabels.length - 1));
      return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" />
        <text class="chart-axis" x="${left - 7}" y="${y + 4}" text-anchor="end">${fmtY(label)}</text>`;
    }).join("")}
    ${tickMarks.map((mark) => {
      const x = left + ((mark.ms - startMs) / Math.max(endMs - startMs, 1)) * width;
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${top + height + 42}" text-anchor="middle">${mark.label}</text>`;
    }).join("")}
    <path class="portfolio-area" d="${areaPath}" />
    <path class="cost-line" d="${costPath}" />
    <path class="portfolio-line" d="${portfolioPath}" />
    ${pointMarkers}
  `;
}

function renderAllocation() {
  const total = totals();
  const groups = sortedGroups(groupBy(total.list, (item) => item.category), total.fundValue);
  const donut = document.querySelector(".donut");

  if (groups.length === 0) {
    donut.style.background = "radial-gradient(circle at center, var(--surface) 0 42%, transparent 43%), conic-gradient(#e7ecf6 0 100%)";
    donut.__allocationGroups = [];
    document.querySelector(".donut-center strong").innerHTML = `<span class="private-value">${shortMoney(0)}</span>`;
    document.querySelector(".allocation-list").innerHTML = `
      <div class="empty-panel-state compact">
        <strong>No allocation yet</strong>
        <span>Fund categories will appear after you add holdings.</span>
      </div>
    `;
    return;
  }

  const stops = [];
  let cursor = 0;

  groups.forEach((group) => {
    const next = cursor + group.pct;
    stops.push(`${colorForCategory(group.key)} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`);
    group.startPct = cursor;
    group.endPct = next;
    cursor = next;
  });

  donut.style.background = `radial-gradient(circle at center, var(--surface) 0 42%, transparent 43%), conic-gradient(${stops.join(", ")})`;
  donut.__allocationGroups = groups;
  document.querySelector(".donut-center strong").innerHTML = `<span class="private-value">${shortMoney(total.fundValue)}</span>`;
  document.querySelector(".allocation-list").innerHTML = groups.map((group) => `
    <div>
      <i style="background:${colorForCategory(group.key)}"></i>
      <span>${group.key}</span>
      <b>${group.pct.toFixed(1)}%</b>
    </div>
  `).join("");
}

function bindAllocationTooltip() {
  const donut = document.querySelector(".donut");
  if (!donut || donut.dataset.tooltipBound) return;

  const tooltip = document.createElement("div");
  tooltip.className = "donut-tooltip";
  donut.append(tooltip);
  donut.dataset.tooltipBound = "true";

  donut.addEventListener("mousemove", (event) => {
    const groups = donut.__allocationGroups || [];
    if (groups.length === 0) {
      tooltip.classList.remove("show");
      return;
    }

    const rect = donut.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const radius = rect.width / 2;
    const dx = x - radius;
    const dy = y - radius;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < radius * 0.43 || distance > radius) {
      tooltip.classList.remove("show");
      return;
    }

    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
    const pctAtPointer = angle / 3.6;
    const group = groups.find((item) => pctAtPointer >= item.startPct && pctAtPointer <= item.endPct);

    if (!group) {
      tooltip.classList.remove("show");
      return;
    }

    const detail = state.privacyMode ? `${group.pct.toFixed(1)}%` : `${money(group.amount)} · ${group.pct.toFixed(1)}%`;
    tooltip.innerHTML = `<b>${group.key}</b><span>${detail}</span>`;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add("show");
  });

  donut.addEventListener("mouseleave", () => tooltip.classList.remove("show"));
}

function buildCalendarDays(monthKey, snapshots) {
  const [year, month] = String(monthKey).split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const leading = firstDay.getDay();
  const snapshotByDate = new Map(snapshots.map((snapshot) => [snapshot.date, snapshot]));

  return [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      const snapshot = snapshotByDate.get(date);
      if (!snapshot) return { date, day };

      const previous = [...snapshots].reverse().find((item) => item.date < date);
      const explicitDelta = Number(snapshot.dayPnlDelta);
      const explicitDeltaPct = Number(snapshot.dayPnlDeltaPct);
      const delta = Number.isFinite(explicitDelta)
        ? explicitDelta
        : previous ? Number(snapshot.pnl || 0) - Number(previous.pnl || 0) : 0;
      const deltaPct = Number.isFinite(explicitDeltaPct)
        ? explicitDeltaPct
        : previous && previous.totalPaid > 0 ? (delta / previous.totalPaid) * 100 : 0;
      return { date, day, snapshot, delta, deltaPct };
    }),
  ];
}

function renderValueCalendar() {
  const panel = document.querySelector(".summary-panel");
  const snapshots = snapshotsWithLiveCurrent(portfolioSnapshots);
  const latestSnapshot = snapshots[snapshots.length - 1];
  const latestMonth = latestSnapshot ? monthKeyFromDate(latestSnapshot.date) : monthKeyFromDate();
  if (!state.calendarMonth) state.calendarMonth = latestMonth;

  const days = buildCalendarDays(state.calendarMonth, snapshots);
  const loggedDays = days.filter((day) => day?.snapshot);
  const maxAbsDelta = Math.max(...loggedDays.map((day) => Math.abs(day.delta)), 1);
  const monthDelta = loggedDays.reduce((sum, day) => sum + day.delta, 0);
  const monthDeltaClass = monthDelta > 0 ? "green" : monthDelta < 0 ? "red" : "neutral";
  const monthDeltaLabel = monthDelta === 0 ? money(0) : `${monthDelta > 0 ? "+" : "−"}${money(Math.abs(monthDelta))}`;
  const positiveDays = days.filter((day) => day?.snapshot && day.delta > 0).length;
  const negativeDays = days.filter((day) => day?.snapshot && day.delta < 0).length;
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"];

  const cfg = currencyConfig[state.currency];

  panel.innerHTML = `
    <div class="calendar-heading">
      <h2>P&L Calendar</h2>
      <div class="calendar-controls" aria-label="Change calendar month">
        <button class="calendar-nav" type="button" data-calendar-shift="-1" aria-label="Previous month">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg>
        </button>
        <strong>${monthLabel(state.calendarMonth)}</strong>
        <button class="calendar-nav" type="button" data-calendar-shift="1" aria-label="Next month">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg>
        </button>
      </div>
    </div>
    <div class="calendar-stats" aria-label="Monthly P&L movement summary">
      ${loggedDays.length
        ? `<span class="calendar-stat-value private-value ${monthDeltaClass}" title="Investment P&L change for ${monthLabel(state.calendarMonth)}, excluding cash added or withdrawn">${monthDeltaLabel}</span>`
        : `<span class="calendar-stat-value" style="color:var(--muted);font-size:12px;font-weight:600">No data this month</span>`}
      <span><i class="calendar-dot up"></i>${positiveDays} up</span>
      <span><i class="calendar-dot down"></i>${negativeDays} down</span>
    </div>
    <div class="value-calendar" aria-label="Investment P&L calendar for ${monthLabel(state.calendarMonth)}">
      ${weekdays.map((day) => `<b class="calendar-weekday">${day}</b>`).join("")}
      ${days.map((day) => {
        if (!day) return `<span class="calendar-day empty"></span>`;
        if (!day.snapshot) return `<span class="calendar-day muted"><span>${day.day}</span></span>`;

        const tone = day.delta > 0 ? "up" : day.delta < 0 ? "down" : "flat";
        const heat = tone === "flat" ? "" : ` heat-${Math.min(Math.ceil((Math.abs(day.delta) / maxAbsDelta) * 3), 3)}`;
        const absDelta = Math.abs(day.delta) * cfg.rate;
        const deltaSign = day.delta > 0 ? "+" : day.delta < 0 ? "−" : "";
        const deltaStr = day.delta === 0 ? "—"
          : absDelta >= 1_000_000 ? `${deltaSign}${cfg.symbol}${(absDelta / 1_000_000).toFixed(1)}M`
          : absDelta >= 1_000 ? `${deltaSign}${cfg.symbol}${Math.round(absDelta / 1_000)}K`
          : `${deltaSign}${money(Math.abs(day.delta))}`;
        const deltaClass = tone === "up" ? "green" : tone === "down" ? "red" : "";
        const actionDetail = state.privacyMode
          ? `${readableDate(day.date)} ended ${tone === "up" ? "up" : tone === "down" ? "down" : "flat"} by ${pct(day.deltaPct)}.`
          : `${readableDate(day.date)} investment P&L ${tone === "up" ? "improved" : tone === "down" ? "fell" : "was flat"} by ${money(Math.abs(day.delta))}, ${pct(day.deltaPct)}. Portfolio value ended at ${money(day.snapshot.totalFundValue)}.`;
        return `
          <button class="calendar-day has-value ${tone}${heat}" type="button" data-action="${actionDetail}">
            <span>${day.day}</span>
            <strong class="private-value ${deltaClass}">${deltaStr}</strong>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderBreakdown() {
  const total = totals();
  if (total.list.length === 0) {
    document.querySelector(".pnl-list").innerHTML = `
      <div class="empty-panel-state">
        <strong>No P&L contribution yet</strong>
        <span>Each fund's contribution will appear once holdings are added.</span>
      </div>
    `;
    return;
  }

  const maxContribution = Math.max(...total.list.map((item) => Math.abs(item.pnlBaht)), 1);
  const sorted = [...total.list].sort((a, b) => Math.abs(b.pnlBaht) - Math.abs(a.pnlBaht));

  document.querySelector(".pnl-list").innerHTML = sorted.map((item) => `
    <button class="pnl-row" data-action="${item.symbol} P&L contribution selected">
      <span class="pnl-fund">
        <b>${item.symbol}</b>
        <small>${item.category}</small>
      </span>
      <span class="pnl-track" aria-hidden="true">
        <i class="${item.pnlBaht >= 0 ? "positive" : "negative"}" style="width:${Math.max((Math.abs(item.pnlBaht) / maxContribution) * 50, 3.5).toFixed(2)}%"></i>
      </span>
      <strong class="${item.pnlBaht >= 0 ? "green" : "red"}"><span class="private-value">${money(item.pnlBaht)}</span><small>${pct(item.pnlPct)}</small></strong>
    </button>
  `).join("");
}

function renderChannelExposure() {
  const total = totals();
  const groups = sortedGroups(groupBy(total.list, (item) => `${item.bank}||${item.port}`), total.fundValue);

  if (groups.length === 0) {
    document.querySelector(".events-panel").innerHTML = `
      <h2>Port Details</h2>
      <div class="empty-panel-state">
        <strong>No port details yet</strong>
        <span>Active bank and port exposure will appear after you add funds.</span>
      </div>
    `;
    return;
  }

  document.querySelector(".events-panel").innerHTML = `
    <h2>Port Details</h2>
    <div class="channel-list">
      ${groups.map((group) => {
        const [bank, port] = group.key.split("||");
        return `
          <button class="channel-row" data-action="${bank} ${port} selected">
            <span><b>${bank}</b><small>${port} · ${group.items.length} asset${group.items.length === 1 ? "" : "s"}</small></span>
            <strong><span class="private-value">${money(group.amount)}</span><small>${group.pct.toFixed(1)}% of assets</small></strong>
            <span class="channel-track" aria-hidden="true"><i style="width:${Math.max(group.pct, 2).toFixed(1)}%"></i></span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderAll(range = document.querySelector(".range-tabs .active")?.dataset.range || "1W") {
  renderHero();
  renderHoldings();
  renderActivities();
  renderChart(range);
  renderAllocation();
  renderValueCalendar();
  renderBreakdown();
  renderChannelExposure();
  bindDynamicButtons();
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function fieldMarkup(config) {
  return config.map((field) => {
    if (field.kind === "textarea") {
      return `
        <label>
          ${field.label}
          <textarea id="${field.id}" spellcheck="false">${field.value ?? ""}</textarea>
        </label>
      `;
    }

    if (field.kind === "select") {
      return `
        <label>
          ${field.label}
          <select id="${field.id}">
            ${field.options.map((option) => `<option value="${option}" ${option === field.value ? "selected" : ""}>${option}</option>`).join("")}
          </select>
        </label>
      `;
    }

    if (field.kind === "file") {
      return `
        <label class="file-upload-field">
          ${field.label}
          <input id="${field.id}" type="file" accept="${field.accept || ".json,application/json"}" />
          <span>${field.help || "Choose a JSON file from your computer."}</span>
        </label>
      `;
    }

    if (field.kind === "checkbox") {
      return `
        <label class="checkbox-field">
          <input id="${field.id}" type="checkbox" ${field.checked ? "checked" : ""} />
          <span>${field.label}</span>
        </label>
      `;
    }

    return `
      <label>
        ${field.label}
        <input id="${field.id}" type="${field.type || "text"}" step="${field.step || "any"}" value="${field.value ?? ""}" min="${field.min ?? ""}" />
      </label>
    `;
  }).join("");
}

function refreshPrices() {
  const btn = document.querySelector("#refreshButton");
  btn.classList.add("spinning");
  const heroValues = document.querySelectorAll(".primary-value strong, .primary-value .metric-up, #pnlPercent, #dayChange, #dayChangePct");
  heroValues.forEach((el) => el.classList.add("skeleton-pulse"));

  window.setTimeout(() => {
    holdings.forEach((fund) => {
      if (isCashHolding(fund)) return;
      const movement = 0.995 + Math.random() * 0.016;
      const baseNav = Number(fund.baseNav ?? fund.currentNav ?? fund.buyingNav);
      fund.baseNav = Number((baseNav * movement).toFixed(4));
    });
    savePortfolio();
    const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const fullLabel = `Last updated: ${todayLabel()} ${now}`;
    btn.title = fullLabel;
    document.querySelector(".last-updated").textContent = fullLabel;
    btn.classList.remove("spinning");
    heroValues.forEach((el) => el.classList.remove("skeleton-pulse"));
    renderAll();
    showToast("NAV refreshed. Fund values and charts updated.");
  }, 700);
}

function focusAnalytics() {
  const panels = [document.querySelector(".allocation-panel"), document.querySelector(".summary-panel"), document.querySelector(".breakdown-panel")];
  panels.forEach((panel) => {
    panel.classList.remove("focus-pulse");
    void panel.offsetWidth;
    panel.classList.add("focus-pulse");
  });
  document.querySelector(".allocation-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  showToast("Analysis panels focused.");
}

function importSampleData() {
  const input = document.querySelector("#jsonImport")?.value || "";
  let parsed;

  try {
    parsed = JSON.parse(input);
  } catch {
    showToast("Import JSON could not parse that text.");
    return false;
  }

  const importedHoldings = Array.isArray(parsed) ? parsed : parsed.holdings || parsed.funds || [];
  const importedActivities = parsed.activities || [];
  const importedSnapshots = normalizePortfolioSnapshots(parsed.portfolioSnapshots || parsed.snapshots || []);
  if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.logDate || "")) {
    state.logDate = parsed.logDate;
    state.calendarMonth = monthKeyFromDate(state.logDate);
  }

  importedHoldings.forEach((item) => {
    const symbol = String(item.symbol || item.fundCode || "").trim().toUpperCase();
    if (!symbol) return;

    if (isCashHolding({ ...item, symbol })) {
      const next = normalizeCashHolding({ ...item, symbol });
      const existingIndex = holdings.findIndex(isCashHolding);
      if (existingIndex >= 0) {
        holdings[existingIndex] = { ...holdings[existingIndex], ...next };
      } else if (next.cashBalance > 0) {
        holdings.push(next);
      }
      return;
    }

    const next = {
      symbol,
      name: String(item.name || item.fundName || symbol),
      bank: String(item.bank || "Unassigned Bank"),
      port: String(item.port || "Main Port"),
      category: String(item.category || "Mixed Allocation"),
      navCurrency: currencyConfig[item.navCurrency] ? item.navCurrency : "THB",
      fxRate: Number(item.fxRate || item.currentFxRate || 0) || 1,
      buyFxRate: Number(item.buyFxRate || item.fxRate || item.currentFxRate || 0) || 1,
      purchaseAmount: Number(item.purchaseAmount || item.orderAmount || item.capitalInvested || item.costBasis || 0),
      frontFeeRate: Number(item.frontFeeRate || item.frontFee || 0),
      navLagDays: normalizedNavLagDays(item),
      units: Number(item.units || item.unitsOwned || 0),
      buyingNav: Number(item.buyingNav || 0),
      currentNav: Number(item.currentNav || item.nav || 0),
      dailyChangePct: Number(item.dailyChangePct || item.dailyNavChange || 0),
      archived: Boolean(item.archived || item.inactive),
      archivedAt: item.archivedAt,
      archivedDate: item.archivedDate,
      archivedSaleAmount: Number(item.archivedSaleAmount || 0),
      archivedUnits: Number(item.archivedUnits || 0),
      archivedPnl: Number(item.archivedPnl ?? ((Number(item.archivedSaleAmount || 0) - Number(item.costBasisAtArchive || 0)) || 0)),
      archivedPnlPct: Number(item.archivedPnlPct || 0),
      navHistory: normalizeNavHistory({
        navHistory: item.navHistory || item.dailyNavHistory || item.navEntries || [],
        dailyChangePct: Number(item.dailyChangePct || item.dailyNavChange || 0),
        navDate: item.navDate,
      }),
    };

    const existingIndex = holdings.findIndex((holding) => holding.symbol === symbol);
    if (existingIndex >= 0) {
      holdings[existingIndex] = { ...holdings[existingIndex], ...next };
    } else {
      holdings.push(next);
    }
  });

  normalizeActivities(importedActivities).forEach((item) => {
    activities.unshift({ ...item, id: makeId("activity") });
  });

  if (importedHoldings.length > 0 && importedActivities.length === 0) {
    activities.unshift({
      id: makeId("activity"),
      date: readableDate(activeDateKey()),
      createdAt: new Date().toISOString(),
      type: "Import",
      asset: "JSON",
      units: `+${importedHoldings.length} fund${importedHoldings.length === 1 ? "" : "s"}`,
      amount: importedHoldings.reduce((sum, item) => sum + Number(item.purchaseAmount || item.orderAmount || item.capitalInvested || 0), 0),
    });
  }

  importedSnapshots.forEach((snapshot) => {
    const existingIndex = portfolioSnapshots.findIndex((item) => item.date === snapshot.date);
    if (existingIndex >= 0) {
      portfolioSnapshots[existingIndex] = snapshot;
    } else {
      portfolioSnapshots.push(snapshot);
    }
  });
  portfolioSnapshots.sort((a, b) => a.date.localeCompare(b.date));

  savePortfolio({ captureSnapshot: false });
  renderAll();
  showToast(`Imported ${importedHoldings.length} fund${importedHoldings.length === 1 ? "" : "s"} from JSON.`);
  return true;
}

function bindJsonFileInput() {
  const input = document.querySelector("#jsonFileInput");
  if (!input) return;

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      document.querySelector("#jsonImport").value = text;
      JSON.parse(text);
      showToast(`${file.name} loaded. Confirm to import.`);
    } catch {
      showToast(`${file.name} is not valid JSON.`);
    }
  });
}

function buildExportPayload() {
  return {
    exportedAt: new Date().toISOString(),
    currency: state.currency,
    logDate: activeDateKey(),
    holdings: holdings.map((holding) => {
      if (isCashHolding(holding)) {
        const cash = normalizeCashHolding(holding);
        return {
          symbol: CASH_SYMBOL,
          name: cash.name,
          bank: cash.bank,
          port: cash.port,
          category: CASH_CATEGORY,
          isCash: true,
          cashBalance: cash.cashBalance,
          cashBasis: cash.cashBalance,
          purchaseAmount: cash.cashBalance,
        };
      }

      const { symbol, name, bank, port, category, navCurrency, fxRate, buyFxRate, purchaseAmount, frontFeeRate, navLagDays, units, buyingNav, currentNav, baseNav, dailyChangePct, navHistory, archived, archivedAt, archivedDate, archivedSaleAmount, archivedUnits, archivedPnl, archivedPnlPct } = holding;
      return {
        symbol,
        name,
        bank,
        port,
        category,
        navCurrency: navCurrency || "THB",
        ...(navCurrency && navCurrency !== "THB" ? { fxRate: fxRate || 1, buyFxRate: buyFxRate || fxRate || 1 } : {}),
        purchaseAmount,
        frontFeeRate,
        navLagDays: normalizedNavLagDays({ navLagDays }),
        units,
        buyingNav,
        currentNav: baseNav ?? currentNav,
        navHistory: normalizeNavHistory({ navHistory, dailyChangePct }),
        dailyChangePct: dailyChangePct || 0,
        archived: Boolean(archived),
        archivedAt,
        archivedDate,
        archivedSaleAmount,
        archivedUnits,
        archivedPnl,
        archivedPnlPct,
      };
    }),
    activities,
    portfolioSnapshots: normalizePortfolioSnapshots(portfolioSnapshots),
  };
}

function exportJson() {
  const payload = buildExportPayload();
  const exportText = JSON.stringify(payload, null, 2);
  const blob = new Blob([exportText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "mutual-fund-portfolio.json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Exported mutual-fund-portfolio.json.");
}

function openEditFundDialog(symbol) {
  const rawFund = holdings.find((item) => item.symbol === symbol);
  if (!rawFund) return;

  if (isCashHolding(rawFund)) {
    const cash = normalizeCashHolding(rawFund);
    const dialog = document.querySelector("#actionDialog");
    const fields = document.querySelector("#dialogFields");
    state.action = "Edit Cash";
    state.editingSymbol = CASH_SYMBOL;

    document.querySelector("#dialogTitle").textContent = "Edit Cash";
    document.querySelector("#dialogCopy").textContent = "Update the visible cash balance and label. Use cash transactions for normal deposits, withdrawals, dividends, and reinvestment.";
    document.querySelector("#confirmAction").textContent = "Save Changes";
    document.querySelector("#deleteFund").hidden = true;
    fields.className = "dialog-fields two-column";
    fields.innerHTML = cashFieldMarkup(cash);

    if (dialog.showModal) dialog.showModal();
    else showToast("Editing Cash");
    return;
  }

  const fund = deriveFund(rawFund);
  const dialog = document.querySelector("#actionDialog");
  const fields = document.querySelector("#dialogFields");
  state.action = "Edit Asset";
  state.editingSymbol = symbol;

  document.querySelector("#dialogTitle").textContent = `Edit ${symbol}`;
  document.querySelector("#dialogCopy").textContent = "Update this fund's details. Units, current value, daily change, and P&L recalculate after saving.";
  document.querySelector("#confirmAction").textContent = "Save Changes";
  document.querySelector("#deleteFund").hidden = false;
  fields.className = "dialog-fields two-column";
  fields.innerHTML = fundFieldMarkup(fund);
  bindAssetFormHelpers();

  if (dialog.showModal) {
    dialog.showModal();
  } else {
    showToast(`Editing ${symbol}`);
  }
}

function openEditActivityDialog(id) {
  const activity = activities.find((item) => item.id === id);
  if (!activity) return;

  const dialog = document.querySelector("#actionDialog");
  const fields = document.querySelector("#dialogFields");
  state.action = "Edit Transaction";
  state.editingActivityId = id;
  state.editingSymbol = "";

  document.querySelector("#dialogTitle").textContent = `Edit ${activity.asset} order`;
  document.querySelector("#dialogCopy").textContent = activity.type === "Dividend"
    ? "Correct the dividend cash and tax record. New dividend cash is deposited to Cash without changing fund units."
    : activity.type === "Deposit" || activity.type === "Withdraw"
      ? "Correct this cash movement. The Cash row updates after saving."
    : "Correct the activity record. Buy and sell changes will also recalculate the fund holding.";
  document.querySelector("#confirmAction").textContent = "Save Changes";
  const deleteButton = document.querySelector("#deleteFund");
  deleteButton.hidden = false;
  deleteButton.textContent = "Delete Activity";
  fields.className = "dialog-fields two-column";
  const editValues = activity.type === "Switch" && activity.switch
    ? {
        date: dateKeyFromActivityDate(activity.date),
        asset: activity.switch.fromSymbol,
        destAsset: activity.switch.toSymbol,
        amount: activity.switch.amount,
        switchOutNav: activity.switch.switchOutNav,
        buyingNav: activity.switch.destBuyingNav,
      }
    : activity.type === "Dividend"
      ? {
          date: dateKeyFromActivityDate(activity.date),
          asset: activity.asset,
          amount: dividendNetAmount(activity),
          taxAmount: dividendTaxAmount(activity),
          grossAmount: dividendGrossAmount(activity),
        }
    : {
        date: dateKeyFromActivityDate(activity.date),
        asset: activity.asset,
        units: activityUnitCount(activity) || "",
        amount: activity.amount,
        fromCash: Boolean(activity.fromCash),
        sellAll: activity.type === "Sell" && holdings.find((item) => item.symbol === activity.asset)?.units === 0,
      };
  fields.innerHTML = transactionFieldMarkup(activity.type, editValues);
  bindOrderFormHelpers();

  if (dialog.showModal) {
    dialog.showModal();
  } else {
    showToast(`Editing ${activity.asset} activity.`);
  }
}

function transactionTypeOptions() {
  return state.action === "Edit Transaction"
    ? ["Buy", "Sell", "Switch", "Dividend", "Deposit", "Withdraw", "Transfer", "Import"]
    : ["Buy", "Sell", "Switch", "Dividend", "Deposit", "Withdraw", "Transfer"];
}

function transactionFundOptions(extra = []) {
  const base = state.action === "Edit Transaction"
    ? holdings.filter((item) => !isCashHolding(item)).map((item) => item.symbol)
    : activeFundHoldings().map((item) => item.symbol);
  return [...new Set([...base, ...extra].filter(Boolean))];
}

// Build the order-dialog fields for a given order type. Switch swaps in its own
// source/destination layout; every other type keeps the classic fund/units/amount form.
function transactionFieldMarkup(type, values = {}) {
  const dateField = { id: "transactionDate", label: "Date", type: "date", value: values.date ?? activeDateKey() };
  const typeField = { id: "transactionType", label: "Order type", kind: "select", options: transactionTypeOptions(), value: type };

  if (type === "Switch") {
    const fundOptions = transactionFundOptions([values.asset, values.destAsset]);
    return fieldMarkup([
      dateField,
      typeField,
      { id: "transactionAsset", label: "Switch from (source)", kind: "select", options: fundOptions, value: values.asset },
      { id: "transactionDestAsset", label: "Switch to (destination)", kind: "select", options: fundOptions, value: values.destAsset },
      { id: "transactionAmount", label: "Invested amount", type: "number", step: "0.01", value: values.amount ?? "1500", min: "0" },
      { id: "transactionSwitchOutNav", label: "Switch-out NAV (source)", type: "number", step: "0.0001", value: values.switchOutNav ?? "", min: "0" },
      { id: "transactionBuyingNav", label: "Buying NAV (destination)", type: "number", step: "0.0001", value: values.buyingNav ?? "", min: "0" },
    ]) + `<div class="order-preview" id="switchPreview" aria-live="polite"></div>`;
  }

  if (type === "Dividend") {
    return fieldMarkup([
      dateField,
      typeField,
      { id: "transactionAsset", label: "Fund", kind: "select", options: transactionFundOptions([values.asset]), value: values.asset },
      { id: "transactionAmount", label: "Net cash received", type: "number", step: "0.01", value: values.amount ?? "", min: "0" },
      { id: "transactionTaxAmount", label: "Withholding tax", type: "number", step: "0.01", value: values.taxAmount ?? "0", min: "0" },
      { id: "transactionGrossAmount", label: "Gross dividend", type: "number", step: "0.01", value: values.grossAmount ?? "", min: "0" },
    ]) + `<div class="order-preview" id="dividendPreview" aria-live="polite"></div>`;
  }

  if (type === "Deposit" || type === "Withdraw") {
    const afterAmount = type === "Deposit"
      ? cashBalance() + Number(values.amount || 0)
      : cashBalance() - Number(values.amount || 0);
    return fieldMarkup([
      dateField,
      typeField,
      { id: "transactionAmount", label: type === "Deposit" ? "Cash deposited" : "Cash withdrawn", type: "number", step: "0.01", value: values.amount ?? "", min: "0" },
    ]) + `<div class="order-preview" id="cashPreview" aria-live="polite">
      <div class="order-preview-row"><span>Cash balance after ${type.toLowerCase()}</span><b>${money(Math.max(afterAmount, 0))}</b></div>
    </div>`;
  }

  const fields = [
    dateField,
    typeField,
    { id: "transactionAsset", label: "Fund", kind: "select", options: transactionFundOptions([values.asset]), value: values.asset },
    { id: "transactionUnits", label: "Units", value: values.units ?? "" },
    { id: "transactionAmount", label: "Amount", type: "number", step: "0.01", value: values.amount ?? "1500", min: "0" },
  ];

  if (type === "Buy") {
    fields.push({ id: "transactionUseCash", label: `Use Cash balance for this buy (${money(cashBalance())} available)`, kind: "checkbox", checked: Boolean(values.fromCash) });
  }

  fields.push({ id: "transactionSellAll", label: "Sell all units in this fund", kind: "checkbox", checked: Boolean(values.sellAll) });
  return fieldMarkup(fields);
}

function readTransactionFormValues() {
  const field = (id) => document.querySelector(`#${id}`);
  return {
    date: field("transactionDate")?.value,
    asset: field("transactionAsset")?.value,
    destAsset: field("transactionDestAsset")?.value,
    units: field("transactionUnits")?.value,
    amount: field("transactionAmount")?.value,
    taxAmount: field("transactionTaxAmount")?.value,
    grossAmount: field("transactionGrossAmount")?.value,
    switchOutNav: field("transactionSwitchOutNav")?.value,
    buyingNav: field("transactionBuyingNav")?.value,
    sellAll: field("transactionSellAll")?.checked,
    fromCash: field("transactionUseCash")?.checked,
  };
}

function renderTransactionFields(type, values = {}) {
  const fields = document.querySelector("#dialogFields");
  if (!fields) return;
  fields.innerHTML = transactionFieldMarkup(type, values);
  bindOrderFormHelpers();
}

function navForSymbol(symbol) {
  const raw = holdings.find((item) => item.symbol === symbol);
  if (!raw) return 0;
  return Number(deriveFund(raw).currentNav || raw.buyingNav || 0);
}

function bindOrderFormHelpers() {
  const typeInput = document.querySelector("#transactionType");
  if (!typeInput) return;

  typeInput.addEventListener("change", () => {
    renderTransactionFields(typeInput.value, readTransactionFormValues());
  });

  if (typeInput.value === "Switch") {
    bindSwitchHelpers();
  } else if (typeInput.value === "Dividend") {
    bindDividendHelpers();
  } else if (typeInput.value === "Deposit" || typeInput.value === "Withdraw") {
    bindCashMovementHelpers();
  } else {
    bindBuySellHelpers();
  }
}

function bindCashMovementHelpers() {
  const typeInput = document.querySelector("#transactionType");
  const amountInput = document.querySelector("#transactionAmount");
  const preview = document.querySelector("#cashPreview");
  if (!typeInput || !amountInput || !preview) return;

  const renderPreview = () => {
    const amount = Number(amountInput.value || 0);
    const nextBalance = typeInput.value === "Withdraw" ? cashBalance() - amount : cashBalance() + amount;
    preview.innerHTML = amount > 0
      ? `<div class="order-preview-row"><span>Cash balance after ${typeInput.value.toLowerCase()}</span><b>${money(Math.max(nextBalance, 0))}</b></div>`
      : `<span class="order-preview-hint">Enter the cash amount to ${typeInput.value.toLowerCase()}.</span>`;
  };

  amountInput.addEventListener("input", renderPreview);
  renderPreview();
}

function bindDividendHelpers() {
  const netInput = document.querySelector("#transactionAmount");
  const taxInput = document.querySelector("#transactionTaxAmount");
  const grossInput = document.querySelector("#transactionGrossAmount");
  const preview = document.querySelector("#dividendPreview");
  if (!netInput || !taxInput || !grossInput || !preview) return;
  grossInput.dataset.autoGross = "true";

  const renderPreview = (source) => {
    const net = Number(netInput.value || 0);
    const tax = Number(taxInput.value || 0);
    if (source === grossInput) grossInput.dataset.autoGross = "false";
    const gross = grossInput.dataset.autoGross === "false"
      ? Number(grossInput.value || 0) || net + tax
      : net + tax;
    if (grossInput.dataset.autoGross !== "false") grossInput.value = gross > 0 ? gross.toFixed(2) : "";
    preview.innerHTML = net > 0
      ? `
        <div class="order-preview-row"><span>Net cash received</span><b>${money(net)}</b></div>
        <div class="order-preview-row"><span>Withholding tax</span><b>${money(tax)}</b></div>
        <div class="order-preview-row"><span>Gross dividend</span><b>${money(gross)}</b></div>
      `
      : `<span class="order-preview-hint">Enter the net dividend cash you received. Tax and gross are saved for reference.</span>`;
  };

  netInput.addEventListener("input", () => renderPreview(netInput));
  taxInput.addEventListener("input", () => renderPreview(taxInput));
  grossInput.addEventListener("input", () => renderPreview(grossInput));
  renderPreview();
}

function bindBuySellHelpers() {
  const typeInput = document.querySelector("#transactionType");
  const assetInput = document.querySelector("#transactionAsset");
  const unitsInput = document.querySelector("#transactionUnits");
  const sellAllInput = document.querySelector("#transactionSellAll");
  const useCashInput = document.querySelector("#transactionUseCash");
  if (!typeInput || !assetInput || !unitsInput) return;

  const syncSellAll = () => {
    const isSellAll = typeInput.value === "Sell" && Boolean(sellAllInput?.checked);
    const holding = holdings.find((item) => item.symbol === assetInput.value);
    sellAllInput?.closest("label")?.classList.toggle("is-disabled", typeInput.value !== "Sell");
    useCashInput?.closest("label")?.classList.toggle("is-disabled", typeInput.value !== "Buy");
    unitsInput.readOnly = isSellAll;
    if (typeInput.value !== "Sell") {
      if (sellAllInput) sellAllInput.checked = false;
      unitsInput.readOnly = false;
      return;
    }
    if (isSellAll && holding) {
      unitsInput.value = Number(holding.units || 0).toFixed(4);
    }
  };

  assetInput.addEventListener("change", syncSellAll);
  sellAllInput?.addEventListener("change", syncSellAll);
  syncSellAll();
}

function bindSwitchHelpers() {
  const sourceInput = document.querySelector("#transactionAsset");
  const destInput = document.querySelector("#transactionDestAsset");
  const amountInput = document.querySelector("#transactionAmount");
  const switchOutNavInput = document.querySelector("#transactionSwitchOutNav");
  const buyingNavInput = document.querySelector("#transactionBuyingNav");
  const preview = document.querySelector("#switchPreview");
  if (!sourceInput || !destInput) return;

  const prefillSourceNav = () => {
    if (switchOutNavInput && !switchOutNavInput.value) {
      const nav = navForSymbol(sourceInput.value);
      if (nav > 0) switchOutNavInput.value = nav.toFixed(4);
    }
  };
  const prefillDestNav = () => {
    if (buyingNavInput && !buyingNavInput.value) {
      const nav = navForSymbol(destInput.value);
      if (nav > 0) buyingNavInput.value = nav.toFixed(4);
    }
  };

  const renderPreview = () => {
    if (!preview) return;
    const source = holdings.find((item) => item.symbol === sourceInput.value);
    const dest = holdings.find((item) => item.symbol === destInput.value);
    const invested = Number(amountInput?.value || 0);
    const switchOutNav = Number(switchOutNavInput?.value || 0);
    const buyingNav = Number(buyingNavInput?.value || 0);

    if (source && dest && sourceInput.value === destInput.value) {
      preview.innerHTML = `<span class="order-preview-hint">Pick two different funds to switch between.</span>`;
      return;
    }
    if (!source || !dest || invested <= 0 || switchOutNav <= 0 || buyingNav <= 0) {
      preview.innerHTML = `<span class="order-preview-hint">Enter an invested amount, switch-out NAV, and destination buying NAV to preview units.</span>`;
      return;
    }

    const data = buildSwitchData(source, dest, invested, switchOutNav, buyingNav);
    const heldUnits = Number(source.units || 0);
    const enough = data.sourceUnits <= heldUnits + 0.0001;
    preview.innerHTML = `
      <div class="order-preview-row"><span>Switch out · ${source.symbol}</span><b>-${data.sourceUnits.toFixed(4)} units</b></div>
      <div class="order-preview-row"><span>Marked-up NAV · ${dest.symbol} (fee ${data.destFeeRate.toFixed(2)}%)</span><b>${data.destOfferNav.toFixed(4)}</b></div>
      <div class="order-preview-row"><span>Switch in · ${dest.symbol}</span><b>+${data.destUnits.toFixed(4)} units</b></div>
      ${enough ? "" : `<div class="order-preview-row order-preview-warn"><span>${source.symbol} holds only ${heldUnits.toFixed(4)} units</span><b>Not enough</b></div>`}
    `;
  };

  [amountInput, switchOutNavInput, buyingNavInput].forEach((el) => {
    el?.addEventListener("input", renderPreview);
  });
  sourceInput.addEventListener("change", () => {
    if (switchOutNavInput) switchOutNavInput.value = "";
    prefillSourceNav();
    renderPreview();
  });
  destInput.addEventListener("change", () => {
    if (buyingNavInput) buyingNavInput.value = "";
    prefillDestNav();
    renderPreview();
  });

  prefillSourceNav();
  prefillDestNav();
  renderPreview();
}

function openActionDialog(action) {
  if (action === "Update Prices") {
    refreshPrices();
    return;
  }

  if (action === "View Analytics" || action === "View all activity") {
    focusAnalytics();
    return;
  }

  if (action === "Export JSON") {
    exportJson();
    return;
  }

  const dialog = document.querySelector("#actionDialog");
  const fields = document.querySelector("#dialogFields");
  state.action = action;
  state.editingSymbol = "";
  document.querySelector("#confirmAction").textContent = "Confirm";
  const deleteButton = document.querySelector("#deleteFund");
  deleteButton.hidden = true;
  deleteButton.textContent = "Delete Fund";
  document.querySelector("#dialogTitle").textContent = {
    "Add Asset": "Add Fund",
    "Add Transaction": "Add Order",
    "Import Data": "Import JSON",
  }[action] || action;
  document.querySelector("#dialogCopy").textContent = {
    "Add Asset": "Add a mutual fund, or choose Cash as the category to record available cash without fund-only fields.",
    "Add Transaction": "Record a buy, sell, switch, dividend, deposit, withdrawal, or transfer. New dividends and sell proceeds move into Cash.",
    "Import Data": "Paste mutual-fund JSON to merge it into the portfolio.",
  }[action] || "This workflow is ready.";
  fields.className = "dialog-fields";

  if (action === "Add Asset") {
    fields.classList.add("two-column");
    fields.innerHTML = fundFieldMarkup();
    bindAssetFormHelpers();
  } else if (action === "Add Transaction") {
    fields.classList.add("two-column");
    fields.innerHTML = transactionFieldMarkup(activeFundHoldings().length > 0 ? "Buy" : "Deposit");
    bindOrderFormHelpers();
  } else if (action === "Import Data") {
    fields.innerHTML = fieldMarkup([
      {
        id: "jsonFileInput",
        label: "Upload JSON file",
        kind: "file",
        accept: ".json,application/json",
        help: "Select a local export or portfolio JSON file.",
      },
      {
        id: "jsonImport",
        label: "Paste or preview JSON",
        kind: "textarea",
        value: JSON.stringify({
          holdings: [],
          activities: [],
        }, null, 2),
      },
    ]);
    bindJsonFileInput();
  }

  if (dialog.showModal) {
    dialog.showModal();
  } else {
    showToast(action);
  }
}

function handleConfirm(event) {
  event.preventDefault();
  const dialog = document.querySelector("#actionDialog");
  const getValue = (id) => document.querySelector(`#${id}`)?.value.trim() || "";
  const isChecked = (id) => Boolean(document.querySelector(`#${id}`)?.checked);

  if (state.action === "Edit Cash" || (state.action === "Add Asset" && getValue("assetCategory") === CASH_CATEGORY)) {
    const values = readCashFormValues();
    if (values.cashBalance < 0) {
      showToast("Cash balance cannot be negative.");
      return;
    }

    const cash = cashHolding({ create: values.cashBalance > 0 });
    if (!cash) {
      showToast("Cash balance is zero, so there is nothing to save.");
      dialog.close();
      return;
    }

    Object.assign(cash, normalizeCashHolding(values));
    savePortfolio();
    renderAll();
    showToast(state.action === "Add Asset" ? "Cash added to investments." : "Cash updated.");
  } else if (state.action === "Add Asset" || state.action === "Edit Asset") {
    const symbol = getValue("assetSymbol").toUpperCase();
    const name = getValue("assetName");
    const bank = getValue("assetBank") || "Unassigned Bank";
    const port = getValue("assetPort") || `${bank} Main Port`;
    const category = getValue("assetCategory") || "Mixed Allocation";
    const navCurrency = getValue("assetNavCurrency") || "THB";
    const isForeign = navCurrency !== "THB";
    const buyFxRate = isForeign ? Number(getValue("assetBuyFxRate") || 0) : 1;
    const currentFxRate = isForeign ? Number(getValue("assetCurrentFxRate") || 0) : 1;
    // assetPurchase is always the THB the user actually put in; convert to the fund's
    // native currency for unit/NAV math.
    const investedTHB = Number(getValue("assetPurchase") || 0);
    const frontFeeRate = Number(getValue("assetFeeRate") || 0);
    const enteredUnits = Number(getValue("assetUnits") || 0);
    const buyingNav = Number(getValue("assetBuyingNav") || 0);
    const navLagDays = Math.max(0, Math.round(Number(getValue("assetNavLagDays") || 0)));
    const currentNav = Number(getValue("assetCurrentNav") || 0);
    const enteredDailyChangePct = Number(getValue("assetDailyChange") || 0);
    const purchaseAmount = isForeign && buyFxRate > 0 ? investedTHB / buyFxRate : investedTHB;
    const offerNav = buyingNav * (1 + frontFeeRate / 100);
    const units = enteredUnits > 0 ? enteredUnits : offerNav > 0 ? purchaseAmount / offerNav : 0;
    const currencyFields = isForeign ? { navCurrency, fxRate: currentFxRate, buyFxRate } : { navCurrency: "THB" };

    if (!symbol || !name || investedTHB <= 0 || buyingNav <= 0 || currentNav <= 0) {
      showToast("Fund needs code, name, invested amount, buying NAV, and current NAV.");
      return;
    }

    if (symbol === CASH_SYMBOL) {
      showToast("CASH is reserved for the cash balance.");
      return;
    }

    if (isForeign && (buyFxRate <= 0 || currentFxRate <= 0)) {
      showToast(`${navCurrency} fund needs a buy and current FX rate (THB per ${navCurrency}).`);
      return;
    }

    if (state.action === "Edit Asset") {
      const existingIndex = holdings.findIndex((item) => item.symbol === state.editingSymbol);
      const duplicate = holdings.some((item, index) => item.symbol === symbol && index !== existingIndex);

      if (existingIndex < 0) {
        showToast("This fund is no longer in the table.");
        return;
      }

      if (duplicate) {
        showToast(`${symbol} already exists. Use a different fund code.`);
        return;
      }

      const previous = holdings[existingIndex];
      const previousInvestedTHB = Number(previous.purchaseAmount || 0) * fundBuyFx(previous);
      const navDate = navEffectiveDate({ navLagDays });
      const previousNav = navBeforeDate({ ...previous, navLagDays }, navDate);
      const dailyChangePct = previousNav > 0 ? ((currentNav / previousNav) - 1) * 100 : enteredDailyChangePct;
      const navHistory = upsertNavHistory(previous, navDate, dailyChangePct, currentNav);
      holdings[existingIndex] = { symbol, name, bank, port, category, ...currencyFields, purchaseAmount, frontFeeRate, navLagDays, units, buyingNav, currentNav: previousNav > 0 ? previousNav : currentNav, baseNav: previous.baseNav ?? previous.currentNav ?? currentNav, dailyChangePct, navHistory };
      activities.forEach((item) => {
        if (item.asset !== state.editingSymbol) return;
        item.asset = symbol;
        if (item.type === "Buy" && Math.abs(Number(item.amount) - previousInvestedTHB) < 0.005) {
          item.amount = investedTHB;
          item.units = `+${units.toFixed(4)}`;
        }
      });
      savePortfolio();
      renderAll();
      showToast(`${symbol} updated.`);
    } else {
      const existing = holdings.find((item) => item.symbol === symbol);
      if (existing) {
        const navDate = navEffectiveDate({ navLagDays });
        const previousNav = navBeforeDate({ ...existing, navLagDays }, navDate);
        const dailyChangePct = previousNav > 0 ? ((currentNav / previousNav) - 1) * 100 : enteredDailyChangePct;
        Object.assign(existing, { name, bank, port, category, ...currencyFields, purchaseAmount, frontFeeRate, navLagDays, units, buyingNav, currentNav: previousNav > 0 ? previousNav : currentNav, dailyChangePct, navHistory: upsertNavHistory(existing, navDate, dailyChangePct, currentNav) });
        savePortfolio();
        renderAll();
        showToast(`${symbol} updated.`);
      } else {
        const dailyChangePct = enteredDailyChangePct;
        const baseCurrentNav = dailyChangePct !== 0 ? currentNav / (1 + dailyChangePct / 100) : currentNav;
        const navDate = navEffectiveDate({ navLagDays });
        const navHistory = upsertNavHistory({}, navDate, dailyChangePct, currentNav);
        holdings.push({ symbol, name, bank, port, category, ...currencyFields, purchaseAmount, frontFeeRate, navLagDays, units, buyingNav, currentNav: baseCurrentNav, baseNav: baseCurrentNav, dailyChangePct, navHistory });
        activities.unshift({ id: makeId("activity"), date: readableDate(activeDateKey()), createdAt: new Date().toISOString(), type: "Buy", asset: symbol, units: `+${units.toFixed(4)}`, amount: investedTHB });
        savePortfolio();
        renderAll();
        window.requestAnimationFrame(() => {
          const newRow = document.querySelector(`tr[data-symbol="${symbol}"]`);
          if (newRow) {
            newRow.classList.add("row-new");
            window.setTimeout(() => newRow.classList.remove("row-new"), 1200);
          }
        });
        showToast(`${symbol} added to funds.`);
      }
    }
  } else if (state.action === "Add Transaction" || state.action === "Edit Transaction") {
    const type = getValue("transactionType");
    const amount = Number(getValue("transactionAmount") || 0);
    const taxAmount = Number(getValue("transactionTaxAmount") || 0);
    const enteredGrossAmount = Number(getValue("transactionGrossAmount") || 0);
    const grossAmount = enteredGrossAmount > 0 ? enteredGrossAmount : amount + taxAmount;
    const requestedActivityDate = getValue("transactionDate") || activeDateKey();
    const activityDate = previousWeekdayKey(requestedActivityDate);

    // Resolve the new order into either a switch descriptor or a fund/units/amount order.
    let newSwitchData = null;
    let asset = getValue("transactionAsset");
    let unitCount = parseUnits(getValue("transactionUnits"));
    let holding = holdings.find((item) => item.symbol === asset);
    const sellAll = type === "Sell" && isChecked("transactionSellAll");
    const fromCash = type === "Buy" && isChecked("transactionUseCash");
    let cashBasisAmount = 0;

    if (type === "Switch") {
      const fromSymbol = getValue("transactionAsset");
      const toSymbol = getValue("transactionDestAsset");
      const switchOutNav = Number(getValue("transactionSwitchOutNav") || 0);
      const destBuyingNav = Number(getValue("transactionBuyingNav") || 0);
      const source = holdings.find((item) => item.symbol === fromSymbol);
      const dest = holdings.find((item) => item.symbol === toSymbol);

      if (!source || !dest) {
        showToast("Switch needs a source and a destination fund.");
        return;
      }
      if (fromSymbol === toSymbol) {
        showToast("Pick two different funds to switch between.");
        return;
      }
      if (amount <= 0 || switchOutNav <= 0 || destBuyingNav <= 0) {
        showToast("Switch needs an invested amount, switch-out NAV, and destination buying NAV.");
        return;
      }

      newSwitchData = buildSwitchData(source, dest, amount, switchOutNav, destBuyingNav);
      asset = fromSymbol;
    } else if (type === "Dividend") {
      if (!asset || !holding || amount <= 0) {
        showToast("Dividend needs a fund and net cash received.");
        return;
      }
      if (taxAmount < 0 || grossAmount < amount) {
        showToast("Dividend gross amount should be at least the net cash received.");
        return;
      }
    } else if (type === "Deposit" || type === "Withdraw") {
      asset = CASH_SYMBOL;
      holding = cashHolding({ create: type === "Deposit" });
      if (amount <= 0) {
        showToast(`${type} needs a cash amount.`);
        return;
      }
      if (type === "Withdraw" && amount > cashBalance() + 0.005) {
        showToast("Cash balance is not high enough for that withdrawal.");
        return;
      }
      cashBasisAmount = type === "Withdraw" ? cashBasisForWithdrawal(amount) : amount;
    } else {
      if (!asset || !holding || amount <= 0) {
        showToast("Order needs a fund and amount.");
        return;
      }

      if (sellAll && state.action !== "Edit Transaction") {
        unitCount = Number(holding.units || 0);
      }

      if ((type === "Buy" || type === "Sell") && unitCount <= 0) {
        showToast(`${type} order needs units so the holding can update.`);
        return;
      }

      if (type === "Buy" && fromCash) {
        if (amount > cashBalance() + 0.005) {
          showToast("Cash balance is not high enough for this buy.");
          return;
        }
        cashBasisAmount = cashBasisForWithdrawal(amount);
      }

      if (type === "Sell") {
        cashBasisAmount = sellCostBasis(holding, unitCount);
      }
    }

    const activityUnitsLabel = () => type === "Switch"
      ? `-${newSwitchData.sourceUnits.toFixed(4)}`
      : unitCount > 0 ? signedUnits(type, unitCount) : "";

    const dividendFields = () => type === "Dividend"
      ? { grossAmount, taxAmount, netAmount: amount }
      : {};

    const cashFields = () => {
      if (type === "Dividend") return { depositedToCash: true, cashAmount: amount, cashBasisAmount: 0 };
      if (type === "Sell") return { depositedToCash: true, cashAmount: amount, cashBasisAmount };
      if (type === "Buy" && fromCash) return { fromCash: true, cashAmount: amount, cashBasisAmount };
      if (type === "Deposit" || type === "Withdraw") return { cashAmount: amount, cashBasisAmount };
      return {};
    };

    const buildActivity = (existing = {}) => {
      const next = {
        ...existing,
        date: readableDate(activityDate),
        createdAt: existing.createdAt || new Date().toISOString(),
        type,
        asset,
        units: activityUnitsLabel(),
        amount,
        ...dividendFields(),
        ...cashFields(),
      };
      if (type === "Switch") next.switch = newSwitchData;
      else delete next.switch;
      if (type !== "Dividend") {
        delete next.grossAmount;
        delete next.taxAmount;
        delete next.netAmount;
      }
      if (!(type === "Dividend" || type === "Sell")) delete next.depositedToCash;
      if (!(type === "Buy" && fromCash)) delete next.fromCash;
      if (!(type === "Dividend" || type === "Sell" || type === "Deposit" || type === "Withdraw" || (type === "Buy" && fromCash))) {
        delete next.cashAmount;
        delete next.cashBasisAmount;
      }
      return next;
    };

    if (state.action === "Edit Transaction") {
      const activity = activities.find((item) => item.id === state.editingActivityId);
      if (!activity) {
        showToast("This activity is no longer available.");
        return;
      }

      if (!reverseActivityEffect(activity)) {
        showToast("Could not reverse the old order from the holding.");
        return;
      }

      if (sellAll) {
        const updatedHolding = holdings.find((item) => item.symbol === asset);
        unitCount = Number(updatedHolding?.units || 0);
        if (type === "Sell") cashBasisAmount = sellCostBasis(updatedHolding, unitCount);
      }

      const nextActivity = buildActivity(activity);
      if (!applyActivityEffect(nextActivity)) {
        applyActivityEffect(activity);
        showToast(type === "Switch"
          ? "Source fund no longer has enough units for this switch."
          : "Could not apply the corrected order to the holding.");
        return;
      }

      Object.assign(activity, nextActivity);
      state.editingActivityId = "";
      savePortfolio();
      renderAll();
      const updatedMessage = type === "Dividend"
        ? `${asset} dividend updated and deposited to Cash.`
        : type === "Deposit" || type === "Withdraw"
          ? `Cash ${type.toLowerCase()} updated.`
        : `${asset} activity updated. Holding recalculated.`;
      showToast(isWeekendDate(requestedActivityDate)
        ? `${asset} activity updated on ${readableDate(activityDate)} because weekend dates are blocked.`
        : updatedMessage);
    } else {
      const newActivity = buildActivity({ id: makeId("activity") });
      if (!applyActivityEffect(newActivity)) {
        showToast(type === "Switch"
          ? "Source fund doesn't have enough units to switch that amount."
          : type === "Buy" && fromCash
            ? "Cash balance is not high enough for this buy."
          : "Order is larger than the current holding.");
        return;
      }

      activities.unshift(newActivity);
      savePortfolio();
      renderAll();
      if (type === "Switch") {
        showToast(isWeekendDate(requestedActivityDate)
          ? `Switched ${newSwitchData.fromSymbol} → ${newSwitchData.toSymbol} on ${readableDate(activityDate)} because weekend dates are blocked.`
          : `Switched ${newSwitchData.fromSymbol} → ${newSwitchData.toSymbol}. Both holdings updated.`);
      } else if (type === "Dividend") {
        showToast(isWeekendDate(requestedActivityDate)
          ? `Dividend recorded for ${asset} on ${readableDate(activityDate)} because weekend dates are blocked.`
          : `Dividend recorded for ${asset} and deposited to Cash.`);
      } else if (type === "Deposit" || type === "Withdraw") {
        showToast(isWeekendDate(requestedActivityDate)
          ? `Cash ${type.toLowerCase()} recorded on ${readableDate(activityDate)} because weekend dates are blocked.`
          : `Cash ${type.toLowerCase()} recorded.`);
      } else {
        showToast(isWeekendDate(requestedActivityDate)
          ? `${type} order recorded for ${asset} on ${readableDate(activityDate)} because weekend dates are blocked.`
          : `${type} order recorded for ${asset}. ${type === "Sell" ? "Proceeds moved to Cash." : fromCash ? "Cash balance reduced." : "Holding updated."}`);
      }
    }
  } else if (state.action === "Import Data") {
    if (!importSampleData()) return;
  } else if (state.action === "Cloud Sync") {
    const key = getValue("syncKeyInput");
    try {
      if (key) {
        localStorage.setItem(CLOUD_KEY_STORAGE, key);
        showToast("Cloud sync enabled. Checking for a stored portfolio…");
        pullPortfolioFromCloud();
      } else {
        localStorage.removeItem(CLOUD_KEY_STORAGE);
        showToast("Cloud sync turned off. Data stays in this browser only.");
      }
    } catch {
      showToast("Could not store the sync key in this browser.");
    }
  } else {
    showToast(`${state.action} workflow confirmed.`);
  }

  dialog.close();
}

function deleteEditingActivity() {
  if (state.action !== "Edit Transaction" || !state.editingActivityId) return;

  const existingIndex = activities.findIndex((item) => item.id === state.editingActivityId);
  if (existingIndex < 0) {
    showToast("This activity is no longer available.");
    return;
  }

  const activity = activities[existingIndex];
  if (!reverseActivityEffect(activity)) {
    showToast("Could not remove this order from the holding.");
    return;
  }

  activities.splice(existingIndex, 1);
  document.querySelector("#actionDialog").close();
  state.editingActivityId = "";
  savePortfolio();
  renderAll();
  showToast(`${activity.asset} activity deleted. Holding recalculated.`);
}

function handleDeleteDialogAction() {
  if (state.action === "Edit Transaction") {
    deleteEditingActivity();
    return;
  }

  deleteEditingFund();
}

function deleteEditingFund() {
  if (state.action !== "Edit Asset" || !state.editingSymbol) return;

  const existingIndex = holdings.findIndex((item) => item.symbol === state.editingSymbol);
  if (existingIndex < 0) {
    showToast("This fund is no longer in the table.");
    return;
  }

  const [removed] = holdings.splice(existingIndex, 1);
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index].asset === state.editingSymbol) activities.splice(index, 1);
  }

  document.querySelector("#actionDialog").close();
  state.editingSymbol = "";
  document.querySelector("#deleteFund").textContent = "Delete Fund";
  savePortfolio();
  renderAll();
  showToast(`${removed.symbol} deleted.`);
}

function bindDynamicButtons() {
  document.querySelectorAll(".calendar-day[data-action], .channel-row, .archive-row, .pnl-row").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => showToast(button.dataset.action || button.querySelector("b")?.textContent || ""));
  });

  document.querySelectorAll(".calendar-nav").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      state.calendarMonth = shiftMonth(state.calendarMonth || monthKeyFromDate(), Number(button.dataset.calendarShift || 0));
      renderValueCalendar();
      bindDynamicButtons();
    });
  });
}

function bindInteractions() {
  bindAllocationTooltip();

  let chartResizeTimer;
  window.addEventListener("resize", () => {
    window.clearTimeout(chartResizeTimer);
    chartResizeTimer = window.setTimeout(() => {
      renderChart(document.querySelector(".range-tabs .active")?.dataset.range || "1W");
    }, 150);
  });

  // Webfont swap changes the insight cards' height, which changes the chart
  // area — re-fit once fonts are ready.
  document.fonts?.ready?.then(() => {
    renderChart(document.querySelector(".range-tabs .active")?.dataset.range || "1W");
  });

  document.querySelectorAll(".range-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".range-tabs button").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      renderChart(button.dataset.range);
      showToast(`Performance range changed to ${button.dataset.range}.`);
    });
  });

  document.querySelectorAll(".action-tile[data-action]").forEach((button) => {
    button.addEventListener("click", () => openActionDialog(button.dataset.action));
  });

  document.querySelector("#refreshButton").addEventListener("click", () => openActionDialog("Update Prices"));

  document.querySelector("#cloudSyncButton")?.addEventListener("click", openCloudSyncDialog);

  const logDateInput = document.querySelector("#logDateInput");
  if (logDateInput) {
    logDateInput.addEventListener("change", () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(logDateInput.value)) {
        syncLogDateInput();
        return;
      }

      const requestedDate = logDateInput.value;
      state.logDate = previousWeekdayKey(requestedDate);
      state.calendarMonth = monthKeyFromDate(state.logDate);
      savePortfolio({ captureSnapshot: false });
      renderAll();
      showToast(isWeekendDate(requestedDate)
        ? `Weekend logs are blocked. Log date moved to ${readableDate(state.logDate)}.`
        : `Log date set to ${readableDate(state.logDate)}.`);
    });
  }

  document.querySelector("#currencyButton").addEventListener("click", () => {
    state.currency = state.currency === "THB" ? "USD" : "THB";
    document.querySelector("#currencyLabel").textContent = state.currency;
    savePortfolio({ captureSnapshot: false });
    renderAll();
    const flipTargets = document.querySelectorAll(".primary-value strong, .primary-value .metric-up, #pnlPercent, #dayChange, #dayChangePct, .donut-center strong");
    flipTargets.forEach((el) => el.classList.remove("value-flip"));
    void document.querySelector(".primary-value strong")?.offsetWidth;
    flipTargets.forEach((el) => el.classList.add("value-flip"));
    showToast(`Currency switched to ${state.currency}.`);
  });

  document.querySelector("#confirmAction").addEventListener("click", handleConfirm);
  document.querySelector("#deleteFund").addEventListener("click", handleDeleteDialogAction);
  document.querySelector("#dialogClose").addEventListener("click", () => document.querySelector("#actionDialog").close());
  document.querySelector("#dialogCancel").addEventListener("click", () => document.querySelector("#actionDialog").close());

  document.querySelectorAll("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.col = col;
        sortState.dir = "asc";
      }
      renderHoldings();
    });
  });

  const privacyBtn = document.querySelector("#privacyToggle");
  if (privacyBtn) {
    privacyBtn.addEventListener("click", () => {
      state.privacyMode = !state.privacyMode;
      savePortfolio({ captureSnapshot: false });
      applyPrivacyMode();
      renderAll();
      showToast(state.privacyMode ? "Investment figures hidden. Percentages stay visible." : "Investment figures visible.");
    });
  }
}

function initDates() {
  const today = todayLabel();
  const lastUpdatedEl = document.querySelector(".last-updated");
  const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const fullLabel = `Last updated: ${today} ${now}`;
  lastUpdatedEl.textContent = fullLabel;
  document.querySelector("#refreshButton").title = fullLabel;
}

initDates();
loadPortfolio();
document.querySelector("#currencyLabel").textContent = state.currency;
applyPrivacyMode();
savePortfolio({ captureSnapshot: false });
bindInteractions();
window.addEventListener("beforeunload", () => savePortfolio({ captureSnapshot: false }));
renderAll();
pullPortfolioFromCloud({ silent: true });
