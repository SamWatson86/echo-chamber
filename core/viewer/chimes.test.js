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
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() { return this; },
      };
    }
    createOscillator() {
      return {
        type: "",
        frequency: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() { return this; },
        start() {},
        stop() {},
      };
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
