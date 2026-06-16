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
