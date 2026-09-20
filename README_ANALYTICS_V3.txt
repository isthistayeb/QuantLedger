QuantLedger Analytics V3
========================

Replace the old GitHub Pages files with:
- index.html
- app.js
- styles.css

Keep your live data file at:
- data/trades.json

Local Windows test:
- Double-click start_local.bat
- It opens http://localhost:8000

Important:
"Convergence window" is NOT the signal/chart timeframe.
It is only the maximum time gap between trade openings for the same symbol from different channels.
A channel with no timeframe is fully supported and is shown as "No TF".

Pattern Lab uses opened_at when present. If older demo data has no opened_at, it derives an approximate opening time from:
closed_at - duration_seconds
and marks it with ≈.
