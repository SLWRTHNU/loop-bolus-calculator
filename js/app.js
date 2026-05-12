import { storage, MEAL_SLUGS, MEAL_LABELS, getMealSettings, setMealSettings, getTodayLog, appendToLog, setTodayLog } from './storage.js';
import { calcBolus, calcNetCarbs, formatBG } from './calculator.js';
import { HEALTH_CANADA_FOODS } from './fooddata.js';
import { startOAuth, handleOAuthCallback, isConnected, disconnect, getAccessToken } from './auth.js';
import { setupDriveFolders, loadConfig, saveConfig, getSheetUrl } from './drive.js';
import { readFoodChart, exportLogToSheet } from './sheets.js';
import { fetchBG as nsBG, fetchIOB as nsIOB, fetchCOB as nsCOB, fetchProfile as nsProfile } from './nightscout.js';
import { fetchBG as dexBG } from './dexcom.js';
import { showToast, applyTheme, initTheme, navigate, getCurrentSection, debounce, createFoodDropdown, showSpinner, hideSpinner, updateConnectedStatus, formatTime, todayStr } from './ui.js';

const MAX_FOOD_ROWS = 12;

let state = {
  activeMeal: 'breakfast',
  meals: {},
  personalFoods: [],
  config: null,
  units: 'mmol',
  bgSource: 'manual',
  iobSource: 'manual',
  cobSource: 'manual',
  lastExportDate: null,
  exportTimer: null
};

MEAL_SLUGS.forEach(slug => {
  state.meals[slug] = {
    foods: [{ name: '', carbFactor: null, weightG: '', absorptionRate: 3.0 }],
    currentBG: '',
    iob: '',
    cob: '',
    mealTime: '',
    leadTime: 13,
    postBgReadings: [],
    notes: '',
    bgTimestamp: null,
    bgTrend: null,
    settingsOpen: false
  };
});

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }

  initTheme();
  state.units = storage.get('units', 'mmol');
  state.bgSource = storage.get('bg_source', 'manual');
  state.iobSource = storage.get('iob_source', 'manual');
  state.cobSource = storage.get('cob_source', 'manual');

  const params = new URLSearchParams(window.location.search);
  if (params.has('code')) {
    try {
      await handleOAuthCallback(params.get('code'), params.get('state'));
      window.history.replaceState({}, '', window.location.pathname);
      showToast('Google account connected!', 'success');
      await postAuthSetup();
    } catch (err) {
      showToast('OAuth failed: ' + err.message, 'error');
    }
  } else if (isConnected()) {
    await postAuthSetup(true);
  }

  loadGuestMealSettings();
  renderAll();
  setupNavigation();
  setupExportTimer();

  const section = getCurrentSection();
  navigate(section);
}

async function postAuthSetup(silent = false) {
  try {
    const folderId = storage.get('drive_folder_id');
    if (!folderId) {
      if (!silent) showToast('Setting up Drive folders…', 'info');
      await setupDriveFolders();
    }

    const config = await loadConfig();
    if (config) {
      state.config = config;
      applyConfig(config);
      if (!silent) showToast('Settings restored from Drive', 'success');
    }

    state.personalFoods = await readFoodChart();

    const email = storage.get('google_email', '');
    updateConnectedStatus(email);
    renderSettingsSection();
  } catch (err) {
    showToast('Drive setup error: ' + err.message, 'error');
  }
}

function applyConfig(config) {
  if (config.units) { state.units = config.units; storage.set('units', config.units); }
  if (config.theme) applyTheme(config.theme);
  if (config.bg_source) state.bgSource = config.bg_source;
  if (config.iob_source) state.iobSource = config.iob_source;
  if (config.cob_source) state.cobSource = config.cob_source;

  if (config.nightscout_url) storage.set('ns_config', { url: config.nightscout_url, secret: config.nightscout_secret });
  if (config.dexcom_user) storage.set('dexcom_config', { user: config.dexcom_user, pass: config.dexcom_pass, region: config.dexcom_region });

  if (config.meals) {
    MEAL_SLUGS.forEach(slug => {
      if (config.meals[slug]) {
        setMealSettings(slug, config.meals[slug]);
      }
    });
  }
}

function loadGuestMealSettings() {
  MEAL_SLUGS.forEach(slug => {
    const s = getMealSettings(slug);
    state.meals[slug]._icr = s.icr;
    state.meals[slug]._isf = s.isf;
    state.meals[slug]._target_bg = s.target_bg;
  });
}

function getCurrentMeal() { return state.meals[state.activeMeal]; }
function getCurrentMealSettings() { return getMealSettings(state.activeMeal); }

// ─── RENDER ────────────────────────────────────────────────────────────────

function renderAll() {
  renderMealTabs();
  renderBGPanel();
  renderMealSettingsPanel();
  renderFoodBuilder();
  renderBolusPanel();
  renderPreBolus();
  renderUnitsLabels();
  renderLogSection();
}

function renderMealTabs() {
  const container = document.getElementById('meal-tabs');
  if (!container) return;
  container.innerHTML = '';
  MEAL_SLUGS.forEach(slug => {
    const btn = document.createElement('button');
    btn.className = 'tab-pill' + (slug === state.activeMeal ? ' tab-pill--active' : '');
    btn.textContent = MEAL_LABELS[slug];
    btn.setAttribute('aria-selected', slug === state.activeMeal);
    btn.addEventListener('click', () => { state.activeMeal = slug; renderAll(); });
    container.appendChild(btn);
  });
}

function renderBGPanel() {
  const meal = getCurrentMeal();
  setVal('bg-value', meal.currentBG);
  setVal('iob-value', meal.iob);
  setVal('cob-value', meal.cob);

  const bgUnit = document.getElementById('bg-unit-label');
  if (bgUnit) bgUnit.textContent = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';

  const bgSource = document.getElementById('bg-source-select');
  if (bgSource) bgSource.value = state.bgSource;

  const iobSource = document.getElementById('iob-source-select');
  if (iobSource) iobSource.value = state.iobSource;

  const cobSource = document.getElementById('cob-source-select');
  if (cobSource) cobSource.value = state.cobSource;

  const bgTimestamp = document.getElementById('bg-timestamp');
  if (bgTimestamp) {
    if (meal.bgTimestamp) {
      const trend = meal.bgTrend ? ` ${meal.bgTrend}` : '';
      bgTimestamp.textContent = `${formatTime(meal.bgTimestamp)}${trend}`;
      bgTimestamp.hidden = false;
    } else {
      bgTimestamp.hidden = true;
    }
  }

  const manualBg = document.getElementById('bg-manual');
  if (manualBg) manualBg.hidden = state.bgSource === 'manual' ? false : true;
  const fetchedBg = document.getElementById('bg-fetched');
  if (fetchedBg) fetchedBg.hidden = state.bgSource === 'manual';
}

function renderMealSettingsPanel() {
  const settings = getCurrentMealSettings();
  const meal = getCurrentMeal();
  setVal('icr-input', settings.icr ?? '');
  setVal('isf-input', settings.isf ?? '');
  setVal('target-bg-input', settings.target_bg ?? '');

  const isfLabel = document.getElementById('isf-label');
  if (isfLabel) isfLabel.textContent = `ISF (${state.units === 'mmol' ? 'mmol/L' : 'mg/dL'} per U)`;

  const panel = document.getElementById('meal-settings-panel');
  if (panel) panel.hidden = !meal.settingsOpen;
  const toggle = document.getElementById('meal-settings-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', meal.settingsOpen);
}

function renderFoodBuilder() {
  const container = document.getElementById('food-rows');
  if (!container) return;
  const meal = getCurrentMeal();
  container.innerHTML = '';

  meal.foods.forEach((food, i) => {
    const row = buildFoodRow(food, i);
    container.appendChild(row);
  });

  const addBtn = document.getElementById('add-food-btn');
  if (addBtn) addBtn.disabled = meal.foods.length >= MAX_FOOD_ROWS;
}

function buildFoodRow(food, index) {
  const meal = getCurrentMeal();
  const row = document.createElement('div');
  row.className = 'food-row';
  row.dataset.index = index;

  const netCarbs = food.carbFactor && food.weightG
    ? calcNetCarbs(parseFloat(food.weightG), food.carbFactor).toFixed(1)
    : '—';

  row.innerHTML = `
    <div class="food-row__search">
      <input
        type="text"
        class="input food-search"
        placeholder="Search food…"
        value="${escHtml(food.name)}"
        autocomplete="off"
        aria-label="Food name"
        data-index="${index}"
      />
      ${food.carbFactor ? `<span class="food-row__cf">CF: ${food.carbFactor}</span>` : ''}
    </div>
    <div class="food-row__weight">
      <input
        type="number"
        class="input food-weight"
        placeholder="g"
        value="${food.weightG || ''}"
        min="0"
        step="1"
        aria-label="Weight in grams"
        data-index="${index}"
      />
    </div>
    <div class="food-row__carbs">
      <span class="food-row__net">${netCarbs}</span>
      <span class="food-row__unit">g</span>
    </div>
    <button class="btn btn--icon food-remove" data-index="${index}" aria-label="Remove food" ${meal.foods.length <= 1 ? 'disabled' : ''}>×</button>
  `;

  const searchInput = row.querySelector('.food-search');
  const weightInput = row.querySelector('.food-weight');

  const debouncedSearch = debounce((query, el) => {
    performFoodSearch(query, el, index);
  }, 300);

  searchInput.addEventListener('input', e => {
    const food = getCurrentMeal().foods[index];
    food.name = e.target.value;
    food.carbFactor = null;
    debouncedSearch(e.target.value, e.target);
    updateBolusLive();
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => {
      const dd = document.querySelector('.food-dropdown');
      if (dd) dd.remove();
    }, 150);
  });

  weightInput.addEventListener('input', e => {
    getCurrentMeal().foods[index].weightG = parseFloat(e.target.value) || '';
    updateNetCarbsDisplay(row, index);
    updateBolusLive();
  });

  row.querySelector('.food-remove').addEventListener('click', () => {
    if (getCurrentMeal().foods.length > 1) {
      getCurrentMeal().foods.splice(index, 1);
      renderFoodBuilder();
      updateBolusLive();
    }
  });

  return row;
}

function performFoodSearch(query, inputEl, index) {
  const existing = document.querySelector('.food-dropdown');
  if (existing) existing.remove();
  if (!query || query.length < 2) return;

  const q = query.toLowerCase();
  const personal = state.personalFoods.filter(f => f.name.toLowerCase().includes(q)).slice(0, 5);
  const builtin = HEALTH_CANADA_FOODS.filter(f => f.name.toLowerCase().includes(q)).slice(0, 5);
  const results = [...personal, ...builtin].slice(0, 8);

  if (!results.length) return;

  const dropdown = createFoodDropdown(results, food => {
    getCurrentMeal().foods[index] = {
      name: food.name,
      carbFactor: food.carbFactor,
      weightG: getCurrentMeal().foods[index].weightG,
      absorptionRate: food.absorptionRate
    };
    renderFoodBuilder();
    updateBolusLive();
    const weightEl = document.querySelector(`.food-weight[data-index="${index}"]`);
    if (weightEl) weightEl.focus();
  });

  if (dropdown) {
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + window.scrollY) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';
    document.body.appendChild(dropdown);
  }
}

function updateNetCarbsDisplay(row, index) {
  const food = getCurrentMeal().foods[index];
  const net = food.carbFactor && food.weightG
    ? calcNetCarbs(parseFloat(food.weightG), food.carbFactor).toFixed(1)
    : '—';
  const span = row.querySelector('.food-row__net');
  if (span) span.textContent = net;
}

function updateBolusLive() {
  renderBolusPanel();
}

function renderBolusPanel() {
  const meal = getCurrentMeal();
  const settings = getCurrentMealSettings();

  const foods = meal.foods.map(f => ({
    weightG: parseFloat(f.weightG) || 0,
    carbFactor: f.carbFactor || 0
  }));

  const currentBG = parseFloat(meal.currentBG) || null;
  const iob = parseFloat(meal.iob) || 0;
  const result = calcBolus({
    foods,
    currentBG,
    targetBG: settings.target_bg,
    icr: settings.icr,
    isf: settings.isf,
    iob
  });

  setText('summary-carbs', result.totalNetCarbs.toFixed(1) + ' g');
  setText('summary-meal-bolus', result.mealBolus.toFixed(2) + ' U');
  setText('summary-correction', result.correctionBolus.toFixed(2) + ' U');
  setText('summary-iob', '−' + result.iobOffset.toFixed(2) + ' U');
  setText('summary-total', result.totalBolus.toFixed(2) + ' U');

  renderPreBolus();
}

function renderPreBolus() {
  const meal = getCurrentMeal();
  const mealTimeInput = document.getElementById('meal-time');
  const leadTimeInput = document.getElementById('lead-time');
  const bolusAtEl = document.getElementById('bolus-at');

  if (!mealTimeInput || !bolusAtEl) return;

  const mealTimeVal = meal.mealTime || mealTimeInput.value;
  const leadTime = parseInt(meal.leadTime ?? leadTimeInput?.value ?? 13) || 13;

  if (!mealTimeVal) {
    bolusAtEl.textContent = '—';
    return;
  }

  const [h, m] = mealTimeVal.split(':').map(Number);
  const mealDate = new Date();
  mealDate.setHours(h, m, 0, 0);
  const bolusTime = new Date(mealDate.getTime() - leadTime * 60000);

  bolusAtEl.textContent = formatTime(bolusTime);
}

function renderUnitsLabels() {
  const unit = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';
  document.querySelectorAll('[data-unit-label]').forEach(el => { el.textContent = unit; });
}

function renderLogSection() {
  const container = document.getElementById('log-entries');
  if (!container) return;
  const log = getTodayLog();

  if (!log.length) {
    container.innerHTML = '<p class="empty-state">No meals logged today.</p>';
    return;
  }

  const byMeal = {};
  log.forEach(entry => {
    if (!byMeal[entry.meal]) byMeal[entry.meal] = [];
    byMeal[entry.meal].push(entry);
  });

  let html = '';
  let grandTotal = 0;

  Object.entries(byMeal).forEach(([meal, entries]) => {
    const mealTotal = entries.reduce((s, e) => s + (e.netCarbs || 0), 0);
    grandTotal += mealTotal;
    html += `<div class="log-meal">
      <h3 class="log-meal__title">${escHtml(meal)} <span class="log-meal__total">${mealTotal.toFixed(1)} g total</span></h3>
      <table class="log-table">
        <thead><tr><th>Food</th><th>Weight</th><th>CF</th><th>Net Carbs</th></tr></thead>
        <tbody>
          ${entries.map(e => `<tr>
            <td>${escHtml(e.food)}</td>
            <td>${e.weightG || '—'} g</td>
            <td>${e.carbFactor || '—'}</td>
            <td>${(e.netCarbs || 0).toFixed(1)} g</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  });

  html += `<div class="log-grand-total">Daily Total: <strong>${grandTotal.toFixed(1)} g</strong></div>`;

  const lastExport = storage.get('last_export_date');
  if (lastExport) {
    html += `<p class="last-export">Last exported: ${lastExport}</p>`;
  }

  container.innerHTML = html;
}

function renderSettingsSection() {
  const email = storage.get('google_email', '');
  const connected = isConnected();

  const connectBlock = document.getElementById('connect-block');
  const connectedBlock = document.getElementById('connected-block');
  if (connectBlock) connectBlock.hidden = connected;
  if (connectedBlock) connectedBlock.hidden = !connected;

  if (connected) {
    const emailEl = document.getElementById('connected-email');
    if (emailEl) emailEl.textContent = email;
    const folderLink = document.getElementById('drive-folder-link');
    if (folderLink) {
      const folderId = storage.get('drive_folder_id');
      if (folderId) {
        folderLink.href = `https://drive.google.com/drive/folders/${folderId}`;
        folderLink.hidden = false;
      }
    }
    const sheetLink = document.getElementById('food-sheet-link');
    if (sheetLink) {
      const sheetId = storage.get('food_sheet_id');
      if (sheetId) {
        sheetLink.href = `https://docs.google.com/spreadsheets/d/${sheetId}`;
        sheetLink.hidden = false;
      }
    }
  }

  const unitsSelect = document.getElementById('units-select');
  if (unitsSelect) unitsSelect.value = state.units;

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) themeSelect.value = storage.get('theme', 'system');
}

// ─── SETUP NAVIGATION ──────────────────────────────────────────────────────

function setupNavigation() {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.nav);
      if (btn.dataset.nav === 'settings') renderSettingsSection();
      if (btn.dataset.nav === 'log') renderLogSection();
    });
  });

  window.addEventListener('hashchange', () => {
    const section = getCurrentSection();
    navigate(section);
    if (section === 'settings') renderSettingsSection();
    if (section === 'log') renderLogSection();
  });

  // ── Calculator interactions ──

  document.getElementById('meal-tabs')?.addEventListener('click', () => {});

  document.getElementById('meal-settings-toggle')?.addEventListener('click', () => {
    const meal = getCurrentMeal();
    meal.settingsOpen = !meal.settingsOpen;
    renderMealSettingsPanel();
  });

  document.getElementById('icr-input')?.addEventListener('input', e => {
    setMealSettings(state.activeMeal, { icr: parseFloat(e.target.value) || null });
    persistConfig();
    updateBolusLive();
  });

  document.getElementById('isf-input')?.addEventListener('input', e => {
    setMealSettings(state.activeMeal, { isf: parseFloat(e.target.value) || null });
    persistConfig();
    updateBolusLive();
  });

  document.getElementById('target-bg-input')?.addEventListener('input', e => {
    setMealSettings(state.activeMeal, { target_bg: parseFloat(e.target.value) || null });
    persistConfig();
    updateBolusLive();
  });

  document.getElementById('bg-value')?.addEventListener('input', e => {
    getCurrentMeal().currentBG = e.target.value;
    updateBolusLive();
  });

  document.getElementById('iob-value')?.addEventListener('input', e => {
    getCurrentMeal().iob = e.target.value;
    updateBolusLive();
  });

  document.getElementById('cob-value')?.addEventListener('input', e => {
    getCurrentMeal().cob = e.target.value;
  });

  document.getElementById('bg-source-select')?.addEventListener('change', e => {
    state.bgSource = e.target.value;
    storage.set('bg_source', state.bgSource);
    renderBGPanel();
  });

  document.getElementById('iob-source-select')?.addEventListener('change', e => {
    state.iobSource = e.target.value;
    storage.set('iob_source', state.iobSource);
  });

  document.getElementById('cob-source-select')?.addEventListener('change', e => {
    state.cobSource = e.target.value;
    storage.set('cob_source', state.cobSource);
  });

  document.getElementById('fetch-bg-btn')?.addEventListener('click', fetchBG);
  document.getElementById('fetch-iob-btn')?.addEventListener('click', fetchIOB);
  document.getElementById('fetch-cob-btn')?.addEventListener('click', fetchCOB);
  document.getElementById('fetch-profile-btn')?.addEventListener('click', fetchNightscoutProfile);

  document.getElementById('add-food-btn')?.addEventListener('click', () => {
    const meal = getCurrentMeal();
    if (meal.foods.length < MAX_FOOD_ROWS) {
      meal.foods.push({ name: '', carbFactor: null, weightG: '', absorptionRate: 3.0 });
      renderFoodBuilder();
    }
  });

  document.getElementById('meal-time')?.addEventListener('input', e => {
    getCurrentMeal().mealTime = e.target.value;
    renderPreBolus();
  });

  document.getElementById('lead-time')?.addEventListener('input', e => {
    getCurrentMeal().leadTime = parseInt(e.target.value) || 13;
    renderPreBolus();
  });

  document.getElementById('add-bg-reading-btn')?.addEventListener('click', addPostBgReading);

  document.getElementById('log-meal-btn')?.addEventListener('click', logMeal);

  // ── Log section ──
  document.getElementById('export-log-btn')?.addEventListener('click', exportToDrive);

  // ── Settings interactions ──
  document.getElementById('connect-google-btn')?.addEventListener('click', startOAuth);

  document.getElementById('disconnect-google-btn')?.addEventListener('click', () => {
    disconnect();
    state.personalFoods = [];
    state.config = null;
    updateConnectedStatus(null);
    renderSettingsSection();
    showToast('Google account disconnected', 'info');
  });

  document.getElementById('build-folders-btn')?.addEventListener('click', async (e) => {
    showSpinner(e.target);
    try {
      const folderName = document.getElementById('drive-folder-name')?.value || 'Loop Bolus Calculator';
      await setupDriveFolders(folderName);
      showToast('Drive folders created!', 'success');
      renderSettingsSection();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally { hideSpinner(e.target); }
  });

  document.getElementById('test-ns-btn')?.addEventListener('click', async (e) => {
    showSpinner(e.target);
    try {
      const { testConnection } = await import('./nightscout.js');
      const ok = await testConnection();
      showToast(ok ? 'Nightscout connected!' : 'Connection failed', ok ? 'success' : 'error');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally { hideSpinner(e.target); }
  });

  document.getElementById('test-dex-btn')?.addEventListener('click', async (e) => {
    showSpinner(e.target);
    try {
      const { testConnection } = await import('./dexcom.js');
      await testConnection();
      showToast('Dexcom connected!', 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally { hideSpinner(e.target); }
  });

  document.getElementById('save-ns-btn')?.addEventListener('click', () => {
    const url = document.getElementById('ns-url')?.value?.trim();
    const secret = document.getElementById('ns-secret')?.value?.trim();
    storage.set('ns_config', { url, secret });
    persistConfig({ nightscout_url: url, nightscout_secret: secret });
    showToast('Nightscout settings saved', 'success');
  });

  document.getElementById('save-dex-btn')?.addEventListener('click', () => {
    const user = document.getElementById('dex-user')?.value?.trim();
    const pass = document.getElementById('dex-pass')?.value?.trim();
    const region = document.getElementById('dex-region')?.value;
    storage.set('dexcom_config', { user, pass, region });
    persistConfig({ dexcom_user: user, dexcom_pass: pass, dexcom_region: region });
    showToast('Dexcom settings saved', 'success');
  });

  document.getElementById('units-select')?.addEventListener('change', e => {
    state.units = e.target.value;
    storage.set('units', state.units);
    persistConfig({ units: state.units });
    renderAll();
    showToast(`Units set to ${state.units === 'mmol' ? 'mmol/L' : 'mg/dL'}`, 'info');
  });

  document.getElementById('theme-select')?.addEventListener('change', e => {
    applyTheme(e.target.value);
    persistConfig({ theme: e.target.value });
  });

  document.getElementById('contact-form')?.addEventListener('submit', e => {
    e.preventDefault();
  });
}

// ─── BG/IOB/COB FETCH ──────────────────────────────────────────────────────

async function fetchBG() {
  const btn = document.getElementById('fetch-bg-btn');
  if (btn) showSpinner(btn);
  try {
    let result;
    if (state.bgSource === 'nightscout') result = await nsBG(state.units);
    else if (state.bgSource === 'dexcom') result = await dexBG(state.units);
    else return;

    const meal = getCurrentMeal();
    meal.currentBG = result.value;
    meal.bgTimestamp = result.timestamp;
    meal.bgTrend = result.trend || null;

    setVal('bg-value', result.value);
    renderBGPanel();
    updateBolusLive();
    showToast(`BG: ${formatBG(result.value, state.units)} ${state.units === 'mmol' ? 'mmol/L' : 'mg/dL'}`, 'success');
  } catch (err) {
    showToast('BG fetch failed: ' + err.message, 'error');
  } finally {
    if (btn) hideSpinner(btn);
  }
}

async function fetchIOB() {
  const btn = document.getElementById('fetch-iob-btn');
  if (btn) showSpinner(btn);
  try {
    const result = await nsIOB();
    getCurrentMeal().iob = result.value;
    setVal('iob-value', result.value);
    updateBolusLive();
    showToast(`IOB: ${result.value} U`, 'success');
  } catch (err) {
    showToast('IOB fetch failed: ' + err.message, 'error');
  } finally {
    if (btn) hideSpinner(btn);
  }
}

async function fetchCOB() {
  const btn = document.getElementById('fetch-cob-btn');
  if (btn) showSpinner(btn);
  try {
    const result = await nsCOB();
    getCurrentMeal().cob = result.value;
    setVal('cob-value', result.value);
    showToast(`COB: ${result.value} g`, 'success');
  } catch (err) {
    showToast('COB fetch failed: ' + err.message, 'error');
  } finally {
    if (btn) hideSpinner(btn);
  }
}

async function fetchNightscoutProfile() {
  const btn = document.getElementById('fetch-profile-btn');
  if (btn) showSpinner(btn);
  try {
    const profile = await nsProfile(state.units);
    if (profile.icr) {
      setMealSettings(state.activeMeal, { icr: profile.icr });
      setVal('icr-input', profile.icr);
    }
    if (profile.isf) {
      setMealSettings(state.activeMeal, { isf: profile.isf });
      setVal('isf-input', profile.isf);
    }
    if (profile.target_bg) {
      setMealSettings(state.activeMeal, { target_bg: profile.target_bg });
      setVal('target-bg-input', profile.target_bg);
    }
    persistConfig();
    updateBolusLive();
    showToast('Profile loaded from Nightscout', 'success');
  } catch (err) {
    showToast('Profile fetch failed: ' + err.message, 'error');
  } finally {
    if (btn) hideSpinner(btn);
  }
}

// ─── POST-MEAL BG ───────────────────────────────────────────────────────────

function addPostBgReading() {
  const meal = getCurrentMeal();
  const container = document.getElementById('post-bg-rows');
  if (!container) return;

  const now = new Date();
  const bolusTimeStr = document.getElementById('bolus-at')?.textContent;
  const reading = { time: '', minSinceBolus: '', bg: '', trend: '→', delta: '' };
  meal.postBgReadings.push(reading);

  const index = meal.postBgReadings.length - 1;
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="time" class="input input--sm" value="${now.toTimeString().slice(0,5)}" data-field="time" data-index="${index}"/></td>
    <td><span class="post-bg-min">—</span></td>
    <td><input type="number" class="input input--sm" placeholder="${state.units === 'mmol' ? 'mmol/L' : 'mg/dL'}" data-field="bg" data-index="${index}" step="${state.units === 'mmol' ? '0.1' : '1'}"/></td>
    <td>
      <select class="input input--sm" data-field="trend" data-index="${index}">
        <option value="→">→ Flat</option>
        <option value="↗">↗ Rising Slightly</option>
        <option value="↘">↘ Falling Slightly</option>
        <option value="↑">↑ Rising</option>
        <option value="↓">↓ Falling</option>
        <option value="⇈">⇈ Rising Rapidly</option>
        <option value="⇊">⇊ Falling Rapidly</option>
      </select>
    </td>
    <td><span class="post-bg-delta">—</span></td>
  `;
  container.appendChild(row);
}

// ─── LOG MEAL ───────────────────────────────────────────────────────────────

function logMeal() {
  const meal = getCurrentMeal();
  const mealLabel = MEAL_LABELS[state.activeMeal];
  const foods = meal.foods.filter(f => f.name && f.weightG);

  if (!foods.length) {
    showToast('Add at least one food before logging', 'error');
    return;
  }

  const entries = foods.map(f => ({
    date: todayStr(),
    meal: mealLabel,
    food: f.name,
    carbFactor: f.carbFactor,
    weightG: parseFloat(f.weightG) || 0,
    netCarbs: calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0),
    notes: meal.notes || ''
  }));

  entries.forEach(e => appendToLog(e));
  showToast(`${mealLabel} logged — ${foods.length} item${foods.length > 1 ? 's' : ''}`, 'success');
}

// ─── EXPORT ─────────────────────────────────────────────────────────────────

async function exportToDrive() {
  const btn = document.getElementById('export-log-btn');
  if (btn) showSpinner(btn);
  try {
    if (!isConnected()) throw new Error('Connect Google Drive first');
    const log = getTodayLog();
    if (!log.length) throw new Error('Nothing to export');
    const dateStr = todayStr();
    await exportLogToSheet(dateStr, log);
    storage.set('last_export_date', dateStr);
    showToast('Log exported to Drive!', 'success');
    renderLogSection();
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  } finally {
    if (btn) hideSpinner(btn);
  }
}

function setupExportTimer() {
  let lastCheck = todayStr();

  setInterval(async () => {
    const today = todayStr();
    if (today !== lastCheck) {
      const yesterday = lastCheck;
      lastCheck = today;
      const lastExport = storage.get('last_export_date');
      if (lastExport !== yesterday && isConnected()) {
        const log = getTodayLog();
        if (log.length) {
          try {
            await exportLogToSheet(yesterday, log);
            storage.set('last_export_date', yesterday);
            setTodayLog([]);
            showToast('Yesterday\'s log exported automatically', 'success');
          } catch {}
        }
      }
    }
  }, 60000);
}

// ─── PERSIST CONFIG ─────────────────────────────────────────────────────────

async function persistConfig(overrides = {}) {
  if (!isConnected()) return;
  try {
    const existing = await loadConfig() || {};
    const meals = {};
    MEAL_SLUGS.forEach(slug => {
      meals[slug] = getMealSettings(slug);
    });
    const updated = {
      ...existing,
      units: state.units,
      theme: storage.get('theme', 'system'),
      bg_source: state.bgSource,
      iob_source: state.iobSource,
      cob_source: state.cobSource,
      meals,
      ...overrides
    };
    await saveConfig(updated);
  } catch {}
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
