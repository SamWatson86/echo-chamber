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
    const video = Array.from(local.trackPublications.values()).find(publication => publication.kind === 'video');
    local.trackPublications.clear();
    room.remoteParticipants.set(local.identity + '$screen', {
      identity: local.identity + '$screen', trackPublications: new Map([[video.trackSid, video]]),
    });
    window.__ECHO_NATIVE__ = true;
    window.nativeTestCalls = [];
    window.nativeTestMessages = [];
    window.nativeTestPublished = [];
    local.publishData = data => { window.nativeTestMessages.push(JSON.parse(new TextDecoder().decode(data))); };
    local.publishTrack = async (track, options) => { window.nativeTestPublished.push({ track, options }); };
    local.unpublishTrack = async () => {};
    hasTauriIPC = () => true;
    const listeners = new Map();
    tauriListen = async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); };
    tauriInvoke = async (command, args) => {
      window.nativeTestCalls.push({ command, args });
      if (command === 'get_capture_health') return { capture_active: true, capture_mode: 'WGC', seconds_since_capture_started: 100 };
      if (command === 'list_screen_sources') return [{ id: 4242, pid: 5678, source_type: 'game', title: 'Fixture game', exe_name: 'fixture-game.exe' }];
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
  expect(errors).toEqual([]);
});
