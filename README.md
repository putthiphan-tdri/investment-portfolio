# My Funds — Mutual Fund Portfolio

A static web app for tracking Thai mutual fund holdings and available cash: NAV updates, multi-currency funds (THB/USD), dividend/sell proceeds deposited to Cash, P&L calendar heatmap, category allocation, and performance charts.

Portfolio data lives in this browser or installed app's `localStorage`. Optional cloud sync stores a private copy through the Vercel API when configured. Use **Export JSON** / **Import JSON** in the app to back up or move data between browsers.

## Run locally

```sh
python3 -m http.server 8743
# open http://localhost:8743
```

## Deploy

Plain static site (no build step). Publish `index.html`, `styles.css`, `app.js`, `pwa.js`, `sw.js`, `manifest.webmanifest`, and the `icons/` directory together. The dashboard and PWA work on HTTPS static hosting, including Vercel, Netlify, or GitHub Pages. Cloud sync also needs the configured Vercel API; it is not available on a plain local/static server.

## Install in the Mac Dock

1. Open [My Funds](https://investment-portfolio-kohl.vercel.app/) in **Safari on macOS Sonoma 14 or later**. Export a backup from **Data & backup → Export JSON** first.
2. Choose **File → Add to Dock**, name it **My Funds**, and click **Add**.
3. Launch My Funds from the Dock. Safari gives it separate website storage. If it opens empty, use **Data & backup → Import JSON** to load the backup, or enter your existing cloud sync key in cloud sync settings.

Chrome and Edge can also install it through their install app menu. The dashboard's **Install My Funds** button provides help and offers a native install prompt when the browser makes one available.

Use the hosted HTTPS URL for everyday access. For local use, start the server above and always use exactly `http://localhost:8743/`; hostnames and ports have separate portfolio storage. Keep the server running for the installed app's first launch and for updates. The existing START HERE launcher chooses a new port when its default is busy, so avoid installing from a changing address.

After the installed app has loaded online and finished offline setup, the dashboard and saved portfolio can reopen offline. Viewing, editing, and JSON backups work locally; cloud sync requires a connection. Offline changes remain local until a successful sync; the PWA does not add background sync. External fonts may fall back to system fonts offline. Browser data clearing or storage eviction can remove saved data and the offline cache; keep JSON backups.

Updates download in the background. **Reload to update** appears when a new version is ready; finish open forms first. Other open windows are not forcibly reloaded. On every app-shell release, bump `VERSION` in `sw.js` and keep its `SHELL_FILES` URLs aligned with `index.html`. Only app assets are cached; API requests, sync credentials, and personal JSON files are excluded. Cache names are scoped to the installation path, so subdirectory hosting works without clearing other apps' caches.

Safari installation reference: [Use Safari web apps on Mac](https://support.apple.com/en-us/104996).

## Dashboard views

- The top bar links to **Overview / Holdings / Activity / Insights** and keeps **Add order** in reach; on phones these move to a bottom bar with Add order in the middle. **Add fund** is on the holdings panel.
- **Value / P&L / Daily P&L** switches the main chart. When the portfolio has a capital anchor (`capitalAnchor` in the saved data), P&L is total P&L: value minus **capital invested**. Only money entering or leaving moves capital: buys not paid from cash, sells not deposited to cash, deposits and withdrawals. Sells into cash, cash-funded buys, switches and dividends kept as cash change P&L, not capital. Without an anchor, P&L is the unrealized balance of holdings (value minus their cost). The hero's **Unrealized P&L** always uses holdings cost. Daily P&L uses recorded daily NAV movement and leaves missing observations blank.
- Chart and holdings view preferences are remembered in this browser. Focus the chart's latest point and use arrow keys to explore dates; Escape closes the tooltip.
- **Overview / Detailed** controls holdings density. On mobile, **Show details** expands one holding. Select a fund name or P&L contribution to inspect its NAV and transaction history.
- Select a bank summary to filter holdings, or a calendar day to inspect its saved totals and transactions.
- The **⋯ (Data & backup)** menu in the top bar contains JSON import/export. **Latest** returns the log date to the most recent saved snapshot (or the latest weekday when there are no snapshots).
- JSON import defaults to **Merge records**, preserving order IDs and applying same-ID corrections. For a corrected full backup, select **Restore full portfolio** to replace holdings, activity, and snapshots, including removing records absent from the backup. The previous browser payload is saved under `myFundsPortfolio.v1.beforeJsonImport`. Restore uses the backup's balances without replaying transactions; distinct orders are retained even when their amounts match.

## Checks

```sh
node --check app.js
node --check pwa.js
node --check sw.js
node --test tests/*.test.js
git diff --check
```
