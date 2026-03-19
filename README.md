# Madness Oracle Pro

A static prototype for NCAA March Madness bracket forecasting and market comparison.

## What changed

This version upgrades the older bracket demo into a more research-driven 64-team tournament workbench:

- models the full 64-team NCAA main bracket across four regions
- simulates every round through the title game with 25,000 Monte Carlo runs
- blends three matchup priors inspired by academic forecasting ideas: a team-strength logistic model, a seed prior, and a no-vig market prior
- adds soft-factor inputs for coaching, player experience, and roster continuity so users can encode tournament maturity and leadership
- applies uncertainty shrinkage so high-volatility matchups get pulled closer to 50/50 instead of becoming overconfident
- exposes first-round sportsbook moneylines and compares them against model fair odds
- ranks the best first-round moneyline edges instead of only showing bracket picks

## Research stance

The current app is closer to a lightweight academic ensemble than the previous heuristic demo. It now explicitly uses:

- **logistic matchup modeling** for team-strength differences
- **Four Factors + adjusted efficiency** as the base basketball signal set
- **market efficiency respect** via vig removal and sportsbook-prior blending
- **soft-factor adjustments** for coaching, experience, and continuity that often matter in March but rarely appear cleanly in box scores
- **uncertainty regularization** so volatile matchups are de-risked rather than treated as certain
- **Monte Carlo path simulation** so region paths affect later-round odds

It is still a prototype, but it is more aligned with the way current academic and quantitative sports models are usually structured.

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Product stance

This app is designed to help users make better bracket and betting decisions, but it does **not** promise guaranteed wins. In real betting workflows, the useful goal is to identify positive expected-value spots and beat weak prices, especially before markets fully sharpen.


## What you may have overlooked

A few important product / architecture realities were missing before:

- **Privacy**: many users will not want to publish or sync their bracket logic, betting edges, or custom team ratings.
- **Persistence**: without local save/export, users can lose their work on refresh.
- **Architecture clarity**: the current prototype is **not** backed by a database, **not** using SQLite, and **not** running as a Rust app today.
- **Deployment choice**: if you want stronger privacy, the likely next step is a **local-first desktop wrapper** (for example Tauri + Rust) or an encrypted backend.

## Current architecture

Right now the app is intentionally simple:

- **Frontend only**: static HTML, CSS, and JavaScript.
- **No backend service**: no API server receives picks or team edits.
- **No database**: no Postgres, no SQLite, no cloud persistence in the current repo.
- **Local persistence**: browser storage plus import/export is the best fit for this prototype stage.

That means users keep predictions on-device unless they choose to export them.
