import { storage } from './storage.js';

let toastTimer = null;

export function showToast(message, type = 'info', duration = 3000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast toast--${type} toast--visible`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, duration);
}

export function showSpinner(el) {
  el.disabled = true;
  el.dataset.originalText = el.textContent;
  el.innerHTML = '<span class="spinner"></span>';
}

export function hideSpinner(el) {
  el.disabled = false;
  el.textContent = el.dataset.originalText || '';
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
  storage.set('theme', theme);
}

export function initTheme() {
  const saved = storage.get('theme', 'system');
  applyTheme(saved);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (storage.get('theme', 'system') === 'system') applyTheme('system');
  });
}

export function formatTime(date) {
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

export function todayStr() {
  return formatDate(new Date());
}

export function navigate(sectionId) {
  document.querySelectorAll('.section').forEach(s => s.hidden = true);
  const target = document.getElementById(sectionId);
  if (target) target.hidden = false;

  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === sectionId);
  });

  window.location.hash = '#' + sectionId;
}

export function getCurrentSection() {
  const hash = window.location.hash.replace('#', '');
  return hash || 'calculator';
}

export function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

export function clearError(el) {
  el.textContent = '';
  el.hidden = true;
}

export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function createFoodDropdown(results, onSelect) {
  const existing = document.querySelector('.food-dropdown');
  if (existing) existing.remove();

  if (!results.length) return;

  const dropdown = document.createElement('ul');
  dropdown.className = 'food-dropdown';
  dropdown.setAttribute('role', 'listbox');

  results.forEach((food, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');
    li.innerHTML = `
      <span class="food-name">${escapeHtml(food.name)}</span>
      <span class="food-badge food-badge--${food.source === 'personal' ? 'personal' : 'hc'}">
        ${food.source === 'personal' ? 'Personal' : 'HC'}
      </span>
      <span class="food-absorption">${food.absorptionRate}h</span>
    `;
    li.addEventListener('mousedown', e => { e.preventDefault(); onSelect(food); dropdown.remove(); });
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { onSelect(food); dropdown.remove(); }
      if (e.key === 'ArrowDown') { const next = li.nextElementSibling; if (next) next.focus(); }
      if (e.key === 'ArrowUp') { const prev = li.previousElementSibling; if (prev) prev.focus(); }
    });
    dropdown.appendChild(li);
  });

  return dropdown;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function updateConnectedStatus(email) {
  const banner = document.getElementById('drive-banner');
  const statusEl = document.getElementById('drive-status');
  if (banner) banner.hidden = !!email;
  if (statusEl) {
    if (email) {
      statusEl.innerHTML = `Connected as <strong>${escapeHtml(email)}</strong>`;
      statusEl.className = 'drive-status drive-status--connected';
    } else {
      statusEl.innerHTML = 'Not connected';
      statusEl.className = 'drive-status';
    }
  }
}
