# Chiliad Business Pulse

Static, privacy-reduced dashboard for two GTA5RP Chiliad businesses. The live
site is <https://fedir-timoshek.github.io/5rpstats-dashboard/>.

This repository is intentionally public so GitHub Pages remains available on
GitHub Free. It contains no GTA5RP credentials, Google service-account key,
spreadsheet identifier, deploy key, cookies, storage state, raw worksheet rows,
account balance, cashbox, or warehouse stock.

The private `fedir-timoshek/5rpstats` repository's single combined hourly job
collects both isolated accounts, derives the aggregate, validates the public
boundary, and pushes through a write deploy key scoped only to this repository.
Its manual publisher workflow is recovery-only. Neither publication path
copies private generator configuration or credentials here.

The exact tracked allowlist is:

1. `.github/workflows/pages.yml`
2. `README.md`
3. `site/app.js`
4. `site/data/stats.json`
5. `site/favicon.svg`
6. `site/index.html`
7. `site/styles.css`
8. `validate_site.py`

The public Pages workflow is secretless and has no schedule. It deploys on a
matching push to `main`, with manual recovery available. The public repository
receives no Google/GTA credential, source spreadsheet id, deploy key, or raw
source response.

The private generator derives aggregates from:

- `Chiliad - азс 6`;
- `Chiliad - барбершоп 5`.

It publishes only:

- daily summed `NET` for АЗС №6 and Барбершоп №5;
- daily minimum and maximum Chiliad online;
- aggregate sample counts and bounded source/generated timestamps.

The site uses static HTML, CSS, vanilla JavaScript, and accessible SVG charts.
Its visual direction is a calm dark operations dashboard with tabular numerals,
responsive spacing, warm amber/mint business accents, and a violet/sky online
range. It provides loading, populated, empty, error, and stale states and honors
reduced-motion preferences. There is no framework runtime, live Sheets fetch,
third-party font, visitor analytics, or client-side secret.

Bootstrap commit
`e33183c8d20c6416db4a6c1ff41c4133894fbca2` was deployed successfully by Pages
run `33578571623`. Pages uses workflow builds, the deployment environment is
restricted to `main`, and desktop/mobile visual smoke plus the reduced-data
privacy check passed.
