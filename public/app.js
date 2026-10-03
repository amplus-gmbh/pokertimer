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
  payouts: [50, 30, 20],
  alarmSound: 'soft',
  locked: false,
  chipCase: DEFAULT_CHIP_CASE.map((chip) => ({ ...chip })),
  rebuyReserve: 0,
  prompt: { durationHours: 4, breakEvery: 60, breakLength: 10, wishes: '' }
};
const DEFAULT_PROMPT = { ...state.prompt };
// Ein Durchgang pro Intervall; wiederholt sich, bis der Alarm quittiert wird.
const ALARM_SOUNDS = {
  soft: { wave: 'sine', volume: 0.12, length: 0.2, interval: 1400, notes: [{ at: 0, frequency: 880 }, { at: 0.22, frequency: 740 }] },
  medium: {
    wave: 'triangle', volume: 0.3, length: 0.16, interval: 1200,
    notes: [{ at: 0, frequency: 988 }, { at: 0.19, frequency: 784 }, { at: 0.38, frequency: 988 }, { at: 0.57, frequency: 1175 }]
  },
  loud: {
    wave: 'square', volume: 0.22, length: 0.1, interval: 900,
    notes: [0, 0.12, 0.24, 0.36, 0.48, 0.6].map((at, index) => ({ at, frequency: index % 2 ? 950 : 1400 }))
  }
};
const PROMPT_FIELDS = {
  'prompt-duration': 'durationHours',
  'prompt-break-every': 'breakEvery',
  'prompt-break-length': 'breakLength',
  'ai-prompt': 'wishes'
};

let tickHandle = null;
let saveHandle = null;
let toastHandle = null;
let audioContext = null;
let alarmHandle = null;
let currentAudioOscillators = [];
let serverStorage = 'memory';
let editMode = false;
let unlockConfirmHandle = null;
const $ = (id) => document.getElementById(id);
const TOURNAMENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const tournamentId = resolveTournamentId();
const tournamentUrl = `/api/tournaments/${tournamentId}`;

async function initialize() {
  bindEvents();
  try {
    const healthResponse = await fetch('/api/health');
    if (!healthResponse.ok) throw new Error('Server nicht erreichbar');
    const health = await healthResponse.json();
    if (health.storage === 'mysql' && !health.dbReady) {
      setSavedStatus(false, `Datenbank-Fehler (${health.dbError || 'unbekannt'})`);
      showToast('Datenbank nicht erreichbar. Timer läuft lokal, Änderungen werden nicht gespeichert.');
      syncControls();
      render();
      return;
    }
    const stateResponse = await fetch(tournamentUrl);
    if (!stateResponse.ok) throw new Error('Server nicht erreichbar');
    const saved = await stateResponse.json();
    serverStorage = health.storage;
    if (saved.state) restoreState(saved.state);
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
  $('settings-toggle').addEventListener('click', () => toggleSection('settings-toggle', 'settings-content'));
  $('copy-prompt-button').addEventListener('click', copyPrompt);
  $('prompt-preview').addEventListener('focus', () => $('prompt-preview').select());
  $('test-alarm-button').addEventListener('click', testAlarm);
  $('lock-button').addEventListener('click', handleLockClick);
  $('resume-button').addEventListener('click', openResumeDialog);
  $('resume-form').addEventListener('submit', applyResume);
  $('resume-cancel').addEventListener('click', () => $('resume-dialog').close());
  $('resume-level').addEventListener('change', () => setResumeTime(levelDuration(state.levels[Number($('resume-level').value)])));
  $('alarm-sound').addEventListener('change', (event) => {
    state.alarmSound = ALARM_SOUNDS[event.target.value] ? event.target.value : 'soft';
    saveState();
    if (state.status !== 'alarm') { ensureAudio(); playAlarmTone(); }
  });
  for (const id of Object.keys(PROMPT_FIELDS)) {
    $(id).addEventListener('input', updatePromptFromInputs);
    $(id).addEventListener('change', () => { syncPromptInputs(); saveState(); });
  }
  $('apply-answer-button').addEventListener('click', applyAnswer);
  $('fullscreen-button').addEventListener('click', toggleFullscreen);
  // Esc beendet das Vollbild; Anzeigemodus dann ebenfalls verlassen.
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setDisplayMode(false); });
  $('edit-title-button').addEventListener('click', editTitle);
  $('levels-list').addEventListener('click', handleLevelClick);
  $('levels-list').addEventListener('change', handleLevelEdit);
  $('levels-list').addEventListener('keydown', handleLevelKey);
  $('edit-levels-button').addEventListener('click', toggleEditMode);
  $('add-break-button').addEventListener('click', addBreak);
  for (const id of ['initial-players', 'starting-stack', 'buy-in']) {
    $(id).addEventListener('change', updateSettingsFromInputs);
  }
  $('payout-places').addEventListener('change', () => setPaidPlaces(Number($('payout-places').value)));
  $('payout-recommend-button').addEventListener('click', () => setPaidPlaces(recommendedPaidPlaces(state.entries)));
  $('payout-grid').addEventListener('change', updatePayoutShare);
  $('chips-toggle').addEventListener('click', () => toggleSection('chips-toggle', 'chips-content'));
  $('chip-rows').addEventListener('input', updateChipCaseFromInputs);
  $('chip-rows').addEventListener('change', () => { normalizeChipCase(); saveState(); });
  $('chip-rows').addEventListener('click', removeChipRow);
  $('add-chip-button').addEventListener('click', addChipRow);
  $('rebuy-reserve').addEventListener('input', () => {
    state.rebuyReserve = clamp(Math.floor(Number($('rebuy-reserve').value) || 0), 0, 200);
    renderChipAnalysis();
    saveState();
  });
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
  state.payouts = sanitizePayouts(state.payouts);
  state.chipCase = sanitizeChipCase(saved.chipCase ?? legacyChipCase(saved.prompt?.chips));
  state.rebuyReserve = clamp(Math.floor(Number(state.rebuyReserve) || 0), 0, 200);
  state.prompt = sanitizePrompt(saved.prompt);
  if (!ALARM_SOUNDS[state.alarmSound]) state.alarmSound = 'soft';
  state.locked = state.locked === true;
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
  if (!state.locked) {
    setLocked(true);
    showToast('Timer gesperrt. Für Level- oder Strukturänderungen zuerst entsperren.');
  }
  ensureAudio();
  startTicker();
  render();
  saveState();
}

// Sperre schützt ein laufendes Turnier vor versehentlichem Zurücksetzen oder Levelwechsel.
function setLocked(locked) {
  state.locked = locked;
  if (locked && editMode) toggleEditMode();
  window.clearTimeout(unlockConfirmHandle);
  unlockConfirmHandle = null;
}

function blockedByLock() {
  if (!state.locked) return false;
  showToast('Timer ist gesperrt. Zum Ändern zuerst «Gesperrt» antippen und bestätigen.');
  const button = $('lock-button');
  button.classList.remove('is-nudged');
  void button.offsetWidth;
  button.classList.add('is-nudged');
  return true;
}

function handleLockClick() {
  if (!state.locked) {
    setLocked(true);
    showToast('Timer gesperrt.');
  } else if (!unlockConfirmHandle) {
    // Zweistufig entsperren, damit ein einzelner Fehlklick nichts auslöst.
    unlockConfirmHandle = window.setTimeout(() => { unlockConfirmHandle = null; renderLock(); }, 4000);
    renderLock();
    return;
  } else {
    setLocked(false);
    showToast('Entsperrt. Level und Struktur können geändert werden.');
  }
  render();
  saveState();
}

function renderLock() {
  const button = $('lock-button');
  button.classList.toggle('is-locked', state.locked);
  button.classList.toggle('is-confirming', Boolean(unlockConfirmHandle));
  button.setAttribute('aria-pressed', String(state.locked));
  button.innerHTML = !state.locked ? '<span>🔓</span> Sperren' : unlockConfirmHandle ? 'Wirklich entsperren?' : '<span>🔒</span> Gesperrt';
  document.body.classList.toggle('is-locked', state.locked);
}

function openResumeDialog() {
  if (blockedByLock()) return;
  $('resume-level').innerHTML = state.levels.map((level, index) => {
    const label = level.type === 'break'
      ? `Pause (${level.durationMinutes} Min.)`
      : `Level ${levelNumber(index)}: ${formatNumber(level.smallBlind)} / ${formatNumber(level.bigBlind)}${level.ante ? `, Ante ${formatNumber(level.ante)}` : ''} (${level.durationMinutes} Min.)`;
    return `<option value="${index}"${index === state.levelIndex ? ' selected' : ''}>${label}</option>`;
  }).join('');
  setResumeTime(remainingSeconds());
  $('resume-dialog').showModal();
  $('resume-minutes').select();
}

function setResumeTime(seconds) {
  $('resume-minutes').value = Math.floor(seconds / 60);
  $('resume-seconds').value = seconds % 60;
}

function applyResume(event) {
  event.preventDefault();
  const index = Number($('resume-level').value);
  const seconds = clamp(Math.floor(Number($('resume-minutes').value) || 0), 0, 240) * 60
    + clamp(Math.floor(Number($('resume-seconds').value) || 0), 0, 59);
  if (!state.levels[index]) return;
  if (seconds < 1) return showToast('Restzeit muss mindestens 1 Sekunde sein.');
  stopTicker();
  stopAlarm();
  state.levelIndex = index;
  state.secondsLeft = seconds;
  state.endsAt = null;
  state.status = 'paused';
  $('resume-dialog').close();
  render();
  saveState();
  showToast(`Bereit: ${state.levels[index].type === 'break' ? 'Pause' : `Level ${levelNumber(index)}`} mit ${formatClock(seconds)}. Start drücken.`);
}

function formatClock(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
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
  if (blockedByLock()) return;
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
  if (blockedByLock()) return;
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
  alarmHandle = window.setInterval(playAlarmTone, alarmSound().interval);
}

function alarmSound() {
  return ALARM_SOUNDS[state.alarmSound] || ALARM_SOUNDS.soft;
}

function playAlarmTone() {
  if (!audioContext) return;
  const sound = alarmSound();
  const now = audioContext.currentTime;
  for (const note of sound.notes) {
    const start = now + note.at;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = sound.wave;
    oscillator.frequency.value = note.frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(sound.volume, start + 0.015);
    gain.gain.setValueAtTime(sound.volume, start + sound.length * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + sound.length);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + sound.length + 0.01);
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
  renderPayoutGrid();
  renderChipRows();
  $('rebuy-reserve').value = state.rebuyReserve;
  syncPromptInputs();
  $('alarm-sound').value = state.alarmSound;
  renderLock();
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
  const { colorUps } = structureAnalysis();
  const colorUpNow = colorUps.get(state.levelIndex);
  $('ante-display').textContent = level.type === 'break'
    ? (colorUpNow ? `COLOR-UP: ${chipLabel(colorUpNow).toUpperCase()} RAUS` : 'CHIPS ZÄHLEN')
    : level.ante ? `ANTE ${formatNumber(level.ante)}` : 'OHNE ANTE';
  const progress = levelDuration(level) ? state.secondsLeft / levelDuration(level) : 0;
  $('timer-progress').style.transform = `scaleX(${clamp(progress, 0, 1)})`;
  $('alarm-overlay').hidden = state.status !== 'alarm';
  const next = state.levels[state.levelIndex + 1];
  const colorUpNext = colorUps.get(state.levelIndex + 1);
  $('next-level-caption').textContent = next
    ? (next.type === 'break' ? `NÄCHSTES · PAUSE ${next.durationMinutes} MIN` : `NÄCHSTES LEVEL · ${formatNumber(next.smallBlind)} / ${formatNumber(next.bigBlind)}`)
      + (colorUpNext ? ` · COLOR-UP ${chipLabel(colorUpNext).toUpperCase()}` : '')
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
  const analysis = structureAnalysis();
  const smallestChip = chipValuesInPlay()[0];
  $('levels-list').innerHTML = state.levels.map((level, index) => {
    const isBreak = level.type === 'break';
    const unpayable = analysis.unpayable.has(index);
    const colorUp = analysis.colorUps.get(index);
    const flags = `${unpayable ? ' is-unpayable' : ''}`;
    const notes = `${unpayable ? `<em class="level-alert">Nicht mit ${formatNumber(smallestChip)}er-Chips bezahlbar</em>` : ''}${
      colorUp ? `<em class="level-colorup">Color-up: ${chipLabel(colorUp)} entfernen</em>` : ''}`;
    const name = isBreak ? 'Pause' : `Level ${levelNumber(index)}`;
    const number = `<span class="level-number">${isBreak ? 'Ⅱ' : String(levelNumber(index)).padStart(2, '0')}</span>`;
    const deleteButton = `<button class="level-delete" type="button" data-delete="${index}" aria-label="${name} löschen" title="Entfernen">×</button>`;
    if (editMode) {
      const input = (field, label) => `<label class="level-field"><span>${label}</span><input type="number" inputmode="numeric" min="${field === 'durationMinutes' ? 1 : 0}" ${field === 'durationMinutes' ? 'max="240"' : ''} step="1" value="${level[field]}" data-field="${field}" aria-label="${name} ${label}"></label>`;
      const fields = isBreak
        ? '<span class="level-field level-field-break">Pause</span>'
        : `${input('smallBlind', 'SB')}${input('bigBlind', 'BB')}${input('ante', 'Ante')}`;
      return `<div class="level-row level-row-edit${index === state.levelIndex ? ' active' : ''}${flags}" data-index="${index}">
        ${number}<span class="level-fields">${fields}${input('durationMinutes', 'Min')}</span>${deleteButton}
      </div>`;
    }
    const blindText = isBreak ? 'Pause' : `${formatNumber(level.smallBlind)} / ${formatNumber(level.bigBlind)}`;
    const anteText = isBreak ? 'Blindpause' : level.ante ? `Ante ${formatNumber(level.ante)}` : 'Ohne Ante';
    return `<div class="level-row${index === state.levelIndex ? ' active' : ''}${flags}" data-index="${index}" role="button" tabindex="0" aria-label="${isBreak ? 'Pause' : `${name}: ${blindText}`} auswählen">
      ${number}
      <span class="level-blinds"><strong>${blindText}</strong><span>${anteText}</span>${notes}</span>
      <span class="level-duration">${level.durationMinutes} MIN</span>
      ${deleteButton}
    </div>`;
  }).join('');
  $('structure-warning').hidden = !analysis.unpayable.size;
  $('structure-warning').textContent = structureWarning(analysis);
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
  if (event.target.closest('[data-index]') && blockedByLock()) return;
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
  if (blockedByLock()) return;
  moveToLevel(Number(row.dataset.index));
}

function toggleEditMode() {
  if (!editMode && blockedByLock()) return;
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
  $('initial-players').value = state.initialPlayers;
  $('starting-stack').value = state.startingStack;
  $('buy-in').value = state.buyIn;
  renderStats();
  renderChipAnalysis();
  saveState();
}

function sanitizePayouts(payouts) {
  if (!Array.isArray(payouts) || !payouts.length || payouts.length > MAX_PAID_PLACES) return payoutTemplate(3);
  return payouts.map((share) => clamp(Math.round(Number(share) || 0), 0, 100));
}

function setPaidPlaces(places) {
  state.payouts = payoutTemplate(clamp(Math.floor(places) || 1, 1, MAX_PAID_PLACES));
  renderPayoutGrid();
  saveState();
}

function updatePayoutShare(event) {
  const place = Number(event.target.dataset.place);
  if (!Number.isInteger(place) || !(place in state.payouts)) return;
  state.payouts[place] = clamp(Math.round(Number(event.target.value) || 0), 0, 100);
  event.target.value = state.payouts[place];
  updatePayouts();
  saveState();
}

function renderPayoutGrid() {
  $('payout-places').value = state.payouts.length;
  $('payout-grid').innerHTML = state.payouts.map((share, place) => `<div class="payout-place">
      <label for="payout-share-${place}">${place + 1}. Platz</label>
      <span class="payout-input"><input id="payout-share-${place}" type="number" inputmode="numeric" min="0" max="100" value="${share}" data-place="${place}"><span>%</span></span>
      <strong class="payout-amount" id="payout-amount-${place}">CHF 0</strong>
    </div>`).join('');
  updatePayouts();
}

function updatePayouts() {
  const total = state.payouts.reduce((sum, share) => sum + share, 0);
  $('payout-total').textContent = total === 100 ? 'Total 100%' : `Total ${total}% (soll 100%)`;
  $('payout-total').classList.toggle('invalid', total !== 100);
  payoutAmounts(state.entries * state.buyIn, state.payouts).forEach((amount, place) => {
    const target = $(`payout-amount-${place}`);
    if (target) target.textContent = formatCurrency(amount);
  });
  const recommended = recommendedPaidPlaces(state.entries);
  $('payout-hint').hidden = recommended === state.payouts.length;
  $('payout-hint-text').textContent = `Bei ${state.entries} Einträgen sind ${recommended} bezahlte ${recommended === 1 ? 'Platz' : 'Plätze'} üblich.`;
}

// Alte Stände kannten nur Chipwerte als Text; Anzahl dann mit 100 pro Wert annehmen.
function legacyChipCase(text) {
  if (typeof text !== 'string') return undefined;
  const values = text.split(/[^\d]+/).filter(Boolean).map(Number);
  return values.length ? values.map((value) => ({ value, count: 100 })) : undefined;
}

let distributionCache = { key: '', result: null };

function chipDistribution() {
  const key = JSON.stringify([state.chipCase, state.startingStack, state.initialPlayers, state.rebuyReserve]);
  if (distributionCache.key !== key) {
    distributionCache = { key, result: distributeStack(state.chipCase, state.startingStack, state.initialPlayers, state.rebuyReserve) };
  }
  return distributionCache.result;
}

// Ohne gültige Stückelung gegen alle Chips im Koffer prüfen.
function chipValuesInPlay() {
  const distribution = chipDistribution();
  return distribution.ok ? distribution.valuesInPlay : state.chipCase.filter((chip) => chip.count > 0).map((chip) => chip.value);
}

function structureAnalysis() {
  return analyzeStructure(state.levels, chipValuesInPlay());
}

function renderChipRows() {
  $('chip-rows').innerHTML = `<div class="chip-row chip-row-head"><span>Wert</span><span>Anzahl im Koffer</span><span></span></div>${
    state.chipCase.map((chip, index) => `<div class="chip-row" data-chip="${index}">
      <input type="number" inputmode="numeric" min="1" step="1" value="${chip.value}" data-chip-field="value" aria-label="Chipwert ${index + 1}">
      <input type="number" inputmode="numeric" min="0" step="1" value="${chip.count}" data-chip-field="count" aria-label="Anzahl Chips à ${chip.value}">
      <button class="level-delete" type="button" data-remove-chip="${index}" aria-label="Chipwert ${chip.value} entfernen" title="Entfernen">×</button>
    </div>`).join('')}`;
  $('add-chip-button').disabled = state.chipCase.length >= MAX_CHIP_ROWS;
  renderChipAnalysis();
}

function updateChipCaseFromInputs(event) {
  const row = event.target.closest('[data-chip]');
  const field = event.target.dataset.chipField;
  if (!row || !field) return;
  const chip = state.chipCase[Number(row.dataset.chip)];
  const value = Math.floor(Number(event.target.value));
  if (!chip || !Number.isFinite(value)) return;
  chip[field] = Math.max(field === 'value' ? 1 : 0, value);
  renderChipAnalysis();
}

// Beim Verlassen eines Felds sortieren und doppelte Werte zusammenführen.
function normalizeChipCase() {
  const normalized = sanitizeChipCase(state.chipCase);
  const changed = JSON.stringify(normalized) !== JSON.stringify(state.chipCase);
  state.chipCase = normalized;
  if (changed) renderChipRows();
}

function addChipRow() {
  if (state.chipCase.length >= MAX_CHIP_ROWS) return;
  const largest = state.chipCase.at(-1)?.value || 0;
  state.chipCase.push({ value: largest ? largest * 5 : 25, count: 50 });
  renderChipRows();
  saveState();
}

function removeChipRow(event) {
  const button = event.target.closest('[data-remove-chip]');
  if (!button) return;
  state.chipCase.splice(Number(button.dataset.removeChip), 1);
  renderChipRows();
  saveState();
}

function renderChipAnalysis() {
  const distribution = chipDistribution();
  let html;
  if (!distribution.ok) {
    html = `<p class="chip-warning">${escapeHtml(distribution.reason)}</p>`;
  } else {
    const perPlayer = distribution.rows.filter((row) => row.perPlayer > 0)
      .map((row) => `${row.perPlayer} × ${formatNumber(row.value)}`).join(' + ');
    const setsText = state.rebuyReserve
      ? `${state.initialPlayers} Spieler + ${state.rebuyReserve} Rebuy-Stacks`
      : `${state.initialPlayers} Spieler`;
    html = `<p class="chip-summary"><strong>Pro Spieler:</strong> ${perPlayer} = ${formatNumber(state.startingStack)} <span>(${distribution.chipsPerPlayer} Chips)</span></p>
      <table class="chip-table">
        <thead><tr><th>Wert</th><th>Pro Spieler</th><th>Für ${escapeHtml(setsText)}</th><th>Im Koffer</th><th>Übrig</th></tr></thead>
        <tbody>${distribution.rows.map((row) => `<tr${row.perPlayer ? '' : ' class="is-unused"'}>
          <td>${formatNumber(row.value)}</td><td>${row.perPlayer}</td><td>${formatNumber(row.needed)}</td><td>${formatNumber(row.available)}</td><td>${formatNumber(row.rest)}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${distribution.warnings.map((warning) => `<p class="chip-warning">${escapeHtml(warning)}</p>`).join('')}`;
  }
  $('chip-result').innerHTML = html;
  renderLevels();
  renderTimer();
  renderPromptPreview();
}

function structureWarning(analysis = structureAnalysis()) {
  const count = analysis.unpayable.size;
  if (!count) return '';
  return `${count} ${count === 1 ? 'Level passt' : 'Level passen'} nicht zu den Chips im Spiel (kleinster Chip ${formatNumber(chipValuesInPlay()[0])}). Rot markierte Werte anpassen oder Chipkoffer prüfen.`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function chipLabel(values) {
  return values.map((value) => `${formatNumber(value)}er`).join(' und ');
}

function sanitizePrompt(saved) {
  const prompt = { ...DEFAULT_PROMPT, ...(saved && typeof saved === 'object' ? saved : {}) };
  return {
    durationHours: clamp(Number(prompt.durationHours) || DEFAULT_PROMPT.durationHours, 0.5, 24),
    breakEvery: clamp(Math.floor(Number(prompt.breakEvery) || 0), 0, 600),
    breakLength: clamp(Math.floor(Number(prompt.breakLength) || DEFAULT_PROMPT.breakLength), 1, 120),
    wishes: String(prompt.wishes ?? '').slice(0, 1000)
  };
}

function updatePromptFromInputs(event) {
  state.prompt[PROMPT_FIELDS[event.target.id]] = event.target.value;
  renderPromptPreview();
  saveState();
}

function syncPromptInputs() {
  state.prompt = sanitizePrompt(state.prompt);
  for (const [id, key] of Object.entries(PROMPT_FIELDS)) {
    if (document.activeElement !== $(id)) $(id).value = state.prompt[key];
  }
  renderPromptPreview();
}

function renderPromptPreview() {
  $('prompt-preview').value = buildPrompt();
}

function testAlarm() {
  if (state.status === 'alarm') return;
  ensureAudio();
  if (!audioContext) return showToast('Dieser Browser unterstützt keine Tonausgabe.');
  const { interval } = alarmSound();
  playAlarmTone();
  window.setTimeout(playAlarmTone, interval);
  window.setTimeout(playAlarmTone, interval * 2);
  showToast('Alarmton wird abgespielt. Lautstärke prüfen.');
}

async function importFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    applyStructure(data);
    showToast(`${state.levels.length} Einträge importiert. ${structureWarning()}`);
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
    applyStructure(extractJson($('json-editor').value));
    showToast(`Blindstruktur übernommen. ${structureWarning()}`);
  } catch (error) {
    showToast(error.message || 'JSON ist ungültig.');
  }
}

function applyStructure(data) {
  if (state.locked) throw new Error('Timer ist gesperrt. Zum Ersetzen der Struktur zuerst entsperren.');
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

function buildPrompt() {
  const prompt = sanitizePrompt(state.prompt);
  const distribution = chipDistribution();
  const chips = chipValuesInPlay();
  const chipCase = state.chipCase.filter((chip) => chip.count > 0).map((chip) => `${chip.count} × ${chip.value}`).join(', ');
  const stackLine = distribution.ok
    ? `- Stückelung pro Spieler (fest): ${distribution.rows.filter((row) => row.perPlayer > 0).map((row) => `${row.perPlayer} × ${row.value}`).join(' + ')}\n- Chipwerte im Spiel: ${chips.join(', ')}`
    : `- Chipkoffer: ${chipCase || 'unbekannt'}`;
  const hours = String(prompt.durationHours).replace('.', ',');
  const breaks = prompt.breakEvery > 0
    ? `etwa alle ${prompt.breakEvery} Minuten Spielzeit eine Pause von ${prompt.breakLength} Minuten`
    : 'keine Pausen';
  return `Erstelle eine Blindstruktur für ein No-Limit-Hold'em-Pokerturnier.

Turnierdaten:
- Spieler: ${state.initialPlayers}
- Startstack: ${state.startingStack} Chips pro Spieler (insgesamt ${state.initialPlayers * state.startingStack} Chips im Spiel)
- Geplante Spieldauer: etwa ${hours} Stunden bis zum Sieger
${stackLine}
- Pausen: ${breaks}
${prompt.wishes.trim() ? `- Weitere Wünsche: ${prompt.wishes.trim()}\n` : ''}
Anforderungen:
- Levellängen und Blindsteigerung so wählen, dass das Turnier ungefähr in der geplanten Spieldauer entschieden ist. Danach noch 2–3 weitere Level anhängen, falls es länger dauert.
${chips.length ? `- Small Blind, Big Blind und Ante müssen mit den Chips im Spiel bezahlbar sein, also immer Vielfache von ${chips[0]}.
- Color-up: Der kleinste Chip darf erst wegfallen, wenn alle folgenden Werte Vielfache des nächstgrösseren Chips sind. Plane solche Wechsel möglichst direkt nach einer Pause.\n` : ''}- Pausen sind eigene Einträge an den passenden Stellen.

Antworte ausschliesslich mit JSON in genau diesem Format, ohne weiteren Text:
{"levels":[{"smallBlind":25,"bigBlind":50,"ante":0,"durationMinutes":20,"type":"level"},{"smallBlind":0,"bigBlind":0,"ante":0,"durationMinutes":10,"type":"break"}]}

Regeln:
- Jeder Eintrag hat genau die Felder smallBlind, bigBlind, ante, durationMinutes und type.
- type ist "level" für ein Blindlevel oder "break" für eine Pause. Bei Pausen sind smallBlind, bigBlind und ante 0.
- Alle Werte sind ganze Zahlen. Bei Levels gilt smallBlind > 0, bigBlind >= smallBlind und ante >= 0 (0 = ohne Ante).
- durationMinutes liegt zwischen 1 und 240.
- Höchstens 100 Einträge, in Spielreihenfolge.
- Die Blinds steigen von Level zu Level und passen zu Startstack und Spielerzahl.`;
}

async function copyPrompt() {
  if (await copyText(buildPrompt())) {
    showToast('Prompt kopiert. Im KI-Chat einfügen und die Antwort unten einfügen.');
    $('ai-answer').focus();
  } else {
    showToast('Kopieren nicht möglich. Bitte Zwischenablage im Browser erlauben.');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback für Browser ohne Clipboard-API-Berechtigung.
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    return copied;
  }
}

function applyAnswer() {
  const answer = $('ai-answer').value.trim();
  if (!answer) return showToast('Zuerst die Antwort der KI einfügen.');
  try {
    applyStructure(extractJson(answer));
    $('ai-answer').value = '';
    showToast(`${state.levels.length} Einträge übernommen. ${structureWarning()}`);
  } catch (error) {
    showToast(error.message || 'Antwort konnte nicht gelesen werden.');
  }
}

// KI-Antworten enthalten oft Codeblöcke oder Begleittext rund um das JSON.
function extractJson(text) {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Nächsten Kandidaten versuchen. */ }
  }
  throw new Error('Kein gültiges JSON gefunden. Bitte die vollständige Antwort einfügen.');
}

function resolveTournamentId() {
  const params = new URLSearchParams(window.location.search);
  let id = params.get('t');
  if (!TOURNAMENT_ID.test(id || '')) {
    try { id = window.localStorage.getItem('tournamentId'); } catch { id = null; }
  }
  if (!TOURNAMENT_ID.test(id || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  try { window.localStorage.setItem('tournamentId', id); } catch { /* Ohne Speicher bleibt die ID in der URL. */ }
  // ID in der URL halten, damit sich das Turnier per Link auf einem zweiten Gerät öffnen lässt.
  params.set('t', id);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
  return id;
}

function toggleJsonEditor() {
  const open = $('json-toggle').getAttribute('aria-expanded') !== 'true';
  $('json-toggle').setAttribute('aria-expanded', String(open));
  $('json-editor-wrap').hidden = !open;
  $('json-toggle').lastElementChild.textContent = open ? '⌃' : '⌄';
}

function toggleSection(buttonId, contentId) {
  const open = $(buttonId).getAttribute('aria-expanded') !== 'true';
  $(buttonId).setAttribute('aria-expanded', String(open));
  $(contentId).hidden = !open;
  $(buttonId).innerHTML = `${open ? 'Einklappen' : 'Ausklappen'} <span>${open ? '⌃' : '⌄'}</span>`;
}

// Vollbild schaltet den Anzeigemodus (nur Uhr und Kennzahlen) mit ein.
// Ohne Vollbild-API (z. B. iPhone) wird nur der Anzeigemodus umgeschaltet.
async function toggleFullscreen() {
  const entering = !document.body.classList.contains('is-display');
  setDisplayMode(entering);
  try {
    if (entering && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    if (!entering && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* Anzeigemodus funktioniert auch ohne Vollbild. */ }
}

function setDisplayMode(active) {
  document.body.classList.toggle('is-display', active);
  $('fullscreen-button').setAttribute('aria-pressed', String(active));
  $('fullscreen-button').title = active ? 'Anzeigemodus beenden' : 'Anzeigemodus (Vollbild)';
  window.scrollTo(0, 0);
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
  toastHandle = window.setTimeout(() => toast.classList.remove('is-visible'), Math.max(3200, message.length * 55));
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
      const response = await fetch(tournamentUrl, {
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
