import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(directory, '../fixtures/install-scenario.js');
const connect = fs.readFileSync(path.resolve(directory, '../../viewer/connect.js'), 'utf8');
const callbacks = ['ParticipantConnected', 'ParticipantDisconnected'].map(event => {
  const start = connect.indexOf('  newRoom.on(LK.RoomEvent.' + event + ',');
  if (start < 0) throw new Error('Missing production callback: ' + event);
  return connect.slice(start, connect.indexOf('\n  });', start) + '\n  });'.length);
}).join('\n');

test('voice slider controls actual boosted audio after a participant leaves and rejoins', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: fixture });
  await page.evaluate(async callbacks => {
    echoSet('echo-changelog-seen', CHANGELOG_LATEST);
    await window.EchoLayoutTestScenario.install({ participants: 2, cameras: 0, screenShares: 0, screenOwners: [2] });
    const expectedRoom = room;
    const LK = getLiveKitClient();
    const handlers = new Map();
    room.on = (event, callback) => handlers.set(event, callback);
    // Only signaling and unrelated UI reconciliation are simulated. The actual
    // room callbacks, SDK track, controls, media elements and boost graph run.
    new Function('newRoom', 'LK', 'ignoreStaleRoomEvent', callbacks)(room, LK, () => room !== expectedRoom);
    scheduleReconcileWaves = () => {};
    scheduleReconcileWavesFast = () => {};
    attachParticipantTracks = () => {};
    resubscribeParticipantTracks = () => {};
    broadcastDeviceId = () => {};
    broadcastStreamActivity = () => {};
    playChimeForParticipant = () => {};
    room.startAudio = async () => {};

    const original = room.remoteParticipants.get('layout-fixture-2');
    original.name = 'Jeff';
    participantCards.get(original.identity).setParticipantDisplayName('Jeff');
    const state = participantState.get(original.identity);
    state.micVolume = 2.8;
    // Keep this synthetic tone away from Sam's speakers and microphone.
    const context = new AudioContext({ sinkId: { type: 'none' } });
    _participantAudioCtx = context;
    const oscillator = context.createOscillator();
    const level = context.createGain();
    level.gain.value = 0.02;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(level).connect(destination);
    oscillator.start();
    await context.resume();
    const mediaTrack = destination.stream.getAudioTracks()[0];
    const attach = (participant, sid) => {
      // Reuse the underlying media track, as a WebRTC receiver can after SDP
      // renegotiation. A leaked old graph must not resume alongside the new one.
      const track = new LK.RemoteAudioTrack(mediaTrack, sid);
      track.source = LK.Track.Source.Microphone;
      const publication = { kind: 'audio', source: 'microphone', track, trackSid: sid, isSubscribed: true };
      participant.trackPublications.set(sid, publication);
      handleTrackSubscribed(track, publication, participant);
      return audioElBySid.get(sid);
    };
    const oldElement = attach(original, 'voice-old');
    const oldGraph = state.micGainNodes.get(oldElement);
    const analyser = context.createAnalyser();
    const probe = context.createGain();
    probe.gain.value = 0;
    oldGraph.gain.connect(analyser).connect(probe).connect(context.destination);
    const peak = () => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
    window.voiceTest = { context, handlers, original, attach, oldElement, oldGraph, analyser, peak, LK };
  }, callbacks);
  await expect.poll(() => page.evaluate(() => voiceTest.peak())).toBeGreaterThan(0.05);
  await page.evaluate(() => {
    room.remoteParticipants.delete(voiceTest.original.identity);
    voiceTest.handlers.get(voiceTest.LK.RoomEvent.ParticipantDisconnected)(voiceTest.original);
  });
  await expect.poll(() => page.evaluate(() => voiceTest.peak())).toBeLessThan(0.00001);
  expect(await page.evaluate(() => ({ attached: voiceTest.oldElement.isConnected, source: voiceTest.oldElement.srcObject,
    nodes: participantState.get(voiceTest.original.identity).micGainNodes.size }))).toEqual({ attached: false, source: null, nodes: 0 });

  await page.evaluate(() => {
    const replacement = { identity: voiceTest.original.identity, name: 'Jeff', trackPublications: new Map() };
    room.remoteParticipants.set(replacement.identity, replacement);
    voiceTest.handlers.get(voiceTest.LK.RoomEvent.ParticipantConnected)(replacement);
    voiceTest.element = voiceTest.attach(replacement, 'voice-new');
    voiceTest.graph = participantState.get(replacement.identity).micGainNodes.get(voiceTest.element);
    voiceTest.graph.gain.connect(voiceTest.analyser);
  });
  await page.getByRole('button', { name: 'Controls for Jeff', exact: true }).click();
  const controls = page.getByRole('dialog', { name: 'Controls for Jeff', exact: true });
  const slider = controls.getByRole('slider', { name: 'Microphone volume for Jeff', exact: true });
  for (const [value, amplitude] of [['0', 0], ['0.25', 0.005], ['1', 0.02], ['3', 0.06]]) {
    await slider.fill(value);
    await expect.poll(async () => Math.abs(await page.evaluate(() => voiceTest.peak()) - amplitude)).toBeLessThan(0.0003);
    expect(await page.evaluate(() => ({ elementVolume: voiceTest.element.volume,
      elements: participantState.get(voiceTest.original.identity).micAudioEls.size,
      // The SDK may recycle the detached HTML element for the replacement.
      // Its old track must have no attachment and its old graph stays silent.
      oldAttachments: voiceTest.original.trackPublications.get('voice-old').track.attachedElements.length,
      graphReplaced: voiceTest.graph !== voiceTest.oldGraph,
    }))).toEqual({ elementVolume: 0, elements: 1, oldAttachments: 0, graphReplaced: true });
  }
  await controls.getByRole('button', { name: 'Mute microphone audio from Jeff', exact: true }).click();
  await expect.poll(() => page.evaluate(() => voiceTest.peak())).toBeLessThan(0.00001);
  await controls.getByRole('button', { name: 'Unmute microphone audio from Jeff', exact: true }).click();
  await expect.poll(() => page.evaluate(() => voiceTest.peak())).toBeGreaterThan(0.059);
  expect(errors).toEqual([]);
});
