#![recursion_limit = "512"]

use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
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

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    http: Client,
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

#[derive(Debug, Clone, Copy, Serialize)]
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
    aggregate: BacktestAggregate,
    years: Vec<BacktestYear>,
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
    recommended_weights: ModelWeights,
    holdout_average_accuracy: f64,
    holdout_average_brier: f64,
    evaluated_seasons_accuracy: f64,
    evaluated_seasons_brier: f64,
    generations: usize,
    population_size: usize,
    candidates: Vec<EvolutionCandidate>,
    fold_summaries: Vec<EvolutionFoldSummary>,
    meta_signals: Vec<String>,
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

#[derive(Debug, Deserialize)]
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

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    let db_path = PathBuf::from("madness_oracle.db");
    initialize_db(&db_path).expect("failed to initialize sqlite database");

    let http = Client::builder()
        .user_agent("madness-oracle-pro/0.1")
        .build()
        .expect("http client");

    let state = Arc::new(AppState { db_path, http });
    let api_routes = Router::new()
        .route("/state", get(get_state).put(put_state).delete(delete_state))
        .route("/season/:year", get(get_season))
        .route("/backtest", get(get_backtest))
        .route("/evolution", get(get_evolution))
        .route("/strategy-evolution", get(get_strategy_evolution))
        .route("/provider-status", get(get_provider_status))
        .route("/tournament/sync", post(post_tournament_sync))
        .route("/live/context", post(post_live_context))
        .route("/ai/prefill", post(post_ai_prefill))
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
    let results = run_backtests(&state.http).await?;
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

fn backtest_methodology() -> String {
    "Historical backtests use official NCAA archived bracket pages for real matchups and outcomes. Because archived NCAA bracket-IQ team-stat feeds returned 404 for 2021-2024 during verification on March 19, 2026, those seasons currently use the app's seed-based proxy ratings rather than full archived NCAA stats.".into()
}

fn backtest_caveats() -> Vec<String> {
    vec![
        "Coverage currently includes 2021-2024 because NCAA's 2025 bracket archive endpoint resolves to the live 2026 bracket page.".into(),
        "Backtest accuracy is useful for structural sanity checks, but it is not yet a full historical replay of live injuries, betting markets, or news context.".into(),
        "The live 2026 season uses official NCAA team stats; archived seasons currently do not.".into(),
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
    })
}

async fn run_backtests(client: &Client) -> Result<BacktestResponse, ApiError> {
    let seasons = load_historical_seasons(client).await?;
    let weights = default_model_weights();
    let mut years = Vec::with_capacity(seasons.len());
    let mut total_correct = 0usize;
    let mut total_games = 0usize;
    let mut champion_hits = 0usize;
    let mut brier_total = 0.0;

    for season in &seasons {
        let year_result = evaluate_historical_season(season, &weights)?;
        total_correct += year_result.correct_picks;
        total_games += year_result.total_games;
        if year_result.champion_hit {
            champion_hits += 1;
        }
        brier_total += year_result.average_brier;
        years.push(year_result);
    }

    Ok(BacktestResponse {
        methodology: backtest_methodology(),
        caveats: backtest_caveats(),
        aggregate: BacktestAggregate {
            years_covered: years.len(),
            correct_picks: total_correct,
            total_games,
            overall_accuracy: ratio(total_correct, total_games),
            average_brier: brier_total / years.len() as f64,
            champion_hits,
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
    let seasons = load_historical_seasons(client).await?;
    let defaults = default_model_weights();

    let mut rng = StdRng::seed_from_u64(EVOLUTION_SEED);
    let leaderboard = evolve_population(&seasons, EVOLUTION_POPULATION, EVOLUTION_GENERATIONS, &mut rng)?;

    let mut fold_summaries = Vec::with_capacity(seasons.len());
    let mut fold_winners = Vec::with_capacity(seasons.len());
    let mut holdout_accuracy_total = 0.0;
    let mut holdout_brier_total = 0.0;

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
            EVOLUTION_POPULATION.saturating_sub(12).max(24),
            EVOLUTION_GENERATIONS.saturating_sub(4).max(10),
            &mut fold_rng,
        )?;
        let winner = fold_board
            .first()
            .ok_or_else(|| ApiError::Parse("Evolution fold returned no candidates".into()))?;
        let holdout_result = evaluate_historical_season(holdout, &winner.weights)?;

        holdout_accuracy_total += holdout_result.overall_accuracy;
        holdout_brier_total += holdout_result.average_brier;
        fold_winners.push(winner.weights);
        fold_summaries.push(EvolutionFoldSummary {
            holdout_year: holdout.year,
            train_years: train.iter().map(|season| season.year).collect(),
            selected_weights: winner.weights,
            holdout_accuracy: holdout_result.overall_accuracy,
            holdout_brier: holdout_result.average_brier,
        });
    }

    let median_fold_weights = median_weights(&fold_winners);
    let recommended_weights = shrink_toward_defaults(&defaults, &median_fold_weights, 0.58);
    let evaluated = evaluate_genome(&seasons, &recommended_weights)?;

    Ok(EvolutionResponse {
        methodology: "The evolution lab searches a bounded family of weight profiles against archived NCAA tournaments, then uses leave-one-year-out folds plus shrinkage back toward the default model before recommending anything for the live season. That keeps the system learning from history without letting one strange March rewrite the whole model.".into(),
        caution: "Archived seasons still use proxy team ratings rather than full archived NCAA stat snapshots, so these learned weights should be treated as conservative meta-guidance, not a fully autonomous retrain. Market blend is intentionally left untouched because historical line snapshots are not yet in the backtest dataset.".into(),
        defaults,
        recommended_weights,
        holdout_average_accuracy: holdout_accuracy_total / fold_summaries.len() as f64,
        holdout_average_brier: holdout_brier_total / fold_summaries.len() as f64,
        evaluated_seasons_accuracy: evaluated.average_accuracy,
        evaluated_seasons_brier: evaluated.average_brier,
        generations: EVOLUTION_GENERATIONS,
        population_size: EVOLUTION_POPULATION,
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
        meta_signals: build_meta_signals(&fold_winners, &defaults, &recommended_weights),
    })
}

fn evolve_population(
    seasons: &[HistoricalSeasonData],
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
) -> Result<Vec<GenomeScore>, ApiError> {
    let defaults = default_model_weights();
    let mut population = initialize_population(population_size, &defaults, rng);

    for generation in 0..generations {
        let mut scored = population
            .iter()
            .map(|weights| evaluate_genome(seasons, weights))
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
    }

    let mut scored = population
        .iter()
        .map(|weights| evaluate_genome(seasons, weights))
        .collect::<Result<Vec<_>, _>>()?;
    scored.sort_by(compare_genome_scores);
    Ok(scored)
}

fn initialize_population(population_size: usize, defaults: &ModelWeights, rng: &mut StdRng) -> Vec<ModelWeights> {
    let mut population = Vec::with_capacity(population_size);
    population.push(*defaults);

    while population.len() < population_size {
        population.push(mutate_weights(defaults, rng, 0, EVOLUTION_GENERATIONS));
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

fn evaluate_genome(seasons: &[HistoricalSeasonData], weights: &ModelWeights) -> Result<GenomeScore, ApiError> {
    let defaults = default_model_weights();
    let year_results = seasons
        .iter()
        .map(|season| evaluate_historical_season(season, weights))
        .collect::<Result<Vec<_>, _>>()?;

    let accuracies = year_results
        .iter()
        .map(|result| result.overall_accuracy)
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
    let distance_from_defaults = distance_from_defaults(weights, &defaults);
    let fitness = (-average_brier * 100.0)
        + (average_accuracy * 28.0)
        + (worst_year_accuracy * 8.0)
        - (brier_stddev * 55.0)
        - (distance_from_defaults * 3.0);

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

fn shrink_toward_defaults(defaults: &ModelWeights, evolved: &ModelWeights, evolved_share: f64) -> ModelWeights {
    let keep_default = 1.0 - evolved_share;
    clamp_model_weights(ModelWeights {
        efficiency: defaults.efficiency * keep_default + evolved.efficiency * evolved_share,
        seed: defaults.seed * keep_default + evolved.seed * evolved_share,
        four_factors: defaults.four_factors * keep_default + evolved.four_factors * evolved_share,
        momentum: defaults.momentum * keep_default + evolved.momentum * evolved_share,
        injuries: defaults.injuries * keep_default + evolved.injuries * evolved_share,
        soft_factors: defaults.soft_factors * keep_default + evolved.soft_factors * evolved_share,
        uncertainty: defaults.uncertainty * keep_default + evolved.uncertainty * evolved_share,
    })
}

fn build_meta_signals(
    fold_winners: &[ModelWeights],
    defaults: &ModelWeights,
    recommended: &ModelWeights,
) -> Vec<String> {
    let mut signals = vec![
        "Market blend is deliberately excluded from evolution because the archived backtest dataset does not yet include trustworthy historical closing lines.".into(),
        "Recommended weights are shrunk back toward the default profile after fold testing so the live model learns slowly instead of chasing one hot tournament.".into(),
    ];

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
    year: i32,
    ending_bankroll: f64,
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
    hedge_stake: f64,
    total_outlay: f64,
    if_pick_wins: f64,
    if_hedge_wins: f64,
    max_loss: f64,
}

async fn run_strategy_evolution(client: &Client) -> Result<StrategyEvolutionResponse, ApiError> {
    let seasons = load_historical_seasons(client).await?;
    let weights = default_model_weights();
    let defaults = default_strategy_profile();
    let mut rng = StdRng::seed_from_u64(STRATEGY_EVOLUTION_SEED);
    let leaderboard = evolve_strategy_population(
        &seasons,
        &weights,
        STRATEGY_EVOLUTION_POPULATION,
        STRATEGY_EVOLUTION_GENERATIONS,
        &mut rng,
    )?;

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
            STRATEGY_EVOLUTION_POPULATION.saturating_sub(10).max(24),
            STRATEGY_EVOLUTION_GENERATIONS.saturating_sub(4).max(10),
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
    }

    let median_profile = median_strategy_profile(&fold_winners);
    let recommended_profile = shrink_strategy_toward_defaults(&defaults, &median_profile, 0.62);
    let evaluated = evaluate_strategy_genome(&seasons, &weights, &recommended_profile)?;

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
        generations: STRATEGY_EVOLUTION_GENERATIONS,
        population_size: STRATEGY_EVOLUTION_POPULATION,
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

fn evolve_strategy_population(
    seasons: &[HistoricalSeasonData],
    weights: &ModelWeights,
    population_size: usize,
    generations: usize,
    rng: &mut StdRng,
) -> Result<Vec<StrategyGenomeScore>, ApiError> {
    let defaults = default_strategy_profile();
    let mut population = initialize_strategy_population(population_size, &defaults, rng);

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
    rng: &mut StdRng,
) -> Vec<StrategyProfile> {
    let mut population = Vec::with_capacity(population_size);
    population.push(*defaults);

    while population.len() < population_size {
        population.push(mutate_strategy_profile(
            defaults,
            rng,
            0,
            STRATEGY_EVOLUTION_GENERATIONS,
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
    let starting_bankroll = 1_000.0;
    let mut bankroll = starting_bankroll;
    let mut peak = bankroll;
    let mut max_drawdown = 0.0;
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
        year: season.year,
        ending_bankroll: bankroll,
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
            hedge_stake: round2(hedge_stake.max(0.0)),
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
    fold_winners: &[StrategyProfile],
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

fn predict_bracket_champion(
    games: &[ActualGame],
    lookup: &HashMap<String, PredictionTeam>,
    weights: &ModelWeights,
) -> Result<String, ApiError> {
    let mut region_winners = Vec::new();

    for region in REGION_ORDER {
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

    let semifinal_a = predicted_winner_from_teams(&region_winners[0], &region_winners[1], 4, weights);
    let semifinal_b = predicted_winner_from_teams(&region_winners[2], &region_winners[3], 4, weights);
    Ok(predicted_winner_from_teams(&semifinal_a, &semifinal_b, 5, weights).name)
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
            tournament_json TEXT
        )",
        [],
    )?;
    ensure_column(&connection, "app_state", "portfolio_json", "TEXT")?;
    ensure_column(&connection, "app_state", "tournament_json", "TEXT")?;
    Ok(())
}

fn load_state_from_db(db_path: &PathBuf) -> Result<Option<StoredState>, ApiError> {
    let connection = Connection::open(db_path)?;
    let mut statement = connection.prepare(
        "SELECT version, saved_at, teams_json, weights_json, COALESCE(portfolio_json, 'null'), COALESCE(tournament_json, 'null') FROM app_state WHERE id = 1",
    )?;

    let row = statement
        .query_row([], |row| {
            let teams_json: String = row.get(2)?;
            let weights_json: String = row.get(3)?;
            let portfolio_json: String = row.get(4)?;
            let tournament_json: String = row.get(5)?;
            Ok(StoredState {
                version: row.get(0)?,
                saved_at: row.get(1)?,
                teams: serde_json::from_str(&teams_json).map_err(to_sql_error)?,
                weights: serde_json::from_str(&weights_json).map_err(to_sql_error)?,
                portfolio: serde_json::from_str(&portfolio_json).map_err(to_sql_error)?,
                tournament: serde_json::from_str(&tournament_json).map_err(to_sql_error)?,
            })
        })
        .optional()?;

    Ok(row)
}

fn save_state_to_db(db_path: &PathBuf, payload: &StoredState) -> Result<(), ApiError> {
    let connection = Connection::open(db_path)?;
    connection.execute(
        "INSERT INTO app_state (id, version, saved_at, teams_json, weights_json, portfolio_json, tournament_json)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            version = excluded.version,
            saved_at = excluded.saved_at,
            teams_json = excluded.teams_json,
            weights_json = excluded.weights_json,
            portfolio_json = excluded.portfolio_json,
            tournament_json = excluded.tournament_json",
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
