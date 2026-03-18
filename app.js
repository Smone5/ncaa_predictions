const defaultWeights = {
  efficiency: 35,
  seed: 15,
  fourFactors: 25,
  momentum: 15,
  injuries: 10,
};

const defaultTeams = [
  { name: 'Duke', seed: 1, adjO: 126.4, adjD: 89.8, efg: 57.8, tov: 15.4, orb: 33.1, ftr: 36.2, form: 9.4, injuries: 0.3 },
  { name: 'Houston', seed: 1, adjO: 123.1, adjD: 87.9, efg: 55.2, tov: 13.3, orb: 37.2, ftr: 33.4, form: 9.0, injuries: 0.2 },
  { name: 'UConn', seed: 1, adjO: 124.7, adjD: 91.2, efg: 56.9, tov: 14.1, orb: 35.7, ftr: 34.5, form: 8.8, injuries: 0.5 },
  { name: 'Auburn', seed: 1, adjO: 122.3, adjD: 92.5, efg: 54.9, tov: 16.1, orb: 34.6, ftr: 37.6, form: 8.4, injuries: 0.7 },
  { name: 'Tennessee', seed: 2, adjO: 119.4, adjD: 90.4, efg: 53.1, tov: 14.9, orb: 31.5, ftr: 35.1, form: 8.2, injuries: 0.8 },
  { name: 'Alabama', seed: 2, adjO: 124.1, adjD: 97.6, efg: 57.2, tov: 16.9, orb: 32.2, ftr: 39.3, form: 8.0, injuries: 1.0 },
  { name: 'Iowa State', seed: 2, adjO: 118.8, adjD: 91.1, efg: 53.9, tov: 15.1, orb: 30.8, ftr: 32.4, form: 7.8, injuries: 0.9 },
  { name: 'Arizona', seed: 2, adjO: 120.8, adjD: 94.2, efg: 55.5, tov: 16.3, orb: 33.0, ftr: 36.1, form: 7.9, injuries: 1.1 },
  { name: 'Creighton', seed: 3, adjO: 121.7, adjD: 95.1, efg: 56.4, tov: 14.8, orb: 28.4, ftr: 31.2, form: 7.6, injuries: 0.6 },
  { name: 'Baylor', seed: 3, adjO: 119.3, adjD: 96.0, efg: 55.9, tov: 15.7, orb: 29.1, ftr: 35.8, form: 7.2, injuries: 1.3 },
  { name: 'Illinois', seed: 3, adjO: 118.6, adjD: 98.8, efg: 54.4, tov: 15.2, orb: 34.8, ftr: 34.7, form: 7.3, injuries: 0.9 },
  { name: 'Gonzaga', seed: 4, adjO: 121.0, adjD: 97.4, efg: 56.6, tov: 15.6, orb: 31.4, ftr: 33.9, form: 7.7, injuries: 0.6 },
  { name: 'Saint Mary\'s', seed: 4, adjO: 114.6, adjD: 92.8, efg: 53.8, tov: 14.0, orb: 33.9, ftr: 30.4, form: 7.4, injuries: 0.4 },
  { name: 'Kentucky', seed: 4, adjO: 120.3, adjD: 99.1, efg: 55.7, tov: 17.1, orb: 31.2, ftr: 37.8, form: 7.0, injuries: 1.4 },
  { name: 'Wisconsin', seed: 5, adjO: 117.2, adjD: 96.5, efg: 54.8, tov: 13.9, orb: 27.3, ftr: 29.4, form: 7.1, injuries: 0.5 },
  { name: 'Florida', seed: 5, adjO: 118.4, adjD: 95.8, efg: 55.0, tov: 15.0, orb: 34.1, ftr: 35.4, form: 7.5, injuries: 0.8 },
];

let teams = structuredClone(defaultTeams);
let weights = { ...defaultWeights };

const weightControls = document.getElementById('weightControls');
const teamTableBody = document.getElementById('teamTableBody');
const championBoard = document.getElementById('championBoard');
const upsetBoard = document.getElementById('upsetBoard');
const bracketView = document.getElementById('bracketView');
const simulateButton = document.getElementById('simulateButton');
const resetButton = document.getElementById('resetButton');

const weightMeta = {
  efficiency: { label: 'Efficiency margin', min: 0, max: 50 },
  seed: { label: 'Seed prior', min: 0, max: 40 },
  fourFactors: { label: 'Four Factors', min: 0, max: 40 },
  momentum: { label: 'Recent form', min: 0, max: 30 },
  injuries: { label: 'Injury penalty', min: 0, max: 25 },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function fourFactorScore(team) {
  const shooting = team.efg * 0.4;
  const ballSecurity = (25 - team.tov) * 0.25;
  const rebounding = team.orb * 0.2;
  const rimPressure = team.ftr * 0.15;
  return shooting + ballSecurity + rebounding + rimPressure;
}

function teamScore(team) {
  const efficiencyMargin = team.adjO - team.adjD;
  const seedBoost = 18 - team.seed;
  const score =
    efficiencyMargin * (weights.efficiency / 35) +
    seedBoost * (weights.seed / 12) +
    fourFactorScore(team) * (weights.fourFactors / 30) +
    team.form * (weights.momentum / 12) -
    team.injuries * (weights.injuries / 6);
  return Number(score.toFixed(2));
}

function winProbability(teamA, teamB) {
  const scoreGap = teamScore(teamA) - teamScore(teamB);
  const seedGap = (teamB.seed - teamA.seed) * 0.08;
  return clamp(sigmoid(scoreGap / 8 + seedGap), 0.03, 0.97);
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

function renderTeamTable() {
  teamTableBody.innerHTML = teams
    .map((team, index) => `
      <tr>
        <td><input class="team-input" data-field="name" data-index="${index}" value="${team.name}" /></td>
        <td><input type="number" step="1" data-field="seed" data-index="${index}" value="${team.seed}" /></td>
        <td><input type="number" step="0.1" data-field="adjO" data-index="${index}" value="${team.adjO}" /></td>
        <td><input type="number" step="0.1" data-field="adjD" data-index="${index}" value="${team.adjD}" /></td>
        <td><input type="number" step="0.1" data-field="efg" data-index="${index}" value="${team.efg}" /></td>
        <td><input type="number" step="0.1" data-field="tov" data-index="${index}" value="${team.tov}" /></td>
        <td><input type="number" step="0.1" data-field="orb" data-index="${index}" value="${team.orb}" /></td>
        <td><input type="number" step="0.1" data-field="ftr" data-index="${index}" value="${team.ftr}" /></td>
        <td><input type="number" step="0.1" min="0" max="10" data-field="form" data-index="${index}" value="${team.form}" /></td>
        <td><input type="number" step="0.1" min="0" max="10" data-field="injuries" data-index="${index}" value="${team.injuries}" /></td>
        <td><span class="score-pill">${teamScore(team)}</span></td>
      </tr>
    `)
    .join('');

  teamTableBody.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', (event) => {
      const index = Number(event.target.dataset.index);
      const field = event.target.dataset.field;
      const rawValue = event.target.value;
      teams[index][field] = field === 'name' ? rawValue : Number(rawValue);
      renderAll();
    });
  });
}

function simulateTournament(iterations = 10000) {
  const orderedTeams = [...teams].sort((a, b) => a.seed - b.seed || teamScore(b) - teamScore(a));
  const championCounts = Object.fromEntries(orderedTeams.map((team) => [team.name, 0]));
  const semifinalCounts = Object.fromEntries(orderedTeams.map((team) => [team.name, 0]));
  const upsetSignals = [];
  let lastBracket = [];

  for (let iter = 0; iter < iterations; iter += 1) {
    let roundTeams = orderedTeams.map((team) => ({ ...team }));
    const bracketRounds = [];

    while (roundTeams.length > 1) {
      const nextRound = [];
      const matchups = [];

      for (let i = 0; i < roundTeams.length; i += 2) {
        const teamA = roundTeams[i];
        const teamB = roundTeams[i + 1];
        const probabilityA = winProbability(teamA, teamB);
        const winner = Math.random() < probabilityA ? teamA : teamB;
        const favorite = probabilityA >= 0.5 ? teamA : teamB;
        const underdog = favorite === teamA ? teamB : teamA;
        const favoriteWinProbability = favorite === teamA ? probabilityA : 1 - probabilityA;

        if (favorite.seed < underdog.seed && favoriteWinProbability < 0.7) {
          upsetSignals.push({
            favorite: favorite.name,
            underdog: underdog.name,
            danger: Number(((1 - favoriteWinProbability) * 100).toFixed(1)),
          });
        }

        matchups.push({ teamA, teamB, probabilityA, winner });
        nextRound.push(winner);
      }

      if (nextRound.length === 4) {
        nextRound.forEach((team) => {
          semifinalCounts[team.name] += 1;
        });
      }

      bracketRounds.push(matchups);
      roundTeams = nextRound;
    }

    championCounts[roundTeams[0].name] += 1;
    lastBracket = bracketRounds;
  }

  const championOdds = Object.entries(championCounts)
    .map(([name, count]) => ({ name, odds: Number(((count / iterations) * 100).toFixed(1)) }))
    .sort((a, b) => b.odds - a.odds);

  const upsetBoardData = Object.values(
    upsetSignals.reduce((acc, signal) => {
      const key = `${signal.favorite}-${signal.underdog}`;
      if (!acc[key]) {
        acc[key] = { ...signal, samples: 0, totalDanger: 0 };
      }
      acc[key].samples += 1;
      acc[key].totalDanger += signal.danger;
      acc[key].danger = Number((acc[key].totalDanger / acc[key].samples).toFixed(1));
      return acc;
    }, {})
  )
    .sort((a, b) => b.danger - a.danger)
    .slice(0, 5);

  return { championOdds, upsetBoardData, lastBracket, semifinalCounts };
}

function renderChampionBoard(championOdds, semifinalCounts, iterations) {
  championBoard.innerHTML = championOdds
    .slice(0, 6)
    .map(({ name, odds }) => `
      <div class="board-card">
        <div>
          <strong>${name}</strong>
          <small>Final Four rate: ${((semifinalCounts[name] / iterations) * 100).toFixed(1)}%</small>
        </div>
        <span class="score-pill">${odds}%</span>
      </div>
    `)
    .join('');
}

function renderUpsetBoard(data) {
  upsetBoard.innerHTML = data
    .map((item) => `
      <div class="board-card">
        <div>
          <strong>${item.favorite} vs ${item.underdog}</strong>
          <small>Favorite vulnerable in this matchup family</small>
        </div>
        <span class="risk-pill">${item.danger}% upset risk</span>
      </div>
    `)
    .join('');
}

function renderBracket(lastBracket) {
  const labels = ['Round of 16', 'Elite Eight', 'Final Four', 'Title'];
  bracketView.innerHTML = lastBracket
    .map((round, roundIndex) => `
      <div class="round-column">
        <h3>${labels[roundIndex]}</h3>
        ${round
          .map((match, matchIndex) => `
            <article class="match-card">
              <h3>Match ${matchIndex + 1}</h3>
              <div class="match-line">
                <span>${match.teamA.name}</span>
                <strong>${(match.probabilityA * 100).toFixed(1)}%</strong>
              </div>
              <div class="match-line">
                <span>${match.teamB.name}</span>
                <strong>${((1 - match.probabilityA) * 100).toFixed(1)}%</strong>
              </div>
              <div class="winner-line">Winner: ${match.winner.name}</div>
            </article>
          `)
          .join('')}
      </div>
    `)
    .join('');
}

function renderAll() {
  renderTeamTable();
  const iterations = 10000;
  const { championOdds, upsetBoardData, lastBracket, semifinalCounts } = simulateTournament(iterations);
  renderChampionBoard(championOdds, semifinalCounts, iterations);
  renderUpsetBoard(upsetBoardData);
  renderBracket(lastBracket);
}

simulateButton.addEventListener('click', renderAll);
resetButton.addEventListener('click', () => {
  teams = structuredClone(defaultTeams);
  weights = { ...defaultWeights };
  renderWeightControls();
  renderAll();
});

renderWeightControls();
renderAll();
