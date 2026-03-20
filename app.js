const regions = ['East', 'West', 'South', 'Midwest'];
const firstRoundSeedPairs = [
  [1, 16],
  [8, 9],
  [5, 12],
  [4, 13],
  [6, 11],
  [3, 14],
  [7, 10],
  [2, 15],
];
const tournamentRoundLabels = ['Round of 64', 'Round of 32', 'Sweet 16', 'Elite Eight', 'Final Four', 'Championship'];

const defaultWeights = {
  efficiency: 30,
  seed: 8,
  fourFactors: 18,
  momentum: 8,
  injuries: 10,
  softFactors: 12,
  marketBlend: 18,
  uncertainty: 8,
};

const weightMeta = {
  efficiency: { label: 'Efficiency', min: 0, max: 40 },
  seed: { label: 'Seed prior', min: 0, max: 20 },
  fourFactors: { label: 'Four Factors', min: 0, max: 30 },
  momentum: { label: 'Recent form', min: 0, max: 20 },
  injuries: { label: 'Injury penalty', min: 0, max: 20 },
  softFactors: { label: 'Soft factors', min: 0, max: 20 },
  marketBlend: { label: 'Market blend', min: 0, max: 25 },
  uncertainty: { label: 'Uncertainty penalty', min: 0, max: 20 },
};

const localModelConcepts = [
  {
    label: 'Seed prior',
    category: 'model',
    description: 'A modest bracket-history prior that stops the model from ignoring how seed strength usually behaves in March.',
  },
  {
    label: 'Market blend',
    category: 'model',
    description: 'A vig-aware sportsbook prior. Enter live moneylines to make this part real instead of placeholder seed lines.',
  },
  {
    label: 'Soft factors',
    category: 'model',
    description: 'Editable human-overrides for coaching, experience, continuity, and injuries when the stat feed is missing context.',
  },
  {
    label: 'Uncertainty shrinkage',
    category: 'model',
    description: 'Pulls volatile matchups closer to 50/50 so the system does not become too certain too fast.',
  },
  {
    label: 'Projected score',
    category: 'model',
    description: 'A possession-based projection using each team’s offensive efficiency, opponent defensive efficiency, and estimated pace.',
  },
];

const aggressionProfiles = {
  conservative: { label: 'Conservative', kellyMultiplier: 0.2, maxStakePct: 3, maxOpenRiskPct: 10 },
  balanced: { label: 'Balanced', kellyMultiplier: 0.35, maxStakePct: 5, maxOpenRiskPct: 15 },
  aggressive: { label: 'Aggressive', kellyMultiplier: 0.5, maxStakePct: 7, maxOpenRiskPct: 20 },
};

const regionTemplates = {
  East: ['Duke', 'Wisconsin', 'Kentucky', 'Saint Mary\'s', 'Michigan', 'BYU', 'Mississippi State', 'Florida Atlantic', 'Memphis', 'Nevada', 'Drake', 'VCU', 'Yale', 'Akron', 'Vermont', 'Howard'],
  West: ['Houston', 'Gonzaga', 'Creighton', 'Kansas', 'Texas Tech', 'Clemson', 'New Mexico', 'Colorado State', 'Boise State', 'Utah State', 'McNeese', 'Liberty', 'Grand Canyon', 'Samford', 'Colgate', 'Longwood'],
  South: ['Auburn', 'Alabama', 'Baylor', 'Texas A&M', 'San Diego State', 'Florida', 'Dayton', 'Nebraska', 'TCU', 'Virginia', 'Indiana State', 'Charleston', 'Princeton', 'UC Irvine', 'South Dakota State', 'Stetson'],
  Midwest: ['UConn', 'Tennessee', 'Illinois', 'Iowa State', 'Marquette', 'Arizona', 'Texas', 'Northwestern', 'Seton Hall', 'Colorado', 'James Madison', 'Richmond', 'App State', 'Oakland', 'Morehead State', 'Wagner'],
};

function baseMetricsForSeed(seed) {
  return {
    adjO: 126 - seed * 1.35,
    adjD: 88 + seed * 0.95,
    efg: 58 - seed * 0.28,
    tov: 13 + seed * 0.24,
    orb: 35 - seed * 0.32,
    ftr: 38 - seed * 0.34,
    form: Math.max(4.8, 9.5 - seed * 0.22),
    injuries: Math.max(0, ((seed % 5) * 0.18) - 0.1),
  };
}

function defaultMoneylineBySeed(seed) {
  if (seed <= 2) return -900 + (seed - 1) * 220;
  if (seed <= 4) return -320 + (seed - 3) * 90;
  if (seed <= 6) return -165 + (seed - 5) * 35;
  if (seed <= 8) return -120 + (seed - 7) * 20;
  if (seed <= 10) return 105 + (seed - 9) * 25;
  if (seed <= 12) return 170 + (seed - 11) * 40;
  if (seed <= 14) return 260 + (seed - 13) * 60;
  return 420 + (seed - 15) * 100;
}

function buildDefaultTeams() {
  return regions.flatMap((region) =>
    regionTemplates[region].map((name, index) => {
      const seed = index + 1;
      const base = baseMetricsForSeed(seed);
      const variance = region.charCodeAt(0) % 5;
      return {
        id: `${region}-${seed}`,
        region,
        seed,
        name,
        adjO: Number((base.adjO + variance * 0.35).toFixed(1)),
        adjD: Number((base.adjD + (4 - variance) * 0.25).toFixed(1)),
        efg: Number((base.efg + variance * 0.12).toFixed(1)),
        tov: Number((base.tov + (variance - 2) * 0.08).toFixed(1)),
        orb: Number((base.orb + (2 - variance) * 0.18).toFixed(1)),
        ftr: Number((base.ftr + variance * 0.15).toFixed(1)),
        form: Number((base.form + variance * 0.06).toFixed(1)),
        injuries: Number((base.injuries + ((seed + variance) % 3) * 0.1).toFixed(1)),
        coach: Number(clamp(8.8 - seed * 0.2 + variance * 0.08, 3.5, 9.8).toFixed(1)),
        experience: Number(clamp(8.2 - seed * 0.16 + variance * 0.05, 3.8, 9.6).toFixed(1)),
        continuity: Number(clamp(7.8 - seed * 0.14 + (2 - variance) * 0.07, 3.5, 9.4).toFixed(1)),
        marketMl: defaultMoneylineBySeed(seed),
      };
    })
  );
}

const API_STATE_URL = '/api/state';
const OFFICIAL_SEASON_URL = '/api/season/2026';
const BACKTEST_URL = '/api/backtest';
const SCORE_BACKTEST_URL = '/api/score-backtest';
const EVOLUTION_URL = '/api/evolution';
const STRATEGY_EVOLUTION_URL = '/api/strategy-evolution';
const EVOLUTION_JOB_URL = '/api/jobs/evolution';
const STRATEGY_EVOLUTION_JOB_URL = '/api/jobs/strategy-evolution';
const AI_PREFILL_JOB_URL = '/api/jobs/ai-prefill';
const JOB_STATUS_URL_PREFIX = '/api/jobs/';
const OVERLAY_REVIEW_URL = '/api/overlay-review';
const PROVIDER_STATUS_URL = '/api/provider-status';
const TOURNAMENT_SYNC_URL = '/api/tournament/sync';
const LIVE_CONTEXT_URL = '/api/live/context';
const AI_PREFILL_URL = '/api/ai/prefill';
const AI_STRATEGY_URL = '/api/ai/strategy';
const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;
let persistTimeout;
let liveRefreshTimer;

let baselineTeams = buildDefaultTeams();
let teams = baselineTeams.map((team) => ({ ...team }));
let weights = { ...defaultWeights };
let seasonMeta = null;
let glossary = [];
let backtestResults = null;
let scoreBacktestResults = null;
let evolutionResults = null;
let strategyResults = null;
let portfolio = createDefaultPortfolio();
let tournamentState = createEmptyTournamentState();
let liveContext = createEmptyLiveContext();
let aiPrefill = createEmptyAiPrefill();
let aiStrategyAdvice = createEmptyAiStrategyAdvice();
let simulationState = createDefaultSimulationState();
let overlayReview = createEmptyOverlayReview();
let predictionLog = createEmptyPredictionLog();
let backgroundJobs = createEmptyBackgroundJobs();
let optimizerSettings = createDefaultOptimizerSettings();
const workspaceMeta = [
  { id: 'overview', label: 'Overview', description: 'Model tuning, season status, and current edge.' },
  { id: 'betting', label: 'Betting', description: 'Stake plan, ledger, live board, and bracket path.' },
  { id: 'research', label: 'Research', description: 'Live news, signals, AI prefill, and glossary.' },
  { id: 'teams', label: 'Team Lab', description: 'Edit all 64 teams and inspect architecture.' },
  { id: 'validation', label: 'Validation', description: 'Backtests and modeling stance.' },
];
let activeWorkspace = 'overview';

const weightControls = document.getElementById('weightControls');
const summaryCards = document.getElementById('summaryCards');
const seasonStatus = document.getElementById('seasonStatus');
const championBoard = document.getElementById('championBoard');
const edgeBoard = document.getElementById('edgeBoard');
const recommendationBoard = document.getElementById('recommendationBoard');
const tournamentStatusBoard = document.getElementById('tournamentStatusBoard');
const portfolioSummary = document.getElementById('portfolioSummary');
const betSizingBoard = document.getElementById('betSizingBoard');
const aiStrategyBoard = document.getElementById('aiStrategyBoard');
const feedbackLoopBoard = document.getElementById('feedbackLoopBoard');
const liveStatusBoard = document.getElementById('liveStatusBoard');
const signalBoard = document.getElementById('signalBoard');
const newsBoard = document.getElementById('newsBoard');
const aiPrefillStatus = document.getElementById('aiPrefillStatus');
const aiPrefillBoard = document.getElementById('aiPrefillBoard');
const equityCurve = document.getElementById('equityCurve');
const betLedgerBody = document.getElementById('betLedgerBody');
const marketBoard = document.getElementById('marketBoard');
const teamTableBody = document.getElementById('teamTableBody');
const bracketView = document.getElementById('bracketView');
const glossaryBoard = document.getElementById('glossaryBoard');
const backtestBoard = document.getElementById('backtestBoard');
const scoreBacktestBoard = document.getElementById('scoreBacktestBoard');
const evolutionBoard = document.getElementById('evolutionBoard');
const strategyBoard = document.getElementById('strategyBoard');
const overlayReviewBoard = document.getElementById('overlayReviewBoard');
const predictionLogBoard = document.getElementById('predictionLogBoard');
const optimizerJobBoard = document.getElementById('optimizerJobBoard');
const researchCacheBoard = document.getElementById('researchCacheBoard');
const simulateButton = document.getElementById('simulateButton');
const simulationIterationsInput = document.getElementById('simulationIterationsInput');
const simulationStatus = document.getElementById('simulationStatus');
const loadOfficialFieldButton = document.getElementById('loadOfficialFieldButton');
const runBacktestButton = document.getElementById('runBacktestButton');
const runScoreBacktestButton = document.getElementById('runScoreBacktestButton');
const runEvolutionButton = document.getElementById('runEvolutionButton');
const runStrategyButton = document.getElementById('runStrategyButton');
const syncLiveButton = document.getElementById('syncLiveButton');
const applyLiveOddsButton = document.getElementById('applyLiveOddsButton');
const applyNewsSignalsButton = document.getElementById('applyNewsSignalsButton');
const generateAiPrefillButton = document.getElementById('generateAiPrefillButton');
const generateAiStrategyButton = document.getElementById('generateAiStrategyButton');
const applyAiPrefillButton = document.getElementById('applyAiPrefillButton');
const applyAiStrategyButton = document.getElementById('applyAiStrategyButton');
const applyEvolutionButton = document.getElementById('applyEvolutionButton');
const applyStrategyButton = document.getElementById('applyStrategyButton');
const runOverlayReviewButton = document.getElementById('runOverlayReviewButton');
const applyOverlayButton = document.getElementById('applyOverlayButton');
const lockPredictionsButton = document.getElementById('lockPredictionsButton');
const resetButton = document.getElementById('resetButton');
const saveLocalButton = document.getElementById('saveLocalButton');
const exportButton = document.getElementById('exportButton');
const importButton = document.getElementById('importButton');
const clearStorageButton = document.getElementById('clearStorageButton');
const importFileInput = document.getElementById('importFileInput');
const workspaceNav = document.getElementById('workspaceNav');
const workspaceTabs = document.getElementById('workspaceTabs');
const startingBankrollInput = document.getElementById('startingBankrollInput');
const kellyMultiplierInput = document.getElementById('kellyMultiplierInput');
const maxStakePctInput = document.getElementById('maxStakePctInput');
const maxOpenRiskPctInput = document.getElementById('maxOpenRiskPctInput');
const minEdgePctInput = document.getElementById('minEdgePctInput');
const minConfidenceInput = document.getElementById('minConfidenceInput');
const hedgeStyleSelect = document.getElementById('hedgeStyleSelect');
const useResearchCacheInput = document.getElementById('useResearchCacheInput');
const autoRefreshMinutesInput = document.getElementById('autoRefreshMinutesInput');
const liveOddsModeSelect = document.getElementById('liveOddsModeSelect');
const autoSyncInput = document.getElementById('autoSyncInput');
const autoApplyNewsInput = document.getElementById('autoApplyNewsInput');
const evolutionPopulationInput = document.getElementById('evolutionPopulationInput');
const evolutionGenerationsInput = document.getElementById('evolutionGenerationsInput');
const evolutionRestartsInput = document.getElementById('evolutionRestartsInput');
const strategyPopulationInput = document.getElementById('strategyPopulationInput');
const strategyGenerationsInput = document.getElementById('strategyGenerationsInput');
const strategyRestartsInput = document.getElementById('strategyRestartsInput');

function createDefaultPortfolio() {
  return {
    startingBankroll: 1000,
    kellyMultiplier: 0.35,
    maxStakePct: 5,
    maxOpenRiskPct: 15,
    minEdgePct: 2,
    minConfidence: 0.55,
    hedgeStyle: 'none',
    useResearchCache: true,
    autoRefreshMinutes: 5,
    liveOddsMode: 'best',
    autoSync: false,
    autoApplyNews: false,
    bets: [],
  };
}

function createDefaultSimulationState() {
  return {
    iterations: 25000,
    completedIterations: 0,
    status: 'idle',
    processed: 0,
    progress: 0,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    signature: null,
    targetSignature: null,
    result: null,
    runId: 0,
  };
}

function createEmptyOverlayReview() {
  return {
    status: 'idle',
    candidateProfile: null,
    response: null,
  };
}

function createEmptyLiveContext() {
  return {
    fetchedAt: null,
    oddsProvider: null,
    newsProvider: null,
    games: [],
    articles: [],
    teamSignals: [],
  };
}

function createDefaultOptimizerSettings() {
  return {
    evolutionPopulation: 96,
    evolutionGenerations: 30,
    evolutionRestarts: 3,
    strategyPopulation: 84,
    strategyGenerations: 28,
    strategyRestarts: 3,
  };
}

function createEmptyTournamentState() {
  return {
    fetchedAt: null,
    sourceUrl: null,
    message: 'No tournament sync has run yet.',
    year: 2026,
    matchedGameCount: 0,
    completedGameCount: 0,
    inProgressGameCount: 0,
    upcomingGameCount: 0,
    autoSettledCount: 0,
    games: [],
  };
}

function createEmptyAiPrefill() {
  return {
    status: 'idle',
    provider: null,
    generatedAt: null,
    appliedAt: null,
    model: null,
    researchedTeams: 0,
    fallbackTeams: 0,
    cacheKey: null,
    cacheHit: false,
    assessments: [],
  };
}

function normalizeAiPrefill(input) {
  const defaults = createEmptyAiPrefill();
  if (!input || typeof input !== 'object') return defaults;
  return {
    ...defaults,
    ...input,
    status: input.status || defaults.status,
    appliedAt: input.appliedAt || defaults.appliedAt,
    researchedTeams: Number.isFinite(Number(input.researchedTeams)) ? Number(input.researchedTeams) : defaults.researchedTeams,
    fallbackTeams: Number.isFinite(Number(input.fallbackTeams)) ? Number(input.fallbackTeams) : defaults.fallbackTeams,
    cacheHit: Boolean(input.cacheHit),
    assessments: Array.isArray(input.assessments) ? input.assessments : [],
  };
}

function normalizeOptimizerSettings(input) {
  const defaults = createDefaultOptimizerSettings();
  if (!input || typeof input !== 'object') return defaults;
  return {
    evolutionPopulation: clamp(Math.round(Number(input.evolutionPopulation) || defaults.evolutionPopulation), 24, 256),
    evolutionGenerations: clamp(Math.round(Number(input.evolutionGenerations) || defaults.evolutionGenerations), 8, 80),
    evolutionRestarts: clamp(Math.round(Number(input.evolutionRestarts) || defaults.evolutionRestarts), 1, 8),
    strategyPopulation: clamp(Math.round(Number(input.strategyPopulation) || defaults.strategyPopulation), 24, 256),
    strategyGenerations: clamp(Math.round(Number(input.strategyGenerations) || defaults.strategyGenerations), 8, 80),
    strategyRestarts: clamp(Math.round(Number(input.strategyRestarts) || defaults.strategyRestarts), 1, 8),
  };
}

function createEmptyAiStrategyAdvice() {
  return {
    status: 'idle',
    provider: null,
    generatedAt: null,
    model: null,
    fallbackUsed: false,
    recommendation: null,
  };
}

function createEmptyPredictionLog() {
  return {
    lastLockedAt: null,
    lastLockSummary: 'No frozen pregame predictions yet.',
    lastGradedAt: null,
    entries: [],
  };
}

function createEmptyBackgroundJobs() {
  return {
    evolution: null,
    strategyEvolution: null,
    aiPrefill: null,
  };
}

function resetAppStateToFreshStart() {
  const nextRunId = simulationState.runId + 1;
  baselineTeams = buildDefaultTeams();
  teams = cloneTeams(baselineTeams);
  weights = { ...defaultWeights };
  seasonMeta = null;
  glossary = [];
  backtestResults = null;
  scoreBacktestResults = null;
  evolutionResults = null;
  strategyResults = null;
  portfolio = createDefaultPortfolio();
  tournamentState = createEmptyTournamentState();
  liveContext = createEmptyLiveContext();
  aiPrefill = createEmptyAiPrefill();
  aiStrategyAdvice = createEmptyAiStrategyAdvice();
  simulationState = {
    ...createDefaultSimulationState(),
    runId: nextRunId,
  };
  overlayReview = createEmptyOverlayReview();
  predictionLog = createEmptyPredictionLog();
  backgroundJobs = createEmptyBackgroundJobs();
  optimizerSettings = createDefaultOptimizerSettings();
}

function isValidWorkspace(workspace) {
  return workspace === 'all' || workspaceMeta.some((item) => item.id === workspace);
}

function applyWorkspaceVisibility() {
  document.querySelectorAll('.dashboard-panel').forEach((panel) => {
    panel.hidden = activeWorkspace !== 'all' && panel.dataset.workspace !== activeWorkspace;
  });
}

function renderWorkspaceTabs() {
  workspaceTabs.innerHTML = [
    { id: 'all', label: 'All Panels', description: 'Keep the full dashboard in one view.' },
    ...workspaceMeta,
  ].map((item) => `
    <button
      class="workspace-tab"
      type="button"
      data-workspace="${item.id}"
      data-active="${item.id === activeWorkspace}"
      aria-pressed="${item.id === activeWorkspace}"
    >
      <strong>${item.label}</strong>
      <span>${item.description}</span>
    </button>
  `).join('');

  workspaceTabs.querySelectorAll('[data-workspace]').forEach((button) => {
    button.addEventListener('click', (event) => {
      setActiveWorkspace(event.currentTarget.dataset.workspace);
    });
  });
}

function setActiveWorkspace(workspace, { scroll = true } = {}) {
  if (!isValidWorkspace(workspace)) return;
  activeWorkspace = workspace;
  window.localStorage.setItem('madnessWorkspace', workspace);
  const url = new URL(window.location.href);
  url.hash = workspace === 'all' ? '' : `workspace-${workspace}`;
  window.history.replaceState({}, '', url);
  renderWorkspaceTabs();
  applyWorkspaceVisibility();
  if (scroll) {
    workspaceNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function initializeWorkspace() {
  const fromHash = window.location.hash.startsWith('#workspace-')
    ? window.location.hash.replace('#workspace-', '')
    : '';
  const stored = window.localStorage.getItem('madnessWorkspace');
  const preferred = isValidWorkspace(fromHash) ? fromHash : stored;
  activeWorkspace = isValidWorkspace(preferred) ? preferred : 'overview';
  renderWorkspaceTabs();
  applyWorkspaceVisibility();
}

async function loadProviderStatus() {
  const response = await fetch(PROVIDER_STATUS_URL);
  if (!response.ok) {
    throw new Error(`Provider status request failed with ${response.status}`);
  }

  const payload = await response.json();
  if (payload.oddsProvider) {
    liveContext.oddsProvider = payload.oddsProvider;
  }
  if (payload.newsProvider) {
    liveContext.newsProvider = payload.newsProvider;
  }
  if (payload.aiProvider) {
    aiPrefill.provider = payload.aiProvider;
    aiStrategyAdvice.provider = payload.aiProvider;
  }
  if (payload.aiModel) {
    aiPrefill.model = payload.aiModel;
    aiStrategyAdvice.model = payload.aiModel;
  }
}


function serializeState() {
  return {
    version: 3,
    savedAt: new Date().toISOString(),
    teams,
    weights,
    portfolio,
    tournament: tournamentState,
    predictionLog,
    aiPrefill,
    optimizerSettings,
  };
}

function cloneTeams(input) {
  return input.map((team) => ({ ...team }));
}

function normalizeBet(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const stake = Number(entry.stake);
  const marketMl = Number(entry.marketMl);
  const modelProbability = Number(entry.modelProbability);
  const expectedValue = Number(entry.expectedValue);
  if (!entry.id || !Number.isFinite(stake) || !Number.isFinite(marketMl)) return null;

  const status = ['open', 'win', 'loss', 'push', 'cancelled'].includes(entry.status)
    ? entry.status
    : 'open';
  const hedgeStyle = normalizeHedgeStyle(entry.hedgeStyle);
  const safeModelProbability = Number.isFinite(modelProbability) ? clamp(modelProbability, 0.001, 0.999) : 0.5;
  const fallbackPlan = buildSelectedHedgePlan(
    Number(stake.toFixed(2)),
    marketMl,
    Number.isFinite(Number(entry.hedgeMarketMl)) ? Number(entry.hedgeMarketMl) : null,
    hedgeStyle
  );
  const hedgeStake = Number.isFinite(Number(entry.hedgeStake))
    ? roundCurrency(Number(entry.hedgeStake))
    : fallbackPlan.hedgeStake;
  const hedgeMarketMl = Number.isFinite(Number(entry.hedgeMarketMl))
    ? Number(entry.hedgeMarketMl)
    : fallbackPlan.hedgeMarketMl;
  const ifPickWins = Number.isFinite(Number(entry.ifPickWins))
    ? roundCurrency(Number(entry.ifPickWins))
    : fallbackPlan.ifPickWins;
  const ifHedgeWins = Number.isFinite(Number(entry.ifHedgeWins))
    ? roundCurrency(Number(entry.ifHedgeWins))
    : fallbackPlan.ifHedgeWins;
  const totalOutlay = Number.isFinite(Number(entry.totalOutlay))
    ? roundCurrency(Number(entry.totalOutlay))
    : roundCurrency(stake + hedgeStake);
  const maxLoss = Number.isFinite(Number(entry.maxLoss))
    ? roundCurrency(Number(entry.maxLoss))
    : roundCurrency(Math.max(-ifPickWins, -ifHedgeWins, 0));
  const normalizedExpectedValue = Number.isFinite(expectedValue)
    ? Number(expectedValue.toFixed(2))
    : roundCurrency((safeModelProbability * ifPickWins) + ((1 - safeModelProbability) * ifHedgeWins));

  return {
    id: String(entry.id),
    createdAt: entry.createdAt || new Date().toISOString(),
    settledAt: entry.settledAt || null,
    teamId: entry.teamId || '',
    teamName: entry.teamName || 'Unknown team',
    opponentId: entry.opponentId || '',
    opponentName: entry.opponentName || 'Unknown opponent',
    region: entry.region || 'Unknown',
    roundIndex: Number.isFinite(Number(entry.roundIndex)) ? Number(entry.roundIndex) : 0,
    roundLabel: entry.roundLabel || 'Round of 64',
    contestId: Number.isFinite(Number(entry.contestId)) ? Number(entry.contestId) : null,
    marketMl,
    opponentMarketMl: Number.isFinite(Number(entry.opponentMarketMl)) ? Number(entry.opponentMarketMl) : null,
    fairMl: Number.isFinite(Number(entry.fairMl)) ? Number(entry.fairMl) : null,
    modelProbability: safeModelProbability,
    confidence: Number.isFinite(Number(entry.confidence)) ? clamp(Number(entry.confidence), 0, 1) : 0.5,
    edge: Number.isFinite(Number(entry.edge)) ? Number(entry.edge) : 0,
    stake: Number(stake.toFixed(2)),
    hedgeStyle: hedgeStake > 0 ? hedgeStyle : 'none',
    hedgeStake,
    hedgeMarketMl,
    totalOutlay,
    ifPickWins,
    ifHedgeWins,
    maxLoss,
    currentMarketMl: Number.isFinite(Number(entry.currentMarketMl)) ? Number(entry.currentMarketMl) : marketMl,
    currentOpponentMarketMl: Number.isFinite(Number(entry.currentOpponentMarketMl))
      ? Number(entry.currentOpponentMarketMl)
      : (Number.isFinite(Number(entry.opponentMarketMl)) ? Number(entry.opponentMarketMl) : null),
    closingMarketMl: Number.isFinite(Number(entry.closingMarketMl)) ? Number(entry.closingMarketMl) : null,
    closingOpponentMarketMl: Number.isFinite(Number(entry.closingOpponentMarketMl)) ? Number(entry.closingOpponentMarketMl) : null,
    marketSource: entry.marketSource || 'manual',
    oddsTimeline: Array.isArray(entry.oddsTimeline)
      ? entry.oddsTimeline
        .map((snapshot) => ({
          at: snapshot?.at || new Date().toISOString(),
          teamMl: Number.isFinite(Number(snapshot?.teamMl)) ? Number(snapshot.teamMl) : null,
          opponentMl: Number.isFinite(Number(snapshot?.opponentMl)) ? Number(snapshot.opponentMl) : null,
          source: snapshot?.source || 'manual',
        }))
        .filter((snapshot) => Number.isFinite(snapshot.teamMl))
      : [],
    contextKey: entry.contextKey || '',
    contextSnapshot: entry.contextSnapshot && typeof entry.contextSnapshot === 'object'
      ? { ...entry.contextSnapshot }
      : null,
    strategySnapshot: entry.strategySnapshot && typeof entry.strategySnapshot === 'object'
      ? { ...entry.strategySnapshot }
      : null,
    expectedValue: normalizedExpectedValue,
    status,
  };
}

function normalizeTournamentTeam(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    name: entry.name || 'Unknown team',
    seed: Number.isFinite(Number(entry.seed)) ? Number(entry.seed) : null,
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
    isWinner: Boolean(entry.isWinner),
    teamId: entry.teamId || null,
    region: entry.region || null,
  };
}

function normalizeTournamentGame(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const teamA = normalizeTournamentTeam(entry.teamA);
  const teamB = normalizeTournamentTeam(entry.teamB);
  if (!teamA || !teamB) return null;

  return {
    contestId: Number.isFinite(Number(entry.contestId)) ? Number(entry.contestId) : null,
    roundIndex: Number.isFinite(Number(entry.roundIndex)) ? Number(entry.roundIndex) : 0,
    roundLabel: entry.roundLabel || 'Round of 64',
    region: entry.region || 'Unknown',
    gameState: entry.gameState || '',
    statusDisplay: entry.statusDisplay || '',
    startTime: entry.startTime || null,
    startDate: entry.startDate || null,
    gameUrl: entry.gameUrl || null,
    teamA,
    teamB,
  };
}

function normalizeTournamentState(input) {
  const defaults = createEmptyTournamentState();
  if (!input || typeof input !== 'object') return defaults;

  return {
    fetchedAt: input.fetchedAt || null,
    sourceUrl: input.sourceUrl || null,
    message: input.message || defaults.message,
    year: Number.isFinite(Number(input.year)) ? Number(input.year) : defaults.year,
    matchedGameCount: Number.isFinite(Number(input.matchedGameCount)) ? Number(input.matchedGameCount) : 0,
    completedGameCount: Number.isFinite(Number(input.completedGameCount)) ? Number(input.completedGameCount) : 0,
    inProgressGameCount: Number.isFinite(Number(input.inProgressGameCount)) ? Number(input.inProgressGameCount) : 0,
    upcomingGameCount: Number.isFinite(Number(input.upcomingGameCount)) ? Number(input.upcomingGameCount) : 0,
    autoSettledCount: Number.isFinite(Number(input.autoSettledCount)) ? Number(input.autoSettledCount) : 0,
    games: Array.isArray(input.games) ? input.games.map(normalizeTournamentGame).filter(Boolean) : [],
  };
}

function normalizePredictionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const roundIndex = Number(entry.roundIndex);
  const probabilityA = Number(entry.probabilityA);
  const projectedTeamAScore = Number(entry.projectedTeamAScore);
  const projectedTeamBScore = Number(entry.projectedTeamBScore);
  const projectedMargin = Number(entry.projectedMargin);
  const projectedTotal = Number(entry.projectedTotal);
  const confidence = Number(entry.confidence);

  if (!entry.id || !Number.isFinite(roundIndex) || !Number.isFinite(probabilityA)) return null;

  return {
    id: String(entry.id),
    lockedAt: entry.lockedAt || new Date().toISOString(),
    gradedAt: entry.gradedAt || null,
    dataCutoff: entry.dataCutoff || entry.lockedAt || new Date().toISOString(),
    seasonYear: Number.isFinite(Number(entry.seasonYear)) ? Number(entry.seasonYear) : 2026,
    roundIndex,
    roundLabel: entry.roundLabel || tournamentRoundLabels[roundIndex] || 'Tournament',
    region: entry.region || 'Unknown',
    contestId: Number.isFinite(Number(entry.contestId)) ? Number(entry.contestId) : null,
    startTime: entry.startTime || null,
    status: entry.status === 'graded' ? 'graded' : 'locked',
    teamAId: entry.teamAId || '',
    teamAName: entry.teamAName || 'Unknown team',
    teamASeed: Number.isFinite(Number(entry.teamASeed)) ? Number(entry.teamASeed) : null,
    teamBId: entry.teamBId || '',
    teamBName: entry.teamBName || 'Unknown opponent',
    teamBSeed: Number.isFinite(Number(entry.teamBSeed)) ? Number(entry.teamBSeed) : null,
    probabilityA: clamp(probabilityA, 0.001, 0.999),
    predictedWinnerId: entry.predictedWinnerId || '',
    predictedWinnerName: entry.predictedWinnerName || '',
    fairTeamAMl: Number.isFinite(Number(entry.fairTeamAMl)) ? Number(entry.fairTeamAMl) : null,
    fairTeamBMl: Number.isFinite(Number(entry.fairTeamBMl)) ? Number(entry.fairTeamBMl) : null,
    marketTeamAMl: Number.isFinite(Number(entry.marketTeamAMl)) ? Number(entry.marketTeamAMl) : null,
    marketTeamBMl: Number.isFinite(Number(entry.marketTeamBMl)) ? Number(entry.marketTeamBMl) : null,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5,
    projectedPace: Number.isFinite(Number(entry.projectedPace)) ? Number(entry.projectedPace) : null,
    projectedTeamAScore: Number.isFinite(projectedTeamAScore) ? projectedTeamAScore : 0,
    projectedTeamBScore: Number.isFinite(projectedTeamBScore) ? projectedTeamBScore : 0,
    projectedMargin: Number.isFinite(projectedMargin)
      ? projectedMargin
      : Number((projectedTeamAScore - projectedTeamBScore).toFixed(1)),
    projectedTotal: Number.isFinite(projectedTotal)
      ? projectedTotal
      : Number((projectedTeamAScore + projectedTeamBScore).toFixed(1)),
    weightsSnapshot: entry.weightsSnapshot && typeof entry.weightsSnapshot === 'object'
      ? { ...entry.weightsSnapshot }
      : { ...defaultWeights },
    teamASnapshot: entry.teamASnapshot && typeof entry.teamASnapshot === 'object'
      ? { ...entry.teamASnapshot }
      : null,
    teamBSnapshot: entry.teamBSnapshot && typeof entry.teamBSnapshot === 'object'
      ? { ...entry.teamBSnapshot }
      : null,
    actualTeamAScore: Number.isFinite(Number(entry.actualTeamAScore)) ? Number(entry.actualTeamAScore) : null,
    actualTeamBScore: Number.isFinite(Number(entry.actualTeamBScore)) ? Number(entry.actualTeamBScore) : null,
    actualWinnerId: entry.actualWinnerId || null,
    actualWinnerName: entry.actualWinnerName || null,
    winnerCorrect: typeof entry.winnerCorrect === 'boolean' ? entry.winnerCorrect : null,
  };
}

function normalizePredictionLog(input) {
  const defaults = createEmptyPredictionLog();
  if (!input || typeof input !== 'object') return defaults;

  return {
    lastLockedAt: input.lastLockedAt || null,
    lastLockSummary: input.lastLockSummary || defaults.lastLockSummary,
    lastGradedAt: input.lastGradedAt || null,
    entries: Array.isArray(input.entries) ? input.entries.map(normalizePredictionEntry).filter(Boolean) : [],
  };
}

function normalizePortfolio(input) {
  const defaults = createDefaultPortfolio();
  if (!input || typeof input !== 'object') return defaults;

  const startingBankroll = Number(input.startingBankroll);
  const kellyMultiplier = Number(input.kellyMultiplier);
  const maxStakePct = Number(input.maxStakePct);
  const maxOpenRiskPct = Number(input.maxOpenRiskPct);
  const minEdgePct = Number(input.minEdgePct);
  const minConfidence = Number(input.minConfidence);
  const autoRefreshMinutes = Number(input.autoRefreshMinutes);

  return {
    startingBankroll: clamp(Number.isFinite(startingBankroll) ? startingBankroll : defaults.startingBankroll, 100, 1_000_000),
    kellyMultiplier: clamp(Number.isFinite(kellyMultiplier) ? kellyMultiplier : defaults.kellyMultiplier, 0, 1),
    maxStakePct: clamp(Number.isFinite(maxStakePct) ? maxStakePct : defaults.maxStakePct, 1, 25),
    maxOpenRiskPct: clamp(Number.isFinite(maxOpenRiskPct) ? maxOpenRiskPct : defaults.maxOpenRiskPct, 1, 50),
    minEdgePct: clamp(Number.isFinite(minEdgePct) ? minEdgePct : defaults.minEdgePct, 0, 15),
    minConfidence: clamp(Number.isFinite(minConfidence) ? minConfidence : defaults.minConfidence, 0.5, 0.95),
    hedgeStyle: normalizeHedgeStyle(input.hedgeStyle),
    useResearchCache: input.useResearchCache === undefined ? defaults.useResearchCache : Boolean(input.useResearchCache),
    autoRefreshMinutes: clamp(Math.round(Number.isFinite(autoRefreshMinutes) ? autoRefreshMinutes : defaults.autoRefreshMinutes), 1, 60),
    liveOddsMode: input.liveOddsMode === 'consensus' ? 'consensus' : 'best',
    autoSync: Boolean(input.autoSync),
    autoApplyNews: Boolean(input.autoApplyNews),
    bets: Array.isArray(input.bets) ? input.bets.map(normalizeBet).filter(Boolean) : [],
  };
}

function canonicalFieldKey(team) {
  return `${team.region}|${team.seed}|${team.name}`;
}

function isDemoField(candidateTeams) {
  if (!Array.isArray(candidateTeams) || candidateTeams.length !== baselineTeams.length) return false;
  const demoKeys = baselineTeams.map(canonicalFieldKey).sort();
  const candidateKeys = candidateTeams.map(canonicalFieldKey).sort();
  return demoKeys.every((key, index) => key === candidateKeys[index]);
}

async function loadOfficialSeason({ replaceExisting = true, resetWeights = false } = {}) {
  const response = await fetch(OFFICIAL_SEASON_URL);
  if (!response.ok) {
    throw new Error(`Official season request failed with ${response.status}`);
  }

  const payload = await response.json();
  seasonMeta = payload.meta || null;
  glossary = Array.isArray(payload.glossary) ? payload.glossary : [];

  if (replaceExisting && Array.isArray(payload.teams)) {
    baselineTeams = cloneTeams(payload.teams);
    teams = cloneTeams(payload.teams);
    aiPrefill = createEmptyAiPrefill();
    aiStrategyAdvice = createEmptyAiStrategyAdvice();
    tournamentState = createEmptyTournamentState();
    overlayReview = createEmptyOverlayReview();
    predictionLog = createEmptyPredictionLog();
    backgroundJobs = createEmptyBackgroundJobs();
    if (resetWeights) {
      weights = { ...defaultWeights };
    }
  }
}

async function loadBacktest() {
  backtestBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small class="eyebrow">Working</small>
      <h3>Running archive checks</h3>
      <p class="section-copy">Pulling prior NCAA bracket pages and scoring the current live weight profile.</p>
    </article>
  `;

  const response = await fetch(BACKTEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weights: currentHistoricalWeightsPayload() }),
  });
  if (!response.ok) {
    throw new Error(`Backtest request failed with ${response.status}`);
  }

  backtestResults = await response.json();
}

async function loadScoreBacktest() {
  scoreBacktestBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small class="eyebrow">Working</small>
      <h3>Replaying frozen score forecasts</h3>
      <p class="section-copy">Scoring pregame winner, margin, total, and team-score projections against archived NCAA finals without letting later outcomes rewrite the snapshot.</p>
    </article>
  `;

  const response = await fetch(SCORE_BACKTEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weights: currentHistoricalWeightsPayload() }),
  });
  if (!response.ok) {
    throw new Error(`Score backtest request failed with ${response.status}`);
  }

  scoreBacktestResults = await response.json();
}

function jobStatusUrl(jobId) {
  return `${JOB_STATUS_URL_PREFIX}${encodeURIComponent(jobId)}`;
}

function normalizeBackgroundJobRecord(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    id: input.id || '',
    kind: input.kind || 'job',
    status: input.status || 'queued',
    progress: clamp(Number(input.progress) || 0, 0, 1),
    message: input.message || '',
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
    result: input.result || null,
    error: input.error || null,
    config: input.config || null,
  };
}

function setBackgroundJob(kind, job) {
  backgroundJobs = {
    ...backgroundJobs,
    [kind]: job ? normalizeBackgroundJobRecord(job) : null,
  };
}

async function pollBackgroundJob(kind, jobId) {
  while (true) {
    const response = await fetch(jobStatusUrl(jobId));
    if (!response.ok) {
      throw new Error(`Job status request failed with ${response.status}`);
    }

    const job = normalizeBackgroundJobRecord(await response.json());
    setBackgroundJob(kind, job);
    renderAll();

    if (job.status === 'completed') return job;
    if (job.status === 'failed') {
      throw new Error(job.error || `${job.kind} job failed`);
    }

    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
}

async function startBackgroundJob(kind, url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Background job launch failed with ${response.status}`);
  }

  const { jobId } = await response.json();
  const queued = {
    id: jobId,
    kind,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    result: null,
    error: null,
    config: payload,
  };
  setBackgroundJob(kind, queued);
  renderAll();
  return pollBackgroundJob(kind, jobId);
}

function currentResearchCacheKey() {
  return JSON.stringify({
    focus: aiResearchFocusTeamNames(),
    teams: teams.map((team) => ({
      name: team.name,
      region: team.region,
      seed: team.seed,
      adjO: team.adjO,
      adjD: team.adjD,
      form: team.form,
      injuries: team.injuries,
      coach: team.coach,
      experience: team.experience,
      continuity: team.continuity,
      marketMl: team.marketMl,
    })),
    news: (liveContext.articles || []).map((article) => ({
      title: article.title,
      publishedAt: article.publishedAt,
      url: article.url,
    })),
    signals: (liveContext.teamSignals || []).map((signal) => ({
      teamName: signal.teamName,
      suggestedInjuries: signal.suggestedInjuries,
      confidence: signal.confidence,
      articleCount: signal.articleCount,
    })),
  });
}

async function loadEvolution() {
  evolutionBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small class="eyebrow">Working</small>
      <h3>Evolving robust weights</h3>
      <p class="section-copy">Searching bounded weight mutations, scoring them across archived tournaments, and then checking leave-one-year-out holdouts before making a recommendation.</p>
    </article>
  `;
  const job = await startBackgroundJob('evolution', EVOLUTION_JOB_URL, {
    populationSize: optimizerSettings.evolutionPopulation,
    generations: optimizerSettings.evolutionGenerations,
    restarts: optimizerSettings.evolutionRestarts,
    currentWeights: currentHistoricalWeightsPayload(),
  });
  evolutionResults = job.result;
}

async function loadStrategyEvolution() {
  strategyBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small class="eyebrow">Working</small>
      <h3>Evolving bankroll discipline</h3>
      <p class="section-copy">Searching edge thresholds, Kelly scaling, risk caps, confidence gates, and hedge styles across archived tournaments before recommending a live paper-trading profile.</p>
    </article>
  `;
  const job = await startBackgroundJob('strategyEvolution', STRATEGY_EVOLUTION_JOB_URL, {
    populationSize: optimizerSettings.strategyPopulation,
    generations: optimizerSettings.strategyGenerations,
    restarts: optimizerSettings.strategyRestarts,
  });
  strategyResults = job.result;
}

function applyEvolutionWeights(recommendedWeights = evolutionResults?.recommendedWeights) {
  if (!recommendedWeights) return;
  weights = {
    ...weights,
    efficiency: Number(recommendedWeights.efficiency.toFixed(1)),
    seed: Number(recommendedWeights.seed.toFixed(1)),
    fourFactors: Number(recommendedWeights.fourFactors.toFixed(1)),
    momentum: Number(recommendedWeights.momentum.toFixed(1)),
    injuries: Number(recommendedWeights.injuries.toFixed(1)),
    softFactors: Number(recommendedWeights.softFactors.toFixed(1)),
    uncertainty: Number(recommendedWeights.uncertainty.toFixed(1)),
  };
  renderWeightControls();
}

function applyStrategyProfile(recommendedProfile = strategyResults?.recommendedProfile) {
  if (!recommendedProfile) return;
  portfolio.minEdgePct = Number(recommendedProfile.minEdgePct.toFixed(2));
  portfolio.kellyMultiplier = Number(recommendedProfile.kellyMultiplier.toFixed(2));
  portfolio.maxStakePct = Number(recommendedProfile.maxStakePct.toFixed(2));
  portfolio.maxOpenRiskPct = Number(recommendedProfile.maxOpenRiskPct.toFixed(2));
  portfolio.minConfidence = Number(recommendedProfile.minConfidence.toFixed(2));
  portfolio.hedgeStyle = normalizeHedgeStyle(recommendedProfile.hedgeStyle);
}

function aiStrategyPayload(currentRound, recommendations) {
  const bankroll = computeBankrollMetrics();
  const feedbackEntries = buildBetFeedbackDataset();
  const feedbackSummary = summarizeFeedbackLoop(feedbackEntries);
  const banditSuggestion = buildBanditOverlaySuggestion(recommendations, feedbackEntries);
  const researchedAssessments = [...(aiPrefill.assessments || [])]
    .filter((assessment) => assessment.researched || assessment.confidence >= 0.45)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 8)
    .map((assessment) => ({
      teamName: assessment.teamName,
      coach: assessment.coach,
      experience: assessment.experience,
      continuity: assessment.continuity,
      injuries: assessment.injuries,
      form: assessment.form,
      confidence: assessment.confidence,
      researched: assessment.researched,
      summary: assessment.summary,
      sourceSignals: assessment.sourceSignals || [],
      sources: (assessment.sources || []).slice(0, 3),
    }));

  return {
    currentProfile: currentStrategyProfile(),
    bankroll: {
      startingBankroll: portfolio.startingBankroll,
      availableCash: bankroll.cashBalance,
      openRisk: bankroll.openRisk,
      riskBudgetLeft: remainingRiskBudget(bankroll),
      openBets: portfolio.bets.filter((bet) => bet.status === 'open').length,
      settledBets: bankroll.settledCount,
      realizedPnl: bankroll.settledPnl,
      roi: bankroll.roi,
    },
    currentRound: {
      roundLabel: currentRound.roundLabel,
      openMatchups: currentRound.matchups.length,
      topRecommendations: recommendations.slice(0, 5).map((row) => ({
        team: row.team.name,
        opponent: row.opponent.name,
        edgePct: Number((row.edge * 100).toFixed(2)),
        confidence: Number(row.confidence.toFixed(4)),
        marketMl: row.market,
        fairMl: row.fair,
        hedgeStyle: row.hedgeStyle,
        projectedMargin: Number((row.projection.teamAPoints - row.projection.teamBPoints).toFixed(1)),
        projectedTotal: Number((row.projection.teamAPoints + row.projection.teamBPoints).toFixed(1)),
      })),
    },
    liveContext: {
      oddsConfigured: Boolean(liveContext.oddsProvider?.configured),
      oddsMatchedGames: liveContext.games?.filter((game) => game.matched).length || 0,
      newsConfigured: Boolean(liveContext.newsProvider?.configured),
      articleCount: liveContext.articles?.length || 0,
      signalCount: liveContext.teamSignals?.length || 0,
      strongestSignals: (liveContext.teamSignals || []).slice(0, 4).map((signal) => ({
        teamName: signal.teamName,
        suggestedInjuries: signal.suggestedInjuries,
        confidence: signal.confidence,
        articleCount: signal.articleCount,
        summary: signal.summary,
      })),
    },
    aiAssessments: researchedAssessments,
    validation: {
      backtestAccuracy: backtestResults?.aggregate?.noLookaheadAccuracy ?? backtestResults?.aggregate?.overallAccuracy ?? null,
      averageBrier: backtestResults?.aggregate?.averageBrier ?? null,
      scoreTeamMae: scoreBacktestResults?.aggregate?.teamScoreMae ?? null,
      scoreMarginMae: scoreBacktestResults?.aggregate?.marginMae ?? null,
      scoreTotalMae: scoreBacktestResults?.aggregate?.totalMae ?? null,
      strategyRecommendedProfile: strategyResults?.recommendedProfile ?? null,
      strategyHoldoutRoi: strategyResults?.holdoutAverageRoi ?? null,
      strategyHoldoutDrawdown: strategyResults?.holdoutAverageDrawdown ?? null,
      evolutionCaution: evolutionResults?.caution ?? null,
    },
    feedbackLoop: {
      trackedBets: feedbackSummary.tracked,
      settledBets: feedbackSummary.settled,
      openBets: feedbackSummary.open,
      avgClvProbDelta: feedbackSummary.avgClvProbDelta,
      positiveClvRate: feedbackSummary.positiveClvRate,
      avgRewardScore: feedbackSummary.avgRewardScore,
      peakDrawdown: feedbackSummary.peakDrawdown,
      candidateProfile: banditSuggestion?.candidateProfile || overlayReview.response?.candidateProfile || null,
    },
  };
}

async function generateAiStrategyAdvice(currentRound, recommendations) {
  aiStrategyAdvice = {
    ...createEmptyAiStrategyAdvice(),
    provider: aiStrategyAdvice.provider || aiPrefill.provider,
    model: aiStrategyAdvice.model || aiPrefill.model,
    status: 'running',
  };
  renderAiStrategyBoard(currentRound, recommendations);

  const response = await fetch(AI_STRATEGY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(aiStrategyPayload(currentRound, recommendations)),
  });

  if (!response.ok) {
    throw new Error(`AI strategy request failed with ${response.status}`);
  }

  aiStrategyAdvice = {
    status: 'ready',
    ...await response.json(),
  };
}

function applyAiStrategyAdvice() {
  const recommendation = aiStrategyAdvice.recommendation;
  if (!recommendation?.profile) return;
  applyStrategyProfile(recommendation.profile);
  portfolio.autoRefreshMinutes = clamp(Math.round(recommendation.autoRefreshMinutes || portfolio.autoRefreshMinutes), 1, 60);
  portfolio.liveOddsMode = recommendation.liveOddsMode === 'consensus' ? 'consensus' : 'best';
  portfolio.autoSync = Boolean(recommendation.autoSync);
  portfolio.autoApplyNews = Boolean(recommendation.autoApplyNews);
  syncAutoRefreshTimer();
}

async function persistState() {
  if (tauriInvoke) {
    await tauriInvoke('save_state', { payload: serializeState() });
    return;
  }

  await fetch(API_STATE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serializeState()),
  });
}

function schedulePersistState() {
  window.clearTimeout(persistTimeout);
  persistTimeout = window.setTimeout(() => {
    persistState().catch((error) => {
      console.warn('Failed to persist sqlite state', error);
    });
  }, 250);
}

async function loadPersistedState() {
  try {
    let parsed;
    if (tauriInvoke) {
      parsed = await tauriInvoke('get_state');
    } else {
      const response = await fetch(API_STATE_URL);
      if (!response.ok) return false;
      parsed = await response.json();
    }

    if (parsed && Array.isArray(parsed.teams) && parsed.weights) {
      teams = parsed.teams;
      weights = { ...defaultWeights, ...parsed.weights };
      baselineTeams = cloneTeams(parsed.teams);
      portfolio = normalizePortfolio(parsed.portfolio);
      tournamentState = normalizeTournamentState(parsed.tournament);
      predictionLog = normalizePredictionLog(parsed.predictionLog);
      aiPrefill = normalizeAiPrefill(parsed.aiPrefill);
      optimizerSettings = normalizeOptimizerSettings(parsed.optimizerSettings);
      aiStrategyAdvice = createEmptyAiStrategyAdvice();
      overlayReview = createEmptyOverlayReview();
      return true;
    }
  } catch (error) {
    console.warn('Failed to load saved sqlite state', error);
  }

  return false;
}

async function clearStorageAndRestart() {
  const confirmed = window.confirm('Clear the saved database state and reset this app to a fresh 2026 baseline?');
  if (!confirmed) return;

  clearStorageButton.disabled = true;
  try {
    if (tauriInvoke) {
      await tauriInvoke('clear_state');
    } else {
      const response = await fetch(API_STATE_URL, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Clear state request failed with ${response.status}`);
      }
    }

    resetAppStateToFreshStart();
    setActiveWorkspace('overview');

    try {
      await loadProviderStatus();
    } catch (error) {
      console.warn('Failed to refresh provider status after clearing state', error);
    }

    try {
      await loadOfficialSeason({ replaceExisting: true, resetWeights: true });
    } catch (error) {
      console.warn('Failed to reload official season after clearing state', error);
    }

    renderWeightControls();
    renderAll();
    runTournamentSimulation(simulationState.iterations, buildTournamentBracketState()).catch((error) => {
      console.warn('Failed to run fresh Monte Carlo simulation after clearing state', error);
      simulationState = {
        ...simulationState,
        status: 'idle',
      };
      renderSimulationStatus(currentSimulationSignature());
    });
  } finally {
    clearStorageButton.disabled = false;
  }
}

function exportState() {
  const blob = new Blob([JSON.stringify(serializeState(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'madness-oracle-picks.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function importState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed.teams) || !parsed.weights) {
        throw new Error('Invalid export format');
      }
      teams = parsed.teams;
      baselineTeams = cloneTeams(parsed.teams);
      weights = { ...defaultWeights, ...parsed.weights };
      portfolio = normalizePortfolio(parsed.portfolio);
      tournamentState = normalizeTournamentState(parsed.tournament);
      predictionLog = normalizePredictionLog(parsed.predictionLog);
      aiPrefill = normalizeAiPrefill(parsed.aiPrefill);
      optimizerSettings = normalizeOptimizerSettings(parsed.optimizerSettings);
      aiStrategyAdvice = createEmptyAiStrategyAdvice();
      overlayReview = createEmptyOverlayReview();
      renderWeightControls();
      renderAll();
      schedulePersistState();
    } catch (error) {
      alert('Import failed: invalid JSON export file.');
    }
  };
  reader.readAsText(file);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function estimatePace(team) {
  if (Number.isFinite(team.pace) && team.pace > 0) return team.pace;
  if (Number.isFinite(team.pointsPerGame) && Number.isFinite(team.adjO) && team.adjO > 0) {
    return clamp((team.pointsPerGame / team.adjO) * 100, 60, 78);
  }
  return clamp(71 - (team.seed - 8) * 0.22, 63, 76);
}

function projectScore(teamA, teamB) {
  const pace = average([estimatePace(teamA), estimatePace(teamB)]);
  const teamAPoints = pace * ((teamA.adjO + teamB.adjD) / 2) / 100;
  const teamBPoints = pace * ((teamB.adjO + teamA.adjD) / 2) / 100;
  return {
    pace: Number(pace.toFixed(1)),
    teamAPoints: Number(teamAPoints.toFixed(1)),
    teamBPoints: Number(teamBPoints.toFixed(1)),
  };
}

function americanToImpliedProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function probabilityToAmerican(probability) {
  const p = clamp(probability, 0.001, 0.999);
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function americanToDecimal(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
}

function projectedProfit(stake, odds) {
  if (!Number.isFinite(stake) || !Number.isFinite(odds)) return 0;
  return odds > 0
    ? stake * (odds / 100)
    : stake * (100 / Math.abs(odds));
}

function kellyFraction(probability, odds) {
  const decimal = americanToDecimal(odds);
  if (!decimal) return 0;
  const netOdds = decimal - 1;
  const losingProbability = 1 - probability;
  return Math.max(0, ((netOdds * probability) - losingProbability) / netOdds);
}

function roundCurrency(value) {
  return Number((value || 0).toFixed(2));
}

function formatCurrency(value) {
  return `$${roundCurrency(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedCurrency(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

function formatMoneyline(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${Math.round(value)}`;
}

function formatSignedNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatInteger(value) {
  return Math.round(value || 0).toLocaleString();
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function currentSimulationSignature() {
  return JSON.stringify({
    weights,
    teams,
    tournament: tournamentState.games.map((game) => ({
      contestId: game.contestId,
      roundIndex: game.roundIndex,
      region: game.region,
      gameState: game.gameState,
      startTime: game.startTime,
      teamA: game.teamA,
      teamB: game.teamB,
    })),
  });
}

function currentHistoricalWeightsPayload() {
  return {
    efficiency: Number(weights.efficiency),
    seed: Number(weights.seed),
    fourFactors: Number(weights.fourFactors),
    momentum: Number(weights.momentum),
    injuries: Number(weights.injuries),
    softFactors: Number(weights.softFactors),
    uncertainty: Number(weights.uncertainty),
  };
}

function historicalWeightsSignature(input = currentHistoricalWeightsPayload()) {
  const payload = {
    efficiency: Number(input?.efficiency || 0),
    seed: Number(input?.seed || 0),
    fourFactors: Number(input?.fourFactors || 0),
    momentum: Number(input?.momentum || 0),
    injuries: Number(input?.injuries || 0),
    softFactors: Number(input?.softFactors || 0),
    uncertainty: Number(input?.uncertainty || 0),
  };
  return JSON.stringify(payload);
}

function historicalResultsAreCurrent(results) {
  return historicalWeightsSignature(results?.weightsUsed) === historicalWeightsSignature();
}

function createEmptySimulationResult() {
  return {
    championOdds: [],
    sampleBracket: null,
    averageUpsetSeed: 0,
  };
}

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findTeamByName(name) {
  const normalized = normalizeTeamName(name);
  return teams.find((team) => normalizeTeamName(team.name) === normalized) || null;
}

function teamSignalByName(name) {
  const normalized = normalizeTeamName(name);
  return (liveContext.teamSignals || []).find((signal) => normalizeTeamName(signal.teamName) === normalized) || null;
}

function confidenceBucket(confidence) {
  if (!Number.isFinite(confidence)) return 'unknown';
  if (confidence < 0.62) return 'guarded';
  if (confidence < 0.75) return 'firm';
  return 'strong';
}

function edgeBucket(edge) {
  if (!Number.isFinite(edge)) return 'unknown';
  if (edge < 0.05) return 'thin';
  if (edge < 0.1) return 'solid';
  return 'wide';
}

function roundBucket(roundIndex) {
  return Number(roundIndex) <= 1 ? 'early' : 'late';
}

function newsBucket(riskScore) {
  return riskScore >= 3 ? 'noisy' : 'clean';
}

function aggressionProfileKey(profile = portfolio) {
  if (!profile) return 'balanced';
  if (
    profile.kellyMultiplier <= aggressionProfiles.conservative.kellyMultiplier + 0.05
    || profile.maxStakePct <= aggressionProfiles.conservative.maxStakePct + 0.5
    || profile.maxOpenRiskPct <= aggressionProfiles.conservative.maxOpenRiskPct + 2
  ) {
    return 'conservative';
  }
  if (
    profile.kellyMultiplier >= aggressionProfiles.aggressive.kellyMultiplier - 0.05
    || profile.maxStakePct >= aggressionProfiles.aggressive.maxStakePct - 0.5
    || profile.maxOpenRiskPct >= aggressionProfiles.aggressive.maxOpenRiskPct - 2
  ) {
    return 'aggressive';
  }
  return 'balanced';
}

function currentStrategyProfile() {
  return {
    minEdgePct: Number(portfolio.minEdgePct.toFixed(2)),
    kellyMultiplier: Number(portfolio.kellyMultiplier.toFixed(2)),
    maxStakePct: Number(portfolio.maxStakePct.toFixed(2)),
    maxOpenRiskPct: Number(portfolio.maxOpenRiskPct.toFixed(2)),
    minConfidence: Number(portfolio.minConfidence.toFixed(2)),
    hedgeStyle: strategyCompatibleHedgeStyle(portfolio.hedgeStyle),
  };
}

function deriveRecommendationContext(recommendation) {
  const teamSignal = teamSignalByName(recommendation.team.name);
  const opponentSignal = teamSignalByName(recommendation.opponent.name);
  const newsRiskScore = Math.max(
    Number(teamSignal?.suggestedInjuries || 0),
    Number(opponentSignal?.suggestedInjuries || 0),
  );
  const newsArticleCount = Number(teamSignal?.articleCount || 0) + Number(opponentSignal?.articleCount || 0);
  const snapshot = {
    roundIndex: recommendation.roundIndex,
    roundLabel: recommendation.roundLabel,
    roundBucket: roundBucket(recommendation.roundIndex),
    confidence: recommendation.confidence,
    confidenceBucket: confidenceBucket(recommendation.confidence),
    edge: recommendation.edge,
    edgeBucket: edgeBucket(recommendation.edge),
    marketSide: recommendation.market > 0 ? 'underdog' : 'favorite',
    newsRiskScore: Number(newsRiskScore.toFixed(2)),
    newsBucket: newsBucket(newsRiskScore),
    newsArticleCount,
    teamSignal: teamSignal ? {
      teamName: recommendation.team.name,
      suggestedInjuries: teamSignal.suggestedInjuries,
      articleCount: teamSignal.articleCount,
    } : null,
    opponentSignal: opponentSignal ? {
      teamName: recommendation.opponent.name,
      suggestedInjuries: opponentSignal.suggestedInjuries,
      articleCount: opponentSignal.articleCount,
    } : null,
  };
  snapshot.contextKey = [
    snapshot.roundBucket,
    snapshot.confidenceBucket,
    snapshot.edgeBucket,
    snapshot.newsBucket,
    snapshot.marketSide,
  ].join('|');
  return snapshot;
}

function strategySnapshotForBet() {
  return {
    ...currentStrategyProfile(),
    aggression: aggressionProfileKey(portfolio),
  };
}

function overlayCandidateProfile(baseProfile, suggestion) {
  const aggression = aggressionProfiles[suggestion.aggression] || aggressionProfiles.balanced;
  return {
    minEdgePct: Number(suggestion.minEdgePct.toFixed(2)),
    kellyMultiplier: aggression.kellyMultiplier,
    maxStakePct: aggression.maxStakePct,
    maxOpenRiskPct: aggression.maxOpenRiskPct,
    minConfidence: Number((baseProfile.minConfidence || portfolio.minConfidence).toFixed(2)),
    hedgeStyle: normalizeHedgeStyle(suggestion.hedgeStyle),
  };
}

function removeVig(probA, probB) {
  if (probA === null || probB === null) return null;
  const total = probA + probB;
  if (!total) return null;
  return { probA: probA / total, probB: probB / total, hold: total - 1 };
}

function fourFactorScore(team) {
  return team.efg * 0.45 + (18 - team.tov) * 1.3 + team.orb * 1.15 + team.ftr * 0.08;
}

function softScore(team) {
  return team.coach * 0.4 + team.experience * 0.35 + team.continuity * 0.25;
}

function activeResearchAssessments() {
  if (!portfolio.useResearchCache || !Array.isArray(aiPrefill.assessments)) return [];
  return aiPrefill.assessments.filter((assessment) => (assessment.researched || assessment.confidence >= 0.2));
}

function researchAssessmentByName(name) {
  const normalized = normalizeTeamName(name);
  return activeResearchAssessments().find((assessment) => normalizeTeamName(assessment.teamName) === normalized) || null;
}

function effectiveTeamForModel(team) {
  const assessment = researchAssessmentByName(team.name);
  if (!assessment) return team;

  return {
    ...team,
    coach: Number(clamp(assessment.coach, 0, 10).toFixed(1)),
    experience: Number(clamp(assessment.experience, 0, 10).toFixed(1)),
    continuity: Number(clamp(assessment.continuity, 0, 10).toFixed(1)),
    injuries: Number(clamp(assessment.injuries, 0, 10).toFixed(1)),
    form: Number(clamp(assessment.form, 0, 10).toFixed(1)),
  };
}

function teamScore(team) {
  const efficiencyMargin = team.adjO - team.adjD;
  const seedBoost = 17 - team.seed;
  return Number((
    efficiencyMargin * (weights.efficiency / 24) +
    seedBoost * (weights.seed / 7) +
    fourFactorScore(team) * (weights.fourFactors / 24) +
    team.form * (weights.momentum / 7) -
    team.injuries * (weights.injuries / 5) +
    softScore(team) * (weights.softFactors / 10)
  ).toFixed(2));
}

function regionTeams(region) {
  return teams
    .filter((team) => team.region === region)
    .map((team) => effectiveTeamForModel({ ...team }))
    .sort((a, b) => a.seed - b.seed || a.name.localeCompare(b.name));
}

function matchupBySeeds(region, seedA, seedB) {
  const regionalTeams = regionTeams(region);
  const teamA = regionalTeams.find((team) => team.seed === seedA) || regionalTeams[seedA - 1];
  const teamB = regionalTeams.find((team) => team.seed === seedB) || regionalTeams[seedB - 1];
  return [teamA, teamB];
}

function seedPriorProbability(teamA, teamB, roundIndex) {
  const gap = teamB.seed - teamA.seed;
  const roundMultiplier = [1.05, 0.95, 0.8, 0.7, 0.65, 0.6][roundIndex] || 0.6;
  return clamp(sigmoid(gap * 0.22 * roundMultiplier), 0.05, 0.95);
}

function marketPriorProbability(teamA, teamB) {
  const probA = americanToImpliedProbability(teamA.marketMl);
  const probB = americanToImpliedProbability(teamB.marketMl);
  const noVig = removeVig(probA, probB);
  return noVig ? noVig.probA : null;
}

function modelProbability(teamA, teamB, roundIndex) {
  const efficiencyGap = (teamA.adjO - teamA.adjD) - (teamB.adjO - teamB.adjD);
  const fourFactorGap = fourFactorScore(teamA) - fourFactorScore(teamB);
  const formGap = teamA.form - teamB.form;
  const injuryGap = teamB.injuries - teamA.injuries;
  const softGap = softScore(teamA) - softScore(teamB);
  const roundBoost = [0.95, 1.0, 1.05, 1.1, 1.12, 1.15][roundIndex] || 1.15;

  const latent =
    (efficiencyGap / 8.5) * (weights.efficiency / 18) * roundBoost +
    (fourFactorGap / 5.5) * (weights.fourFactors / 18) +
    (formGap / 2.8) * (weights.momentum / 10) +
    injuryGap * (weights.injuries / 10) +
    (softGap / 2.2) * (weights.softFactors / 12);

  return clamp(sigmoid(latent), 0.03, 0.97);
}

function blendedProbability(teamA, teamB, roundIndex) {
  const pureModel = modelProbability(teamA, teamB, roundIndex);
  const seedPrior = seedPriorProbability(teamA, teamB, roundIndex);
  const marketPrior = marketPriorProbability(teamA, teamB);
  const volatility = clamp((teamA.injuries + teamB.injuries + Math.abs(teamA.form - teamB.form) / 2 + Math.abs(teamA.experience - teamB.experience) / 4) / 10, 0, 0.35);
  const uncertaintyPull = (weights.uncertainty / 20) * volatility;

  const available = [
    { value: pureModel, weight: 1 },
    { value: seedPrior, weight: Math.max(weights.seed, 0) / 12 },
  ];

  if (marketPrior !== null) {
    available.push({ value: marketPrior, weight: weights.marketBlend / 12 });
  }

  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);
  let blended = available.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  blended = blended * (1 - uncertaintyPull) + 0.5 * uncertaintyPull;

  return {
    probabilityA: clamp(blended, 0.02, 0.98),
    pureModel,
    seedPrior,
    marketPrior,
    volatility,
    uncertaintyPull,
  };
}

function tournamentGameIsFinal(game) {
  return String(game?.gameState || '').toUpperCase() === 'F' || String(game?.statusDisplay || '').toLowerCase() === 'final';
}

function tournamentGameIsInProgress(game) {
  const state = String(game?.gameState || '').toUpperCase();
  return !tournamentGameIsFinal(game) && ['I', 'IP', 'L'].includes(state);
}

function tournamentWinnerId(game) {
  if (!game) return null;
  if (game.teamA?.isWinner) return game.teamA.teamId || game.teamA.name;
  if (game.teamB?.isWinner) return game.teamB.teamId || game.teamB.name;
  return null;
}

function teamsMatchByReference(syncTeam, team) {
  if (!syncTeam || !team) return false;
  if (syncTeam.teamId && team.id) return syncTeam.teamId === team.id;
  return normalizeTeamName(syncTeam.name) === normalizeTeamName(team.name);
}

function syncedGameMatchesSlot(syncGame, slot) {
  return (
    (teamsMatchByReference(syncGame.teamA, slot.teamA) && teamsMatchByReference(syncGame.teamB, slot.teamB)) ||
    (teamsMatchByReference(syncGame.teamA, slot.teamB) && teamsMatchByReference(syncGame.teamB, slot.teamA))
  );
}

function matchupFromBracketGame(game) {
  if (!game?.teamA || !game?.teamB) return null;
  const blended = blendedProbability(game.teamA, game.teamB, game.roundIndex);
  const projection = projectScore(game.teamA, game.teamB);
  const impliedA = americanToImpliedProbability(game.teamA.marketMl);
  const impliedB = americanToImpliedProbability(game.teamB.marketMl);
  const noVig = removeVig(impliedA, impliedB);
  const marketA = noVig ? noVig.probA : impliedA;
  const marketB = noVig ? noVig.probB : impliedB;
  const edgeA = marketA === null ? null : blended.probabilityA - marketA;
  const edgeB = marketB === null ? null : 1 - blended.probabilityA - marketB;
  const confidence = clamp(1 - blended.uncertaintyPull + Math.abs(blended.probabilityA - 0.5), 0, 1);

  return {
    key: game.key,
    contestId: game.contestId || null,
    region: game.region,
    roundIndex: game.roundIndex,
    roundLabel: tournamentRoundLabels[game.roundIndex] || 'Tournament',
    teamA: game.teamA,
    teamB: game.teamB,
    probabilityA: blended.probabilityA,
    components: blended,
    hold: noVig ? noVig.hold : null,
    marketA,
    marketB,
    edgeA,
    edgeB,
    confidence,
    projection,
    statusDisplay: game.statusDisplay || '',
    gameState: game.gameState || '',
    startTime: game.startTime || null,
    gameUrl: game.gameUrl || null,
    scoreA: Number.isFinite(game.scoreA) ? game.scoreA : null,
    scoreB: Number.isFinite(game.scoreB) ? game.scoreB : null,
    actualWinnerId: game.actualWinnerId || null,
  };
}

function buildTournamentBracketState() {
  const rounds = Array.from({ length: 6 }, () => []);
  const gameMap = new Map();

  regions.forEach((region) => {
    firstRoundSeedPairs.forEach(([seedA, seedB], slotIndex) => {
      const [teamA, teamB] = matchupBySeeds(region, seedA, seedB);
      const game = {
        key: `r0-${region}-${slotIndex}`,
        roundIndex: 0,
        region,
        slotIndex,
        parentKeys: [],
        teamA,
        teamB,
        winner: null,
        actualWinnerId: null,
        syncedGame: null,
        contestId: null,
        startTime: null,
        gameUrl: null,
        statusDisplay: '',
        gameState: '',
        scoreA: null,
        scoreB: null,
      };
      rounds[0].push(game);
      gameMap.set(game.key, game);
    });

    for (let roundIndex = 1; roundIndex <= 3; roundIndex += 1) {
      const priorCount = rounds[roundIndex - 1].filter((game) => game.region === region).length;
      const gameCount = priorCount / 2;
      for (let slotIndex = 0; slotIndex < gameCount; slotIndex += 1) {
        const game = {
          key: `r${roundIndex}-${region}-${slotIndex}`,
          roundIndex,
          region,
          slotIndex,
          parentKeys: [`r${roundIndex - 1}-${region}-${slotIndex * 2}`, `r${roundIndex - 1}-${region}-${slotIndex * 2 + 1}`],
          teamA: null,
          teamB: null,
          winner: null,
          actualWinnerId: null,
          syncedGame: null,
          contestId: null,
          startTime: null,
          gameUrl: null,
          statusDisplay: '',
          gameState: '',
          scoreA: null,
          scoreB: null,
        };
        rounds[roundIndex].push(game);
        gameMap.set(game.key, game);
      }
    }
  });

  [
    ['East', 'West'],
    ['South', 'Midwest'],
  ].forEach(([regionA, regionB], slotIndex) => {
    const game = {
      key: `r4-final-four-${slotIndex}`,
      roundIndex: 4,
      region: 'Final Four',
      slotIndex,
      parentKeys: [`r3-${regionA}-0`, `r3-${regionB}-0`],
      teamA: null,
      teamB: null,
      winner: null,
      actualWinnerId: null,
      syncedGame: null,
      contestId: null,
      startTime: null,
      gameUrl: null,
      statusDisplay: '',
      gameState: '',
      scoreA: null,
      scoreB: null,
    };
    rounds[4].push(game);
    gameMap.set(game.key, game);
  });

  const titleGame = {
    key: 'r5-championship-0',
    roundIndex: 5,
    region: 'Championship',
    slotIndex: 0,
    parentKeys: ['r4-final-four-0', 'r4-final-four-1'],
    teamA: null,
    teamB: null,
    winner: null,
    actualWinnerId: null,
    syncedGame: null,
    contestId: null,
    startTime: null,
    gameUrl: null,
    statusDisplay: '',
    gameState: '',
    scoreA: null,
    scoreB: null,
  };
  rounds[5].push(titleGame);
  gameMap.set(titleGame.key, titleGame);

  const pools = new Map(
    tournamentRoundLabels.map((_, roundIndex) => [
      roundIndex,
      tournamentState.games.filter((game) => game.roundIndex === roundIndex),
    ])
  );

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    rounds[roundIndex].forEach((game) => {
      if (roundIndex > 0) {
        const parentA = gameMap.get(game.parentKeys[0]);
        const parentB = gameMap.get(game.parentKeys[1]);
        game.teamA = parentA?.winner || null;
        game.teamB = parentB?.winner || null;
      }

      if (!game.teamA || !game.teamB) return;

      const pool = pools.get(roundIndex) || [];
      const matchedIndex = pool.findIndex((syncGame) => syncedGameMatchesSlot(syncGame, game));
      if (matchedIndex !== -1) {
        const [syncedGame] = pool.splice(matchedIndex, 1);
        game.syncedGame = syncedGame;
        game.contestId = syncedGame.contestId || null;
        game.startTime = syncedGame.startTime || null;
        game.gameUrl = syncedGame.gameUrl || null;
        game.statusDisplay = syncedGame.statusDisplay || '';
        game.gameState = syncedGame.gameState || '';
        game.scoreA = syncedGame.teamA.score;
        game.scoreB = syncedGame.teamB.score;
        game.actualWinnerId = tournamentWinnerId(syncedGame);
      }

      if (game.actualWinnerId) {
        game.winner = game.actualWinnerId === game.teamA.id || normalizeTeamName(game.actualWinnerId) === normalizeTeamName(game.teamA.name)
          ? game.teamA
          : game.teamB;
      }
    });
  }

  return { rounds, gameMap };
}

function firstRoundMatchups() {
  return buildTournamentBracketState().rounds[0]
    .map(matchupFromBracketGame)
    .filter(Boolean);
}

function currentTournamentRound(bracketState = buildTournamentBracketState()) {
  const openRoundIndex = bracketState.rounds.findIndex((games) => games.some((game) => game.teamA && game.teamB && !game.actualWinnerId));
  const roundIndex = openRoundIndex === -1 ? 5 : openRoundIndex;
  const games = openRoundIndex === -1
    ? []
    : bracketState.rounds[roundIndex].filter((game) => game.teamA && game.teamB && !game.actualWinnerId);

  return {
    roundIndex,
    roundLabel: openRoundIndex === -1 ? 'Tournament complete' : (tournamentRoundLabels[roundIndex] || 'Tournament'),
    matchups: games.map(matchupFromBracketGame).filter(Boolean),
  };
}

function snapshotPredictionTeam(team) {
  if (!team) return null;
  return {
    id: team.id || '',
    name: team.name || 'Unknown team',
    seed: Number.isFinite(Number(team.seed)) ? Number(team.seed) : null,
    adjO: Number.isFinite(Number(team.adjO)) ? Number(team.adjO) : null,
    adjD: Number.isFinite(Number(team.adjD)) ? Number(team.adjD) : null,
    efg: Number.isFinite(Number(team.efg)) ? Number(team.efg) : null,
    tov: Number.isFinite(Number(team.tov)) ? Number(team.tov) : null,
    orb: Number.isFinite(Number(team.orb)) ? Number(team.orb) : null,
    ftr: Number.isFinite(Number(team.ftr)) ? Number(team.ftr) : null,
    form: Number.isFinite(Number(team.form)) ? Number(team.form) : null,
    injuries: Number.isFinite(Number(team.injuries)) ? Number(team.injuries) : null,
    coach: Number.isFinite(Number(team.coach)) ? Number(team.coach) : null,
    experience: Number.isFinite(Number(team.experience)) ? Number(team.experience) : null,
    continuity: Number.isFinite(Number(team.continuity)) ? Number(team.continuity) : null,
    marketMl: Number.isFinite(Number(team.marketMl)) ? Number(team.marketMl) : null,
    pace: Number.isFinite(Number(team.pace)) ? Number(team.pace) : null,
    pointsPerGame: Number.isFinite(Number(team.pointsPerGame)) ? Number(team.pointsPerGame) : null,
  };
}

function predictionEntryMatchesMatchup(entry, matchup) {
  if (!entry || !matchup) return false;
  if (Number.isFinite(entry.contestId) && Number.isFinite(matchup.contestId)) {
    return entry.contestId === matchup.contestId;
  }

  if (entry.roundIndex !== matchup.roundIndex) return false;

  const directIds = entry.teamAId && entry.teamBId
    && entry.teamAId === matchup.teamA.id
    && entry.teamBId === matchup.teamB.id;
  const swappedIds = entry.teamAId && entry.teamBId
    && entry.teamAId === matchup.teamB.id
    && entry.teamBId === matchup.teamA.id;
  if (directIds || swappedIds) return true;

  const entryA = normalizeTeamName(entry.teamAName);
  const entryB = normalizeTeamName(entry.teamBName);
  const matchupA = normalizeTeamName(matchup.teamA.name);
  const matchupB = normalizeTeamName(matchup.teamB.name);
  return (entryA === matchupA && entryB === matchupB) || (entryA === matchupB && entryB === matchupA);
}

function predictionTeamMatchesFeedTeam(teamId, teamName, feedTeam) {
  if (!feedTeam) return false;
  if (teamId && feedTeam.teamId) return teamId === feedTeam.teamId;
  return normalizeTeamName(teamName) === normalizeTeamName(feedTeam.name);
}

function predictionEntryGamePerspective(entry, game) {
  const direct = predictionTeamMatchesFeedTeam(entry.teamAId, entry.teamAName, game.teamA)
    && predictionTeamMatchesFeedTeam(entry.teamBId, entry.teamBName, game.teamB);
  if (direct) {
    return {
      teamA: game.teamA,
      teamB: game.teamB,
    };
  }

  const swapped = predictionTeamMatchesFeedTeam(entry.teamAId, entry.teamAName, game.teamB)
    && predictionTeamMatchesFeedTeam(entry.teamBId, entry.teamBName, game.teamA);
  if (swapped) {
    return {
      teamA: game.teamB,
      teamB: game.teamA,
    };
  }

  return null;
}

function resolveTournamentGameForPrediction(entry, games = tournamentState.games) {
  return (games || []).find((game) => {
    if (Number.isFinite(entry.contestId) && Number.isFinite(game.contestId)) {
      return entry.contestId === game.contestId;
    }
    if (entry.roundIndex !== game.roundIndex) return false;
    return Boolean(predictionEntryGamePerspective(entry, game));
  }) || null;
}

function createPredictionEntry(matchup) {
  if (!matchup || tournamentGameIsFinal(matchup) || tournamentGameIsInProgress(matchup)) return null;
  const lockedAt = new Date().toISOString();
  const predictedWinner = matchup.probabilityA >= 0.5 ? matchup.teamA : matchup.teamB;
  return normalizePredictionEntry({
    id: `prediction-${matchup.roundIndex}-${matchup.contestId || matchup.key || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lockedAt,
    gradedAt: null,
    dataCutoff: lockedAt,
    seasonYear: seasonMeta?.year || 2026,
    roundIndex: matchup.roundIndex,
    roundLabel: matchup.roundLabel,
    region: matchup.region,
    contestId: matchup.contestId,
    startTime: matchup.startTime,
    status: 'locked',
    teamAId: matchup.teamA.id,
    teamAName: matchup.teamA.name,
    teamASeed: matchup.teamA.seed,
    teamBId: matchup.teamB.id,
    teamBName: matchup.teamB.name,
    teamBSeed: matchup.teamB.seed,
    probabilityA: matchup.probabilityA,
    predictedWinnerId: predictedWinner.id,
    predictedWinnerName: predictedWinner.name,
    fairTeamAMl: probabilityToAmerican(matchup.probabilityA),
    fairTeamBMl: probabilityToAmerican(1 - matchup.probabilityA),
    marketTeamAMl: matchup.teamA.marketMl,
    marketTeamBMl: matchup.teamB.marketMl,
    confidence: matchup.confidence,
    projectedPace: matchup.projection.pace,
    projectedTeamAScore: matchup.projection.teamAPoints,
    projectedTeamBScore: matchup.projection.teamBPoints,
    projectedMargin: matchup.projection.teamAPoints - matchup.projection.teamBPoints,
    projectedTotal: matchup.projection.teamAPoints + matchup.projection.teamBPoints,
    weightsSnapshot: { ...weights },
    teamASnapshot: snapshotPredictionTeam(matchup.teamA),
    teamBSnapshot: snapshotPredictionTeam(matchup.teamB),
  });
}

function freezeCurrentRoundPredictions(currentRound = currentTournamentRound(buildTournamentBracketState())) {
  let added = 0;
  let skipped = 0;
  const nextEntries = [...predictionLog.entries];

  currentRound.matchups.forEach((matchup) => {
    const existing = nextEntries.find((entry) => predictionEntryMatchesMatchup(entry, matchup));
    if (existing || tournamentGameIsFinal(matchup) || tournamentGameIsInProgress(matchup)) {
      skipped += 1;
      return;
    }

    const entry = createPredictionEntry(matchup);
    if (!entry) {
      skipped += 1;
      return;
    }
    nextEntries.unshift(entry);
    added += 1;
  });

  predictionLog = {
    ...predictionLog,
    lastLockedAt: added ? new Date().toISOString() : predictionLog.lastLockedAt,
    lastLockSummary: added
      ? `Locked ${added} pregame ${added === 1 ? 'forecast' : 'forecasts'} for ${currentRound.roundLabel}. Skipped ${skipped} game${skipped === 1 ? '' : 's'} that were already frozen or no longer pregame.`
      : `No new pregame forecasts were locked for ${currentRound.roundLabel}. ${skipped ? `Skipped ${skipped} game${skipped === 1 ? '' : 's'} because they were already frozen or already underway.` : 'There may not be an open round yet.'}`,
    entries: nextEntries,
  };

  gradePredictionLogFromTournament(tournamentState.games);
  return { added, skipped };
}

function gradePredictionLogFromTournament(games = tournamentState.games) {
  let gradedCount = 0;

  predictionLog = {
    ...predictionLog,
    entries: predictionLog.entries.map((entry) => {
      if (entry.status === 'graded') return entry;
      const game = resolveTournamentGameForPrediction(entry, games);
      if (!game || !tournamentGameIsFinal(game)) return entry;

      const perspective = predictionEntryGamePerspective(entry, game) || {
        teamA: game.teamA,
        teamB: game.teamB,
      };
      const actualWinner = perspective.teamA.isWinner ? perspective.teamA : perspective.teamB;
      gradedCount += 1;
      return normalizePredictionEntry({
        ...entry,
        status: 'graded',
        gradedAt: new Date().toISOString(),
        actualTeamAScore: perspective.teamA.score,
        actualTeamBScore: perspective.teamB.score,
        actualWinnerId: actualWinner.teamId || actualWinner.name,
        actualWinnerName: actualWinner.name,
        winnerCorrect: (
          (entry.predictedWinnerId && actualWinner.teamId && entry.predictedWinnerId === actualWinner.teamId)
          || normalizeTeamName(entry.predictedWinnerName || entry.teamAName) === normalizeTeamName(actualWinner.name)
        ),
      });
    }),
  };

  if (gradedCount) {
    predictionLog.lastGradedAt = new Date().toISOString();
  }

  return gradedCount;
}

function predictionEntryErrors(entry) {
  if (
    !entry
    || entry.status !== 'graded'
    || !Number.isFinite(entry.actualTeamAScore)
    || !Number.isFinite(entry.actualTeamBScore)
  ) {
    return null;
  }

  const teamAError = entry.projectedTeamAScore - entry.actualTeamAScore;
  const teamBError = entry.projectedTeamBScore - entry.actualTeamBScore;
  const predictedMargin = entry.projectedTeamAScore - entry.projectedTeamBScore;
  const actualMargin = entry.actualTeamAScore - entry.actualTeamBScore;
  const predictedTotal = entry.projectedTeamAScore + entry.projectedTeamBScore;
  const actualTotal = entry.actualTeamAScore + entry.actualTeamBScore;

  return {
    teamScoreAbs: Math.abs(teamAError) + Math.abs(teamBError),
    teamScoreSq: (teamAError ** 2) + (teamBError ** 2),
    marginAbs: Math.abs(predictedMargin - actualMargin),
    marginSq: (predictedMargin - actualMargin) ** 2,
    totalAbs: Math.abs(predictedTotal - actualTotal),
    totalSq: (predictedTotal - actualTotal) ** 2,
  };
}

function buildPredictionLogMetrics() {
  const entries = predictionLog.entries;
  const graded = entries.filter((entry) => entry.status === 'graded');
  const locked = entries.filter((entry) => entry.status === 'locked');

  const totals = graded.reduce((accumulator, entry) => {
    const errors = predictionEntryErrors(entry);
    if (!errors) return accumulator;

    return {
      games: accumulator.games + 1,
      winnerCorrect: accumulator.winnerCorrect + (entry.winnerCorrect ? 1 : 0),
      teamScoreAbs: accumulator.teamScoreAbs + errors.teamScoreAbs,
      teamScoreSq: accumulator.teamScoreSq + errors.teamScoreSq,
      marginAbs: accumulator.marginAbs + errors.marginAbs,
      marginSq: accumulator.marginSq + errors.marginSq,
      totalAbs: accumulator.totalAbs + errors.totalAbs,
      totalSq: accumulator.totalSq + errors.totalSq,
    };
  }, {
    games: 0,
    winnerCorrect: 0,
    teamScoreAbs: 0,
    teamScoreSq: 0,
    marginAbs: 0,
    marginSq: 0,
    totalAbs: 0,
    totalSq: 0,
  });

  const rounds = tournamentRoundLabels
    .map((label, roundIndex) => {
      const roundEntries = graded.filter((entry) => entry.roundIndex === roundIndex);
      if (!roundEntries.length) return null;

      const roundTotals = roundEntries.reduce((accumulator, entry) => {
        const errors = predictionEntryErrors(entry);
        if (!errors) return accumulator;
        return {
          games: accumulator.games + 1,
          winnerCorrect: accumulator.winnerCorrect + (entry.winnerCorrect ? 1 : 0),
          teamScoreAbs: accumulator.teamScoreAbs + errors.teamScoreAbs,
          teamScoreSq: accumulator.teamScoreSq + errors.teamScoreSq,
          marginAbs: accumulator.marginAbs + errors.marginAbs,
          marginSq: accumulator.marginSq + errors.marginSq,
          totalAbs: accumulator.totalAbs + errors.totalAbs,
          totalSq: accumulator.totalSq + errors.totalSq,
        };
      }, {
        games: 0,
        winnerCorrect: 0,
        teamScoreAbs: 0,
        teamScoreSq: 0,
        marginAbs: 0,
        marginSq: 0,
        totalAbs: 0,
        totalSq: 0,
      });

      return {
        label,
        games: roundTotals.games,
        winnerAccuracy: roundTotals.games ? roundTotals.winnerCorrect / roundTotals.games : 0,
        teamScoreMae: roundTotals.games ? roundTotals.teamScoreAbs / (roundTotals.games * 2) : 0,
        marginMae: roundTotals.games ? roundTotals.marginAbs / roundTotals.games : 0,
        totalMae: roundTotals.games ? roundTotals.totalAbs / roundTotals.games : 0,
      };
    })
    .filter(Boolean);

  return {
    totalEntries: entries.length,
    lockedEntries: locked.length,
    gradedEntries: graded.length,
    winnerAccuracy: totals.games ? totals.winnerCorrect / totals.games : 0,
    teamScoreMae: totals.games ? totals.teamScoreAbs / (totals.games * 2) : 0,
    teamScoreRmse: totals.games ? Math.sqrt(totals.teamScoreSq / (totals.games * 2)) : 0,
    marginMae: totals.games ? totals.marginAbs / totals.games : 0,
    marginRmse: totals.games ? Math.sqrt(totals.marginSq / totals.games) : 0,
    totalMae: totals.games ? totals.totalAbs / totals.games : 0,
    totalRmse: totals.games ? Math.sqrt(totals.totalSq / totals.games) : 0,
    rounds,
  };
}

function createSimulationAccumulator() {
  return {
    championCounts: Object.fromEntries(teams.map((team) => [team.id, 0])),
    finalFourCounts: Object.fromEntries(teams.map((team) => [team.id, 0])),
    sweet16Counts: Object.fromEntries(teams.map((team) => [team.id, 0])),
    finalsCounts: Object.fromEntries(teams.map((team) => [team.id, 0])),
    upsetSeedTotal: 0,
    upsetSeedCount: 0,
    sampleBracket: null,
  };
}

function runSimulationChunk(accumulator, iterations, bracketState = buildTournamentBracketState()) {
  for (let iter = 0; iter < iterations; iter += 1) {
    const winnersByKey = new Map();
    const bracketSample = {
      East: [[], [], [], []],
      West: [[], [], [], []],
      South: [[], [], [], []],
      Midwest: [[], [], [], []],
      finalFour: [],
    };

    for (let roundIndex = 0; roundIndex < bracketState.rounds.length; roundIndex += 1) {
      bracketState.rounds[roundIndex].forEach((template) => {
        const teamA = roundIndex === 0 ? template.teamA : winnersByKey.get(template.parentKeys[0]) || null;
        const teamB = roundIndex === 0 ? template.teamB : winnersByKey.get(template.parentKeys[1]) || null;
        if (!teamA || !teamB) return;

        const blended = blendedProbability(teamA, teamB, roundIndex);
        const probabilityA = blended.probabilityA;
        const actualWinner = template.actualWinnerId
          ? (template.actualWinnerId === teamA.id || normalizeTeamName(template.actualWinnerId) === normalizeTeamName(teamA.name)
            ? teamA
            : teamB)
          : null;
        const winner = actualWinner || (Math.random() < probabilityA ? teamA : teamB);
        const loser = winner.id === teamA.id ? teamB : teamA;

        if (winner.seed > loser.seed && winner.seed >= 9) {
          accumulator.upsetSeedTotal += winner.seed;
          accumulator.upsetSeedCount += 1;
        }
        winnersByKey.set(template.key, winner);

        const played = {
          ...template,
          teamA,
          teamB,
          probabilityA,
          components: blended,
          winner,
        };

        if (roundIndex <= 3) {
          bracketSample[template.region][roundIndex].push(played);
        } else {
          bracketSample.finalFour.push(played);
        }

        if (roundIndex === 1) accumulator.sweet16Counts[winner.id] += 1;
        if (roundIndex === 3) accumulator.finalFourCounts[winner.id] += 1;
        if (roundIndex === 4) accumulator.finalsCounts[winner.id] += 1;
        if (roundIndex === 5) accumulator.championCounts[winner.id] += 1;
      });
    }

    accumulator.sampleBracket = bracketSample;
  }
}

function finalizeSimulationAccumulator(accumulator, iterations) {
  const championOdds = teams.map((team) => ({
    id: team.id,
    name: team.name,
    titleOdds: Number(((accumulator.championCounts[team.id] / iterations) * 100).toFixed(1)),
    finalsOdds: Number(((accumulator.finalsCounts[team.id] / iterations) * 100).toFixed(1)),
    finalFourOdds: Number(((accumulator.finalFourCounts[team.id] / iterations) * 100).toFixed(1)),
    sweet16Odds: Number(((accumulator.sweet16Counts[team.id] / iterations) * 100).toFixed(1)),
  })).sort((a, b) => b.titleOdds - a.titleOdds);

  return {
    championOdds,
    sampleBracket: accumulator.sampleBracket,
    averageUpsetSeed: accumulator.upsetSeedCount
      ? accumulator.upsetSeedTotal / accumulator.upsetSeedCount
      : 0,
  };
}

function simulateTournament(iterations = 25000, bracketState = buildTournamentBracketState()) {
  const accumulator = createSimulationAccumulator();
  runSimulationChunk(accumulator, iterations, bracketState);
  return finalizeSimulationAccumulator(accumulator, iterations);
}

async function runTournamentSimulation(iterations = simulationState.iterations, bracketState = buildTournamentBracketState()) {
  const targetIterations = clamp(Math.round(Number(iterations) || 25000), 1000, 1_000_000);
  const targetSignature = currentSimulationSignature();
  const runId = simulationState.runId + 1;
  const chunkSize = Math.max(500, Math.min(5000, Math.round(targetIterations / 80)));
  const accumulator = createSimulationAccumulator();
  const startedAt = performance.now();

  simulationState = {
    ...simulationState,
    iterations: targetIterations,
    status: 'running',
    processed: 0,
    progress: 0,
    startedAt,
    completedAt: null,
    durationMs: null,
    targetSignature,
    runId,
  };
  renderSimulationStatus(currentSimulationSignature());

  while (simulationState.runId === runId && simulationState.processed < targetIterations) {
    const remaining = targetIterations - simulationState.processed;
    const chunkIterations = Math.min(chunkSize, remaining);
    runSimulationChunk(accumulator, chunkIterations, bracketState);
    const processed = simulationState.processed + chunkIterations;
    simulationState = {
      ...simulationState,
      processed,
      progress: processed / targetIterations,
    };
    renderSimulationStatus(currentSimulationSignature());

    if (processed < targetIterations) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  if (simulationState.runId !== runId) return;

  const finishedAt = performance.now();
  simulationState = {
    ...simulationState,
    status: 'ready',
    completedIterations: targetIterations,
    processed: targetIterations,
    progress: 1,
    completedAt: new Date().toISOString(),
    durationMs: finishedAt - startedAt,
    signature: targetSignature,
    targetSignature,
    result: finalizeSimulationAccumulator(accumulator, targetIterations),
  };
  renderAll();
}

function buildBetRows(matchups) {
  return matchups
    .flatMap((matchup) => [
      matchup.edgeA !== null ? {
        team: matchup.teamA,
        opponent: matchup.teamB,
        region: matchup.region,
        roundIndex: matchup.roundIndex,
        roundLabel: matchup.roundLabel,
        contestId: matchup.contestId,
        edge: matchup.edgeA,
        market: matchup.teamA.marketMl,
        opponentMarket: matchup.teamB.marketMl,
        fair: probabilityToAmerican(matchup.probabilityA),
        confidence: matchup.confidence,
        probability: matchup.probabilityA,
        projection: matchup.projection,
        startTime: matchup.startTime,
      } : null,
      matchup.edgeB !== null ? {
        team: matchup.teamB,
        opponent: matchup.teamA,
        region: matchup.region,
        roundIndex: matchup.roundIndex,
        roundLabel: matchup.roundLabel,
        contestId: matchup.contestId,
        edge: matchup.edgeB,
        market: matchup.teamB.marketMl,
        opponentMarket: matchup.teamA.marketMl,
        fair: probabilityToAmerican(1 - matchup.probabilityA),
        confidence: matchup.confidence,
        probability: 1 - matchup.probabilityA,
        projection: {
          teamAPoints: matchup.projection.teamBPoints,
          teamBPoints: matchup.projection.teamAPoints,
          pace: matchup.projection.pace,
        },
        startTime: matchup.startTime,
      } : null,
    ])
    .filter(Boolean)
    .sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence));
}

function recommendationAlreadyTracked(recommendation) {
  return Boolean(findOpenTrackedBetForRecommendation(recommendation));
}

function computeBankrollMetrics() {
  const orderedBets = [...portfolio.bets].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  let cashBalance = portfolio.startingBankroll;
  let settledPnl = 0;
  let openRisk = 0;
  let openExpectedValue = 0;
  let wins = 0;
  let losses = 0;

  orderedBets.forEach((bet) => {
    const totalOutlay = Number.isFinite(bet.totalOutlay) ? bet.totalOutlay : bet.stake;
    const ifPickWins = Number.isFinite(bet.ifPickWins) ? bet.ifPickWins : projectedProfit(bet.stake, bet.marketMl);
    const ifHedgeWins = Number.isFinite(bet.ifHedgeWins) ? bet.ifHedgeWins : -bet.stake;
    const expectedValue = Number.isFinite(bet.expectedValue)
      ? bet.expectedValue
      : (bet.modelProbability * ifPickWins) + ((1 - bet.modelProbability) * ifHedgeWins);

    cashBalance -= totalOutlay;

    if (bet.status === 'win') {
      cashBalance += totalOutlay + ifPickWins;
      settledPnl += ifPickWins;
      wins += 1;
      return;
    }

    if (bet.status === 'push' || bet.status === 'cancelled') {
      cashBalance += totalOutlay;
      return;
    }

    if (bet.status === 'loss') {
      cashBalance += totalOutlay + ifHedgeWins;
      settledPnl += ifHedgeWins;
      losses += 1;
      return;
    }

    openRisk += Number.isFinite(bet.maxLoss) ? bet.maxLoss : bet.stake;
    openExpectedValue += expectedValue;
  });

  const settledCount = wins + losses;
  const roi = settledCount ? settledPnl / Math.max(1, portfolio.startingBankroll) : 0;

  return {
    cashBalance: roundCurrency(cashBalance),
    settledPnl: roundCurrency(settledPnl),
    openRisk: roundCurrency(openRisk),
    openExpectedValue: roundCurrency(openExpectedValue),
    settledCount,
    wins,
    losses,
    roi,
  };
}

function riskBudget(bankroll = computeBankrollMetrics()) {
  const activeCapital = Math.max(bankroll.cashBalance + bankroll.openRisk, 0);
  return roundCurrency(activeCapital * (portfolio.maxOpenRiskPct / 100));
}

function remainingRiskBudget(bankroll = computeBankrollMetrics()) {
  return roundCurrency(Math.max(riskBudget(bankroll) - bankroll.openRisk, 0));
}

function normalizeHedgeStyle(value) {
  return ['equalResult', 'breakEven', 'adaptive'].includes(value) ? value : 'none';
}

function strategyCompatibleHedgeStyle(value) {
  const normalized = normalizeHedgeStyle(value);
  return normalized === 'adaptive' ? 'none' : normalized;
}

function hedgeStyleLabel(value) {
  switch (normalizeHedgeStyle(value)) {
    case 'adaptive':
      return 'Adaptive hedge';
    case 'equalResult':
      return 'Equal-result hedge';
    case 'breakEven':
      return 'Break-even hedge';
    default:
      return 'No hedge';
  }
}

function equalProfitHedgeStake(stake, betOdds, hedgeOdds) {
  const betDecimal = americanToDecimal(betOdds);
  const hedgeDecimal = americanToDecimal(hedgeOdds);
  if (!betDecimal || !hedgeDecimal) return null;
  return roundCurrency((stake * betDecimal) / hedgeDecimal);
}

function breakEvenHedgeStake(stake, hedgeOdds) {
  const hedgeDecimal = americanToDecimal(hedgeOdds);
  if (!hedgeDecimal) return null;
  return roundCurrency(stake / (hedgeDecimal - 1));
}

function hedgeOutcomes(stake, betOdds, hedgeStake, hedgeOdds) {
  if (!Number.isFinite(stake) || !Number.isFinite(betOdds) || !Number.isFinite(hedgeStake) || !Number.isFinite(hedgeOdds)) {
    return null;
  }

  return {
    ifPickWins: roundCurrency(projectedProfit(stake, betOdds) - hedgeStake),
    ifHedgeWins: roundCurrency(projectedProfit(hedgeStake, hedgeOdds) - stake),
  };
}

function buildSelectedHedgePlan(stake, betOdds, hedgeOdds, requestedHedgeStyle) {
  const hedgeStyle = normalizeHedgeStyle(requestedHedgeStyle);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(betOdds)) {
    return {
      hedgeStyle: 'none',
      hedgeStake: 0,
      hedgeMarketMl: null,
      totalOutlay: 0,
      ifPickWins: 0,
      ifHedgeWins: 0,
      maxLoss: 0,
    };
  }

  let hedgeStake = 0;
  if (hedgeStyle === 'equalResult' && Number.isFinite(hedgeOdds)) {
    hedgeStake = equalProfitHedgeStake(stake, betOdds, hedgeOdds) || 0;
  } else if (hedgeStyle === 'breakEven' && Number.isFinite(hedgeOdds)) {
    hedgeStake = breakEvenHedgeStake(stake, hedgeOdds) || 0;
  }

  const outcome = hedgeStake > 0 && Number.isFinite(hedgeOdds)
    ? hedgeOutcomes(stake, betOdds, hedgeStake, hedgeOdds)
    : null;
  const activeHedgeStyle = outcome ? hedgeStyle : 'none';
  const ifPickWins = activeHedgeStyle === 'none'
    ? roundCurrency(projectedProfit(stake, betOdds))
    : outcome.ifPickWins;
  const ifHedgeWins = activeHedgeStyle === 'none'
    ? roundCurrency(-stake)
    : outcome.ifHedgeWins;

  return {
    hedgeStyle: activeHedgeStyle,
    hedgeStake: activeHedgeStyle === 'none' ? 0 : roundCurrency(hedgeStake),
    hedgeMarketMl: activeHedgeStyle === 'none' ? null : hedgeOdds,
    totalOutlay: roundCurrency(stake + (activeHedgeStyle === 'none' ? 0 : hedgeStake)),
    ifPickWins,
    ifHedgeWins,
    maxLoss: activeHedgeStyle === 'none'
      ? roundCurrency(stake)
      : roundCurrency(Math.max(-ifPickWins, -ifHedgeWins, 0)),
  };
}

function chooseAdaptiveHedgePlan(row, stake, remainingCash, remainingRisk) {
  const candidates = ['none', 'equalResult', 'breakEven']
    .map((hedgeStyle) => buildSelectedHedgePlan(stake, row.market, row.opponentMarket, hedgeStyle))
    .filter((plan) => Number.isFinite(plan.totalOutlay) && plan.totalOutlay > 0)
    .filter((plan) => plan.totalOutlay <= remainingCash + 0.01 && plan.maxLoss <= remainingRisk + 0.01);

  if (!candidates.length) {
    return {
      ...buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'none'),
      adaptiveReason: 'No viable hedge plan fit the current bankroll constraints.',
    };
  }

  const teamSignal = teamSignalByName(row.team.name);
  const opponentSignal = teamSignalByName(row.opponent.name);
  const newsRisk = Math.max(
    Number(teamSignal?.suggestedInjuries || 0),
    Number(opponentSignal?.suggestedInjuries || 0),
  );
  const riskPressure = clamp(
    (0.9 - row.confidence) + Math.max(0, 0.12 - row.edge) * 4 + newsRisk / 10,
    0,
    1.4,
  );

  const scored = candidates.map((plan) => {
    const expectedValue = (row.probability * plan.ifPickWins) + ((1 - row.probability) * plan.ifHedgeWins);
    const deploymentPenalty = Math.max(0, plan.totalOutlay - stake) * 0.08;
    const lossPenalty = plan.maxLoss * (0.18 + riskPressure * 0.9);
    const upsideBonus = plan.ifPickWins * clamp(row.edge * row.confidence * 0.6, 0, 0.35);
    const utility = expectedValue - deploymentPenalty - lossPenalty + upsideBonus;
    return { plan, utility, expectedValue };
  });
  scored.sort((a, b) => b.utility - a.utility);
  const winner = scored[0];

  let adaptiveReason = 'Adaptive search preferred the best risk-adjusted expected value for this ticket.';
  if (winner.plan.hedgeStyle === 'none') {
    adaptiveReason = 'Adaptive search kept this bet unhedged because the edge and confidence were strong enough to justify full upside.';
  } else if (winner.plan.hedgeStyle === 'breakEven') {
    adaptiveReason = 'Adaptive search used a break-even hedge because the news/confidence/risk mix favored protecting the downside.';
  } else if (winner.plan.hedgeStyle === 'equalResult') {
    adaptiveReason = 'Adaptive search flattened both outcomes because bankroll smoothness beat pure upside here.';
  }

  return {
    ...winner.plan,
    adaptiveReason,
  };
}

function buildStakePlan(matchups) {
  const bankroll = computeBankrollMetrics();
  let remainingCash = Math.max(bankroll.cashBalance, 0);
  let remainingRisk = remainingRiskBudget(bankroll);
  const minimumEdge = portfolio.minEdgePct / 100;
  const minimumConfidence = portfolio.minConfidence;
  const requestedHedgeStyle = normalizeHedgeStyle(portfolio.hedgeStyle);

  return buildBetRows(matchups)
    .reduce((accepted, row) => {
      if (recommendationAlreadyTracked(row)) {
        return accepted;
      }

      const rawKelly = kellyFraction(row.probability, row.market);
      if (
        row.edge <= minimumEdge
        || row.confidence < minimumConfidence
        || rawKelly <= 0
        || remainingCash <= 0
        || remainingRisk <= 0
      ) {
        return accepted;
      }

      const appliedFraction = Math.min(
        rawKelly * portfolio.kellyMultiplier,
        portfolio.maxStakePct / 100
      );
      let stake = roundCurrency(remainingCash * appliedFraction);
      stake = roundCurrency(Math.min(stake, remainingCash));
      if (!Number.isFinite(stake) || stake <= 0) {
        return accepted;
      }

      let nonePlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'none');
      let equalPlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'equalResult');
      let breakPlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'breakEven');
      let activePlan = requestedHedgeStyle === 'adaptive'
        ? chooseAdaptiveHedgePlan(row, stake, remainingCash, remainingRisk)
        : buildSelectedHedgePlan(stake, row.market, row.opponentMarket, requestedHedgeStyle);

      if (activePlan.totalOutlay > remainingCash || activePlan.maxLoss > remainingRisk) {
        const cashScale = activePlan.totalOutlay > 0 ? remainingCash / activePlan.totalOutlay : 1;
        const riskScale = activePlan.maxLoss > 0 ? remainingRisk / activePlan.maxLoss : 1;
        stake = roundCurrency(stake * Math.min(cashScale, riskScale, 1));
        if (!Number.isFinite(stake) || stake <= 0) {
          return accepted;
        }
        nonePlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'none');
        equalPlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'equalResult');
        breakPlan = buildSelectedHedgePlan(stake, row.market, row.opponentMarket, 'breakEven');
        activePlan = requestedHedgeStyle === 'adaptive'
          ? chooseAdaptiveHedgePlan(row, stake, remainingCash, remainingRisk)
          : buildSelectedHedgePlan(stake, row.market, row.opponentMarket, requestedHedgeStyle);
      }

      if (!Number.isFinite(activePlan.totalOutlay) || activePlan.totalOutlay <= 0) {
        return accepted;
      }

      const expectedValue = roundCurrency(
        (row.probability * activePlan.ifPickWins) + ((1 - row.probability) * activePlan.ifHedgeWins)
      );

      remainingCash = roundCurrency(Math.max(0, remainingCash - activePlan.totalOutlay));
      remainingRisk = roundCurrency(Math.max(0, remainingRisk - activePlan.maxLoss));

      accepted.push({
        ...row,
        rawKelly,
        appliedFraction,
        stake,
        toWin: activePlan.ifPickWins,
        expectedValue,
        equalHedgeStake: equalPlan.hedgeStyle === 'none' ? null : equalPlan.hedgeStake,
        equalHedgeOutcome: equalPlan.hedgeStyle === 'none'
          ? null
          : { ifPickWins: equalPlan.ifPickWins, ifHedgeWins: equalPlan.ifHedgeWins },
        breakEvenHedge: breakPlan.hedgeStyle === 'none' ? null : breakPlan.hedgeStake,
        breakEvenOutcome: breakPlan.hedgeStyle === 'none'
          ? null
          : { ifPickWins: breakPlan.ifPickWins, ifHedgeWins: breakPlan.ifHedgeWins },
        unhedgedMaxLoss: nonePlan.maxLoss,
        hedgeStyle: activePlan.hedgeStyle,
        configuredHedgeStyle: requestedHedgeStyle,
        hedgeStyleLabel: hedgeStyleLabel(activePlan.hedgeStyle),
        adaptiveReason: activePlan.adaptiveReason || null,
        totalOutlay: activePlan.totalOutlay,
        hedgeStake: activePlan.hedgeStake,
        hedgeMarketMl: activePlan.hedgeMarketMl,
        ifPickWins: activePlan.ifPickWins,
        ifHedgeWins: activePlan.ifHedgeWins,
        maxLoss: activePlan.maxLoss,
      });

      return accepted;
    }, [])
    .slice(0, 8);
}

function aiResearchFocusTeamNames() {
  const matchups = currentTournamentRound(buildTournamentBracketState()).matchups;
  const stakePlan = buildStakePlan(matchups);
  const teamRanking = [...teams]
    .sort((a, b) => teamScore(b) - teamScore(a))
    .slice(0, 8)
    .map((team) => team.name);

  return [...new Set([
    ...stakePlan.flatMap((row) => [row.team.name, row.opponent.name]),
    ...teamRanking,
  ])].slice(0, 12);
}

function oddsTimelineSnapshot(teamMl, opponentMl, source = portfolio.liveOddsMode) {
  return {
    at: new Date().toISOString(),
    teamMl,
    opponentMl,
    source,
  };
}

function createTrackedBet(recommendation) {
  const contextSnapshot = deriveRecommendationContext(recommendation);
  const strategySnapshot = strategySnapshotForBet();
  return normalizeBet({
    id: `${recommendation.team.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    settledAt: null,
    teamId: recommendation.team.id,
    teamName: recommendation.team.name,
    opponentId: recommendation.opponent.id,
    opponentName: recommendation.opponent.name,
    region: recommendation.region,
    roundIndex: recommendation.roundIndex,
    roundLabel: recommendation.roundLabel,
    contestId: recommendation.contestId,
    marketMl: recommendation.market,
    opponentMarketMl: recommendation.opponentMarket,
    fairMl: recommendation.fair,
    modelProbability: recommendation.probability,
    confidence: recommendation.confidence,
    edge: recommendation.edge,
    stake: recommendation.stake,
    hedgeStyle: recommendation.hedgeStyle,
    hedgeStake: recommendation.hedgeStake,
    hedgeMarketMl: recommendation.hedgeMarketMl,
    totalOutlay: recommendation.totalOutlay,
    ifPickWins: recommendation.ifPickWins,
    ifHedgeWins: recommendation.ifHedgeWins,
    maxLoss: recommendation.maxLoss,
    currentMarketMl: recommendation.market,
    currentOpponentMarketMl: recommendation.opponentMarket,
    marketSource: portfolio.liveOddsMode,
    oddsTimeline: [oddsTimelineSnapshot(recommendation.market, recommendation.opponentMarket)],
    contextKey: contextSnapshot.contextKey,
    contextSnapshot,
    strategySnapshot,
    expectedValue: recommendation.expectedValue,
    status: 'open',
  });
}

function trackedBetMatchesRecommendation(bet, recommendation) {
  if (!bet || !recommendation) return false;
  if (Number.isFinite(bet.contestId) && Number.isFinite(recommendation.contestId)) {
    return bet.contestId === recommendation.contestId;
  }

  if (bet.roundIndex !== recommendation.roundIndex) return false;

  const sameDirectIds = bet.teamId && bet.opponentId
    && bet.teamId === recommendation.team.id
    && bet.opponentId === recommendation.opponent.id;
  const sameSwappedIds = bet.teamId && bet.opponentId
    && bet.teamId === recommendation.opponent.id
    && bet.opponentId === recommendation.team.id;
  if (sameDirectIds || sameSwappedIds) return true;

  const teamName = normalizeTeamName(recommendation.team.name);
  const opponentName = normalizeTeamName(recommendation.opponent.name);
  const betTeamName = normalizeTeamName(bet.teamName);
  const betOpponentName = normalizeTeamName(bet.opponentName);

  return (
    betTeamName === teamName
    && betOpponentName === opponentName
  ) || (
    betTeamName === opponentName
    && betOpponentName === teamName
  );
}

function findOpenTrackedBetForRecommendation(recommendation) {
  return portfolio.bets.find((bet) => bet.status === 'open' && trackedBetMatchesRecommendation(bet, recommendation)) || null;
}

function addTrackedBet(recommendation) {
  const existingOpenBet = findOpenTrackedBetForRecommendation(recommendation);
  if (existingOpenBet) {
    renderAll();
    return;
  }
  const bet = createTrackedBet(recommendation);
  if (!bet) return;
  portfolio.bets = [bet, ...portfolio.bets];
  renderAll();
}

function updateBetStatus(id, status) {
  portfolio.bets = portfolio.bets.map((bet) => (
    bet.id === id
      ? {
        ...bet,
        status,
        settledAt: status === 'open' ? null : new Date().toISOString(),
        closingMarketMl: status === 'open' ? bet.closingMarketMl : (bet.closingMarketMl ?? bet.currentMarketMl ?? bet.marketMl),
        closingOpponentMarketMl: status === 'open'
          ? bet.closingOpponentMarketMl
          : (bet.closingOpponentMarketMl ?? bet.currentOpponentMarketMl ?? bet.opponentMarketMl ?? null),
      }
      : bet
  ));
  renderAll();
}

function resolveCompletedTournamentBet(bet, completedGames) {
  return completedGames.find((game) => {
    if (!tournamentGameIsFinal(game)) return false;
    if (Number.isFinite(bet.contestId) && Number.isFinite(game.contestId)) {
      return bet.contestId === game.contestId;
    }

    if (bet.roundIndex !== game.roundIndex) return false;
    const sameDirect = bet.teamId && bet.opponentId
      && game.teamA.teamId === bet.teamId
      && game.teamB.teamId === bet.opponentId;
    const sameSwapped = bet.teamId && bet.opponentId
      && game.teamA.teamId === bet.opponentId
      && game.teamB.teamId === bet.teamId;
    if (sameDirect || sameSwapped) return true;

    return (
      normalizeTeamName(game.teamA.name) === normalizeTeamName(bet.teamName)
      && normalizeTeamName(game.teamB.name) === normalizeTeamName(bet.opponentName)
    ) || (
      normalizeTeamName(game.teamA.name) === normalizeTeamName(bet.opponentName)
      && normalizeTeamName(game.teamB.name) === normalizeTeamName(bet.teamName)
    );
  }) || null;
}

function autoSettleTrackedBets(completedGames = tournamentState.games) {
  let settledCount = 0;
  portfolio.bets = portfolio.bets.map((bet) => {
    if (bet.status !== 'open') return bet;
    const completedGame = resolveCompletedTournamentBet(bet, completedGames);
    if (!completedGame) return bet;

    const winnerId = tournamentWinnerId(completedGame);
    const wonBet = winnerId
      ? (winnerId === bet.teamId || normalizeTeamName(winnerId) === normalizeTeamName(bet.teamName))
      : false;
    settledCount += 1;
    return {
      ...bet,
      status: wonBet ? 'win' : 'loss',
      settledAt: completedGame.startTime || new Date().toISOString(),
      closingMarketMl: bet.closingMarketMl ?? bet.currentMarketMl ?? bet.marketMl,
      closingOpponentMarketMl: bet.closingOpponentMarketMl ?? bet.currentOpponentMarketMl ?? bet.opponentMarketMl ?? null,
    };
  });
  return settledCount;
}

function deleteTrackedBet(id) {
  portfolio.bets = portfolio.bets.filter((bet) => bet.id !== id);
  renderAll();
}

function buildEquitySnapshots() {
  const events = [{ at: 'Start', balance: portfolio.startingBankroll }];
  const ledgerEvents = portfolio.bets.flatMap((bet) => {
    const totalOutlay = Number.isFinite(bet.totalOutlay) ? bet.totalOutlay : bet.stake;
    const placed = {
      timestamp: bet.createdAt,
      label: `Bet ${bet.teamName}`,
      delta: -totalOutlay,
    };
    if (bet.status === 'open') return [placed];

    const settlementDelta = bet.status === 'win'
      ? totalOutlay + (Number.isFinite(bet.ifPickWins) ? bet.ifPickWins : projectedProfit(bet.stake, bet.marketMl))
      : bet.status === 'loss'
        ? totalOutlay + (Number.isFinite(bet.ifHedgeWins) ? bet.ifHedgeWins : -bet.stake)
        : (bet.status === 'push' || bet.status === 'cancelled')
          ? totalOutlay
          : 0;

    return [
      placed,
      {
        timestamp: bet.settledAt || bet.createdAt,
        label: `${bet.teamName} ${bet.status}`,
        delta: settlementDelta,
      },
    ];
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let balance = portfolio.startingBankroll;
  ledgerEvents.forEach((event) => {
    balance += event.delta;
    events.push({
      at: event.label,
      balance: roundCurrency(balance),
    });
  });
  return events;
}

function renderPortfolioControls() {
  startingBankrollInput.value = String(portfolio.startingBankroll);
  kellyMultiplierInput.value = String(portfolio.kellyMultiplier);
  maxStakePctInput.value = String(portfolio.maxStakePct);
  maxOpenRiskPctInput.value = String(portfolio.maxOpenRiskPct);
  minEdgePctInput.value = String(portfolio.minEdgePct);
  minConfidenceInput.value = String(portfolio.minConfidence);
  hedgeStyleSelect.value = normalizeHedgeStyle(portfolio.hedgeStyle);
  useResearchCacheInput.checked = Boolean(portfolio.useResearchCache);
  autoRefreshMinutesInput.value = String(portfolio.autoRefreshMinutes);
  liveOddsModeSelect.value = portfolio.liveOddsMode;
  autoSyncInput.checked = portfolio.autoSync;
  autoApplyNewsInput.checked = portfolio.autoApplyNews;
  evolutionPopulationInput.value = String(optimizerSettings.evolutionPopulation);
  evolutionGenerationsInput.value = String(optimizerSettings.evolutionGenerations);
  evolutionRestartsInput.value = String(optimizerSettings.evolutionRestarts);
  strategyPopulationInput.value = String(optimizerSettings.strategyPopulation);
  strategyGenerationsInput.value = String(optimizerSettings.strategyGenerations);
  strategyRestartsInput.value = String(optimizerSettings.strategyRestarts);
}

function renderOptimizerJobBoard() {
  const jobs = [
    backgroundJobs.evolution,
    backgroundJobs.strategyEvolution,
    backgroundJobs.aiPrefill,
  ].filter(Boolean);

  if (!jobs.length) {
    optimizerJobBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Background jobs</small>
        <strong>No heavy jobs running</strong>
        <p>Larger optimizer runs and researched AI passes will show live progress here instead of tying up the UI.</p>
      </article>
    `;
    return;
  }

  optimizerJobBoard.innerHTML = jobs.map((job) => `
    <article class="season-card">
      <small>${job.kind}</small>
      <strong>${job.status === 'completed' ? 'Completed' : job.status === 'failed' ? 'Failed' : `${Math.round(job.progress * 100)}% complete`}</strong>
      <p>${job.error || job.message || 'Working'}</p>
      <div class="inline-progress">
        <div class="inline-progress__bar" style="width:${Math.round(job.progress * 100)}%"></div>
      </div>
      <div class="season-meta-row">
        <span class="tag">${job.id}</span>
        <span class="tag">${job.updatedAt ? new Date(job.updatedAt).toLocaleTimeString() : 'Queued'}</span>
      </div>
    </article>
  `).join('');
}

function renderResearchCacheBoard() {
  const cacheReady = Boolean(aiPrefill.assessments?.length && aiPrefill.cacheKey);
  const overlayCount = portfolio.useResearchCache && cacheReady ? aiPrefill.assessments.filter((assessment) => assessment.confidence >= 0.2 || assessment.researched).length : 0;

  researchCacheBoard.innerHTML = `
    <article class="season-card">
      <small>Research cache</small>
      <strong>${cacheReady ? (aiPrefill.cacheHit ? 'Cache hit ready' : 'Cached AI research ready') : 'No cached research yet'}</strong>
      <p>${cacheReady ? `The current field and live context have ${aiPrefill.assessments.length} cached AI assessments ready to reuse without paying for another run.` : 'Generate a researched AI prefill once and the app can reuse it while the field and live context stay materially the same.'}</p>
      <div class="season-meta-row">
        <span class="tag">${portfolio.useResearchCache ? 'Overlay active in model' : 'Overlay inactive'}</span>
        <span class="tag">${overlayCount} teams affecting sims</span>
        <span class="tag">${aiPrefill.generatedAt ? new Date(aiPrefill.generatedAt).toLocaleString() : 'Not generated yet'}</span>
      </div>
    </article>
    <article class="season-card season-card--wide">
      <small>How it feeds the engine</small>
      <strong>${portfolio.useResearchCache ? 'Simulation and edge board are using cached AI overrides' : 'Simulation is still using manual/base values only'}</strong>
      <p>${portfolio.useResearchCache ? 'When the cache is enabled, coach, experience, continuity, injuries, and form suggestions are applied as a temporary research overlay inside the simulation and betting engine without forcing them into the editable team table.' : 'Turn on the cache toggle in Paper bankroll if you want researched overrides to flow into Monte Carlo, the edge board, and the round-by-round stake plan.'}</p>
    </article>
  `;
}

function renderAiStrategyBoard(currentRound, recommendations) {
  const provider = aiStrategyAdvice.provider || aiPrefill.provider;
  const recommendation = aiStrategyAdvice.recommendation;
  const recommendationApplied = Boolean(
    recommendation?.profile
    && JSON.stringify(currentStrategyProfile()) === JSON.stringify({
      minEdgePct: Number(recommendation.profile.minEdgePct.toFixed(2)),
      kellyMultiplier: Number(recommendation.profile.kellyMultiplier.toFixed(2)),
      maxStakePct: Number(recommendation.profile.maxStakePct.toFixed(2)),
      maxOpenRiskPct: Number(recommendation.profile.maxOpenRiskPct.toFixed(2)),
      minConfidence: Number(recommendation.profile.minConfidence.toFixed(2)),
      hedgeStyle: normalizeHedgeStyle(recommendation.profile.hedgeStyle),
    })
    && portfolio.autoRefreshMinutes === clamp(Math.round(recommendation.autoRefreshMinutes || portfolio.autoRefreshMinutes), 1, 60)
    && portfolio.liveOddsMode === (recommendation.liveOddsMode === 'consensus' ? 'consensus' : 'best')
    && portfolio.autoSync === Boolean(recommendation.autoSync)
    && portfolio.autoApplyNews === Boolean(recommendation.autoApplyNews)
  );
  generateAiStrategyButton.disabled = aiStrategyAdvice.status === 'running';
  applyAiStrategyButton.disabled = !recommendation || recommendationApplied;

  if (aiStrategyAdvice.status === 'running') {
    aiStrategyBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small class="eyebrow">AI betting settings</small>
        <strong>Thinking through the board</strong>
        <p>The AI layer is reviewing the current round, live context, paper-bet telemetry, and validation summaries to recommend Kelly, risk caps, confidence gating, and hedge style. Your bankroll amount stays manual.</p>
      </article>
    `;
    return;
  }

  if (!recommendation) {
    aiStrategyBoard.innerHTML = `
      <article class="season-card">
        <small>AI provider</small>
        <strong>${provider?.configured ? 'Ready' : 'Waiting for key'}</strong>
        <p>${provider?.message || 'Generate AI betting settings to let the model suggest bankroll controls from the full board state.'}</p>
      </article>
      <article class="season-card season-card--wide">
        <small>What it will set</small>
        <strong>Kelly, risk caps, edge gate, confidence gate, and hedge style</strong>
        <p>This recommendation uses the current round, live odds/news availability, AI research notes, score replay quality, historical backtests, and your paper-bet telemetry. It will not invent your starting bankroll.</p>
        <div class="season-meta-row">
          <span class="tag">${currentRound.roundLabel}</span>
          <span class="tag">${recommendations.length} live bankroll-ready angles</span>
          <span class="tag">${liveContext.articles?.length || 0} articles</span>
          <span class="tag">${buildBetFeedbackDataset().length} tracked bets</span>
        </div>
      </article>
    `;
    return;
  }

  const profile = recommendation.profile;
  aiStrategyBoard.innerHTML = `
    <article class="season-card">
      <small>AI provider</small>
      <strong>${aiStrategyAdvice.fallbackUsed ? 'Fallback strategy mode' : 'AI recommendation ready'}</strong>
      <p>${aiStrategyAdvice.provider?.message || 'Recommendation ready.'}</p>
      <div class="season-meta-row">
        <span class="tag">${aiStrategyAdvice.model || aiPrefill.model || 'model unknown'}</span>
        <span class="tag">${aiStrategyAdvice.generatedAt ? new Date(aiStrategyAdvice.generatedAt).toLocaleString() : 'just now'}</span>
        <span class="tag">${Math.round((recommendation.confidence || 0) * 100)} confidence</span>
        <span class="tag">${recommendationApplied ? 'Applied to controls' : 'Ready to apply'}</span>
      </div>
    </article>
    <article class="season-card">
      <small>Suggested profile</small>
      <strong>${recommendation.riskPosture}</strong>
      <ul class="season-list">
        <li>Kelly ${profile.kellyMultiplier.toFixed(2)}x · max stake ${profile.maxStakePct.toFixed(1)}% · max open risk ${profile.maxOpenRiskPct.toFixed(1)}%</li>
        <li>Min edge ${profile.minEdgePct.toFixed(1)} pts · min confidence ${profile.minConfidence.toFixed(2)} · ${hedgeStyleLabel(profile.hedgeStyle)}</li>
        <li>Auto-refresh ${recommendation.autoRefreshMinutes} min · odds ${recommendation.liveOddsMode} · auto-sync ${recommendation.autoSync ? 'on' : 'off'} · auto-news ${recommendation.autoApplyNews ? 'on' : 'off'}</li>
        <li>Starting bankroll remains your call at ${formatCurrency(portfolio.startingBankroll)}.</li>
      </ul>
    </article>
    <article class="season-card season-card--wide">
      <small>Why this fits the current board</small>
      <strong>${recommendation.summary}</strong>
      <ul class="season-list">
        ${(recommendation.reasons || []).map((reason) => `<li>${reason}</li>`).join('')}
      </ul>
      ${(recommendation.warnings || []).length ? `
        <div class="season-meta-row">
          ${(recommendation.warnings || []).slice(0, 3).map((warning) => `<span class="tag">${warning}</span>`).join('')}
        </div>
      ` : ''}
    </article>
  `;
}

function renderSimulationStatus(currentSignature = currentSimulationSignature()) {
  simulationIterationsInput.value = String(simulationState.iterations);
  simulateButton.disabled = simulationState.status === 'running';
  simulationIterationsInput.disabled = simulationState.status === 'running';
  simulateButton.textContent = simulationState.status === 'running'
    ? `Running ${formatInteger(simulationState.iterations)} simulations...`
    : `Run ${formatInteger(simulationState.iterations)} simulations`;

  const hasMatchingIterations = simulationState.completedIterations === simulationState.iterations;
  const hasStaleResult = Boolean(
    simulationState.result
    && (
      (simulationState.signature && simulationState.signature !== currentSignature)
      || !hasMatchingIterations
    )
  );
  const hasCurrentResult = Boolean(
    simulationState.result
    && simulationState.signature === currentSignature
    && hasMatchingIterations
  );

  if (simulationState.status === 'running') {
    const elapsedMs = performance.now() - (simulationState.startedAt || performance.now());
    const etaMs = simulationState.progress > 0
      ? (elapsedMs / simulationState.progress) - elapsedMs
      : null;
    const staleDuringRun = simulationState.targetSignature !== currentSignature;

    simulationStatus.innerHTML = `
      <small>Monte Carlo status</small>
      <strong>${Math.round(simulationState.progress * 100)}% complete · ${formatInteger(simulationState.processed)} / ${formatInteger(simulationState.iterations)} runs</strong>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width:${(simulationState.progress * 100).toFixed(1)}%"></div>
      </div>
      <p>Elapsed ${formatDuration(elapsedMs)}${etaMs !== null ? ` · about ${formatDuration(Math.max(etaMs, 0))} left` : ''}.</p>
      <p>${staleDuringRun ? 'Inputs changed during this run, so these results will be marked stale when it finishes.' : 'Larger runs reduce Monte Carlo noise, but they do not fix bad inputs or model bias.'}</p>
    `;
    return;
  }

  if (hasCurrentResult) {
    simulationStatus.innerHTML = `
      <small>Monte Carlo status</small>
      <strong>${formatInteger(simulationState.completedIterations)} runs complete</strong>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width:100%"></div>
      </div>
      <p>Fresh for the current inputs${simulationState.durationMs ? ` · finished in ${formatDuration(simulationState.durationMs)}` : ''}.</p>
      <p>25,000 is a solid baseline. 100,000+ gives smoother estimates, but the gains taper off after that.</p>
    `;
    return;
  }

  if (hasStaleResult) {
    simulationStatus.innerHTML = `
      <small>Monte Carlo status</small>
      <strong>Simulation needs a rerun</strong>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width:100%; opacity:0.55"></div>
      </div>
      <p>The last ${formatInteger(simulationState.completedIterations)}-run simulation finished${simulationState.durationMs ? ` in ${formatDuration(simulationState.durationMs)}` : ''}, but ${hasMatchingIterations ? 'the field, weights, or synced results changed afterward' : `you now want ${formatInteger(simulationState.iterations)} runs instead`}.</p>
      <p>Run it again to refresh champion odds, path-dependent bracket views, and volatility estimates.</p>
    `;
    return;
  }

  simulationStatus.innerHTML = `
    <small>Monte Carlo status</small>
    <strong>No simulation has run for the current board yet</strong>
    <div class="progress-track" aria-hidden="true">
      <div class="progress-fill" style="width:0%"></div>
    </div>
    <p>Start with 25,000 runs for a fast baseline. Move to 100,000 or more if you want smoother title odds and you are okay waiting longer.</p>
    <p>More runs reduce random Monte Carlo wobble. They do not make a biased model magically better.</p>
  `;
}

function minEdgePolicyBucket(value) {
  const options = [2, 4, 6];
  const numeric = Number(value);
  return options.reduce((closest, option) => (
    Math.abs(option - numeric) < Math.abs(closest - numeric) ? option : closest
  ), options[0]);
}

function buildBetFeedbackDataset() {
  const orderedBets = [...portfolio.bets].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  let balance = portfolio.startingBankroll;
  let peak = balance;

  return orderedBets.map((bet) => {
    const totalOutlay = Number.isFinite(bet.totalOutlay) ? bet.totalOutlay : bet.stake;
    const ifPickWins = Number.isFinite(bet.ifPickWins) ? bet.ifPickWins : projectedProfit(bet.stake, bet.marketMl);
    const ifHedgeWins = Number.isFinite(bet.ifHedgeWins) ? bet.ifHedgeWins : -bet.stake;
    const bankrollBefore = roundCurrency(balance);
    balance -= totalOutlay;

    let realizedPnl = null;
    if (bet.status === 'win') {
      realizedPnl = ifPickWins;
      balance += totalOutlay + ifPickWins;
    } else if (bet.status === 'loss') {
      realizedPnl = ifHedgeWins;
      balance += totalOutlay + ifHedgeWins;
    } else if (bet.status === 'push' || bet.status === 'cancelled') {
      realizedPnl = 0;
      balance += totalOutlay;
    }

    const bankrollAfter = roundCurrency(balance);
    peak = Math.max(peak, bankrollAfter);
    const drawdownAfter = peak > 0 ? (peak - bankrollAfter) / peak : 0;
    const placedProbability = americanToImpliedProbability(bet.marketMl);
    const closingMl = bet.closingMarketMl ?? bet.currentMarketMl ?? null;
    const closingProbability = Number.isFinite(closingMl) ? americanToImpliedProbability(closingMl) : null;
    const clvProbDelta = placedProbability !== null && closingProbability !== null
      ? Number((closingProbability - placedProbability).toFixed(4))
      : null;
    const rewardScore = realizedPnl === null
      ? null
      : Number((
        (realizedPnl / Math.max(bankrollBefore, 1))
        + ((clvProbDelta || 0) * 0.35)
        - (drawdownAfter * 0.45)
      ).toFixed(4));

    return {
      bet,
      bankrollBefore,
      bankrollAfter,
      realizedPnl,
      drawdownAfter,
      drawdownPenalty: Number((drawdownAfter * 0.45).toFixed(4)),
      placedProbability,
      closingProbability,
      clvProbDelta,
      rewardScore,
      oddsSnapshots: Array.isArray(bet.oddsTimeline) ? bet.oddsTimeline.length : 0,
    };
  });
}

function summarizeFeedbackLoop(entries) {
  const settled = entries.filter((entry) => entry.bet.status !== 'open');
  const clvEntries = settled.filter((entry) => Number.isFinite(entry.clvProbDelta));
  const rewardEntries = settled.filter((entry) => Number.isFinite(entry.rewardScore));
  const peakDrawdown = entries.length
    ? entries.reduce((max, entry) => Math.max(max, entry.drawdownAfter), 0)
    : 0;

  return {
    tracked: entries.length,
    settled: settled.length,
    open: entries.filter((entry) => entry.bet.status === 'open').length,
    avgClvProbDelta: clvEntries.length ? average(clvEntries.map((entry) => entry.clvProbDelta)) : null,
    positiveClvRate: clvEntries.length
      ? clvEntries.filter((entry) => entry.clvProbDelta > 0).length / clvEntries.length
      : null,
    avgRewardScore: rewardEntries.length ? average(rewardEntries.map((entry) => entry.rewardScore)) : null,
    peakDrawdown,
    oddsSnapshots: entries.reduce((sum, entry) => sum + entry.oddsSnapshots, 0),
  };
}

function banditActionValue(bet, family) {
  if (family === 'hedgeStyle') {
    return normalizeHedgeStyle(bet.strategySnapshot?.hedgeStyle || bet.hedgeStyle);
  }
  if (family === 'minEdgePct') {
    return String(minEdgePolicyBucket(bet.strategySnapshot?.minEdgePct ?? portfolio.minEdgePct));
  }
  if (family === 'aggression') {
    return aggressionProfileKey(bet.strategySnapshot || portfolio);
  }
  return 'unknown';
}

function buildBanditStats(entries) {
  const families = {
    hedgeStyle: ['none', 'equalResult', 'breakEven'],
    minEdgePct: ['2', '4', '6'],
    aggression: Object.keys(aggressionProfiles),
  };
  const stats = Object.fromEntries(Object.keys(families).map((family) => [family, new Map()]));

  const updateFamily = (family, contextKey, action, reward) => {
    const familyMap = stats[family];
    if (!familyMap.has(contextKey)) familyMap.set(contextKey, new Map());
    const contextMap = familyMap.get(contextKey);
    const current = contextMap.get(action) || { count: 0, rewardSum: 0 };
    contextMap.set(action, {
      count: current.count + 1,
      rewardSum: current.rewardSum + reward,
    });
  };

  entries
    .filter((entry) => entry.bet.status !== 'open' && Number.isFinite(entry.rewardScore))
    .forEach((entry) => {
      const contextKey = entry.bet.contextKey || entry.bet.contextSnapshot?.contextKey || 'global';
      Object.keys(families).forEach((family) => {
        const action = banditActionValue(entry.bet, family);
        updateFamily(family, contextKey, action, entry.rewardScore);
        updateFamily(family, 'global', action, entry.rewardScore);
      });
    });

  return { families, stats };
}

function chooseBanditAction(statsPackage, family, contextKey) {
  const actions = statsPackage.families[family] || [];
  const contextStats = statsPackage.stats[family].get(contextKey)
    || statsPackage.stats[family].get('global')
    || new Map();
  const total = Array.from(contextStats.values()).reduce((sum, stat) => sum + stat.count, 0);
  if (!total) {
    return {
      best: null,
      options: actions.map((action) => ({ action, count: 0, meanReward: 0, score: 0 })),
      totalSamples: 0,
    };
  }
  const scored = actions.map((action) => {
    const stat = contextStats.get(action) || { count: 0, rewardSum: 0 };
    const priorCount = 3;
    const posteriorCount = stat.count + priorCount;
    const posteriorMean = stat.rewardSum / Math.max(stat.count, 1);
    const score = (
      ((stat.rewardSum) / Math.max(posteriorCount, 1))
      + (0.18 * Math.sqrt(Math.log(total + 2) / posteriorCount))
    );
    return {
      action,
      count: stat.count,
      meanReward: Number(posteriorMean.toFixed(4)),
      score: Number(score.toFixed(4)),
    };
  }).sort((a, b) => b.score - a.score);

  return {
    best: scored[0] || null,
    options: scored,
    totalSamples: total,
  };
}

function buildBanditOverlaySuggestion(recommendations, entries = buildBetFeedbackDataset()) {
  const target = recommendations[0];
  if (!target) return null;

  const contextSnapshot = deriveRecommendationContext(target);
  const statsPackage = buildBanditStats(entries);
  const hedgeSuggestion = chooseBanditAction(statsPackage, 'hedgeStyle', contextSnapshot.contextKey);
  const edgeSuggestion = chooseBanditAction(statsPackage, 'minEdgePct', contextSnapshot.contextKey);
  const aggressionSuggestion = chooseBanditAction(statsPackage, 'aggression', contextSnapshot.contextKey);

  const suggestion = {
    contextSnapshot,
    hedgeStyle: hedgeSuggestion.best?.action || normalizeHedgeStyle(portfolio.hedgeStyle),
    minEdgePct: Number(edgeSuggestion.best?.action || minEdgePolicyBucket(portfolio.minEdgePct)),
    aggression: aggressionSuggestion.best?.action || aggressionProfileKey(portfolio),
    confidenceSamples: Math.max(hedgeSuggestion.totalSamples, edgeSuggestion.totalSamples, aggressionSuggestion.totalSamples),
    hedgeOptions: hedgeSuggestion.options,
    edgeOptions: edgeSuggestion.options,
    aggressionOptions: aggressionSuggestion.options,
  };
  suggestion.candidateProfile = overlayCandidateProfile(currentStrategyProfile(), suggestion);
  return suggestion;
}

function renderFeedbackLoopBoard(recommendations) {
  const entries = buildBetFeedbackDataset();
  const summary = summarizeFeedbackLoop(entries);
  const suggestion = buildBanditOverlaySuggestion(recommendations, entries);

  feedbackLoopBoard.innerHTML = `
    <article class="season-card">
      <small>Logged telemetry</small>
      <strong>${summary.tracked} tracked bets · ${summary.settled} settled</strong>
      <p>${summary.oddsSnapshots} odds snapshots captured across the paper ledger. Each tracked bet now stores its context bucket, hedge mode, strategy snapshot, and line history.</p>
      <div class="season-meta-row">
        <span class="tag">${summary.open} still open</span>
        <span class="tag">${summary.oddsSnapshots} line snapshots</span>
      </div>
    </article>
    <article class="season-card">
      <small>Price quality</small>
      <strong>${summary.avgClvProbDelta !== null ? `${formatSignedNumber(summary.avgClvProbDelta * 100, 2)} pts avg CLV` : 'No CLV sample yet'}</strong>
      <p>${summary.positiveClvRate !== null ? `${(summary.positiveClvRate * 100).toFixed(0)}% of settled bets beat the later line on the chosen side.` : 'CLV appears once tracked bets have both a placed line and at least one later line snapshot.'}</p>
      <div class="season-meta-row">
        <span class="tag">Peak drawdown ${(summary.peakDrawdown * 100).toFixed(1)}%</span>
      </div>
    </article>
    <article class="season-card season-card--wide">
      <small>Contextual overlay bandit</small>
      <strong>${suggestion ? `${hedgeStyleLabel(suggestion.hedgeStyle)} · min edge ${suggestion.minEdgePct.toFixed(1)} pts · ${aggressionProfiles[suggestion.aggression].label}` : 'No live recommendation context yet'}</strong>
      <p>${suggestion ? `Current context: ${suggestion.contextSnapshot.roundBucket}, ${suggestion.contextSnapshot.confidenceBucket} confidence, ${suggestion.contextSnapshot.edgeBucket} edge, ${suggestion.contextSnapshot.newsBucket} news, ${suggestion.contextSnapshot.marketSide}. The overlay recommender only uses settled paper bets and remains advisory until it clears the promotion gate.` : 'The bandit needs a current recommendation to build an overlay candidate.'}</p>
      <div class="season-meta-row">
        <span class="tag">${suggestion ? `${suggestion.confidenceSamples} settled local samples` : '0 samples'}</span>
        <span class="tag">${summary.avgRewardScore !== null ? `Avg reward ${formatSignedNumber(summary.avgRewardScore, 3)}` : 'Reward appears after settlements'}</span>
      </div>
    </article>
  `;
}

function overlayReviewPayload(suggestion) {
  return {
    currentProfile: currentStrategyProfile(),
    candidateProfile: suggestion?.candidateProfile || currentStrategyProfile(),
  };
}

async function runOverlayReview(recommendations) {
  const suggestion = buildBanditOverlaySuggestion(recommendations);
  if (!suggestion) return;

  overlayReview = {
    status: 'running',
    candidateProfile: suggestion.candidateProfile,
    response: null,
  };
  renderOverlayReviewBoard(recommendations);

  const response = await fetch(OVERLAY_REVIEW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overlayReviewPayload(suggestion)),
  });

  if (!response.ok) {
    throw new Error(`Overlay review request failed with ${response.status}`);
  }

  overlayReview = {
    status: 'ready',
    candidateProfile: suggestion.candidateProfile,
    response: await response.json(),
  };
}

function applyApprovedOverlay() {
  if (!overlayReview.response?.promote) return;
  applyStrategyProfile(overlayReview.response.candidateProfile);
  overlayReview = createEmptyOverlayReview();
}

function renderOverlayReviewBoard(recommendations) {
  const suggestion = buildBanditOverlaySuggestion(recommendations);
  runOverlayReviewButton.disabled = overlayReview.status === 'running';
  const reviewStale = overlayReview.response
    ? JSON.stringify(overlayReview.response.currentProfile) !== JSON.stringify(currentStrategyProfile())
      || JSON.stringify(overlayReview.response.candidateProfile) !== JSON.stringify(suggestion?.candidateProfile)
    : false;
  applyOverlayButton.disabled = !overlayReview.response?.promote || reviewStale;
  if (!suggestion) {
    overlayReviewBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Promotion review</small>
        <strong>No candidate overlay yet</strong>
        <p>The gate needs a live recommendation context before it can compare the current overlay profile against a bandit-driven candidate on rolling holdouts.</p>
      </article>
    `;
    return;
  }

  if (overlayReview.status === 'running') {
    overlayReviewBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small class="eyebrow">Working</small>
        <strong>Running rolling holdout review</strong>
        <p>Comparing the current overlay profile to the bandit candidate across archived seasons before anything can be promoted.</p>
      </article>
    `;
    return;
  }

  if (!overlayReview.response) {
    overlayReviewBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Candidate</small>
        <strong>${hedgeStyleLabel(suggestion.hedgeStyle)} · min edge ${suggestion.minEdgePct.toFixed(1)} pts · ${aggressionProfiles[suggestion.aggression].label}</strong>
        <p>The local contextual bandit has a candidate overlay, but it has not passed the batch promotion review yet. Run the review to check rolling holdout ROI, log growth, drawdown, and bet volume before promoting anything live.</p>
      </article>
    `;
    return;
  }

  const review = overlayReview.response;
  overlayReviewBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Promotion verdict</small>
      <strong>${review.promote ? 'Candidate cleared the gate' : 'Candidate blocked by the gate'}</strong>
      <p>${review.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${review.promote ? 'Promotion allowed' : 'Keep current overlay'}</span>
        <span class="tag">Delta ROI ${formatSignedNumber(review.deltaRoi * 100, 2)} pts</span>
        <span class="tag">Delta log growth ${formatSignedNumber(review.deltaLogGrowth, 3)}</span>
        <span class="tag">Delta drawdown ${formatSignedNumber(review.deltaDrawdown * 100, 2)} pts</span>
        ${reviewStale ? '<span class="tag">Review is stale</span>' : ''}
      </div>
    </article>
    <article class="season-card">
      <small>Current profile</small>
      <strong>${hedgeStyleLabel(review.currentProfile.hedgeStyle)}</strong>
      <ul class="season-list">
        <li>Min edge ${review.currentProfile.minEdgePct.toFixed(2)} pts · Kelly ${review.currentProfile.kellyMultiplier.toFixed(2)}x</li>
        <li>Max stake ${review.currentProfile.maxStakePct.toFixed(1)}% · max open risk ${review.currentProfile.maxOpenRiskPct.toFixed(1)}% · min confidence ${review.currentProfile.minConfidence.toFixed(2)}</li>
        <li>Holdout ROI ${(review.currentMetrics.holdoutAverageRoi * 100).toFixed(1)}% · drawdown ${(review.currentMetrics.holdoutAverageDrawdown * 100).toFixed(1)}% · ${review.currentMetrics.holdoutAverageBets.toFixed(1)} bets</li>
      </ul>
    </article>
    <article class="season-card">
      <small>Candidate profile</small>
      <strong>${hedgeStyleLabel(review.candidateProfile.hedgeStyle)}</strong>
      <ul class="season-list">
        <li>Min edge ${review.candidateProfile.minEdgePct.toFixed(2)} pts · Kelly ${review.candidateProfile.kellyMultiplier.toFixed(2)}x</li>
        <li>Max stake ${review.candidateProfile.maxStakePct.toFixed(1)}% · max open risk ${review.candidateProfile.maxOpenRiskPct.toFixed(1)}% · min confidence ${review.candidateProfile.minConfidence.toFixed(2)}</li>
        <li>Holdout ROI ${(review.candidateMetrics.holdoutAverageRoi * 100).toFixed(1)}% · drawdown ${(review.candidateMetrics.holdoutAverageDrawdown * 100).toFixed(1)}% · ${review.candidateMetrics.holdoutAverageBets.toFixed(1)} bets</li>
      </ul>
    </article>
    <article class="season-card season-card--wide">
      <small>Gate reasons</small>
      <strong>${review.promote ? 'Why promotion is allowed' : 'Why promotion was blocked'}</strong>
      <ul class="season-list">
        ${(review.gateReasons || []).map((reason) => `<li>${reason}</li>`).join('')}
      </ul>
    </article>
  `;
}

function renderTournamentStatus(currentRound) {
  const fetchedCopy = tournamentState.fetchedAt
    ? `Last synced ${new Date(tournamentState.fetchedAt).toLocaleString()}.`
    : 'No tournament sync has run yet.';
  const openGames = currentRound.matchups.length;

  tournamentStatusBoard.innerHTML = `
    <article class="season-card">
      <small>Current betting round</small>
      <strong>${currentRound.roundLabel}</strong>
      <p>${openGames ? `${openGames} open matchup${openGames === 1 ? '' : 's'} ready for pricing.` : 'No open games are available to bet right now.'}</p>
      <div class="season-meta-row">
        <span class="tag">${tournamentState.completedGameCount} finals logged</span>
        <span class="tag">${tournamentState.inProgressGameCount} live</span>
        <span class="tag">${tournamentState.upcomingGameCount} upcoming</span>
      </div>
    </article>
    <article class="season-card">
      <small>Bracket sync</small>
      <strong>${tournamentState.matchedGameCount ? 'NCAA tournament feed connected' : 'Waiting for sync'}</strong>
      <p>${tournamentState.message}</p>
      <div class="season-meta-row">
        <span class="tag">${fetchedCopy}</span>
        ${tournamentState.sourceUrl ? `<a class="tag season-link" href="${tournamentState.sourceUrl}" target="_blank" rel="noreferrer">Scoreboard source</a>` : ''}
      </div>
    </article>
    <article class="season-card">
      <small>Auto settlement</small>
      <strong>${tournamentState.autoSettledCount || 0} bet${tournamentState.autoSettledCount === 1 ? '' : 's'} settled on last sync</strong>
      <p>Finished NCAA games automatically flip matching paper bets from open to win or loss. Manual override buttons still stay available in the ledger.</p>
      <div class="season-meta-row">
        <span class="tag">${portfolio.bets.filter((bet) => bet.status === 'open').length} still open</span>
      </div>
    </article>
  `;
}

function renderPredictionLogBoard(currentRound) {
  const metrics = buildPredictionLogMetrics();
  lockPredictionsButton.disabled = !currentRound.matchups.length;

  if (!predictionLog.entries.length) {
    predictionLogBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Audit trail</small>
        <strong>No frozen forecasts yet</strong>
        <p>Lock the current round before tipoff to create an auditable prediction snapshot. Once those games finish and tournament sync pulls the finals, the app will grade winner accuracy plus team-score, margin, and total error automatically.</p>
      </article>
    `;
    return;
  }

  const recentEntries = predictionLog.entries
    .slice(0, 6)
    .map((entry) => {
      const errors = predictionEntryErrors(entry);
      return `
        <article class="season-card">
          <small>${entry.roundLabel} · ${entry.region}</small>
          <strong>${entry.teamAName} vs ${entry.teamBName}</strong>
          <p>Locked ${new Date(entry.lockedAt).toLocaleString()}${entry.startTime ? ` · tip ${entry.startTime}` : ''}. Predicted ${Math.round(entry.projectedTeamAScore)}-${Math.round(entry.projectedTeamBScore)} with ${(entry.probabilityA * 100).toFixed(1)}% on ${entry.teamAName}.</p>
          <div class="season-meta-row">
            <span class="tag">${entry.status === 'graded' ? 'Graded' : 'Locked'}</span>
            <span class="tag">${entry.status === 'graded' ? `Actual ${entry.actualTeamAScore}-${entry.actualTeamBScore}` : 'Pregame snapshot frozen'}</span>
            ${entry.winnerCorrect === null ? '<span class="tag">Winner waiting</span>' : `<span class="tag">${entry.winnerCorrect ? 'Winner correct' : 'Winner miss'}</span>`}
            ${errors ? `<span class="tag">Margin MAE ${errors.marginAbs.toFixed(1)}</span>` : ''}
            ${errors ? `<span class="tag">Total MAE ${errors.totalAbs.toFixed(1)}</span>` : ''}
          </div>
        </article>
      `;
    }).join('');

  predictionLogBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Frozen pregame snapshots</small>
      <strong>${metrics.totalEntries} logged · ${metrics.gradedEntries} graded · ${metrics.lockedEntries} still pending</strong>
      <p>${predictionLog.lastLockSummary}</p>
      <div class="season-meta-row">
        <span class="tag">${predictionLog.lastLockedAt ? `Last lock ${new Date(predictionLog.lastLockedAt).toLocaleString()}` : 'No lock yet'}</span>
        <span class="tag">${predictionLog.lastGradedAt ? `Last grade ${new Date(predictionLog.lastGradedAt).toLocaleString()}` : 'No graded finals yet'}</span>
        <span class="tag">${metrics.gradedEntries ? `${(metrics.winnerAccuracy * 100).toFixed(1)}% winner accuracy` : 'Winner accuracy pending'}</span>
        <span class="tag">${metrics.gradedEntries ? `Team MAE ${metrics.teamScoreMae.toFixed(1)}` : 'Score error pending'}</span>
      </div>
      ${metrics.rounds.length ? `
        <ul class="season-list">
          ${metrics.rounds.map((round) => `<li>${round.label}: ${round.games} graded · ${(round.winnerAccuracy * 100).toFixed(1)}% winner accuracy · team MAE ${round.teamScoreMae.toFixed(1)} · margin MAE ${round.marginMae.toFixed(1)} · total MAE ${round.totalMae.toFixed(1)}</li>`).join('')}
        </ul>
      ` : '<ul class="season-list"><li>Score grading begins after synced NCAA finals arrive for locked games.</li></ul>'}
    </article>
    <article class="season-card">
      <small>Accuracy dashboard</small>
      <strong>${metrics.gradedEntries ? `RMSE ${metrics.teamScoreRmse.toFixed(1)} team · ${metrics.marginRmse.toFixed(1)} margin · ${metrics.totalRmse.toFixed(1)} total` : 'No graded games yet'}</strong>
      <ul class="season-list">
        <li>Team-score MAE ${metrics.teamScoreMae.toFixed(1)} · RMSE ${metrics.teamScoreRmse.toFixed(1)}</li>
        <li>Margin MAE ${metrics.marginMae.toFixed(1)} · RMSE ${metrics.marginRmse.toFixed(1)}</li>
        <li>Total MAE ${metrics.totalMae.toFixed(1)} · RMSE ${metrics.totalRmse.toFixed(1)}</li>
      </ul>
    </article>
    ${recentEntries}
  `;
}

function renderPortfolioSummary(recommendations, currentRound) {
  const bankroll = computeBankrollMetrics();
  const top = recommendations[0];
  const totalRiskBudget = riskBudget(bankroll);
  const riskLeft = remainingRiskBudget(bankroll);

  portfolioSummary.innerHTML = `
    <div class="summary-card">
      <small>Available cash</small>
      <strong>${formatCurrency(bankroll.cashBalance)}</strong>
      <small>${portfolio.bets.filter((bet) => bet.status === 'open').length} open paper bets</small>
    </div>
    <div class="summary-card">
      <small>Realized P&amp;L</small>
      <strong>${formatCurrency(bankroll.settledPnl)}</strong>
      <small>${bankroll.wins} wins · ${bankroll.losses} losses · ${(bankroll.roi * 100).toFixed(1)}% ROI</small>
    </div>
    <div class="summary-card">
      <small>Open risk</small>
      <strong>${formatCurrency(bankroll.openRisk)}</strong>
      <small>Worst case if every open bet loses: ${formatSignedCurrency(-bankroll.openRisk)}</small>
    </div>
    <div class="summary-card">
      <small>Risk budget left</small>
      <strong>${formatCurrency(riskLeft)}</strong>
      <small>${portfolio.maxOpenRiskPct}% cap of active bankroll · total budget ${formatCurrency(totalRiskBudget)}</small>
    </div>
    <div class="summary-card">
      <small>Active round</small>
      <strong>${currentRound.roundLabel}</strong>
      <small>${currentRound.matchups.length} bettable matchup${currentRound.matchups.length === 1 ? '' : 's'} right now</small>
    </div>
    <div class="summary-card">
      <small>Best current paper bet</small>
      <strong>${top ? top.team.name : 'No stake yet'}</strong>
      <small>${top ? `${formatCurrency(top.totalOutlay)} deployed · ${top.hedgeStyleLabel.toLowerCase()} · max loss ${formatCurrency(top.maxLoss)}` : 'Sync results or add live lines to surface the next round.'}</small>
    </div>
  `;
}

function renderBetSizingBoard(recommendations) {
  if (!recommendations.length) {
    betSizingBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Stake plan</small>
        <strong>No bankroll-ready edge yet</strong>
        <p>The model needs a positive edge and a positive Kelly fraction before it will suggest a stake.</p>
      </article>
    `;
    return;
  }

  betSizingBoard.innerHTML = recommendations.map((row, index) => {
    const existingOpenBet = findOpenTrackedBetForRecommendation(row);
    return `
    <article class="season-card">
      <small>${row.roundLabel} · ${row.region}</small>
      <strong>${row.team.name} over ${row.opponent.name}</strong>
      <p>Model ${(row.probability * 100).toFixed(1)}% · market ${formatMoneyline(row.market)} · fair ${formatMoneyline(row.fair)} · edge ${(row.edge * 100).toFixed(1)} pts.</p>
      <div class="season-meta-row">
        <span class="tag">Primary ${formatCurrency(row.stake)}</span>
        <span class="tag">Outlay ${formatCurrency(row.totalOutlay)}</span>
        <span class="tag">Net if right ${formatSignedCurrency(row.toWin)}</span>
        <span class="tag">Kelly ${(row.rawKelly * 100).toFixed(1)}%</span>
        <span class="tag">${row.hedgeStyleLabel}</span>
        ${row.startTime ? `<span class="tag">${row.startTime}</span>` : ''}
      </div>
      <ul class="season-list">
        <li>Active strategy: ${row.hedgeStyleLabel}. Total outlay ${formatCurrency(row.totalOutlay)}, max loss ${formatCurrency(row.maxLoss)}, net ${formatSignedCurrency(row.ifPickWins)} if ${row.team.name} wins, and ${formatSignedCurrency(row.ifHedgeWins)} if ${row.opponent.name} wins.</li>
        <li>${row.configuredHedgeStyle === 'adaptive' ? row.adaptiveReason : `Global hedge mode is ${hedgeStyleLabel(row.configuredHedgeStyle)} for this run.`}</li>
        <li>Unhedged max loss would be ${formatCurrency(row.unhedgedMaxLoss)}.</li>
        <li>${row.equalHedgeStake && row.equalHedgeOutcome ? `Equal-result hedge on ${row.opponent.name}: bet ${formatCurrency(row.equalHedgeStake)} at ${formatMoneyline(row.opponentMarket)} to lock about ${formatSignedCurrency(row.equalHedgeOutcome.ifPickWins)} either way.` : 'Equal-result hedge appears once both sides have usable moneylines.'}</li>
        <li>${row.breakEvenHedge && row.breakEvenOutcome ? `Break-even hedge on ${row.opponent.name}: bet ${formatCurrency(row.breakEvenHedge)} to get about ${formatSignedCurrency(row.breakEvenOutcome.ifHedgeWins)} if ${row.opponent.name} wins, while still keeping about ${formatSignedCurrency(row.breakEvenOutcome.ifPickWins)} if ${row.team.name} wins.` : 'Break-even hedge appears once both sides have usable moneylines.'}</li>
        <li>Projected score: ${row.team.name} ${Math.round(row.projection.teamAPoints)}-${Math.round(row.projection.teamBPoints)} ${row.opponent.name}.</li>
        <li>${existingOpenBet ? `Open ticket already exists for this game: ${existingOpenBet.teamName} vs ${existingOpenBet.opponentName} with ${formatCurrency(existingOpenBet.totalOutlay)} outlay. Settle, cancel, or delete it before adding another.` : 'No open ticket exists for this game yet.'}</li>
      </ul>
      <button class="button button--ghost button--small" data-track-recommendation="${index}" ${existingOpenBet ? 'disabled' : ''}>${existingOpenBet ? 'Already tracked' : 'Track paper strategy'}</button>
    </article>
  `;
  }).join('');

  betSizingBoard.querySelectorAll('[data-track-recommendation]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const recommendation = recommendations[Number(event.currentTarget.dataset.trackRecommendation)];
      addTrackedBet(recommendation);
    });
  });
}

function renderLiveStatus() {
  const oddsStatus = liveContext.oddsProvider;
  const newsStatus = liveContext.newsProvider;
  const fetchedCopy = liveContext.fetchedAt
    ? `Last refresh ${new Date(liveContext.fetchedAt).toLocaleString()}.`
    : 'No live sync has run yet.';

  liveStatusBoard.innerHTML = `
    <article class="season-card">
      <small>Odds feed</small>
      <strong>${oddsStatus?.configured ? 'Configured' : 'Waiting for key'}</strong>
      <p>${oddsStatus?.message || 'Set THE_ODDS_API_KEY to enable live college basketball odds sync.'}</p>
      <div class="season-meta-row">
        <span class="tag">${liveContext.games?.filter((game) => game.matched).length || 0} matched games</span>
        <a class="tag season-link" href="${oddsStatus?.sourceUrl || 'https://the-odds-api.com/'}" target="_blank" rel="noreferrer">Odds docs</a>
      </div>
    </article>
    <article class="season-card season-card--wide">
      <small>News feed</small>
      <strong>${newsStatus?.configured ? 'Configured' : 'Waiting for key'}</strong>
      <p>${newsStatus?.message || 'Set NEWSAPI_KEY to pull current matchup coverage.'}</p>
      <div class="season-meta-row">
        <span class="tag">${fetchedCopy}</span>
        <span class="tag">${liveContext.teamSignals?.length || 0} team signals</span>
        <a class="tag season-link" href="${newsStatus?.sourceUrl || 'https://newsapi.org/docs/endpoints/everything'}" target="_blank" rel="noreferrer">News docs</a>
      </div>
    </article>
  `;
}

function renderSignalBoard() {
  if (!liveContext.teamSignals?.length) {
    signalBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Signal layer</small>
        <strong>No team-level news signal yet</strong>
        <p>After a live sync, this board will show which teams have injury-style news concerns and what injury score the app suggests applying.</p>
      </article>
    `;
    return;
  }

  signalBoard.innerHTML = liveContext.teamSignals.map((signal) => {
    const currentTeam = findTeamByName(signal.teamName);
    const currentInjuries = currentTeam ? currentTeam.injuries : null;
    const delta = currentInjuries === null ? null : signal.suggestedInjuries - currentInjuries;

    return `
      <article class="season-card">
        <small>${signal.articleCount} article${signal.articleCount === 1 ? '' : 's'}</small>
        <strong>${signal.teamName}</strong>
        <p>${signal.summary}</p>
        <div class="season-meta-row">
          <span class="tag">Suggested injuries ${signal.suggestedInjuries.toFixed(1)}</span>
          <span class="tag">Current ${currentInjuries === null ? '—' : currentInjuries.toFixed(1)}</span>
          <span class="tag">Delta ${delta === null ? '—' : formatSignedNumber(delta)}</span>
          <span class="tag">${Math.round(signal.confidence * 100)} confidence</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderNewsBoard() {
  if (!liveContext.articles?.length) {
    newsBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Matchup context</small>
        <strong>No live articles yet</strong>
        <p>${liveContext.newsProvider?.configured ? 'Run a live sync to pull recent coverage for the teams at the top of the board.' : 'Add NEWSAPI_KEY, then run a live sync to pull recent coverage for the teams at the top of the board.'}</p>
      </article>
    `;
    return;
  }

  newsBoard.innerHTML = liveContext.articles.map((article) => `
    <article class="glossary-card">
      <small>${article.source}</small>
      <strong>${article.title}</strong>
      <p>${article.description || 'No description provided by the feed.'}</p>
      <div class="season-meta-row">
        <span class="tag">${article.signal}</span>
        <span class="tag">Impact ${formatSignedNumber(article.impactScore, 2)}</span>
        <span class="tag">${article.teams?.length ? article.teams.join(', ') : 'General coverage'}</span>
        <span class="tag">${new Date(article.publishedAt).toLocaleString()}</span>
        <a class="tag season-link" href="${article.url}" target="_blank" rel="noreferrer">Open article</a>
      </div>
    </article>
  `).join('');
}

function renderAiPrefill() {
  const job = backgroundJobs.aiPrefill;
  if (job && ['queued', 'running'].includes(job.status)) {
    aiPrefillStatus.innerHTML = `
      <article class="season-card season-card--wide">
        <small>AI prefill job</small>
        <strong>${Math.round(job.progress * 100)}% complete</strong>
        <p>${job.message || 'Running researched AI pass in the background.'}</p>
        <div class="inline-progress">
          <div class="inline-progress__bar" style="width:${Math.round(job.progress * 100)}%"></div>
        </div>
      </article>
    `;
    aiPrefillBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Suggestions</small>
        <strong>Research in progress</strong>
        <p>The researched AI pass is running in the background. You can keep using the board while it works.</p>
      </article>
    `;
    return;
  }

  const provider = aiPrefill.provider;
  const generatedCopy = aiPrefill.generatedAt
    ? `Generated ${new Date(aiPrefill.generatedAt).toLocaleString()}.`
    : 'No AI prefill has run yet.';
  const appliedCopy = aiPrefill.appliedAt
    ? `Applied to Team Lab ${new Date(aiPrefill.appliedAt).toLocaleString()}.`
    : 'Not applied to Team Lab yet.';
  const cacheCopy = aiPrefill.cacheHit
    ? 'Latest request reused cached research.'
    : aiPrefill.cacheKey
      ? 'Cached research is available for reuse.'
      : 'No cache entry yet.';

  aiPrefillStatus.innerHTML = `
    <article class="season-card">
      <small>AI provider</small>
      <strong>${provider?.configured ? 'Configured' : 'Waiting for key'}</strong>
      <p>${provider?.message || 'Set OPENAI_API_KEY to enable AI model prefilling.'}</p>
      <div class="season-meta-row">
        <span class="tag">${generatedCopy}</span>
        <span class="tag">${appliedCopy}</span>
        <span class="tag">${cacheCopy}</span>
        <span class="tag">${aiPrefill.researchedTeams || 0} researched</span>
        <span class="tag">${aiPrefill.fallbackTeams || 0} fallback</span>
        <a class="tag season-link" href="${provider?.sourceUrl || 'https://developers.openai.com/api/reference/responses'}" target="_blank" rel="noreferrer">OpenAI docs</a>
      </div>
    </article>
    <article class="season-card season-card--wide">
      <small>Model</small>
      <strong>${aiPrefill.model || 'Not used yet'}</strong>
      <p>The AI layer researches priority teams with web search, attaches source-backed notes when it can, and fills the rest conservatively. Generating a researched AI prefill now also writes the suggested coach, experience, continuity, injuries, and form values into Team Lab automatically.</p>
    </article>
  `;

  if (!aiPrefill.assessments?.length) {
    aiPrefillBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Suggestions</small>
        <strong>No AI assessments yet</strong>
        <p>${aiPrefill.provider?.configured ? 'Generate a researched AI prefill after loading the official field and, ideally, refreshing live context.' : 'Add OPENAI_API_KEY, then generate a researched AI prefill after loading the official field.'}</p>
      </article>
    `;
    return;
  }

  const hasMaterialAiOutput = aiPrefill.assessments.some((assessment) => assessment.researched || assessment.confidence > 0.15);
  if (!hasMaterialAiOutput) {
    aiPrefillBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Suggestions</small>
        <strong>Waiting for AI output</strong>
        <p>${aiPrefill.provider?.configured ? 'The provider is configured; run the researched AI prefill to replace the current manual defaults with source-backed suggestions.' : 'Once OPENAI_API_KEY is configured, this board will show model-generated override suggestions instead of the current manual defaults.'}</p>
      </article>
    `;
    return;
  }

  const ranked = [...aiPrefill.assessments]
    .map((assessment) => {
      const team = findTeamByName(assessment.teamName);
      const totalDelta = team
        ? Math.abs(assessment.coach - team.coach)
          + Math.abs(assessment.experience - team.experience)
          + Math.abs(assessment.continuity - team.continuity)
          + Math.abs(assessment.injuries - team.injuries)
          + Math.abs(assessment.form - team.form)
        : 0;

      return { ...assessment, totalDelta, team };
    })
    .sort((a, b) => b.totalDelta - a.totalDelta)
    .slice(0, 12);

  aiPrefillBoard.innerHTML = ranked.map((assessment) => `
    <article class="season-card">
      <small>${assessment.team?.region || 'Team context'}</small>
      <strong>${assessment.teamName}</strong>
      <p>${assessment.summary}</p>
      <div class="season-meta-row">
        <span class="tag">${assessment.researched ? 'Web researched' : 'Fallback kept'}</span>
        <span class="tag">Coach ${assessment.coach.toFixed(1)}</span>
        <span class="tag">Exp ${assessment.experience.toFixed(1)}</span>
        <span class="tag">Cont ${assessment.continuity.toFixed(1)}</span>
        <span class="tag">Inj ${assessment.injuries.toFixed(1)}</span>
        <span class="tag">Form ${assessment.form.toFixed(1)}</span>
        <span class="tag">${Math.round(assessment.confidence * 100)} confidence</span>
      </div>
      <ul class="season-list">
        ${(assessment.sourceSignals || []).slice(0, 3).map((signal) => `<li>${signal}</li>`).join('')}
      </ul>
      <div class="season-meta-row">
        ${(assessment.sources || []).slice(0, 3).map((source) => `<a class="tag season-link" href="${source.url}" target="_blank" rel="noreferrer">${source.publisher || 'Source'}: ${source.title}</a>`).join('')}
      </div>
    </article>
  `).join('');
}

function renderEquityCurve() {
  const points = buildEquitySnapshots();
  const balances = points.map((point) => point.balance);
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);
  const width = 640;
  const height = 140;
  const spread = Math.max(maxBalance - minBalance, 1);
  const path = points.map((point, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
    const y = height - (((point.balance - minBalance) / spread) * (height - 20)) - 10;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  equityCurve.innerHTML = `
    <div class="equity-card__header">
      <div>
        <small class="eyebrow">Equity curve</small>
        <h3>${formatCurrency(points[points.length - 1]?.balance || portfolio.startingBankroll)}</h3>
      </div>
      <p class="section-copy">This is paper money only. The line updates when you add bets, settle them manually, or let tournament sync settle finished games automatically.</p>
    </div>
    <svg viewBox="0 0 ${width} ${height}" class="equity-chart" role="img" aria-label="Paper bankroll equity curve">
      <path d="${path}" />
    </svg>
    <div class="season-meta-row">
      <span class="tag">Start ${formatCurrency(portfolio.startingBankroll)}</span>
      <span class="tag">Low ${formatCurrency(minBalance)}</span>
      <span class="tag">High ${formatCurrency(maxBalance)}</span>
      <span class="tag">${points.length - 1} bankroll events</span>
    </div>
  `;
}

function renderBetLedger() {
  if (!portfolio.bets.length) {
    betLedgerBody.innerHTML = `
      <tr>
        <td colspan="8">No paper bets tracked yet. Use "Track paper strategy" on one of the stake-plan cards.</td>
      </tr>
    `;
    return;
  }

  const analyticsById = new Map(buildBetFeedbackDataset().map((entry) => [entry.bet.id, entry]));

  betLedgerBody.innerHTML = portfolio.bets.map((bet) => {
    const analytics = analyticsById.get(bet.id);
    return `
    <tr>
      <td>${new Date(bet.createdAt).toLocaleString()}</td>
      <td>${bet.teamName} vs ${bet.opponentName}<br /><small>${bet.roundLabel} · ${bet.region} · ${hedgeStyleLabel(bet.hedgeStyle)} · ${bet.contextSnapshot?.contextKey || 'no context key'}</small></td>
      <td>${formatMoneyline(bet.marketMl)}<br /><small>${Number.isFinite(bet.closingMarketMl) ? `Close ${formatMoneyline(bet.closingMarketMl)}` : Number.isFinite(bet.currentMarketMl) ? `Now ${formatMoneyline(bet.currentMarketMl)}` : 'No later line yet'}</small></td>
      <td>${formatCurrency(bet.totalOutlay)}<br /><small>Primary ${formatCurrency(bet.stake)}${bet.hedgeStake ? ` + hedge ${formatCurrency(bet.hedgeStake)}` : ''}</small></td>
      <td>${formatSignedCurrency(bet.ifPickWins)}<br /><small>${bet.hedgeStyle === 'none' ? `Max loss ${formatSignedCurrency(-bet.maxLoss)}` : `If ${bet.opponentName} wins ${formatSignedCurrency(bet.ifHedgeWins)}`}</small></td>
      <td>${formatCurrency(bet.expectedValue)}<br /><small>${analytics?.clvProbDelta !== null && analytics?.clvProbDelta !== undefined ? `CLV ${formatSignedNumber(analytics.clvProbDelta * 100, 2)} pts` : 'CLV waiting'}${analytics?.rewardScore !== null && analytics?.rewardScore !== undefined ? ` · reward ${formatSignedNumber(analytics.rewardScore, 3)}` : ''}</small></td>
      <td>${bet.status}</td>
      <td>
        <div class="ledger-actions">
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="win">Pick wins</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="loss">Pick loses</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="push">Push</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="delete">Delete</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');

  betLedgerBody.querySelectorAll('[data-bet-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const { betId, betAction } = event.currentTarget.dataset;
      if (betAction === 'delete') {
        deleteTrackedBet(betId);
        return;
      }
      updateBetStatus(betId, betAction);
    });
  });
}

function liveContextPayload(matchups) {
  const recommendations = buildStakePlan(matchups);
  const focusRows = recommendations.length ? recommendations : buildBetRows(matchups).slice(0, 3);
  const focusTeams = focusRows
    .slice(0, 3)
    .flatMap((row) => [row.team.name, row.opponent.name]);

  return {
    games: matchups.map((matchup) => ({
      region: matchup.region,
      teamA: matchup.teamA.name,
      teamB: matchup.teamB.name,
    })),
    newsTeams: [...new Set(focusTeams)],
  };
}

function matchedLiveGameForBet(bet, games = liveContext.games) {
  return (games || []).find((game) => {
    const sameDirect = normalizeTeamName(game.teamA) === normalizeTeamName(bet.teamName)
      && normalizeTeamName(game.teamB) === normalizeTeamName(bet.opponentName);
    const sameSwapped = normalizeTeamName(game.teamA) === normalizeTeamName(bet.opponentName)
      && normalizeTeamName(game.teamB) === normalizeTeamName(bet.teamName);
    return sameDirect || sameSwapped;
  }) || null;
}

function updateOpenBetMarketSnapshots(games = liveContext.games) {
  const modeKeyA = portfolio.liveOddsMode === 'consensus' ? 'consensusTeamAMl' : 'bestTeamAMl';
  const modeKeyB = portfolio.liveOddsMode === 'consensus' ? 'consensusTeamBMl' : 'bestTeamBMl';

  portfolio.bets = portfolio.bets.map((bet) => {
    const game = matchedLiveGameForBet(bet, games);
    if (!game || !game.matched) return bet;

    const betIsTeamA = normalizeTeamName(game.teamA) === normalizeTeamName(bet.teamName);
    const teamMl = betIsTeamA ? game[modeKeyA] : game[modeKeyB];
    const opponentMl = betIsTeamA ? game[modeKeyB] : game[modeKeyA];
    if (!Number.isFinite(teamMl)) return bet;

    const oddsTimeline = Array.isArray(bet.oddsTimeline) ? [...bet.oddsTimeline] : [];
    const last = oddsTimeline[oddsTimeline.length - 1];
    const source = portfolio.liveOddsMode;
    if (!last || last.teamMl !== teamMl || last.opponentMl !== opponentMl || last.source !== source) {
      oddsTimeline.push(oddsTimelineSnapshot(teamMl, opponentMl, source));
    }

    const closed = bet.status !== 'open';
    return normalizeBet({
      ...bet,
      currentMarketMl: teamMl,
      currentOpponentMarketMl: Number.isFinite(opponentMl) ? opponentMl : bet.currentOpponentMarketMl,
      closingMarketMl: closed ? teamMl : bet.closingMarketMl,
      closingOpponentMarketMl: closed && Number.isFinite(opponentMl)
        ? opponentMl
        : bet.closingOpponentMarketMl,
      marketSource: source,
      oddsTimeline,
    });
  });
}

function tournamentSyncPayload() {
  return {
    year: seasonMeta?.year || 2026,
    teams: teams.map((team) => ({
      id: team.id,
      region: team.region,
      seed: team.seed,
      name: team.name,
    })),
  };
}

async function syncTournamentState() {
  const response = await fetch(TOURNAMENT_SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tournamentSyncPayload()),
  });

  if (!response.ok) {
    throw new Error(`Tournament sync request failed with ${response.status}`);
  }

  tournamentState = normalizeTournamentState(await response.json());
  tournamentState.autoSettledCount = autoSettleTrackedBets(
    tournamentState.games.filter((game) => tournamentGameIsFinal(game))
  );
  gradePredictionLogFromTournament(tournamentState.games);
  return tournamentState;
}

async function syncLiveContext(matchups, { applyOdds = false, applyNews = false } = {}) {
  const response = await fetch(LIVE_CONTEXT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(liveContextPayload(matchups)),
  });

  if (!response.ok) {
    throw new Error(`Live context request failed with ${response.status}`);
  }

  liveContext = await response.json();
  updateOpenBetMarketSnapshots(liveContext.games);
  if (applyOdds) {
    applyLiveOdds(liveContext.games);
  }
  if (applyNews) {
    applyNewsSignals(liveContext.teamSignals);
  }
}

async function syncTournamentAndLiveContext({ applyOdds = false, applyNews = false } = {}) {
  await syncTournamentState();
  const matchups = currentTournamentRound(buildTournamentBracketState()).matchups;
  await syncLiveContext(matchups, { applyOdds, applyNews });
}

function applyLiveOdds(games = liveContext.games) {
  const modeKeyA = portfolio.liveOddsMode === 'consensus' ? 'consensusTeamAMl' : 'bestTeamAMl';
  const modeKeyB = portfolio.liveOddsMode === 'consensus' ? 'consensusTeamBMl' : 'bestTeamBMl';

  games.forEach((game) => {
    if (!game.matched) return;
    const teamA = findTeamByName(game.teamA);
    const teamB = findTeamByName(game.teamB);
    if (teamA && Number.isFinite(game[modeKeyA])) teamA.marketMl = Number(game[modeKeyA]);
    if (teamB && Number.isFinite(game[modeKeyB])) teamB.marketMl = Number(game[modeKeyB]);
  });
}

function applyNewsSignals(signals = liveContext.teamSignals) {
  signals.forEach((signal) => {
    const team = findTeamByName(signal.teamName);
    if (!team || !Number.isFinite(signal.suggestedInjuries)) return;
    team.injuries = Number(clamp(signal.suggestedInjuries, 0, 10).toFixed(1));
  });
}

function aiPrefillPayload() {
  return {
    teams: teams.map((team) => ({
      id: team.id,
      region: team.region,
      seed: team.seed,
      name: team.name,
      adjO: team.adjO,
      adjD: team.adjD,
      efg: team.efg,
      tov: team.tov,
      orb: team.orb,
      ftr: team.ftr,
      form: team.form,
      injuries: team.injuries,
      coach: team.coach,
      experience: team.experience,
      continuity: team.continuity,
      marketMl: team.marketMl,
      pace: team.pace || null,
      pointsPerGame: team.pointsPerGame || null,
      netRanking: team.netRanking || null,
      winPct: team.winPct || null,
      lastTenRecord: team.lastTenRecord || null,
    })),
    articles: liveContext.articles || [],
    teamSignals: liveContext.teamSignals || [],
    focusTeamNames: aiResearchFocusTeamNames(),
  };
}

async function generateAiPrefill() {
  const cacheKey = currentResearchCacheKey();
  if (aiPrefill.assessments?.length && aiPrefill.cacheKey === cacheKey) {
    aiPrefill = {
      ...aiPrefill,
      status: 'cached',
      cacheHit: true,
    };
    return;
  }

  aiPrefill = {
    ...aiPrefill,
    status: 'running',
    cacheHit: false,
    appliedAt: null,
  };
  const job = await startBackgroundJob('aiPrefill', AI_PREFILL_JOB_URL, aiPrefillPayload());
  aiPrefill = {
    ...job.result,
    status: 'ready',
    cacheKey,
    cacheHit: false,
    appliedAt: null,
  };
}

function applyAiPrefill(assessments = aiPrefill.assessments) {
  assessments.forEach((assessment) => {
    const team = findTeamByName(assessment.teamName);
    if (!team) return;
    team.coach = Number(clamp(assessment.coach, 0, 10).toFixed(1));
    team.experience = Number(clamp(assessment.experience, 0, 10).toFixed(1));
    team.continuity = Number(clamp(assessment.continuity, 0, 10).toFixed(1));
    team.injuries = Number(clamp(assessment.injuries, 0, 10).toFixed(1));
    team.form = Number(clamp(assessment.form, 0, 10).toFixed(1));
  });
}

function applyAiPrefillAndMark(assessments = aiPrefill.assessments) {
  if (!Array.isArray(assessments) || !assessments.length) return;
  applyAiPrefill(assessments);
  aiPrefill = {
    ...aiPrefill,
    appliedAt: new Date().toISOString(),
  };
}

function syncAutoRefreshTimer() {
  window.clearInterval(liveRefreshTimer);
  if (!portfolio.autoSync) return;

  liveRefreshTimer = window.setInterval(() => {
    syncTournamentAndLiveContext({ applyOdds: true, applyNews: portfolio.autoApplyNews })
      .then(() => renderAll())
      .catch((error) => console.warn('Failed to refresh live tournament context', error));
  }, portfolio.autoRefreshMinutes * 60_000);
}

function renderWeightControls() {
  weightControls.innerHTML = Object.entries(weightMeta)
    .map(([key, meta]) => `
      <div class="control-card">
        <label for="weight-${key}">
          <span>${meta.label}</span>
          <span id="weight-value-${key}">${weights[key]}</span>
        </label>
        <input id="weight-${key}" type="range" min="${meta.min}" max="${meta.max}" value="${weights[key]}" />
      </div>
    `)
    .join('');

  Object.keys(weightMeta).forEach((key) => {
    document.getElementById(`weight-${key}`).addEventListener('input', (event) => {
      weights[key] = Number(event.target.value);
      document.getElementById(`weight-value-${key}`).textContent = String(weights[key]);
      renderAll();
    });
  });
}

function renderSummaryCards(championOdds, matchups, averageUpsetSeed, currentRound) {
  const bestEdge = matchups
    .flatMap((matchup) => [
      matchup.edgeA !== null ? { team: matchup.teamA.name, edge: matchup.edgeA, confidence: matchup.confidence } : null,
      matchup.edgeB !== null ? { team: matchup.teamB.name, edge: matchup.edgeB, confidence: matchup.confidence } : null,
    ])
    .filter(Boolean)
    .sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence))[0];

  const leader = championOdds[0];
  const avgEdge = average(
    matchups
      .flatMap((matchup) => [matchup.edgeA, matchup.edgeB])
      .filter((edge) => edge !== null)
      .map((edge) => Math.abs(edge * 100))
  );

  const avgConfidence = average(matchups.map((matchup) => matchup.confidence * 100));

  summaryCards.innerHTML = `
    <div class="summary-card">
      <small>Most likely champion</small>
      <strong>${leader ? leader.name : 'Run simulation'}</strong>
      <small>${leader ? `${leader.titleOdds}% title · ${leader.finalsOdds}% finals` : 'Monte Carlo results populate after a run completes.'}</small>
    </div>
    <div class="summary-card">
      <small>Best weighted edge</small>
      <strong>${bestEdge ? bestEdge.team : 'N/A'}</strong>
      <small>${bestEdge ? `${(bestEdge.edge * 100).toFixed(1)} pts · ${(bestEdge.confidence * 100).toFixed(0)} confidence` : 'Enter prices to compare.'}</small>
    </div>
    <div class="summary-card">
      <small>Average model/book gap</small>
      <strong>${avgEdge.toFixed(1)} pts</strong>
      <small>Absolute ${currentRound.roundLabel.toLowerCase()} disagreement after vig-aware normalization.</small>
    </div>
    <div class="summary-card">
      <small>Field volatility</small>
      <strong>${championOdds.length ? averageUpsetSeed.toFixed(1) : '—'}</strong>
      <small>${championOdds.length ? `Average seed of simulated upset winners · ${avgConfidence.toFixed(0)} average confidence` : 'Rerun the simulation to estimate path-dependent volatility.'}</small>
    </div>
  `;
}

function renderSeasonStatus() {
  if (!seasonMeta) {
    const placeholderField = buildDefaultTeams();
    const looksCustom = teams.some((team, index) => {
      const baseline = placeholderField[index];
      return !baseline
        || baseline.name !== team.name
        || baseline.region !== team.region
        || baseline.seed !== team.seed;
    });
    seasonStatus.innerHTML = `
      <article class="season-card">
        <small>Field source</small>
        <strong>${looksCustom ? 'Saved custom field' : 'Demo fallback'}</strong>
        <p>${looksCustom ? 'The app restored a previously saved field without official-season metadata. If you see unexpected teams, load the official 2026 NCAA field or clear the database and start over.' : 'The app is using local placeholder teams right now. Load the official 2026 NCAA field to replace them.'}</p>
      </article>
    `;
    return;
  }

  const caveats = (seasonMeta.caveats || []).slice(0, 3).map((item) => `<li>${item}</li>`).join('');
  seasonStatus.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Field source</small>
      <strong>Official NCAA 2026 field</strong>
      <p>${seasonMeta.note}</p>
      <div class="season-meta-row">
        <span class="tag">Stats updated ${seasonMeta.statsLastUpdated}</span>
        <a class="tag season-link" href="${seasonMeta.sourceUrl}" target="_blank" rel="noreferrer">Open bracket source</a>
        <a class="tag season-link" href="${seasonMeta.statsUrl}" target="_blank" rel="noreferrer">Open stats feed</a>
      </div>
    </article>
    <article class="season-card">
      <small>Important caveats</small>
      <strong>Still needs live context</strong>
      <ul class="season-list">${caveats}</ul>
    </article>
  `;
}

function renderRecommendationBoard(matchups, recommendations) {
  const best = recommendations[0] || buildBetRows(matchups).find((row) => !recommendationAlreadyTracked(row));
  if (!best) {
    recommendationBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Recommendation</small>
        <strong>No new bet to place right now</strong>
        <p>Either the live round has no bankroll-ready edge yet, or every viable matchup is already tracked in the paper ledger. Settle or delete an open ticket to make that game actionable again.</p>
      </article>
    `;
    return;
  }

  const bestTeamSignal = liveContext.teamSignals?.find((signal) => signal.teamName === best.team.name) || null;
  const opponentSignal = liveContext.teamSignals?.find((signal) => signal.teamName === best.opponent.name) || null;
  const existingOpenBet = findOpenTrackedBetForRecommendation(best);

  recommendationBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Current top edge</small>
      <strong>${best.team.name} over ${best.opponent.name}</strong>
      <p>${best.roundLabel} · ${best.region}. Model ${((best.probability) * 100).toFixed(1)}% to win, fair ${best.fair > 0 ? '+' : ''}${best.fair}, market ${best.market > 0 ? '+' : ''}${best.market}, weighted edge ${(best.edge * 100).toFixed(1)} points.</p>
      <div class="season-meta-row">
        <span class="tag">Proj ${best.team.name} ${Math.round(best.projection.teamAPoints)}-${Math.round(best.projection.teamBPoints)} ${best.opponent.name}</span>
        <span class="tag">NET #${best.team.netRanking || '—'}</span>
        <span class="tag">Last 10 ${best.team.lastTenRecord || '—'}</span>
        <span class="tag">${(best.confidence * 100).toFixed(0)} confidence</span>
        <span class="tag">${best.hedgeStyleLabel}</span>
        ${best.startTime ? `<span class="tag">${best.startTime}</span>` : ''}
      </div>
    </article>
    <article class="season-card">
      <small>How to bet it</small>
      <strong>${best.team.name}</strong>
      <ul class="season-list">
        <li>Offense ${best.team.adjO.toFixed(1)} vs opponent defense ${best.opponent.adjD.toFixed(1)}.</li>
        <li>Effective FG ${best.team.efg.toFixed(1)}% and estimated pace ${best.projection.pace.toFixed(1)} possessions.</li>
        <li>${best.stake ? `Primary stake ${formatCurrency(best.stake)} with ${formatCurrency(best.totalOutlay)} total outlay under the ${best.hedgeStyleLabel.toLowerCase()} plan. Net result is ${formatSignedCurrency(best.ifPickWins)} if ${best.team.name} wins and ${formatSignedCurrency(best.ifHedgeWins)} if ${best.opponent.name} wins.` : 'No bankroll stake yet because the edge does not survive the current loss-control settings.'}</li>
        <li>${best.configuredHedgeStyle === 'adaptive' && best.adaptiveReason ? best.adaptiveReason : `Portfolio hedge mode is currently ${hedgeStyleLabel(best.configuredHedgeStyle).toLowerCase()}.`}</li>
        <li>${best.stake ? `This recommendation only survives if it clears ${(portfolio.minEdgePct).toFixed(1)} edge points, ${(portfolio.minConfidence * 100).toFixed(0)}% confidence, a ${(portfolio.kellyMultiplier * 100).toFixed(0)}% Kelly multiplier, a ${portfolio.maxStakePct}% per-bet cap, and a ${portfolio.maxOpenRiskPct}% open-risk cap.` : 'No hedge math yet because there is no approved stake.'}</li>
        <li>${best.equalHedgeStake && best.equalHedgeOutcome ? `Equal-result hedge: ${formatCurrency(best.equalHedgeStake)} on ${best.opponent.name} at ${formatMoneyline(best.opponentMarket)} would lock about ${formatSignedCurrency(best.equalHedgeOutcome.ifPickWins)} either way.` : 'Equal-result hedge appears once both sides have live moneylines.'}</li>
        <li>${best.breakEvenHedge && best.breakEvenOutcome ? `Break-even hedge: ${formatCurrency(best.breakEvenHedge)} on ${best.opponent.name} gets you about ${formatSignedCurrency(best.breakEvenOutcome.ifHedgeWins)} if the pick loses, while still leaving about ${formatSignedCurrency(best.breakEvenOutcome.ifPickWins)} if the pick wins.` : 'Break-even hedge appears once both sides have live moneylines.'}</li>
        <li>${existingOpenBet ? `This game is already tracked in the ledger as ${existingOpenBet.teamName} vs ${existingOpenBet.opponentName} with ${formatCurrency(existingOpenBet.totalOutlay)} outlay, so the app will not add a second open ticket for it.` : 'No open ticket exists for this game yet.'}</li>
        <li>${bestTeamSignal ? `${best.team.name} live news signal: suggested injuries ${bestTeamSignal.suggestedInjuries.toFixed(1)} from ${bestTeamSignal.articleCount} recent articles.` : 'No strong live news signal on the recommended side yet.'}</li>
        <li>${opponentSignal ? `${best.opponent.name} live news signal: suggested injuries ${opponentSignal.suggestedInjuries.toFixed(1)} from ${opponentSignal.articleCount} recent articles.` : 'Opponent news context is still light, so manual scouting still matters.'}</li>
      </ul>
    </article>
  `;
}

function renderGlossary() {
  const officialCards = glossary.map((item) => `
    <article class="glossary-card">
      <small>${item.category}</small>
      <strong>${item.label}</strong>
      <p>${item.description}</p>
    </article>
  `);

  const localCards = localModelConcepts.map((item) => `
    <article class="glossary-card">
      <small>${item.category}</small>
      <strong>${item.label}</strong>
      <p>${item.description}</p>
    </article>
  `);

  glossaryBoard.innerHTML = [...officialCards, ...localCards].join('');
}

function renderBacktest() {
  if (!backtestResults) {
    backtestBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Coverage</small>
        <strong>Backtest not loaded</strong>
        <p>Use the "Run historical backtest" button to score the model against archived NCAA brackets.</p>
      </article>
    `;
    return;
  }

  const aggregate = backtestResults.aggregate;
  const stale = !historicalResultsAreCurrent(backtestResults);
  const header = `
    <article class="season-card season-card--wide">
      <small>Aggregate baseline</small>
      <strong>${(aggregate.noLookaheadAccuracy * 100).toFixed(1)}% no-lookahead bracket-start accuracy</strong>
      <p>${backtestResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${stale ? 'Needs rerun for current weights' : 'Current live weights'}</span>
        <span class="tag">${aggregate.noLookaheadCorrectPicks}/${aggregate.noLookaheadTotalGames} bracket-start picks correct</span>
        <span class="tag">Round replay ${(aggregate.overallAccuracy * 100).toFixed(1)}%</span>
        <span class="tag">${aggregate.championHits}/${aggregate.yearsCovered} champion hits</span>
        <span class="tag">Avg Brier ${aggregate.averageBrier.toFixed(3)}</span>
      </div>
      ${stale ? '<p>The live weights changed after this run. Rerun the backtest to compare the same model the Monte Carlo is using now.</p>' : ''}
    </article>
  `;

  const yearCards = backtestResults.years.map((year) => `
    <article class="season-card">
      <small>${year.year}</small>
      <strong>${(year.noLookaheadAccuracy * 100).toFixed(1)}% bracket-start accuracy</strong>
      <p>Champion pick: ${year.championPick}. Actual champion: ${year.actualChampion}. ${year.championHit ? 'Hit.' : 'Miss.'} Round replay ${(year.overallAccuracy * 100).toFixed(1)}%.</p>
      <div class="season-meta-row">
        <span class="tag">${year.noLookaheadCorrectPicks}/${year.noLookaheadTotalGames} bracket-start picks correct</span>
        <span class="tag">Round replay ${year.correctPicks}/${year.totalGames}</span>
        <span class="tag">Brier ${year.averageBrier.toFixed(3)}</span>
      </div>
      <ul class="season-list">
        ${year.noLookaheadRounds.map((round) => `<li>${round.label}: ${round.correct}/${round.total} (${(round.accuracy * 100).toFixed(1)}%)</li>`).join('')}
      </ul>
    </article>
  `).join('');

  backtestBoard.innerHTML = header + yearCards;
}

function renderScoreBacktest() {
  if (!scoreBacktestResults) {
    scoreBacktestBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Coverage</small>
        <strong>Score replay not loaded</strong>
        <p>Run the score replay to audit frozen pregame score forecasts on archived NCAA tournaments without lookahead bias.</p>
      </article>
    `;
    return;
  }

  const aggregate = scoreBacktestResults.aggregate;
  const stale = !historicalResultsAreCurrent(scoreBacktestResults);
  const header = `
    <article class="season-card season-card--wide">
      <small>Aggregate score audit</small>
      <strong>${(aggregate.winnerAccuracy * 100).toFixed(1)}% winner accuracy · team MAE ${aggregate.teamScoreMae.toFixed(1)}</strong>
      <p>${scoreBacktestResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${stale ? 'Needs rerun for current weights' : 'Current live weights'}</span>
        <span class="tag">${aggregate.gamesGraded} graded games</span>
        <span class="tag">Team RMSE ${aggregate.teamScoreRmse.toFixed(1)}</span>
        <span class="tag">Margin MAE ${aggregate.marginMae.toFixed(1)} · RMSE ${aggregate.marginRmse.toFixed(1)}</span>
        <span class="tag">Total MAE ${aggregate.totalMae.toFixed(1)} · RMSE ${aggregate.totalRmse.toFixed(1)}</span>
      </div>
      ${stale ? '<p>The live weights changed after this run. Rerun the score replay to audit the same model the Monte Carlo is using now.</p>' : ''}
    </article>
  `;

  const yearCards = scoreBacktestResults.years.map((year) => `
    <article class="season-card">
      <small>${year.year}</small>
      <strong>${(year.winnerAccuracy * 100).toFixed(1)}% winner accuracy</strong>
      <p>${year.gamesGraded} graded games · team MAE ${year.teamScoreMae.toFixed(1)} · margin MAE ${year.marginMae.toFixed(1)} · total MAE ${year.totalMae.toFixed(1)}.</p>
      <ul class="season-list">
        ${year.rounds.map((round) => `<li>${round.label}: ${round.games} games · ${(round.winnerAccuracy * 100).toFixed(1)}% winner accuracy · team MAE ${round.teamScoreMae.toFixed(1)} · total MAE ${round.totalMae.toFixed(1)}</li>`).join('')}
      </ul>
    </article>
  `).join('');

  scoreBacktestBoard.innerHTML = header + yearCards;
}

function renderEvolution() {
  const job = backgroundJobs.evolution;
  if (job && ['queued', 'running'].includes(job.status)) {
    applyEvolutionButton.disabled = true;
  }
  if (job && ['queued', 'running'].includes(job.status)) {
    evolutionBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Evolution run</small>
        <strong>${Math.round(job.progress * 100)}% complete</strong>
        <p>${job.message || 'Running heavy evolution search in the background.'}</p>
        <div class="inline-progress">
          <div class="inline-progress__bar" style="width:${Math.round(job.progress * 100)}%"></div>
        </div>
      </article>
    `;
    return;
  }
  if (!evolutionResults) {
    applyEvolutionButton.disabled = true;
    evolutionBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Coverage</small>
        <strong>Evolution lab not run yet</strong>
        <p>Run the evolution lab to search historical weight profiles, cross-check them with leave-one-year-out folds, and generate a conservative weight recommendation for the current season.</p>
      </article>
    `;
    return;
  }

  const recommended = evolutionResults.recommendedWeights;
  const defaults = evolutionResults.defaults;
  const review = evolutionResults.promotionReview;
  const reviewStale = historicalWeightsSignature(evolutionResults.anchorWeights) !== historicalWeightsSignature();
  applyEvolutionButton.disabled = !review?.promote || reviewStale;
  const weightCards = [
    ['Efficiency', defaults.efficiency, recommended.efficiency],
    ['Seed prior', defaults.seed, recommended.seed],
    ['Four Factors', defaults.fourFactors, recommended.fourFactors],
    ['Recent form', defaults.momentum, recommended.momentum],
    ['Injury penalty', defaults.injuries, recommended.injuries],
    ['Soft factors', defaults.softFactors, recommended.softFactors],
    ['Uncertainty', defaults.uncertainty, recommended.uncertainty],
  ].map(([label, baseline, evolved]) => `<li>${label}: ${Number(baseline).toFixed(1)} -> ${Number(evolved).toFixed(1)} (${formatSignedNumber(Number(evolved) - Number(baseline), 1)})</li>`).join('');

  const leaderCards = (evolutionResults.candidates || []).map((candidate) => `
    <article class="season-card">
      <small>Candidate #${candidate.rank}</small>
      <strong>${(candidate.averageAccuracy * 100).toFixed(1)}% avg accuracy</strong>
      <p>Avg Brier ${candidate.averageBrier.toFixed(3)} · worst-year accuracy ${(candidate.worstYearAccuracy * 100).toFixed(1)}% · stability penalty ${candidate.brierStddev.toFixed(3)}.</p>
      <ul class="season-list">
        <li>Eff ${candidate.weights.efficiency.toFixed(1)} · Seed ${candidate.weights.seed.toFixed(1)} · Four ${candidate.weights.fourFactors.toFixed(1)}</li>
        <li>Mom ${candidate.weights.momentum.toFixed(1)} · Inj ${candidate.weights.injuries.toFixed(1)} · Soft ${candidate.weights.softFactors.toFixed(1)} · Unc ${candidate.weights.uncertainty.toFixed(1)}</li>
      </ul>
    </article>
  `).join('');

  const foldCards = (evolutionResults.foldSummaries || []).map((fold) => `
    <article class="season-card">
      <small>Holdout ${fold.holdoutYear}</small>
      <strong>${(fold.holdoutAccuracy * 100).toFixed(1)}% holdout accuracy</strong>
      <p>Holdout Brier ${fold.holdoutBrier.toFixed(3)} after training on ${fold.trainYears.join(', ')}.</p>
      <ul class="season-list">
        <li>Eff ${fold.selectedWeights.efficiency.toFixed(1)} · Seed ${fold.selectedWeights.seed.toFixed(1)} · Four ${fold.selectedWeights.fourFactors.toFixed(1)}</li>
        <li>Mom ${fold.selectedWeights.momentum.toFixed(1)} · Inj ${fold.selectedWeights.injuries.toFixed(1)} · Soft ${fold.selectedWeights.softFactors.toFixed(1)} · Unc ${fold.selectedWeights.uncertainty.toFixed(1)}</li>
      </ul>
    </article>
  `).join('');

  const reviewCard = review ? `
    <article class="season-card season-card--wide">
      <small>Promotion gate</small>
      <strong>${review.promote ? 'Approved for live promotion' : 'Hold the current live weights'}</strong>
      <p>${review.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${reviewStale ? 'Review is stale' : 'Review matches current weights'}</span>
        <span class="tag">Acc ${formatSignedNumber(review.deltaAccuracy * 100, 1)} pts</span>
        <span class="tag">Brier ${formatSignedNumber(review.deltaBrier, 3)}</span>
        <span class="tag">Team MAE ${formatSignedNumber(review.deltaTeamScoreMae, 2)}</span>
        <span class="tag">Margin MAE ${formatSignedNumber(review.deltaMarginMae, 2)}</span>
      </div>
      <ul class="season-list">
        ${(review.gateReasons || []).map((reason) => `<li>${reason}</li>`).join('')}
      </ul>
      <p>${reviewStale ? 'The live weights changed after this review ran. Rerun the evolution lab before applying anything.' : review.caution}</p>
    </article>
  ` : '';

  evolutionBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Recommended profile</small>
      <strong>${(evolutionResults.holdoutAverageAccuracy * 100).toFixed(1)}% avg holdout accuracy · Brier ${evolutionResults.holdoutAverageBrier.toFixed(3)}</strong>
      <p>${evolutionResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">Anchored to current live weights</span>
        <span class="tag">${evolutionResults.populationSize} population</span>
        <span class="tag">${evolutionResults.generations} generations</span>
        <span class="tag">${evolutionResults.restarts || 1} restarts</span>
        <span class="tag">${(evolutionResults.evaluatedSeasonsAccuracy * 100).toFixed(1)}% recommended-profile accuracy</span>
        <span class="tag">Brier ${evolutionResults.evaluatedSeasonsBrier.toFixed(3)}</span>
      </div>
      <ul class="season-list">${weightCards}</ul>
    </article>
    <article class="season-card">
      <small>Caution</small>
      <strong>Slow-learning only</strong>
      <p>${evolutionResults.caution}</p>
    </article>
    <article class="season-card">
      <small>Meta signals</small>
      <strong>Stable historical lessons</strong>
      <ul class="season-list">
        ${(evolutionResults.metaSignals || []).map((signal) => `<li>${signal}</li>`).join('')}
      </ul>
    </article>
    ${reviewCard}
    ${leaderCards}
    ${foldCards}
  `;
}

function renderStrategyEvolution() {
  const job = backgroundJobs.strategyEvolution;
  if (job && ['queued', 'running'].includes(job.status)) {
    strategyBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Strategy run</small>
        <strong>${Math.round(job.progress * 100)}% complete</strong>
        <p>${job.message || 'Running heavy strategy search in the background.'}</p>
        <div class="inline-progress">
          <div class="inline-progress__bar" style="width:${Math.round(job.progress * 100)}%"></div>
        </div>
      </article>
    `;
    return;
  }
  if (!strategyResults) {
    strategyBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Coverage</small>
        <strong>Strategy lab not run yet</strong>
        <p>Run the strategy lab to learn a conservative paper-trading profile for edge threshold, Kelly sizing, risk caps, confidence gating, and hedge style.</p>
      </article>
    `;
    return;
  }

  const defaults = strategyResults.defaults;
  const recommended = strategyResults.recommendedProfile;
  const profileCards = [
    ['Min edge', defaults.minEdgePct, recommended.minEdgePct, ' pts'],
    ['Kelly', defaults.kellyMultiplier, recommended.kellyMultiplier, 'x'],
    ['Max stake', defaults.maxStakePct, recommended.maxStakePct, '%'],
    ['Max open risk', defaults.maxOpenRiskPct, recommended.maxOpenRiskPct, '%'],
    ['Min confidence', defaults.minConfidence, recommended.minConfidence, ''],
  ].map(([label, baseline, evolved, suffix]) => `<li>${label}: ${Number(baseline).toFixed(2)}${suffix} -> ${Number(evolved).toFixed(2)}${suffix} (${formatSignedNumber(Number(evolved) - Number(baseline), 2)})</li>`).join('');

  const leaderCards = (strategyResults.candidates || []).map((candidate) => `
    <article class="season-card">
      <small>Candidate #${candidate.rank}</small>
      <strong>${(candidate.averageRoi * 100).toFixed(1)}% avg ROI</strong>
      <p>Avg log growth ${candidate.averageLogGrowth.toFixed(3)} · worst-year ROI ${(candidate.worstYearRoi * 100).toFixed(1)}% · avg drawdown ${(candidate.averageDrawdown * 100).toFixed(1)}%.</p>
      <ul class="season-list">
        <li>Min edge ${candidate.profile.minEdgePct.toFixed(2)} pts · Kelly ${candidate.profile.kellyMultiplier.toFixed(2)}x · max stake ${candidate.profile.maxStakePct.toFixed(1)}%</li>
        <li>Open risk ${candidate.profile.maxOpenRiskPct.toFixed(1)}% · min confidence ${candidate.profile.minConfidence.toFixed(2)} · ${hedgeStyleLabel(candidate.profile.hedgeStyle)}</li>
      </ul>
    </article>
  `).join('');

  const foldCards = (strategyResults.foldSummaries || []).map((fold) => `
    <article class="season-card">
      <small>Holdout ${fold.holdoutYear}</small>
      <strong>${(fold.holdoutRoi * 100).toFixed(1)}% holdout ROI</strong>
      <p>Log growth ${fold.holdoutLogGrowth.toFixed(3)} · drawdown ${(fold.holdoutDrawdown * 100).toFixed(1)}% after training on ${fold.trainYears.join(', ')}.</p>
      <ul class="season-list">
        <li>Min edge ${fold.selectedProfile.minEdgePct.toFixed(2)} pts · Kelly ${fold.selectedProfile.kellyMultiplier.toFixed(2)}x · max stake ${fold.selectedProfile.maxStakePct.toFixed(1)}%</li>
        <li>Open risk ${fold.selectedProfile.maxOpenRiskPct.toFixed(1)}% · min confidence ${fold.selectedProfile.minConfidence.toFixed(2)} · ${hedgeStyleLabel(fold.selectedProfile.hedgeStyle)} · ${fold.holdoutBets} bets</li>
      </ul>
    </article>
  `).join('');

  strategyBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Recommended profile</small>
      <strong>${(strategyResults.holdoutAverageRoi * 100).toFixed(1)}% avg holdout ROI · log growth ${strategyResults.holdoutAverageLogGrowth.toFixed(3)}</strong>
      <p>${strategyResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${strategyResults.populationSize} population</span>
        <span class="tag">${strategyResults.generations} generations</span>
        <span class="tag">${strategyResults.restarts || 1} restarts</span>
        <span class="tag">${(strategyResults.evaluatedSeasonsRoi * 100).toFixed(1)}% all-years ROI</span>
        <span class="tag">${(strategyResults.evaluatedSeasonsDrawdown * 100).toFixed(1)}% avg drawdown</span>
        <span class="tag">${hedgeStyleLabel(recommended.hedgeStyle)}</span>
      </div>
      <ul class="season-list">
        ${profileCards}
        <li>Hedge style: ${hedgeStyleLabel(defaults.hedgeStyle)} -> ${hedgeStyleLabel(recommended.hedgeStyle)}.</li>
      </ul>
    </article>
    <article class="season-card">
      <small>Caution</small>
      <strong>Paper-trading guidance only</strong>
      <p>${strategyResults.caution}</p>
    </article>
    <article class="season-card">
      <small>Meta signals</small>
      <strong>What archived tournaments favored</strong>
      <ul class="season-list">
        ${(strategyResults.metaSignals || []).map((signal) => `<li>${signal}</li>`).join('')}
      </ul>
    </article>
    ${leaderCards}
    ${foldCards}
  `;
}

function renderChampionBoard(championOdds) {
  if (!championOdds.length) {
    championBoard.innerHTML = `
      <div class="list-card">
        <div>
          <strong>Champion odds waiting on simulation</strong>
          <div class="board-subtext">Run the Monte Carlo engine to populate title, finals, and Final Four probabilities.</div>
        </div>
        <span class="warn-pill">—</span>
      </div>
    `;
    return;
  }

  championBoard.innerHTML = championOdds.slice(0, 10).map((team) => `
    <div class="list-card">
      <div>
        <strong>${team.name}</strong>
        <div class="board-subtext">Finals ${team.finalsOdds}% · Final Four ${team.finalFourOdds}% · Sweet 16 ${team.sweet16Odds}%</div>
      </div>
      <span class="score-pill">${team.titleOdds}%</span>
    </div>
  `).join('');
}

function edgeClass(edge, confidence) {
  const weighted = edge * confidence;
  if (weighted > 0.03) return 'edge-pill';
  if (weighted > 0) return 'warn-pill';
  return 'bad-pill';
}

function renderEdgeBoard(matchups) {
  const edgeRows = matchups
    .flatMap((matchup) => [
      matchup.edgeA !== null ? {
        team: matchup.teamA.name,
        opponent: matchup.teamB.name,
        region: matchup.region,
        roundLabel: matchup.roundLabel,
        edge: matchup.edgeA,
        fair: probabilityToAmerican(matchup.probabilityA),
        market: matchup.teamA.marketMl,
        confidence: matchup.confidence,
      } : null,
      matchup.edgeB !== null ? {
        team: matchup.teamB.name,
        opponent: matchup.teamA.name,
        region: matchup.region,
        roundLabel: matchup.roundLabel,
        edge: matchup.edgeB,
        fair: probabilityToAmerican(1 - matchup.probabilityA),
        market: matchup.teamB.marketMl,
        confidence: matchup.confidence,
      } : null,
    ])
    .filter(Boolean)
    .sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence))
    .slice(0, 10);

  if (!edgeRows.length) {
    edgeBoard.innerHTML = `
      <div class="list-card">
        <div>
          <strong>No live round edges yet</strong>
          <div class="board-subtext">Sync finished results and current odds to populate the next betting round.</div>
        </div>
        <span class="warn-pill">—</span>
      </div>
    `;
    return;
  }

  edgeBoard.innerHTML = edgeRows.map((row) => `
    <div class="list-card">
      <div>
        <strong>${row.team}</strong>
        <div class="board-subtext">${row.roundLabel} · ${row.region} vs ${row.opponent} · Fair ${row.fair > 0 ? '+' : ''}${row.fair} · Market ${row.market > 0 ? '+' : ''}${row.market} · ${(row.confidence * 100).toFixed(0)} conf</div>
      </div>
      <span class="${edgeClass(row.edge, row.confidence)}">${(row.edge * 100).toFixed(1)} pts</span>
    </div>
  `).join('');
}

function renderMarketBoard(matchups) {
  if (!matchups.length) {
    marketBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Current round</small>
        <strong>No open games to price</strong>
        <p>The board will repopulate as soon as the tournament sync exposes the next unresolved matchup set.</p>
      </article>
    `;
    return;
  }

  marketBoard.innerHTML = matchups.map((matchup, index) => {
    const fairA = probabilityToAmerican(matchup.probabilityA);
    const fairB = probabilityToAmerican(1 - matchup.probabilityA);
    const marketA = matchup.marketA === null ? '—' : `${(matchup.marketA * 100).toFixed(1)}%`;
    const marketB = matchup.marketB === null ? '—' : `${(matchup.marketB * 100).toFixed(1)}%`;

    return `
      <article class="market-match">
        <h3>${matchup.roundLabel} · ${matchup.region}: ${matchup.teamA.seed} vs ${matchup.teamB.seed}</h3>
        <div class="market-meta">Academic blend = efficiency model + soft-factor overlay + seed prior + no-vig market prior, then uncertainty shrinkage.</div>
        <div class="market-meta">Projected score: ${matchup.teamA.name} ${Math.round(matchup.projection.teamAPoints)} - ${Math.round(matchup.projection.teamBPoints)} ${matchup.teamB.name} · ${matchup.projection.pace.toFixed(1)} poss</div>
        ${matchup.startTime ? `<div class="market-meta">Tip ${matchup.startTime}</div>` : ''}
        <div class="market-line">
          <div class="market-line__team">
            <strong>${matchup.teamA.name}</strong>
            <div class="price-line">Model ${(matchup.probabilityA * 100).toFixed(1)}% · Fair ${fairA > 0 ? '+' : ''}${fairA} · Market ${marketA}</div>
          </div>
          <input type="number" data-market-index="${index}" data-side="A" value="${matchup.teamA.marketMl}" />
          <span class="${edgeClass(matchup.edgeA, matchup.confidence)}">${(matchup.edgeA * 100).toFixed(1)} pts</span>
        </div>
        <div class="market-line">
          <div class="market-line__team">
            <strong>${matchup.teamB.name}</strong>
            <div class="price-line">Model ${((1 - matchup.probabilityA) * 100).toFixed(1)}% · Fair ${fairB > 0 ? '+' : ''}${fairB} · Market ${marketB}</div>
          </div>
          <input type="number" data-market-index="${index}" data-side="B" value="${matchup.teamB.marketMl}" />
          <span class="${edgeClass(matchup.edgeB, matchup.confidence)}">${(matchup.edgeB * 100).toFixed(1)} pts</span>
        </div>
        <div class="market-meta">Components: model ${(matchup.components.pureModel * 100).toFixed(1)}% · seed ${(matchup.components.seedPrior * 100).toFixed(1)}%${matchup.components.marketPrior !== null ? ` · market ${(matchup.components.marketPrior * 100).toFixed(1)}%` : ''} · soft ${(softScore(matchup.teamA) - softScore(matchup.teamB)).toFixed(1)} gap · hold ${matchup.hold !== null ? `${(matchup.hold * 100).toFixed(1)}%` : '—'} · confidence ${(matchup.confidence * 100).toFixed(0)}%</div>
      </article>
    `;
  }).join('');

  marketBoard.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', (event) => {
      const matchup = matchups[Number(event.target.dataset.marketIndex)];
      const value = Number(event.target.value);
      const teamId = event.target.dataset.side === 'A' ? matchup.teamA.id : matchup.teamB.id;
      const team = teams.find((item) => item.id === teamId);
      team.marketMl = value;
      renderAll();
    });
  });
}

function renderTeamTable() {
  const orderedTeams = [...teams].sort((a, b) => a.region.localeCompare(b.region) || a.seed - b.seed || a.name.localeCompare(b.name));
  teamTableBody.innerHTML = orderedTeams.map((team) => `
    <tr>
      <td>
        <select class="region-select" data-id="${team.id}" data-region-field="region">
          ${regions.map((region) => `<option value="${region}" ${region === team.region ? 'selected' : ''}>${region}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" min="1" max="16" data-id="${team.id}" data-field="seed" value="${team.seed}" /></td>
      <td><input class="team-input" data-id="${team.id}" data-field="name" value="${team.name}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="adjO" value="${team.adjO}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="adjD" value="${team.adjD}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="efg" value="${team.efg}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="tov" value="${team.tov}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="orb" value="${team.orb}" /></td>
      <td><input type="number" step="0.1" data-id="${team.id}" data-field="ftr" value="${team.ftr}" /></td>
      <td><input type="number" step="0.1" min="0" max="10" data-id="${team.id}" data-field="form" value="${team.form}" /></td>
      <td><input type="number" step="0.1" min="0" max="10" data-id="${team.id}" data-field="injuries" value="${team.injuries}" /></td>
      <td><input type="number" step="0.1" min="0" max="10" data-id="${team.id}" data-field="coach" value="${team.coach}" /></td>
      <td><input type="number" step="0.1" min="0" max="10" data-id="${team.id}" data-field="experience" value="${team.experience}" /></td>
      <td><input type="number" step="0.1" min="0" max="10" data-id="${team.id}" data-field="continuity" value="${team.continuity}" /></td>
      <td><input type="number" step="1" data-id="${team.id}" data-field="marketMl" value="${team.marketMl}" /></td>
      <td><span class="score-pill">${teamScore(team)}</span></td>
    </tr>
  `).join('');

  teamTableBody.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('input', (event) => {
      const team = teams.find((item) => item.id === event.target.dataset.id);
      if (event.target.dataset.regionField === 'region') {
        team.region = event.target.value;
      } else {
        const field = event.target.dataset.field;
        team[field] = field === 'name' ? event.target.value : Number(event.target.value);
      }
      renderAll();
    });
  });
}

function bracketScoreLine(game) {
  if (tournamentGameIsFinal(game) && Number.isFinite(game.scoreA) && Number.isFinite(game.scoreB)) {
    return `Final ${game.scoreA}-${game.scoreB}`;
  }
  if (tournamentGameIsInProgress(game) && Number.isFinite(game.scoreA) && Number.isFinite(game.scoreB)) {
    return `Live ${game.scoreA}-${game.scoreB}`;
  }
  const projection = projectScore(game.teamA, game.teamB);
  return `Proj ${Math.round(projection.teamAPoints)}-${Math.round(projection.teamBPoints)}`;
}

function renderBracket(sampleBracket) {
  if (!sampleBracket) {
    bracketView.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Bracket view</small>
        <strong>Monte Carlo bracket not ready yet</strong>
        <p>Run the simulation to generate a sampled path through the tournament and update the region-by-region bracket view.</p>
      </article>
    `;
    return;
  }

  const regionColumns = regions.map((region) => {
    const rounds = sampleBracket[region] || [];
    return `
      <div class="bracket-column">
        <h3>${region}</h3>
        ${rounds.map((games, roundIndex) => `
          <div class="bracket-card">
            <h4>${tournamentRoundLabels[roundIndex]}</h4>
            ${games.map((game) => `
              <div>
                <div class="match-line"><span>${game.teamA.seed}. ${game.teamA.name}</span><strong>${(game.probabilityA * 100).toFixed(1)}%</strong></div>
                <div class="match-line"><span>${game.teamB.seed}. ${game.teamB.name}</span><strong>${((1 - game.probabilityA) * 100).toFixed(1)}%</strong></div>
                <div class="market-meta">${bracketScoreLine(game)}</div>
                <div class="winner-line">${game.actualWinnerId ? 'Actual winner' : 'Projected winner'}: ${game.winner.name}</div>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
    `;
  }).join('');

  const finalFour = sampleBracket.finalFour || [];
  const finalColumn = `
    <div class="bracket-column">
      <h3>Final Four</h3>
      <div class="bracket-card">
        <h4>National semis + title</h4>
        ${finalFour.map((game, index) => `
          <div>
            <div class="match-line"><span>${game.teamA.name}</span><strong>${(game.probabilityA * 100).toFixed(1)}%</strong></div>
            <div class="match-line"><span>${game.teamB.name}</span><strong>${((1 - game.probabilityA) * 100).toFixed(1)}%</strong></div>
            <div class="market-meta">${bracketScoreLine(game)}</div>
            <div class="winner-line">${game.actualWinnerId ? (index === 2 ? 'Actual champion' : 'Actual winner') : (index === 2 ? 'Projected champion' : 'Projected winner')}: ${game.winner.name}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  bracketView.innerHTML = regionColumns + finalColumn;
}

function sanitizeField() {
  teams = teams
    .map((team) => ({ ...team, seed: clamp(Math.round(team.seed), 1, 16) }))
    .sort((a, b) => a.region.localeCompare(b.region) || a.seed - b.seed || a.name.localeCompare(b.name));
}

function renderAll() {
  sanitizeField();
  gradePredictionLogFromTournament(tournamentState.games);
  schedulePersistState();
  applyWorkspaceVisibility();
  const bracketState = buildTournamentBracketState();
  const currentSignature = currentSimulationSignature();
  const simulation = simulationState.result && simulationState.signature === currentSignature
    ? simulationState.result
    : createEmptySimulationResult();
  const currentRound = currentTournamentRound(bracketState);
  const matchups = currentRound.matchups;
  const recommendations = buildStakePlan(matchups);
  renderSimulationStatus(currentSignature);
  renderPortfolioControls();
  renderOptimizerJobBoard();
  renderAiStrategyBoard(currentRound, recommendations);
  renderSeasonStatus();
  renderGlossary();
  renderBacktest();
  renderScoreBacktest();
  renderEvolution();
  renderStrategyEvolution();
  renderLiveStatus();
  renderSignalBoard();
  renderNewsBoard();
  renderAiPrefill();
  renderResearchCacheBoard();
  renderTeamTable();
  renderTournamentStatus(currentRound);
  renderPredictionLogBoard(currentRound);
  renderSummaryCards(simulation.championOdds, matchups, simulation.averageUpsetSeed, currentRound);
  renderPortfolioSummary(recommendations, currentRound);
  renderBetSizingBoard(recommendations);
  renderFeedbackLoopBoard(recommendations);
  renderEquityCurve();
  renderBetLedger();
  renderChampionBoard(simulation.championOdds);
  renderEdgeBoard(matchups);
  renderRecommendationBoard(matchups, recommendations);
  renderMarketBoard(matchups);
  renderBracket(simulation.sampleBracket);
  renderOverlayReviewBoard(recommendations);
  applyWorkspaceVisibility();
}

simulateButton.addEventListener('click', () => {
  runTournamentSimulation(simulationState.iterations, buildTournamentBracketState())
    .catch((error) => {
      console.warn('Failed to run Monte Carlo simulation', error);
      simulationState = {
        ...simulationState,
        status: 'idle',
      };
      renderSimulationStatus(currentSimulationSignature());
    });
});
simulationIterationsInput.addEventListener('input', (event) => {
  simulationState = {
    ...simulationState,
    iterations: clamp(Math.round(Number(event.target.value) || 25000), 1000, 1_000_000),
  };
  renderSimulationStatus(currentSimulationSignature());
});
loadOfficialFieldButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('overview');
    await loadOfficialSeason({ replaceExisting: true, resetWeights: true });
    renderWeightControls();
    renderAll();
  } catch (error) {
    console.warn('Failed to load official 2026 season', error);
  }
});
runBacktestButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('validation');
    runBacktestButton.disabled = true;
    await loadBacktest();
    renderAll();
  } catch (error) {
    console.warn('Failed to run historical backtest', error);
    renderBacktest();
  } finally {
    runBacktestButton.disabled = false;
  }
});
runScoreBacktestButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('validation');
    runScoreBacktestButton.disabled = true;
    await loadScoreBacktest();
    renderAll();
  } catch (error) {
    console.warn('Failed to run historical score replay', error);
    renderScoreBacktest();
  } finally {
    runScoreBacktestButton.disabled = false;
  }
});
runEvolutionButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('validation');
    runEvolutionButton.disabled = true;
    await loadEvolution();
    renderAll();
  } catch (error) {
    console.warn('Failed to run evolution lab', error);
    renderEvolution();
  } finally {
    runEvolutionButton.disabled = false;
  }
});
runStrategyButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('validation');
    runStrategyButton.disabled = true;
    await loadStrategyEvolution();
    renderAll();
  } catch (error) {
    console.warn('Failed to run strategy lab', error);
    renderStrategyEvolution();
  } finally {
    runStrategyButton.disabled = false;
  }
});
syncLiveButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('betting');
    syncLiveButton.disabled = true;
    await syncTournamentAndLiveContext({ applyOdds: true, applyNews: portfolio.autoApplyNews });
    renderAll();
  } catch (error) {
    console.warn('Failed to sync tournament results, odds, and news', error);
  } finally {
    syncLiveButton.disabled = false;
  }
});
lockPredictionsButton.addEventListener('click', () => {
  setActiveWorkspace('betting');
  const currentRound = currentTournamentRound(buildTournamentBracketState());
  freezeCurrentRoundPredictions(currentRound);
  renderAll();
});
applyLiveOddsButton.addEventListener('click', () => {
  setActiveWorkspace('betting');
  applyLiveOdds(liveContext.games);
  renderAll();
});
applyNewsSignalsButton.addEventListener('click', () => {
  setActiveWorkspace('research');
  applyNewsSignals(liveContext.teamSignals);
  renderAll();
});
generateAiPrefillButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('research');
    generateAiPrefillButton.disabled = true;
    await generateAiPrefill();
    applyAiPrefillAndMark(aiPrefill.assessments);
    renderAll();
  } catch (error) {
    console.warn('Failed to generate AI prefill', error);
  } finally {
    generateAiPrefillButton.disabled = false;
  }
});
generateAiStrategyButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('betting');
    generateAiStrategyButton.disabled = true;
    const currentRound = currentTournamentRound(buildTournamentBracketState());
    await generateAiStrategyAdvice(currentRound, buildStakePlan(currentRound.matchups));
    applyAiStrategyAdvice();
    renderAll();
  } catch (error) {
    console.warn('Failed to generate AI betting settings', error);
    aiStrategyAdvice = createEmptyAiStrategyAdvice();
    renderAll();
  } finally {
    generateAiStrategyButton.disabled = false;
  }
});
applyAiPrefillButton.addEventListener('click', () => {
  setActiveWorkspace('research');
  applyAiPrefillAndMark(aiPrefill.assessments);
  renderAll();
});
applyAiStrategyButton.addEventListener('click', () => {
  setActiveWorkspace('betting');
  applyAiStrategyAdvice();
  renderAll();
});
applyEvolutionButton.addEventListener('click', async () => {
  const review = evolutionResults?.promotionReview;
  const reviewStale = evolutionResults
    ? historicalWeightsSignature(evolutionResults.anchorWeights) !== historicalWeightsSignature()
    : true;
  if (!review?.promote || reviewStale) {
    setActiveWorkspace('validation');
    renderAll();
    return;
  }

  try {
    setActiveWorkspace('overview');
    applyEvolutionButton.disabled = true;
    applyEvolutionWeights();
    renderWeightControls();
    renderAll();
    await runTournamentSimulation(simulationState.iterations, buildTournamentBracketState());
  } catch (error) {
    console.warn('Failed to rerun Monte Carlo after applying evolved weights', error);
    simulationState = {
      ...simulationState,
      status: 'idle',
    };
    renderSimulationStatus(currentSimulationSignature());
  } finally {
    renderAll();
  }
});
applyStrategyButton.addEventListener('click', () => {
  setActiveWorkspace('betting');
  applyStrategyProfile();
  renderAll();
});
runOverlayReviewButton.addEventListener('click', async () => {
  try {
    setActiveWorkspace('validation');
    runOverlayReviewButton.disabled = true;
    const currentRound = currentTournamentRound(buildTournamentBracketState());
    await runOverlayReview(buildStakePlan(currentRound.matchups));
    renderAll();
  } catch (error) {
    console.warn('Failed to run overlay promotion review', error);
    overlayReview = createEmptyOverlayReview();
    renderAll();
  } finally {
    runOverlayReviewButton.disabled = false;
  }
});
applyOverlayButton.addEventListener('click', () => {
  if (!overlayReview.response?.promote) {
    setActiveWorkspace('validation');
    renderAll();
    return;
  }
  setActiveWorkspace('betting');
  applyApprovedOverlay();
  renderAll();
});
saveLocalButton.addEventListener('click', () => {
  persistState().catch((error) => {
    console.warn('Failed to save sqlite state', error);
  });
});
exportButton.addEventListener('click', exportState);
importButton.addEventListener('click', () => {
  importFileInput.click();
});
importFileInput.addEventListener('change', (event) => {
  const [file] = event.target.files || [];
  if (file) importState(file);
  event.target.value = '';
});
clearStorageButton.addEventListener('click', async () => {
  try {
    await clearStorageAndRestart();
  } catch (error) {
    console.warn('Failed to clear sqlite state and restart', error);
  }
});
resetButton.addEventListener('click', () => {
  setActiveWorkspace('overview');
  teams = cloneTeams(baselineTeams);
  weights = { ...defaultWeights };
  aiPrefill = createEmptyAiPrefill();
  aiStrategyAdvice = createEmptyAiStrategyAdvice();
  tournamentState = createEmptyTournamentState();
  overlayReview = createEmptyOverlayReview();
  predictionLog = createEmptyPredictionLog();
  backgroundJobs = createEmptyBackgroundJobs();
  renderWeightControls();
  renderAll();
});

startingBankrollInput.addEventListener('input', (event) => {
  portfolio.startingBankroll = clamp(Number(event.target.value) || 1000, 100, 1_000_000);
  renderAll();
});
kellyMultiplierInput.addEventListener('input', (event) => {
  portfolio.kellyMultiplier = clamp(Number(event.target.value) || 0, 0, 1);
  renderAll();
});
maxStakePctInput.addEventListener('input', (event) => {
  portfolio.maxStakePct = clamp(Number(event.target.value) || 5, 1, 25);
  renderAll();
});
maxOpenRiskPctInput.addEventListener('input', (event) => {
  portfolio.maxOpenRiskPct = clamp(Number(event.target.value) || 15, 1, 50);
  renderAll();
});
minEdgePctInput.addEventListener('input', (event) => {
  portfolio.minEdgePct = clamp(Number(event.target.value) || 0, 0, 15);
  renderAll();
});
minConfidenceInput.addEventListener('input', (event) => {
  portfolio.minConfidence = clamp(Number(event.target.value) || 0.55, 0.5, 0.95);
  renderAll();
});
hedgeStyleSelect.addEventListener('change', (event) => {
  portfolio.hedgeStyle = normalizeHedgeStyle(event.target.value);
  renderAll();
});
useResearchCacheInput.addEventListener('change', (event) => {
  portfolio.useResearchCache = event.target.checked;
  renderAll();
});
autoRefreshMinutesInput.addEventListener('input', (event) => {
  portfolio.autoRefreshMinutes = clamp(Math.round(Number(event.target.value) || 5), 1, 60);
  syncAutoRefreshTimer();
  renderAll();
});
liveOddsModeSelect.addEventListener('change', (event) => {
  portfolio.liveOddsMode = event.target.value === 'consensus' ? 'consensus' : 'best';
  renderAll();
});
autoSyncInput.addEventListener('change', (event) => {
  portfolio.autoSync = event.target.checked;
  syncAutoRefreshTimer();
  if (portfolio.autoSync) {
    syncTournamentAndLiveContext({ applyOdds: true, applyNews: portfolio.autoApplyNews })
      .then(() => renderAll())
      .catch((error) => {
        console.warn('Failed to prime live tournament sync', error);
        renderAll();
      });
    return;
  }
  renderAll();
});
autoApplyNewsInput.addEventListener('change', (event) => {
  portfolio.autoApplyNews = event.target.checked;
  renderAll();
});
evolutionPopulationInput.addEventListener('input', (event) => {
  optimizerSettings.evolutionPopulation = clamp(Math.round(Number(event.target.value) || 96), 24, 256);
  renderAll();
});
evolutionGenerationsInput.addEventListener('input', (event) => {
  optimizerSettings.evolutionGenerations = clamp(Math.round(Number(event.target.value) || 30), 8, 80);
  renderAll();
});
evolutionRestartsInput.addEventListener('input', (event) => {
  optimizerSettings.evolutionRestarts = clamp(Math.round(Number(event.target.value) || 3), 1, 8);
  renderAll();
});
strategyPopulationInput.addEventListener('input', (event) => {
  optimizerSettings.strategyPopulation = clamp(Math.round(Number(event.target.value) || 84), 24, 256);
  renderAll();
});
strategyGenerationsInput.addEventListener('input', (event) => {
  optimizerSettings.strategyGenerations = clamp(Math.round(Number(event.target.value) || 28), 8, 80);
  renderAll();
});
strategyRestartsInput.addEventListener('input', (event) => {
  optimizerSettings.strategyRestarts = clamp(Math.round(Number(event.target.value) || 3), 1, 8);
  renderAll();
});

window.addEventListener('hashchange', () => {
  const fromHash = window.location.hash.startsWith('#workspace-')
    ? window.location.hash.replace('#workspace-', '')
    : window.localStorage.getItem('madnessWorkspace');
  if (isValidWorkspace(fromHash) && fromHash !== activeWorkspace) {
    setActiveWorkspace(fromHash, { scroll: false });
  }
});

async function boot() {
  initializeWorkspace();
  const restored = await loadPersistedState();
  const replaceWithOfficial = !restored || isDemoField(teams);
  try {
    await loadProviderStatus();
  } catch (error) {
    console.warn('Failed to load provider status', error);
  }
  try {
    await loadOfficialSeason({ replaceExisting: replaceWithOfficial, resetWeights: !restored });
  } catch (error) {
    console.warn('Failed to load official 2026 season', error);
  }
  renderWeightControls();
  syncAutoRefreshTimer();
  renderAll();
  runTournamentSimulation(simulationState.iterations, buildTournamentBracketState()).catch((error) => {
    console.warn('Failed to run initial Monte Carlo simulation', error);
    simulationState = {
      ...simulationState,
      status: 'idle',
    };
    renderSimulationStatus(currentSimulationSignature());
  });
}

boot();
