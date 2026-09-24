import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(directory, '../fixtures/install-scenario.js');
const seed = '0VjIjW4GlUZAMYd2vXMi3b';
const playlistId = '37i9dQZF1E8UXBoz02kGID';
const track = (position = 0) => ({
  kind: 'track', spotify_id: position === 0 ? seed : String(position).padStart(22, '0'),
  name: position === 0 ? 'Blinding Lights' : `Radio song ${position + 1}`,
  artist: 'Test artist', duration_ms: 200000, playlist_position: position,
});
const playlist = { kind: 'playlist', spotify_id: playlistId, name: 'Blinding Lights Radio',
  owner: 'Spotify', track_count: 300, snapshot_id: 'radio-snapshot' };

async function openJam(page) {
  const mutations = [];
  const state = {
    jam_protocol_version: 3, active: true, generation: 7,
    spotify_connected: true, spotify_library_authorized: true, spotify_is_playing: true,
    playlist_selection_supported: true, queue_clear_supported: true,
    source_enabled: true, source_availability_known: true, source_status: 'live', source_ready: true,
    queue_revision: 4, listeners: [], listener_count: 0,
    now_playing: { ...track(), spotify_uri: `spotify:track:${seed}`, is_playing: true, progress_ms: 20000 },
    queue: [
      { ...track(), queue_entry_id: 'current', spotify_uri: `spotify:track:${seed}`, delivery_state: 'spotify_committed', can_remove: false },
      { ...track(1), queue_entry_id: 'waiting', delivery_state: 'pending', can_remove: true },
    ],
  };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/jam/state') body = state;
    else if (url.pathname.endsWith('/radio')) body = { schema_version: 1, seed_track_id: seed, max_tracks: 250, playlist };
    else if (url.pathname === `/api/jam/playlists/${playlistId}/items`) {
      const offset = Number(url.searchParams.get('offset'));
      body = { playlist, items: Array.from({ length: 50 }, (_, i) => track(offset + i)),
        skipped: [], total: 300, offset, limit: 50, next_offset: offset + 50 < 300 ? offset + 50 : null, items_source: 'spotify' };
    } else if (url.pathname === '/api/jam/queue/playlist/selection') {
      const payload = route.request().postDataJSON();
      mutations.push({ path: url.pathname, payload });
      body = { ok: true, complete: true, generation: 7, queued_count: payload.selected_positions.length,
        queued_positions: payload.selected_positions, skipped: [], skipped_count: 0 };
    } else if (url.pathname === '/api/jam/queue/clear') {
      const payload = route.request().postDataJSON();
      mutations.push({ path: url.pathname, payload });
      state.queue = state.queue.filter(row => !row.can_remove);
      state.queue_revision += 1;
      body = { ok: true, generation: 7, request_id: payload.request_id, queue_revision: state.queue_revision,
        removed_count: 1, removed_entry_ids: ['waiting'], retained_count: 1,
        retained_entry_ids: ['current'], complete: false };
    } else if (url.pathname === '/api/jam/favorites') {
      body = { schema_version: 1, items: [track()], contributors: [], counts: { tracks: 1, playlists: 0, contributors: 0 },
        offset: 0, limit: 20, total: 1, next_offset: null };
    } else if (url.pathname === '/api/online') body = [];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: fixture });
  await page.evaluate(async () => {
    echoSet('echo-changelog-seen', CHANGELOG_LATEST);
    await window.EchoLayoutTestScenario.install({ participants: 2, cameras: 0, screenShares: 0, screenOwners: [2] });
    adminToken = 'test-admin';
    currentAccessToken = 'test-participant';
    openJamPanel(document.getElementById('open-jam'));
  });
  await expect(page.locator('#jam-now-playing .jam-now-playing-name')).toHaveText('Blinding Lights');
  return mutations;
}

test('song menu supports keyboard navigation and Song Radio queues only the first 250 positions', async ({ page }) => {
  const mutations = await openJam(page);
  const title = page.locator('#jam-now-playing .jam-now-playing-name');
  await title.focus();
  await page.keyboard.press('Space');
  const menu = page.getByRole('menu', { name: 'Song actions for Blinding Lights' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Song Radio', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Open in Spotify', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(title).toBeFocused();
  await title.click();
  await page.getByRole('menuitem', { name: 'Song Radio', exact: true }).click();
  await expect(page.locator('#jam-playlist-items [role=listitem]')).toHaveCount(50);
  await expect(page.locator('#jam-playlist-summary')).toContainText('250');
  for (let pageNumber = 1; pageNumber < 5; pageNumber += 1) {
    await page.locator('#jam-playlist-load-more').click();
    await expect(page.locator('#jam-playlist-items [role=listitem]')).toHaveCount((pageNumber + 1) * 50);
  }
  await expect(page.locator('#jam-playlist-load-more')).toBeHidden();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#jam-playlist-add-all').click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0].path).toBe('/api/jam/queue/playlist/selection');
  expect(mutations[0].payload.selected_positions).toEqual(Array.from({ length: 250 }, (_, i) => i));
  expect(mutations[0].payload.snapshot_id).toBe('radio-snapshot');
  expect(mutations[0].payload.confirmed).toBe(true);
  await expect(page.locator('#jam-playlist-status')).toContainText('250');
});

test('Clear All removes waiting rows and explains the Spotify-controlled song it retains', async ({ page }) => {
  const mutations = await openJam(page);
  await page.locator('#jam-view-queue-tab').click();
  await expect(page.locator('#jam-queue-list .jam-queue-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear All', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0].payload.generation).toBe(7);
  expect(mutations[0].payload.expected_queue_revision).toBe(4);
  await expect(page.locator('#jam-queue-list .jam-queue-item')).toHaveCount(1);
  await expect(page.locator('#jam-queue-status')).toContainText('Spotify');
  await expect(page.locator('#jam-now-playing .jam-now-playing-name')).toHaveText('Blinding Lights');
  await expect(page.getByRole('button', { name: 'Clear All', exact: true })).toBeDisabled();
});
