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
const EVOLUTION_URL = '/api/evolution';
const PROVIDER_STATUS_URL = '/api/provider-status';
const TOURNAMENT_SYNC_URL = '/api/tournament/sync';
const LIVE_CONTEXT_URL = '/api/live/context';
const AI_PREFILL_URL = '/api/ai/prefill';
const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;
let persistTimeout;
let liveRefreshTimer;

let baselineTeams = buildDefaultTeams();
let teams = baselineTeams.map((team) => ({ ...team }));
let weights = { ...defaultWeights };
let seasonMeta = null;
let glossary = [];
let backtestResults = null;
let evolutionResults = null;
let portfolio = createDefaultPortfolio();
let tournamentState = createEmptyTournamentState();
let liveContext = createEmptyLiveContext();
let aiPrefill = createEmptyAiPrefill();
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
const evolutionBoard = document.getElementById('evolutionBoard');
const simulateButton = document.getElementById('simulateButton');
const loadOfficialFieldButton = document.getElementById('loadOfficialFieldButton');
const runBacktestButton = document.getElementById('runBacktestButton');
const runEvolutionButton = document.getElementById('runEvolutionButton');
const syncLiveButton = document.getElementById('syncLiveButton');
const applyLiveOddsButton = document.getElementById('applyLiveOddsButton');
const applyNewsSignalsButton = document.getElementById('applyNewsSignalsButton');
const generateAiPrefillButton = document.getElementById('generateAiPrefillButton');
const applyAiPrefillButton = document.getElementById('applyAiPrefillButton');
const applyEvolutionButton = document.getElementById('applyEvolutionButton');
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
const autoRefreshMinutesInput = document.getElementById('autoRefreshMinutesInput');
const liveOddsModeSelect = document.getElementById('liveOddsModeSelect');
const autoSyncInput = document.getElementById('autoSyncInput');
const autoApplyNewsInput = document.getElementById('autoApplyNewsInput');

function createDefaultPortfolio() {
  return {
    startingBankroll: 1000,
    kellyMultiplier: 0.35,
    maxStakePct: 5,
    maxOpenRiskPct: 15,
    minEdgePct: 2,
    autoRefreshMinutes: 5,
    liveOddsMode: 'best',
    autoSync: false,
    autoApplyNews: false,
    bets: [],
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
    provider: null,
    generatedAt: null,
    model: null,
    researchedTeams: 0,
    fallbackTeams: 0,
    assessments: [],
  };
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
  }
  if (payload.aiModel) {
    aiPrefill.model = payload.aiModel;
  }
}


function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    teams,
    weights,
    portfolio,
    tournament: tournamentState,
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
    fairMl: Number.isFinite(Number(entry.fairMl)) ? Number(entry.fairMl) : null,
    modelProbability: Number.isFinite(modelProbability) ? clamp(modelProbability, 0.001, 0.999) : 0.5,
    confidence: Number.isFinite(Number(entry.confidence)) ? clamp(Number(entry.confidence), 0, 1) : 0.5,
    edge: Number.isFinite(Number(entry.edge)) ? Number(entry.edge) : 0,
    stake: Number(stake.toFixed(2)),
    expectedValue: Number.isFinite(expectedValue) ? Number(expectedValue.toFixed(2)) : 0,
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

function normalizePortfolio(input) {
  const defaults = createDefaultPortfolio();
  if (!input || typeof input !== 'object') return defaults;

  const startingBankroll = Number(input.startingBankroll);
  const kellyMultiplier = Number(input.kellyMultiplier);
  const maxStakePct = Number(input.maxStakePct);
  const maxOpenRiskPct = Number(input.maxOpenRiskPct);
  const minEdgePct = Number(input.minEdgePct);
  const autoRefreshMinutes = Number(input.autoRefreshMinutes);

  return {
    startingBankroll: clamp(Number.isFinite(startingBankroll) ? startingBankroll : defaults.startingBankroll, 100, 1_000_000),
    kellyMultiplier: clamp(Number.isFinite(kellyMultiplier) ? kellyMultiplier : defaults.kellyMultiplier, 0, 1),
    maxStakePct: clamp(Number.isFinite(maxStakePct) ? maxStakePct : defaults.maxStakePct, 1, 25),
    maxOpenRiskPct: clamp(Number.isFinite(maxOpenRiskPct) ? maxOpenRiskPct : defaults.maxOpenRiskPct, 1, 50),
    minEdgePct: clamp(Number.isFinite(minEdgePct) ? minEdgePct : defaults.minEdgePct, 0, 15),
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
    tournamentState = createEmptyTournamentState();
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
      <p class="section-copy">Pulling prior NCAA bracket pages and scoring the current model baseline.</p>
    </article>
  `;

  const response = await fetch(BACKTEST_URL);
  if (!response.ok) {
    throw new Error(`Backtest request failed with ${response.status}`);
  }

  backtestResults = await response.json();
}

async function loadEvolution() {
  evolutionBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small class="eyebrow">Working</small>
      <h3>Evolving robust weights</h3>
      <p class="section-copy">Searching bounded weight mutations, scoring them across archived tournaments, and then checking leave-one-year-out holdouts before making a recommendation.</p>
    </article>
  `;

  const response = await fetch(EVOLUTION_URL);
  if (!response.ok) {
    throw new Error(`Evolution request failed with ${response.status}`);
  }

  evolutionResults = await response.json();
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
      return true;
    }
  } catch (error) {
    console.warn('Failed to load saved sqlite state', error);
  }

  return false;
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
      aiPrefill = createEmptyAiPrefill();
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

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findTeamByName(name) {
  const normalized = normalizeTeamName(name);
  return teams.find((team) => normalizeTeamName(team.name) === normalized) || null;
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
  return teams.filter((team) => team.region === region).sort((a, b) => a.seed - b.seed || a.name.localeCompare(b.name));
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

function simulateTournament(iterations = 25000, bracketState = buildTournamentBracketState()) {
  const championCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const finalFourCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const sweet16Counts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const finalsCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const upsetSeeds = [];
  let sampleBracket = null;

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

        if (winner.seed > loser.seed && winner.seed >= 9) upsetSeeds.push(winner.seed);
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

        if (roundIndex === 1) sweet16Counts[winner.id] += 1;
        if (roundIndex === 3) finalFourCounts[winner.id] += 1;
        if (roundIndex === 4) finalsCounts[winner.id] += 1;
        if (roundIndex === 5) championCounts[winner.id] += 1;
      });
    }

    sampleBracket = bracketSample;
  }

  const championOdds = teams.map((team) => ({
    id: team.id,
    name: team.name,
    titleOdds: Number(((championCounts[team.id] / iterations) * 100).toFixed(1)),
    finalsOdds: Number(((finalsCounts[team.id] / iterations) * 100).toFixed(1)),
    finalFourOdds: Number(((finalFourCounts[team.id] / iterations) * 100).toFixed(1)),
    sweet16Odds: Number(((sweet16Counts[team.id] / iterations) * 100).toFixed(1)),
  })).sort((a, b) => b.titleOdds - a.titleOdds);

  return {
    championOdds,
    sampleBracket,
    averageUpsetSeed: average(upsetSeeds),
  };
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
    const profit = projectedProfit(bet.stake, bet.marketMl);
    const expectedValue = Number.isFinite(bet.expectedValue)
      ? bet.expectedValue
      : (bet.modelProbability * profit) - ((1 - bet.modelProbability) * bet.stake);

    cashBalance -= bet.stake;

    if (bet.status === 'win') {
      cashBalance += bet.stake + profit;
      settledPnl += profit;
      wins += 1;
      return;
    }

    if (bet.status === 'push' || bet.status === 'cancelled') {
      cashBalance += bet.stake;
      return;
    }

    if (bet.status === 'loss') {
      settledPnl -= bet.stake;
      losses += 1;
      return;
    }

    openRisk += bet.stake;
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

function buildStakePlan(matchups) {
  const bankroll = computeBankrollMetrics();
  let remainingCash = Math.max(bankroll.cashBalance, 0);
  let remainingRisk = remainingRiskBudget(bankroll);
  const minimumEdge = portfolio.minEdgePct / 100;

  return buildBetRows(matchups)
    .reduce((accepted, row) => {
      const rawKelly = kellyFraction(row.probability, row.market);
      if (row.edge <= minimumEdge || rawKelly <= 0 || remainingCash <= 0 || remainingRisk <= 0) {
        return accepted;
      }

      const appliedFraction = Math.min(
        rawKelly * portfolio.kellyMultiplier,
        portfolio.maxStakePct / 100
      );
      let stake = roundCurrency(remainingCash * appliedFraction);
      stake = roundCurrency(Math.min(stake, remainingCash, remainingRisk));
      if (!Number.isFinite(stake) || stake <= 0) {
        return accepted;
      }

      const toWin = roundCurrency(projectedProfit(stake, row.market));
      const expectedValue = roundCurrency(
        (row.probability * toWin) - ((1 - row.probability) * stake)
      );
      const equalHedgeStake = equalProfitHedgeStake(stake, row.market, row.opponentMarket);
      const breakEvenHedge = breakEvenHedgeStake(stake, row.opponentMarket);
      const equalHedgeOutcome = hedgeOutcomes(stake, row.market, equalHedgeStake, row.opponentMarket);
      const breakEvenOutcome = hedgeOutcomes(stake, row.market, breakEvenHedge, row.opponentMarket);

      remainingCash = roundCurrency(Math.max(0, remainingCash - stake));
      remainingRisk = roundCurrency(Math.max(0, remainingRisk - stake));

      accepted.push({
        ...row,
        rawKelly,
        appliedFraction,
        stake,
        toWin,
        expectedValue,
        equalHedgeStake,
        equalHedgeOutcome,
        breakEvenHedge,
        breakEvenOutcome,
        maxLoss: stake,
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

function createTrackedBet(recommendation) {
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
    fairMl: recommendation.fair,
    modelProbability: recommendation.probability,
    confidence: recommendation.confidence,
    edge: recommendation.edge,
    stake: recommendation.stake,
    expectedValue: recommendation.expectedValue,
    status: 'open',
  });
}

function addTrackedBet(recommendation) {
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
    const placed = {
      timestamp: bet.createdAt,
      label: `Bet ${bet.teamName}`,
      delta: -bet.stake,
    };
    if (bet.status === 'open') return [placed];

    const settlementDelta = bet.status === 'win'
      ? bet.stake + projectedProfit(bet.stake, bet.marketMl)
      : (bet.status === 'push' || bet.status === 'cancelled')
        ? bet.stake
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
  autoRefreshMinutesInput.value = String(portfolio.autoRefreshMinutes);
  liveOddsModeSelect.value = portfolio.liveOddsMode;
  autoSyncInput.checked = portfolio.autoSync;
  autoApplyNewsInput.checked = portfolio.autoApplyNews;
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
      <small>${top ? `${formatCurrency(top.stake)} risked · max loss ${formatCurrency(top.maxLoss)}` : 'Sync results or add live lines to surface the next round.'}</small>
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

  betSizingBoard.innerHTML = recommendations.map((row, index) => `
    <article class="season-card">
      <small>${row.roundLabel} · ${row.region}</small>
      <strong>${row.team.name} over ${row.opponent.name}</strong>
      <p>Model ${(row.probability * 100).toFixed(1)}% · market ${formatMoneyline(row.market)} · fair ${formatMoneyline(row.fair)} · edge ${(row.edge * 100).toFixed(1)} pts.</p>
      <div class="season-meta-row">
        <span class="tag">Stake ${formatCurrency(row.stake)}</span>
        <span class="tag">To win ${formatCurrency(row.toWin)}</span>
        <span class="tag">Kelly ${(row.rawKelly * 100).toFixed(1)}%</span>
        ${row.startTime ? `<span class="tag">${row.startTime}</span>` : ''}
      </div>
      <ul class="season-list">
        <li>Max loss without a hedge: ${formatCurrency(row.maxLoss)}.</li>
        <li>${row.equalHedgeStake && row.equalHedgeOutcome ? `Equal-result hedge on ${row.opponent.name}: bet ${formatCurrency(row.equalHedgeStake)} at ${formatMoneyline(row.opponentMarket)} to lock about ${formatSignedCurrency(row.equalHedgeOutcome.ifPickWins)} either way.` : 'Equal-result hedge appears once both sides have usable moneylines.'}</li>
        <li>${row.breakEvenHedge && row.breakEvenOutcome ? `Break-even hedge on ${row.opponent.name}: bet ${formatCurrency(row.breakEvenHedge)} to get about ${formatSignedCurrency(row.breakEvenOutcome.ifHedgeWins)} if ${row.opponent.name} wins, while still keeping about ${formatSignedCurrency(row.breakEvenOutcome.ifPickWins)} if ${row.team.name} wins.` : 'Break-even hedge appears once both sides have usable moneylines.'}</li>
        <li>Projected score: ${row.team.name} ${Math.round(row.projection.teamAPoints)}-${Math.round(row.projection.teamBPoints)} ${row.opponent.name}.</li>
      </ul>
      <button class="button button--ghost button--small" data-track-recommendation="${index}">Track paper bet</button>
    </article>
  `).join('');

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
  const provider = aiPrefill.provider;
  const generatedCopy = aiPrefill.generatedAt
    ? `Generated ${new Date(aiPrefill.generatedAt).toLocaleString()}.`
    : 'No AI prefill has run yet.';

  aiPrefillStatus.innerHTML = `
    <article class="season-card">
      <small>AI provider</small>
      <strong>${provider?.configured ? 'Configured' : 'Waiting for key'}</strong>
      <p>${provider?.message || 'Set OPENAI_API_KEY to enable AI model prefilling.'}</p>
      <div class="season-meta-row">
        <span class="tag">${generatedCopy}</span>
        <span class="tag">${aiPrefill.researchedTeams || 0} researched</span>
        <span class="tag">${aiPrefill.fallbackTeams || 0} fallback</span>
        <a class="tag season-link" href="${provider?.sourceUrl || 'https://developers.openai.com/api/reference/responses'}" target="_blank" rel="noreferrer">OpenAI docs</a>
      </div>
    </article>
    <article class="season-card season-card--wide">
      <small>Model</small>
      <strong>${aiPrefill.model || 'Not used yet'}</strong>
      <p>The AI layer researches priority teams with web search, attaches source-backed notes when it can, and fills the rest conservatively. You can inspect everything here before applying it into the editable team table.</p>
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
        <td colspan="8">No paper bets tracked yet. Use "Track paper bet" on one of the stake-plan cards.</td>
      </tr>
    `;
    return;
  }

  betLedgerBody.innerHTML = portfolio.bets.map((bet) => `
    <tr>
      <td>${new Date(bet.createdAt).toLocaleString()}</td>
      <td>${bet.teamName} vs ${bet.opponentName}<br /><small>${bet.roundLabel} · ${bet.region}</small></td>
      <td>${formatMoneyline(bet.marketMl)}</td>
      <td>${formatCurrency(bet.stake)}</td>
      <td>${formatCurrency(projectedProfit(bet.stake, bet.marketMl))}</td>
      <td>${formatCurrency(bet.expectedValue)}</td>
      <td>${bet.status}</td>
      <td>
        <div class="ledger-actions">
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="win">Win</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="loss">Loss</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="push">Push</button>
          <button class="button button--ghost button--small" data-bet-id="${bet.id}" data-bet-action="delete">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

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
  const response = await fetch(AI_PREFILL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(aiPrefillPayload()),
  });

  if (!response.ok) {
    throw new Error(`AI prefill request failed with ${response.status}`);
  }

  aiPrefill = await response.json();
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
      <strong>${leader.name}</strong>
      <small>${leader.titleOdds}% title · ${leader.finalsOdds}% finals</small>
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
      <strong>${averageUpsetSeed.toFixed(1)}</strong>
      <small>Average seed of simulated upset winners · ${avgConfidence.toFixed(0)} average confidence</small>
    </div>
  `;
}

function renderSeasonStatus() {
  if (!seasonMeta) {
    seasonStatus.innerHTML = `
      <article class="season-card">
        <small>Field source</small>
        <strong>Demo fallback</strong>
        <p>The app is using local placeholder teams right now. Load the official 2026 NCAA field to replace them.</p>
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
  const best = recommendations[0] || buildBetRows(matchups)[0];
  if (!best) {
    recommendationBoard.innerHTML = `
      <article class="season-card season-card--wide">
        <small>Recommendation</small>
        <strong>No edge yet</strong>
        <p>Sync finished results and current moneylines to see the next live-round recommendation.</p>
      </article>
    `;
    return;
  }

  const bestTeamSignal = liveContext.teamSignals?.find((signal) => signal.teamName === best.team.name) || null;
  const opponentSignal = liveContext.teamSignals?.find((signal) => signal.teamName === best.opponent.name) || null;

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
        ${best.startTime ? `<span class="tag">${best.startTime}</span>` : ''}
      </div>
    </article>
    <article class="season-card">
      <small>How to bet it</small>
      <strong>${best.team.name}</strong>
      <ul class="season-list">
        <li>Offense ${best.team.adjO.toFixed(1)} vs opponent defense ${best.opponent.adjD.toFixed(1)}.</li>
        <li>Effective FG ${best.team.efg.toFixed(1)}% and estimated pace ${best.projection.pace.toFixed(1)} possessions.</li>
        <li>${best.stake ? `Paper stake ${formatCurrency(best.stake)} to win ${formatCurrency(best.toWin)} using ${(portfolio.kellyMultiplier * 100).toFixed(0)}% Kelly, a ${portfolio.maxStakePct}% per-bet cap, a ${portfolio.maxOpenRiskPct}% open-risk cap, and a ${portfolio.minEdgePct.toFixed(1)}-point minimum edge filter.` : 'No bankroll stake yet because the edge does not survive the current loss-control settings.'}</li>
        <li>${best.stake ? `Max loss unhedged: ${formatCurrency(best.maxLoss)}.` : 'No hedge math yet because there is no approved stake.'}</li>
        <li>${best.equalHedgeStake && best.equalHedgeOutcome ? `Equal-result hedge: ${formatCurrency(best.equalHedgeStake)} on ${best.opponent.name} at ${formatMoneyline(best.opponentMarket)} would lock about ${formatSignedCurrency(best.equalHedgeOutcome.ifPickWins)} either way.` : 'Equal-result hedge appears once both sides have live moneylines.'}</li>
        <li>${best.breakEvenHedge && best.breakEvenOutcome ? `Break-even hedge: ${formatCurrency(best.breakEvenHedge)} on ${best.opponent.name} gets you about ${formatSignedCurrency(best.breakEvenOutcome.ifHedgeWins)} if the pick loses, while still leaving about ${formatSignedCurrency(best.breakEvenOutcome.ifPickWins)} if the pick wins.` : 'Break-even hedge appears once both sides have live moneylines.'}</li>
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
  const header = `
    <article class="season-card season-card--wide">
      <small>Aggregate baseline</small>
      <strong>${(aggregate.overallAccuracy * 100).toFixed(1)}% game-pick accuracy</strong>
      <p>${backtestResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${aggregate.correctPicks}/${aggregate.totalGames} picks correct</span>
        <span class="tag">${aggregate.championHits}/${aggregate.yearsCovered} champion hits</span>
        <span class="tag">Avg Brier ${aggregate.averageBrier.toFixed(3)}</span>
      </div>
    </article>
  `;

  const yearCards = backtestResults.years.map((year) => `
    <article class="season-card">
      <small>${year.year}</small>
      <strong>${(year.overallAccuracy * 100).toFixed(1)}% accuracy</strong>
      <p>Champion pick: ${year.championPick}. Actual champion: ${year.actualChampion}. ${year.championHit ? 'Hit.' : 'Miss.'}</p>
      <ul class="season-list">
        ${year.rounds.map((round) => `<li>${round.label}: ${round.correct}/${round.total} (${(round.accuracy * 100).toFixed(1)}%)</li>`).join('')}
      </ul>
    </article>
  `).join('');

  backtestBoard.innerHTML = header + yearCards;
}

function renderEvolution() {
  if (!evolutionResults) {
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

  evolutionBoard.innerHTML = `
    <article class="season-card season-card--wide">
      <small>Recommended profile</small>
      <strong>${(evolutionResults.holdoutAverageAccuracy * 100).toFixed(1)}% avg holdout accuracy · Brier ${evolutionResults.holdoutAverageBrier.toFixed(3)}</strong>
      <p>${evolutionResults.methodology}</p>
      <div class="season-meta-row">
        <span class="tag">${evolutionResults.populationSize} population</span>
        <span class="tag">${evolutionResults.generations} generations</span>
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
    ${leaderCards}
    ${foldCards}
  `;
}

function renderChampionBoard(championOdds) {
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

function renderBracket(sampleBracket) {
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
                <div class="market-meta">${Number.isFinite(game.scoreA) && Number.isFinite(game.scoreB) ? `Final ${game.scoreA}-${game.scoreB}` : `Proj ${Math.round(projectScore(game.teamA, game.teamB).teamAPoints)}-${Math.round(projectScore(game.teamA, game.teamB).teamBPoints)}`}</div>
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
            <div class="market-meta">${Number.isFinite(game.scoreA) && Number.isFinite(game.scoreB) ? `Final ${game.scoreA}-${game.scoreB}` : `Proj ${Math.round(projectScore(game.teamA, game.teamB).teamAPoints)}-${Math.round(projectScore(game.teamA, game.teamB).teamBPoints)}`}</div>
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
  schedulePersistState();
  applyWorkspaceVisibility();
  const bracketState = buildTournamentBracketState();
  const currentRound = currentTournamentRound(bracketState);
  const matchups = currentRound.matchups;
  const simulation = simulateTournament(25000, bracketState);
  const recommendations = buildStakePlan(matchups);
  renderPortfolioControls();
  renderSeasonStatus();
  renderGlossary();
  renderBacktest();
  renderEvolution();
  renderLiveStatus();
  renderSignalBoard();
  renderNewsBoard();
  renderAiPrefill();
  renderTeamTable();
  renderTournamentStatus(currentRound);
  renderSummaryCards(simulation.championOdds, matchups, simulation.averageUpsetSeed, currentRound);
  renderPortfolioSummary(recommendations, currentRound);
  renderBetSizingBoard(recommendations);
  renderEquityCurve();
  renderBetLedger();
  renderChampionBoard(simulation.championOdds);
  renderEdgeBoard(matchups);
  renderRecommendationBoard(matchups, recommendations);
  renderMarketBoard(matchups);
  renderBracket(simulation.sampleBracket);
  applyWorkspaceVisibility();
}

simulateButton.addEventListener('click', renderAll);
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
    renderAll();
  } catch (error) {
    console.warn('Failed to generate AI prefill', error);
  } finally {
    generateAiPrefillButton.disabled = false;
  }
});
applyAiPrefillButton.addEventListener('click', () => {
  setActiveWorkspace('research');
  applyAiPrefill(aiPrefill.assessments);
  renderAll();
});
applyEvolutionButton.addEventListener('click', () => {
  setActiveWorkspace('overview');
  applyEvolutionWeights();
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
clearStorageButton.addEventListener('click', () => {
  const clearPromise = tauriInvoke ? tauriInvoke('clear_state') : fetch(API_STATE_URL, { method: 'DELETE' });
  Promise.resolve(clearPromise).catch((error) => {
    console.warn('Failed to clear sqlite state', error);
  });
});
resetButton.addEventListener('click', () => {
  setActiveWorkspace('overview');
  teams = cloneTeams(baselineTeams);
  weights = { ...defaultWeights };
  aiPrefill = createEmptyAiPrefill();
  tournamentState = createEmptyTournamentState();
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
}

boot();
