# My Funds — Mutual Fund Portfolio

A static web app for tracking Thai mutual fund holdings and available cash: NAV updates, multi-currency funds (THB/USD), dividend/sell proceeds deposited to Cash, P&L calendar heatmap, category allocation, and performance charts.

All portfolio data lives in the browser's `localStorage` — nothing is stored on a server. Use **Export JSON** / **Import JSON** in the app to back up or move data between browsers.

## Run locally

```sh
python3 -m http.server 8743
# open http://localhost:8743
```

## Deploy

Plain static site (no build step): `index.html`, `styles.css`, `app.js`. Deployable as-is on Vercel, Netlify, or GitHub Pages.

## Dashboard views

- **Value / P&L / Daily P&L** switches the main chart. P&L is the unrealized balance of holdings at each date; it excludes realized gains and dividends. Daily P&L uses recorded daily NAV movement and leaves missing observations blank.
- Chart and holdings view preferences are remembered in this browser. Focus the chart's latest point and use arrow keys to explore dates; Escape closes the tooltip.
- **Overview / Detailed** controls holdings density. On mobile, **Show details** expands one holding. Select a fund name or P&L contribution to inspect its NAV and transaction history.
- Select a bank summary to filter holdings, or a calendar day to inspect its saved totals and transactions.
- **Data & backup** contains JSON import/export. **Latest log** returns the log date to the most recent saved snapshot (or the latest weekday when there are no snapshots).

## Checks

```sh
node --check app.js
node --test tests/performance.test.js
git diff --check
```
