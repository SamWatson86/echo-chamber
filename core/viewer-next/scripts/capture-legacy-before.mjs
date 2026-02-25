import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const workspaceRoot = '/home/smstromb/.openclaw/workspace/echo-chamber-react';
const legacyRoot = path.join(workspaceRoot, 'core', 'viewer');
const outDir = path.join(workspaceRoot, 'docs', 'proof', 'parity');
const port = 4176;
const host = '127.0.0.1';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

function makeServer() {
  return http.createServer(async (req, res) => {
    try {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0] || '/');
      const rel = reqPath === '/' ? '/index.html' : reqPath;
      const filePath = path.join(legacyRoot, rel);
      if (!filePath.startsWith(legacyRoot)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      const buf = await fs.readFile(filePath);
      res.statusCode = 200;
      res.setHeader('content-type', mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
}

function tsPrefix() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const prefix = `${tsPrefix()}-legacy-before`;

  const server = makeServer();
  await new Promise((resolve) => server.listen(port, host, resolve));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

  const shots = [];
  const screenshot = async (label) => {
    const file = `${prefix}-${String(shots.length + 1).padStart(2, '0')}-${label}.png`;
    const full = path.join(outDir, file);
    await page.screenshot({ path: full, fullPage: true });
    shots.push(file);
  };

  await page.goto(`http://${host}:${port}/`, { waitUntil: 'domcontentloaded' });

  await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    q('#control-url').value = 'https://control.mock.local';
    q('#sfu-url').value = 'ws://127.0.0.1:7880';
    q('#name').value = 'Parity Viewer';
    q('#admin-password').value = 'test-password';
    q('#status').textContent = 'Connected';

    q('.publish-actions')?.classList.remove('hidden');
    q('#room-list')?.classList.remove('hidden');
    q('#open-admin-dash')?.classList.remove('hidden');

    const enableIds = [
      '#disconnect', '#disconnect-top', '#toggle-mic', '#toggle-cam', '#toggle-screen',
      '#mic-select', '#cam-select', '#speaker-select', '#refresh-devices', '#open-chat',
      '#toggle-room-audio', '#open-soundboard', '#open-camera-lobby', '#open-jam',
      '#open-settings', '#open-bug-report'
    ];
    for (const id of enableIds) {
      const el = q(id);
      if (el) el.disabled = false;
    }

    q('#online-users').innerHTML = [
      '<span class="online-pill">Sam · main</span>',
      '<span class="online-pill">Alex · main</span>',
      '<span class="online-pill">Max · breakout-2</span>'
    ].join('');

    q('#room-list').innerHTML = [
      '<button type="button" class="room-btn active">Main <span class="count">2</span></button>',
      '<button type="button" class="room-btn">Breakout 1 <span class="count">1</span></button>',
      '<button type="button" class="room-btn">Breakout 2 <span class="count">1</span></button>',
      '<button type="button" class="room-btn">Breakout 3 <span class="count">0</span></button>'
    ].join('');

    q('#user-list').innerHTML = [
      '<div class="user-card"><div class="name">Sam</div><div class="meta">Speaking</div></div>',
      '<div class="user-card"><div class="name">Alex</div><div class="meta">Muted</div></div>',
      '<div class="user-card"><div class="name">Parity Viewer</div><div class="meta">You</div></div>'
    ].join('');

    const setPanel = (id, open) => {
      const el = q(id);
      if (!el) return;
      if (open) el.classList.remove('hidden');
      else el.classList.add('hidden');
    };

    // Close all overlays initially.
    ['#chat-panel', '#theme-panel', '#settings-panel', '#soundboard-compact', '#soundboard', '#jam-panel', '#admin-dash-panel', '#bug-report-panel'].forEach((id) => setPanel(id, false));
  });

  await screenshot('connected-shell');

  await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    q('#chat-panel')?.classList.remove('hidden');
    q('#chat-messages').innerHTML = [
      '<div class="chat-message"><div class="chat-message-meta">Parity Viewer · 08:25</div><div class="chat-message-text">React parity chat smoke message</div></div>',
      '<div class="chat-message"><div class="chat-message-meta">Sam · 08:26</div><div class="chat-message-text">Looks good</div></div>'
    ].join('');
    q('#chat-input').value = 'message draft';
  });
  await screenshot('chat-open-message-sent');

  await page.evaluate(() => {
    document.body.dataset.theme = 'cyberpunk';
    document.querySelector('#theme-panel')?.classList.remove('hidden');
  });
  await screenshot('theme-panel-cyberpunk');

  await page.evaluate(() => {
    const settings = document.querySelector('#settings-panel');
    settings?.classList.remove('hidden');
    const body = document.querySelector('#settings-device-panel');
    if (body) {
      body.innerHTML = [
        '<div class="settings-row"><label>Mic</label><span>Default Microphone</span></div>',
        '<div class="settings-row"><label>Camera</label><span>FaceTime HD Camera</span></div>',
        '<div class="settings-row"><label>Output</label><span>Default Speaker</span></div>',
        '<div id="chime-settings-section" class="chime-settings-section"><div class="chime-settings-title">Custom Sounds</div><div>Enter/Exit sound controls</div></div>'
      ].join('');
    }
  });
  await screenshot('settings-chime');

  await page.evaluate(() => {
    const panel = document.querySelector('#soundboard-compact');
    panel?.classList.remove('hidden');
    const grid = document.querySelector('#soundboard-compact-grid');
    if (grid) {
      grid.innerHTML = [
        '<button class="sound-compact">🎺 Airhorn</button>',
        '<button class="sound-compact">👏 Applause</button>',
        '<button class="sound-compact">🔥 Hype</button>'
      ].join('');
    }
  });
  await screenshot('soundboard-compact');

  await page.evaluate(() => {
    const compact = document.querySelector('#soundboard-compact');
    compact?.classList.add('hidden');
    const panel = document.querySelector('#soundboard');
    panel?.classList.remove('hidden');
    const grid = document.querySelector('#soundboard-grid');
    if (grid) {
      grid.innerHTML = [
        '<div class="sound-tile"><div class="sound-name">Airhorn</div></div>',
        '<div class="sound-tile"><div class="sound-name">Applause</div></div>',
        '<div class="sound-tile"><div class="sound-name">Bell Upload</div></div>'
      ].join('');
    }
  });
  await screenshot('soundboard-edit-open');

  await page.evaluate(() => {
    document.querySelector('#soundboard')?.classList.add('hidden');
    document.querySelector('#jam-panel')?.classList.remove('hidden');
    document.querySelector('#jam-now-playing').innerHTML = '<div class="jam-now-track">No song playing</div>';
    const host = document.querySelector('#jam-host-controls');
    if (host) host.style.display = 'flex';
    const search = document.querySelector('#jam-search-section');
    if (search) search.style.display = 'block';
  });
  await screenshot('jam-panel-open');

  await page.evaluate(() => {
    document.querySelector('#jam-now-playing').innerHTML = '<div class="jam-now-track">Lo-fi Focus — Echo Bot</div>';
    const queue = document.querySelector('#jam-queue-section');
    if (queue) queue.style.display = 'flex';
    const list = document.querySelector('#jam-queue-list');
    if (list) list.innerHTML = '<div class="jam-queue-item">Lo-fi Focus</div><div class="jam-queue-item">Night Drive</div>';
  });
  await screenshot('jam-started-now-playing');

  await page.evaluate(() => {
    const bug = document.querySelector('#bug-report-panel');
    bug?.classList.remove('hidden');
    const status = document.querySelector('#bug-report-status');
    if (status) status.textContent = 'Report sent! Thank you.';
    const desc = document.querySelector('#bug-report-desc');
    if (desc) desc.value = 'Parity bug report smoke test issue details';
  });
  await screenshot('bug-report-submitted');

  await page.evaluate(() => {
    const panel = document.querySelector('#admin-dash-panel');
    panel?.classList.remove('hidden');
    document.querySelectorAll('.admin-dash-content').forEach((el) => el.classList.add('hidden'));
    const live = document.querySelector('#admin-dash-live');
    live?.classList.remove('hidden');
    if (live) {
      live.innerHTML = '<div class="adm-stat-row"><span class="adm-stat-label">Online · v2026.2.25</span><span class="adm-stat-value">2</span></div><div class="adm-room-card">main <span class="adm-room-count">2</span></div>';
    }
  });
  await screenshot('admin-live-tab');

  await page.evaluate(() => {
    document.querySelectorAll('.admin-dash-content').forEach((el) => el.classList.add('hidden'));
    const metrics = document.querySelector('#admin-dash-metrics');
    metrics?.classList.remove('hidden');
    if (metrics) {
      metrics.innerHTML = '<div class="adm-cards"><div class="adm-card"><div class="adm-card-value">12</div><div class="adm-card-label">Sessions (30d)</div></div><div class="adm-card"><div class="adm-card-value">3</div><div class="adm-card-label">Unique Users</div></div></div>';
    }
  });
  await screenshot('admin-metrics-tab');

  await page.evaluate(() => {
    document.querySelectorAll('.admin-dash-content').forEach((el) => el.classList.add('hidden'));
    const deploys = document.querySelector('#admin-dash-deploys');
    deploys?.classList.remove('hidden');
    if (deploys) {
      deploys.innerHTML = '<div class="adm-deploy-row"><span class="adm-deploy-badge adm-deploy-success">deployed</span><span>viewer-next parity release candidate</span></div>';
    }
  });
  await screenshot('admin-deploys-tab');

  const behavior = {
    timestamp: prefix,
    type: 'legacy-before-states',
    screenshots: shots,
    notes: 'Legacy static UI state captures for before/after visual comparison against viewer-next parity evidence.',
  };

  await fs.writeFile(path.join(outDir, `${prefix}-behavior.json`), JSON.stringify(behavior, null, 2), 'utf8');

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(JSON.stringify({ prefix, count: shots.length, shots }, null, 2));
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
