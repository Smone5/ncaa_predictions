# Madness Oracle Pro

Madness Oracle Pro is a local NCAA tournament forecasting and paper-betting workbench.

It is built around four ideas:

- use the real 64-team bracket field
- freeze predictions before grading them
- compare model prices to market prices
- let the system learn slowly from history without blindly overfitting

## What The App Does

- loads the official 2026 NCAA tournament field and NCAA team stats
- simulates the full bracket through all six rounds with Monte Carlo
- tracks a live tournament state as games finish
- builds a paper-betting board with stake sizing, hedge math, and bankroll tracking
- logs frozen pregame predictions and grades them later against actual scores
- runs historical backtests and score replays on archived seasons
- evolves model weights and betting strategy profiles on archived data
- syncs live odds and recent news when provider keys are configured
- uses AI research to prefill team context and betting settings

## Core Workflow

The normal workflow is:

1. Load the official field.
2. Sync results, odds, and news.
3. Generate researched AI prefill if you want AI context on teams.
4. Run Monte Carlo to price the current tournament path.
5. Review the current-round edges and paper stake plan.
6. Lock predictions before tipoff.
7. Let the tournament sync grade predictions and settle paper bets as results post.
8. Run backtests, score replay, evolution, and strategy lab to improve slowly.

## Main Concepts

### Forecasting

The matchup engine blends:

- adjusted offense and defense
- Four Factors
- seed prior
- market prior when moneylines are available
- soft factors like coach, experience, and continuity
- uncertainty shrinkage so noisy games get pulled back toward 50/50

### Monte Carlo

Monte Carlo runs the bracket forward many times from the current state of the tournament.

- more runs reduce random simulation wobble
- more runs do not fix bad inputs or model bias
- the UI now supports larger runs and shows progress

### No-lookahead grading

The app now separates:

- live locked prediction grading
- no-lookahead historical bracket-start replay
- round-by-round historical replay for secondary context

That means the app tries to predict first, lock that snapshot, and only grade later.

### Learning loop

The system learns conservatively:

- backtests and score replays measure error
- evolution searches for better model weights
- strategy evolution searches for better bankroll and hedge discipline
- paper-bet feedback tracks CLV, reward, and drawdown
- promotion gates prevent fragile changes from being applied automatically

It does not fully self-rewrite from one bad result. The goal is slow improvement, not constant overreaction.

## Heavy Runs And Background Jobs

Heavier optimizer runs no longer have to freeze the app.

The Validation workspace now supports:

- larger evolution populations
- larger generation counts
- multi-start restarts
- live job progress while the rest of the dashboard stays usable

The researched AI prefill path also runs as a background job now.

## Adaptive Hedging

Hedge mode is no longer limited to one blunt global style.

You can still choose:

- `No hedge`
- `Equal result`
- `Break even`

But there is also:

- `Adaptive per bet`

In adaptive mode, the app scores hedge choices per recommendation using edge, confidence, bankroll pressure, and live news risk, then picks the most risk-adjusted plan for that specific ticket.

## AI Research And Cache

With `OPENAI_API_KEY` configured, the app can:

- research priority teams
- suggest coach, experience, continuity, injuries, and form values
- recommend betting settings

The app now also keeps a cached AI research layer so that expensive research can feed:

- Monte Carlo
- the edge board
- the stake plan

without forcing you to regenerate everything every time.

You can turn that overlay on or off from the betting controls.

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Supported variables:

- `OPENAI_API_KEY`
- `OPENAI_PREFILL_MODEL`
- `OPENAI_RESEARCH_TEAM_LIMIT`
- `THE_ODDS_API_KEY`
- `NEWSAPI_KEY`

Then start the app:

```bash
cargo run
```

Default local URL:

```text
http://127.0.0.1:3000
```

If that port is already in use:

```bash
PORT=3001 cargo run
```

## Persistence And Reset

The app stores local state in SQLite in `madness_oracle.db`.

Saved state includes:

- teams
- weights
- bankroll and paper bets
- tournament state
- prediction log
- cached AI prefill
- optimizer settings

You can:

- save to database
- export/import JSON
- clear the database and start over from a fresh official-season baseline

## Current Architecture

- [src/main.rs](/Users/amelton/ncaa_predictions/src/main.rs): Axum server, APIs, SQLite persistence, background jobs
- [app.js](/Users/amelton/ncaa_predictions/app.js): simulation engine, betting workflow, grading, UI logic
- [index.html](/Users/amelton/ncaa_predictions/index.html): dashboard layout and controls
- [src-tauri/src/main.rs](/Users/amelton/ncaa_predictions/src-tauri/src/main.rs): Tauri desktop shell commands

There is no cloud backend by default. The project is intentionally local-first.

## Product Stance

This app is for forecasting, paper trading, and research support.

It is not:

- guaranteed-profit software
- automatic sportsbook execution
- a perfect historical reconstruction of every past market and injury state

The most useful goal is still the boring one: identify better prices, manage downside, and improve decision quality over time.

## Current Limitations

- archived seasons still rely on proxy historical team ratings rather than full historical stat snapshots
- historical betting replays still do not have a complete archived closing-line dataset
- live news interpretation is helpful but still needs human judgment
- the AI research path is stronger than before, but it is still not a perfect autonomous sports desk

## Desktop Direction

The repo includes a Tauri shell in [src-tauri/](/Users/amelton/ncaa_predictions/src-tauri/) so this can keep moving toward a desktop install, not just a local browser app.
