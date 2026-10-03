const DEFAULT_LEVELS = [
  { smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 20, type: 'level' },
  { smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 20, type: 'level' },
  { smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 20, type: 'level' },
  { smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 20, type: 'level' },
  { smallBlind: 500, bigBlind: 1000, ante: 100, durationMinutes: 20, type: 'level' },
  { smallBlind: 600, bigBlind: 1200, ante: 200, durationMinutes: 20, type: 'level' },
  { smallBlind: 800, bigBlind: 1600, ante: 200, durationMinutes: 20, type: 'level' },
  { smallBlind: 1000, bigBlind: 2000, ante: 300, durationMinutes: 20, type: 'level' },
  { smallBlind: 1500, bigBlind: 3000, ante: 500, durationMinutes: 20, type: 'level' },
  { smallBlind: 2000, bigBlind: 4000, ante: 500, durationMinutes: 20, type: 'level' },
  { smallBlind: 3000, bigBlind: 6000, ante: 1000, durationMinutes: 20, type: 'level' },
  { smallBlind: 5000, bigBlind: 10000, ante: 1500, durationMinutes: 20, type: 'level' }
];

const state = {
  title: 'Home Game',
  levels: structuredClone(DEFAULT_LEVELS),
  levelIndex: 0,
  secondsLeft: 1200,
  endsAt: null,
  status: 'paused',
  initialPlayers: 8,
  startingStack: 10000,
  buyIn: 20,
  eliminated: 0,
  rebuys: 0,
  payouts: [50, 30, 20]
};

let tickHandle = null;
let saveHandle = null;
let toastHandle = null;
let audioContext = null;
let alarmHandle = null;
let currentAudioOscillators = [];
let serverStorage = 'memory';
let editMode = false;
const $ = (id) => document.getElementById(id);

async function initialize() {
  bindEvents();
  try {
    const [healthResponse, stateResponse] = await Promise.all([fetch('/api/health'), fetch('/api/state')]);
    if (!healthResponse.ok || !stateResponse.ok) throw new Error('Server nicht erreichbar');
    const health = await healthResponse.json();
    const saved = await stateResponse.json();
    serverStorage = health.storage;
    if (saved.state) restoreState(saved.state);
    $('ai-note').textContent = health.aiConfigured
      ? 'KI ist bereit. Die erzeugte Struktur ersetzt die aktuelle Liste.'
      : 'KI benötigt OPENAI_API_KEY in der Server-Konfiguration.';
    setSavedStatus(true, health.storage === 'mysql' ? 'Mit MySQL verbunden' : 'Nur temporär gespeichert');
  } catch (error) {
    setSavedStatus(false, 'Server nicht erreichbar');
    showToast('Serververbindung fehlgeschlagen. Timer läuft lokal im Browser.');
  }
  syncControls();
  render();
  if (state.status === 'running') startTicker();
  window.addEventListener('beforeunload', () => {
    stopAlarm();
    if (state.status !== 'running') saveState();
  });
}

function bindEvents() {
  $('start-button').addEventListener('click', startTimer);
  $('pause-button').addEventListener('click', pauseTimer);
  $('reset-button').addEventListener('click', resetLevel);
  $('acknowledge-button').addEventListener('click', acknowledgeAlarm);
  $('previous-level-button').addEventListener('click', () => moveLevel(-1));
  $('next-level-button').addEventListener('click', () => moveLevel(1));
  $('add-level-button').addEventListener('click', addLevel);
  $('eliminate-button').addEventListener('click', eliminatePlayer);
  $('rebuy-button').addEventListener('click', rebuyPlayer);
  $('import-button').addEventListener('click', () => $('json-file-input').click());
  $('json-file-input').addEventListener('change', importFile);
  $('export-button').addEventListener('click', exportStructure);
  $('apply-json-button').addEventListener('click', applyJsonEditor);
  $('json-toggle').addEventListener('click', toggleJsonEditor);
  $('settings-toggle').addEventListener('click', toggleSettings);
  $('generate-button').addEventListener('click', generateStructure);
  $('fullscreen-button').addEventListener('click', toggleFullscreen);
  $('edit-title-button').addEventListener('click', editTitle);
  $('levels-list').addEventListener('click', handleLevelClick);
  $('levels-list').addEventListener('change', handleLevelEdit);
  $('levels-list').addEventListener('keydown', handleLevelKey);
  $('edit-levels-button').addEventListener('click', toggleEditMode);
  $('add-break-button').addEventListener('click', addBreak);
  for (const id of ['initial-players', 'starting-stack', 'buy-in', 'payout-first', 'payout-second', 'payout-third']) {
    $(id).addEventListener('change', updateSettingsFromInputs);
  }
}

function restoreState(saved) {
  if (!saved || !Array.isArray(saved.levels) || !saved.levels.length) return;
  const candidate = { ...state, ...saved };
  if (!isValidStructure({ levels: candidate.levels })) return;
  Object.assign(state, candidate);
  state.levelIndex = clamp(Number(state.levelIndex) || 0, 0, state.levels.length - 1);
  state.secondsLeft = Math.max(0, Math.floor(Number(state.secondsLeft) || 0));
  state.initialPlayers = Math.max(2, Math.floor(Number(state.initialPlayers) || 8));
  state.startingStack = Math.max(1, Math.floor(Number(state.startingStack) || 10000));
  state.buyIn = Math.max(0, Number(state.buyIn) || 0);
  state.eliminated = clamp(Math.floor(Number(state.eliminated) || 0), 0, state.entries - 1);
  state.rebuys = Math.max(0, Math.floor(Number(state.rebuys) || 0));
  state.payouts = Array.isArray(state.payouts) && state.payouts.length === 3 ? state.payouts : [50, 30, 20];
  if (!['running', 'paused', 'alarm', 'finished'].includes(state.status)) state.status = 'paused';
  if (state.status === 'running') {
    state.endsAt = Number(saved.endsAt) || (Number(saved.savedAt) || Date.now()) + state.secondsLeft * 1000;
    state.secondsLeft = remainingSeconds();
    if (state.secondsLeft === 0) state.status = 'alarm';
  } else {
    state.endsAt = null;
  }
}

Object.defineProperty(state, 'entries', { get: () => state.initialPlayers + state.rebuys });
Object.defineProperty(state, 'playersInGame', { get: () => Math.max(0, state.entries - state.eliminated) });
Object.defineProperty(state, 'totalChips', { get: () => state.entries * state.startingStack });

function startTimer() {
  if (state.status === 'alarm' || state.status === 'finished') return;
  if (state.secondsLeft <= 0) state.secondsLeft = levelDuration(state.levels[state.levelIndex]);
  state.endsAt = Date.now() + state.secondsLeft * 1000;
  state.status = 'running';
  ensureAudio();
  startTicker();
  render();
  saveState();
}

function pauseTimer() {
  if (state.status !== 'running') return;
  state.secondsLeft = remainingSeconds();
  state.endsAt = null;
  state.status = 'paused';
  stopTicker();
  render();
  saveState();
}

function resetLevel() {
  stopAlarm();
  stopTicker();
  state.status = 'paused';
  state.secondsLeft = levelDuration(state.levels[state.levelIndex]);
  render();
  saveState();
}

function startTicker() {
  stopTicker();
  tickHandle = window.setInterval(tick, 250);
  document.addEventListener('visibilitychange', tick);
}

function stopTicker() {
  if (tickHandle) window.clearInterval(tickHandle);
  tickHandle = null;
  document.removeEventListener('visibilitychange', tick);
}

// Restzeit aus dem Endzeitpunkt ableiten, weil Browser Intervalle in Hintergrund-Tabs drosseln.
function tick() {
  if (state.status !== 'running') return;
  state.secondsLeft = remainingSeconds();
  if (state.secondsLeft <= 0) {
    state.status = 'alarm';
    state.endsAt = null;
    stopTicker();
    startAlarm();
    $('live-announcement').textContent = 'Level beendet. Alarm läuft.';
    saveState();
  }
  renderTimer();
  syncControls();
}

function remainingSeconds() {
  if (state.status !== 'running' || !state.endsAt) return state.secondsLeft;
  return Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
}

function acknowledgeAlarm() {
  stopAlarm();
  if (state.levelIndex >= state.levels.length - 1) {
    state.status = 'finished';
    showToast('Letztes Level beendet. Turnierstruktur abgeschlossen.');
  } else {
    state.levelIndex += 1;
    state.secondsLeft = levelDuration(state.levels[state.levelIndex]);
    state.endsAt = Date.now() + state.secondsLeft * 1000;
    state.status = 'running';
    ensureAudio();
    startTicker();
  }
  render();
  saveState();
}

function moveLevel(offset) {
  stopAlarm();
  stopTicker();
  state.levelIndex = clamp(state.levelIndex + offset, 0, state.levels.length - 1);
  state.secondsLeft = levelDuration(state.levels[state.levelIndex]);
  state.status = 'paused';
  render();
  saveState();
}

function startAlarm() {
  ensureAudio();
  if (!audioContext || alarmHandle) return;
  playAlarmTone();
  alarmHandle = window.setInterval(playAlarmTone, 1400);
}

function playAlarmTone() {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  for (const offset of [0, 0.22]) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = offset ? 740 : 880;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.21);
    currentAudioOscillators.push(oscillator);
    oscillator.addEventListener('ended', () => { currentAudioOscillators = currentAudioOscillators.filter((item) => item !== oscillator); });
  }
}

function stopAlarm() {
  if (alarmHandle) window.clearInterval(alarmHandle);
  alarmHandle = null;
  for (const oscillator of currentAudioOscillators) {
    try { oscillator.stop(); } catch { /* Already stopped. */ }
  }
  currentAudioOscillators = [];
}

function ensureAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  if (audioContext?.state === 'suspended') audioContext.resume();
}

function render() {
  renderTimer();
  renderStats();
  renderLevels();
  syncControls();
  $('tournament-title-display').textContent = state.title;
  $('initial-players').value = state.initialPlayers;
  $('starting-stack').value = state.startingStack;
  $('buy-in').value = state.buyIn;
  $('payout-first').value = state.payouts[0];
  $('payout-second').value = state.payouts[1];
  $('payout-third').value = state.payouts[2];
  updatePayouts();
}

function renderTimer() {
  const level = state.levels[state.levelIndex];
  if (!level) return;
  const mins = Math.floor(state.secondsLeft / 60).toString().padStart(2, '0');
  const secs = (state.secondsLeft % 60).toString().padStart(2, '0');
  $('timer-clock').textContent = `${mins}:${secs}`;
  $('level-label').textContent = level.type === 'break' ? 'PAUSE' : `LEVEL ${String(levelNumber(state.levelIndex)).padStart(2, '0')}`;
  $('timer-mode').textContent = ({ running: 'LÄUFT', paused: 'BEREIT', alarm: 'ALARM', finished: 'BEENDET' })[state.status];
  $('small-blind-display').textContent = level.type === 'break' ? 'Pause' : formatNumber(level.smallBlind);
  $('big-blind-display').textContent = level.type === 'break' ? '' : formatNumber(level.bigBlind);
  $('blind-separator').hidden = level.type === 'break';
  $('ante-display').textContent = level.type === 'break' ? 'CHIPS ZÄHLEN' : level.ante ? `ANTE ${formatNumber(level.ante)}` : 'OHNE ANTE';
  const progress = levelDuration(level) ? state.secondsLeft / levelDuration(level) : 0;
  $('timer-progress').style.transform = `scaleX(${clamp(progress, 0, 1)})`;
  $('alarm-overlay').hidden = state.status !== 'alarm';
  const next = state.levels[state.levelIndex + 1];
  $('next-level-caption').textContent = next
    ? (next.type === 'break' ? `NÄCHSTES · PAUSE ${next.durationMinutes} MIN` : `NÄCHSTES LEVEL · ${formatNumber(next.smallBlind)} / ${formatNumber(next.bigBlind)}`)
    : 'LETZTES LEVEL';
}

function renderStats() {
  $('players-in-game').innerHTML = `${formatNumber(state.playersInGame)} <small>/ ${formatNumber(state.entries)}</small>`;
  const average = state.playersInGame ? state.totalChips / state.playersInGame : 0;
  $('average-stack').textContent = formatNumber(average);
  $('prize-pool').textContent = `${formatCurrency(state.entries * state.buyIn)}`;
  $('eliminated-count').textContent = formatNumber(state.eliminated);
  $('eliminate-button').disabled = state.playersInGame === 0;
  updatePayouts();
}

function renderLevels() {
  $('levels-list').classList.toggle('is-editing', editMode);
  $('levels-list').innerHTML = state.levels.map((level, index) => {
    const isBreak = level.type === 'break';
    const name = isBreak ? 'Pause' : `Level ${levelNumber(index)}`;
    const number = `<span class="level-number">${isBreak ? 'Ⅱ' : String(levelNumber(index)).padStart(2, '0')}</span>`;
    const deleteButton = `<button class="level-delete" type="button" data-delete="${index}" aria-label="${name} löschen" title="Entfernen">×</button>`;
    if (editMode) {
      const input = (field, label) => `<label class="level-field"><span>${label}</span><input type="number" inputmode="numeric" min="${field === 'durationMinutes' ? 1 : 0}" ${field === 'durationMinutes' ? 'max="240"' : ''} step="1" value="${level[field]}" data-field="${field}" aria-label="${name} ${label}"></label>`;
      const fields = isBreak
        ? '<span class="level-field level-field-break">Pause</span>'
        : `${input('smallBlind', 'SB')}${input('bigBlind', 'BB')}${input('ante', 'Ante')}`;
      return `<div class="level-row level-row-edit${index === state.levelIndex ? ' active' : ''}" data-index="${index}">
        ${number}<span class="level-fields">${fields}${input('durationMinutes', 'Min')}</span>${deleteButton}
      </div>`;
    }
    const blindText = isBreak ? 'Pause' : `${formatNumber(level.smallBlind)} / ${formatNumber(level.bigBlind)}`;
    const anteText = isBreak ? 'Blindpause' : level.ante ? `Ante ${formatNumber(level.ante)}` : 'Ohne Ante';
    return `<div class="level-row${index === state.levelIndex ? ' active' : ''}" data-index="${index}" role="button" tabindex="0" aria-label="${isBreak ? 'Pause' : `${name}: ${blindText}`} auswählen">
      ${number}
      <span class="level-blinds"><strong>${blindText}</strong><span>${anteText}</span></span>
      <span class="level-duration">${level.durationMinutes} MIN</span>
      ${deleteButton}
    </div>`;
  }).join('');
  $('level-count').textContent = `${state.levels.filter((level) => level.type === 'level').length} LEVELS`;
  const minutes = state.levels.reduce((sum, level) => sum + level.durationMinutes, 0);
  $('total-duration').textContent = `GESAMT ${Math.floor(minutes / 60)}H ${String(minutes % 60).padStart(2, '0')}M`;
  $('json-editor').value = JSON.stringify({ levels: state.levels }, null, 2);
}

function syncControls() {
  $('start-button').disabled = state.status === 'running' || state.status === 'alarm' || state.status === 'finished';
  $('pause-button').disabled = state.status !== 'running';
  $('previous-level-button').disabled = state.levelIndex === 0;
  $('next-level-button').disabled = state.levelIndex === state.levels.length - 1;
  $('start-button').innerHTML = state.status === 'finished' ? '<span>✓</span> Beendet' : '<span>▶</span> Start';
}

function handleLevelClick(event) {
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    event.stopPropagation();
    deleteLevel(Number(deleteButton.dataset.delete));
    return;
  }
  if (editMode) return;
  const row = event.target.closest('[data-index]');
  if (row) moveToLevel(Number(row.dataset.index));
}

function handleLevelEdit(event) {
  const row = event.target.closest('[data-index]');
  const field = event.target.dataset.field;
  if (!row || !field) return;
  const index = Number(row.dataset.index);
  const level = state.levels[index];
  const value = Math.floor(Number(event.target.value));
  if (!Number.isFinite(value)) return render();
  level[field] = field === 'durationMinutes' ? clamp(value, 1, 240) : Math.max(0, value);
  // Struktur gültig halten, sonst verwirft restoreState den gespeicherten Stand.
  if (level.type === 'level') {
    level.smallBlind = Math.max(1, level.smallBlind);
    if (field === 'smallBlind') level.bigBlind = Math.max(level.bigBlind, level.smallBlind);
    else level.smallBlind = Math.min(level.smallBlind, level.bigBlind || 1);
    level.bigBlind = Math.max(level.bigBlind, level.smallBlind);
  }
  if (field === 'durationMinutes' && index === state.levelIndex && state.status !== 'running') {
    state.secondsLeft = levelDuration(state.levels[index]);
  }
  render();
  saveState();
}

function handleLevelKey(event) {
  if (editMode || !['Enter', ' '].includes(event.key) || event.target.closest('[data-delete]')) return;
  const row = event.target.closest('[data-index]');
  if (!row) return;
  event.preventDefault();
  moveToLevel(Number(row.dataset.index));
}

function toggleEditMode() {
  editMode = !editMode;
  $('edit-levels-button').setAttribute('aria-pressed', String(editMode));
  $('edit-levels-button').innerHTML = editMode ? '<span>✓</span> Fertig' : '<span>✎</span> Bearbeiten';
  renderLevels();
}

function addBreak() {
  state.levels.push({ smallBlind: 0, bigBlind: 0, ante: 0, durationMinutes: 10, type: 'break' });
  render();
  saveState();
  $('levels-list').lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function levelNumber(index) {
  return state.levels.slice(0, index + 1).filter((level) => level.type === 'level').length;
}

function moveToLevel(index) {
  if (index < 0 || index >= state.levels.length) return;
  stopTicker();
  stopAlarm();
  state.levelIndex = index;
  state.secondsLeft = levelDuration(state.levels[index]);
  state.status = 'paused';
  render();
  saveState();
}

function addLevel() {
  const previous = [...state.levels].reverse().find((level) => level.type === 'level') || { smallBlind: 100, bigBlind: 200, ante: 0 };
  const next = { smallBlind: previous.smallBlind * 2, bigBlind: previous.bigBlind * 2, ante: previous.ante * 2, durationMinutes: 20, type: 'level' };
  state.levels.push(next);
  render();
  saveState();
  $('levels-list').lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function deleteLevel(index) {
  if (state.levels.length <= 1) return showToast('Mindestens ein Level behalten.');
  state.levels.splice(index, 1);
  if (state.levelIndex >= state.levels.length) state.levelIndex = state.levels.length - 1;
  else if (index < state.levelIndex) state.levelIndex -= 1;
  state.secondsLeft = levelDuration(state.levels[state.levelIndex]);
  if (state.status !== 'finished') state.status = 'paused';
  stopAlarm();
  stopTicker();
  render();
  saveState();
}

function eliminatePlayer() {
  if (state.playersInGame <= 0) return;
  state.eliminated += 1;
  renderStats();
  saveState();
}

function rebuyPlayer() {
  state.rebuys += 1;
  renderStats();
  saveState();
  showToast('Rebuy erfasst: Buy-in und Startstack hinzugefügt.');
}

function updateSettingsFromInputs() {
  state.initialPlayers = clamp(Math.floor(Number($('initial-players').value) || 2), 2, 1000);
  state.startingStack = Math.max(1, Math.floor(Number($('starting-stack').value) || 1));
  state.buyIn = Math.max(0, Number($('buy-in').value) || 0);
  state.eliminated = Math.min(state.eliminated, state.entries - 1);
  state.payouts = ['payout-first', 'payout-second', 'payout-third'].map((id) => clamp(Number($(id).value) || 0, 0, 100));
  $('initial-players').value = state.initialPlayers;
  $('starting-stack').value = state.startingStack;
  $('buy-in').value = state.buyIn;
  renderStats();
  saveState();
}

function updatePayouts() {
  if (!$('payout-total')) return;
  const total = state.payouts.reduce((sum, share) => sum + Number(share || 0), 0);
  $('payout-total').textContent = `${total}%`;
  $('payout-total').classList.toggle('invalid', total !== 100);
  $('payout-results').innerHTML = state.payouts.map((share, index) => {
    const amount = Math.round(state.entries * state.buyIn * Number(share || 0)) / 100;
    return `<span>${index + 1}. ${formatCurrency(amount)}</span>`;
  }).join('');
}

async function importFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    applyStructure(data);
    showToast(`${state.levels.length} Einträge importiert.`);
  } catch (error) {
    showToast(error.message || 'JSON-Datei konnte nicht gelesen werden.');
  }
  event.target.value = '';
}

function exportStructure() {
  const blob = new Blob([`${JSON.stringify({ levels: state.levels }, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'blindstruktur.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

function applyJsonEditor() {
  try {
    applyStructure(JSON.parse($('json-editor').value));
    showToast('Blindstruktur übernommen.');
  } catch (error) {
    showToast(error.message || 'JSON ist ungültig.');
  }
}

function applyStructure(data) {
  const normalized = Array.isArray(data) ? { levels: data } : data;
  if (!isValidStructure(normalized)) {
    throw new Error('Ungültig: levels mit 1–100 Leveln/Pausen, Blinds und Dauer prüfen.');
  }
  stopTicker();
  stopAlarm();
  state.levels = normalized.levels.map((level) => ({
    smallBlind: Number(level.smallBlind),
    bigBlind: Number(level.bigBlind),
    ante: Number(level.ante || 0),
    durationMinutes: Number(level.durationMinutes),
    type: level.type
  }));
  state.levelIndex = 0;
  state.secondsLeft = levelDuration(state.levels[0]);
  state.status = 'paused';
  render();
  saveState();
}

function isValidStructure(data) {
  return Array.isArray(data?.levels) && data.levels.length > 0 && data.levels.length <= 100
    && data.levels.every((level) => level && ['level', 'break'].includes(level.type)
      && Number.isInteger(Number(level.durationMinutes)) && Number(level.durationMinutes) >= 1 && Number(level.durationMinutes) <= 240
      && Number.isInteger(Number(level.smallBlind)) && Number(level.smallBlind) >= 0
      && Number.isInteger(Number(level.bigBlind)) && Number(level.bigBlind) >= 0
      && Number.isInteger(Number(level.ante || 0)) && Number(level.ante || 0) >= 0
      && (level.type === 'break' || (Number(level.smallBlind) > 0 && Number(level.bigBlind) >= Number(level.smallBlind))));
}

async function generateStructure() {
  const prompt = $('ai-prompt').value.trim();
  if (!prompt) return showToast('Beschreibe zuerst dein Turnier.');
  const button = $('generate-button');
  button.disabled = true;
  button.textContent = 'Struktur wird erstellt …';
  try {
    const response = await fetch('/api/generate-structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'KI-Anfrage fehlgeschlagen.');
    applyStructure(result.structure);
    showToast(`${state.levels.length} Einträge mit KI erstellt.`);
  } catch (error) {
    showToast(error.message || 'KI-Anfrage fehlgeschlagen.');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>✳</span> Blindstruktur erstellen';
  }
}

function toggleJsonEditor() {
  const open = $('json-toggle').getAttribute('aria-expanded') !== 'true';
  $('json-toggle').setAttribute('aria-expanded', String(open));
  $('json-editor-wrap').hidden = !open;
  $('json-toggle').lastElementChild.textContent = open ? '⌃' : '⌄';
}

function toggleSettings() {
  const open = $('settings-toggle').getAttribute('aria-expanded') !== 'true';
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-content').hidden = !open;
  $('settings-toggle').innerHTML = `${open ? 'Einklappen' : 'Ausklappen'} <span>${open ? '⌃' : '⌄'}</span>`;
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch { showToast('Vollbild wird von diesem Browser nicht unterstützt.'); }
}

function editTitle() {
  const title = window.prompt('Turniername', state.title);
  if (title?.trim()) {
    state.title = title.trim().slice(0, 50);
    $('tournament-title-display').textContent = state.title;
    saveState();
  }
}

function levelDuration(level) {
  return Math.max(60, Number(level?.durationMinutes || 1) * 60);
}

function formatNumber(value) {
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(value);
}

function formatCurrency(value) {
  return `CHF ${new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(value)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastHandle);
  toastHandle = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function setSavedStatus(saved, label) {
  $('save-dot').classList.toggle('is-saved', saved);
  $('save-dot').classList.toggle('is-error', !saved);
  $('save-status').textContent = label;
}

function saveState() {
  const snapshot = { ...state, levels: state.levels.map((level) => ({ ...level })), payouts: [...state.payouts], savedAt: Date.now() };
  if (saveHandle) window.clearTimeout(saveHandle);
  saveHandle = window.setTimeout(async () => {
    try {
      const response = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: snapshot })
      });
      if (!response.ok) throw new Error('Speichern fehlgeschlagen');
      const result = await response.json();
      serverStorage = result.storage;
      setSavedStatus(true, result.storage === 'mysql' ? 'In MySQL gespeichert' : 'Nur temporär gespeichert');
    } catch {
      setSavedStatus(false, 'Speichern fehlgeschlagen');
    }
  }, 180);
}

initialize();
