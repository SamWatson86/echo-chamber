import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/install-scenario.js');

// The Windows IPC boundary is simulated; the reloaded viewer, sessionStorage,
// activity messages, AudioContext, AudioWorklet, and outgoing audio track are real.
async function installNativePublisher(page) {
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate(async () => {
    await window.EchoLayoutTestScenario.install({ participants: 2, cameras: 0, screenShares: 1, screenOwners: [1] });
    currentRoomName = 'main';
    const local = room.localParticipant;
    // The generic layout fixture supplies dummy receiver audio for every share.
    // A real publisher has no local playback elements.
    const audioState = participantState.get(local.identity);
    audioState.screenAudioEls.clear();
    audioState.screenGainNodes.clear();
    const video = Array.from(local.trackPublications.values()).find(publication => publication.kind === 'video');
    local.trackPublications.clear();
    room.remoteParticipants.set(local.identity + '$screen', {
      identity: local.identity + '$screen', trackPublications: new Map([[video.trackSid, video]]),
    });
    window.__ECHO_NATIVE__ = true;
    window.nativeTestCalls = [];
    window.nativeTestMessages = [];
    window.nativeTestPublished = [];
    window.nativeTestCapture = { wgc: true, desktop: false };
    window.nativeTestFailStops = [];
    local.publishData = data => { window.nativeTestMessages.push(JSON.parse(new TextDecoder().decode(data))); };
    local.publishTrack = async (track, options) => {
      window.nativeTestPublished.push({ track, options });
      const publication = { trackSid: 'native-test-audio', kind: 'audio', source: options.source, track };
      local.trackPublications.set(publication.trackSid, publication);
      reconcileLocalPublishIndicators('local-track-published');
      return publication;
    };
    local.unpublishTrack = async track => {
      for (const [sid, publication] of local.trackPublications) {
        if (publication.track === track) local.trackPublications.delete(sid);
      }
      reconcileLocalPublishIndicators('local-track-unpublished');
    };
    hasTauriIPC = () => true;
    const listeners = new Map();
    tauriListen = async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); };
    tauriInvoke = async (command, args) => {
      window.nativeTestCalls.push({ command, args });
      if (command === 'get_capture_health') return {
        capture_active: window.nativeTestCapture.wgc || window.nativeTestCapture.desktop,
        capture_mode: window.nativeTestCapture.desktop ? 'DXGI-DD' : 'WGC',
        seconds_since_capture_started: 100,
      };
      if (command === 'list_screen_sources') return [{ id: 4242, pid: 5678, source_type: 'game', title: 'Fixture game', exe_name: 'fixture-game.exe' }];
      if (command === 'stop_screen_share' || command === 'stop_desktop_capture') {
        if (window.nativeTestFailStops.includes(command)) throw new Error('Simulated native stop failure');
        window.nativeTestCapture[command === 'stop_screen_share' ? 'wgc' : 'desktop'] = false;
        if (!window.nativeTestCapture.wgc && !window.nativeTestCapture.desktop) {
          room.remoteParticipants.delete(local.identity + '$screen');
        }
      }
      if (command === 'stop_audio_capture') clearInterval(window.nativeTestPcmTimer);
      if (command === 'start_audio_capture') {
        listeners.get('audio-capture-format')?.({ payload: { channels: 2, sampleRate: 48000 } });
        const pcm = new Float32Array(960).fill(0.2);
        const payload = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
        window.nativeTestPcmTimer = setInterval(() => listeners.get('audio-capture-data')?.({ payload }), 10);
      }
      return null;
    };
  });
}

async function installActiveNativeShare(page) {
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await installNativePublisher(page);
  await page.evaluate(async () => {
    window._echoNativeCaptureActive = true;
    await rememberNativeShareSession({ id: 4242, pid: 5678, sourceType: 'game', title: 'Fixture game', exeName: 'fixture-game.exe' },
      'wgc', _nativeShareRecoveryGeneration);
  });
  await page.locator('#screen-grid video').click();
  await page.evaluate(async () => {
    await recoverNativeScreenShare(room);
    window.nativeTestVideoElement = document.querySelector('#screen-grid video');
    window.nativeTestCalls = [];
    setPublishButtonsEnabled(true);
  });
  await expect(page.locator('#toggle-screen')).toHaveText('Stop Sharing');
}

test('End Sharing stops both native capture backends, retires media, and cannot recover the ended share', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installActiveNativeShare(page);
  // The IPC capture outlives these WebView flags. End Sharing must still reach
  // both native backends when a reload or state race loses the local mode.
  await page.evaluate(() => {
    window._echoNativeCaptureActive = false;
    window._echoNativeCaptureMode = null;
  });
  await page.locator('#toggle-screen').click();
  await expect(page.locator('#toggle-screen')).toHaveText('Share Screen');
  await expect(page.locator('#toggle-screen')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#screen-grid > .tile')).toHaveCount(0);
  expect(await page.evaluate(() => ({
    stops: window.nativeTestCalls.filter(call => ['stop_screen_share', 'stop_desktop_capture'].includes(call.command))
      .map(call => call.command).sort(),
    nativeActive: window.nativeTestCapture.wgc || window.nativeTestCapture.desktop,
    audioActive: _nativeAudioActive,
    audioTracks: window.nativeTestPublished.map(item => item.track.mediaStreamTrack.readyState),
    publications: room.localParticipant.trackPublications.size,
    videoDetached: window.nativeTestVideoElement.srcObject === null && window.nativeTestVideoElement.paused,
    savedSession: sessionStorage.getItem(NATIVE_SHARE_SESSION_KEY),
  }))).toEqual({
    stops: ['stop_desktop_capture', 'stop_screen_share'], nativeActive: false,
    audioActive: false, audioTracks: ['ended'], publications: 0, videoDetached: true, savedSession: null,
  });
  await page.evaluate(() => recoverNativeScreenShare(room));
  expect(await page.evaluate(() => ({
    active: !!window._echoNativeCaptureActive,
    newCaptureStarts: window.nativeTestCalls.filter(call => call.command.startsWith('start_')).length,
  }))).toEqual({ active: false, newCaptureStarts: 0 });
  await expect(page.locator('#screen-grid > .tile')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('failed native End Sharing stays visibly active and permits a successful retry', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installActiveNativeShare(page);
  await page.evaluate(() => { window.nativeTestFailStops = ['stop_screen_share']; });
  await page.locator('#toggle-screen').click();
  await expect(page.locator('#status')).toContainText('Screen sharing could not be fully stopped');
  await expect(page.locator('#toggle-screen')).toHaveText('Stop Sharing');
  await expect(page.locator('#toggle-screen')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#toggle-screen')).toBeEnabled();
  expect(await page.evaluate(() => ({
    stops: window.nativeTestCalls.filter(call => ['stop_screen_share', 'stop_desktop_capture'].includes(call.command))
      .map(call => call.command).sort(),
    nativeActive: window.nativeTestCapture.wgc,
    sharing: screenEnabled,
    audioTracks: window.nativeTestPublished.map(item => item.track.mediaStreamTrack.readyState),
  }))).toEqual({
    stops: ['stop_desktop_capture', 'stop_screen_share'], nativeActive: true,
    sharing: true, audioTracks: ['ended'],
  });
  await page.evaluate(() => { window.nativeTestFailStops = []; });
  await page.locator('#toggle-screen').click();
  await expect(page.locator('#toggle-screen')).toHaveText('Share Screen');
  await expect(page.locator('#screen-grid > .tile')).toHaveCount(0);
  expect(await page.evaluate(() => window.nativeTestCapture.wgc)).toBe(false);
  expect(errors).toEqual([]);
});

test('a real viewer reload restores game activity and non-silent outgoing audio', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await installNativePublisher(page);
  await page.evaluate(async () => {
    window._echoNativeCaptureActive = true;
    await rememberNativeShareSession({ id: 4242, pid: 5678, sourceType: 'game', title: 'Fixture game', exeName: 'fixture-game.exe' },
      'wgc', _nativeShareRecoveryGeneration);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await installNativePublisher(page);
  // Supply a normal interaction so Chromium may resume its audio context.
  await page.locator('#screen-grid video').click();
  await page.evaluate(() => recoverNativeScreenShare(room));
  await expect(page.locator('.user-card.is-local .participant-stream-description')).toHaveText('Playing Fixture game');
  const tile = page.locator('#screen-grid > .tile');
  await tile.getByRole('button', { name: 'Your stream audio', exact: true }).hover();
  await expect(tile.locator('.tile-volume-status')).toHaveText('Audio shared');
  await expect(tile.locator('.tile-volume-slider')).toBeDisabled();
  await expect(tile.locator('.tile-volume-slider')).toBeHidden();
  expect(await page.evaluate(() => participantState.get(room.localParticipant.identity).screenAudioEls.size)).toBe(0);
  expect(await page.evaluate(() => ({
    active: _nativeAudioActive,
    tracks: window.nativeTestPublished.map(item => ({ source: item.options.source, state: item.track.mediaStreamTrack.readyState })),
    nativeVideoStarts: window.nativeTestCalls.filter(call => call.command === 'start_screen_share').length,
    messages: window.nativeTestMessages.filter(message => message.type === 'stream-activity').map(message => message.source.source_title),
  }))).toEqual({ active: true, tracks: [{ source: 'screen_share_audio', state: 'live' }], nativeVideoStarts: 0, messages: ['Fixture game'] });
  await page.evaluate(() => {
    const source = _nativeAudioCtx.createMediaStreamSource(new MediaStream([window.nativeTestPublished[0].track.mediaStreamTrack]));
    const analyser = _nativeAudioCtx.createAnalyser();
    const silentOutput = _nativeAudioCtx.createGain();
    silentOutput.gain.value = 0;
    source.connect(analyser).connect(silentOutput).connect(_nativeAudioCtx.destination);
    window.nativeTestAudioLevel = () => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
  });
  await expect.poll(() => page.evaluate(() => window.nativeTestAudioLevel())).toBeGreaterThan(0.1);
  await page.evaluate(() => stopNativeAudioCapture());
  await expect(tile.locator('.tile-volume-status')).toHaveText('No audio shared');
  expect(errors).toEqual([]);
});
