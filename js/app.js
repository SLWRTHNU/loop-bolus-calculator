import { storage, MEAL_SLUGS, MEAL_LABELS, getMealSettings, setMealSettings, getTodayLog, appendToLog, setTodayLog } from './storage.js';
import { calcBolus, calcNetCarbs, calcWeightFromCarbs, calcCompositeCF, formatBG, mgdlToMmol, mmolToMgdl } from './calculator.js';
import { HEALTH_CANADA_FOODS } from './fooddata.js';
import { startOAuth, handleOAuthCallback, isConnected, disconnect, getAccessToken } from './auth.js';
import { setupDriveFolders, loadConfig, saveConfig, getSheetUrl } from './drive.js';
import { readFoodChart, exportLogToSheet } from './sheets.js';
import { fetchBG as nsBG, fetchIOB as nsIOB, fetchCOB as nsCOB, fetchProfile as nsProfile } from './nightscout.js';
import { fetchBG as dexBG } from './dexcom.js';
import {
  showToast, applyTheme, applyColorTheme, applyMode, initTheme,
  navigate, getCurrentSection, debounce,
  createFoodDropdown, positionDropdown,
  showSpinner, hideSpinner, updateConnectedStatus,
  formatTime, todayStr, elapsedMMSS,
  toggleToolsDropdown, openRecipePanel, closeRecipePanel
} from './ui.js';

// ─── STATE ───────────────────────────────────────────────────────────────────

let state = {
  activeMeal: 'breakfast',
  meals: {},
  personalFoods: [],
  config: null,
  units: 'mmol',
  bolusLockedAt: {},
  mealLockedAt: {},
  bolusTimerID: null,
  entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '', absorptionRate: 3.0 },
  recipes: [],
  activeRecipeIndex: 0
};

MEAL_SLUGS.forEach(slug => {
  state.meals[slug] = {
    foods: [], currentBG: '', iob: '', cob: '',
    postBgReadings: [], notes: '', bgTimestamp: null, bgTrend: null
  };
  state.bolusLockedAt[slug] = null;
  state.mealLockedAt[slug]  = null;
});

state.recipes.push(createRecipe());

function createRecipe(name = '') {
  return { name, ingredients: [], entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '' } };
}

// ─── INIT ────────────────────────────────────────────────────────────────────

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
  initTheme();
  state.units = storage.get('units', 'mmol');

  const params = new URLSearchParams(window.location.search);
  if (params.has('code')) {
    try {
      await handleOAuthCallback(params.get('code'), params.get('state'));
      window.history.replaceState({}, '', window.location.pathname);
      showToast('Google account connected!', 'success');
      await postAuthSetup();
    } catch (err) { showToast('OAuth failed: ' + err.message, 'error'); }
  } else if (isConnected()) {
    await postAuthSetup(true);
  }

  renderAll();
  setupNavigation();
  setupTimingCard();
  setupFoodEntryRow();
  setupToolsMenu();
  setupRecipePanel();
  setupPostMealTracker();
  setupExportTimer();
  navigate(getCurrentSection());
}

async function postAuthSetup(silent = false) {
  try {
    if (!storage.get('drive_folder_id')) {
      if (!silent) showToast('Setting up Drive folders…', 'info');
      await setupDriveFolders();
    }
    const config = await loadConfig();
    if (config) { state.config = config; applyConfig(config); if (!silent) showToast('Settings restored from Drive', 'success'); }
    state.personalFoods = await readFoodChart();
    updateConnectedStatus(storage.get('google_email', ''));
    renderSettingsSection();
  } catch (err) { showToast('Drive setup error: ' + err.message, 'error'); }
}

function applyConfig(config) {
  if (config.units)       { state.units = config.units; storage.set('units', config.units); }
  if (config.color_theme) applyColorTheme(config.color_theme);
  if (config.mode)        applyMode(config.mode);
  if (config.theme && !config.mode && !config.color_theme) applyTheme(config.theme);
  if (config.nightscout_url) storage.set('ns_config',    { url: config.nightscout_url, secret: config.nightscout_secret });
  if (config.dexcom_user)    storage.set('dexcom_config', { user: config.dexcom_user,  pass: config.dexcom_pass, region: config.dexcom_region });
  if (config.meals) MEAL_SLUGS.forEach(slug => { if (config.meals[slug]) setMealSettings(slug, config.meals[slug]); });
}

// ─── SOURCE AUTO-DETECT ──────────────────────────────────────────────────────

function inferBGSource() {
  const dex = storage.get('dexcom_config'); if (dex?.user) return 'dexcom';
  const ns  = storage.get('ns_config');    if (ns?.url)   return 'nightscout';
  return 'manual';
}
function inferIOBSource() { const ns = storage.get('ns_config'); return ns?.url ? 'nightscout' : 'manual'; }
function inferCOBSource() { const ns = storage.get('ns_config'); return ns?.url ? 'nightscout' : 'manual'; }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getCurrentMeal()         { return state.meals[state.activeMeal]; }
function getCurrentMealSettings() { return getMealSettings(state.activeMeal); }

function setVal(id, value)  { const el = document.getElementById(id); if (el) el.value = value ?? ''; }
function setText(id, text)  { const el = document.getElementById(id); if (el) el.textContent = text; }
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeInputToDate(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d > new Date()) d.setDate(d.getDate() - 1);
  return d;
}
function hhmm(date) { return date.toTimeString().slice(0, 5); }

// ─── RENDER ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderMealTabs();
  renderBGPanel();
  renderMealSettingsPanel();
  renderFoodTable();
  renderBolusPanel();
  renderTimingCard();
  renderUnitsLabels();
  renderLogSection();
  setVal('meal-notes', getCurrentMeal().notes || '');
}

function renderMealTabs() {
  const container = document.getElementById('meal-tabs');
  if (!container) return;
  container.innerHTML = '';
  MEAL_SLUGS.forEach(slug => {
    const btn = document.createElement('button');
    btn.className = 'tab-pill' + (slug === state.activeMeal ? ' tab-pill--active' : '');
    btn.textContent = MEAL_LABELS[slug];
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', slug === state.activeMeal);
    btn.addEventListener('click', () => {
      state.activeMeal = slug;
      clearBolusTimer();
      state.entryFood = { name: '', carbFactor: null, weightG: '', carbsG: '', absorptionRate: 3.0 };
      ['entry-food-search','entry-cf','entry-weight','entry-carbs'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      renderAll();
      startBolusTimerIfLocked();
    });
    container.appendChild(btn);
  });
}

function renderBGPanel() {
  const meal = getCurrentMeal();
  setVal('bg-value', meal.currentBG);
  setVal('iob-value', meal.iob);
  setVal('cob-value', meal.cob);
  const unitLabel = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';
  document.querySelectorAll('.bg-unit-label').forEach(el => { el.textContent = unitLabel; });
  const bgTs = document.getElementById('bg-timestamp');
  if (bgTs) {
    if (meal.bgTimestamp) { bgTs.textContent = formatTime(meal.bgTimestamp) + (meal.bgTrend ? ' ' + meal.bgTrend : ''); bgTs.hidden = false; }
    else bgTs.hidden = true;
  }
  const fetchBgBtn  = document.getElementById('fetch-bg-btn');  if (fetchBgBtn)  fetchBgBtn.hidden  = inferBGSource()  === 'manual';
  const fetchIobBtn = document.getElementById('fetch-iob-btn'); if (fetchIobBtn) fetchIobBtn.hidden = inferIOBSource() === 'manual';
  const fetchCobBtn = document.getElementById('fetch-cob-btn'); if (fetchCobBtn) fetchCobBtn.hidden = inferCOBSource() === 'manual';
}

function renderMealSettingsPanel() {
  const settings = getCurrentMealSettings();
  setVal('icr-input', settings.icr ?? '');
  setVal('isf-input', settings.isf ?? '');
  setVal('target-bg-input', settings.target_bg ?? '');
  const isfUnitStr = state.units === 'mmol' ? 'mmol/L per U' : 'mg/dL per U';
  document.querySelectorAll('.isf-unit-label').forEach(el => { el.textContent = isfUnitStr; });
  const nsBtn = document.getElementById('fetch-profile-btn');
  if (nsBtn) { const nsConfig = storage.get('ns_config'); nsBtn.hidden = !nsConfig?.url; }
}

function renderTimingCard() {
  const slug     = state.activeMeal;
  const bolusSet = state.bolusLockedAt[slug];
  const mealSet  = state.mealLockedAt[slug];

  const bolusInput = document.getElementById('bolus-time-input');
  const mealInput  = document.getElementById('meal-time-input');
  if (bolusSet && bolusInput && document.activeElement !== bolusInput) bolusInput.value = hhmm(bolusSet);
  if (mealSet  && mealInput  && document.activeElement !== mealInput)  mealInput.value  = hhmm(mealSet);

  const mbEl    = document.getElementById('minutes-between');
  const mbValue = document.getElementById('minutes-between-value');
  if (bolusSet) {
    if (mbEl) mbEl.hidden = false;
    if (mealSet) {
      const diffMins = Math.floor((mealSet.getTime() - bolusSet.getTime()) / 60000);
      if (mbValue) mbValue.textContent = diffMins >= 0 ? `${diffMins} min` : `−${Math.abs(diffMins)} min`;
    } else {
      if (mbValue) mbValue.textContent = elapsedMMSS(bolusSet);
    }
  } else {
    if (mbEl) mbEl.hidden = true;
  }
}

function setupTimingCard() {
  const bolusInput  = document.getElementById('bolus-time-input');
  const bolusSetBtn = document.getElementById('bolus-set-btn');
  const mealInput   = document.getElementById('meal-time-input');
  const mealSetBtn  = document.getElementById('meal-set-btn');

  bolusInput?.addEventListener('input', e => {
    const d = timeInputToDate(e.target.value);
    state.bolusLockedAt[state.activeMeal] = d || null;
    clearBolusTimer(); startBolusTimerIfLocked();
  });
  bolusInput?.addEventListener('change', e => {
    if (!e.target.value) { state.bolusLockedAt[state.activeMeal] = null; clearBolusTimer(); renderTimingCard(); }
  });

  mealInput?.addEventListener('input', e => {
    const d = timeInputToDate(e.target.value);
    state.mealLockedAt[state.activeMeal] = d || null;
    clearBolusTimer(); startBolusTimerIfLocked();
  });
  mealInput?.addEventListener('change', e => {
    if (!e.target.value) { state.mealLockedAt[state.activeMeal] = null; clearBolusTimer(); startBolusTimerIfLocked(); }
  });

  bolusSetBtn?.addEventListener('click', () => {
    const now = new Date();
    state.bolusLockedAt[state.activeMeal] = now;
    if (bolusInput) bolusInput.value = hhmm(now);
    clearBolusTimer(); startBolusTimerIfLocked();
  });

  mealSetBtn?.addEventListener('click', () => {
    const now = new Date();
    state.mealLockedAt[state.activeMeal] = now;
    if (mealInput) mealInput.value = hhmm(now);
    clearBolusTimer(); startBolusTimerIfLocked();
  });
}

function startBolusTimerIfLocked() {
  clearBolusTimer();
  const slug     = state.activeMeal;
  const bolusSet = state.bolusLockedAt[slug];
  const mealSet  = state.mealLockedAt[slug];
  const mbEl     = document.getElementById('minutes-between');
  const mbValue  = document.getElementById('minutes-between-value');

  if (!bolusSet) { if (mbEl) mbEl.hidden = true; return; }
  if (mbEl) mbEl.hidden = false;

  if (mealSet) {
    // Both set: static floor minutes, no live timer needed
    const diffMins = Math.floor((mealSet.getTime() - bolusSet.getTime()) / 60000);
    if (mbValue) mbValue.textContent = diffMins >= 0 ? `${diffMins} min` : `−${Math.abs(diffMins)} min`;
    return;
  }

  // Only bolus set: live MM:SS elapsed
  function tick() {
    const from = state.bolusLockedAt[slug]; if (!from) return;
    if (mbValue) mbValue.textContent = elapsedMMSS(from);
  }
  tick();
  state.bolusTimerID = setInterval(tick, 1000);
}
function clearBolusTimer() { if (state.bolusTimerID) { clearInterval(state.bolusTimerID); state.bolusTimerID = null; } }

// ─── FOOD ENTRY ROW ──────────────────────────────────────────────────────────

function setupFoodEntryRow() {
  const searchInput = document.getElementById('entry-food-search');
  const cfInput     = document.getElementById('entry-cf');
  const weightInput = document.getElementById('entry-weight');
  const carbsInput  = document.getElementById('entry-carbs');
  const addBtn      = document.getElementById('add-food-btn');

  const debouncedSearch = debounce((query, el) => {
    performFoodSearch(query, el, food => {
      state.entryFood.name = food.name; state.entryFood.carbFactor = food.carbFactor;
      state.entryFood.absorptionRate = food.absorptionRate;
      if (searchInput) searchInput.value = food.name;
      if (cfInput) cfInput.value = food.carbFactor || '';
      if (state.entryFood.weightG) {
        const c = calcNetCarbs(parseFloat(state.entryFood.weightG), food.carbFactor);
        state.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c;
      } else if (state.entryFood.carbsG) {
        const w = calcWeightFromCarbs(parseFloat(state.entryFood.carbsG), food.carbFactor);
        state.entryFood.weightG = w; if (weightInput) weightInput.value = w;
      }
    });
  }, 300);

  searchInput?.addEventListener('input', e => {
    state.entryFood.name = e.target.value; state.entryFood.carbFactor = null;
    if (cfInput) cfInput.value = ''; debouncedSearch(e.target.value, e.target);
  });
  searchInput?.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });

  weightInput?.addEventListener('input', e => {
    const w = parseFloat(e.target.value) || 0; state.entryFood.weightG = w || '';
    if (state.entryFood.carbFactor && w) { const c = calcNetCarbs(w, state.entryFood.carbFactor); state.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c; }
  });

  carbsInput?.addEventListener('input', e => {
    const c = parseFloat(e.target.value) || 0; state.entryFood.carbsG = c || '';
    if (state.entryFood.carbFactor && c) { const w = calcWeightFromCarbs(c, state.entryFood.carbFactor); state.entryFood.weightG = w; if (weightInput) weightInput.value = w; }
  });

  addBtn?.addEventListener('click', () => {
    const ef = state.entryFood;
    if (!ef.name) { showToast('Search and select a food first', 'error'); return; }
    const w = parseFloat(ef.weightG) || 0, c = parseFloat(ef.carbsG) || 0;
    if (!w && !c) { showToast('Enter weight or carbs', 'error'); return; }
    getCurrentMeal().foods.push({ name: ef.name, carbFactor: ef.carbFactor, weightG: w || calcWeightFromCarbs(c, ef.carbFactor), absorptionRate: ef.absorptionRate || 3.0 });
    state.entryFood = { name: '', carbFactor: null, weightG: '', carbsG: '', absorptionRate: 3.0 };
    if (searchInput) searchInput.value = '';
    if (cfInput)     cfInput.value = '';
    if (weightInput) weightInput.value = '';
    if (carbsInput)  carbsInput.value = '';
    renderFoodTable(); updateBolusLive();
  });
}

// ─── FOOD TABLE ──────────────────────────────────────────────────────────────

function renderFoodTable() {
  const tbody = document.getElementById('food-rows');
  if (!tbody) return;
  const meal = getCurrentMeal();
  tbody.innerHTML = '';

  meal.foods.forEach((food, i) => {
    const carbsVal = food.carbFactor && food.weightG ? calcNetCarbs(parseFloat(food.weightG), food.carbFactor) : '';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="food-col-name">
        <input type="text" class="input input--sm food-name-input" value="${escHtml(food.name)}" autocomplete="off" data-index="${i}" />
      </td>
      <td class="food-col-cf"><span class="cf-display">${food.carbFactor != null ? food.carbFactor : '—'}</span></td>
      <td class="food-col-weight"><input type="number" class="input input--sm food-weight-input" value="${food.weightG || ''}" min="0" step="1" data-index="${i}" /></td>
      <td class="food-col-carbs"><input type="number" class="input input--sm food-carbs-input" value="${carbsVal !== '' ? carbsVal : ''}" min="0" step="0.1" data-index="${i}" /></td>
      <td class="food-col-remove"><button class="btn btn--icon food-remove-btn" aria-label="Remove">×</button></td>
    `;

    const nameInput   = row.querySelector('.food-name-input');
    const weightInput = row.querySelector('.food-weight-input');
    const carbsInput  = row.querySelector('.food-carbs-input');
    const cfDisplay   = row.querySelector('.cf-display');

    const debouncedSearch = debounce((query, el) => {
      performFoodSearch(query, el, sel => {
        const f = getCurrentMeal().foods[i];
        f.name = sel.name; f.carbFactor = sel.carbFactor; f.absorptionRate = sel.absorptionRate;
        nameInput.value = sel.name; cfDisplay.textContent = sel.carbFactor != null ? sel.carbFactor : '—';
        if (f.weightG) { const c = calcNetCarbs(parseFloat(f.weightG), sel.carbFactor); carbsInput.value = c; }
        updateBolusLive(); renderFoodTotals();
      });
    }, 300);

    nameInput.addEventListener('input', e => { const f = getCurrentMeal().foods[i]; f.name = e.target.value; debouncedSearch(e.target.value, e.target); });
    nameInput.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });

    weightInput.addEventListener('input', e => {
      const f = getCurrentMeal().foods[i]; const w = parseFloat(e.target.value) || 0; f.weightG = w || '';
      if (f.carbFactor && w) { carbsInput.value = calcNetCarbs(w, f.carbFactor); }
      updateBolusLive(); renderFoodTotals();
    });

    carbsInput.addEventListener('input', e => {
      const f = getCurrentMeal().foods[i]; const c = parseFloat(e.target.value) || 0;
      if (f.carbFactor && c) { const w = calcWeightFromCarbs(c, f.carbFactor); f.weightG = w; weightInput.value = w; }
      updateBolusLive(); renderFoodTotals();
    });

    row.querySelector('.food-remove-btn').addEventListener('click', () => {
      getCurrentMeal().foods.splice(i, 1); renderFoodTable(); updateBolusLive();
    });

    tbody.appendChild(row);
  });

  renderFoodTotals();
}

function renderFoodTotals() {
  const total = getCurrentMeal().foods.reduce((s, f) => s + calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0), 0);
  setText('food-total-carbs', total.toFixed(1) + ' g');
}

// ─── FOOD SEARCH ─────────────────────────────────────────────────────────────

function performFoodSearch(query, inputEl, onSelect) {
  document.querySelector('.food-dropdown')?.remove();
  if (!query || query.length < 1) return;
  const q       = query.toLowerCase();
  const personal = state.personalFoods.filter(f => f.name.toLowerCase().includes(q)).slice(0, 5);
  const builtin  = HEALTH_CANADA_FOODS.filter(f => f.name.toLowerCase().includes(q)).slice(0, 5);
  const results  = [...personal, ...builtin].slice(0, 8);
  if (!results.length) return;
  const dropdown = createFoodDropdown(results, onSelect);
  if (dropdown) positionDropdown(dropdown, inputEl);
}

// ─── BOLUS PANEL ─────────────────────────────────────────────────────────────

function updateBolusLive() { renderBolusPanel(); }

function renderBolusPanel() {
  const meal = getCurrentMeal(); const settings = getCurrentMealSettings();
  const foods = meal.foods.map(f => ({ weightG: parseFloat(f.weightG) || 0, carbFactor: f.carbFactor || 0 }));
  const result = calcBolus({ foods, currentBG: parseFloat(meal.currentBG) || null, targetBG: settings.target_bg, icr: settings.icr, isf: settings.isf, iob: parseFloat(meal.iob) || 0 });
  setText('summary-carbs',      result.totalNetCarbs.toFixed(1) + ' g');
  setText('summary-meal-bolus', result.mealBolus.toFixed(2) + ' U');
  setText('summary-correction', result.correctionBolus.toFixed(2) + ' U');
  setText('summary-iob',        '−' + result.iobOffset.toFixed(2) + ' U');
  setText('summary-total',      result.totalBolus.toFixed(2));
}

function renderUnitsLabels() {
  const unit = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';
  document.querySelectorAll('[data-unit-label]').forEach(el => { el.textContent = unit; });
}

// ─── UNITS CONVERSION ────────────────────────────────────────────────────────

function changeUnits(newUnits) {
  if (newUnits === state.units) return;
  state.units = newUnits; storage.set('units', newUnits); persistConfig({ units: newUnits });

  MEAL_SLUGS.forEach(slug => {
    const meal = state.meals[slug];
    if (meal.currentBG !== '') {
      const v = parseFloat(meal.currentBG);
      if (!isNaN(v)) meal.currentBG = newUnits === 'mmol' ? mgdlToMmol(v) : mmolToMgdl(v);
    }
    const s = getMealSettings(slug);
    if (s.target_bg != null) {
      const v = newUnits === 'mmol' ? mgdlToMmol(s.target_bg) : mmolToMgdl(s.target_bg);
      setMealSettings(slug, { target_bg: newUnits === 'mmol' ? Math.round(v * 10) / 10 : Math.round(v) });
    }
    if (s.isf != null) {
      const v = newUnits === 'mmol' ? mgdlToMmol(s.isf) : mmolToMgdl(s.isf);
      setMealSettings(slug, { isf: newUnits === 'mmol' ? Math.round(v * 10) / 10 : Math.round(v) });
    }
    meal.postBgReadings.forEach(r => {
      if (r.bg !== '' && r.bg != null) {
        const v = parseFloat(r.bg);
        if (!isNaN(v)) r.bg = newUnits === 'mmol' ? mgdlToMmol(v) : mmolToMgdl(v);
      }
    });
  });

  renderAll(); renderPostMealTracker();
  showToast(`Units set to ${newUnits === 'mmol' ? 'mmol/L' : 'mg/dL'}`, 'info');
}

// ─── LOG SECTION ─────────────────────────────────────────────────────────────

function renderLogSection() {
  const container = document.getElementById('log-entries');
  if (!container) return;
  const log = getTodayLog();
  if (!log.length) { container.innerHTML = '<p class="empty-state">No meals logged today.</p>'; return; }
  const byMeal = {};
  log.forEach(e => { if (!byMeal[e.meal]) byMeal[e.meal] = []; byMeal[e.meal].push(e); });
  let html = '', grandTotal = 0;
  Object.entries(byMeal).forEach(([meal, entries]) => {
    const mt = entries.reduce((s, e) => s + (e.netCarbs || 0), 0); grandTotal += mt;
    html += `<div class="log-meal"><h3 class="log-meal__title">${escHtml(meal)} <span class="log-meal__total">${mt.toFixed(1)} g total</span></h3>
      <table class="log-table"><thead><tr><th>Food</th><th>Weight</th><th>CF</th><th>Net Carbs</th></tr></thead><tbody>
        ${entries.map(e => `<tr><td>${escHtml(e.food)}</td><td>${e.weightG||'—'} g</td><td>${e.carbFactor||'—'}</td><td>${(e.netCarbs||0).toFixed(1)} g</td></tr>`).join('')}
      </tbody></table></div>`;
  });
  html += `<div class="log-grand-total">Daily Total: <strong>${grandTotal.toFixed(1)} g</strong></div>`;
  const lastExport = storage.get('last_export_date');
  if (lastExport) html += `<p class="last-export">Last exported: ${lastExport}</p>`;
  container.innerHTML = html;
}

// ─── SETTINGS SECTION ────────────────────────────────────────────────────────

function renderSettingsSection() {
  const email = storage.get('google_email', ''), connected = isConnected();
  document.getElementById('connect-block')?.toggleAttribute('hidden', connected);
  document.getElementById('connected-block')?.toggleAttribute('hidden', !connected);
  if (connected) {
    const emailEl = document.getElementById('connected-email'); if (emailEl) emailEl.textContent = email;
    const folderId = storage.get('drive_folder_id');
    const folderLink = document.getElementById('drive-folder-link');
    if (folderLink && folderId) { folderLink.href = `https://drive.google.com/drive/folders/${folderId}`; folderLink.hidden = false; }
    const sheetId = storage.get('food_sheet_id');
    const sheetLink = document.getElementById('food-sheet-link');
    if (sheetLink && sheetId) { sheetLink.href = `https://docs.google.com/spreadsheets/d/${sheetId}`; sheetLink.hidden = false; }
  }
  const nsConfig = storage.get('ns_config', {}); setVal('ns-url', nsConfig.url||''); setVal('ns-secret', nsConfig.secret||'');
  const dexConfig = storage.get('dexcom_config', {}); setVal('dex-user', dexConfig.user||''); setVal('dex-pass', dexConfig.pass||''); setVal('dex-region', dexConfig.region||'us');
  const unitsSelect = document.getElementById('units-select'); if (unitsSelect) unitsSelect.value = state.units;
  const colorSelect = document.getElementById('color-theme-select'); if (colorSelect) colorSelect.value = storage.get('color_theme','green');
  const modeSelect  = document.getElementById('mode-select');  if (modeSelect)  modeSelect.value  = storage.get('mode','system');
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function setupNavigation() {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.nav);
      if (btn.dataset.nav === 'settings') renderSettingsSection();
      if (btn.dataset.nav === 'log')      renderLogSection();
    });
  });
  window.addEventListener('hashchange', () => {
    const section = getCurrentSection(); navigate(section);
    if (section === 'settings') renderSettingsSection();
    if (section === 'log')      renderLogSection();
  });

  document.getElementById('bg-value')?.addEventListener('input',  e => { getCurrentMeal().currentBG = e.target.value; updateBolusLive(); });
  document.getElementById('iob-value')?.addEventListener('input', e => { getCurrentMeal().iob = e.target.value; updateBolusLive(); });
  document.getElementById('cob-value')?.addEventListener('input', e => { getCurrentMeal().cob = e.target.value; });
  document.getElementById('fetch-bg-btn')?.addEventListener('click',       fetchBG);
  document.getElementById('fetch-iob-btn')?.addEventListener('click',      fetchIOB);
  document.getElementById('fetch-cob-btn')?.addEventListener('click',      fetchCOB);
  document.getElementById('fetch-profile-btn')?.addEventListener('click',  fetchNightscoutProfile);

  document.getElementById('icr-input')?.addEventListener('input',       e => { setMealSettings(state.activeMeal, { icr:      parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });
  document.getElementById('isf-input')?.addEventListener('input',       e => { setMealSettings(state.activeMeal, { isf:      parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });
  document.getElementById('target-bg-input')?.addEventListener('input', e => { setMealSettings(state.activeMeal, { target_bg: parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });

  document.getElementById('meal-notes')?.addEventListener('input', e => { getCurrentMeal().notes = e.target.value; });
  document.getElementById('bolus-given-btn')?.addEventListener('click', handleBolusGiven);
  document.getElementById('export-log-btn')?.addEventListener('click',  exportToDrive);

  document.getElementById('connect-google-btn')?.addEventListener('click', startOAuth);
  document.getElementById('disconnect-google-btn')?.addEventListener('click', () => {
    disconnect(); state.personalFoods = []; state.config = null;
    updateConnectedStatus(null); renderSettingsSection(); showToast('Google account disconnected', 'info');
  });
  document.getElementById('build-folders-btn')?.addEventListener('click', async e => {
    showSpinner(e.target);
    try { await setupDriveFolders(document.getElementById('drive-folder-name')?.value || 'Loop Bolus Calculator'); showToast('Drive folders created!', 'success'); renderSettingsSection(); }
    catch (err) { showToast('Error: ' + err.message, 'error'); } finally { hideSpinner(e.target); }
  });
  document.getElementById('test-ns-btn')?.addEventListener('click', async e => {
    showSpinner(e.target);
    try { const { testConnection } = await import('./nightscout.js'); const ok = await testConnection(); showToast(ok ? 'Nightscout connected!' : 'Connection failed', ok ? 'success' : 'error'); }
    catch (err) { showToast('Error: ' + err.message, 'error'); } finally { hideSpinner(e.target); }
  });
  document.getElementById('test-dex-btn')?.addEventListener('click', async e => {
    showSpinner(e.target);
    try { const { testConnection } = await import('./dexcom.js'); await testConnection(); showToast('Dexcom connected!', 'success'); }
    catch (err) { showToast('Error: ' + err.message, 'error'); } finally { hideSpinner(e.target); }
  });
  document.getElementById('save-ns-btn')?.addEventListener('click', () => {
    const url = document.getElementById('ns-url')?.value?.trim(); const secret = document.getElementById('ns-secret')?.value?.trim();
    storage.set('ns_config', { url, secret }); persistConfig({ nightscout_url: url, nightscout_secret: secret });
    renderMealSettingsPanel(); showToast('Nightscout settings saved', 'success');
  });
  document.getElementById('save-dex-btn')?.addEventListener('click', () => {
    const user = document.getElementById('dex-user')?.value?.trim(); const pass = document.getElementById('dex-pass')?.value?.trim(); const region = document.getElementById('dex-region')?.value;
    storage.set('dexcom_config', { user, pass, region }); persistConfig({ dexcom_user: user, dexcom_pass: pass, dexcom_region: region }); showToast('Dexcom settings saved', 'success');
  });
  document.getElementById('units-select')?.addEventListener('change', e => { changeUnits(e.target.value); });
  document.getElementById('color-theme-select')?.addEventListener('change', e => { applyColorTheme(e.target.value); persistConfig({ color_theme: e.target.value }); });
  document.getElementById('mode-select')?.addEventListener('change',  e => { applyMode(e.target.value);  persistConfig({ mode: e.target.value }); });
}

// ─── TOOLS MENU ──────────────────────────────────────────────────────────────

function setupToolsMenu() {
  document.getElementById('tools-btn')?.addEventListener('click', e => { e.stopPropagation(); toggleToolsDropdown(); });
  document.getElementById('tools-export-current')?.addEventListener('click', () => { document.getElementById('tools-dropdown').hidden = true; exportAndClearCurrentSheet(); });
  document.getElementById('tools-export-all')?.addEventListener('click',     () => { document.getElementById('tools-dropdown').hidden = true; exportAndClearAllSheets(); });
  document.getElementById('tools-recipe')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const panel = document.getElementById('recipe-panel');
    if (panel?.hidden) { openRecipePanel(); renderRecipeTabs(); renderRecipePanel(); } else { closeRecipePanel(); }
  });
  document.getElementById('tools-tracker')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const tracker = document.getElementById('post-meal-tracker');
    if (tracker) tracker.hidden = !tracker.hidden;
  });
}

// ─── BOLUS GIVEN ─────────────────────────────────────────────────────────────

function handleBolusGiven() {
  const slug = state.activeMeal;
  const now  = new Date();
  state.bolusLockedAt[slug] = now;
  const input = document.getElementById('bolus-time-input');
  if (input) input.value = hhmm(now);
  clearBolusTimer(); startBolusTimerIfLocked();
  showToast('Bolus time set to now', 'success');
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

function buildLogEntries(slug, meal) {
  return meal.foods.filter(f => f.name && f.weightG).map(f => ({
    date: todayStr(), meal: MEAL_LABELS[slug], food: f.name, carbFactor: f.carbFactor,
    weightG: parseFloat(f.weightG) || 0, netCarbs: calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0), notes: meal.notes || ''
  }));
}

async function exportAndClearCurrentSheet() {
  if (!isConnected()) { showToast('Connect Google Drive first', 'error'); return; }
  const slug = state.activeMeal; const entries = buildLogEntries(slug, state.meals[slug]);
  if (!entries.length) { showToast('No foods to export for ' + MEAL_LABELS[slug], 'error'); return; }
  try {
    showToast('Exporting…', 'info'); const dateStr = todayStr();
    await exportLogToSheet(dateStr, entries); storage.set('last_export_date', dateStr);
    state.meals[slug].foods = []; renderFoodTable(); updateBolusLive();
    showToast(`${MEAL_LABELS[slug]} exported and cleared`, 'success'); renderLogSection();
  } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
}

async function exportAndClearAllSheets() {
  if (!isConnected()) { showToast('Connect Google Drive first', 'error'); return; }
  const allEntries = []; MEAL_SLUGS.forEach(slug => { allEntries.push(...buildLogEntries(slug, state.meals[slug])); });
  if (!allEntries.length) { showToast('No foods to export', 'error'); return; }
  try {
    showToast('Exporting all meals…', 'info'); const dateStr = todayStr();
    await exportLogToSheet(dateStr, allEntries); storage.set('last_export_date', dateStr);
    MEAL_SLUGS.forEach(slug => { state.meals[slug].foods = []; }); renderFoodTable(); updateBolusLive();
    showToast('All meals exported and cleared', 'success'); renderLogSection();
  } catch (err) { showToast('Export failed: ' + err.message, 'error'); }
}

async function exportToDrive() {
  const btn = document.getElementById('export-log-btn'); if (btn) showSpinner(btn);
  try {
    if (!isConnected()) throw new Error('Connect Google Drive first');
    const log = getTodayLog(); if (!log.length) throw new Error('Nothing to export');
    const dateStr = todayStr(); await exportLogToSheet(dateStr, log);
    storage.set('last_export_date', dateStr); showToast('Log exported to Drive!', 'success'); renderLogSection();
  } catch (err) { showToast('Export failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

// ─── POST-MEAL BG TRACKER ────────────────────────────────────────────────────

function setupPostMealTracker() {
  document.getElementById('close-tracker-btn')?.addEventListener('click', () => {
    const el = document.getElementById('post-meal-tracker'); if (el) el.hidden = true;
  });
  document.getElementById('generate-times-btn')?.addEventListener('click', () => {
    const slug = state.activeMeal; const locked = state.bolusLockedAt[slug];
    const interval = parseInt(document.getElementById('tracking-interval')?.value || '30');
    if (!locked) { showToast('Lock the bolus time first', 'error'); return; }
    const rows = getCurrentMeal().postBgReadings;
    rows.forEach((r, i) => { const t = new Date(locked.getTime() + (i+1) * interval * 60000); r.time = hhmm(t); r.minSinceBolus = (i+1) * interval; });
    renderPostMealTracker();
  });
  document.getElementById('add-bg-row-btn')?.addEventListener('click', () => {
    getCurrentMeal().postBgReadings.push({ time: '', minSinceBolus: '', bg: '', trend: '→', delta: '' });
    renderPostMealTracker();
  });
}

function renderPostMealTracker() {
  const tbody = document.getElementById('post-bg-rows'); if (!tbody) return;
  const meal = getCurrentMeal(); tbody.innerHTML = '';
  meal.postBgReadings.forEach((r, i) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="time" class="input input--sm" value="${r.time||''}" data-field="time" data-index="${i}" /></td>
      <td><span class="post-min">${r.minSinceBolus||'—'}</span></td>
      <td><input type="number" class="input input--sm" value="${r.bg||''}" placeholder="${state.units==='mmol'?'mmol/L':'mg/dL'}" step="${state.units==='mmol'?'0.1':'1'}" data-field="bg" data-index="${i}" /></td>
      <td><select class="input input--sm" data-field="trend" data-index="${i}">
        <option value="→" ${r.trend==='→'?'selected':''}>→ Flat</option>
        <option value="↗" ${r.trend==='↗'?'selected':''}>↗ Rising Slightly</option>
        <option value="↘" ${r.trend==='↘'?'selected':''}>↘ Falling Slightly</option>
        <option value="↑" ${r.trend==='↑'?'selected':''}>↑ Rising</option>
        <option value="↓" ${r.trend==='↓'?'selected':''}>↓ Falling</option>
        <option value="⇈" ${r.trend==='⇈'?'selected':''}>⇈ Rising Rapidly</option>
        <option value="⇊" ${r.trend==='⇊'?'selected':''}>⇊ Falling Rapidly</option>
      </select></td>
      <td><span class="post-delta">${r.delta!==''&&r.delta!=null?(r.delta>0?'+':'')+r.delta:'—'}</span></td>
      <td><button class="btn btn--icon" data-remove="${i}">×</button></td>`;
    row.querySelector('[data-field="time"]').addEventListener('input', e => {
      const rd = getCurrentMeal().postBgReadings[i]; rd.time = e.target.value;
      const locked = state.bolusLockedAt[state.activeMeal];
      if (locked && e.target.value) { const rd2 = timeInputToDate(e.target.value); if (rd2) rd.minSinceBolus = Math.round((rd2 - locked) / 60000); row.querySelector('.post-min').textContent = rd.minSinceBolus; }
    });
    row.querySelector('[data-field="bg"]').addEventListener('input', e => {
      const rd = getCurrentMeal().postBgReadings[i]; rd.bg = parseFloat(e.target.value)||'';
      if (i > 0) { const prev = getCurrentMeal().postBgReadings[i-1]; if (prev.bg!=='' && rd.bg!=='') { const delta = Math.round((rd.bg-prev.bg)*10)/10; rd.delta = delta; row.querySelector('.post-delta').textContent = (delta>0?'+':'')+delta; } }
    });
    row.querySelector('[data-field="trend"]').addEventListener('change', e => { getCurrentMeal().postBgReadings[i].trend = e.target.value; });
    row.querySelector('[data-remove]').addEventListener('click', () => { getCurrentMeal().postBgReadings.splice(i, 1); renderPostMealTracker(); });
    tbody.appendChild(row);
  });
}

// ─── RECIPE BUILDER ──────────────────────────────────────────────────────────

function calcRecipeCompositeCF(recipe) {
  const totalWeight = recipe.ingredients.reduce((s, i) => s + (parseFloat(i.weightG)||0), 0);
  const totalCarbs  = recipe.ingredients.reduce((s, i) => s + calcNetCarbs(parseFloat(i.weightG)||0, i.carbFactor||0), 0);
  return calcCompositeCF(totalCarbs, totalWeight);
}

function setupRecipePanel() {
  document.getElementById('close-recipe-btn')?.addEventListener('click', closeRecipePanel);
  document.getElementById('new-recipe-btn')?.addEventListener('click', () => {
    state.recipes.push(createRecipe()); state.activeRecipeIndex = state.recipes.length - 1;
    renderRecipeTabs(); renderRecipePanel();
  });
  document.getElementById('recipe-add-ingredient-btn')?.addEventListener('click', () => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const ef = recipe.entryFood;
    if (!ef.name || !ef.carbFactor) { showToast('Select a food first', 'error'); return; }
    const w = parseFloat(ef.weightG)||0, c = parseFloat(ef.carbsG)||0;
    if (!w && !c) { showToast('Enter weight or carbs', 'error'); return; }
    recipe.ingredients.push({ name: ef.name, carbFactor: ef.carbFactor, weightG: w || calcWeightFromCarbs(c, ef.carbFactor), absorptionRate: ef.absorptionRate||3.0 });
    recipe.entryFood = { name:'', carbFactor:null, weightG:'', carbsG:'' };
    ['recipe-search-input','recipe-entry-cf','recipe-entry-weight','recipe-entry-carbs'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderRecipeIngredients(); renderRecipeComposite();
  });
  setupRecipeEntryRow();

  document.getElementById('recipe-portion-weight')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe); const w = parseFloat(e.target.value)||0;
    const portionCarbsEl = document.getElementById('recipe-portion-carbs');
    if (portionCarbsEl) portionCarbsEl.value = cf ? Math.round(w * cf * 10) / 10 : '';
  });
  document.getElementById('recipe-portion-carbs')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe); const c = parseFloat(e.target.value)||0;
    const portionWeightEl = document.getElementById('recipe-portion-weight');
    if (portionWeightEl) portionWeightEl.value = cf ? Math.round((c/cf)*10)/10 : '';
  });
  document.getElementById('recipe-add-to-meal-btn')?.addEventListener('click', () => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe);
    const w  = parseFloat(document.getElementById('recipe-portion-weight')?.value)||0;
    const c  = parseFloat(document.getElementById('recipe-portion-carbs')?.value)||0;
    if (!w && !c) { showToast('Enter portion weight or carbs', 'error'); return; }
    const weight = w || (cf ? Math.round((c/cf)*10)/10 : 0);
    getCurrentMeal().foods.push({ name: recipe.name||'Recipe', carbFactor: cf, weightG: weight, absorptionRate: 3.0 });
    renderFoodTable(); updateBolusLive(); showToast('Recipe added to meal', 'success');
  });
  document.getElementById('recipe-name-input')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (recipe) recipe.name = e.target.value;
    const tabs = document.querySelectorAll('.recipe-tab-pill');
    if (tabs[state.activeRecipeIndex]) tabs[state.activeRecipeIndex].textContent = e.target.value || `Recipe ${state.activeRecipeIndex+1}`;
  });
}

function setupRecipeEntryRow() {
  const searchInput = document.getElementById('recipe-search-input');
  const cfInput     = document.getElementById('recipe-entry-cf');
  const weightInput = document.getElementById('recipe-entry-weight');
  const carbsInput  = document.getElementById('recipe-entry-carbs');
  const debouncedSearch = debounce((query, el) => {
    performFoodSearch(query, el, food => {
      const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
      recipe.entryFood.name = food.name; recipe.entryFood.carbFactor = food.carbFactor; recipe.entryFood.absorptionRate = food.absorptionRate;
      if (searchInput) searchInput.value = food.name; if (cfInput) cfInput.value = food.carbFactor||'';
      if (recipe.entryFood.weightG) { const c = calcNetCarbs(parseFloat(recipe.entryFood.weightG), food.carbFactor); recipe.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c; }
    });
  }, 300);
  searchInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex];
    if (recipe) { recipe.entryFood.name = e.target.value; recipe.entryFood.carbFactor = null; }
    if (cfInput) cfInput.value = ''; debouncedSearch(e.target.value, e.target);
  });
  searchInput?.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });
  weightInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const w = parseFloat(e.target.value)||0; recipe.entryFood.weightG = w||'';
    if (recipe.entryFood.carbFactor && w) { const c = calcNetCarbs(w, recipe.entryFood.carbFactor); recipe.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c; }
  });
  carbsInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const c = parseFloat(e.target.value)||0; recipe.entryFood.carbsG = c||'';
    if (recipe.entryFood.carbFactor && c) { const w = calcWeightFromCarbs(c, recipe.entryFood.carbFactor); recipe.entryFood.weightG = w; if (weightInput) weightInput.value = w; }
  });
}

function renderRecipeTabs() {
  const container = document.getElementById('recipe-tabs'); if (!container) return;
  container.innerHTML = '';
  state.recipes.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'recipe-tab-pill' + (i === state.activeRecipeIndex ? ' recipe-tab-pill--active' : '');
    btn.textContent = r.name || `Recipe ${i+1}`;
    btn.addEventListener('click', () => { state.activeRecipeIndex = i; renderRecipeTabs(); renderRecipePanel(); });
    container.appendChild(btn);
  });
}

function renderRecipePanel() {
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  const nameInput = document.getElementById('recipe-name-input'); if (nameInput) nameInput.value = recipe.name||'';
  document.getElementById('recipe-search-input').value = recipe.entryFood.name||'';
  document.getElementById('recipe-entry-cf').value     = recipe.entryFood.carbFactor||'';
  document.getElementById('recipe-entry-weight').value = recipe.entryFood.weightG||'';
  document.getElementById('recipe-entry-carbs').value  = recipe.entryFood.carbsG||'';
  renderRecipeIngredients(); renderRecipeComposite();
}

function renderRecipeIngredients() {
  const tbody = document.getElementById('recipe-ingredient-rows'); if (!tbody) return;
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  tbody.innerHTML = '';
  recipe.ingredients.forEach((ing, i) => {
    const carbs = calcNetCarbs(parseFloat(ing.weightG)||0, ing.carbFactor||0);
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escHtml(ing.name)}</td><td>${ing.carbFactor!=null?ing.carbFactor:'—'}</td>
      <td><input type="number" class="input input--sm" value="${ing.weightG||''}" min="0" step="1" /></td>
      <td>${carbs.toFixed(1)}</td><td><button class="btn btn--icon">×</button></td>`;
    row.querySelector('input').addEventListener('input', e => { recipe.ingredients[i].weightG = parseFloat(e.target.value)||0; renderRecipeIngredients(); renderRecipeComposite(); });
    row.querySelector('button').addEventListener('click', () => { recipe.ingredients.splice(i, 1); renderRecipeIngredients(); renderRecipeComposite(); });
    tbody.appendChild(row);
  });
}

function renderRecipeComposite() {
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  const totalWeight = recipe.ingredients.reduce((s, i) => s+(parseFloat(i.weightG)||0), 0);
  const totalCarbs  = recipe.ingredients.reduce((s, i) => s+calcNetCarbs(parseFloat(i.weightG)||0, i.carbFactor||0), 0);
  const cf          = calcCompositeCF(totalCarbs, totalWeight);
  setText('recipe-total-weight', totalWeight.toFixed(1)+' g');
  setText('recipe-total-carbs',  totalCarbs.toFixed(1)+' g');
  setText('recipe-composite-cf', cf ? cf.toFixed(4) : '—');
  const pw = parseFloat(document.getElementById('recipe-portion-weight')?.value)||0;
  if (pw && cf) { const portionCarbsEl = document.getElementById('recipe-portion-carbs'); if (portionCarbsEl) portionCarbsEl.value = Math.round(pw*cf*10)/10; }
}

// ─── BG/IOB/COB FETCH ────────────────────────────────────────────────────────

async function fetchBG() {
  const btn = document.getElementById('fetch-bg-btn'); if (btn) showSpinner(btn);
  try {
    const bgSrc = inferBGSource();
    let result;
    if (bgSrc === 'nightscout')    result = await nsBG(state.units);
    else if (bgSrc === 'dexcom') result = await dexBG(state.units);
    else return;
    const meal = getCurrentMeal(); meal.currentBG = result.value; meal.bgTimestamp = result.timestamp; meal.bgTrend = result.trend||null;
    setVal('bg-value', result.value); renderBGPanel(); updateBolusLive();
    showToast(`BG: ${formatBG(result.value, state.units)} ${state.units==='mmol'?'mmol/L':'mg/dL'}`, 'success');
  } catch (err) { showToast('BG fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchIOB() {
  const btn = document.getElementById('fetch-iob-btn'); if (btn) showSpinner(btn);
  try { const result = await nsIOB(); getCurrentMeal().iob = result.value; setVal('iob-value', result.value); updateBolusLive(); showToast(`IOB: ${result.value} U`, 'success'); }
  catch (err) { showToast('IOB fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchCOB() {
  const btn = document.getElementById('fetch-cob-btn'); if (btn) showSpinner(btn);
  try { const result = await nsCOB(); getCurrentMeal().cob = result.value; setVal('cob-value', result.value); showToast(`COB: ${result.value} g`, 'success'); }
  catch (err) { showToast('COB fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchNightscoutProfile() {
  const btn = document.getElementById('fetch-profile-btn'); if (btn) showSpinner(btn);
  try {
    const profile = await nsProfile(state.units);
    if (profile.icr)       { setMealSettings(state.activeMeal, { icr: profile.icr });             setVal('icr-input',       profile.icr); }
    if (profile.isf)       { setMealSettings(state.activeMeal, { isf: profile.isf });             setVal('isf-input',       profile.isf); }
    if (profile.target_bg) { setMealSettings(state.activeMeal, { target_bg: profile.target_bg }); setVal('target-bg-input', profile.target_bg); }
    persistConfig(); updateBolusLive(); showToast('Profile loaded from Nightscout', 'success');
  } catch (err) { showToast('Profile fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

// ─── EXPORT TIMER ────────────────────────────────────────────────────────────

function setupExportTimer() {
  let lastCheck = todayStr();
  setInterval(async () => {
    const today = todayStr();
    if (today !== lastCheck) {
      const yesterday = lastCheck; lastCheck = today;
      const lastExport = storage.get('last_export_date');
      if (lastExport !== yesterday && isConnected()) {
        const log = getTodayLog();
        if (log.length) { try { await exportLogToSheet(yesterday, log); storage.set('last_export_date', yesterday); setTodayLog([]); showToast("Yesterday's log exported automatically", 'success'); } catch {} }
      }
    }
  }, 60000);
}

// ─── PERSIST CONFIG ──────────────────────────────────────────────────────────

async function persistConfig(overrides = {}) {
  if (!isConnected()) return;
  try {
    const existing = await loadConfig() || {};
    const meals = {}; MEAL_SLUGS.forEach(slug => { meals[slug] = getMealSettings(slug); });
    await saveConfig({ ...existing, units: state.units, color_theme: storage.get('color_theme','green'), mode: storage.get('mode','system'), meals, ...overrides });
  } catch {}
}

document.addEventListener('DOMContentLoaded', init);
