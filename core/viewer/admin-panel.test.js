const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatStreamBitrate,
  renderInboundStreamStats,
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
