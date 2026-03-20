const API_URL = window.CONTEMPLACE_API_URL;
const AUTH_KEY = 'contemplace-dashboard-key';

function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

function setToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_KEY);
}

async function apiFetch(path) {
  const token = getToken();
  if (!token) throw new Error('No API key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      clearToken();
      location.reload();
      return;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export const api = { fetch: apiFetch };

import { init as initStats } from './stats.js';
import { init as initClusters } from './clusters.js';
import { init as initRecent } from './recent.js';

function showAuth() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('main-content').style.display = 'none';
}

function showDashboard() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
}

async function loadPanels() {
  const results = await Promise.allSettled([
    initStats(api),
    initClusters(api),
    initRecent(api),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Panel init failed:', r.reason);
  }
}

async function boot() {
  if (!getToken()) {
    showAuth();
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = document.getElementById('api-key-input').value.trim();
      if (key) {
        setToken(key);
        showDashboard();
        loadPanels();
      }
    });
    return;
  }
  showDashboard();
  loadPanels();
}

boot();
