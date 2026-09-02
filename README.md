# Chiliad Business Pulse

Static, privacy-reduced dashboard for two GTA5RP Chiliad businesses.

The repository is intentionally public so GitHub Pages remains available on
GitHub Free. It contains no GTA5RP credentials,
Google service-account key, cookies, storage state, raw worksheet rows, account
balance, cashbox, or warehouse stock.

The private collector repository performs the hourly aggregate build. This
public repository receives only the validated static site and reduced JSON; it
does not receive the spreadsheet identifier or generator configuration.

The public Pages workflow is secretless and has no schedule. Its automatic
trigger is a matching push to `main`; the private repository's hourly publisher
pushes only `site/` through a write deploy key scoped to this repository. The
public repository receives neither half of the private publisher secret
contract, no Google/GTA credential, and no raw source response.

The private publisher derives aggregates from these worksheets:

- `Chiliad - азс 6`
- `Chiliad - барбершоп 5`

It publishes only:

- daily summed `NET` for АЗС №6 and Барбершоп №5;
- daily minimum and maximum Chiliad online;
- aggregate sample counts and source freshness timestamps.

The public site uses static HTML, CSS, JavaScript, and accessible SVG charts.
The standard-library Python generator runs only in the private repository and
is not copied here. No third-party browser runtime or analytics is loaded by
visitors.
