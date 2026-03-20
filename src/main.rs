#![recursion_limit = "512"]

use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{Datelike, Duration, Utc};
use rand::{rngs::StdRng, Rng, SeedableRng};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use tower_http::services::ServeDir;

const REGION_ORDER: [&str; 4] = ["East", "West", "South", "Midwest"];
const FIRST_ROUND_SEED_PAIRS: [(u8, u8); 8] = [
    (1, 16),
    (8, 9),
    (5, 12),
    (4, 13),
    (6, 11),
    (3, 14),
    (7, 10),
    (2, 15),
];
const BACKTEST_YEARS: [i32; 4] = [2024, 2023, 2022, 2021];
const EVOLUTION_SEED: u64 = 20_260_319;
const EVOLUTION_POPULATION: usize = 48;
const EVOLUTION_GENERATIONS: usize = 18;
const STRATEGY_EVOLUTION_SEED: u64 = 20_260_320;
const STRATEGY_EVOLUTION_POPULATION: usize = 42;
const STRATEGY_EVOLUTION_GENERATIONS: usize = 16;

struct AppState {
    db_path: PathBuf,
    http: Client,
    jobs: Mutex<HashMap<String, BackgroundJobRecord>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    version: i64,
    saved_at: String,
    teams: serde_json::Value,
    weights: serde_json::Value,
    #[serde(default)]
    portfolio: serde_json::Value,
    #[serde(default)]
    tournament: serde_json::Value,
    #[serde(default)]
    prediction_log: serde_json::Value,
    #[serde(default)]
    ai_prefill: serde_json::Value,
    #[serde(default)]
    optimizer_settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeasonResponse {
    meta: SeasonMeta,
    teams: Vec<ModelTeam>,
    glossary: Vec<StatDefinition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeasonMeta {
    year: i32,
    source_url: String,
    stats_url: String,
    stats_last_updated: String,
    fetched_at: String,
    note: String,
    caveats: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelTeam {
    id: String,
    region: String,
    seed: u8,
    name: String,
    adj_o: f64,
    adj_d: f64,
    efg: f64,
    tov: f64,
    orb: f64,
    ftr: f64,
    form: f64,
    injuries: f64,
    coach: f64,
    experience: f64,
    continuity: f64,
    market_ml: i32,
    pace: f64,
    points_per_game: f64,
    net_ranking: i32,
    win_pct: f64,
    last_ten_record: String,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatDefinition {
    property: String,
    label: String,
    description: String,
    category: String,
    value: String,
    baseline: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NcaaTeamStatsResponse {
    last_updated: String,
    tournament_teams: Vec<NcaaTeamStats>,
}

#[derive(Debug, Clone, Deserialize)]
struct NcaaTeamStats {
    market: String,
    seed: i32,
    team_id: i64,
    overall_efficiency: String,
    opponent_efficiency: String,
    effective_field_goals_pct: String,
    overall_turnovers_total: String,
    overall_offensive_rebounds: String,
    overall_free_throws_pct: String,
    last_ten_games: String,
    last_ten_games_record: String,
    overall_points: String,
    overall_winning_pct: String,
    netranking: i32,
}

#[derive(Debug, Clone)]
struct FieldEntry {
    region: String,
    seed: u8,
    name: String,
}

#[derive(Debug, Clone)]
struct HistoricalBracket {
    field: Vec<FieldEntry>,
    games: Vec<ActualGame>,
}

#[derive(Debug, Clone)]
struct ActualGame {
    round_index: usize,
    region: String,
    team_a: ActualTeam,
    team_b: ActualTeam,
}

#[derive(Debug, Clone)]
struct ActualTeam {
    seed: u8,
    name: String,
    score: Option<i32>,
    won: bool,
}

#[derive(Debug, Clone)]
struct PredictionTeam {
    seed: u8,
    name: String,
    adj_o: f64,
    adj_d: f64,
    efg: f64,
    tov: f64,
    orb: f64,
    ftr: f64,
    form: f64,
    injuries: f64,
    coach: f64,
    experience: f64,
    continuity: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelWeights {
    efficiency: f64,
    seed: f64,
    four_factors: f64,
    momentum: f64,
    injuries: f64,
    soft_factors: f64,
    uncertainty: f64,
}

#[derive(Debug, Clone)]
struct HistoricalSeasonData {
    year: i32,
    bracket: HistoricalBracket,
    lookup: HashMap<String, PredictionTeam>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BacktestResponse {
    methodology: String,
    caveats: Vec<String>,
    weights_used: ModelWeights,
    aggregate: BacktestAggregate,
    years: Vec<BacktestYear>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreBacktestResponse {
    methodology: String,
    caveats: Vec<String>,
    weights_used: ModelWeights,
    aggregate: ScoreBacktestAggregate,
    years: Vec<ScoreBacktestYear>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreBacktestAggregate {
    years_covered: usize,
    games_graded: usize,
    winner_accuracy: f64,
    team_score_mae: f64,
    team_score_rmse: f64,
    margin_mae: f64,
    margin_rmse: f64,
    total_mae: f64,
    total_rmse: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreBacktestYear {
    year: i32,
    games_graded: usize,
    winner_accuracy: f64,
    team_score_mae: f64,
    team_score_rmse: f64,
    margin_mae: f64,
    margin_rmse: f64,
    total_mae: f64,
    total_rmse: f64,
    rounds: Vec<ScoreRoundResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreRoundResult {
    label: String,
    games: usize,
    winner_accuracy: f64,
    team_score_mae: f64,
    team_score_rmse: f64,
    margin_mae: f64,
    margin_rmse: f64,
    total_mae: f64,
    total_rmse: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BacktestAggregate {
    years_covered: usize,
    correct_picks: usize,
    total_games: usize,
    overall_accuracy: f64,
    average_brier: f64,
    champion_hits: usize,
    no_lookahead_correct_picks: usize,
    no_lookahead_total_games: usize,
    no_lookahead_accuracy: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BacktestYear {
    year: i32,
    champion_pick: String,
    actual_champion: String,
    champion_hit: bool,
    correct_picks: usize,
    total_games: usize,
    overall_accuracy: f64,
    average_brier: f64,
    rounds: Vec<RoundResult>,
    no_lookahead_correct_picks: usize,
    no_lookahead_total_games: usize,
    no_lookahead_accuracy: f64,
    no_lookahead_rounds: Vec<RoundResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundResult {
    label: String,
    correct: usize,
    total: usize,
    accuracy: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvolutionResponse {
    methodology: String,
    caution: String,
    defaults: ModelWeights,
    anchor_weights: ModelWeights,
    recommended_weights: ModelWeights,
    holdout_average_accuracy: f64,
    holdout_average_brier: f64,
    evaluated_seasons_accuracy: f64,
    evaluated_seasons_brier: f64,
    generations: usize,
    population_size: usize,
    restarts: usize,
    candidates: Vec<EvolutionCandidate>,
    fold_summaries: Vec<EvolutionFoldSummary>,
    meta_signals: Vec<String>,
    promotion_review: ModelPromotionReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum HedgeStyle {
    None,
    EqualResult,
    BreakEven,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrategyProfile {
    min_edge_pct: f64,
    kelly_multiplier: f64,
    max_stake_pct: f64,
    max_open_risk_pct: f64,
    min_confidence: f64,
    hedge_style: HedgeStyle,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyEvolutionResponse {
    methodology: String,
    caution: String,
    defaults: StrategyProfile,
    recommended_profile: StrategyProfile,
    holdout_average_roi: f64,
    holdout_average_log_growth: f64,
    holdout_average_drawdown: f64,
    evaluated_seasons_roi: f64,
    evaluated_seasons_log_growth: f64,
    evaluated_seasons_drawdown: f64,
    generations: usize,
    population_size: usize,
    restarts: usize,
    candidates: Vec<StrategyCandidate>,
    fold_summaries: Vec<StrategyFoldSummary>,
    meta_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyCandidate {
    rank: usize,
    profile: StrategyProfile,
    average_roi: f64,
    average_log_growth: f64,
    worst_year_roi: f64,
    average_drawdown: f64,
    average_bets: f64,
    fitness: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyFoldSummary {
    holdout_year: i32,
    train_years: Vec<i32>,
    selected_profile: StrategyProfile,
    holdout_roi: f64,
    holdout_log_growth: f64,
    holdout_drawdown: f64,
    holdout_bets: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayReviewRequest {
    current_profile: StrategyProfile,
    candidate_profile: StrategyProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayReviewMetrics {
    holdout_average_roi: f64,
    holdout_average_log_growth: f64,
    holdout_average_drawdown: f64,
    holdout_average_bets: f64,
    worst_year_roi: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayReviewResponse {
    methodology: String,
    caution: String,
    current_profile: StrategyProfile,
    candidate_profile: StrategyProfile,
    current_metrics: OverlayReviewMetrics,
    candidate_metrics: OverlayReviewMetrics,
    delta_roi: f64,
    delta_log_growth: f64,
    delta_drawdown: f64,
    promote: bool,
    gate_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelPromotionMetrics {
    holdout_average_accuracy: f64,
    holdout_average_brier: f64,
    holdout_average_team_score_mae: f64,
    holdout_average_margin_mae: f64,
    worst_holdout_accuracy: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelPromotionReview {
    methodology: String,
    caution: String,
    current_weights: ModelWeights,
    candidate_weights: ModelWeights,
    current_metrics: ModelPromotionMetrics,
    candidate_metrics: ModelPromotionMetrics,
    delta_accuracy: f64,
    delta_brier: f64,
    delta_team_score_mae: f64,
    delta_margin_mae: f64,
    promote: bool,
    gate_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvolutionCandidate {
    rank: usize,
    weights: ModelWeights,
    average_accuracy: f64,
    average_brier: f64,
    worst_year_accuracy: f64,
    brier_stddev: f64,
    distance_from_defaults: f64,
    fitness: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvolutionFoldSummary {
    holdout_year: i32,
    train_years: Vec<i32>,
    selected_weights: ModelWeights,
    holdout_accuracy: f64,
    holdout_brier: f64,
}

#[derive(Debug, Default)]
struct RoundAccumulator {
    correct: usize,
    total: usize,
}

#[derive(Debug, Default, Clone)]
struct ScoreMetricAccumulator {
    games: usize,
    winner_correct: usize,
    team_score_abs_sum: f64,
    team_score_sq_sum: f64,
    margin_abs_sum: f64,
    margin_sq_sum: f64,
    total_abs_sum: f64,
    total_sq_sum: f64,
}

#[derive(Debug, Clone, Copy)]
struct ScoreProjection {
    team_a_points: f64,
    team_b_points: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveContextRequest {
    games: Vec<LiveGameRequest>,
    #[serde(default)]
    news_teams: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveGameRequest {
    region: String,
    team_a: String,
    team_b: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveContextResponse {
    fetched_at: String,
    odds_provider: LiveProviderStatus,
    news_provider: LiveProviderStatus,
    games: Vec<LiveGameMatch>,
    articles: Vec<LiveArticle>,
    team_signals: Vec<LiveTeamSignal>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentSyncRequest {
    year: i32,
    teams: Vec<TournamentSyncTeam>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentSyncTeam {
    id: String,
    region: String,
    seed: u8,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentSyncResponse {
    fetched_at: String,
    source_url: String,
    message: String,
    year: i32,
    matched_game_count: usize,
    completed_game_count: usize,
    in_progress_game_count: usize,
    upcoming_game_count: usize,
    games: Vec<TournamentFeedGame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentFeedGame {
    contest_id: i64,
    round_index: usize,
    round_label: String,
    region: String,
    game_state: String,
    status_display: String,
    start_time: Option<String>,
    start_date: Option<String>,
    game_url: String,
    team_a: TournamentFeedTeam,
    team_b: TournamentFeedTeam,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentFeedTeam {
    name: String,
    seed: u8,
    score: Option<i32>,
    is_winner: bool,
    team_id: Option<String>,
    region: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPrefillRequest {
    teams: Vec<AiPrefillTeamInput>,
    #[serde(default)]
    articles: Vec<LiveArticle>,
    #[serde(default)]
    team_signals: Vec<LiveTeamSignal>,
    #[serde(default)]
    focus_team_names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyRequest {
    current_profile: StrategyProfile,
    bankroll: AiStrategyBankrollInput,
    current_round: AiStrategyRoundInput,
    #[serde(default)]
    live_context: AiStrategyLiveContextInput,
    #[serde(default)]
    ai_assessments: Vec<AiTeamAssessment>,
    #[serde(default)]
    validation: AiStrategyValidationInput,
    #[serde(default)]
    feedback_loop: AiStrategyFeedbackInput,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyBankrollInput {
    starting_bankroll: f64,
    available_cash: f64,
    open_risk: f64,
    risk_budget_left: f64,
    open_bets: usize,
    settled_bets: usize,
    realized_pnl: f64,
    roi: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyRoundInput {
    round_label: String,
    open_matchups: usize,
    #[serde(default)]
    top_recommendations: Vec<AiStrategyTopRecommendation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerRunRequest {
    population_size: Option<usize>,
    generations: Option<usize>,
    restarts: Option<usize>,
    current_weights: Option<ModelWeights>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoricalWeightsRequest {
    weights: Option<ModelWeights>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvolutionRunConfig {
    population_size: usize,
    generations: usize,
    restarts: usize,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyRunConfig {
    population_size: usize,
    generations: usize,
    restarts: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobLaunchResponse {
    job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundJobRecord {
    id: String,
    kind: String,
    status: String,
    progress: f64,
    message: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyTopRecommendation {
    team: String,
    opponent: String,
    edge_pct: f64,
    confidence: f64,
    market_ml: i32,
    fair_ml: i32,
    hedge_style: HedgeStyle,
    projected_margin: f64,
    projected_total: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyLiveContextInput {
    odds_configured: bool,
    odds_matched_games: usize,
    news_configured: bool,
    article_count: usize,
    signal_count: usize,
    #[serde(default)]
    strongest_signals: Vec<AiStrategySignalSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategySignalSummary {
    team_name: String,
    suggested_injuries: f64,
    confidence: f64,
    article_count: usize,
    summary: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyValidationInput {
    backtest_accuracy: Option<f64>,
    average_brier: Option<f64>,
    score_team_mae: Option<f64>,
    score_margin_mae: Option<f64>,
    score_total_mae: Option<f64>,
    strategy_recommended_profile: Option<StrategyProfile>,
    strategy_holdout_roi: Option<f64>,
    strategy_holdout_drawdown: Option<f64>,
    evolution_caution: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyFeedbackInput {
    tracked_bets: usize,
    settled_bets: usize,
    open_bets: usize,
    avg_clv_prob_delta: Option<f64>,
    positive_clv_rate: Option<f64>,
    avg_reward_score: Option<f64>,
    peak_drawdown: f64,
    candidate_profile: Option<StrategyProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPrefillTeamInput {
    id: String,
    region: String,
    seed: u8,
    name: String,
    adj_o: f64,
    adj_d: f64,
    efg: f64,
    tov: f64,
    orb: f64,
    ftr: f64,
    form: f64,
    injuries: f64,
    coach: f64,
    experience: f64,
    continuity: f64,
    market_ml: i32,
    pace: Option<f64>,
    points_per_game: Option<f64>,
    net_ranking: Option<i32>,
    win_pct: Option<f64>,
    last_ten_record: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiPrefillResponse {
    provider: AiProviderStatus,
    generated_at: String,
    model: Option<String>,
    researched_teams: usize,
    fallback_teams: usize,
    assessments: Vec<AiTeamAssessment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyResponse {
    provider: AiProviderStatus,
    generated_at: String,
    model: Option<String>,
    fallback_used: bool,
    recommendation: AiStrategyRecommendation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStrategyRecommendation {
    profile: StrategyProfile,
    auto_refresh_minutes: i32,
    live_odds_mode: String,
    auto_sync: bool,
    auto_apply_news: bool,
    confidence: f64,
    risk_posture: String,
    summary: String,
    reasons: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderStatus {
    configured: bool,
    available: bool,
    message: String,
    source_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatusResponse {
    odds_provider: LiveProviderStatus,
    news_provider: LiveProviderStatus,
    ai_provider: AiProviderStatus,
    ai_model: String,
    research_team_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiTeamAssessment {
    team_name: String,
    coach: f64,
    experience: f64,
    continuity: f64,
    injuries: f64,
    form: f64,
    confidence: f64,
    researched: bool,
    summary: String,
    source_signals: Vec<String>,
    sources: Vec<ResearchSource>,
}

#[derive(Debug, Deserialize)]
struct AiPrefillModelOutput {
    assessments: Vec<AiTeamAssessment>,
}

#[derive(Debug, Deserialize)]
struct AiStrategyModelOutput {
    recommendation: AiStrategyRecommendation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResearchSource {
    title: String,
    url: String,
    publisher: String,
    note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveProviderStatus {
    configured: bool,
    available: bool,
    message: String,
    source_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveGameMatch {
    region: String,
    team_a: String,
    team_b: String,
    matched: bool,
    commence_time: Option<String>,
    book_count: usize,
    best_team_a_ml: Option<i32>,
    best_team_b_ml: Option<i32>,
    consensus_team_a_ml: Option<i32>,
    consensus_team_b_ml: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveArticle {
    title: String,
    source: String,
    description: String,
    published_at: String,
    url: String,
    teams: Vec<String>,
    signal: String,
    impact_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveTeamSignal {
    team_name: String,
    article_count: usize,
    injury_mentions: usize,
    positive_mentions: usize,
    suggested_injuries: f64,
    confidence: f64,
    summary: String,
    latest_article_published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OddsApiEvent {
    commence_time: Option<String>,
    home_team: String,
    away_team: String,
    #[serde(default)]
    bookmakers: Vec<OddsApiBookmaker>,
}

#[derive(Debug, Deserialize)]
struct OddsApiBookmaker {
    #[serde(default)]
    markets: Vec<OddsApiMarket>,
}

#[derive(Debug, Deserialize)]
struct OddsApiMarket {
    key: String,
    #[serde(default)]
    outcomes: Vec<OddsApiOutcome>,
}

#[derive(Debug, Deserialize)]
struct OddsApiOutcome {
    name: String,
    price: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct NewsApiResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    articles: Vec<NewsApiArticle>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewsApiArticle {
    source: NewsApiSource,
    title: String,
    description: Option<String>,
    published_at: String,
    url: String,
}

#[derive(Debug, Deserialize, Default)]
struct NewsApiSource {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NcaaChampionshipWidgetResponse {
    data: NcaaChampionshipWidgetData,
}

#[derive(Debug, Deserialize)]
struct NcaaChampionshipWidgetData {
    championships: Vec<NcaaChampionship>,
}

#[derive(Debug, Deserialize)]
struct NcaaChampionship {
    #[serde(default)]
    games: Vec<NcaaChampionshipGame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NcaaChampionshipGame {
    contest_id: i64,
    url: String,
    game_state: String,
    status_code_display: String,
    start_time: Option<String>,
    start_date: Option<String>,
    #[serde(default)]
    teams: Vec<NcaaChampionshipTeam>,
    round: NcaaChampionshipRound,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NcaaChampionshipTeam {
    name_short: String,
    seed: Option<u8>,
    score: Option<i32>,
    is_winner: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NcaaChampionshipRound {
    round_number: i32,
    title: String,
}

#[derive(Debug, Default)]
struct TeamSignalAccumulator {
    article_count: usize,
    injury_mentions: usize,
    positive_mentions: usize,
    net_injury_score: f64,
    latest_article_published_at: Option<String>,
}

impl EvolutionRunConfig {
    fn from_request(request: OptimizerRunRequest) -> Self {
        Self {
            population_size: request.population_size.unwrap_or(96).clamp(24, 256),
            generations: request.generations.unwrap_or(30).clamp(8, 80),
            restarts: request.restarts.unwrap_or(3).clamp(1, 8),
        }
    }

    fn legacy_defaults() -> Self {
        Self {
            population_size: EVOLUTION_POPULATION,
            generations: EVOLUTION_GENERATIONS,
            restarts: 1,
        }
    }
}

impl StrategyRunConfig {
    fn from_request(request: OptimizerRunRequest) -> Self {
        Self {
            population_size: request.population_size.unwrap_or(84).clamp(24, 256),
            generations: request.generations.unwrap_or(28).clamp(8, 80),
            restarts: request.restarts.unwrap_or(3).clamp(1, 8),
        }
    }

    fn legacy_defaults() -> Self {
        Self {
            population_size: STRATEGY_EVOLUTION_POPULATION,
            generations: STRATEGY_EVOLUTION_GENERATIONS,
            restarts: 1,
        }
    }
}

fn timestamp_now() -> String {
    Utc::now().to_rfc3339()
}

fn create_job_record(
    state: &Arc<AppState>,
    kind: &str,
    config: Option<serde_json::Value>,
) -> BackgroundJobRecord {
    let id = format!("job-{}", Utc::now().timestamp_micros());
    let now = timestamp_now();
    let job = BackgroundJobRecord {
        id: id.clone(),
        kind: kind.into(),
        status: "queued".into(),
        progress: 0.0,
        message: "Queued".into(),
        created_at: now.clone(),
        updated_at: now,
        result: None,
        error: None,
        config,
    };

    state
        .jobs
        .lock()
        .expect("background jobs mutex poisoned")
        .insert(id, job.clone());
    job
}

fn update_job_progress(
    state: &Arc<AppState>,
    job_id: &str,
    progress: f64,
    message: impl Into<String>,
) {
    if let Some(job) = state
        .jobs
        .lock()
        .expect("background jobs mutex poisoned")
        .get_mut(job_id)
    {
        job.status = "running".into();
        job.progress = progress.clamp(0.0, 1.0);
        job.message = message.into();
        job.updated_at = timestamp_now();
    }
}

fn complete_job<T: Serialize>(state: &Arc<AppState>, job_id: &str, result: &T) -> Result<(), ApiError> {
    if let Some(job) = state
        .jobs
        .lock()
        .expect("background jobs mutex poisoned")
        .get_mut(job_id)
    {
        job.status = "completed".into();
        job.progress = 1.0;
        job.message = "Completed".into();
        job.updated_at = timestamp_now();
        job.result = Some(serde_json::to_value(result).map_err(ApiError::Json)?);
        job.error = None;
    }
    Ok(())
}

fn fail_job(state: &Arc<AppState>, job_id: &str, error: &ApiError) {
    if let Some(job) = state
        .jobs
        .lock()
        .expect("background jobs mutex poisoned")
        .get_mut(job_id)
    {
        job.status = "failed".into();
        job.progress = 1.0;
        job.message = "Failed".into();
        job.updated_at = timestamp_now();
        job.error = Some(format!("{error:?}"));
    }
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    let db_path = PathBuf::from("madness_oracle.db");
    initialize_db(&db_path).expect("failed to initialize sqlite database");

    let http = Client::builder()
        .user_agent("madness-oracle-pro/0.1")
        .build()
        .expect("http client");

    let state = Arc::new(AppState {
        db_path,
        http,
        jobs: Mutex::new(HashMap::new()),
    });
    let api_routes = Router::new()
        .route("/state", get(get_state).put(put_state).delete(delete_state))
        .route("/season/:year", get(get_season))
        .route("/backtest", get(get_backtest).post(post_backtest))
        .route("/score-backtest", get(get_score_backtest).post(post_score_backtest))
        .route("/evolution", get(get_evolution))
        .route("/strategy-evolution", get(get_strategy_evolution))
        .route("/jobs/:id", get(get_job_status))
        .route("/jobs/evolution", post(post_evolution_job))
        .route("/jobs/strategy-evolution", post(post_strategy_evolution_job))
        .route("/jobs/ai-prefill", post(post_ai_prefill_job))
        .route("/overlay-review", post(post_overlay_review))
        .route("/provider-status", get(get_provider_status))
        .route("/tournament/sync", post(post_tournament_sync))
        .route("/live/context", post(post_live_context))
        .route("/ai/prefill", post(post_ai_prefill))
        .route("/ai/strategy", post(post_ai_strategy))
        .with_state(state);

    let app = Router::new()
        .nest("/api", api_routes)
        .fallback_service(ServeDir::new("."));

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!("Madness Oracle Pro running at http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind tcp listener");
    axum::serve(listener, app).await.expect("server failed");
}

async fn get_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<StoredState>>, ApiError> {
    Ok(Json(load_state_from_db(&state.db_path)?))
}

async fn put_state(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StoredState>,
) -> Result<impl IntoResponse, ApiError> {
    save_state_to_db(&state.db_path, &payload)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_state(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    clear_state_in_db(&state.db_path)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_season(
    State(state): State<Arc<AppState>>,
    Path(year): Path<i32>,
) -> Result<Json<SeasonResponse>, ApiError> {
    if year != 2026 {
        return Err(ApiError::Parse(format!(
            "Only the 2026 official NCAA field is currently supported, received {year}"
        )));
    }

    let response = fetch_official_2026_season(&state.http).await?;
    Ok(Json(response))
}

async fn get_backtest(State(state): State<Arc<AppState>>) -> Result<Json<BacktestResponse>, ApiError> {
    let results = run_backtests(&state.http, &default_model_weights()).await?;
    Ok(Json(results))
}

async fn get_score_backtest(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ScoreBacktestResponse>, ApiError> {
    let results = run_score_backtests(&state.http, &default_model_weights()).await?;
    Ok(Json(results))
}

async fn post_backtest(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<HistoricalWeightsRequest>,
) -> Result<Json<BacktestResponse>, ApiError> {
    let weights = requested_model_weights(payload.weights);
    let results = run_backtests(&state.http, &weights).await?;
    Ok(Json(results))
}

async fn post_score_backtest(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<HistoricalWeightsRequest>,
) -> Result<Json<ScoreBacktestResponse>, ApiError> {
    let weights = requested_model_weights(payload.weights);
    let results = run_score_backtests(&state.http, &weights).await?;
    Ok(Json(results))
}

async fn get_evolution(State(state): State<Arc<AppState>>) -> Result<Json<EvolutionResponse>, ApiError> {
    let results = run_evolution(&state.http).await?;
    Ok(Json(results))
}

async fn get_strategy_evolution(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StrategyEvolutionResponse>, ApiError> {
    let results = run_strategy_evolution(&state.http).await?;
    Ok(Json(results))
}

async fn get_job_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<BackgroundJobRecord>, ApiError> {
    let job = state
        .jobs
        .lock()
        .expect("background jobs mutex poisoned")
        .get(&id)
        .cloned()
        .ok_or_else(|| ApiError::Parse(format!("Unknown background job {id}")))?;
    Ok(Json(job))
}

async fn post_evolution_job(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OptimizerRunRequest>,
) -> Result<Json<JobLaunchResponse>, ApiError> {
    let anchor_weights = requested_model_weights(payload.current_weights);
    let config = EvolutionRunConfig::from_request(payload.clone());
    let config_value = serde_json::json!({
        "populationSize": config.population_size,
        "generations": config.generations,
        "restarts": config.restarts,
        "currentWeights": anchor_weights,
    });
    let job = create_job_record(&state, "evolution", Some(config_value));
    let state_clone = state.clone();
    let job_id = job.id.clone();

    tokio::spawn(async move {
        match run_evolution_with_config(&state_clone.http, config, anchor_weights, |progress, message| {
            update_job_progress(&state_clone, &job_id, progress, message);
        })
        .await
        {
            Ok(result) => {
                if let Err(error) = complete_job(&state_clone, &job_id, &result) {
                    fail_job(&state_clone, &job_id, &error);
                }
            }
            Err(error) => fail_job(&state_clone, &job_id, &error),
        }
    });

    Ok(Json(JobLaunchResponse { job_id: job.id }))
}

async fn post_strategy_evolution_job(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OptimizerRunRequest>,
) -> Result<Json<JobLaunchResponse>, ApiError> {
    let config = StrategyRunConfig::from_request(payload);
    let config_value = serde_json::to_value(config).map_err(ApiError::Json)?;
    let job = create_job_record(&state, "strategyEvolution", Some(config_value));
    let state_clone = state.clone();
    let job_id = job.id.clone();

    tokio::spawn(async move {
        match run_strategy_evolution_with_config(&state_clone.http, config, |progress, message| {
            update_job_progress(&state_clone, &job_id, progress, message);
        })
        .await
        {
            Ok(result) => {
                if let Err(error) = complete_job(&state_clone, &job_id, &result) {
                    fail_job(&state_clone, &job_id, &error);
                }
            }
            Err(error) => fail_job(&state_clone, &job_id, &error),
        }
    });

    Ok(Json(JobLaunchResponse { job_id: job.id }))
}

async fn post_ai_prefill_job(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AiPrefillRequest>,
) -> Result<Json<JobLaunchResponse>, ApiError> {
    let config = serde_json::json!({
        "focusTeamCount": payload.focus_team_names.len(),
        "articleCount": payload.articles.len(),
        "teamSignalCount": payload.team_signals.len(),
    });
    let job = create_job_record(&state, "aiPrefill", Some(config));
    let state_clone = state.clone();
    let job_id = job.id.clone();

    tokio::spawn(async move {
        update_job_progress(&state_clone, &job_id, 0.1, "Preparing researched AI prefill");
        match fetch_ai_prefill(&state_clone.http, payload).await {
            Ok(result) => {
                update_job_progress(&state_clone, &job_id, 0.95, "Caching researched AI output");
                if let Err(error) = complete_job(&state_clone, &job_id, &result) {
                    fail_job(&state_clone, &job_id, &error);
                }
            }
            Err(error) => fail_job(&state_clone, &job_id, &error),
        }
    });

    Ok(Json(JobLaunchResponse { job_id: job.id }))
}

async fn post_overlay_review(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OverlayReviewRequest>,
) -> Result<Json<OverlayReviewResponse>, ApiError> {
    let results = run_overlay_review(&state.http, payload).await?;
    Ok(Json(results))
}

async fn get_provider_status() -> Result<Json<ProviderStatusResponse>, ApiError> {
    Ok(Json(build_provider_status()))
}

async fn post_live_context(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LiveContextRequest>,
) -> Result<Json<LiveContextResponse>, ApiError> {
    Ok(Json(fetch_live_context(&state.http, payload).await?))
}

async fn post_tournament_sync(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TournamentSyncRequest>,
) -> Result<Json<TournamentSyncResponse>, ApiError> {
    Ok(Json(fetch_tournament_sync(&state.http, payload).await?))
}

async fn post_ai_prefill(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AiPrefillRequest>,
) -> Result<Json<AiPrefillResponse>, ApiError> {
    Ok(Json(fetch_ai_prefill(&state.http, payload).await?))
}

async fn post_ai_strategy(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AiStrategyRequest>,
) -> Result<Json<AiStrategyResponse>, ApiError> {
    Ok(Json(fetch_ai_strategy(&state.http, payload).await?))
}

async fn fetch_official_2026_season(client: &Client) -> Result<SeasonResponse, ApiError> {
    let bracket_url = "https://www.ncaa.com/brackets/basketball-men/d1/2026";
    let stats_url = "https://data.ncaa.com/prod/mml/2026/mobile/bracket_iq/ncaa_team_stats.json";
    let glossary_url = "https://mmldata.ncaa.com/mml/2026/data/prod/bracket_iq/ma_stats.json";

    let bracket_response = client.get(bracket_url).send().await?.error_for_status()?;
    let resolved_url = bracket_response.url().to_string();
    let bracket_html = bracket_response.text().await?;

    let stats_response = client.get(stats_url).send().await?.error_for_status()?;
    let stats: NcaaTeamStatsResponse = stats_response.json().await?;

    let glossary_response = client.get(glossary_url).send().await?.error_for_status()?;
    let glossary: Vec<StatDefinition> = glossary_response.json().await?;

    let field = parse_live_field(&bracket_html)?;
    let stats_by_name = stats
        .tournament_teams
        .iter()
        .map(|team| (team.market.clone(), team.clone()))
        .collect::<HashMap<_, _>>();

    let mut teams = Vec::with_capacity(field.len());
    for entry in field {
        let stat_line = stats_by_name.get(&entry.name).ok_or_else(|| {
            ApiError::Parse(format!("Missing NCAA stats for 2026 tournament team {}", entry.name))
        })?;
        teams.push(build_official_team(&entry, stat_line));
    }

    teams.sort_by(|a, b| {
        region_rank(&a.region)
            .cmp(&region_rank(&b.region))
            .then(a.seed.cmp(&b.seed))
            .then(a.name.cmp(&b.name))
    });

    Ok(SeasonResponse {
        meta: SeasonMeta {
            year: 2026,
            source_url: resolved_url,
            stats_url: stats_url.into(),
            stats_last_updated: stats.last_updated,
            fetched_at: Utc::now().to_rfc3339(),
            note: "Teams, seeds, and regions come from the official NCAA men's bracket. Core team stats come from NCAA's tournament team-stats feed. Live odds and news can now be layered in through optional provider keys, while injury/context adjustments remain heuristic rather than official NCAA fields.".into(),
            caveats: vec![
                "Moneylines remain editable placeholders until you enter live sportsbook prices or connect an odds provider.".into(),
                "Coach, experience, continuity, and injury values are still model-side overrides rather than official NCAA fields.".into(),
                "News-based injury signals are heuristic keyword extractions from recent coverage, so they should be sanity-checked before betting real money.".into(),
            ],
        },
        teams,
        glossary,
    })
}

fn default_model_weights() -> ModelWeights {
    ModelWeights {
        efficiency: 30.0,
        seed: 8.0,
        four_factors: 18.0,
        momentum: 8.0,
        injuries: 10.0,
        soft_factors: 12.0,
        uncertainty: 8.0,
    }
}

fn requested_model_weights(weights: Option<ModelWeights>) -> ModelWeights {
    weights.map(clamp_model_weights).unwrap_or_else(default_model_weights)
}

fn backtest_methodology() -> String {
    "Historical backtests now report a no-lookahead bracket-start replay as the main accuracy line: each season starts from the archived 64-team field, the model advances its own predicted winners forward to create future rounds, and those frozen slot winners are graded only after the real tournament outcomes are known. A secondary round-replay accuracy is still included for matchup-level calibration context. Because archived NCAA bracket-IQ team-stat feeds returned 404 for 2021-2024 during verification on March 19, 2026, those seasons currently use the app's seed-based proxy ratings rather than full archived NCAA stats.".into()
}

fn backtest_caveats() -> Vec<String> {
    vec![
        "Coverage currently includes 2021-2024 because NCAA's 2025 bracket archive endpoint resolves to the live 2026 bracket page.".into(),
        "No-lookahead replay removes future-matchup leakage, but it still does not recreate historical injuries, betting markets, or news context.".into(),
        "The live 2026 season uses official NCAA team stats; archived seasons currently do not.".into(),
    ]
}

fn score_backtest_methodology() -> String {
    "Score replays freeze each archived matchup before grading it: the model projects the pregame winner probability, margin, total, and team scores using only the historical field lookup and round context, then compares that frozen snapshot to the actual final score after the fact. That keeps the score audit chronological instead of quietly letting later information leak backward.".into()
}

fn score_backtest_caveats() -> Vec<String> {
    vec![
        "Archived score replays currently use the app's seed-based proxy ratings rather than full archived NCAA stat snapshots, because archived NCAA bracket-IQ team-stat feeds returned 404 for 2021-2024 during verification on March 19, 2026.".into(),
        "These score metrics grade a possession-based baseline projection. More simulations reduce bracket noise, but they do not change a frozen score estimate after tipoff.".into(),
        "Round-by-round summaries use the archived NCAA matchup tree and final scores, but they do not yet replay historical injuries, line movement, or news overlays.".into(),
    ]
}

async fn load_historical_seasons(client: &Client) -> Result<Vec<HistoricalSeasonData>, ApiError> {
    let mut seasons = Vec::with_capacity(BACKTEST_YEARS.len());

    for year in BACKTEST_YEARS {
        let url = format!("https://www.ncaa.com/brackets/basketball-men/d1/{year}");
        let html = client.get(&url).send().await?.error_for_status()?.text().await?;
        let bracket = parse_archived_bracket(&html)?;
        let lookup = build_historical_lookup(&bracket);
        seasons.push(HistoricalSeasonData { year, bracket, lookup });
    }

    Ok(seasons)
}

fn build_historical_lookup(bracket: &HistoricalBracket) -> HashMap<String, PredictionTeam> {
    let mut lookup = HashMap::new();
    for entry in &bracket.field {
        for alias in team_aliases(&entry.name) {
            let alias_entry = FieldEntry {
                region: entry.region.clone(),
                seed: entry.seed,
                name: alias.clone(),
            };
            lookup.insert(normalize_team_name(&alias), build_proxy_team(&alias_entry));
        }
    }
    lookup
}

fn evaluate_historical_season(
    season: &HistoricalSeasonData,
    weights: &ModelWeights,
) -> Result<BacktestYear, ApiError> {
    let champion_pick = predict_bracket_champion(&season.bracket.games, &season.lookup, weights)?;
    let actual_champion = season
        .bracket
        .games
        .iter()
        .find(|game| game.round_index == 5)
        .map(actual_winner_name)
        .ok_or_else(|| ApiError::Parse(format!("Missing title game for {}", season.year)))?;

    let mut rounds = BTreeMap::new();
    let mut correct = 0usize;
    let mut brier_sum = 0.0;

    for game in &season.bracket.games {
        let team_a = season
            .lookup
            .get(&normalize_team_name(&game.team_a.name))
            .ok_or_else(|| ApiError::Parse(format!("Missing proxy team for {} in {}", game.team_a.name, season.year)))?;
        let team_b = season
            .lookup
            .get(&normalize_team_name(&game.team_b.name))
            .ok_or_else(|| ApiError::Parse(format!("Missing proxy team for {} in {}", game.team_b.name, season.year)))?;

        let probability_a = blended_probability(team_a, team_b, game.round_index, weights);
        let predicted_winner = if probability_a >= 0.5 {
            &game.team_a.name
        } else {
            &game.team_b.name
        };
        let actual_winner = actual_winner_name(game);

        let round = rounds.entry(game.round_index).or_insert_with(RoundAccumulator::default);
        round.total += 1;
        if predicted_winner == actual_winner {
            round.correct += 1;
            correct += 1;
        }

        let actual = if game.team_a.won { 1.0 } else { 0.0 };
        brier_sum += (probability_a - actual).powi(2);
    }

    let round_results = rounds
        .into_iter()
        .map(|(round_index, acc)| RoundResult {
            label: round_label(round_index).into(),
            correct: acc.correct,
            total: acc.total,
            accuracy: ratio(acc.correct, acc.total),
        })
        .collect::<Vec<_>>();
    let no_lookahead = evaluate_no_lookahead_bracket_start(season, weights)?;

    Ok(BacktestYear {
        year: season.year,
        champion_hit: champion_pick == actual_champion,
        champion_pick,
        actual_champion: actual_champion.into(),
        correct_picks: correct,
        total_games: season.bracket.games.len(),
        overall_accuracy: ratio(correct, season.bracket.games.len()),
        average_brier: brier_sum / season.bracket.games.len() as f64,
        rounds: round_results,
        no_lookahead_correct_picks: no_lookahead.correct_picks,
        no_lookahead_total_games: no_lookahead.total_games,
        no_lookahead_accuracy: ratio(no_lookahead.correct_picks, no_lookahead.total_games),
        no_lookahead_rounds: no_lookahead.rounds,
    })
}

async fn run_backtests(client: &Client, weights: &ModelWeights) -> Result<BacktestResponse, ApiError> {
    let seasons = load_historical_seasons(client).await?;
    let mut years = Vec::with_capacity(seasons.len());
    let mut total_correct = 0usize;
    let mut total_games = 0usize;
    let mut champion_hits = 0usize;
    let mut brier_total = 0.0;
    let mut total_no_lookahead_correct = 0usize;
    let mut total_no_lookahead_games = 0usize;

    for season in &seasons {
        let year_result = evaluate_historical_season(season, &weights)?;
        total_correct += year_result.correct_picks;
        total_games += year_result.total_games;
        total_no_lookahead_correct += year_result.no_lookahead_correct_picks;
        total_no_lookahead_games += year_result.no_lookahead_total_games;
        if year_result.champion_hit {
            champion_hits += 1;
        }
        brier_total += year_result.average_brier;
        years.push(year_result);
    }

    Ok(BacktestResponse {
        methodology: backtest_methodology(),
        caveats: backtest_caveats(),
        weights_used: *weights,
        aggregate: BacktestAggregate {
            years_covered: years.len(),
            correct_picks: total_correct,
            total_games,
            overall_accuracy: ratio(total_correct, total_games),
            average_brier: brier_total / years.len() as f64,
            champion_hits,
            no_lookahead_correct_picks: total_no_lookahead_correct,
            no_lookahead_total_games: total_no_lookahead_games,
            no_lookahead_accuracy: ratio(total_no_lookahead_correct, total_no_lookahead_games),
        },
        years,
    })
}

#[derive(Debug)]
struct NoLookaheadBacktestResult {
    correct_picks: usize,
    total_games: usize,
    rounds: Vec<RoundResult>,
}

fn evaluate_no_lookahead_bracket_start(
    season: &HistoricalSeasonData,
    weights: &ModelWeights,
) -> Result<NoLookaheadBacktestResult, ApiError> {
    let mut rounds = BTreeMap::new();
    let mut predicted_region_winners = Vec::with_capacity(REGION_ORDER.len());
    let mut actual_region_winners = Vec::with_capacity(REGION_ORDER.len());

    for region in REGION_ORDER {
        let first_round_games = region_first_round_games(&season.bracket.games, region)?;
        let mut predicted_winners = Vec::with_capacity(first_round_games.len());
        let mut actual_winners = Vec::with_capacity(first_round_games.len());

        for game in first_round_games {
            let predicted = predicted_winner(game, &season.lookup, 0, weights)?;
            let actual = actual_winner_name(game).to_string();
            record_round_pick(&mut rounds, 0, &predicted.name, &actual);
            predicted_winners.push(predicted);
            actual_winners.push(actual);
        }

        for round_index in 1..=3 {
            let round_games = season
                .bracket
                .games
                .iter()
                .filter(|game| game.round_index == round_index && game.region == region)
                .collect::<Vec<_>>();

            let mut next_predicted = Vec::with_capacity(predicted_winners.len() / 2);
            let mut next_actual = Vec::with_capacity(actual_winners.len() / 2);

            for (predicted_pair, actual_pair) in predicted_winners
                .chunks(2)
                .zip(actual_winners.chunks(2))
            {
                if predicted_pair.len() != 2 || actual_pair.len() != 2 {
                    return Err(ApiError::Parse(format!(
                        "Invalid {region} replay pairing in round {} for {}",
                        round_index + 1,
                        season.year
                    )));
                }

                let predicted = predicted_winner_from_teams(
                    &predicted_pair[0],
                    &predicted_pair[1],
                    round_index,
                    weights,
                );
                let actual_game = find_game_by_teams(&round_games, &actual_pair[0], &actual_pair[1])
                    .ok_or_else(|| {
                        ApiError::Parse(format!(
                            "Missing {region} {} game between {} and {} in {}",
                            round_label(round_index),
                            actual_pair[0],
                            actual_pair[1],
                            season.year
                        ))
                    })?;
                let actual = actual_winner_name(actual_game).to_string();
                record_round_pick(&mut rounds, round_index, &predicted.name, &actual);
                next_predicted.push(predicted);
                next_actual.push(actual);
            }

            predicted_winners = next_predicted;
            actual_winners = next_actual;
        }

        let predicted_region_winner = predicted_winners.into_iter().next().ok_or_else(|| {
            ApiError::Parse(format!("Missing predicted regional champion for {region} in {}", season.year))
        })?;
        let actual_region_winner = actual_winners.into_iter().next().ok_or_else(|| {
            ApiError::Parse(format!("Missing actual regional champion for {region} in {}", season.year))
        })?;
        predicted_region_winners.push(predicted_region_winner);
        actual_region_winners.push(actual_region_winner);
    }

    let semifinal_pairs = infer_semifinal_region_pairs(&season.bracket.games, &actual_region_winners)?;
    let semifinal_games = season
        .bracket
        .games
        .iter()
        .filter(|game| game.round_index == 4)
        .collect::<Vec<_>>();
    if semifinal_games.len() != 2 {
        return Err(ApiError::Parse(format!(
            "Expected 2 semifinal games in {}, found {}",
            season.year,
            semifinal_games.len()
        )));
    }

    let mut predicted_semifinal_winners = Vec::with_capacity(semifinal_pairs.len());
    let mut actual_semifinal_winners = Vec::with_capacity(semifinal_pairs.len());
    for (left, right) in semifinal_pairs {
        let predicted_semifinal = predicted_winner_from_teams(
            &predicted_region_winners[left],
            &predicted_region_winners[right],
            4,
            weights,
        );
        let actual_semifinal = find_game_by_teams(
            &semifinal_games,
            &actual_region_winners[left],
            &actual_region_winners[right],
        )
        .ok_or_else(|| {
            ApiError::Parse(format!(
                "Missing semifinal game between {} and {} in {}",
                actual_region_winners[left], actual_region_winners[right], season.year
            ))
        })?;
        let actual_semifinal_winner = actual_winner_name(actual_semifinal).to_string();
        record_round_pick(
            &mut rounds,
            4,
            &predicted_semifinal.name,
            &actual_semifinal_winner,
        );
        predicted_semifinal_winners.push(predicted_semifinal);
        actual_semifinal_winners.push(actual_semifinal_winner);
    }

    let title_games = season
        .bracket
        .games
        .iter()
        .filter(|game| game.round_index == 5)
        .collect::<Vec<_>>();
    if title_games.len() != 1 {
        return Err(ApiError::Parse(format!(
            "Expected 1 title game in {}, found {}",
            season.year,
            title_games.len()
        )));
    }

    let predicted_champion = predicted_winner_from_teams(
        &predicted_semifinal_winners[0],
        &predicted_semifinal_winners[1],
        5,
        weights,
    );
    let actual_title = find_game_by_teams(
        &title_games,
        &actual_semifinal_winners[0],
        &actual_semifinal_winners[1],
    )
    .ok_or_else(|| {
        ApiError::Parse(format!(
            "Missing title game between {} and {} in {}",
            actual_semifinal_winners[0], actual_semifinal_winners[1], season.year
        ))
    })?;
    let actual_champion = actual_winner_name(actual_title).to_string();
    record_round_pick(&mut rounds, 5, &predicted_champion.name, &actual_champion);

    let round_results = rounds
        .into_iter()
        .map(|(round_index, acc)| RoundResult {
            label: round_label(round_index).into(),
            correct: acc.correct,
            total: acc.total,
            accuracy: ratio(acc.correct, acc.total),
        })
        .collect::<Vec<_>>();
    let correct_picks = round_results.iter().map(|round| round.correct).sum::<usize>();
    let total_games = round_results.iter().map(|round| round.total).sum::<usize>();

    Ok(NoLookaheadBacktestResult {
        correct_picks,
        total_games,
        rounds: round_results,
    })
}

fn estimate_pace(team: &PredictionTeam) -> f64 {
    clamp(71.0 - (team.seed as f64 - 8.0) * 0.22, 63.0, 76.0)
}

fn project_score(team_a: &PredictionTeam, team_b: &PredictionTeam) -> ScoreProjection {
    let pace = (estimate_pace(team_a) + estimate_pace(team_b)) / 2.0;
    let team_a_points = pace * ((team_a.adj_o + team_b.adj_d) / 2.0) / 100.0;
    let team_b_points = pace * ((team_b.adj_o + team_a.adj_d) / 2.0) / 100.0;

    ScoreProjection {
        team_a_points,
        team_b_points,
    }
}

fn record_score_metrics(
    accumulator: &mut ScoreMetricAccumulator,
    projection: ScoreProjection,
    actual_team_a: i32,
    actual_team_b: i32,
    winner_correct: bool,
) {
    let actual_team_a = actual_team_a as f64;
    let actual_team_b = actual_team_b as f64;
    let predicted_margin = projection.team_a_points - projection.team_b_points;
    let actual_margin = actual_team_a - actual_team_b;
    let predicted_total = projection.team_a_points + projection.team_b_points;
    let actual_total = actual_team_a + actual_team_b;
    let error_a = projection.team_a_points - actual_team_a;
    let error_b = projection.team_b_points - actual_team_b;
    let margin_error = predicted_margin - actual_margin;
    let total_error = predicted_total - actual_total;

    accumulator.games += 1;
    if winner_correct {
        accumulator.winner_correct += 1;
    }
    accumulator.team_score_abs_sum += error_a.abs() + error_b.abs();
    accumulator.team_score_sq_sum += error_a.powi(2) + error_b.powi(2);
    accumulator.margin_abs_sum += margin_error.abs();
    accumulator.margin_sq_sum += margin_error.powi(2);
    accumulator.total_abs_sum += total_error.abs();
    accumulator.total_sq_sum += total_error.powi(2);
}

fn team_score_mae(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        accumulator.team_score_abs_sum / (accumulator.games as f64 * 2.0)
    }
}

fn team_score_rmse(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        (accumulator.team_score_sq_sum / (accumulator.games as f64 * 2.0)).sqrt()
    }
}

fn margin_mae(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        accumulator.margin_abs_sum / accumulator.games as f64
    }
}

fn margin_rmse(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        (accumulator.margin_sq_sum / accumulator.games as f64).sqrt()
    }
}

fn total_mae(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        accumulator.total_abs_sum / accumulator.games as f64
    }
}

fn total_rmse(accumulator: &ScoreMetricAccumulator) -> f64 {
    if accumulator.games == 0 {
        0.0
    } else {
        (accumulator.total_sq_sum / accumulator.games as f64).sqrt()
    }
}

fn evaluate_historical_score_season(
    season: &HistoricalSeasonData,
    weights: &ModelWeights,
) -> Result<ScoreBacktestYear, ApiError> {
    let mut aggregate = ScoreMetricAccumulator::default();
    let mut rounds = BTreeMap::new();

    for game in &season.bracket.games {
        let (Some(actual_team_a), Some(actual_team_b)) = (game.team_a.score, game.team_b.score) else {
            continue;
        };

        let team_a = season
            .lookup
            .get(&normalize_team_name(&game.team_a.name))
            .ok_or_else(|| {
                ApiError::Parse(format!(
                    "Missing proxy team for {} in {}",
                    game.team_a.name, season.year
                ))
            })?;
        let team_b = season
            .lookup
            .get(&normalize_team_name(&game.team_b.name))
            .ok_or_else(|| {
                ApiError::Parse(format!(
                    "Missing proxy team for {} in {}",
                    game.team_b.name, season.year
                ))
            })?;

        let probability_a = blended_probability(team_a, team_b, game.round_index, weights);
        let winner_correct = if probability_a >= 0.5 {
            game.team_a.won
        } else {
            game.team_b.won
        };
        let projection = project_score(team_a, team_b);

        record_score_metrics(
            &mut aggregate,
            projection,
            actual_team_a,
            actual_team_b,
            winner_correct,
        );

        let round = rounds
            .entry(game.round_index)
            .or_insert_with(ScoreMetricAccumulator::default);
        record_score_metrics(round, projection, actual_team_a, actual_team_b, winner_correct);
    }

    let round_results = rounds
        .into_iter()
        .map(|(round_index, metrics)| ScoreRoundResult {
            label: round_label(round_index).into(),
            games: metrics.games,
            winner_accuracy: ratio(metrics.winner_correct, metrics.games),
            team_score_mae: team_score_mae(&metrics),
            team_score_rmse: team_score_rmse(&metrics),
            margin_mae: margin_mae(&metrics),
            margin_rmse: margin_rmse(&metrics),
            total_mae: total_mae(&metrics),
            total_rmse: total_rmse(&metrics),
        })
        .collect::<Vec<_>>();

    Ok(ScoreBacktestYear {
        year: season.year,
        games_graded: aggregate.games,
        winner_accuracy: ratio(aggregate.winner_correct, aggregate.games),
        team_score_mae: team_score_mae(&aggregate),
        team_score_rmse: team_score_rmse(&aggregate),
        margin_mae: margin_mae(&aggregate),
        margin_rmse: margin_rmse(&aggregate),
        total_mae: total_mae(&aggregate),
        total_rmse: total_rmse(&aggregate),
        rounds: round_results,
    })
}

async fn run_score_backtests(client: &Client, weights: &ModelWeights) -> Result<ScoreBacktestResponse, ApiError> {
    let seasons = load_historical_seasons(client).await?;
    let mut years = Vec::with_capacity(seasons.len());
    let mut games_graded = 0usize;
    let mut winner_correct = 0usize;
    let mut team_score_abs_sum = 0.0;
    let mut team_score_sq_sum = 0.0;
    let mut margin_abs_sum = 0.0;
    let mut margin_sq_sum = 0.0;
    let mut total_abs_sum = 0.0;
    let mut total_sq_sum = 0.0;

    for season in &seasons {
        let year_result = evaluate_historical_score_season(season, &weights)?;
        games_graded += year_result.games_graded;
        winner_correct += year_result
            .winner_accuracy
            .mul_add(year_result.games_graded as f64, 0.0)
            .round() as usize;
        team_score_abs_sum += year_result.team_score_mae * year_result.games_graded as f64 * 2.0;
        team_score_sq_sum += year_result.team_score_rmse.powi(2) * year_result.games_graded as f64 * 2.0;
        margin_abs_sum += year_result.margin_mae * year_result.games_graded as f64;
        margin_sq_sum += year_result.margin_rmse.powi(2) * year_result.games_graded as f64;
        total_abs_sum += year_result.total_mae * year_result.games_graded as f64;
        total_sq_sum += year_result.total_rmse.powi(2) * year_result.games_graded as f64;
        years.push(year_result);
    }

    let aggregate = ScoreMetricAccumulator {
        games: games_graded,
        winner_correct,
        team_score_abs_sum,
        team_score_sq_sum,
        margin_abs_sum,
        margin_sq_sum,
        total_abs_sum,
        total_sq_sum,
    };

    Ok(ScoreBacktestResponse {
        methodology: score_backtest_methodology(),
        caveats: score_backtest_caveats(),
        weights_used: *weights,
        aggregate: ScoreBacktestAggregate {
            years_covered: years.len(),
            games_graded,
            winner_accuracy: ratio(aggregate.winner_correct, aggregate.games),
            team_score_mae: team_score_mae(&aggregate),
            team_score_rmse: team_score_rmse(&aggregate),
            margin_mae: margin_mae(&aggregate),
            margin_rmse: margin_rmse(&aggregate),
            total_mae: total_mae(&aggregate),
            total_rmse: total_rmse(&aggregate),
        },
        years,
    })
}

#[derive(Debug, Clone)]
struct GenomeScore {
    weights: ModelWeights,
    average_accuracy: f64,
    average_brier: f64,
    worst_year_accuracy: f64,
    brier_stddev: f64,
    distance_from_defaults: f64,
    fitness: f64,
}

async fn run_evolution(client: &Client) -> Result<EvolutionResponse, ApiError> {
    run_evolution_with_config(
        client,
        EvolutionRunConfig::legacy_defaults(),
        default_model_weights(),
        |_, _| {},
    )
    .await
}

async fn run_evolution_with_config<F>(
    client: &Client,
    config: EvolutionRunConfig,
    anchor_weights: ModelWeights,
    mut on_progress: F,
) -> Result<EvolutionResponse, ApiError>
where
    F: FnMut(f64, String),
{
    on_progress(0.02, "Loading archived seasons".into());
    let seasons = load_historical_seasons(client).await?;
    let defaults = default_model_weights();
    let mut leaderboard = Vec::new();

    for restart in 0..config.restarts {
        let mut rng = StdRng::seed_from_u64(EVOLUTION_SEED + restart as u64 * 97);
        let phase_start = 0.08 + (restart as f64 / config.restarts as f64) * 0.52;
        let phase_span = 0.52 / config.restarts as f64;
        let mut restart_progress = |generation_completed: usize, generation_total: usize| {
            let generation_ratio = generation_completed as f64 / generation_total.max(1) as f64;
            on_progress(
                phase_start + phase_span * generation_ratio,
                format!(
                    "Evolution restart {}/{} · generation {}/{}",
                    restart + 1,
                    config.restarts,
                    generation_completed,
                    generation_total
                ),
            );
        };
        let board = evolve_population_with_progress(
            &seasons,
            &anchor_weights,
            config.population_size,
            config.generations,
            &mut rng,
            &mut restart_progress,
        )?;
        leaderboard.extend(board.into_iter().take(8));
    }
    leaderboard.sort_by(compare_genome_scores);

    let mut fold_summaries = Vec::with_capacity(seasons.len());
    let mut fold_winners = Vec::with_capacity(seasons.len());
    let mut holdout_accuracy_total = 0.0;
    let mut holdout_brier_total = 0.0;
    let mut current_holdout_accuracy_total = 0.0;
    let mut current_holdout_brier_total = 0.0;
    let mut current_holdout_team_score_mae_total = 0.0;
    let mut current_holdout_margin_mae_total = 0.0;
    let mut current_worst_holdout_accuracy = f64::INFINITY;
    let mut candidate_holdout_team_score_mae_total = 0.0;
    let mut candidate_holdout_margin_mae_total = 0.0;
    let mut candidate_worst_holdout_accuracy = f64::INFINITY;

    for holdout_index in 0..seasons.len() {
        let mut train = Vec::with_capacity(seasons.len().saturating_sub(1));
        for (index, season) in seasons.iter().enumerate() {
            if index != holdout_index {
                train.push(season.clone());
            }
        }

        let holdout = &seasons[holdout_index];
        let mut fold_rng = StdRng::seed_from_u64(EVOLUTION_SEED + holdout.year as u64);
        let fold_board = evolve_population(
            &train,
            &anchor_weights,
            config.population_size.saturating_sub(18).max(24),
            config.generations.saturating_sub(6).max(10),
            &mut fold_rng,
        )?;
        let winner = fold_board
            .first()
            .ok_or_else(|| ApiError::Parse("Evolution fold returned no candidates".into()))?;
        let holdout_result = evaluate_historical_season(holdout, &winner.weights)?;
        let holdout_score_result = evaluate_historical_score_season(holdout, &winner.weights)?;
        let current_holdout_result = evaluate_historical_season(holdout, &anchor_weights)?;
        let current_holdout_score_result =
            evaluate_historical_score_season(holdout, &anchor_weights)?;

        holdout_accuracy_total += holdout_result.no_lookahead_accuracy;
        holdout_brier_total += holdout_result.average_brier;
        candidate_holdout_team_score_mae_total += holdout_score_result.team_score_mae;
        candidate_holdout_margin_mae_total += holdout_score_result.margin_mae;
        candidate_worst_holdout_accuracy =
            candidate_worst_holdout_accuracy.min(holdout_result.no_lookahead_accuracy);
        current_holdout_accuracy_total += current_holdout_result.no_lookahead_accuracy;
        current_holdout_brier_total += current_holdout_result.average_brier;
        current_holdout_team_score_mae_total += current_holdout_score_result.team_score_mae;
        current_holdout_margin_mae_total += current_holdout_score_result.margin_mae;
        current_worst_holdout_accuracy =
            current_worst_holdout_accuracy.min(current_holdout_result.no_lookahead_accuracy);
        fold_winners.push(winner.weights);
        fold_summaries.push(EvolutionFoldSummary {
            holdout_year: holdout.year,
            train_years: train.iter().map(|season| season.year).collect(),
            selected_weights: winner.weights,
            holdout_accuracy: holdout_result.no_lookahead_accuracy,
            holdout_brier: holdout_result.average_brier,
        });
        on_progress(
            0.66 + ((holdout_index + 1) as f64 / seasons.len().max(1) as f64) * 0.26,
            format!("Evolution holdout {}/{}", holdout_index + 1, seasons.len()),
        );
    }

    let median_fold_weights = median_weights(&fold_winners);
    let recommended_weights = shrink_toward_anchor(&anchor_weights, &median_fold_weights, 0.58);
    let evaluated = evaluate_genome(&seasons, &recommended_weights, &anchor_weights)?;
    let season_count = fold_summaries.len().max(1) as f64;
    let current_metrics = ModelPromotionMetrics {
        holdout_average_accuracy: current_holdout_accuracy_total / season_count,
        holdout_average_brier: current_holdout_brier_total / season_count,
        holdout_average_team_score_mae: current_holdout_team_score_mae_total / season_count,
        holdout_average_margin_mae: current_holdout_margin_mae_total / season_count,
        worst_holdout_accuracy: if current_worst_holdout_accuracy.is_finite() {
            current_worst_holdout_accuracy
        } else {
            0.0
        },
    };
    let candidate_metrics = ModelPromotionMetrics {
        holdout_average_accuracy: holdout_accuracy_total / season_count,
        holdout_average_brier: holdout_brier_total / season_count,
        holdout_average_team_score_mae: candidate_holdout_team_score_mae_total / season_count,
        holdout_average_margin_mae: candidate_holdout_margin_mae_total / season_count,
        worst_holdout_accuracy: if candidate_worst_holdout_accuracy.is_finite() {
            candidate_worst_holdout_accuracy
        } else {
            0.0
        },
    };
    let promotion_review =
        build_model_promotion_review(anchor_weights, recommended_weights, &current_metrics, &candidate_metrics);
    on_progress(0.97, "Finalizing evolved weights".into());

    Ok(EvolutionResponse {
        methodology: "The evolution lab now anchors itself to the live weight profile, searches a bounded family of historical calibrations around that profile, and then uses leave-one-year-out folds plus shrinkage back toward the live model before recommending anything for the current season. That lets history refine the forecast without turning one strange March into a full reset.".into(),
        caution: "Archived seasons still use proxy team ratings rather than full archived NCAA stat snapshots, so these learned weights should be treated as conservative meta-guidance, not a fully autonomous retrain. Market blend is intentionally left untouched because historical line snapshots are not yet in the backtest dataset.".into(),
        defaults,
        anchor_weights,
        recommended_weights,
        holdout_average_accuracy: holdout_accuracy_total / fold_summaries.len() as f64,
        holdout_average_brier: holdout_brier_total / fold_summaries.len() as f64,
        evaluated_seasons_accuracy: evaluated.average_accuracy,
        evaluated_seasons_brier: evaluated.average_brier,
        generations: config.generations,
        population_size: config.population_size,
        restarts: config.restarts,
        candidates: leaderboard
            .into_iter()
            .take(5)
            .enumerate()
            .map(|(index, candidate)| EvolutionCandidate {
                rank: index + 1,
                weights: candidate.weights,
                average_accuracy: candidate.average_accuracy,
                average_brier: candidate.average_brier,
                worst_year_accuracy: candidate.worst_year_accuracy,
                brier_stddev: candidate.brier_stddev,
                distance_from_defaults: candidate.distance_from_defaults,
                fitness: candidate.fitness,
            })
            .collect(),
        fold_summaries,
        meta_signals: build_meta_signals(&fold_winners, &anchor_weights, &defaults, &recommended_weights),
        promotion_review,
    })
}

fn evolve_population(
    seasons: &[HistoricalSeasonData],
    anchor: &ModelWeights,
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
) -> Result<Vec<GenomeScore>, ApiError> {
    evolve_population_with_progress(seasons, anchor, population_size, generations, rng, &mut |_, _| {})
}

fn evolve_population_with_progress<F>(
    seasons: &[HistoricalSeasonData],
    anchor: &ModelWeights,
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
    on_generation: &mut F,
) -> Result<Vec<GenomeScore>, ApiError>
where
    F: FnMut(usize, usize),
{
    let defaults = default_model_weights();
    let mut population = initialize_population(population_size, anchor, &defaults, generations, rng);

    for generation in 0..generations {
        let mut scored = population
            .iter()
            .map(|weights| evaluate_genome(seasons, weights, anchor))
            .collect::<Result<Vec<_>, _>>()?;
        scored.sort_by(compare_genome_scores);

        let elite_count = 8usize.min(scored.len());
        let mut next_population = scored
            .iter()
            .take(elite_count)
            .map(|candidate| candidate.weights)
            .collect::<Vec<_>>();

        while next_population.len() < population_size {
            let parent_a = scored[rng.gen_range(0..12.min(scored.len()))].weights;
            let parent_b = scored[rng.gen_range(0..12.min(scored.len()))].weights;
            let crossed = crossover_weights(&parent_a, &parent_b, rng);
            next_population.push(mutate_weights(
                &crossed,
                rng,
                generation,
                generations,
            ));
        }

        population = next_population;
        on_generation(generation + 1, generations);
    }

    let mut scored = population
        .iter()
        .map(|weights| evaluate_genome(seasons, weights, anchor))
        .collect::<Result<Vec<_>, _>>()?;
    scored.sort_by(compare_genome_scores);
    Ok(scored)
}

fn initialize_population(
    population_size: usize,
    anchor: &ModelWeights,
    defaults: &ModelWeights,
    generations: usize,
    rng: &mut StdRng,
) -> Vec<ModelWeights> {
    let mut population = Vec::with_capacity(population_size);
    population.push(*anchor);
    if population_size > 1 && distance_between_weights(anchor, defaults) > 0.001 {
        population.push(*defaults);
    }

    while population.len() < population_size {
        population.push(mutate_weights(anchor, rng, 0, generations));
    }

    population
}

fn mutate_weights(
    base: &ModelWeights,
    rng: &mut StdRng,
    generation: usize,
    generations: usize,
) -> ModelWeights {
    let cooling = 1.0 - (generation as f64 / generations.max(1) as f64);
    let scale = 0.45 + cooling * 0.55;

    clamp_model_weights(ModelWeights {
        efficiency: base.efficiency + rng.gen_range(-5.5..5.5) * scale,
        seed: base.seed + rng.gen_range(-3.0..3.0) * scale,
        four_factors: base.four_factors + rng.gen_range(-4.5..4.5) * scale,
        momentum: base.momentum + rng.gen_range(-3.5..3.5) * scale,
        injuries: base.injuries + rng.gen_range(-3.0..3.0) * scale,
        soft_factors: base.soft_factors + rng.gen_range(-3.5..3.5) * scale,
        uncertainty: base.uncertainty + rng.gen_range(-2.5..2.5) * scale,
    })
}

fn crossover_weights(a: &ModelWeights, b: &ModelWeights, rng: &mut StdRng) -> ModelWeights {
    let mut mix = |left: f64, right: f64| {
        let ratio = rng.gen_range(0.25..0.75);
        left * ratio + right * (1.0 - ratio)
    };

    clamp_model_weights(ModelWeights {
        efficiency: mix(a.efficiency, b.efficiency),
        seed: mix(a.seed, b.seed),
        four_factors: mix(a.four_factors, b.four_factors),
        momentum: mix(a.momentum, b.momentum),
        injuries: mix(a.injuries, b.injuries),
        soft_factors: mix(a.soft_factors, b.soft_factors),
        uncertainty: mix(a.uncertainty, b.uncertainty),
    })
}

fn clamp_model_weights(weights: ModelWeights) -> ModelWeights {
    ModelWeights {
        efficiency: clamp(weights.efficiency, 18.0, 40.0),
        seed: clamp(weights.seed, 2.0, 16.0),
        four_factors: clamp(weights.four_factors, 8.0, 28.0),
        momentum: clamp(weights.momentum, 0.0, 16.0),
        injuries: clamp(weights.injuries, 4.0, 16.0),
        soft_factors: clamp(weights.soft_factors, 4.0, 18.0),
        uncertainty: clamp(weights.uncertainty, 2.0, 14.0),
    }
}

fn evaluate_genome(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    anchor: &ModelWeights,
) -> Result<GenomeScore, ApiError> {
    let defaults = default_model_weights();
    let year_results = seasons
        .iter()
        .map(|season| evaluate_historical_season(season, weights))
        .collect::<Result<Vec<_>, _>>()?;

    let accuracies = year_results
        .iter()
        .map(|result| result.no_lookahead_accuracy)
        .collect::<Vec<_>>();
    let briers = year_results
        .iter()
        .map(|result| result.average_brier)
        .collect::<Vec<_>>();

    let average_accuracy = mean(&accuracies);
    let average_brier = mean(&briers);
    let worst_year_accuracy = accuracies
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    let brier_stddev = stddev(&briers);
    let distance_from_anchor = distance_between_weights(weights, anchor);
    let distance_from_defaults = distance_from_defaults(weights, &defaults);
    let fitness = (-average_brier * 100.0)
        + (average_accuracy * 28.0)
        + (worst_year_accuracy * 8.0)
        - (brier_stddev * 55.0)
        - (distance_from_anchor * 4.5)
        - (distance_from_defaults * 1.5);

    Ok(GenomeScore {
        weights: *weights,
        average_accuracy,
        average_brier,
        worst_year_accuracy,
        brier_stddev,
        distance_from_defaults,
        fitness,
    })
}

fn compare_genome_scores(a: &GenomeScore, b: &GenomeScore) -> Ordering {
    b.fitness
        .partial_cmp(&a.fitness)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            a.average_brier
                .partial_cmp(&b.average_brier)
                .unwrap_or(Ordering::Equal)
        })
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn stddev(values: &[f64]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }

    let average = mean(values);
    let variance = values
        .iter()
        .map(|value| (value - average).powi(2))
        .sum::<f64>()
        / values.len() as f64;
    variance.sqrt()
}

fn distance_from_defaults(weights: &ModelWeights, defaults: &ModelWeights) -> f64 {
    let deltas = [
        (weights.efficiency - defaults.efficiency) / defaults.efficiency,
        (weights.seed - defaults.seed) / defaults.seed.max(1.0),
        (weights.four_factors - defaults.four_factors) / defaults.four_factors,
        (weights.momentum - defaults.momentum) / defaults.momentum.max(1.0),
        (weights.injuries - defaults.injuries) / defaults.injuries,
        (weights.soft_factors - defaults.soft_factors) / defaults.soft_factors,
        (weights.uncertainty - defaults.uncertainty) / defaults.uncertainty,
    ];

    deltas.iter().map(|delta| delta.abs()).sum::<f64>() / deltas.len() as f64
}

fn distance_between_weights(a: &ModelWeights, b: &ModelWeights) -> f64 {
    let deltas = [
        (a.efficiency - b.efficiency) / b.efficiency.max(1.0),
        (a.seed - b.seed) / b.seed.max(1.0),
        (a.four_factors - b.four_factors) / b.four_factors.max(1.0),
        (a.momentum - b.momentum) / b.momentum.max(1.0),
        (a.injuries - b.injuries) / b.injuries.max(1.0),
        (a.soft_factors - b.soft_factors) / b.soft_factors.max(1.0),
        (a.uncertainty - b.uncertainty) / b.uncertainty.max(1.0),
    ];

    deltas.iter().map(|delta| delta.abs()).sum::<f64>() / deltas.len() as f64
}

fn median_weights(weights: &[ModelWeights]) -> ModelWeights {
    ModelWeights {
        efficiency: median_by(weights, |item| item.efficiency),
        seed: median_by(weights, |item| item.seed),
        four_factors: median_by(weights, |item| item.four_factors),
        momentum: median_by(weights, |item| item.momentum),
        injuries: median_by(weights, |item| item.injuries),
        soft_factors: median_by(weights, |item| item.soft_factors),
        uncertainty: median_by(weights, |item| item.uncertainty),
    }
}

fn median_by<F>(weights: &[ModelWeights], accessor: F) -> f64
where
    F: Fn(&ModelWeights) -> f64,
{
    let mut values = weights.iter().map(accessor).collect::<Vec<_>>();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    if values.is_empty() {
        0.0
    } else if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        let upper = values.len() / 2;
        (values[upper - 1] + values[upper]) / 2.0
    }
}

fn shrink_toward_anchor(anchor: &ModelWeights, evolved: &ModelWeights, evolved_share: f64) -> ModelWeights {
    let keep_anchor = 1.0 - evolved_share;
    clamp_model_weights(ModelWeights {
        efficiency: anchor.efficiency * keep_anchor + evolved.efficiency * evolved_share,
        seed: anchor.seed * keep_anchor + evolved.seed * evolved_share,
        four_factors: anchor.four_factors * keep_anchor + evolved.four_factors * evolved_share,
        momentum: anchor.momentum * keep_anchor + evolved.momentum * evolved_share,
        injuries: anchor.injuries * keep_anchor + evolved.injuries * evolved_share,
        soft_factors: anchor.soft_factors * keep_anchor + evolved.soft_factors * evolved_share,
        uncertainty: anchor.uncertainty * keep_anchor + evolved.uncertainty * evolved_share,
    })
}

fn build_meta_signals(
    fold_winners: &[ModelWeights],
    anchor: &ModelWeights,
    defaults: &ModelWeights,
    recommended: &ModelWeights,
) -> Vec<String> {
    let mut signals = vec![
        "Market blend is deliberately excluded from evolution because the archived backtest dataset does not yet include trustworthy historical closing lines.".into(),
        "Recommended weights are shrunk back toward the live profile after fold testing so the forecast learns slowly instead of chasing one hot tournament.".into(),
    ];

    if distance_between_weights(anchor, recommended) > 0.12 {
        signals.push("Historical calibration wanted a meaningful change from the current live profile, but the final recommendation is still range-limited before promotion.".into());
    } else {
        signals.push("Historical calibration only found a small adjustment around the current live profile, which is a good sign that the model is staying stable.".into());
    }

    let axes = [
        ("efficiency", "efficiency", defaults.efficiency, recommended.efficiency),
        ("seed", "seed prior", defaults.seed, recommended.seed),
        (
            "fourFactors",
            "Four Factors",
            defaults.four_factors,
            recommended.four_factors,
        ),
        ("momentum", "recent form", defaults.momentum, recommended.momentum),
        ("injuries", "injury penalty", defaults.injuries, recommended.injuries),
        (
            "softFactors",
            "soft factors",
            defaults.soft_factors,
            recommended.soft_factors,
        ),
        (
            "uncertainty",
            "uncertainty shrinkage",
            defaults.uncertainty,
            recommended.uncertainty,
        ),
    ];

    for (field, label, default_value, recommended_value) in axes {
        let support_up = fold_winners
            .iter()
            .filter(|weights| model_weight_value(weights, field) > default_value + 0.5)
            .count();
        let support_down = fold_winners
            .iter()
            .filter(|weights| model_weight_value(weights, field) < default_value - 0.5)
            .count();
        let delta = recommended_value - default_value;

        if delta.abs() < 0.5 {
            continue;
        }

        if support_up >= 3 || support_down >= 3 {
            let direction = if delta > 0.0 { "leaned heavier" } else { "leaned lighter" };
            let support = support_up.max(support_down);
            signals.push(format!(
                "{} of {} fold winners {} on {} than the default setup, so the recommended profile moves from {:.1} to {:.1}.",
                support,
                fold_winners.len(),
                direction,
                label,
                round1(default_value),
                round1(recommended_value)
            ));
        }
    }

    signals
}

fn build_model_promotion_review(
    current_weights: ModelWeights,
    candidate_weights: ModelWeights,
    current_metrics: &ModelPromotionMetrics,
    candidate_metrics: &ModelPromotionMetrics,
) -> ModelPromotionReview {
    let delta_accuracy =
        candidate_metrics.holdout_average_accuracy - current_metrics.holdout_average_accuracy;
    let delta_brier =
        candidate_metrics.holdout_average_brier - current_metrics.holdout_average_brier;
    let delta_team_score_mae = candidate_metrics.holdout_average_team_score_mae
        - current_metrics.holdout_average_team_score_mae;
    let delta_margin_mae =
        candidate_metrics.holdout_average_margin_mae - current_metrics.holdout_average_margin_mae;

    let mut gate_reasons = Vec::new();
    let mut promote = true;

    if delta_accuracy >= 0.003 {
        gate_reasons.push(format!(
            "Candidate improved holdout no-lookahead accuracy from {:.1}% to {:.1}%.",
            current_metrics.holdout_average_accuracy * 100.0,
            candidate_metrics.holdout_average_accuracy * 100.0
        ));
    } else if delta_accuracy >= -0.001 {
        gate_reasons.push(format!(
            "Candidate stayed within the accuracy tolerance band: {:.1}% vs {:.1}%.",
            candidate_metrics.holdout_average_accuracy * 100.0,
            current_metrics.holdout_average_accuracy * 100.0
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate lost too much holdout accuracy: {:.1}% vs {:.1}%.",
            candidate_metrics.holdout_average_accuracy * 100.0,
            current_metrics.holdout_average_accuracy * 100.0
        ));
        promote = false;
    }

    if delta_brier <= -0.0015 {
        gate_reasons.push(format!(
            "Candidate improved holdout Brier from {:.3} to {:.3}.",
            current_metrics.holdout_average_brier,
            candidate_metrics.holdout_average_brier
        ));
    } else if delta_brier <= 0.0008 {
        gate_reasons.push(format!(
            "Candidate kept Brier within the tolerance band: {:.3} vs {:.3}.",
            candidate_metrics.holdout_average_brier,
            current_metrics.holdout_average_brier
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate worsened holdout Brier too much: {:.3} vs {:.3}.",
            candidate_metrics.holdout_average_brier,
            current_metrics.holdout_average_brier
        ));
        promote = false;
    }

    if delta_team_score_mae <= 0.35 {
        gate_reasons.push(format!(
            "Candidate kept team-score MAE in range: {:.1} vs {:.1}.",
            candidate_metrics.holdout_average_team_score_mae,
            current_metrics.holdout_average_team_score_mae
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate made score calibration too much worse: {:.1} vs {:.1}.",
            candidate_metrics.holdout_average_team_score_mae,
            current_metrics.holdout_average_team_score_mae
        ));
        promote = false;
    }

    if delta_margin_mae <= 0.35 {
        gate_reasons.push(format!(
            "Candidate kept margin MAE in range: {:.1} vs {:.1}.",
            candidate_metrics.holdout_average_margin_mae,
            current_metrics.holdout_average_margin_mae
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate made margin error too much worse: {:.1} vs {:.1}.",
            candidate_metrics.holdout_average_margin_mae,
            current_metrics.holdout_average_margin_mae
        ));
        promote = false;
    }

    if candidate_metrics.worst_holdout_accuracy + 0.015
        >= current_metrics.worst_holdout_accuracy
    {
        gate_reasons.push(format!(
            "Candidate did not materially worsen the worst holdout year: {:.1}% vs {:.1}%.",
            candidate_metrics.worst_holdout_accuracy * 100.0,
            current_metrics.worst_holdout_accuracy * 100.0
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate made the worst holdout year too much worse: {:.1}% vs {:.1}%.",
            candidate_metrics.worst_holdout_accuracy * 100.0,
            current_metrics.worst_holdout_accuracy * 100.0
        ));
        promote = false;
    }

    ModelPromotionReview {
        methodology: "The model promotion gate compares the current live weights to a historically calibrated candidate on one holdout season at a time. It only promotes if the candidate clears accuracy and Brier gates, stays within score-error tolerances, and does not materially worsen the weakest holdout season.".into(),
        caution: "This is still a conservative paper-model gate built on proxy historical team ratings rather than perfect archived stat snapshots, so a pass means 'safe enough to try live' instead of 'guaranteed future improvement.'".into(),
        current_weights,
        candidate_weights,
        current_metrics: current_metrics.clone(),
        candidate_metrics: candidate_metrics.clone(),
        delta_accuracy,
        delta_brier,
        delta_team_score_mae,
        delta_margin_mae,
        promote,
        gate_reasons,
    }
}

fn default_strategy_profile() -> StrategyProfile {
    StrategyProfile {
        min_edge_pct: 2.0,
        kelly_multiplier: 0.35,
        max_stake_pct: 5.0,
        max_open_risk_pct: 15.0,
        min_confidence: 0.55,
        hedge_style: HedgeStyle::None,
    }
}

#[derive(Debug, Clone)]
struct StrategySeasonResult {
    roi: f64,
    log_growth: f64,
    max_drawdown: f64,
    bets_placed: usize,
}

#[derive(Debug, Clone)]
struct StrategyGenomeScore {
    profile: StrategyProfile,
    average_roi: f64,
    average_log_growth: f64,
    worst_year_roi: f64,
    average_drawdown: f64,
    average_bets: f64,
    fitness: f64,
}

#[derive(Debug, Clone)]
struct HistoricalBetCandidate {
    probability: f64,
    confidence: f64,
    edge: f64,
    market_ml: i32,
    opponent_market_ml: i32,
    actual_pick_won: bool,
}

#[derive(Debug, Clone, Copy)]
struct HedgePlan {
    total_outlay: f64,
    if_pick_wins: f64,
    if_hedge_wins: f64,
    max_loss: f64,
}

async fn run_strategy_evolution(client: &Client) -> Result<StrategyEvolutionResponse, ApiError> {
    run_strategy_evolution_with_config(client, StrategyRunConfig::legacy_defaults(), |_, _| {}).await
}

async fn run_strategy_evolution_with_config<F>(
    client: &Client,
    config: StrategyRunConfig,
    mut on_progress: F,
) -> Result<StrategyEvolutionResponse, ApiError>
where
    F: FnMut(f64, String),
{
    on_progress(0.02, "Loading archived seasons".into());
    let seasons = load_historical_seasons(client).await?;
    let weights = default_model_weights();
    let defaults = default_strategy_profile();
    let mut leaderboard = Vec::new();

    for restart in 0..config.restarts {
        let mut rng = StdRng::seed_from_u64(STRATEGY_EVOLUTION_SEED + restart as u64 * 97);
        let phase_start = 0.08 + (restart as f64 / config.restarts as f64) * 0.52;
        let phase_span = 0.52 / config.restarts as f64;
        let mut restart_progress = |generation_completed: usize, generation_total: usize| {
            let generation_ratio = generation_completed as f64 / generation_total.max(1) as f64;
            on_progress(
                phase_start + phase_span * generation_ratio,
                format!(
                    "Strategy restart {}/{} · generation {}/{}",
                    restart + 1,
                    config.restarts,
                    generation_completed,
                    generation_total
                ),
            );
        };
        let board = evolve_strategy_population_with_progress(
            &seasons,
            &weights,
            config.population_size,
            config.generations,
            &mut rng,
            &mut restart_progress,
        )?;
        leaderboard.extend(board.into_iter().take(8));
    }
    leaderboard.sort_by(compare_strategy_scores);

    let mut fold_summaries = Vec::with_capacity(seasons.len());
    let mut fold_winners = Vec::with_capacity(seasons.len());
    let mut holdout_roi_total = 0.0;
    let mut holdout_log_growth_total = 0.0;
    let mut holdout_drawdown_total = 0.0;

    for holdout_index in 0..seasons.len() {
        let mut train = Vec::with_capacity(seasons.len().saturating_sub(1));
        for (index, season) in seasons.iter().enumerate() {
            if index != holdout_index {
                train.push(season.clone());
            }
        }

        let holdout = &seasons[holdout_index];
        let mut fold_rng = StdRng::seed_from_u64(STRATEGY_EVOLUTION_SEED + holdout.year as u64);
        let fold_board = evolve_strategy_population(
            &train,
            &weights,
            config.population_size.saturating_sub(16).max(24),
            config.generations.saturating_sub(6).max(10),
            &mut fold_rng,
        )?;
        let winner = fold_board
            .first()
            .ok_or_else(|| ApiError::Parse("Strategy evolution fold returned no candidates".into()))?;
        let holdout_result = evaluate_strategy_season(holdout, &weights, &winner.profile)?;

        holdout_roi_total += holdout_result.roi;
        holdout_log_growth_total += holdout_result.log_growth;
        holdout_drawdown_total += holdout_result.max_drawdown;
        fold_winners.push(winner.profile);
        fold_summaries.push(StrategyFoldSummary {
            holdout_year: holdout.year,
            train_years: train.iter().map(|season| season.year).collect(),
            selected_profile: winner.profile,
            holdout_roi: holdout_result.roi,
            holdout_log_growth: holdout_result.log_growth,
            holdout_drawdown: holdout_result.max_drawdown,
            holdout_bets: holdout_result.bets_placed,
        });
        on_progress(
            0.66 + ((holdout_index + 1) as f64 / seasons.len().max(1) as f64) * 0.26,
            format!("Strategy holdout {}/{}", holdout_index + 1, seasons.len()),
        );
    }

    let median_profile = median_strategy_profile(&fold_winners);
    let recommended_profile = shrink_strategy_toward_defaults(&defaults, &median_profile, 0.62);
    let evaluated = evaluate_strategy_genome(&seasons, &weights, &recommended_profile)?;
    on_progress(0.97, "Finalizing evolved strategy".into());

    Ok(StrategyEvolutionResponse {
        methodology: "The strategy lab keeps the base model fixed, then evolves bankroll and bet-selection profiles across archived NCAA tournaments. It searches edge thresholds, Kelly scaling, stake caps, open-risk caps, confidence gates, and hedge style, then validates them with leave-one-year-out folds before recommending anything for the live board.".into(),
        caution: "This is a paper-trading optimizer, not a live reinforcement-learning agent. Archived seasons still use proxy market prices from seed lines rather than true historical closing odds, and the confidence gate is a conservative proxy for when to trust thin or noisy bets. Treat it as strategy discipline guidance, not a claim that it discovered an oracle.".into(),
        defaults,
        recommended_profile,
        holdout_average_roi: holdout_roi_total / fold_summaries.len() as f64,
        holdout_average_log_growth: holdout_log_growth_total / fold_summaries.len() as f64,
        holdout_average_drawdown: holdout_drawdown_total / fold_summaries.len() as f64,
        evaluated_seasons_roi: evaluated.average_roi,
        evaluated_seasons_log_growth: evaluated.average_log_growth,
        evaluated_seasons_drawdown: evaluated.average_drawdown,
        generations: config.generations,
        population_size: config.population_size,
        restarts: config.restarts,
        candidates: leaderboard
            .into_iter()
            .take(5)
            .enumerate()
            .map(|(index, candidate)| StrategyCandidate {
                rank: index + 1,
                profile: candidate.profile,
                average_roi: candidate.average_roi,
                average_log_growth: candidate.average_log_growth,
                worst_year_roi: candidate.worst_year_roi,
                average_drawdown: candidate.average_drawdown,
                average_bets: candidate.average_bets,
                fitness: candidate.fitness,
            })
            .collect(),
        fold_summaries,
        meta_signals: build_strategy_meta_signals(&fold_winners, &defaults, &recommended_profile),
    })
}

async fn run_overlay_review(
    client: &Client,
    payload: OverlayReviewRequest,
) -> Result<OverlayReviewResponse, ApiError> {
    let seasons = load_historical_seasons(client).await?;
    let weights = default_model_weights();
    let current_profile = clamp_strategy_profile(payload.current_profile);
    let candidate_profile = clamp_strategy_profile(payload.candidate_profile);
    let current_metrics = evaluate_overlay_profile_holdouts(&seasons, &weights, &current_profile)?;
    let candidate_metrics = evaluate_overlay_profile_holdouts(&seasons, &weights, &candidate_profile)?;
    let delta_roi = candidate_metrics.holdout_average_roi - current_metrics.holdout_average_roi;
    let delta_log_growth =
        candidate_metrics.holdout_average_log_growth - current_metrics.holdout_average_log_growth;
    let delta_drawdown =
        candidate_metrics.holdout_average_drawdown - current_metrics.holdout_average_drawdown;

    let mut gate_reasons = Vec::new();
    let mut promote = true;

    if delta_log_growth > 0.003 {
        gate_reasons.push(format!(
            "Candidate improved average holdout log growth from {:.3} to {:.3}.",
            current_metrics.holdout_average_log_growth,
            candidate_metrics.holdout_average_log_growth
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate did not clear the minimum log-growth lift gate: {:.3} vs {:.3}.",
            candidate_metrics.holdout_average_log_growth,
            current_metrics.holdout_average_log_growth
        ));
        promote = false;
    }

    if delta_roi > 0.01 {
        gate_reasons.push(format!(
            "Candidate improved average holdout ROI from {:.1}% to {:.1}%.",
            current_metrics.holdout_average_roi * 100.0,
            candidate_metrics.holdout_average_roi * 100.0
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate ROI lift was too small to promote safely: {:.1}% vs {:.1}%.",
            candidate_metrics.holdout_average_roi * 100.0,
            current_metrics.holdout_average_roi * 100.0
        ));
        promote = false;
    }

    if delta_drawdown <= 0.015 {
        gate_reasons.push(format!(
            "Candidate kept drawdown within the tolerance band: {:.1}% vs {:.1}%.",
            candidate_metrics.holdout_average_drawdown * 100.0,
            current_metrics.holdout_average_drawdown * 100.0
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate increased average drawdown too much: {:.1}% vs {:.1}%.",
            candidate_metrics.holdout_average_drawdown * 100.0,
            current_metrics.holdout_average_drawdown * 100.0
        ));
        promote = false;
    }

    if candidate_metrics.holdout_average_bets >= 4.0 {
        gate_reasons.push(format!(
            "Candidate kept enough holdout action to be measurable: {:.1} average bets.",
            candidate_metrics.holdout_average_bets
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate traded too little on holdouts to trust the signal: {:.1} average bets.",
            candidate_metrics.holdout_average_bets
        ));
        promote = false;
    }

    if candidate_metrics.worst_year_roi + 0.02 >= current_metrics.worst_year_roi {
        gate_reasons.push(format!(
            "Candidate did not meaningfully worsen the worst holdout year: {:.1}% vs {:.1}%.",
            candidate_metrics.worst_year_roi * 100.0,
            current_metrics.worst_year_roi * 100.0
        ));
    } else {
        gate_reasons.push(format!(
            "Candidate made the worst holdout year materially worse: {:.1}% vs {:.1}%.",
            candidate_metrics.worst_year_roi * 100.0,
            current_metrics.worst_year_roi * 100.0
        ));
        promote = false;
    }

    Ok(OverlayReviewResponse {
        methodology: "The promotion gate replays the current overlay profile and the candidate overlay profile on archived seasons one holdout year at a time. It only allows promotion when the candidate improves holdout growth and ROI, stays within a drawdown tolerance, and still places enough bets to be meaningful.".into(),
        caution: "This still uses proxy historical prices rather than true closing-line archives, so a pass here should be treated as a conservative approval gate for paper trading, not proof that the candidate will beat live markets.".into(),
        current_profile,
        candidate_profile,
        current_metrics,
        candidate_metrics,
        delta_roi,
        delta_log_growth,
        delta_drawdown,
        promote,
        gate_reasons,
    })
}

fn evaluate_overlay_profile_holdouts(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    profile: &StrategyProfile,
) -> Result<OverlayReviewMetrics, ApiError> {
    let mut roi_total = 0.0;
    let mut log_growth_total = 0.0;
    let mut drawdown_total = 0.0;
    let mut bets_total = 0.0;
    let mut worst_year_roi = f64::INFINITY;

    for season in seasons {
        let result = evaluate_strategy_season(season, weights, profile)?;
        roi_total += result.roi;
        log_growth_total += result.log_growth;
        drawdown_total += result.max_drawdown;
        bets_total += result.bets_placed as f64;
        worst_year_roi = worst_year_roi.min(result.roi);
    }

    let season_count = seasons.len().max(1) as f64;
    Ok(OverlayReviewMetrics {
        holdout_average_roi: roi_total / season_count,
        holdout_average_log_growth: log_growth_total / season_count,
        holdout_average_drawdown: drawdown_total / season_count,
        holdout_average_bets: bets_total / season_count,
        worst_year_roi: if worst_year_roi.is_finite() { worst_year_roi } else { 0.0 },
    })
}

fn evolve_strategy_population(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
) -> Result<Vec<StrategyGenomeScore>, ApiError> {
    evolve_strategy_population_with_progress(
        seasons,
        weights,
        population_size,
        generations,
        rng,
        &mut |_, _| {},
    )
}

fn evolve_strategy_population_with_progress<F>(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
    on_generation: &mut F,
) -> Result<Vec<StrategyGenomeScore>, ApiError>
where
    F: FnMut(usize, usize),
{
    let defaults = default_strategy_profile();
    let mut population = initialize_strategy_population(population_size, &defaults, generations, rng);

    for generation in 0..generations {
        let mut scored = population
            .iter()
            .map(|profile| evaluate_strategy_genome(seasons, weights, profile))
            .collect::<Result<Vec<_>, _>>()?;
        scored.sort_by(compare_strategy_scores);

        let elite_count = 8usize.min(scored.len());
        let mut next_population = scored
            .iter()
            .take(elite_count)
            .map(|candidate| candidate.profile)
            .collect::<Vec<_>>();

        while next_population.len() < population_size {
            let parent_a = scored[rng.gen_range(0..12.min(scored.len()))].profile;
            let parent_b = scored[rng.gen_range(0..12.min(scored.len()))].profile;
            let crossed = crossover_strategy_profiles(&parent_a, &parent_b, rng);
            next_population.push(mutate_strategy_profile(&crossed, rng, generation, generations));
        }

        population = next_population;
        on_generation(generation + 1, generations);
    }

    let mut scored = population
        .iter()
        .map(|profile| evaluate_strategy_genome(seasons, weights, profile))
        .collect::<Result<Vec<_>, _>>()?;
    scored.sort_by(compare_strategy_scores);
    Ok(scored)
}

fn initialize_strategy_population(
    population_size: usize,
    defaults: &StrategyProfile,
    generations: usize,
    rng: &mut StdRng,
) -> Vec<StrategyProfile> {
    let mut population = Vec::with_capacity(population_size);
    population.push(*defaults);

    while population.len() < population_size {
        population.push(mutate_strategy_profile(
            defaults,
            rng,
            0,
            generations,
        ));
    }

    population
}

fn mutate_strategy_profile(
    base: &StrategyProfile,
    rng: &mut StdRng,
    generation: usize,
    generations: usize,
) -> StrategyProfile {
    let cooling = 1.0 - (generation as f64 / generations.max(1) as f64);
    let scale = 0.45 + cooling * 0.55;

    let hedge_style = if rng.gen_bool((0.18 + cooling * 0.18).clamp(0.0, 0.55)) {
        match rng.gen_range(0..3) {
            0 => HedgeStyle::None,
            1 => HedgeStyle::EqualResult,
            _ => HedgeStyle::BreakEven,
        }
    } else {
        base.hedge_style
    };

    clamp_strategy_profile(StrategyProfile {
        min_edge_pct: base.min_edge_pct + rng.gen_range(-1.8..1.8) * scale,
        kelly_multiplier: base.kelly_multiplier + rng.gen_range(-0.22..0.22) * scale,
        max_stake_pct: base.max_stake_pct + rng.gen_range(-2.2..2.2) * scale,
        max_open_risk_pct: base.max_open_risk_pct + rng.gen_range(-4.0..4.0) * scale,
        min_confidence: base.min_confidence + rng.gen_range(-0.14..0.14) * scale,
        hedge_style,
    })
}

fn crossover_strategy_profiles(
    a: &StrategyProfile,
    b: &StrategyProfile,
    rng: &mut StdRng,
) -> StrategyProfile {
    let mut mix = |left: f64, right: f64| {
        let ratio = rng.gen_range(0.25..0.75);
        left * ratio + right * (1.0 - ratio)
    };

    clamp_strategy_profile(StrategyProfile {
        min_edge_pct: mix(a.min_edge_pct, b.min_edge_pct),
        kelly_multiplier: mix(a.kelly_multiplier, b.kelly_multiplier),
        max_stake_pct: mix(a.max_stake_pct, b.max_stake_pct),
        max_open_risk_pct: mix(a.max_open_risk_pct, b.max_open_risk_pct),
        min_confidence: mix(a.min_confidence, b.min_confidence),
        hedge_style: if rng.gen_bool(0.5) { a.hedge_style } else { b.hedge_style },
    })
}

fn clamp_strategy_profile(profile: StrategyProfile) -> StrategyProfile {
    StrategyProfile {
        min_edge_pct: clamp(profile.min_edge_pct, 0.0, 8.0),
        kelly_multiplier: clamp(profile.kelly_multiplier, 0.05, 0.9),
        max_stake_pct: clamp(profile.max_stake_pct, 1.0, 12.0),
        max_open_risk_pct: clamp(profile.max_open_risk_pct, 5.0, 30.0),
        min_confidence: clamp(profile.min_confidence, 0.5, 0.9),
        hedge_style: profile.hedge_style,
    }
}

fn evaluate_strategy_genome(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    profile: &StrategyProfile,
) -> Result<StrategyGenomeScore, ApiError> {
    let defaults = default_strategy_profile();
    let results = seasons
        .iter()
        .map(|season| evaluate_strategy_season(season, weights, profile))
        .collect::<Result<Vec<_>, _>>()?;

    let rois = results.iter().map(|result| result.roi).collect::<Vec<_>>();
    let log_growth = results
        .iter()
        .map(|result| result.log_growth)
        .collect::<Vec<_>>();
    let drawdowns = results
        .iter()
        .map(|result| result.max_drawdown)
        .collect::<Vec<_>>();
    let bets = results
        .iter()
        .map(|result| result.bets_placed as f64)
        .collect::<Vec<_>>();

    let average_roi = mean(&rois);
    let average_log_growth = mean(&log_growth);
    let worst_year_roi = rois.iter().copied().fold(f64::INFINITY, f64::min);
    let average_drawdown = mean(&drawdowns);
    let average_bets = mean(&bets);
    let distance = strategy_distance_from_defaults(profile, &defaults);
    let bet_volume_penalty = if average_bets < 6.0 {
        (6.0 - average_bets) * 0.03
    } else {
        0.0
    };
    let fitness = (average_roi * 6.0)
        + (average_log_growth * 18.0)
        + (worst_year_roi * 2.5)
        - (average_drawdown * 9.0)
        - (distance * 1.8)
        - bet_volume_penalty;

    Ok(StrategyGenomeScore {
        profile: *profile,
        average_roi,
        average_log_growth,
        worst_year_roi,
        average_drawdown,
        average_bets,
        fitness,
    })
}

fn evaluate_strategy_season(
    season: &HistoricalSeasonData,
    weights: &ModelWeights,
    profile: &StrategyProfile,
) -> Result<StrategySeasonResult, ApiError> {
    let starting_bankroll: f64 = 1_000.0;
    let mut bankroll: f64 = starting_bankroll;
    let mut peak = bankroll;
    let mut max_drawdown: f64 = 0.0;
    let mut bets_placed = 0usize;

    for round_index in 0..=5 {
        let round_games = season
            .bracket
            .games
            .iter()
            .filter(|game| game.round_index == round_index)
            .collect::<Vec<_>>();
        if round_games.is_empty() {
            continue;
        }

        let mut candidates = Vec::new();
        for game in round_games {
            let team_a = season
                .lookup
                .get(&normalize_team_name(&game.team_a.name))
                .ok_or_else(|| ApiError::Parse(format!("Missing proxy team for {} in {}", game.team_a.name, season.year)))?;
            let team_b = season
                .lookup
                .get(&normalize_team_name(&game.team_b.name))
                .ok_or_else(|| ApiError::Parse(format!("Missing proxy team for {} in {}", game.team_b.name, season.year)))?;
            candidates.extend(build_historical_bet_candidates(
                team_a,
                team_b,
                round_index,
                game.team_a.won,
                weights,
            ));
        }

        candidates.sort_by(|a, b| {
            (b.edge * b.confidence)
                .partial_cmp(&(a.edge * a.confidence))
                .unwrap_or(Ordering::Equal)
        });

        let mut remaining_cash = bankroll.max(0.0);
        let mut remaining_risk = (bankroll.max(0.0) * (profile.max_open_risk_pct / 100.0)).max(0.0);
        let mut round_pnl = 0.0;

        for candidate in candidates {
            let raw_kelly = kelly_fraction(candidate.probability, candidate.market_ml);
            if candidate.edge <= profile.min_edge_pct / 100.0
                || candidate.confidence < profile.min_confidence
                || raw_kelly <= 0.0
                || remaining_cash <= 0.0
                || remaining_risk <= 0.0
            {
                continue;
            }

            let applied_fraction = (raw_kelly * profile.kelly_multiplier)
                .min(profile.max_stake_pct / 100.0);
            let base_stake = round2(remaining_cash * applied_fraction);
            if !base_stake.is_finite() || base_stake < 1.0 {
                continue;
            }

            let plan = build_strategy_hedge_plan(
                base_stake,
                candidate.market_ml,
                candidate.opponent_market_ml,
                profile.hedge_style,
                remaining_cash,
                remaining_risk,
            );

            if plan.total_outlay < 1.0 {
                continue;
            }

            remaining_cash = round2((remaining_cash - plan.total_outlay).max(0.0));
            remaining_risk = round2((remaining_risk - plan.max_loss).max(0.0));
            round_pnl += if candidate.actual_pick_won {
                plan.if_pick_wins
            } else {
                plan.if_hedge_wins
            };
            bets_placed += 1;
        }

        bankroll = round2((bankroll + round_pnl).max(0.0));
        peak = peak.max(bankroll);
        let drawdown = if peak <= 0.0 {
            0.0
        } else {
            (peak - bankroll) / peak
        };
        max_drawdown = max_drawdown.max(drawdown);
    }

    Ok(StrategySeasonResult {
        roi: (bankroll - starting_bankroll) / starting_bankroll,
        log_growth: if bankroll > 0.0 {
            (bankroll / starting_bankroll).ln()
        } else {
            -4.0
        },
        max_drawdown,
        bets_placed,
    })
}

fn build_historical_bet_candidates(
    team_a: &PredictionTeam,
    team_b: &PredictionTeam,
    round_index: usize,
    team_a_won: bool,
    weights: &ModelWeights,
) -> Vec<HistoricalBetCandidate> {
    let probability_a = blended_probability(team_a, team_b, round_index, weights);
    let confidence = strategy_matchup_confidence(team_a, team_b, probability_a, weights);
    let market_ml_a = default_moneyline_by_seed(team_a.seed);
    let market_ml_b = default_moneyline_by_seed(team_b.seed);
    let (market_a, market_b) = no_vig_probabilities(market_ml_a, market_ml_b);

    vec![
        HistoricalBetCandidate {
            probability: probability_a,
            confidence,
            edge: probability_a - market_a,
            market_ml: market_ml_a,
            opponent_market_ml: market_ml_b,
            actual_pick_won: team_a_won,
        },
        HistoricalBetCandidate {
            probability: 1.0 - probability_a,
            confidence,
            edge: (1.0 - probability_a) - market_b,
            market_ml: market_ml_b,
            opponent_market_ml: market_ml_a,
            actual_pick_won: !team_a_won,
        },
    ]
}

fn strategy_matchup_confidence(
    team_a: &PredictionTeam,
    team_b: &PredictionTeam,
    probability_a: f64,
    weights: &ModelWeights,
) -> f64 {
    let volatility = clamp(
        (team_a.injuries
            + team_b.injuries
            + ((team_a.form - team_b.form).abs() / 2.0)
            + ((team_a.experience - team_b.experience).abs() / 4.0))
            / 10.0,
        0.0,
        0.35,
    );
    let uncertainty_pull = (weights.uncertainty / 20.0) * volatility;
    clamp(1.0 - uncertainty_pull + (probability_a - 0.5).abs(), 0.0, 1.0)
}

fn build_strategy_hedge_plan(
    base_stake: f64,
    bet_odds: i32,
    hedge_odds: i32,
    hedge_style: HedgeStyle,
    remaining_cash: f64,
    remaining_risk: f64,
) -> HedgePlan {
    let compute = |primary_stake: f64| {
        let hedge_stake = match hedge_style {
            HedgeStyle::None => 0.0,
            HedgeStyle::EqualResult => equal_profit_hedge_stake(primary_stake, bet_odds, hedge_odds),
            HedgeStyle::BreakEven => break_even_hedge_stake(primary_stake, hedge_odds),
        };
        let if_pick_wins = projected_profit(primary_stake, bet_odds) - hedge_stake;
        let if_hedge_wins = projected_profit(hedge_stake, hedge_odds) - primary_stake;
        let max_loss = if hedge_style == HedgeStyle::None {
            primary_stake
        } else {
            round2((-if_pick_wins).max(-if_hedge_wins).max(0.0))
        };

        HedgePlan {
            total_outlay: round2(primary_stake + hedge_stake.max(0.0)),
            if_pick_wins: round2(if_pick_wins),
            if_hedge_wins: round2(if_hedge_wins),
            max_loss,
        }
    };

    let initial = compute(base_stake);
    let cash_scale = if initial.total_outlay > 0.0 {
        remaining_cash / initial.total_outlay
    } else {
        1.0
    };
    let risk_scale = if initial.max_loss > 0.0 {
        remaining_risk / initial.max_loss
    } else {
        1.0
    };
    let scale = cash_scale.min(risk_scale).clamp(0.0, 1.0);

    if scale >= 0.999 {
        initial
    } else {
        compute(round2(base_stake * scale))
    }
}

fn equal_profit_hedge_stake(stake: f64, bet_odds: i32, hedge_odds: i32) -> f64 {
    let bet_decimal = american_to_decimal(bet_odds);
    let hedge_decimal = american_to_decimal(hedge_odds);
    if bet_decimal <= 0.0 || hedge_decimal <= 0.0 {
        0.0
    } else {
        round2((stake * bet_decimal) / hedge_decimal)
    }
}

fn break_even_hedge_stake(stake: f64, hedge_odds: i32) -> f64 {
    let hedge_decimal = american_to_decimal(hedge_odds);
    if hedge_decimal <= 1.0 {
        0.0
    } else {
        round2(stake / (hedge_decimal - 1.0))
    }
}

fn american_to_implied_probability(odds: i32) -> f64 {
    if odds > 0 {
        100.0 / (odds as f64 + 100.0)
    } else {
        odds.abs() as f64 / (odds.abs() as f64 + 100.0)
    }
}

fn no_vig_probabilities(odds_a: i32, odds_b: i32) -> (f64, f64) {
    let implied_a = american_to_implied_probability(odds_a);
    let implied_b = american_to_implied_probability(odds_b);
    let total = implied_a + implied_b;
    if total <= 0.0 {
        (0.5, 0.5)
    } else {
        (implied_a / total, implied_b / total)
    }
}

fn american_to_decimal(odds: i32) -> f64 {
    if odds > 0 {
        1.0 + (odds as f64 / 100.0)
    } else {
        1.0 + (100.0 / odds.abs() as f64)
    }
}

fn projected_profit(stake: f64, odds: i32) -> f64 {
    if odds > 0 {
        round2(stake * (odds as f64 / 100.0))
    } else {
        round2(stake * (100.0 / odds.abs() as f64))
    }
}

fn kelly_fraction(probability: f64, odds: i32) -> f64 {
    let decimal = american_to_decimal(odds);
    let net_odds = decimal - 1.0;
    let losing_probability = 1.0 - probability;
    if net_odds <= 0.0 {
        0.0
    } else {
        (((net_odds * probability) - losing_probability) / net_odds).max(0.0)
    }
}

fn strategy_distance_from_defaults(
    profile: &StrategyProfile,
    defaults: &StrategyProfile,
) -> f64 {
    let deltas = [
        (profile.min_edge_pct - defaults.min_edge_pct) / defaults.min_edge_pct.max(1.0),
        (profile.kelly_multiplier - defaults.kelly_multiplier) / defaults.kelly_multiplier.max(0.01),
        (profile.max_stake_pct - defaults.max_stake_pct) / defaults.max_stake_pct.max(1.0),
        (profile.max_open_risk_pct - defaults.max_open_risk_pct) / defaults.max_open_risk_pct.max(1.0),
        (profile.min_confidence - defaults.min_confidence) / defaults.min_confidence.max(0.01),
        if profile.hedge_style == defaults.hedge_style { 0.0 } else { 1.0 },
    ];
    deltas.iter().map(|delta| delta.abs()).sum::<f64>() / deltas.len() as f64
}

fn compare_strategy_scores(a: &StrategyGenomeScore, b: &StrategyGenomeScore) -> Ordering {
    b.fitness
        .partial_cmp(&a.fitness)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            b.average_roi
                .partial_cmp(&a.average_roi)
                .unwrap_or(Ordering::Equal)
        })
}

fn median_strategy_profile(profiles: &[StrategyProfile]) -> StrategyProfile {
    let hedge_style = {
        let mut counts = [0usize; 3];
        for profile in profiles {
            match profile.hedge_style {
                HedgeStyle::None => counts[0] += 1,
                HedgeStyle::EqualResult => counts[1] += 1,
                HedgeStyle::BreakEven => counts[2] += 1,
            }
        }
        let winner = counts
            .iter()
            .enumerate()
            .max_by_key(|(_, count)| **count)
            .map(|(index, _)| index)
            .unwrap_or(0);
        match winner {
            1 => HedgeStyle::EqualResult,
            2 => HedgeStyle::BreakEven,
            _ => HedgeStyle::None,
        }
    };

    StrategyProfile {
        min_edge_pct: median_profile_by(profiles, |item| item.min_edge_pct),
        kelly_multiplier: median_profile_by(profiles, |item| item.kelly_multiplier),
        max_stake_pct: median_profile_by(profiles, |item| item.max_stake_pct),
        max_open_risk_pct: median_profile_by(profiles, |item| item.max_open_risk_pct),
        min_confidence: median_profile_by(profiles, |item| item.min_confidence),
        hedge_style,
    }
}

fn median_profile_by<F>(profiles: &[StrategyProfile], accessor: F) -> f64
where
    F: Fn(&StrategyProfile) -> f64,
{
    let mut values = profiles.iter().map(accessor).collect::<Vec<_>>();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    if values.is_empty() {
        0.0
    } else if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        let upper = values.len() / 2;
        (values[upper - 1] + values[upper]) / 2.0
    }
}

fn shrink_strategy_toward_defaults(
    defaults: &StrategyProfile,
    evolved: &StrategyProfile,
    evolved_share: f64,
) -> StrategyProfile {
    let keep_default = 1.0 - evolved_share;
    clamp_strategy_profile(StrategyProfile {
        min_edge_pct: defaults.min_edge_pct * keep_default + evolved.min_edge_pct * evolved_share,
        kelly_multiplier: defaults.kelly_multiplier * keep_default + evolved.kelly_multiplier * evolved_share,
        max_stake_pct: defaults.max_stake_pct * keep_default + evolved.max_stake_pct * evolved_share,
        max_open_risk_pct: defaults.max_open_risk_pct * keep_default + evolved.max_open_risk_pct * evolved_share,
        min_confidence: defaults.min_confidence * keep_default + evolved.min_confidence * evolved_share,
        hedge_style: if evolved_share >= 0.5 { evolved.hedge_style } else { defaults.hedge_style },
    })
}

fn build_strategy_meta_signals(
    _fold_winners: &[StrategyProfile],
    defaults: &StrategyProfile,
    recommended: &StrategyProfile,
) -> Vec<String> {
    let mut signals = vec![
        "The strategy lab keeps the core model fixed and only learns bankroll discipline around it, so model quality and betting aggressiveness do not get conflated.".into(),
        "Confidence gating is a conservative stand-in for when to trust thin, noisy, or low-context edges; it is not a claim that archived seasons contain real-time news confidence labels.".into(),
    ];

    let deltas = [
        ("minimum edge", defaults.min_edge_pct, recommended.min_edge_pct, "%"),
        ("Kelly multiplier", defaults.kelly_multiplier, recommended.kelly_multiplier, "x"),
        ("max stake", defaults.max_stake_pct, recommended.max_stake_pct, "%"),
        ("max open risk", defaults.max_open_risk_pct, recommended.max_open_risk_pct, "%"),
        ("confidence gate", defaults.min_confidence, recommended.min_confidence, ""),
    ];

    for (label, baseline, evolved, suffix) in deltas {
        if (evolved - baseline).abs() < 0.05 {
            continue;
        }
        signals.push(format!(
            "Recommended {} moves from {:.2}{} to {:.2}{} after holdout testing.",
            label,
            baseline,
            suffix,
            evolved,
            suffix
        ));
    }

    if recommended.hedge_style != defaults.hedge_style {
        signals.push(format!(
            "Fold winners preferred a {:?} hedge profile over the default {:?} stance when paper-trading the archived brackets.",
            recommended.hedge_style,
            defaults.hedge_style
        ));
    }

    signals
}

fn model_weight_value(weights: &ModelWeights, field: &str) -> f64 {
    match field {
        "efficiency" => weights.efficiency,
        "seed" => weights.seed,
        "fourFactors" => weights.four_factors,
        "momentum" => weights.momentum,
        "injuries" => weights.injuries,
        "softFactors" => weights.soft_factors,
        "uncertainty" => weights.uncertainty,
        _ => 0.0,
    }
}

async fn fetch_live_context(
    client: &Client,
    payload: LiveContextRequest,
) -> Result<LiveContextResponse, ApiError> {
    let (odds_provider, games) = fetch_live_odds(client, &payload.games).await?;
    let (news_provider, articles, team_signals) = fetch_live_news(client, &payload.news_teams).await?;

    Ok(LiveContextResponse {
        fetched_at: Utc::now().to_rfc3339(),
        odds_provider,
        news_provider,
        games,
        articles,
        team_signals,
    })
}

async fn fetch_tournament_sync(
    client: &Client,
    payload: TournamentSyncRequest,
) -> Result<TournamentSyncResponse, ApiError> {
    if payload.year != 2026 {
        return Err(ApiError::Parse(format!(
            "Only the live 2026 tournament sync is currently supported, received {}",
            payload.year
        )));
    }

    let (source_url, widget_hash) = fetch_championship_widget_details(client, payload.year).await?;
    let extensions = serde_json::json!({
        "persistedQuery": {
            "version": 1,
            "sha256Hash": widget_hash,
        }
    });
    let variables = serde_json::json!({
        "sportUrl": "basketball-men",
        "division": 1,
        "year": payload.year,
    });

    let response = client
        .get("https://sdataprod.ncaa.com/")
        .query(&[
            ("meta", "ScoringWidgetChampionship_ncaa".to_string()),
            (
                "extensions",
                serde_json::to_string(&extensions).map_err(ApiError::Json)?,
            ),
            (
                "variables",
                serde_json::to_string(&variables).map_err(ApiError::Json)?,
            ),
        ])
        .send()
        .await?
        .error_for_status()?;

    let payload_json: NcaaChampionshipWidgetResponse = response.json().await?;
    let mut games = Vec::new();

    for championship in payload_json.data.championships {
        for game in championship.games {
            let Some(round_index) = championship_round_index(game.round.round_number, &game.round.title) else {
                continue;
            };

            if game.teams.len() != 2 {
                continue;
            }

            let team_a_input = &game.teams[0];
            let team_b_input = &game.teams[1];
            let team_a_match = payload
                .teams
                .iter()
                .find(|team| team_names_match(&team_a_input.name_short, &team.name));
            let team_b_match = payload
                .teams
                .iter()
                .find(|team| team_names_match(&team_b_input.name_short, &team.name));

            let (Some(team_a_field), Some(team_b_field)) = (team_a_match, team_b_match) else {
                continue;
            };

            let region = if team_a_field.region == team_b_field.region {
                team_a_field.region.clone()
            } else if round_index == 4 {
                "Final Four".into()
            } else {
                "Championship".into()
            };

            games.push(TournamentFeedGame {
                contest_id: game.contest_id,
                round_index,
                round_label: round_label(round_index).into(),
                region,
                game_state: game.game_state.clone(),
                status_display: game.status_code_display.clone(),
                start_time: build_feed_start_timestamp(game.start_date.as_deref(), game.start_time.as_deref()),
                start_date: game.start_date.clone(),
                game_url: if game.url.starts_with("http") {
                    game.url.clone()
                } else {
                    format!("https://www.ncaa.com{}", game.url)
                },
                team_a: TournamentFeedTeam {
                    name: team_a_field.name.clone(),
                    seed: team_a_input.seed.unwrap_or(team_a_field.seed),
                    score: team_a_input.score,
                    is_winner: team_a_input.is_winner,
                    team_id: Some(team_a_field.id.clone()),
                    region: Some(team_a_field.region.clone()),
                },
                team_b: TournamentFeedTeam {
                    name: team_b_field.name.clone(),
                    seed: team_b_input.seed.unwrap_or(team_b_field.seed),
                    score: team_b_input.score,
                    is_winner: team_b_input.is_winner,
                    team_id: Some(team_b_field.id.clone()),
                    region: Some(team_b_field.region.clone()),
                },
            });
        }
    }

    games.sort_by(|left, right| {
        left.round_index
            .cmp(&right.round_index)
            .then(
                left.start_time
                    .as_deref()
                    .unwrap_or("")
                    .cmp(right.start_time.as_deref().unwrap_or("")),
            )
            .then(left.contest_id.cmp(&right.contest_id))
    });

    let completed_game_count = games.iter().filter(|game| tournament_game_is_final(game)).count();
    let in_progress_game_count = games
        .iter()
        .filter(|game| tournament_game_is_in_progress(game))
        .count();
    let upcoming_game_count = games
        .len()
        .saturating_sub(completed_game_count + in_progress_game_count);

    Ok(TournamentSyncResponse {
        fetched_at: Utc::now().to_rfc3339(),
        source_url,
        message: format!(
            "Matched {} live NCAA tournament games from the championship scoreboard feed. Finals can auto-settle paper bets and completed winners can advance the current bracket.",
            games.len()
        ),
        year: payload.year,
        matched_game_count: games.len(),
        completed_game_count,
        in_progress_game_count,
        upcoming_game_count,
        games,
    })
}

fn build_provider_status() -> ProviderStatusResponse {
    let ai_model = env::var("OPENAI_PREFILL_MODEL").unwrap_or_else(|_| "gpt-5-mini".into());
    let research_team_limit = env::var("OPENAI_RESEARCH_TEAM_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(12);

    ProviderStatusResponse {
        odds_provider: LiveProviderStatus {
            configured: env_var_configured("THE_ODDS_API_KEY"),
            available: env_var_configured("THE_ODDS_API_KEY"),
            message: if env_var_configured("THE_ODDS_API_KEY") {
                "The Odds API key detected. Click sync to pull live college basketball prices.".into()
            } else {
                "Set THE_ODDS_API_KEY to sync live US college basketball moneylines into the board.".into()
            },
            source_url: "https://the-odds-api.com/".into(),
        },
        news_provider: LiveProviderStatus {
            configured: env_var_configured("NEWSAPI_KEY"),
            available: env_var_configured("NEWSAPI_KEY"),
            message: if env_var_configured("NEWSAPI_KEY") {
                "NewsAPI key detected. Click sync to pull recent matchup coverage and derive team signals.".into()
            } else {
                "Set NEWSAPI_KEY to pull recent coverage for the current top betting angles.".into()
            },
            source_url: "https://newsapi.org/docs/endpoints/everything".into(),
        },
        ai_provider: AiProviderStatus {
            configured: env_var_configured("OPENAI_API_KEY"),
            available: env_var_configured("OPENAI_API_KEY"),
            message: if env_var_configured("OPENAI_API_KEY") {
                format!(
                    "OpenAI key detected. Generate researched AI prefills with model {} for up to {} priority teams.",
                    ai_model, research_team_limit
                )
            } else {
                "Set OPENAI_API_KEY to let the app research priority teams and prefill coach, experience, continuity, injuries, and form with source-backed LLM analysis.".into()
            },
            source_url: "https://developers.openai.com/api/reference/responses".into(),
        },
        ai_model,
        research_team_limit,
    }
}

async fn fetch_ai_prefill(
    client: &Client,
    payload: AiPrefillRequest,
) -> Result<AiPrefillResponse, ApiError> {
    let generated_at = Utc::now().to_rfc3339();
    let research_limit = env::var("OPENAI_RESEARCH_TEAM_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, payload.teams.len().max(1)))
        .unwrap_or(12);
    let focus_teams = prioritize_focus_teams(&payload.teams, &payload.focus_team_names, research_limit);

    let Ok(api_key) = env::var("OPENAI_API_KEY") else {
        return Ok(AiPrefillResponse {
            provider: AiProviderStatus {
                configured: false,
                available: false,
                message: "Set OPENAI_API_KEY to let the app research priority teams and prefill coach, experience, continuity, injuries, and form with source-backed LLM analysis.".into(),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: None,
            researched_teams: 0,
            fallback_teams: payload.teams.len(),
            assessments: build_fallback_assessments(&payload.teams, "AI key missing; kept current values."),
        });
    };

    if api_key.trim().is_empty() {
        return Ok(AiPrefillResponse {
            provider: AiProviderStatus {
                configured: false,
                available: false,
                message: "OPENAI_API_KEY is empty, so AI prefill is disabled.".into(),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: None,
            researched_teams: 0,
            fallback_teams: payload.teams.len(),
            assessments: build_fallback_assessments(&payload.teams, "AI key empty; kept current values."),
        });
    }

    let model = env::var("OPENAI_PREFILL_MODEL").unwrap_or_else(|_| "gpt-5-mini".into());
    let mut researched_assessments = Vec::new();
    let mut research_errors = 0usize;

    for team in &focus_teams {
        match research_team_assessment(client, &api_key, &model, team, &payload).await {
            Ok(assessment) => researched_assessments.push(assessment),
            Err(_) => {
                research_errors += 1;
                researched_assessments.push(fallback_assessment(
                    team,
                    "Research request failed for this team; current values retained.",
                ));
            }
        }
    }

    let researched_teams = researched_assessments.iter().filter(|item| item.researched).count();
    let assessments = merge_ai_assessments_with_fallback(payload.teams, researched_assessments);
    let fallback_teams = assessments.len().saturating_sub(researched_teams);

    Ok(AiPrefillResponse {
        provider: AiProviderStatus {
            configured: true,
            available: researched_teams > 0,
            message: if researched_teams > 0 {
                format!(
                    "Researched {researched_teams} priority teams with web search and retained current values for {fallback_teams} others. {} team research calls fell back.",
                    research_errors
                )
            } else {
                "No researched teams were returned, so the app kept the current manual values.".into()
            },
            source_url: "https://developers.openai.com/api/reference/responses".into(),
        },
        generated_at,
        model: Some(model),
        researched_teams,
        fallback_teams,
        assessments,
    })
}

fn fallback_ai_strategy_recommendation(
    payload: &AiStrategyRequest,
    summary: &str,
) -> AiStrategyRecommendation {
    let mut profile = payload
        .feedback_loop
        .candidate_profile
        .or(payload.validation.strategy_recommended_profile)
        .unwrap_or(payload.current_profile);

    if payload.feedback_loop.peak_drawdown > 0.14 || payload.bankroll.open_risk > payload.bankroll.risk_budget_left {
        profile.kelly_multiplier *= 0.82;
        profile.max_stake_pct -= 1.0;
        profile.max_open_risk_pct -= 3.0;
        profile.min_edge_pct += 0.4;
        profile.min_confidence += 0.03;
        profile.hedge_style = HedgeStyle::BreakEven;
    } else if payload.feedback_loop.avg_reward_score.unwrap_or(0.0) > 0.01
        && payload.feedback_loop.positive_clv_rate.unwrap_or(0.0) > 0.53
    {
        profile.kelly_multiplier *= 1.05;
        profile.max_stake_pct += 0.5;
        profile.max_open_risk_pct += 1.0;
    }

    if payload.live_context.signal_count > 0 && payload.live_context.news_configured {
        profile.min_confidence += 0.02;
    }

    let profile = clamp_strategy_profile(profile);
    let auto_refresh_minutes = if payload.current_round.open_matchups > 0 { 5 } else { 10 };
    let auto_sync = payload.live_context.odds_configured || payload.live_context.news_configured;
    let auto_apply_news = payload.live_context.news_configured && payload.live_context.signal_count > 0;
    let live_odds_mode = if payload.live_context.odds_matched_games >= 2 {
        "best"
    } else {
        "consensus"
    };

    let mut reasons = Vec::new();
    reasons.push("Kept the recommendation close to the existing strategy profile because risk settings should move slowly.".into());
    if payload.feedback_loop.peak_drawdown > 0.14 {
        reasons.push("Peak drawdown was elevated, so the fallback tightened Kelly, stake size, and open-risk caps.".into());
    }
    if payload.live_context.signal_count > 0 {
        reasons.push("Recent team-signal noise pushed the fallback toward a slightly higher confidence gate.".into());
    }
    if payload.validation.strategy_recommended_profile.is_some() {
        reasons.push("Used the archived strategy-lab recommendation as a baseline anchor instead of inventing a new posture from scratch.".into());
    }

    AiStrategyRecommendation {
        profile,
        auto_refresh_minutes,
        live_odds_mode: live_odds_mode.into(),
        auto_sync,
        auto_apply_news,
        confidence: 0.42,
        risk_posture: if profile.kelly_multiplier <= 0.25 {
            "conservative".into()
        } else if profile.kelly_multiplier >= 0.45 {
            "aggressive".into()
        } else {
            "balanced".into()
        },
        summary: summary.into(),
        reasons,
        warnings: vec![
            "Fallback mode was used, so this recommendation is heuristic rather than a fresh LLM synthesis.".into(),
            "Starting bankroll is intentionally left to the user instead of being auto-set by the model.".into(),
        ],
    }
}

fn normalize_ai_strategy_recommendation(
    recommendation: AiStrategyRecommendation,
    fallback: &AiStrategyRecommendation,
) -> AiStrategyRecommendation {
    AiStrategyRecommendation {
        profile: clamp_strategy_profile(recommendation.profile),
        auto_refresh_minutes: recommendation.auto_refresh_minutes.clamp(1, 60),
        live_odds_mode: if recommendation.live_odds_mode.eq_ignore_ascii_case("consensus") {
            "consensus".into()
        } else {
            "best".into()
        },
        auto_sync: recommendation.auto_sync,
        auto_apply_news: recommendation.auto_apply_news,
        confidence: round2(clamp(recommendation.confidence, 0.0, 1.0)),
        risk_posture: if recommendation.risk_posture.trim().is_empty() {
            fallback.risk_posture.clone()
        } else {
            recommendation.risk_posture
        },
        summary: if recommendation.summary.trim().is_empty() {
            fallback.summary.clone()
        } else {
            recommendation.summary
        },
        reasons: if recommendation.reasons.is_empty() {
            fallback.reasons.clone()
        } else {
            recommendation.reasons
        },
        warnings: if recommendation.warnings.is_empty() {
            fallback.warnings.clone()
        } else {
            recommendation.warnings
        },
    }
}

async fn fetch_ai_strategy(
    client: &Client,
    payload: AiStrategyRequest,
) -> Result<AiStrategyResponse, ApiError> {
    let generated_at = Utc::now().to_rfc3339();
    let fallback = fallback_ai_strategy_recommendation(
        &payload,
        "Used local bankroll heuristics, strategy-lab anchors, and paper-bet telemetry because AI strategy synthesis was unavailable.",
    );

    let Ok(api_key) = env::var("OPENAI_API_KEY") else {
        return Ok(AiStrategyResponse {
            provider: AiProviderStatus {
                configured: false,
                available: false,
                message: "Set OPENAI_API_KEY to let the app recommend bankroll and hedge settings from live context, research, and historical validation.".into(),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: None,
            fallback_used: true,
            recommendation: fallback,
        });
    };

    if api_key.trim().is_empty() {
        return Ok(AiStrategyResponse {
            provider: AiProviderStatus {
                configured: false,
                available: false,
                message: "OPENAI_API_KEY is empty, so AI betting-strategy recommendations are disabled.".into(),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: None,
            fallback_used: true,
            recommendation: fallback,
        });
    }

    let model = env::var("OPENAI_STRATEGY_MODEL")
        .or_else(|_| env::var("OPENAI_PREFILL_MODEL"))
        .unwrap_or_else(|_| "gpt-5-mini".into());

    let strategy_context = serde_json::json!({
        "currentProfile": payload.current_profile,
        "bankroll": payload.bankroll,
        "currentRound": payload.current_round,
        "liveContext": payload.live_context,
        "topAiAssessments": payload.ai_assessments.into_iter().take(8).collect::<Vec<_>>(),
        "validation": payload.validation,
        "feedbackLoop": payload.feedback_loop
    });

    let system_prompt = "You are a conservative NCAA tournament bankroll and hedge strategist. Recommend only overlay settings such as Kelly scaling, stake caps, open-risk caps, minimum edge, minimum confidence, hedge style, auto-refresh, odds mode, auto-sync, and auto-apply-news. Do not invent the user's bankroll size. Use the supplied validation, score-replay, live context, research, and paper-bet telemetry. Prefer small changes, drawdown control, and no-lookahead discipline. Return valid JSON only.";
    let user_prompt = format!(
        "Recommend betting settings as of {} for this paper-trading system. Stay close to the current profile unless the evidence is strong. Explain the recommendation in plain English and list the main reasons plus cautions.\n\n{}",
        Utc::now().format("%B %-d, %Y"),
        serde_json::to_string_pretty(&strategy_context).map_err(ApiError::Json)?
    );

    let request_body = serde_json::json!({
        "model": model,
        "reasoning": { "effort": "medium" },
        "input": [
            {
                "role": "system",
                "content": [{ "type": "input_text", "text": system_prompt }]
            },
            {
                "role": "user",
                "content": [{ "type": "input_text", "text": user_prompt }]
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "ai_strategy_recommendation",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "recommendation": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "profile": {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "properties": {
                                        "minEdgePct": { "type": "number" },
                                        "kellyMultiplier": { "type": "number" },
                                        "maxStakePct": { "type": "number" },
                                        "maxOpenRiskPct": { "type": "number" },
                                        "minConfidence": { "type": "number" },
                                        "hedgeStyle": { "type": "string", "enum": ["none", "equalResult", "breakEven"] }
                                    },
                                    "required": ["minEdgePct", "kellyMultiplier", "maxStakePct", "maxOpenRiskPct", "minConfidence", "hedgeStyle"]
                                },
                                "autoRefreshMinutes": { "type": "integer" },
                                "liveOddsMode": { "type": "string", "enum": ["best", "consensus"] },
                                "autoSync": { "type": "boolean" },
                                "autoApplyNews": { "type": "boolean" },
                                "confidence": { "type": "number" },
                                "riskPosture": { "type": "string" },
                                "summary": { "type": "string" },
                                "reasons": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                },
                                "warnings": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                }
                            },
                            "required": ["profile", "autoRefreshMinutes", "liveOddsMode", "autoSync", "autoApplyNews", "confidence", "riskPosture", "summary", "reasons", "warnings"]
                        }
                    },
                    "required": ["recommendation"]
                }
            }
        }
    });

    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(AiStrategyResponse {
            provider: AiProviderStatus {
                configured: true,
                available: false,
                message: format!(
                    "AI strategy recommendation failed with status {}, so the app fell back to local heuristics.",
                    response.status()
                ),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: Some(model),
            fallback_used: true,
            recommendation: fallback,
        });
    }

    let response_json: serde_json::Value = response.json().await?;
    let strategy_output = extract_openai_output_text(&response_json)
        .and_then(|raw_text| serde_json::from_str::<AiStrategyModelOutput>(&raw_text).ok());

    let Some(parsed) = strategy_output else {
        return Ok(AiStrategyResponse {
            provider: AiProviderStatus {
                configured: true,
                available: false,
                message: "AI strategy output could not be verified as structured JSON, so the app fell back to local heuristics.".into(),
                source_url: "https://developers.openai.com/api/reference/responses".into(),
            },
            generated_at,
            model: Some(model),
            fallback_used: true,
            recommendation: fallback,
        });
    };

    let normalized = normalize_ai_strategy_recommendation(parsed.recommendation, &fallback);

    Ok(AiStrategyResponse {
        provider: AiProviderStatus {
            configured: true,
            available: true,
            message: "Generated AI bankroll and hedge settings from the current board, validation summaries, and paper-bet telemetry.".into(),
            source_url: "https://developers.openai.com/api/reference/responses".into(),
        },
        generated_at,
        model: Some(model),
        fallback_used: false,
        recommendation: normalized,
    })
}

async fn fetch_live_odds(
    client: &Client,
    games: &[LiveGameRequest],
) -> Result<(LiveProviderStatus, Vec<LiveGameMatch>), ApiError> {
    let empty_games = games.iter().map(empty_live_game_match).collect::<Vec<_>>();
    let Ok(api_key) = env::var("THE_ODDS_API_KEY") else {
        return Ok((
            LiveProviderStatus {
                configured: false,
                available: false,
                message: "Set THE_ODDS_API_KEY to sync live US college basketball moneylines into the board.".into(),
                source_url: "https://the-odds-api.com/".into(),
            },
            empty_games,
        ));
    };

    if api_key.trim().is_empty() {
        return Ok((
            LiveProviderStatus {
                configured: false,
                available: false,
                message: "THE_ODDS_API_KEY is empty, so live odds sync is disabled.".into(),
                source_url: "https://the-odds-api.com/".into(),
            },
            empty_games,
        ));
    }

    let response = client
        .get("https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds")
        .query(&[
            ("regions", "us"),
            ("markets", "h2h"),
            ("oddsFormat", "american"),
            ("apiKey", api_key.as_str()),
        ])
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok((
            LiveProviderStatus {
                configured: true,
                available: false,
                message: format!(
                    "Live odds request failed with status {} from The Odds API.",
                    response.status()
                ),
                source_url: "https://the-odds-api.com/".into(),
            },
            empty_games,
        ));
    }

    let events: Vec<OddsApiEvent> = response.json().await?;
    let mut matched_games = Vec::with_capacity(games.len());
    let mut matched_count = 0usize;

    for game in games {
        if let Some(live_game) = events
            .iter()
            .find_map(|event| build_live_game_match(event, game))
        {
            matched_count += 1;
            matched_games.push(live_game);
        } else {
            matched_games.push(empty_live_game_match(game));
        }
    }

    Ok((
        LiveProviderStatus {
            configured: true,
            available: matched_count > 0,
            message: format!(
                "Matched {matched_count} of {} current bracket games to live US h2h odds.",
                games.len()
            ),
            source_url: "https://the-odds-api.com/".into(),
        },
        matched_games,
    ))
}

async fn fetch_live_news(
    client: &Client,
    news_teams: &[String],
) -> Result<(LiveProviderStatus, Vec<LiveArticle>, Vec<LiveTeamSignal>), ApiError> {
    if news_teams.is_empty() {
        return Ok((
            LiveProviderStatus {
                configured: false,
                available: false,
                message: "No matchup focus was passed to the news engine yet.".into(),
                source_url: "https://newsapi.org/docs/endpoints/everything".into(),
            },
            Vec::new(),
            Vec::new(),
        ));
    }

    let Ok(api_key) = env::var("NEWSAPI_KEY") else {
        return Ok((
            LiveProviderStatus {
                configured: false,
                available: false,
                message: "Set NEWSAPI_KEY to pull recent coverage for the current top betting angles.".into(),
                source_url: "https://newsapi.org/docs/endpoints/everything".into(),
            },
            Vec::new(),
            Vec::new(),
        ));
    };

    if api_key.trim().is_empty() {
        return Ok((
            LiveProviderStatus {
                configured: false,
                available: false,
                message: "NEWSAPI_KEY is empty, so matchup news sync is disabled.".into(),
                source_url: "https://newsapi.org/docs/endpoints/everything".into(),
            },
            Vec::new(),
            Vec::new(),
        ));
    }

    let query = build_news_query(news_teams);
    let from = (Utc::now() - Duration::days(4))
        .format("%Y-%m-%d")
        .to_string();
    let response = client
        .get("https://newsapi.org/v2/everything")
        .query(&[
            ("q", query.as_str()),
            ("language", "en"),
            ("sortBy", "publishedAt"),
            ("pageSize", "8"),
            ("from", from.as_str()),
        ])
        .header("X-Api-Key", api_key)
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok((
            LiveProviderStatus {
                configured: true,
                available: false,
                message: format!(
                    "News request failed with status {} from NewsAPI.",
                    response.status()
                ),
                source_url: "https://newsapi.org/docs/endpoints/everything".into(),
            },
            Vec::new(),
            Vec::new(),
        ));
    }

    let payload: NewsApiResponse = response.json().await?;
    let articles = payload
        .articles
        .into_iter()
        .take(6)
        .map(|article| LiveArticle {
            title: article.title,
            source: article.source.name.unwrap_or_else(|| "Unknown source".into()),
            description: article.description.unwrap_or_default(),
            published_at: article.published_at,
            url: article.url,
            teams: Vec::new(),
            signal: "General context".into(),
            impact_score: 0.0,
        })
        .collect::<Vec<_>>();
    let (articles, team_signals) = analyze_news_context(articles, news_teams);

    let message = if payload.status == "ok" {
        format!(
            "Loaded {} recent articles and {} team context signals for the current recommended teams.",
            articles.len(),
            team_signals.len()
        )
    } else {
        payload
            .message
            .unwrap_or_else(|| "NewsAPI returned an unexpected payload.".into())
    };

    Ok((
        LiveProviderStatus {
            configured: true,
            available: !articles.is_empty(),
            message,
            source_url: "https://newsapi.org/docs/endpoints/everything".into(),
        },
        articles,
        team_signals,
    ))
}

async fn fetch_championship_widget_details(
    client: &Client,
    year: i32,
) -> Result<(String, String), ApiError> {
    let today = Utc::now().date_naive();
    let scoreboard_url = format!(
        "https://www.ncaa.com/scoreboard/basketball-men/d1/{year}/{:02}/{:02}",
        today.month(),
        today.day()
    );
    let html = client
        .get(&scoreboard_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    let document = Html::parse_document(&html);
    let script_selector = selector(r#"script[data-drupal-selector="drupal-settings-json"]"#)?;
    let settings_json = document
        .select(&script_selector)
        .next()
        .map(|script| script.text().collect::<String>())
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| ApiError::Parse("missing NCAA scoreboard settings payload".into()))?;
    let settings: serde_json::Value =
        serde_json::from_str(&settings_json).map_err(ApiError::Json)?;
    let hash = settings
        .pointer("/scoreboardWidget/shas/ScoringWidgetChampionship_ncaa")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ApiError::Parse("missing NCAA championship widget hash".into()))?;

    Ok((scoreboard_url, hash.into()))
}

fn championship_round_index(round_number: i32, title: &str) -> Option<usize> {
    let normalized = title.to_ascii_lowercase();
    if normalized.contains("first four") || round_number <= 1 {
        return None;
    }

    match round_number {
        2 => Some(0),
        3 => Some(1),
        4 => Some(2),
        5 => Some(3),
        6 => Some(4),
        7 => Some(5),
        _ => None,
    }
}

fn build_feed_start_timestamp(start_date: Option<&str>, start_time: Option<&str>) -> Option<String> {
    match (start_date, start_time) {
        (Some(date), Some(time)) if !time.is_empty() => Some(format!("{date} {time}")),
        (Some(date), _) => Some(date.into()),
        _ => None,
    }
}

fn tournament_game_is_final(game: &TournamentFeedGame) -> bool {
    game.game_state.eq_ignore_ascii_case("F") || game.status_display.eq_ignore_ascii_case("final")
}

fn tournament_game_is_in_progress(game: &TournamentFeedGame) -> bool {
    !tournament_game_is_final(game)
        && matches!(
            game.game_state.to_ascii_uppercase().as_str(),
            "I" | "IP" | "L"
        )
}

fn parse_live_field(html: &str) -> Result<Vec<FieldEntry>, ApiError> {
    let document = Html::parse_document(html);
    let region_selector = selector("div.region")?;
    let title_selector = selector("span.subtitle")?;
    let round_selector = selector("div.region-round.round-1")?;
    let pod_selector = selector("a.game-pod")?;
    let team_selector = selector("div.team")?;
    let seed_selector = selector("span.overline")?;
    let body_selector = selector("p.body")?;

    let mut field = Vec::new();

    for region in document.select(&region_selector) {
        let Some(region_name) = region
            .select(&title_selector)
            .next()
            .map(element_text)
            .and_then(|text| canonical_region(&text))
        else {
            continue;
        };

        let Some(round) = region.select(&round_selector).next() else {
            continue;
        };

        for pod in round.select(&pod_selector) {
            for team in pod.select(&team_selector) {
                if team.value().classes().any(|class_name| class_name == "team-empty") {
                    continue;
                }
                let seed = team
                    .select(&seed_selector)
                    .next()
                    .map(element_text)
                    .ok_or_else(|| ApiError::Parse("missing live seed".into()))?
                    .parse::<u8>()
                    .map_err(|_| ApiError::Parse("invalid live seed".into()))?;

                let name = team
                    .select(&body_selector)
                    .map(element_text)
                    .find(|value| !value.is_empty())
                    .ok_or_else(|| ApiError::Parse("missing live team name".into()))?;

                field.push(FieldEntry {
                    region: region_name.clone(),
                    seed,
                    name,
                });
            }
        }
    }

    if field.len() != 64 {
        return Err(ApiError::Parse(format!(
            "Expected 64 main-bracket teams from live NCAA page, found {}",
            field.len()
        )));
    }

    Ok(field)
}

fn parse_archived_bracket(html: &str) -> Result<HistoricalBracket, ApiError> {
    let document = Html::parse_document(html);
    let region_selector = selector("div.region")?;
    let title_selector = selector("h3")?;
    let pod_selector = selector(".game-pod")?;
    let center_selector = selector(".center-final-games")?;
    let mut field = Vec::new();
    let mut games = Vec::new();

    let round_selectors = (1..=4)
        .map(|round| selector(&format!("div.region-round.round-{round}")))
        .collect::<Result<Vec<_>, _>>()?;

    for region in document.select(&region_selector) {
        let Some(region_name) = region
            .select(&title_selector)
            .next()
            .map(element_text)
            .and_then(|text| canonical_region(&text))
        else {
            continue;
        };

        for (round_index, round_selector) in round_selectors.iter().enumerate() {
            let Some(round) = region.select(round_selector).next() else {
                continue;
            };

            for pod in round.select(&pod_selector) {
                let game = parse_archive_game(pod, round_index, &region_name)?;
                if round_index == 0 {
                    field.push(FieldEntry {
                        region: region_name.clone(),
                        seed: game.team_a.seed,
                        name: game.team_a.name.clone(),
                    });
                    field.push(FieldEntry {
                        region: region_name.clone(),
                        seed: game.team_b.seed,
                        name: game.team_b.name.clone(),
                    });
                }
                games.push(game);
            }
        }
    }

    if let Some(center) = document.select(&center_selector).next() {
        for pod in center.select(&pod_selector) {
            let Some(id) = pod.value().attr("id") else {
                continue;
            };
            let round_index = if id.starts_with('6') {
                4
            } else if id.starts_with('7') {
                5
            } else {
                continue;
            };
            games.push(parse_archive_game(pod, round_index, "Final Four")?);
        }
    }

    field.sort_by(|a, b| {
        region_rank(&a.region)
            .cmp(&region_rank(&b.region))
            .then(a.seed.cmp(&b.seed))
            .then(a.name.cmp(&b.name))
    });

    if field.len() != 64 || games.len() < 63 {
        return Err(ApiError::Parse(format!(
            "Expected archived NCAA bracket to expose 64 teams and at least 63 games, found {} teams and {} games",
            field.len(),
            games.len()
        )));
    }

    Ok(HistoricalBracket { field, games })
}

fn parse_archive_game(
    pod: ElementRef<'_>,
    round_index: usize,
    region: &str,
) -> Result<ActualGame, ApiError> {
    let team_selector = selector(".team")?;
    let seed_selector = selector(".seed")?;
    let name_selector = selector(".name")?;
    let score_selector = selector(".score")?;

    let mut teams = pod
        .select(&team_selector)
        .filter_map(|team| {
            let seed = team
                .select(&seed_selector)
                .next()
                .map(element_text)
                .and_then(|value| value.parse::<u8>().ok())?;
            let name = team.select(&name_selector).next().map(element_text)?;
            let score = team
                .select(&score_selector)
                .next()
                .map(element_text)
                .and_then(|value| value.parse::<i32>().ok());
            let won = team.value().classes().any(|class_name| class_name == "winner");

            Some(ActualTeam {
                seed,
                name,
                score,
                won,
            })
        })
        .collect::<Vec<_>>();

    if teams.len() != 2 {
        return Err(ApiError::Parse("archived game missing teams".into()));
    }

    if !teams[0].won && !teams[1].won {
        if let (Some(a), Some(b)) = (teams[0].score, teams[1].score) {
            teams[0].won = a > b;
            teams[1].won = b > a;
        }
    }

    Ok(ActualGame {
        round_index,
        region: region.into(),
        team_a: teams.remove(0),
        team_b: teams.remove(0),
    })
}

fn build_official_team(entry: &FieldEntry, stats: &NcaaTeamStats) -> ModelTeam {
    let overall_efficiency = parse_number(&stats.overall_efficiency);
    let opponent_efficiency = parse_number(&stats.opponent_efficiency);
    let points_per_game = parse_number(&stats.overall_points);
    let pace = if overall_efficiency > 0.0 {
        (points_per_game / overall_efficiency) * 100.0
    } else {
        70.0
    };

    ModelTeam {
        id: format!("{}-{}", entry.region, entry.seed),
        region: entry.region.clone(),
        seed: entry.seed,
        name: entry.name.clone(),
        adj_o: overall_efficiency,
        adj_d: opponent_efficiency,
        efg: parse_percent(&stats.effective_field_goals_pct),
        tov: parse_number(&stats.overall_turnovers_total),
        orb: parse_number(&stats.overall_offensive_rebounds),
        ftr: parse_percent(&stats.overall_free_throws_pct),
        form: parse_unit_scale(&stats.last_ten_games) * 10.0,
        injuries: 0.0,
        coach: 5.0,
        experience: 5.0,
        continuity: 5.0,
        market_ml: default_moneyline_by_seed(entry.seed),
        pace,
        points_per_game,
        net_ranking: stats.netranking,
        win_pct: parse_unit_scale(&stats.overall_winning_pct),
        last_ten_record: stats.last_ten_games_record.clone(),
        source: format!("official-ncaa-{}-{}", stats.team_id, stats.seed),
    }
}

fn build_proxy_team(entry: &FieldEntry) -> PredictionTeam {
    let seed = entry.seed as f64;
    let variance = entry.region.chars().next().unwrap_or('E') as u32 % 5;
    let variance = variance as f64;

    let adj_o = round1(126.0 - seed * 1.35 + variance * 0.35);
    let adj_d = round1(88.0 + seed * 0.95 + (4.0 - variance) * 0.25);
    let efg = round1(58.0 - seed * 0.28 + variance * 0.12);
    let tov = round1(13.0 + seed * 0.24 + (variance - 2.0) * 0.08);
    let orb = round1(35.0 - seed * 0.32 + (2.0 - variance) * 0.18);
    let ftr = round1(38.0 - seed * 0.34 + variance * 0.15);
    let form = round1((9.5 - seed * 0.22).max(4.8) + variance * 0.06);
    let injuries = round1((((seed as i32) % 5) as f64 * 0.18 - 0.1).max(0.0) + (((seed as i32 + variance as i32) % 3) as f64) * 0.1);

    PredictionTeam {
        seed: entry.seed,
        name: entry.name.clone(),
        adj_o,
        adj_d,
        efg,
        tov,
        orb,
        ftr,
        form,
        injuries,
        coach: round1(clamp(8.8 - seed * 0.2 + variance * 0.08, 3.5, 9.8)),
        experience: round1(clamp(8.2 - seed * 0.16 + variance * 0.05, 3.8, 9.6)),
        continuity: round1(clamp(7.8 - seed * 0.14 + (2.0 - variance) * 0.07, 3.5, 9.4)),
    }
}

fn region_first_round_games<'a>(
    games: &'a [ActualGame],
    region: &str,
) -> Result<Vec<&'a ActualGame>, ApiError> {
    let round_games = games
        .iter()
        .filter(|game| game.round_index == 0 && game.region == region)
        .collect::<Vec<_>>();

    if round_games.len() != FIRST_ROUND_SEED_PAIRS.len() {
        return Err(ApiError::Parse(format!(
            "Expected 8 first-round games in {region}, found {}",
            round_games.len()
        )));
    }

    let mut indexed_games = round_games
        .into_iter()
        .map(|game| {
            let game_pair = ordered_seed_pair(game.team_a.seed, game.team_b.seed);
            let slot = FIRST_ROUND_SEED_PAIRS
                .iter()
                .position(|pair| ordered_seed_pair(pair.0, pair.1) == game_pair)
                .ok_or_else(|| {
                    ApiError::Parse(format!(
                        "Unexpected first-round seed pairing {}-{} in {region}",
                        game.team_a.seed, game.team_b.seed
                    ))
                })?;
            Ok((slot, game))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    indexed_games.sort_by_key(|(slot, _)| *slot);
    Ok(indexed_games
        .into_iter()
        .map(|(_, game)| game)
        .collect::<Vec<_>>())
}

fn ordered_seed_pair(seed_a: u8, seed_b: u8) -> (u8, u8) {
    if seed_a <= seed_b {
        (seed_a, seed_b)
    } else {
        (seed_b, seed_a)
    }
}

fn find_game_by_teams<'a>(
    games: &[&'a ActualGame],
    team_a: &str,
    team_b: &str,
) -> Option<&'a ActualGame> {
    games.iter().copied().find(|game| {
        (team_names_equivalent(&game.team_a.name, team_a)
            && team_names_equivalent(&game.team_b.name, team_b))
            || (team_names_equivalent(&game.team_a.name, team_b)
                && team_names_equivalent(&game.team_b.name, team_a))
    })
}

fn record_round_pick(
    rounds: &mut BTreeMap<usize, RoundAccumulator>,
    round_index: usize,
    predicted_winner: &str,
    actual_winner: &str,
) {
    let round = rounds.entry(round_index).or_insert_with(RoundAccumulator::default);
    round.total += 1;
    if team_names_equivalent(predicted_winner, actual_winner) {
        round.correct += 1;
    }
}

fn actual_region_winners(games: &[ActualGame]) -> Result<Vec<String>, ApiError> {
    REGION_ORDER
        .iter()
        .map(|region| {
            games.iter()
                .find(|game| game.round_index == 3 && game.region == *region)
                .map(|game| actual_winner_name(game).to_string())
                .ok_or_else(|| {
                    ApiError::Parse(format!("Missing Elite Eight result for {region}"))
                })
        })
        .collect::<Result<Vec<_>, _>>()
}

fn infer_semifinal_region_pairs(
    games: &[ActualGame],
    actual_region_winners: &[String],
) -> Result<Vec<(usize, usize)>, ApiError> {
    let semifinal_games = games
        .iter()
        .filter(|game| game.round_index == 4)
        .collect::<Vec<_>>();
    if semifinal_games.len() != 2 {
        return Err(ApiError::Parse(format!(
            "Expected 2 semifinal games, found {}",
            semifinal_games.len()
        )));
    }

    let mut pairs = Vec::with_capacity(semifinal_games.len());
    let mut used_regions = [false; REGION_ORDER.len()];

    for game in semifinal_games {
        let regions = actual_region_winners
            .iter()
            .enumerate()
            .filter_map(|(index, winner)| {
                if team_names_equivalent(winner, &game.team_a.name)
                    || team_names_equivalent(winner, &game.team_b.name)
                {
                    Some(index)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        if regions.len() != 2 {
            return Err(ApiError::Parse(format!(
                "Could not infer semifinal region pairing from {} vs {}",
                game.team_a.name, game.team_b.name
            )));
        }

        for region_index in &regions {
            if used_regions[*region_index] {
                return Err(ApiError::Parse(
                    "Historical semifinal region pairings reused the same region twice".into(),
                ));
            }
            used_regions[*region_index] = true;
        }

        pairs.push((regions[0], regions[1]));
    }

    if used_regions.iter().any(|used| !used) {
        return Err(ApiError::Parse(
            "Historical semifinal region pairing inference missed a region".into(),
        ));
    }

    Ok(pairs)
}

fn team_names_equivalent(left: &str, right: &str) -> bool {
    let left_normalized = normalize_team_name(left);
    let right_normalized = normalize_team_name(right);
    if left_normalized == right_normalized {
        return true;
    }

    team_aliases(left)
        .into_iter()
        .map(|alias| normalize_team_name(&alias))
        .any(|alias| alias == right_normalized)
        || team_aliases(right)
            .into_iter()
            .map(|alias| normalize_team_name(&alias))
            .any(|alias| alias == left_normalized)
}

fn predict_bracket_champion(
    games: &[ActualGame],
    lookup: &HashMap<String, PredictionTeam>,
    weights: &ModelWeights,
) -> Result<String, ApiError> {
    let mut region_winners = Vec::new();

    for region in REGION_ORDER {
        let round_games = region_first_round_games(games, region)?;

        let mut winners = round_games
            .iter()
            .map(|game| predicted_winner(game, lookup, 0, weights))
            .collect::<Result<Vec<_>, _>>()?;

        for round_index in 1..=3 {
            let mut next_round = Vec::new();
            for pair in winners.chunks(2) {
                let winner = predicted_winner_from_teams(&pair[0], &pair[1], round_index, weights);
                next_round.push(winner);
            }
            winners = next_round;
        }

        region_winners.push(winners[0].clone());
    }

    let actual_region_winners = actual_region_winners(games)?;
    let semifinal_pairs = infer_semifinal_region_pairs(games, &actual_region_winners)?;
    let semifinal_winners = semifinal_pairs
        .into_iter()
        .map(|(left, right)| {
            predicted_winner_from_teams(&region_winners[left], &region_winners[right], 4, weights)
        })
        .collect::<Vec<_>>();

    Ok(predicted_winner_from_teams(&semifinal_winners[0], &semifinal_winners[1], 5, weights).name)
}

fn predicted_winner(
    game: &ActualGame,
    lookup: &HashMap<String, PredictionTeam>,
    round_index: usize,
    weights: &ModelWeights,
) -> Result<PredictionTeam, ApiError> {
    let team_a = lookup.get(&normalize_team_name(&game.team_a.name)).ok_or_else(|| {
        ApiError::Parse(format!("Missing prediction team {}", game.team_a.name))
    })?;
    let team_b = lookup.get(&normalize_team_name(&game.team_b.name)).ok_or_else(|| {
        ApiError::Parse(format!("Missing prediction team {}", game.team_b.name))
    })?;
    Ok(predicted_winner_from_teams(team_a, team_b, round_index, weights))
}

fn predicted_winner_from_teams(
    team_a: &PredictionTeam,
    team_b: &PredictionTeam,
    round_index: usize,
    weights: &ModelWeights,
) -> PredictionTeam {
    if blended_probability(team_a, team_b, round_index, weights) >= 0.5 {
        team_a.clone()
    } else {
        team_b.clone()
    }
}

fn blended_probability(
    team_a: &PredictionTeam,
    team_b: &PredictionTeam,
    round_index: usize,
    weights: &ModelWeights,
) -> f64 {
    let pure_model = model_probability(team_a, team_b, round_index, weights);
    let seed_prior = seed_prior_probability(team_a, team_b, round_index);
    let volatility = clamp(
        (team_a.injuries
            + team_b.injuries
            + ((team_a.form - team_b.form).abs() / 2.0)
            + ((team_a.experience - team_b.experience).abs() / 4.0))
            / 10.0,
        0.0,
        0.35,
    );
    let uncertainty_pull = (weights.uncertainty / 20.0) * volatility;
    let total_weight = 1.0 + (weights.seed / 12.0);
    let blended = ((pure_model * 1.0) + (seed_prior * (weights.seed / 12.0))) / total_weight;
    clamp(blended * (1.0 - uncertainty_pull) + 0.5 * uncertainty_pull, 0.02, 0.98)
}

fn model_probability(
    team_a: &PredictionTeam,
    team_b: &PredictionTeam,
    round_index: usize,
    weights: &ModelWeights,
) -> f64 {
    let efficiency_gap = (team_a.adj_o - team_a.adj_d) - (team_b.adj_o - team_b.adj_d);
    let four_factor_gap = four_factor_score(team_a) - four_factor_score(team_b);
    let form_gap = team_a.form - team_b.form;
    let injury_gap = team_b.injuries - team_a.injuries;
    let soft_gap = soft_score(team_a) - soft_score(team_b);
    let round_boost = [0.95, 1.0, 1.05, 1.1, 1.12, 1.15]
        .get(round_index)
        .copied()
        .unwrap_or(1.15);

    let latent = (efficiency_gap / 8.5) * (weights.efficiency / 18.0) * round_boost
        + (four_factor_gap / 5.5) * (weights.four_factors / 18.0)
        + (form_gap / 2.8) * (weights.momentum / 10.0)
        + injury_gap * (weights.injuries / 10.0)
        + (soft_gap / 2.2) * (weights.soft_factors / 12.0);

    clamp(sigmoid(latent), 0.03, 0.97)
}

fn four_factor_score(team: &PredictionTeam) -> f64 {
    team.efg * 0.45 + (18.0 - team.tov) * 1.3 + team.orb * 1.15 + team.ftr * 0.08
}

fn soft_score(team: &PredictionTeam) -> f64 {
    team.coach * 0.4 + team.experience * 0.35 + team.continuity * 0.25
}

fn seed_prior_probability(team_a: &PredictionTeam, team_b: &PredictionTeam, round_index: usize) -> f64 {
    let gap = team_b.seed as f64 - team_a.seed as f64;
    let round_multiplier = [1.05, 0.95, 0.8, 0.7, 0.65, 0.6]
        .get(round_index)
        .copied()
        .unwrap_or(0.6);
    clamp(sigmoid(gap * 0.22 * round_multiplier), 0.05, 0.95)
}

fn actual_winner_name(game: &ActualGame) -> &str {
    if game.team_a.won {
        &game.team_a.name
    } else {
        &game.team_b.name
    }
}

fn default_moneyline_by_seed(seed: u8) -> i32 {
    match seed {
        1..=2 => -900 + (seed as i32 - 1) * 220,
        3..=4 => -320 + (seed as i32 - 3) * 90,
        5..=6 => -165 + (seed as i32 - 5) * 35,
        7..=8 => -120 + (seed as i32 - 7) * 20,
        9..=10 => 105 + (seed as i32 - 9) * 25,
        11..=12 => 170 + (seed as i32 - 11) * 40,
        13..=14 => 260 + (seed as i32 - 13) * 60,
        _ => 420 + (seed as i32 - 15) * 100,
    }
}

fn initialize_db(db_path: &PathBuf) -> rusqlite::Result<()> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            saved_at TEXT NOT NULL,
            teams_json TEXT NOT NULL,
            weights_json TEXT NOT NULL,
            portfolio_json TEXT,
            tournament_json TEXT,
            prediction_log_json TEXT
        )",
        [],
    )?;
    ensure_column(&connection, "app_state", "portfolio_json", "TEXT")?;
    ensure_column(&connection, "app_state", "tournament_json", "TEXT")?;
    ensure_column(&connection, "app_state", "prediction_log_json", "TEXT")?;
    ensure_column(&connection, "app_state", "ai_prefill_json", "TEXT")?;
    ensure_column(&connection, "app_state", "optimizer_settings_json", "TEXT")?;
    Ok(())
}

fn load_state_from_db(db_path: &PathBuf) -> Result<Option<StoredState>, ApiError> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "SELECT version, saved_at, teams_json, weights_json, COALESCE(portfolio_json, 'null'), COALESCE(tournament_json, 'null'), COALESCE(prediction_log_json, 'null'), COALESCE(ai_prefill_json, 'null'), COALESCE(optimizer_settings_json, 'null') FROM app_state WHERE id = 1",
    )?;

    let row = statement
        .query_row([], |row| {
            let teams_json: String = row.get(2)?;
            let weights_json: String = row.get(3)?;
            let portfolio_json: String = row.get(4)?;
            let tournament_json: String = row.get(5)?;
            let prediction_log_json: String = row.get(6)?;
            let ai_prefill_json: String = row.get(7)?;
            let optimizer_settings_json: String = row.get(8)?;
            Ok(StoredState {
                version: row.get(0)?,
                saved_at: row.get(1)?,
                teams: serde_json::from_str(&teams_json).map_err(to_sql_error)?,
                weights: serde_json::from_str(&weights_json).map_err(to_sql_error)?,
                portfolio: serde_json::from_str(&portfolio_json).map_err(to_sql_error)?,
                tournament: serde_json::from_str(&tournament_json).map_err(to_sql_error)?,
                prediction_log: serde_json::from_str(&prediction_log_json).map_err(to_sql_error)?,
                ai_prefill: serde_json::from_str(&ai_prefill_json).map_err(to_sql_error)?,
                optimizer_settings: serde_json::from_str(&optimizer_settings_json).map_err(to_sql_error)?,
            })
        })
        .optional()?;

    Ok(row)
}

fn save_state_to_db(db_path: &PathBuf, payload: &StoredState) -> Result<(), ApiError> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO app_state (id, version, saved_at, teams_json, weights_json, portfolio_json, tournament_json, prediction_log_json, ai_prefill_json, optimizer_settings_json)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            version = excluded.version,
            saved_at = excluded.saved_at,
            teams_json = excluded.teams_json,
            weights_json = excluded.weights_json,
            portfolio_json = excluded.portfolio_json,
            tournament_json = excluded.tournament_json,
            prediction_log_json = excluded.prediction_log_json,
            ai_prefill_json = excluded.ai_prefill_json,
            optimizer_settings_json = excluded.optimizer_settings_json",
        params![
            payload.version,
            if payload.saved_at.is_empty() {
                Utc::now().to_rfc3339()
            } else {
                payload.saved_at.clone()
            },
            serde_json::to_string(&payload.teams).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.weights).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.portfolio).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.tournament).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.prediction_log).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.ai_prefill).map_err(ApiError::Json)?,
            serde_json::to_string(&payload.optimizer_settings).map_err(ApiError::Json)?,
        ],
    )?;
    Ok(())
}

fn clear_state_in_db(db_path: &PathBuf) -> Result<(), ApiError> {
    let connection = Connection::open(db_path)?;
    connection.execute("DELETE FROM app_state WHERE id = 1", [])?;
    Ok(())
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    if !columns.iter().any(|existing| existing == column) {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }

    Ok(())
}

fn selector(value: &str) -> Result<Selector, ApiError> {
    Selector::parse(value)
        .map_err(|_| ApiError::Parse(format!("failed to parse selector {value}")))
}

fn element_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .map(str::trim)
        .filter(|chunk| !chunk.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn canonical_region(raw: &str) -> Option<String> {
    let normalized = raw.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "EAST" => Some("East".into()),
        "WEST" => Some("West".into()),
        "SOUTH" => Some("South".into()),
        "MIDWEST" => Some("Midwest".into()),
        _ => None,
    }
}

fn normalize_team_name(name: &str) -> String {
    name.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn team_aliases(name: &str) -> Vec<String> {
    let mut aliases = vec![name.trim().into()];
    if name.contains('/') {
        aliases.extend(
            name.split('/')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    if let Some(expanded) = expand_team_alias(name) {
        aliases.push(expanded.into());
    }

    if name.contains("Saint") {
        aliases.push(name.replace("Saint", "St."));
        aliases.push(name.replace("Saint", "St"));
    }
    if name.contains("St.") {
        aliases.push(name.replace("St.", "Saint"));
    }
    if name.contains("St ") {
        aliases.push(name.replace("St ", "Saint "));
    }

    aliases.sort();
    aliases.dedup();
    aliases
}

fn expand_team_alias(name: &str) -> Option<&'static str> {
    match name.trim() {
        "UConn" => Some("Connecticut"),
        "BYU" => Some("Brigham Young"),
        "VCU" => Some("Virginia Commonwealth"),
        "SMU" => Some("Southern Methodist"),
        "TCU" => Some("Texas Christian"),
        "UCF" => Some("Central Florida"),
        "UAB" => Some("Alabama Birmingham"),
        "USC" => Some("Southern California"),
        "Ole Miss" => Some("Mississippi"),
        "App State" => Some("Appalachian State"),
        "FAU" => Some("Florida Atlantic"),
        "Pitt" => Some("Pittsburgh"),
        "Saint Mary's" => Some("Saint Marys"),
        _ => None,
    }
}

fn name_tokens(name: &str) -> Vec<String> {
    name.split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

fn team_names_match(feed_name: &str, bracket_name: &str) -> bool {
    let feed_normalized = normalize_team_name(feed_name);
    let feed_tokens = name_tokens(feed_name);
    team_aliases(bracket_name).into_iter().any(|alias| {
        let alias_normalized = normalize_team_name(&alias);
        if feed_normalized == alias_normalized {
            return true;
        }

        let alias_tokens = name_tokens(&alias);
        alias_tokens.len() >= 2
            && alias_tokens
                .iter()
                .all(|token| feed_tokens.iter().any(|candidate| candidate == token))
    })
}

fn empty_live_game_match(game: &LiveGameRequest) -> LiveGameMatch {
    LiveGameMatch {
        region: game.region.clone(),
        team_a: game.team_a.clone(),
        team_b: game.team_b.clone(),
        matched: false,
        commence_time: None,
        book_count: 0,
        best_team_a_ml: None,
        best_team_b_ml: None,
        consensus_team_a_ml: None,
        consensus_team_b_ml: None,
    }
}

fn build_live_game_match(event: &OddsApiEvent, game: &LiveGameRequest) -> Option<LiveGameMatch> {
    let event_maps_direct =
        team_names_match(&event.home_team, &game.team_a) && team_names_match(&event.away_team, &game.team_b);
    let event_maps_swapped =
        team_names_match(&event.home_team, &game.team_b) && team_names_match(&event.away_team, &game.team_a);

    if !event_maps_direct && !event_maps_swapped {
        return None;
    }

    let team_a_is_home = event_maps_direct;
    let mut team_a_prices = Vec::new();
    let mut team_b_prices = Vec::new();

    for bookmaker in &event.bookmakers {
        if let Some((home_price, away_price)) = extract_h2h_prices(bookmaker, event) {
            let (team_a_price, team_b_price) = if team_a_is_home {
                (home_price, away_price)
            } else {
                (away_price, home_price)
            };

            if let Some(price) = team_a_price {
                team_a_prices.push(price);
            }
            if let Some(price) = team_b_price {
                team_b_prices.push(price);
            }
        }
    }

    Some(LiveGameMatch {
        region: game.region.clone(),
        team_a: game.team_a.clone(),
        team_b: game.team_b.clone(),
        matched: !team_a_prices.is_empty() && !team_b_prices.is_empty(),
        commence_time: event.commence_time.clone(),
        book_count: team_a_prices.len().min(team_b_prices.len()),
        best_team_a_ml: best_bettor_price(&team_a_prices),
        best_team_b_ml: best_bettor_price(&team_b_prices),
        consensus_team_a_ml: median_price(&team_a_prices),
        consensus_team_b_ml: median_price(&team_b_prices),
    })
}

fn extract_h2h_prices(
    bookmaker: &OddsApiBookmaker,
    event: &OddsApiEvent,
) -> Option<(Option<i32>, Option<i32>)> {
    let market = bookmaker.markets.iter().find(|market| market.key == "h2h")?;
    let home_price = market
        .outcomes
        .iter()
        .find(|outcome| team_names_match(&outcome.name, &event.home_team))
        .and_then(|outcome| outcome.price);
    let away_price = market
        .outcomes
        .iter()
        .find(|outcome| team_names_match(&outcome.name, &event.away_team))
        .and_then(|outcome| outcome.price);
    Some((home_price, away_price))
}

fn best_bettor_price(prices: &[i32]) -> Option<i32> {
    prices
        .iter()
        .copied()
        .max_by(|left, right| american_payout_factor(*left).total_cmp(&american_payout_factor(*right)))
}

fn median_price(prices: &[i32]) -> Option<i32> {
    if prices.is_empty() {
        return None;
    }

    let mut sorted = prices.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

fn american_payout_factor(odds: i32) -> f64 {
    if odds > 0 {
        odds as f64 / 100.0
    } else {
        100.0 / odds.abs() as f64
    }
}

fn build_news_query(news_teams: &[String]) -> String {
    let team_clause = news_teams
        .iter()
        .take(4)
        .map(|team| format!("\"{team}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("({team_clause}) AND (NCAA OR \"March Madness\" OR basketball)")
}

fn env_var_configured(key: &str) -> bool {
    env::var(key)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn extract_openai_output_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload.get("output_text").and_then(serde_json::Value::as_str) {
        return Some(text.into());
    }

    payload
        .get("output")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.get("content")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|content| {
                        content.iter().find_map(|part| {
                            part.get("text")
                                .and_then(serde_json::Value::as_str)
                                .map(ToOwned::to_owned)
                                .or_else(|| {
                                    part.get("text")
                                        .and_then(|text| text.get("value"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(ToOwned::to_owned)
                                })
                        })
                    })
            })
        })
}

async fn research_team_assessment(
    client: &Client,
    api_key: &str,
    model: &str,
    team: &AiPrefillTeamInput,
    payload: &AiPrefillRequest,
) -> Result<AiTeamAssessment, ApiError> {
    let relevant_signals = payload
        .team_signals
        .iter()
        .filter(|signal| signal.team_name == team.name)
        .take(3)
        .cloned()
        .collect::<Vec<_>>();
    let relevant_articles = payload
        .articles
        .iter()
        .filter(|article| article.teams.iter().any(|candidate| candidate == &team.name))
        .take(3)
        .cloned()
        .collect::<Vec<_>>();

    let team_context = serde_json::json!({
        "name": team.name,
        "region": team.region,
        "seed": team.seed,
        "currentValues": {
            "coach": team.coach,
            "experience": team.experience,
            "continuity": team.continuity,
            "injuries": team.injuries,
            "form": team.form
        },
        "stats": {
            "adjO": team.adj_o,
            "adjD": team.adj_d,
            "efg": team.efg,
            "tov": team.tov,
            "orb": team.orb,
            "ftr": team.ftr,
            "marketMl": team.market_ml,
            "netRanking": team.net_ranking,
            "winPct": team.win_pct,
            "lastTenRecord": team.last_ten_record,
            "pointsPerGame": team.points_per_game,
            "pace": team.pace
        },
        "liveSignals": relevant_signals,
        "recentArticles": relevant_articles
    });

    let system_prompt = "You are an NCAA tournament betting research analyst. Use web search plus supplied team context to produce conservative 0-10 ratings for coach, experience, continuity, injuries, and form. Higher coach, experience, continuity, and form is better. Higher injuries means more concern. Prefer recent, credible reporting. Keep ratings close to supplied current values unless evidence supports a change. Return valid JSON only.";
    let user_prompt = format!(
        "Research this team as of {} and return a conservative betting-model prefill. Include 2-4 source-backed notes and 2-4 source links when available. If evidence is sparse, set researched=false and stay near the current values.\n\n{}",
        Utc::now().format("%B %-d, %Y"),
        serde_json::to_string_pretty(&team_context).map_err(ApiError::Json)?
    );

    let request_body = serde_json::json!({
        "model": model,
        "reasoning": { "effort": "low" },
        "tools": [{ "type": "web_search" }],
        "include": ["web_search_call.action.sources"],
        "input": [
            {
                "role": "system",
                "content": [{ "type": "input_text", "text": system_prompt }]
            },
            {
                "role": "user",
                "content": [{ "type": "input_text", "text": user_prompt }]
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "team_research_prefill",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "assessments": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "teamName": { "type": "string" },
                                    "coach": { "type": "number" },
                                    "experience": { "type": "number" },
                                    "continuity": { "type": "number" },
                                    "injuries": { "type": "number" },
                                    "form": { "type": "number" },
                                    "confidence": { "type": "number" },
                                    "researched": { "type": "boolean" },
                                    "summary": { "type": "string" },
                                    "sourceSignals": {
                                        "type": "array",
                                        "items": { "type": "string" }
                                    },
                                    "sources": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "additionalProperties": false,
                                            "properties": {
                                                "title": { "type": "string" },
                                                "url": { "type": "string" },
                                                "publisher": { "type": "string" },
                                                "note": { "type": "string" }
                                            },
                                            "required": ["title", "url", "publisher", "note"]
                                        }
                                    }
                                },
                                "required": ["teamName", "coach", "experience", "continuity", "injuries", "form", "confidence", "researched", "summary", "sourceSignals", "sources"]
                            }
                        }
                    },
                    "required": ["assessments"]
                }
            }
        }
    });

    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(ApiError::Parse(format!(
            "OpenAI team research failed for {} with status {}",
            team.name,
            response.status()
        )));
    }

    let response_json: serde_json::Value = response.json().await?;
    let raw_text = extract_openai_output_text(&response_json)
        .ok_or_else(|| ApiError::Parse(format!("OpenAI response did not include output text for {}", team.name)))?;
    let parsed: AiPrefillModelOutput = serde_json::from_str(&raw_text).map_err(ApiError::Json)?;
    let mut assessment = parsed
        .assessments
        .into_iter()
        .next()
        .unwrap_or_else(|| fallback_assessment(team, "Research returned no assessment; current values retained."));

    let verified_urls = collect_urls_from_value(&response_json);
    if !verified_urls.is_empty() {
        assessment.sources = assessment
            .sources
            .into_iter()
            .filter(|source| verified_urls.contains(&source.url))
            .collect();
    }

    if assessment.sources.is_empty() {
        assessment.researched = false;
        assessment.summary = format!(
            "{} Source verification was thin, so the app kept this suggestion in conservative mode.",
            assessment.summary
        );
    }

    Ok(AiTeamAssessment {
        team_name: team.name.clone(),
        coach: round1(clamp(assessment.coach, 0.0, 10.0)),
        experience: round1(clamp(assessment.experience, 0.0, 10.0)),
        continuity: round1(clamp(assessment.continuity, 0.0, 10.0)),
        injuries: round1(clamp(assessment.injuries, 0.0, 10.0)),
        form: round1(clamp(assessment.form, 0.0, 10.0)),
        confidence: round2(clamp(assessment.confidence, 0.0, 1.0)),
        researched: assessment.researched,
        summary: assessment.summary,
        source_signals: assessment.source_signals,
        sources: assessment.sources,
    })
}

fn prioritize_focus_teams(
    teams: &[AiPrefillTeamInput],
    focus_team_names: &[String],
    limit: usize,
) -> Vec<AiPrefillTeamInput> {
    let mut prioritized = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for focus in focus_team_names {
        let normalized = normalize_team_name(focus);
        if let Some(team) = teams
            .iter()
            .find(|candidate| normalize_team_name(&candidate.name) == normalized)
        {
            if seen.insert(normalized) {
                prioritized.push(team.clone());
            }
        }
    }

    if prioritized.len() < limit {
        let mut remaining = teams.to_vec();
        remaining.sort_by(|a, b| {
            a.seed
                .cmp(&b.seed)
                .then(a.net_ranking.unwrap_or(i32::MAX).cmp(&b.net_ranking.unwrap_or(i32::MAX)))
                .then(
                    (b.adj_o - b.adj_d)
                        .total_cmp(&(a.adj_o - a.adj_d)),
                )
                .then(a.name.cmp(&b.name))
        });

        for team in remaining {
            let normalized = normalize_team_name(&team.name);
            if seen.insert(normalized) {
                prioritized.push(team);
            }
            if prioritized.len() >= limit {
                break;
            }
        }
    }

    prioritized.truncate(limit);
    prioritized
}

fn collect_urls_from_value(value: &serde_json::Value) -> std::collections::HashSet<String> {
    let mut urls = std::collections::HashSet::new();
    collect_urls_recursive(value, &mut urls);
    urls
}

fn collect_urls_recursive(
    value: &serde_json::Value,
    urls: &mut std::collections::HashSet<String>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, nested) in map {
                if (key == "url" || key == "uri" || key == "source_url")
                    && nested.as_str().is_some()
                {
                    urls.insert(nested.as_str().unwrap_or_default().to_string());
                }
                collect_urls_recursive(nested, urls);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_urls_recursive(item, urls);
            }
        }
        _ => {}
    }
}

fn build_fallback_assessments(
    teams: &[AiPrefillTeamInput],
    summary: &str,
) -> Vec<AiTeamAssessment> {
    teams.iter().map(|team| fallback_assessment(team, summary)).collect()
}

fn fallback_assessment(team: &AiPrefillTeamInput, summary: &str) -> AiTeamAssessment {
    AiTeamAssessment {
        team_name: team.name.clone(),
        coach: round1(clamp(team.coach, 0.0, 10.0)),
        experience: round1(clamp(team.experience, 0.0, 10.0)),
        continuity: round1(clamp(team.continuity, 0.0, 10.0)),
        injuries: round1(clamp(team.injuries, 0.0, 10.0)),
        form: round1(clamp(team.form, 0.0, 10.0)),
        confidence: 0.1,
        researched: false,
        summary: summary.into(),
        source_signals: vec!["Current manual values retained.".into()],
        sources: Vec::new(),
    }
}

fn merge_ai_assessments_with_fallback(
    teams: Vec<AiPrefillTeamInput>,
    generated: Vec<AiTeamAssessment>,
) -> Vec<AiTeamAssessment> {
    let mut generated_by_name = generated
        .into_iter()
        .map(|assessment| (normalize_team_name(&assessment.team_name), assessment))
        .collect::<HashMap<_, _>>();

    teams.into_iter()
        .map(|team| {
            let key = normalize_team_name(&team.name);
            let Some(assessment) = generated_by_name.remove(&key) else {
                return fallback_assessment(&team, "AI omitted this team; current values retained.");
            };

            AiTeamAssessment {
                team_name: team.name.clone(),
                coach: round1(clamp(assessment.coach, 0.0, 10.0)),
                experience: round1(clamp(assessment.experience, 0.0, 10.0)),
                continuity: round1(clamp(assessment.continuity, 0.0, 10.0)),
                injuries: round1(clamp(assessment.injuries, 0.0, 10.0)),
                form: round1(clamp(assessment.form, 0.0, 10.0)),
                confidence: round2(clamp(assessment.confidence, 0.0, 1.0)),
                researched: assessment.researched,
                summary: assessment.summary,
                source_signals: if assessment.source_signals.is_empty() {
                    vec!["No source signals returned by the model.".into()]
                } else {
                    assessment.source_signals
                },
                sources: assessment.sources,
            }
        })
        .collect()
}

fn analyze_news_context(
    mut articles: Vec<LiveArticle>,
    news_teams: &[String],
) -> (Vec<LiveArticle>, Vec<LiveTeamSignal>) {
    let mut signal_map: HashMap<String, TeamSignalAccumulator> = HashMap::new();

    for article in &mut articles {
        let combined_text = format!("{} {}", article.title, article.description);
        let teams = match_article_teams(&combined_text, news_teams);
        let (signal, impact_score, injury_mentions, positive_mentions) =
            classify_article_signal(&combined_text);

        article.teams = teams.clone();
        article.signal = signal.into();
        article.impact_score = round2(impact_score);

        for team in teams {
            let entry = signal_map.entry(team).or_default();
            entry.article_count += 1;
            entry.injury_mentions += injury_mentions;
            entry.positive_mentions += positive_mentions;
            entry.net_injury_score += impact_score.max(0.0);

            if entry
                .latest_article_published_at
                .as_ref()
                .map(|latest| latest < &article.published_at)
                .unwrap_or(true)
            {
                entry.latest_article_published_at = Some(article.published_at.clone());
            }
        }
    }

    let mut team_signals = signal_map
        .into_iter()
        .map(|(team_name, acc)| {
            let suggested_injuries = round1(clamp(acc.net_injury_score * 1.35, 0.0, 5.0));
            let confidence = round2(clamp(
                (acc.article_count as f64 * 0.22)
                    + ((acc.injury_mentions + acc.positive_mentions) as f64 * 0.08),
                0.15,
                1.0,
            ));
            let summary = if suggested_injuries >= 0.7 {
                format!(
                    "{} recent articles, {} injury flags, suggested injury score {} / 10.",
                    acc.article_count, acc.injury_mentions, suggested_injuries
                )
            } else if acc.positive_mentions > 0 {
                format!(
                    "{} recent articles, {} positive return/availability mentions, little injury concern.",
                    acc.article_count, acc.positive_mentions
                )
            } else {
                format!(
                    "{} recent articles, but the signal is mostly general context rather than a clear injury edge.",
                    acc.article_count
                )
            };

            LiveTeamSignal {
                team_name,
                article_count: acc.article_count,
                injury_mentions: acc.injury_mentions,
                positive_mentions: acc.positive_mentions,
                suggested_injuries,
                confidence,
                summary,
                latest_article_published_at: acc.latest_article_published_at,
            }
        })
        .collect::<Vec<_>>();

    team_signals.sort_by(|a, b| {
        b.suggested_injuries
            .total_cmp(&a.suggested_injuries)
            .then(b.confidence.total_cmp(&a.confidence))
            .then(a.team_name.cmp(&b.team_name))
    });

    (articles, team_signals)
}

fn match_article_teams(text: &str, news_teams: &[String]) -> Vec<String> {
    let article_tokens = name_tokens(text);
    let article_normalized = normalize_team_name(text);
    let mut matches = Vec::new();

    for team in news_teams {
        let matched = team_aliases(team).into_iter().any(|alias| {
            let alias_tokens = name_tokens(&alias)
                .into_iter()
                .filter(|token| token.len() > 1)
                .collect::<Vec<_>>();

            if alias_tokens.is_empty() {
                return false;
            }

            if alias_tokens.len() == 1 {
                let token = &alias_tokens[0];
                return (token.len() >= 3 && article_tokens.iter().any(|candidate| candidate == token))
                    || (normalize_team_name(&alias).len() >= 4
                        && article_normalized.contains(&normalize_team_name(&alias)));
            }

            alias_tokens
                .iter()
                .all(|token| article_tokens.iter().any(|candidate| candidate == token))
        });

        if matched {
            matches.push(team.clone());
        }
    }

    matches.sort();
    matches.dedup();
    matches
}

fn classify_article_signal(text: &str) -> (&'static str, f64, usize, usize) {
    let lowercase = text.to_ascii_lowercase();
    let negative_phrases = [
        ("out for season", 1.5),
        ("ruled out", 1.2),
        ("will miss", 1.0),
        ("miss time", 0.9),
        ("doubtful", 0.8),
        ("suspended", 0.8),
        ("suspension", 0.8),
        ("concussion", 0.8),
        ("questionable", 0.6),
        ("limited", 0.5),
        ("injury", 0.5),
        ("injured", 0.5),
        ("illness", 0.45),
        ("ankle", 0.35),
        ("knee", 0.35),
        ("hamstring", 0.35),
        ("foot", 0.35),
        ("wrist", 0.3),
    ];
    let positive_phrases = [
        ("back in the lineup", 0.8),
        ("expected to play", 0.6),
        ("returns", 0.6),
        ("returning", 0.55),
        ("cleared", 0.55),
        ("available", 0.4),
        ("healthy", 0.4),
        ("back", 0.25),
        ("probable", 0.25),
    ];

    let mut negative_score = 0.0;
    let mut positive_score = 0.0;
    let mut injury_mentions = 0usize;
    let mut positive_mentions = 0usize;

    for (phrase, weight) in negative_phrases {
        if lowercase.contains(phrase) {
            negative_score += weight;
            injury_mentions += 1;
        }
    }

    for (phrase, weight) in positive_phrases {
        if lowercase.contains(phrase) {
            positive_score += weight;
            positive_mentions += 1;
        }
    }

    let impact_score = clamp(negative_score - positive_score, -1.0, 2.0);
    let signal = if impact_score >= 0.4 {
        "Injury concern"
    } else if impact_score <= -0.25 {
        "Positive return"
    } else {
        "General context"
    };

    (signal, impact_score, injury_mentions, positive_mentions)
}

fn parse_number(value: &str) -> f64 {
    value.parse::<f64>().unwrap_or(0.0)
}

fn parse_percent(value: &str) -> f64 {
    parse_number(value) * 100.0
}

fn parse_unit_scale(value: &str) -> f64 {
    parse_number(value)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn sigmoid(value: f64) -> f64 {
    1.0 / (1.0 + (-value).exp())
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn region_rank(region: &str) -> usize {
    REGION_ORDER
        .iter()
        .position(|candidate| candidate == &region)
        .unwrap_or(usize::MAX)
}

fn round_label(round_index: usize) -> &'static str {
    match round_index {
        0 => "Round of 64",
        1 => "Round of 32",
        2 => "Sweet 16",
        3 => "Elite Eight",
        4 => "Final Four",
        5 => "Championship",
        _ => "Round",
    }
}

#[derive(Debug)]
enum ApiError {
    Sql(rusqlite::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    Parse(String),
}

impl From<rusqlite::Error> for ApiError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let message = match self {
            ApiError::Sql(error) => format!("sqlite error: {error}"),
            ApiError::Json(error) => format!("json error: {error}"),
            ApiError::Http(error) => format!("http error: {error}"),
            ApiError::Parse(error) => error,
        };
        (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("valid time")
            .as_nanos();
        std::env::temp_dir().join(format!("{label}-{nanos}.db"))
    }

    fn sample_state() -> StoredState {
        StoredState {
            version: 1,
            saved_at: "2026-03-19T00:00:00Z".into(),
            teams: serde_json::json!([{"name": "Duke"}]),
            weights: serde_json::json!({"efficiency": 30}),
            portfolio: serde_json::json!({"startingBankroll": 1000, "bets": []}),
            tournament: serde_json::json!({"year": 2026, "games": []}),
            prediction_log: serde_json::json!({"entries": []}),
            ai_prefill: serde_json::json!(null),
            optimizer_settings: serde_json::json!(null),
        }
    }

    #[test]
    fn sqlite_round_trip_state() {
        let db_path = temp_db_path("oracle-server-roundtrip");
        initialize_db(&db_path).expect("db init");
        let state = sample_state();

        save_state_to_db(&db_path, &state).expect("save state");
        let loaded = load_state_from_db(&db_path)
            .expect("load state")
            .expect("stored state exists");

        assert_eq!(loaded.version, state.version);
        assert_eq!(loaded.teams, state.teams);
        assert_eq!(loaded.weights, state.weights);
        assert_eq!(loaded.portfolio, state.portfolio);
        assert_eq!(loaded.tournament, state.tournament);
        assert_eq!(loaded.prediction_log, state.prediction_log);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn sqlite_clear_state_removes_row() {
        let db_path = temp_db_path("oracle-server-clear");
        initialize_db(&db_path).expect("db init");
        save_state_to_db(&db_path, &sample_state()).expect("save state");

        clear_state_in_db(&db_path).expect("clear state");
        let loaded = load_state_from_db(&db_path).expect("load state after clear");
        assert!(loaded.is_none());

        let _ = std::fs::remove_file(db_path);
    }
}
