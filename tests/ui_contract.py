from pathlib import Path

html = Path('index.html').read_text()
js = Path('app.js').read_text()

required_html_ids = [
    'simulateButton',
    'weightControls',
    'marketBoard',
    'teamTableBody',
    'bracketView',
]

for element_id in required_html_ids:
    assert f'id="{element_id}"' in html, element_id

required_ui_copy = [
    '64-team',
    'SQLite',
    'Tauri',
    'Monte Carlo',
]

for snippet in required_ui_copy:
    assert snippet in html, snippet

required_js_hooks = [
    'persistState',
    'loadPersistedState',
    'simulateTournament',
    'renderMarketBoard',
]

for hook in required_js_hooks:
    assert hook in js, hook

print('frontend contract checks passed')
