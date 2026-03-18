# Madness Oracle Lab

A static prototype for NCAA March Madness tournament predictions.

## What it does

- Lets you edit a Sweet 16-style field of teams.
- Scores teams with a blend of adjusted efficiency, seed priors, Four Factors, form, and injury penalties.
- Runs 10,000 Monte Carlo simulations to estimate champion odds.
- Surfaces vulnerable favorites as an upset radar.
- Renders a simulated bracket path with explainable matchup win probabilities.

## Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Product stance

This app is intentionally explicit that no model can guarantee a perfect bracket. The goal is a better decision-support tool, not a false promise.
