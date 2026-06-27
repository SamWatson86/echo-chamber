const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatStreamBitrate,
  renderCaptureSourceDiagnostics,
  renderInboundStreamStats,
  renderSenderDiagnostics,
} = require("./admin-panel.js");

test("formats stream bitrate for admin diagnostics", () => {
  assert.equal(formatStreamBitrate(6420), "6.4 Mbps");
  assert.equal(formatStreamBitrate(980), "980 kbps");
  assert.equal(formatStreamBitrate(null), "? Mbps");
});

test("renders receiver-side bitrate rows for every inbound stream", () => {
  const html = renderInboundStreamStats({
    rooms: [{
      room_id: "main",
      participants: [{
        identity: "david-2222",
        name: "David",
        stats: {
          inbound: [{
            from: "sam-1111",
            source: "screen",
            fps: 59.7,
            width: 1920,
            height: 1080,
            bitrate_kbps: 6420,
            lost: 0,
            nack: 0,
            pli: 0,
            jitter_ms: 3,
            layer: "HIGH",
            ice_remote_type: "srflx",
          }, {
            from: "jeff-3333",
            source: "camera",
            fps: 29.9,
            width: 1280,
            height: 720,
            bitrate_kbps: 1180,
            lost: 2,
            nack: 4,
            pli: 1,
          }],
        },
      }],
    }],
  });

  assert.match(html, /David sees sam-1111 screen/);
  assert.match(html, /60fps 1920x1080 6\.4 Mbps/);
  assert.match(html, /loss 0 nack 0 pli 0 jitter 3ms/);
  assert.match(html, /David sees jeff-3333 camera/);
  assert.match(html, /30fps 1280x720 1\.2 Mbps/);
});

test("renders sender-side capture diagnostics", () => {
  const html = renderSenderDiagnostics({
    sender_fps: 8,
    sender_target_bitrate_kbps: 5520,
    sender_available_outgoing_bitrate_kbps: 5615,
    sender_quality_limitation: "Cpu",
    sender_encoder: "NVIDIA H264 Encoder",
  });

  assert.match(html, /sender 8fps/);
  assert.match(html, /target 5\.5 Mbps/);
  assert.match(html, /avail 5\.6 Mbps/);
  assert.match(html, /quality Cpu/);
  assert.match(html, /NVIDIA H264 Encoder/);
});

test("renders selected capture source diagnostics", () => {
  const html = renderCaptureSourceDiagnostics({
    capture_source: {
      source_type: "game",
      source_title: "Brotato",
      capture_route: "wgc-game-monitor",
      publish_profile: "game",
      fullscreen_like: true,
    },
  });

  assert.match(html, /source game/);
  assert.match(html, /Fullscreen Game Capture/);
  assert.match(html, /profile game/);
  assert.match(html, /fullscreen-like yes/);
  assert.match(html, /Brotato/);
});
