from pathlib import Path

html = Path('index.html').read_text()
js = Path('app.js').read_text()

required_html_ids = [
    'simulateButton',
    'loadOfficialFieldButton',
    'runBacktestButton',
    'runEvolutionButton',
    'syncLiveButton',
    'applyLiveOddsButton',
    'applyNewsSignalsButton',
    'generateAiPrefillButton',
    'applyAiPrefillButton',
    'applyEvolutionButton',
    'workspaceNav',
    'workspaceTabs',
    'weightControls',
    'seasonStatus',
    'recommendationBoard',
    'tournamentStatusBoard',
    'portfolioSummary',
    'betSizingBoard',
    'maxOpenRiskPctInput',
    'minEdgePctInput',
    'liveStatusBoard',
    'signalBoard',
    'newsBoard',
    'aiPrefillStatus',
    'aiPrefillBoard',
    'equityCurve',
    'betLedgerBody',
    'marketBoard',
    'teamTableBody',
    'bracketView',
    'backtestBoard',
    'evolutionBoard',
    'glossaryBoard',
]

for element_id in required_html_ids:
    assert f'id="{element_id}"' in html, element_id

required_ui_copy = [
    '64-team',
    'SQLite',
    'Tauri',
    'Monte Carlo',
    'Paper bankroll',
]

for snippet in required_ui_copy:
    assert snippet in html, snippet

required_js_hooks = [
    'loadOfficialSeason',
    'loadBacktest',
    'persistState',
    'loadPersistedState',
    'simulateTournament',
    'buildTournamentBracketState',
    'currentTournamentRound',
    'renderMarketBoard',
    'syncTournamentState',
    'syncTournamentAndLiveContext',
    'syncLiveContext',
    'renderBetSizingBoard',
    'renderBetLedger',
    'autoSettleTrackedBets',
    'applyNewsSignals',
    'renderSignalBoard',
    'loadProviderStatus',
    'initializeWorkspace',
    'setActiveWorkspace',
    'renderWorkspaceTabs',
    'loadEvolution',
    'renderEvolution',
    'applyEvolutionWeights',
    'generateAiPrefill',
    'applyAiPrefill',
    'renderAiPrefill',
    'renderTournamentStatus',
]

for hook in required_js_hooks:
    assert hook in js, hook

print('frontend contract checks passed')
