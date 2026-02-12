/* Echo Chamber Admin Dashboard */
'use strict';

const $ = (sel) => document.getElementById(sel);

const loginSection = $('login-section');
const dashSection = $('dashboard-section');
const loginForm = $('login-form');
const passInput = $('password-input');
const loginError = $('login-error');
const onlineCount = $('online-count');
const connStatus = $('conn-status');
const roomsContainer = $('rooms-container');
const historyBody = $('history-body');

let dashTimer = null;
let histTimer = null;

// ── Helpers ──

function apiUrl(path) {
  return window.location.origin + path;
}

function getToken() {
  return sessionStorage.getItem('adminToken');
}

function setToken(token) {
  sessionStorage.setItem('adminToken', token);
}

function clearToken() {
  sessionStorage.removeItem('adminToken');
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' };
}

function formatDuration(secs) {
  if (secs == null) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.max(1, Math.floor(secs))}s`;
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function iceClass(type) {
  if (type === 'host') return 'ice-host';
  if (type === 'srflx') return 'ice-srflx';
  return 'ice-relay';
}

function qualBadge(limitation) {
  if (!limitation || limitation === 'none') return '<span class="badge badge-good">OK</span>';
  if (limitation === 'cpu') return '<span class="badge badge-warn">CPU</span>';
  return '<span class="badge badge-bad">' + limitation.toUpperCase() + '</span>';
}

// ── Login ──

async function login(password) {
  loginError.textContent = '';
  try {
    const res = await fetch(apiUrl('/v1/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      loginError.textContent = res.status === 401 ? 'Invalid password' : `Error ${res.status}`;
      return;
    }
    const data = await res.json();
    setToken(data.token);
    showDashboard();
  } catch (e) {
    loginError.textContent = 'Connection failed';
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = passInput.value.trim();
  if (pw) login(pw);
});

// ── Dashboard ──

function showDashboard() {
  loginSection.style.display = 'none';
  dashSection.style.display = 'block';
  connStatus.textContent = '';
  fetchDashboard();
  fetchHistory();
  dashTimer = setInterval(fetchDashboard, 3000);
  histTimer = setInterval(fetchHistory, 30000);
}

function showLogin() {
  clearToken();
  clearInterval(dashTimer);
  clearInterval(histTimer);
  dashSection.style.display = 'none';
  loginSection.style.display = 'flex';
  passInput.value = '';
  loginError.textContent = '';
}

async function fetchDashboard() {
  try {
    const res = await fetch(apiUrl('/admin/api/dashboard'), { headers: authHeaders() });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(res.status);
    connStatus.textContent = '';
    renderDashboard(await res.json());
  } catch {
    connStatus.textContent = 'Connection lost';
  }
}

async function fetchHistory() {
  try {
    const res = await fetch(apiUrl('/admin/api/sessions'), { headers: authHeaders() });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(res.status);
    renderHistory(await res.json());
  } catch { /* silent — dashboard fetch already shows conn status */ }
}

// ── Render Live ──

function renderDashboard(data) {
  onlineCount.textContent = `${data.total_online || 0} online`;

  if (!data.rooms || data.rooms.length === 0) {
    roomsContainer.innerHTML = '<div class="rooms-empty">No active rooms</div>';
    return;
  }

  roomsContainer.innerHTML = data.rooms.map(room => {
    const pCount = room.participants ? room.participants.length : 0;
    const rows = (room.participants || []).map(p => renderParticipant(p)).join('');
    return `<div class="room-card">
      <div class="room-header">
        <span class="room-name">${esc(room.room_id)}</span>
        <span class="room-count">${pCount} participant${pCount !== 1 ? 's' : ''}</span>
      </div>
      ${rows}
    </div>`;
  }).join('');
}

function renderParticipant(p) {
  const s = p.stats;
  const time = formatDuration(p.online_seconds);
  let qualityClass = '';
  let statsHtml = '';

  if (s && (s.screen_fps != null || s.camera_fps != null)) {
    const chips = [];

    if (s.ice_remote_type) {
      chips.push(`<span class="badge ${iceClass(s.ice_remote_type)}">${s.ice_remote_type}</span>`);
    }
    if (s.screen_fps != null) {
      chips.push(`<span class="stat-chip">${s.screen_fps}fps ${s.screen_width}x${s.screen_height} ${(s.screen_bitrate_kbps / 1000).toFixed(1)}Mbps</span>`);
    }
    if (s.encoder) {
      chips.push(`<span class="stat-chip encoder">${esc(s.encoder)}</span>`);
    }
    if (s.quality_limitation != null) {
      chips.push(qualBadge(s.quality_limitation));
    }
    if (s.camera_fps != null) {
      chips.push(`<span class="stat-chip">${s.camera_fps}fps ${s.camera_width}x${s.camera_height} ${(s.camera_bitrate_kbps / 1000).toFixed(1)}Mbps</span>`);
    }

    statsHtml = chips.join('');

    if (s.quality_limitation === 'bandwidth') qualityClass = 'bad-quality';
    else if (s.screen_fps != null && s.screen_fps < 30) qualityClass = qualityClass || 'warn-quality';
    else if (s.quality_limitation === 'cpu') qualityClass = 'warn-quality';
  } else {
    statsHtml = '<span class="no-media">No active media</span>';
  }

  return `<div class="participant-row ${qualityClass}">
    <div class="participant-left">
      <span class="participant-name">${esc(p.name || p.identity)}</span>
      <span class="participant-time">${time}</span>
    </div>
    <div class="participant-right">${statsHtml}</div>
  </div>`;
}

// ── Render History ──

function renderHistory(data) {
  const events = data.events || [];
  if (events.length === 0) {
    historyBody.innerHTML = '<tr class="history-empty"><td colspan="5">No session history yet</td></tr>';
    return;
  }

  historyBody.innerHTML = events.map(ev => {
    const isJoin = ev.event_type === 'join';
    const badgeCls = isJoin ? 'event-join' : 'event-leave';
    const label = isJoin ? 'JOIN' : 'LEAVE';
    const dur = ev.duration_secs != null ? formatDuration(ev.duration_secs) : '';
    return `<tr>
      <td>${formatTime(ev.timestamp)}</td>
      <td><span class="badge ${badgeCls}">${label}</span></td>
      <td>${esc(ev.name || ev.identity)}</td>
      <td>${esc(ev.room_id)}</td>
      <td>${dur}</td>
    </tr>`;
  }).join('');
}

// ── Util ──

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Init ──

if (getToken()) {
  showDashboard();
}
