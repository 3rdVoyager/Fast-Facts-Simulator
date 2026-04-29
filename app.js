/*
  app.js - Fast Facts Simulator logic

  Overview:
  - Loads a local `data.json` file organized as { category: { LETTER: [words...] } }
  - Controls round lifecycle: pick category -> pick letter -> pick a canonical answer -> start timer
  - Validates user input against all words for the displayed category+letter
  - Provides progressive hints based on the canonical answer (prefix reveals)

  This file is intentionally verbose with comments and JSDoc so beginners can follow along.
*/

// ----------------------------- Helper utilities -----------------------------

/**
 * Normalize an answer string for comparison:
 * - lowercase, trim, remove punctuation, collapse spaces
 * @param {string} s
 * @returns {string}
 */
function normalize(s){
  return (s || "")
    .toLowerCase()
    .normalize('NFKD') // decompose diacritics if present
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^a-z0-9\s]/g, '') // remove punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

/**
 * Pick a random element from an array
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function rand(arr){
  return arr[Math.floor(Math.random()*arr.length)];
}

/**
 * Validate loaded category data against the app's one-letter prompt model.
 * Returns a cleaned copy plus a list of warnings for anything skipped.
 * @param {Record<string, Record<string, string[]>>} rawData
 */
function sanitizeData(rawData){
  const cleaned = {};
  const warnings = [];

  for(const [category, letters] of Object.entries(rawData || {})){
    const cleanedLetters = {};

    for(const [letterKey, values] of Object.entries(letters || {})){
      const prompt = String(letterKey || '').trim().toUpperCase();
      if(!/^[A-Z]$/.test(prompt)){
        warnings.push(`${category}: skipped key "${letterKey}" because prompts must be one letter.`);
        continue;
      }

      if(!Array.isArray(values)) {
        warnings.push(`${category} ${prompt}: skipped because the value is not a list.`);
        continue;
      }

      const seen = new Set();
      const cleanedValues = [];

      for(const value of values){
        if(typeof value !== 'string') continue;
        const trimmed = value.trim();
        if(!trimmed) continue;

        const match = trimmed.match(/[A-Za-z]/);
        if(!match || match[0].toUpperCase() !== prompt){
          warnings.push(`${category} ${prompt}: skipped "${trimmed}" because it does not start with ${prompt}.`);
          continue;
        }

        const normalized = normalize(trimmed);
        if(!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        cleanedValues.push(trimmed);
      }

      if(cleanedValues.length > 0){
        cleanedLetters[prompt] = cleanedValues;
      }
    }

    if(Object.keys(cleanedLetters).length > 0){
      cleaned[category] = cleanedLetters;
    }
  }

  return { cleaned, warnings };
}

// ----------------------------- App state -----------------------------
const state = {
  data: null, // loaded JSON data
  categories: [], // category names
  current: {
    category: null,
    letter: null,
    canonical: null, // canonical answer for hint progression
    validList: [], // all valid words for this category+letter
    hintIndex: 0, // how many characters revealed (prefix length)
    hintCap: 0, // maximum prefix length allowed by mode
    timerMs: 0, // current timer in seconds
    timerId: null, // interval id
    timeLeft: 0, // seconds remaining
    nextTimeout: null // id for scheduled auto-next after correct
  }
};

// Auto-move default delay (ms)
const AUTO_MOVE_DELAY_MS = 5000;

// ----------------------------- DOM references -----------------------------
const refs = {
  // optional native selects (kept for fallback)
  categorySelect: document.getElementById('categorySelect'),
  timerSelect: document.getElementById('timerSelect'),
  modeSelect: document.getElementById('modeSelect'),
  // primary controls
  startBtn: document.getElementById('startBtn'),
  categoryToggle: document.getElementById('categoryToggle'),
  categoryMenu: document.getElementById('categoryMenu'),
  categoryList: document.getElementById('categoryList'),
  timerToggle: document.getElementById('timerToggle'),
  timerMenu: document.getElementById('timerMenu'),
  timerList: document.getElementById('timerList'),
  modeToggle: document.getElementById('modeToggle'),
  modeMenu: document.getElementById('modeMenu'),
  modeList: document.getElementById('modeList'),
  settingsToggle: document.getElementById('settingsToggle'),
  settingsMenu: document.getElementById('settingsMenu'),
  // displays / inputs
  categoryDisplay: document.getElementById('categoryDisplay'),
  categoryDescription: document.getElementById('categoryDescription'),
  timeText: document.getElementById('timeText'),
  timePct: document.getElementById('timePct'),
  progressBar: document.getElementById('progressBar'),
  answerInput: document.getElementById('answerInput'),
  answerWrap: document.querySelector('.answer-wrap'),
  hintBtn: document.getElementById('hintBtn'),
  revealBtn: document.getElementById('revealBtn'),
  feedback: document.getElementById('feedback'),
  letterDisplay: document.getElementById('letterDisplay'),
  exampleAnswer: document.getElementById('exampleAnswer'),
  exampleArea: document.getElementById('exampleArea')
  ,
  // score panel elements
  scorePanel: document.getElementById('scorePanel'),
  currentStreak: document.getElementById('currentStreak'),
  bestStreak: document.getElementById('bestStreak'),
  totalCorrect: document.getElementById('totalCorrect'),
  roundCount: document.getElementById('roundCount'),
  resetScoreBtn: document.getElementById('resetScoreBtn'),
  toastContainer: document.getElementById('toastContainer'),
  readinessItem: document.getElementById('readinessItem'),
  readinessScore: document.getElementById('readinessScore'),
  instructionsBtn: document.getElementById('instructionsBtn'),
  instructionsModal: document.getElementById('instructionsModal'),
  instructionsCloseBtn: document.getElementById('instructionsCloseBtn'),
  instructionsDoneBtn: document.getElementById('instructionsDoneBtn')
};

// Theme toggle element (added to header)
refs.themeToggle = document.getElementById('themeToggle');
// Auto-move toggle (header)
refs.autoToggle = document.getElementById('autoToggle');

/**
 * Populate custom timer and mode dropdowns (if present).
 */
function populateControls(){
  // timers (include an explicit 'Off' option)
  const timers = ['off',10,20,30,40,50,60];
  if(refs.timerList){
    refs.timerList.innerHTML = '';
    timers.forEach((t, idx)=>{
      const li = document.createElement('li');
      if(String(t) === 'off'){
        li.textContent = 'Off';
        li.dataset.value = 'off';
      }else{
        li.textContent = `${t}s`;
        li.dataset.value = String(t);
      }
      if(t===30) li.classList.add('selected');
      refs.timerList.appendChild(li);
    });
    if(refs.timerToggle){ refs.timerToggle.dataset.value = '30'; refs.timerToggle.textContent = '30s ▾'; }
  }

  // modes
  const modes = [{v:'easy',label:'Easy'},{v:'medium',label:'Medium'},{v:'hard',label:'Hard'}];
  if(refs.modeList){
    refs.modeList.innerHTML = '';
    modes.forEach((m, idx)=>{
      const li = document.createElement('li');
      li.textContent = m.label;
      li.dataset.value = m.v;
      if(m.v==='easy') li.classList.add('selected');
      refs.modeList.appendChild(li);
    });
    if(refs.modeToggle){ refs.modeToggle.dataset.value = 'easy'; refs.modeToggle.textContent = 'Mode: Easy'; }
  }
}

  /**
   * Save current filter settings (category, timer, mode) to localStorage.
   */
  function saveFiltersToStorage(){
    try{
      const obj = {
        category: (refs.categorySelect && refs.categorySelect.value) ? refs.categorySelect.value : (refs.categoryToggle && refs.categoryToggle.dataset.value) ? refs.categoryToggle.dataset.value : '__random__',
        timer: (refs.timerSelect && refs.timerSelect.value) ? refs.timerSelect.value : (refs.timerToggle && refs.timerToggle.dataset.value) ? refs.timerToggle.dataset.value : '30',
        mode: (refs.modeSelect && refs.modeSelect.value) ? refs.modeSelect.value : (refs.modeToggle && refs.modeToggle.dataset.value) ? refs.modeToggle.dataset.value : 'easy',
        autoMove: (refs.autoToggle && (refs.autoToggle.dataset.value === 'true' || refs.autoToggle.getAttribute('aria-pressed') === 'true')) ? true : false
      };
      localStorage.setItem('fastfacts_filters', JSON.stringify(obj));
    }catch(err){
      // ignore storage errors
      console.warn('Could not save filters', err);
    }
  }

  /**
   * Load saved filter settings from localStorage and apply to controls.
   */
  function loadFiltersFromStorage(){
    try{
      const raw = localStorage.getItem('fastfacts_filters');
      if(!raw) return;
      const obj = JSON.parse(raw || '{}');
      // category
      if(obj.category){
        if(refs.categorySelect){
          const opt = Array.from(refs.categorySelect.options).find(o=>o.value===obj.category);
          if(opt) refs.categorySelect.value = obj.category;
        }
        if(refs.categoryToggle){
          const val = (obj.category === '__random__' || state.categories.includes(obj.category)) ? obj.category : '__random__';
          refs.categoryToggle.dataset.value = val;
          refs.categoryToggle.textContent = (val === '__random__') ? 'Category: Random ▾' : ('Category: ' + val + ' ▾');
          if(refs.categoryList){
            Array.from(refs.categoryList.children).forEach(li=> li.classList.toggle('selected', li.dataset.value === val));
          }
        }
      }
      // timer
      if(obj.timer){
        if(refs.timerSelect){ refs.timerSelect.value = obj.timer; }
        if(refs.timerToggle){ refs.timerToggle.dataset.value = obj.timer; refs.timerToggle.textContent = (obj.timer === 'off') ? 'Timer: Off ▾' : `Timer: ${obj.timer}s ▾`; }
        if(refs.timerList){ Array.from(refs.timerList.children).forEach(li=> li.classList.toggle('selected', li.dataset.value === String(obj.timer))); }
      }
      // mode
      if(obj.mode){
        if(refs.modeSelect){ refs.modeSelect.value = obj.mode; }
        if(refs.modeToggle){ refs.modeToggle.dataset.value = obj.mode; refs.modeToggle.textContent = `Mode: ${obj.mode.charAt(0).toUpperCase()+obj.mode.slice(1)}`; }
        if(refs.modeList){ Array.from(refs.modeList.children).forEach(li=> li.classList.toggle('selected', li.dataset.value === obj.mode)); }
      }
      // autoMove
      if(typeof obj.autoMove !== 'undefined' && refs.autoToggle){
        const on = !!obj.autoMove;
        refs.autoToggle.dataset.value = on ? 'true' : 'false';
        refs.autoToggle.setAttribute('aria-pressed', String(on));
        refs.autoToggle.textContent = on ? 'Auto Move: On' : 'Auto Move: Off';
      }
    }catch(err){ console.warn('Could not load filters', err); }
  }

// ----------------------------- Data loading -----------------------------
/**
 * Load the local data.json and build a categories list.
 */
async function loadData(){
  try{
    const res = await fetch('./data.json');
    if(!res.ok) throw new Error('Could not load data.json: '+res.status);
    const rawData = await res.json();
    const { cleaned, warnings } = sanitizeData(rawData);
    state.data = cleaned;
    state.categories = Object.keys(cleaned).filter(cat => {
      // ensure category has at least one letter with a non-empty list
      const letters = Object.keys(cleaned[cat] || {});
      return letters.some(L => Array.isArray(cleaned[cat][L]) && cleaned[cat][L].length>0);
    }).sort();
    if(warnings.length){
      console.warn('data.json warnings:\n' + warnings.join('\n'));
    }
    populateCategorySelect();
    // populate timer/mode controls (if present)
    populateControls();
    // load category descriptions from data.json (optional)
    window.CATEGORY_DESCRIPTIONS = rawData.CategoryDescriptions || {};
    // apply persisted filters (if any) before starting
    loadFiltersFromStorage();
    // load persisted score/streak state
    loadScoreFromStorage();
    updateScoreUI();
    // ensure the example area is visible by default (content will be empty during rounds)
    if(refs.exampleArea && refs.exampleArea.classList){ refs.exampleArea.classList.remove('hidden'); }
    // start the first round immediately after data loads
    if(state.categories && state.categories.length>0) nextRound();
  }catch(err){
    console.error(err);
    refs.feedback.textContent = 'Failed to load data.json — see console for details.';
  }
}

/**
 * Update the visible category description for the current category.
 * If no description exists, show a short placeholder hint.
 */
function updateCategoryDescription(category){
  if(!refs.categoryDescription) return;
  const desc = (window.CATEGORY_DESCRIPTIONS && window.CATEGORY_DESCRIPTIONS[category]) || '';
  refs.categoryDescription.textContent = desc || 'Try to think of common things in this area; type them to answer.';
}

// ----------------------------- Score / Streaks -----------------------------
// persisted under `fastfacts_score` in localStorage
function defaultScore(){ return { currentStreak:0, bestStreak:0, totalCorrect:0, rounds:0 }; }
function loadScoreFromStorage(){
  try{
    const raw = localStorage.getItem('fastfacts_score');
    state.score = raw ? JSON.parse(raw) : defaultScore();
  }catch(e){ state.score = defaultScore(); }
}
function saveScoreToStorage(){
  try{ localStorage.setItem('fastfacts_score', JSON.stringify(state.score)); }catch(e){}
}
function updateScoreUI(){
  if(!refs.scorePanel) return;
  refs.currentStreak.textContent = state.score.currentStreak || 0;
  refs.bestStreak.textContent = state.score.bestStreak || 0;
  refs.totalCorrect.textContent = state.score.totalCorrect || 0;
  refs.roundCount.textContent = state.score.rounds || 0;
  // readiness only visible in hard mode
  const mode = (refs.modeSelect && refs.modeSelect.value) ? refs.modeSelect.value : (refs.modeToggle && refs.modeToggle.dataset.value) ? refs.modeToggle.dataset.value : 'easy';
  if(mode === 'hard'){
    if(refs.readinessItem) refs.readinessItem.style.display = '';
    const r = computeReadiness();
    if(refs.readinessScore) refs.readinessScore.textContent = r;
    if(refs.readinessItem){
      refs.readinessItem.classList.remove('readiness-low','readiness-mid','readiness-high');
      if(r < 40) refs.readinessItem.classList.add('readiness-low');
      else if(r < 70) refs.readinessItem.classList.add('readiness-mid');
      else refs.readinessItem.classList.add('readiness-high');
    }
  }else{
    if(refs.readinessItem) refs.readinessItem.style.display = 'none';
  }
}

function finalizeRound(result){
  // result: 'correct' or 'revealed' (or other)
  state.score.rounds = (state.score.rounds || 0) + 1;
  const prevStreak = state.score.currentStreak || 0;
  const prevBest = state.score.bestStreak || 0;
  if(result === 'correct'){
    state.score.totalCorrect = (state.score.totalCorrect || 0) + 1;
    state.score.currentStreak = prevStreak + 1;
    if(prevBest < state.score.currentStreak){
      state.score.bestStreak = state.score.currentStreak;
      // show toast for new best
      showToast(`New best streak: ${state.score.bestStreak}`,'success');
    }else{
      // show toast for streak increase
      if(state.score.currentStreak > prevStreak) showToast(`Streak: ${state.score.currentStreak}`,'success');
    }
  }else{
    // non-correct round resets streak
    if(prevStreak > 0) showToast(`Streak ended at ${prevStreak}`);
    state.score.currentStreak = 0;
  }
  saveScoreToStorage();
  updateScoreUI();
}

/**
 * Compute a simple readiness score [1..100] from stored metrics.
 * Formula (simple heuristic):
 * - accuracy = totalCorrect / rounds (0..1)
 * - streakFactor = min(bestStreak,10)/10 (0..1)
 * readiness = clamp(round((0.75*accuracy + 0.25*streakFactor)*100), 1, 100)
 */
function computeReadiness(){
  const s = state.score || {};
  const rounds = s.rounds || 0;
  const accuracy = rounds > 0 ? ((s.totalCorrect || 0)/rounds) : 0;
  const streakFactor = Math.min((s.bestStreak || 0),10)/10;
  let val = Math.round((0.75*accuracy + 0.25*streakFactor)*100);
  // when there have been no rounds yet, readiness is 0
  if(rounds === 0) val = 0;
  if(val < 0) val = 0;
  if(val > 100) val = 100;
  return val;
}

function resetScore(){
  state.score = defaultScore();
  saveScoreToStorage();
  updateScoreUI();
}

function showToast(text, type){
  if(!refs.toastContainer) return;
  const div = document.createElement('div');
  div.className = 'toast' + (type ? ' '+type : '');
  div.textContent = text;
  refs.toastContainer.appendChild(div);
  // allow CSS transition
  requestAnimationFrame(()=>{ div.classList.add('show'); });
  // remove after 3s
  setTimeout(()=>{
    div.classList.remove('show');
    setTimeout(()=>{ try{ refs.toastContainer.removeChild(div); }catch(e){} }, 240);
  }, 3000);
}

/**
 * Populate the category select dropdown with the loaded categories.
 */
function populateCategorySelect(){
  // If native select exists (fallback), populate it. Otherwise populate custom dropdown list.
  if(refs.categorySelect){
    while(refs.categorySelect.options.length>1) refs.categorySelect.remove(1);
    state.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      refs.categorySelect.appendChild(opt);
    });
    return;
  }

  // populate custom dropdown list
  if(refs.categoryList){
    refs.categoryList.innerHTML = '';
    // add Random Category as first option
    const items = ['Random Category', ...state.categories];
    items.forEach((cat, idx) => {
      const li = document.createElement('li');
      li.textContent = cat;
      li.dataset.value = (idx===0) ? '__random__' : cat;
      if(idx===0) li.classList.add('selected');
      refs.categoryList.appendChild(li);
    });
  }
}

// ----------------------------- Round lifecycle -----------------------------
/**
 * Start the next round. Picks category, letter, canonical answer, resets UI, and starts timer.
 */
function nextRound(){
  stopTimer();
  clearFeedback();
  hideExample();

  // Ensure action buttons are in their normal state when starting a new round
  restoreActionButtons();

  // decide category: user-chosen or random
  // determine chosen category from either native select or custom dropdown toggle
  let chosen;
  if(refs.categorySelect){
    chosen = refs.categorySelect.value;
  }else if(refs.categoryToggle){
    chosen = refs.categoryToggle.dataset.value || '__random__';
  }
  let category = chosen === '__random__' ? rand(state.categories) : chosen;
  state.current.category = category;
  refs.categoryDisplay.textContent = category || '—';

  // pick a random letter from category that has words
  const letters = Object.keys(state.data[category] || {}).filter(L=> state.data[category][L].length>0);
  const letter = rand(letters);
  state.current.letter = letter;
  refs.letterDisplay.textContent = letter;

  // valid words for this category+letter
  const valid = (state.data[category][letter] || []).slice();
  state.current.validList = valid;

  // pick a canonical answer for hint progression (random choice)
  const canonical = rand(valid);
  state.current.canonical = canonical;
  state.current.hintIndex = 0;

  // establish hint cap depending on mode (support native select or custom toggle)
  const mode = (refs.modeSelect && refs.modeSelect.value) ? refs.modeSelect.value : (refs.modeToggle && refs.modeToggle.dataset.value) ? refs.modeToggle.dataset.value : 'easy';
  const fullLen = String(canonical).length;
  if(mode === 'easy') state.current.hintCap = fullLen;
  else if(mode === 'medium') state.current.hintCap = Math.floor(fullLen/2); // allow hints up to half the word (rounded down)
  else state.current.hintCap = 0; // hard: no hints

  // timer setup (support native select or custom toggle)
  const rawTimerVal = (refs.timerSelect && refs.timerSelect.value) ? refs.timerSelect.value : (refs.timerToggle && refs.timerToggle.dataset.value) ? refs.timerToggle.dataset.value : '30';
  if(rawTimerVal === 'off' || rawTimerVal === '0'){
    state.current.timerMs = 0; // timer disabled
    state.current.timeLeft = 0;
  }else{
    const t = Number(rawTimerVal) || 30;
    state.current.timerMs = t;
    state.current.timeLeft = t;
  }

  // reset UI elements
  refs.answerInput.value = '';
  refs.answerInput.disabled = false;
  refs.hintBtn.disabled = (state.current.hintCap<=0);
  refs.hintBtn.textContent = 'Hint';
  refs.revealBtn.disabled = false;
  hideExample();

  // update category description when a round starts
  updateCategoryDescription(category);

  renderTimer();
  startTimer();
  refs.answerInput.focus();
}

// ----------------------------- Timer -----------------------------
function startTimer(){
  stopTimer();
  // do not start when timer is disabled/off
  if(!state.current.timerMs || state.current.timerMs <= 0) return;
  state.current.timerId = setInterval(()=>{
    state.current.timeLeft -= 1;
    if(state.current.timeLeft <= 0){
      state.current.timeLeft = 0;
      renderTimer();
      stopTimer();
      // handle timeout: disable input and show a Next Round button in place of Hint/Reveal
      handleTimeout();
      return;
    }
    renderTimer();
  }, 1000);
}

function stopTimer(){
  if(state.current.timerId){
    clearInterval(state.current.timerId);
    state.current.timerId = null;
  }
}

function renderTimer(){
  const left = state.current.timeLeft;
  const total = state.current.timerMs || 0;
  if(!total || total <= 0){
    refs.timeText.textContent = `Timer: Off`;
    refs.timePct.textContent = `0%`;
    refs.progressBar.style.width = `0%`;
    return;
  }
  refs.timeText.textContent = `Time Remaining: ${left}s`;
  const pct = Math.round((left/total)*100);
  refs.timePct.textContent = `${pct}%`;
  refs.progressBar.style.width = `${pct}%`;
}

// ----------------------------- Hint & Reveal -----------------------------
/**
 * Reveal the next prefix of the canonical answer, up to the limit (hintCap).
 */
function giveHint(){
  const canonical = state.current.canonical || '';
  if(!canonical) return;
  // if no hints allowed
  if(state.current.hintCap <= 0) return;

  // increment hint index, but do not exceed cap or full length
  state.current.hintIndex = Math.min(state.current.hintIndex + 1, state.current.hintCap, canonical.length);
  const prefix = canonical.slice(0, state.current.hintIndex);
  refs.answerInput.value = prefix; // optionally pre-fill input with hint prefix
  refs.hintBtn.textContent = `Hint (${state.current.hintIndex}/${state.current.hintCap})`;

  // disable hint if we've reached cap
  if(state.current.hintIndex >= state.current.hintCap) refs.hintBtn.disabled = true;
}

/**
 * Reveal full canonical answer and show a few accepted examples from the valid list.
 * Stops the round.
 */
function revealAnswer(reason){
  stopTimer();
  refs.answerInput.disabled = true;
  refs.hintBtn.disabled = true;
  refs.revealBtn.disabled = true;

  const canonical = state.current.canonical || '';
  // show canonical and some others
  const others = state.current.validList.filter(w => w !== canonical).slice(0,3);
  const display = [canonical].concat(others).join(' — ');
  showExample(display || '—');
  // finalize scoring for revealed/give-up/timeout rounds
  try{ finalizeRound('revealed'); }catch(e){}
  // transform hint -> Next Round so the user can advance after revealing
  transformButtonsToNext();
  if(refs.autoToggle && (refs.autoToggle.dataset.value === 'true' || refs.autoToggle.getAttribute('aria-pressed') === 'true')){
    startAutoCountdown(AUTO_MOVE_DELAY_MS);
  }
}

/**
 * Show the example area with the provided text.
 * @param {string} text
 */
function showExample(text){
  if(!refs.exampleArea) return;
  refs.exampleAnswer.textContent = text || '—';
}

/**
 * Hide the example area and clear its content.
 */
function hideExample(){
  if(!refs.exampleArea) return;
  refs.exampleAnswer.textContent = '';
}

/**
 * Handle when the timer reaches zero: disable typing and replace Hint/Reveal
 * with a Next Round button (no automatic reveal or 'time expired' message).
 */
function handleTimeout(){
  // When time expires, reveal the canonical answer and show examples,
  // then transform the Hint/Reveal buttons to the Next Round state.
  revealAnswer('Time expired');
}

/**
 * Ensure a visible Next Round button exists in the actions area and wire its click.
 * Used after correct answers or timeout; does NOT auto-start a round.
 */
function transformButtonsToNext(){
  if(refs.hintBtn){
    refs.hintBtn.dataset.mode = 'next';
    refs.hintBtn.textContent = 'Next Round';
    refs.hintBtn.disabled = false;
    refs.hintBtn.classList.add('next-mode');
  }
  if(refs.revealBtn) refs.revealBtn.style.display = 'none';
}

function revertButtonsFromNext(){
  if(!refs.hintBtn) return;
  delete refs.hintBtn.dataset.mode;
  refs.hintBtn.textContent = 'Hint';
  refs.hintBtn.classList.remove('next-mode');
  if(refs.revealBtn) refs.revealBtn.style.display = 'inline-block';
  refs.hintBtn.disabled = (state.current.hintCap<=0);
}

/**
 * Restore the Hint/Reveal buttons (remove Next Round button if present).
 */
function restoreActionButtons(){
  // cancel any pending auto-advance and revert transforms
  clearNextTimeout();
  // revert any Next-mode transforms
  revertButtonsFromNext();
  if(refs.hintBtn){ refs.hintBtn.style.display = 'inline-block'; refs.hintBtn.disabled = (state.current.hintCap<=0); }
  if(refs.revealBtn){ refs.revealBtn.style.display = 'inline-block'; refs.revealBtn.disabled = false; }
  // remove correct styling on the input when restoring actions
  if(refs.answerInput && refs.answerInput.classList){ refs.answerInput.classList.remove('correct'); }
  if(refs.answerWrap && refs.answerWrap.classList){ refs.answerWrap.classList.remove('correct'); }
}

// ----------------------------- Validation -----------------------------
/**
 * Validate user input. Normalizes and compares against the full valid list for current category+letter.
 * If correct, mark success and stop round.
 */
function submitAnswer(){
  const raw = refs.answerInput.value || '';
  const normalized = normalize(raw);
  if(!normalized) return;

  const valid = state.current.validList || [];
  const normMap = new Map(valid.map(w => [normalize(w), w]));

  if(normMap.has(normalized)){
    // correct
    const canonicalMatched = normMap.get(normalized);
    // handle correct match: show feedback, stop round, and schedule next round
    handleCorrectMatch(canonicalMatched, 'Correct');
  }else{
    // incorrect — silently allow retry (no feedback)
    clearFeedback();
  }
}

/**
 * Handle a correct match: stop timer, display success, disable inputs, and
 * schedule an automatic Next Round after a short delay so the user sees feedback.
 * @param {string} matched - the canonical matched answer
 * @param {string} [reason] - optional short reason text to display
 */
function handleCorrectMatch(matched, reason){
  // ensure any timeout Next Round button is removed
  restoreActionButtons();
  stopTimer();
  clearNextTimeout();
  // Do not show a textual notice on correct answers; only reveal the example area.
  showExample(matched);
  refs.answerInput.disabled = true;
  // mark input visually as correct
  if(refs.answerInput && refs.answerInput.classList){ refs.answerInput.classList.add('correct'); }
  if(refs.answerWrap && refs.answerWrap.classList){ refs.answerWrap.classList.add('correct'); }
  refs.hintBtn.disabled = true;
  refs.revealBtn.disabled = true;

  // transform the hint button into Next Round and wait for user action
  transformButtonsToNext();
  // finalize scoring for this round
  try{ finalizeRound('correct'); }catch(e){}
  // if auto-move is enabled, schedule a short automatic advance with countdown
  if(refs.autoToggle && (refs.autoToggle.dataset.value === 'true' || refs.autoToggle.getAttribute('aria-pressed') === 'true')){
    startAutoCountdown(AUTO_MOVE_DELAY_MS);
  }

  // add a brief pulse to emphasize the correct input
  if(refs.answerInput && refs.answerInput.classList){
    refs.answerInput.classList.add('pulse');
    setTimeout(()=>{ try{ refs.answerInput.classList.remove('pulse'); }catch(e){} }, 1000);
  }
}

function clearNextTimeout(){
  if(state.current.nextTimeout){
    clearTimeout(state.current.nextTimeout);
    state.current.nextTimeout = null;
  }
  if(state.current.nextCountdownInterval){
    clearInterval(state.current.nextCountdownInterval);
    state.current.nextCountdownInterval = null;
  }
}


/**
 * Start the auto-move countdown and update the Hint/Next button label.
 * @param {number} ms - milliseconds until auto-advance
 */
function startAutoCountdown(ms){
  clearNextTimeout();
  if(!refs.hintBtn) return;
  const end = Date.now() + ms;
  // schedule the actual advance
  state.current.nextTimeout = setTimeout(()=>{
    state.current.nextTimeout = null;
    clearNextTimeout();
    restoreActionButtons();
    nextRound();
  }, ms);
  // update label frequently to show seconds remaining
  state.current.nextCountdownInterval = setInterval(()=>{
    const remaining = Math.max(0, end - Date.now());
    const sec = Math.ceil(remaining/1000);
    if(refs.hintBtn){ refs.hintBtn.textContent = `Next Round (${sec}s)`; }
    if(remaining <= 0){
      clearInterval(state.current.nextCountdownInterval);
      state.current.nextCountdownInterval = null;
    }
  }, 150);
}

function clearFeedback(){
  refs.feedback.textContent = '';
  refs.feedback.style.color = 'inherit';
}

// ----------------------------- Event wiring -----------------------------
if(refs.startBtn){
  refs.startBtn.addEventListener('click', ()=>{
    nextRound();
  });
}

refs.hintBtn.addEventListener('click', ()=>{
  // If hint button is in 'next' mode, start next round instead of giving a hint
  if(refs.hintBtn.dataset && refs.hintBtn.dataset.mode === 'next'){
    // cancel pending auto-advance, revert buttons then start next
    clearNextTimeout();
    restoreActionButtons();
    nextRound();
    return;
  }
  giveHint();
});

// Auto-move toggle wiring
if(refs.autoToggle){
  refs.autoToggle.addEventListener('click', ()=>{
    const cur = refs.autoToggle.dataset && refs.autoToggle.dataset.value === 'true';
    const next = !cur;
    refs.autoToggle.dataset.value = next ? 'true' : 'false';
    refs.autoToggle.setAttribute('aria-pressed', String(next));
    refs.autoToggle.textContent = next ? 'Auto Move: On' : 'Auto Move: Off';
    saveFiltersToStorage();
  });
}

// Reset score button wiring
if(refs.resetScoreBtn){
  refs.resetScoreBtn.addEventListener('click', ()=>{
    if(!confirm('Reset saved scores and streaks?')) return;
    resetScore();
  });
}

// Instructions modal wiring
if(refs.instructionsBtn && refs.instructionsModal){
  const openInstructions = ()=>{
    refs.instructionsModal.classList.remove('hidden');
    // focus the close button for accessibility
    if(refs.instructionsCloseBtn) refs.instructionsCloseBtn.focus();
  };
  const closeInstructions = ()=>{
    refs.instructionsModal.classList.add('hidden');
    if(refs.instructionsBtn) refs.instructionsBtn.focus();
  };

  refs.instructionsBtn.addEventListener('click', openInstructions);
  if(refs.instructionsCloseBtn) refs.instructionsCloseBtn.addEventListener('click', closeInstructions);
  if(refs.instructionsDoneBtn) refs.instructionsDoneBtn.addEventListener('click', closeInstructions);
  // clicking the backdrop closes
  const backdrop = refs.instructionsModal.querySelector('[data-backdrop]');
  if(backdrop) backdrop.addEventListener('click', closeInstructions);
  // ESC key closes modal
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && !refs.instructionsModal.classList.contains('hidden')){
      closeInstructions();
    }
  });
}

refs.revealBtn.addEventListener('click', ()=>{
  revealAnswer('User revealed answer');
});

refs.answerInput.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){
    e.preventDefault();
    // If the hint button is currently acting as Next Round, advance instead of submitting
    if(refs.hintBtn && refs.hintBtn.dataset && refs.hintBtn.dataset.mode === 'next'){
      clearNextTimeout();
      restoreActionButtons();
      nextRound();
      return;
    }
    submitAnswer();
  }
});

// Support pressing Enter to advance when the input is disabled (Next Round state).
// Disabled inputs do not receive key events, so listen on the document and
// only act when the hint button is in 'next' mode.
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter') return;
  if(!(refs.hintBtn && refs.hintBtn.dataset && refs.hintBtn.dataset.mode === 'next')) return;
  e.preventDefault();
  clearNextTimeout();
  restoreActionButtons();
  nextRound();
});

// Live validation: validate as the user types and auto-advance when a match is found.
refs.answerInput.addEventListener('input', ()=>{
  const raw = refs.answerInput.value || '';
  const normalized = normalize(raw);
  if(!normalized) {
    // clear subtle feedback while typing
    // (do not show 'incorrect' on partial input)
    // clearFeedback();
    return;
  }

  const valid = state.current.validList || [];
  const normMap = new Map(valid.map(w => [normalize(w), w]));
  if(normMap.has(normalized)){
    // immediate acceptance when a valid word is typed
    const matched = normMap.get(normalized);
    handleCorrectMatch(matched, 'Correct');
  }
});

// Global keyboard shortcuts removed — only Enter is supported (handled on the answer input).

// Theme toggle wiring: toggle light mode class on body and update icon
if(refs.themeToggle){
  // use onclick assignment so the handler is single and robust
  refs.themeToggle.onclick = function(){
    const isLight = document.body.classList.toggle('light-mode');
    refs.themeToggle.textContent = isLight ? 'Light Mode ☀️' : 'Dark Mode 🌙';
    refs.themeToggle.setAttribute('aria-pressed', String(isLight));
  };
}

// --- Custom dropdown interactions (if present) ---
if(refs.categoryToggle && refs.categoryMenu && refs.categoryList){
  // open/close toggle
  refs.categoryToggle.addEventListener('click', (e)=>{
    const open = refs.categoryMenu.getAttribute('aria-hidden') === 'false';
    refs.categoryMenu.setAttribute('aria-hidden', String(open));
    refs.categoryMenu.style.display = open ? 'none' : 'block';
    refs.categoryToggle.setAttribute('aria-expanded', String(!open));
  });

  // item click
  refs.categoryList.addEventListener('click', (e)=>{
    const li = e.target.closest('li');
    if(!li) return;
    // mark selection
    Array.from(refs.categoryList.children).forEach(c=>c.classList.remove('selected'));
    li.classList.add('selected');
    const val = li.dataset.value || '__random__';
    refs.categoryToggle.dataset.value = val;
    refs.categoryToggle.textContent = (val === '__random__') ? 'Category: Random ▾' : ('Category: ' + li.textContent + ' ▾');
    // keep menu open (do not close on selection)
    // persist and start a new round when the category filter is changed
    saveFiltersToStorage();
    nextRound();
  });

  // close on outside click
  document.addEventListener('click', (e)=>{
    // close any open custom dropdowns when clicking outside
    if(refs.categoryMenu && !(refs.categoryMenu.contains(e.target) || (refs.categoryToggle && refs.categoryToggle.contains(e.target)))){
      refs.categoryMenu.setAttribute('aria-hidden', 'true');
      refs.categoryMenu.style.display = 'none';
      refs.categoryToggle.setAttribute('aria-expanded', 'false');
    }
    if(refs.timerMenu && !(refs.timerMenu.contains(e.target) || (refs.timerToggle && refs.timerToggle.contains(e.target)))){
      refs.timerMenu.setAttribute('aria-hidden', 'true');
      refs.timerMenu.style.display = 'none';
      refs.timerToggle.setAttribute('aria-expanded', 'false');
    }
    if(refs.modeMenu && !(refs.modeMenu.contains(e.target) || (refs.modeToggle && refs.modeToggle.contains(e.target)))){
      refs.modeMenu.setAttribute('aria-hidden', 'true');
      refs.modeMenu.style.display = 'none';
      refs.modeToggle.setAttribute('aria-expanded', 'false');
    }
    if(refs.settingsMenu && !(refs.settingsMenu.contains(e.target) || (refs.settingsToggle && refs.settingsToggle.contains(e.target)))){
      refs.settingsMenu.setAttribute('aria-hidden', 'true');
      refs.settingsMenu.style.display = 'none';
      if(refs.settingsToggle) refs.settingsToggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// Timer dropdown interactions
if(refs.timerToggle && refs.timerMenu && refs.timerList){
  refs.timerToggle.addEventListener('click', ()=>{
    const open = refs.timerMenu.getAttribute('aria-hidden') === 'false';
    refs.timerMenu.setAttribute('aria-hidden', String(open));
    refs.timerMenu.style.display = open ? 'none' : 'block';
    refs.timerToggle.setAttribute('aria-expanded', String(!open));
  });
  refs.timerList.addEventListener('click', (e)=>{
    const li = e.target.closest('li'); if(!li) return;
    Array.from(refs.timerList.children).forEach(c=>c.classList.remove('selected'));
    li.classList.add('selected');
    const val = li.dataset.value || '30';
    refs.timerToggle.dataset.value = val;
    if(val === 'off') refs.timerToggle.textContent = `Timer: Off ▾`;
    else refs.timerToggle.textContent = `Timer: ${val}s ▾`;
    // keep menu open (do not close on selection)
    // persist and start a new round when timer filter is changed
    saveFiltersToStorage();
    nextRound();
  });
}

// Settings dropdown interactions
if(refs.settingsToggle && refs.settingsMenu){
  refs.settingsToggle.addEventListener('click', ()=>{
    const open = refs.settingsMenu.getAttribute('aria-hidden') === 'false';
    refs.settingsMenu.setAttribute('aria-hidden', String(open));
    refs.settingsMenu.style.display = open ? 'none' : 'block';
    refs.settingsToggle.setAttribute('aria-expanded', String(!open));
  });
}

// Mode control: either a custom dropdown (modeList present) or a cycling button inside Settings
if(refs.modeToggle && refs.modeMenu && refs.modeList){
  refs.modeToggle.addEventListener('click', ()=>{
    const open = refs.modeMenu.getAttribute('aria-hidden') === 'false';
    refs.modeMenu.setAttribute('aria-hidden', String(open));
    refs.modeMenu.style.display = open ? 'none' : 'block';
    refs.modeToggle.setAttribute('aria-expanded', String(!open));
  });
  refs.modeList.addEventListener('click', (e)=>{
    const li = e.target.closest('li'); if(!li) return;
    Array.from(refs.modeList.children).forEach(c=>c.classList.remove('selected'));
    li.classList.add('selected');
    const val = li.dataset.value || 'easy';
    refs.modeToggle.dataset.value = val;
    refs.modeToggle.textContent = `Mode: ${li.textContent} ▾`;
    // persist and start a new round when mode filter is changed
    // When changing modes, reset saved sessions/scores
    saveFiltersToStorage();
    resetScore();
    showToast(`Switched mode to ${li.textContent}; scores reset`);
    nextRound();
  });
} else if(refs.modeToggle && !refs.modeList){
  // cycling button inside Settings
  const _modes = ['easy','medium','hard'];
  const setModeUI = (m)=>{
    refs.modeToggle.dataset.value = m;
    refs.modeToggle.textContent = `Mode: ${m.charAt(0).toUpperCase()+m.slice(1)}`;
  };
  // ensure a default
  if(!refs.modeToggle.dataset || !refs.modeToggle.dataset.value) setModeUI('easy');
  refs.modeToggle.addEventListener('click', ()=>{
    const cur = refs.modeToggle.dataset.value || 'easy';
    const idx = _modes.indexOf(cur);
    const next = _modes[(idx+1)%_modes.length];
    setModeUI(next);
    // persist and reset scores/sessions when mode changes
    saveFiltersToStorage();
    resetScore();
    showToast(`Switched mode to ${next.charAt(0).toUpperCase()+next.slice(1)}; scores reset`);
    nextRound();
  });
}

// Native select fallbacks: start next round when a native select changes
if(refs.categorySelect){
  refs.categorySelect.addEventListener('change', ()=>{ saveFiltersToStorage(); nextRound(); });
}
if(refs.timerSelect){
  refs.timerSelect.addEventListener('change', ()=>{ saveFiltersToStorage(); nextRound(); });
}
if(refs.modeSelect){
  refs.modeSelect.addEventListener('change', ()=>{ saveFiltersToStorage(); resetScore(); showToast('Mode changed; scores reset'); nextRound(); });
}

// initial load
loadData();

// Expose some helpers to the window for debugging in browser console
window.FastFacts = { state, nextRound, giveHint, revealAnswer, submitAnswer };
