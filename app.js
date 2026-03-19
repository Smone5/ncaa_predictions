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

const STORAGE_KEY = 'madness-oracle-pro-state-v1';

let teams = buildDefaultTeams();
let weights = { ...defaultWeights };

const weightControls = document.getElementById('weightControls');
const summaryCards = document.getElementById('summaryCards');
const championBoard = document.getElementById('championBoard');
const edgeBoard = document.getElementById('edgeBoard');
const marketBoard = document.getElementById('marketBoard');
const teamTableBody = document.getElementById('teamTableBody');
const bracketView = document.getElementById('bracketView');
const simulateButton = document.getElementById('simulateButton');
const resetButton = document.getElementById('resetButton');
const saveLocalButton = document.getElementById('saveLocalButton');
const exportButton = document.getElementById('exportButton');
const importButton = document.getElementById('importButton');
const clearStorageButton = document.getElementById('clearStorageButton');
const importFileInput = document.getElementById('importFileInput');


function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    teams,
    weights,
  };
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
}

function loadPersistedState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.teams) && parsed.weights) {
      teams = parsed.teams;
      weights = { ...defaultWeights, ...parsed.weights };
    }
  } catch (error) {
    console.warn('Failed to load saved state', error);
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
      weights = { ...defaultWeights, ...parsed.weights };
      renderWeightControls();
      renderAll();
      persistState();
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

function americanToImpliedProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function probabilityToAmerican(probability) {
  const p = clamp(probability, 0.001, 0.999);
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

function removeVig(probA, probB) {
  if (probA === null || probB === null) return null;
  const total = probA + probB;
  if (!total) return null;
  return { probA: probA / total, probB: probB / total, hold: total - 1 };
}

function fourFactorScore(team) {
  return team.efg * 0.4 + (25 - team.tov) * 0.25 + team.orb * 0.2 + team.ftr * 0.15;
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

function firstRoundMatchups() {
  return regions.flatMap((region) =>
    firstRoundSeedPairs.map(([seedA, seedB]) => {
      const [teamA, teamB] = matchupBySeeds(region, seedA, seedB);
      const blended = blendedProbability(teamA, teamB, 0);
      const impliedA = americanToImpliedProbability(teamA.marketMl);
      const impliedB = americanToImpliedProbability(teamB.marketMl);
      const noVig = removeVig(impliedA, impliedB);
      const marketA = noVig ? noVig.probA : impliedA;
      const marketB = noVig ? noVig.probB : impliedB;
      const edgeA = marketA === null ? null : blended.probabilityA - marketA;
      const edgeB = marketB === null ? null : 1 - blended.probabilityA - marketB;
      const confidence = clamp(1 - blended.uncertaintyPull + Math.abs(blended.probabilityA - 0.5), 0, 1);
      return {
        region,
        roundIndex: 0,
        teamA,
        teamB,
        probabilityA: blended.probabilityA,
        components: blended,
        hold: noVig ? noVig.hold : null,
        marketA,
        marketB,
        edgeA,
        edgeB,
        confidence,
      };
    })
  );
}

function playRound(games, roundIndex, upsetSeeds) {
  const nextTeams = [];
  const played = games.map((game) => {
    const blended = blendedProbability(game.teamA, game.teamB, roundIndex);
    const probabilityA = blended.probabilityA;
    const winner = Math.random() < probabilityA ? game.teamA : game.teamB;
    const loser = winner === game.teamA ? game.teamB : game.teamA;
    if (winner.seed > loser.seed && winner.seed >= 9) upsetSeeds.push(winner.seed);
    nextTeams.push(winner);
    return { ...game, probabilityA, components: blended, winner };
  });
  return { played, nextTeams };
}

function simulateTournament(iterations = 25000) {
  const championCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const finalFourCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const sweet16Counts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  const finalsCounts = Object.fromEntries(teams.map((team) => [team.id, 0]));
  let sampleBracket = null;
  const upsetSeeds = [];

  for (let iter = 0; iter < iterations; iter += 1) {
    const regionWinners = [];
    const bracketSample = {};

    regions.forEach((region) => {
      let games = firstRoundSeedPairs.map(([seedA, seedB]) => {
        const [teamA, teamB] = matchupBySeeds(region, seedA, seedB).map((team) => ({ ...team }));
        return { teamA, teamB };
      });

      const rounds = [];
      let roundIndex = 0;

      while (games.length) {
        const { played, nextTeams } = playRound(games, roundIndex, upsetSeeds);
        rounds.push(played);

        if (nextTeams.length === 4) {
          nextTeams.forEach((team) => { sweet16Counts[team.id] += 1; });
        }

        if (nextTeams.length === 1) {
          finalFourCounts[nextTeams[0].id] += 1;
          regionWinners.push(nextTeams[0]);
          break;
        }

        games = [];
        for (let index = 0; index < nextTeams.length; index += 2) {
          games.push({ teamA: nextTeams[index], teamB: nextTeams[index + 1] });
        }
        roundIndex += 1;
      }

      bracketSample[region] = rounds;
    });

    const semiOneBlend = blendedProbability(regionWinners[0], regionWinners[1], 4);
    const semifinalA = {
      teamA: regionWinners[0],
      teamB: regionWinners[1],
      probabilityA: semiOneBlend.probabilityA,
      components: semiOneBlend,
    };
    semifinalA.winner = Math.random() < semifinalA.probabilityA ? semifinalA.teamA : semifinalA.teamB;

    const semiTwoBlend = blendedProbability(regionWinners[2], regionWinners[3], 4);
    const semifinalB = {
      teamA: regionWinners[2],
      teamB: regionWinners[3],
      probabilityA: semiTwoBlend.probabilityA,
      components: semiTwoBlend,
    };
    semifinalB.winner = Math.random() < semifinalB.probabilityA ? semifinalB.teamA : semifinalB.teamB;

    finalsCounts[semifinalA.winner.id] += 1;
    finalsCounts[semifinalB.winner.id] += 1;

    const titleBlend = blendedProbability(semifinalA.winner, semifinalB.winner, 5);
    const title = {
      teamA: semifinalA.winner,
      teamB: semifinalB.winner,
      probabilityA: titleBlend.probabilityA,
      components: titleBlend,
    };
    title.winner = Math.random() < title.probabilityA ? title.teamA : title.teamB;
    championCounts[title.winner.id] += 1;

    bracketSample.finalFour = [semifinalA, semifinalB, title];
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

function renderSummaryCards(championOdds, matchups, averageUpsetSeed) {
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
      <small>Absolute first-round disagreement after vig-aware normalization.</small>
    </div>
    <div class="summary-card">
      <small>Field volatility</small>
      <strong>${averageUpsetSeed.toFixed(1)}</strong>
      <small>Average seed of simulated upset winners · ${avgConfidence.toFixed(0)} average confidence</small>
    </div>
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
        edge: matchup.edgeA,
        fair: probabilityToAmerican(matchup.probabilityA),
        market: matchup.teamA.marketMl,
        confidence: matchup.confidence,
      } : null,
      matchup.edgeB !== null ? {
        team: matchup.teamB.name,
        opponent: matchup.teamA.name,
        region: matchup.region,
        edge: matchup.edgeB,
        fair: probabilityToAmerican(1 - matchup.probabilityA),
        market: matchup.teamB.marketMl,
        confidence: matchup.confidence,
      } : null,
    ])
    .filter(Boolean)
    .sort((a, b) => (b.edge * b.confidence) - (a.edge * a.confidence))
    .slice(0, 10);

  edgeBoard.innerHTML = edgeRows.map((row) => `
    <div class="list-card">
      <div>
        <strong>${row.team}</strong>
        <div class="board-subtext">${row.region} vs ${row.opponent} · Fair ${row.fair > 0 ? '+' : ''}${row.fair} · Market ${row.market > 0 ? '+' : ''}${row.market} · ${(row.confidence * 100).toFixed(0)} conf</div>
      </div>
      <span class="${edgeClass(row.edge, row.confidence)}">${(row.edge * 100).toFixed(1)} pts</span>
    </div>
  `).join('');
}

function renderMarketBoard(matchups) {
  marketBoard.innerHTML = matchups.map((matchup, index) => {
    const fairA = probabilityToAmerican(matchup.probabilityA);
    const fairB = probabilityToAmerican(1 - matchup.probabilityA);
    const marketA = matchup.marketA === null ? '—' : `${(matchup.marketA * 100).toFixed(1)}%`;
    const marketB = matchup.marketB === null ? '—' : `${(matchup.marketB * 100).toFixed(1)}%`;

    return `
      <article class="market-match">
        <h3>${matchup.region}: ${matchup.teamA.seed} vs ${matchup.teamB.seed}</h3>
        <div class="market-meta">Academic blend = efficiency model + soft-factor overlay + seed prior + no-vig market prior, then uncertainty shrinkage.</div>
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
    const labels = ['Round of 64', 'Round of 32', 'Sweet 16', 'Elite Eight'];
    return `
      <div class="bracket-column">
        <h3>${region}</h3>
        ${rounds.map((games, roundIndex) => `
          <div class="bracket-card">
            <h4>${labels[roundIndex]}</h4>
            ${games.map((game) => `
              <div>
                <div class="match-line"><span>${game.teamA.seed}. ${game.teamA.name}</span><strong>${(game.probabilityA * 100).toFixed(1)}%</strong></div>
                <div class="match-line"><span>${game.teamB.seed}. ${game.teamB.name}</span><strong>${((1 - game.probabilityA) * 100).toFixed(1)}%</strong></div>
                <div class="winner-line">Winner: ${game.winner.name}</div>
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
            <div class="winner-line">${index === 2 ? 'Champion' : 'Winner'}: ${game.winner.name}</div>
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
  persistState();
  renderTeamTable();
  const matchups = firstRoundMatchups();
  const simulation = simulateTournament(25000);
  renderSummaryCards(simulation.championOdds, matchups, simulation.averageUpsetSeed);
  renderChampionBoard(simulation.championOdds);
  renderEdgeBoard(matchups);
  renderMarketBoard(matchups);
  renderBracket(simulation.sampleBracket);
}

simulateButton.addEventListener('click', renderAll);
saveLocalButton.addEventListener('click', () => {
  persistState();
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
  localStorage.removeItem(STORAGE_KEY);
});
resetButton.addEventListener('click', () => {
  teams = buildDefaultTeams();
  weights = { ...defaultWeights };
  renderWeightControls();
  renderAll();
});

loadPersistedState();
renderWeightControls();
renderAll();
