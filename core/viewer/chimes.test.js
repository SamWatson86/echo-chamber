const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeAudioContext() {
  return class AudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.state = "suspended";
      this.resumeCalls = 0;
      this.oscillators = [];
      this.peaks = [];
    }
    createBufferSource() {
      return {
        buffer: null,
        connect() { return this; },
        start() {},
        stop() {},
      };
    }
    createGain() {
      const peaks = this.peaks;
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          linearRampToValueAtTime(value) { peaks.push(value); },
          exponentialRampToValueAtTime() {},
        },
        connect() { return this; },
      };
    }
    createOscillator() {
      const osc = {
        type: "",
        frequency: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() { return this; },
        start(time) { this.startedAt = time; },
        stop(time) { this.stoppedAt = time; },
      };
      this.oscillators.push(osc);
      return osc;
    }
    async decodeAudioData() {
      return { decoded: true };
    }
    async resume() {
      this.resumeCalls += 1;
      this.state = "running";
    }
  };
}

function loadChimesContext({ deviceId, localIdentity = "zane-1234", foundKeys = [] } = {}) {
  const fetches = [];
  const context = {
    window: {},
    roomAudioMuted: false,
    _isMobileDevice: false,
    participantState: new Map([["zane", { chimeVolume: 0.5 }]]),
    deviceIdByIdentity: new Map(deviceId ? [["zane", deviceId]] : []),
    room: { localParticipant: { identity: localIdentity } },
    getLocalDeviceId() {
      return "device-uuid-1";
    },
    getIdentityBase(identity) {
      return identity ? identity.replace(/-\d+$/, "") : identity;
    },
    apiUrl(pathname) {
      return "https://echo.example.test" + pathname;
    },
    fetch: async (url) => {
      fetches.push(String(url));
      const key = decodeURIComponent(String(url).match(/\/api\/chime\/([^/]+)\//)?.[1] || "");
      if (!foundKeys.includes(key)) {
        return { ok: false };
      }
      return {
        ok: true,
        async arrayBuffer() {
          return new ArrayBuffer(8);
        },
      };
    },
    console,
  };
  context.window.AudioContext = makeAudioContext();
  context.window.webkitAudioContext = context.window.AudioContext;
  context.AudioContext = context.window.AudioContext;
  context.webkitAudioContext = context.window.AudioContext;
  context.global = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "chimes.js"), "utf8");
  vm.runInContext(code, context, { filename: "chimes.js" });
  return { context, fetches };
}

test("custom chime playback falls back to identity key when mapped device key has no upload", async () => {
  const { context, fetches } = loadChimesContext({
    deviceId: "device-uuid-1",
    foundKeys: ["zane"],
  });

  await context.playChimeForParticipant("zane-1234", "enter");

  assert.deepEqual(
    fetches.map((url) => decodeURIComponent(url.match(/\/api\/chime\/([^/]+)\//)[1])),
    ["device-uuid-1", "zane"]
  );
});

test("local chime keys include stable device and current visible identity", () => {
  const { context } = loadChimesContext();

  assert.deepEqual(Array.from(context.getLocalChimeKeys()), ["device-uuid-1", "zane"]);
});

test("primeChimeAudio resumes the shared chime context", () => {
  const { context } = loadChimesContext();

  context.primeChimeAudio();
  const ctx = context.getChimeCtx();

  assert.equal(ctx.state, "running");
  assert.equal(ctx.resumeCalls, 1);
});

test("gentle presence cues rise for entry, fall for exit and suppress muted or suspended audio", () => {
  const { context } = loadChimesContext();
  const ctx = context.getChimeCtx();
  context.playJoinChime(1);
  assert.equal(ctx.oscillators.length, 0);

  context.primeChimeAudio();
  context.playJoinChime(1);
  context.playLeaveChime(0.5);
  assert.deepEqual(ctx.oscillators.map(osc => osc.frequency.value), [523.25, 659.25, 587.33, 440]);
  assert.ok(ctx.oscillators.every(osc => osc.type === "sine" && osc.stoppedAt <= 0.25));
  assert.deepEqual(ctx.peaks, [0.045, 0, 0.045, 0, 0.0225, 0, 0.0225, 0]);

  context.roomAudioMuted = true;
  context.playPresenceChime("enter");
  assert.equal(ctx.oscillators.length, 4);
});
