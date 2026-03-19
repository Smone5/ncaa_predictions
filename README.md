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

Copy `.env.example` to `.env` and add any keys you want to use:

```bash
cp .env.example .env
```

Supported variables:

- `OPENAI_API_KEY`: enables researched AI prefills for coach, experience, continuity, injuries, and form
- `OPENAI_PREFILL_MODEL`: optional override for the AI prefill model, default is `gpt-5-mini`
- `OPENAI_RESEARCH_TEAM_LIMIT`: optional cap for how many teams get deeper web research, default is `12`
- `THE_ODDS_API_KEY`: enables live sportsbook odds sync
- `NEWSAPI_KEY`: enables live news ingestion

Then start the app:

```bash
cargo run
```

Open `http://127.0.0.1:3000`.

For desktop packaging, use the Tauri shell in `src-tauri/` with the scripts in `package.json`.

## Product stance

This app is designed to help users make better bracket and betting decisions, but it does **not** promise guaranteed wins. In real betting workflows, the useful goal is to identify positive expected-value spots and beat weak prices, especially before markets fully sharpen.


## What you may have overlooked

A few important product / architecture realities were missing before:

- **Privacy**: many users will not want to publish or sync their bracket logic, betting edges, or custom team ratings.
- **Persistence**: without local save/export, users can lose their work on refresh.
- **Architecture clarity**: the current prototype now uses a local Rust server plus SQLite, but it still does not have multi-user auth, sync, or encryption at rest.
- **Deployment choice**: if you want stronger privacy and packaging, the next step is a true desktop wrapper (for example Tauri + Rust) or an encrypted backend.

## Current architecture

Right now the app is intentionally simple:

- **Rust app server**: `src/main.rs` starts an Axum server on `127.0.0.1:3000` and serves the frontend plus local API routes.
- **SQLite persistence**: the app stores saved state in a local `madness_oracle.db` file.
- **No cloud backend**: no remote API, no hosted database, and no forced sharing of picks.
- **Local portability**: JSON import/export still exists for backup or moving data between machines.

That means users keep predictions on-device unless they choose to export them, and the persistence layer is now a real local database rather than browser storage.


## Tauri status

Yes now — the repo includes a **Tauri desktop shell** in `src-tauri/` so the app can move toward an installable desktop package instead of only running as a local web server.

There are now two Rust-side paths in the repo:

- `src/main.rs`: Axum + SQLite local web app runtime
- `src-tauri/`: Tauri desktop packaging and SQLite-backed commands for desktop installs

That means the project is no longer just “Rust + SQLite in a browser”; it now has an explicit desktop-install direction.
