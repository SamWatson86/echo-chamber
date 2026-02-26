# Chaos Stress Test Design

**Date:** 2026-02-26
**Goal:** Automated stress testing of viewer state management under rapid media toggling, participant churn, and room switching. Catches state desync bugs that unit tests can't reach.

## Architecture

**Three browser tabs orchestrated via Chrome DevTools MCP:**

- **Tab 1: Observer ("Sam")** — Connects, sits in room, watches other participants. This is the tab we verify — its DOM and JS state must stay consistent.
- **Tab 2: ChaosBot-1** — Connects as a participant, runs chaos sequences (rapid toggling, disconnect/reconnect, room switches).
- **Tab 3: ChaosBot-2** — Same chaos, different timing. Tests the viewer handling multiple participants changing state simultaneously.

**No new dependencies.** Uses existing DevTools MCP, existing viewer, existing LiveKit SFU. No npm, no bundler, no test framework.

## Chaos Phases

### Phase 1: Mic Flap
One bot toggles mic on/off 10 times with 200-500ms random delays.
**Verifies:** Observer's mic indicator matches actual mute state. No orphaned audio elements.

### Phase 2: Camera Flap
One bot toggles camera on/off 10 times with 200-500ms random delays.
**Verifies:** Observer sees camera video appear/disappear correctly. No zombie video elements.

### Phase 3: Combined Flap
One bot alternates mic and camera toggles, 10 times.
**Verifies:** Independent state tracking — mic toggle doesn't affect camera state and vice versa.

### Phase 4: Disconnect/Reconnect
Bot disconnects, waits 2-3s, reconnects.
**Verifies:** Participant card removed after grace period, card reappears on reconnect, audio elements cleaned up and re-created.

### Phase 5: Room Switch Storm
Bot switches between Main and Breakout 1 five times rapidly (~1s intervals).
**Verifies:** Observer's participant list updates correctly. No ghost cards from previous room. Token cache works.

### Phase 6: Dual Chaos
Both bots toggle mic + camera simultaneously while observer watches.
**Verifies:** Viewer handles concurrent remote participant state changes without desync.

### Phase 7: Local Self-Test
Observer tab itself toggles mic/cam/screen rapidly.
**Verifies:** `micEnabled`, `camEnabled`, `screenEnabled` match actual track publications. `publishStateReconcile` reports `anyDrift: false` after settling.

## Verification Checks

After each phase, run these checks on the observer tab:

| # | Check | JS Expression | Pass Condition |
|---|-------|---------------|----------------|
| 1 | Card count | `participantCards.size` | Equals number of connected participants |
| 2 | State map size | `participantState.size` | Equals `participantCards.size` |
| 3 | Audio bucket | `audioBucketEl.children.length` | Each child has a `srcObject` |
| 4 | No ghost screen tiles | `screenTileByIdentity.size` | Matches participants actually screen sharing |
| 5 | Mic state matches | Per-participant `micMuted` in state | Matches actual `track.isMuted` |
| 6 | Publish reconcile | `EchoPublishStateReconcile(...)` | `anyDrift: false` for local participant |

On each bot tab, verify:

| # | Check | JS Expression | Pass Condition |
|---|-------|---------------|----------------|
| 1 | Mic sync | `micEnabled === room.localParticipant.isMicrophoneEnabled` | true |
| 2 | Cam sync | `camEnabled === room.localParticipant.isCameraEnabled` | true |
| 3 | Screen sync | `screenEnabled` matches screen publication exists | true |

## Output Format

```
╔══════════════════════════════════════════════╗
║         ECHO CHAMBER CHAOS TEST             ║
╚══════════════════════════════════════════════╝

Phase 1: Mic Flap (ChaosBot-1)
  [PASS] 10/10 toggles completed
  [PASS] Observer card count correct (3)
  [PASS] Observer mic indicator matches
  [PASS] No orphaned audio elements

Phase 2: Camera Flap (ChaosBot-1)
  [PASS] 10/10 toggles completed
  [PASS] Observer camera state correct
  ...

RESULT: 28/28 checks passed
```

## Implementation Approach

The test is a sequence of DevTools MCP calls — no standalone script file needed. The orchestrator (Claude) drives the test by:

1. Opening 3 tabs via `new_page`
2. Connecting each as a different user
3. Running each phase by clicking buttons and evaluating JS
4. Running verification checks via `evaluate_script`
5. Reporting results

This can be re-run anytime by asking Claude to "run the chaos test."

## What This Catches

- Zombie audio elements (hearing someone you can't see)
- Ghost participant cards (seeing someone who left)
- Mic/camera indicators stuck in wrong state
- Screen share tiles not appearing or not cleaning up
- State map leaks (`participantState` growing without bound)
- Publish state drift (UI says mic is on, but no track published)
- Race conditions during rapid room switching
- Grace period cleanup bugs during reconnection

## What This Doesn't Catch

- SFU-level issues (packet loss, codec negotiation) — use LiveKit CLI `lk load-test` for that
- Network interruption simulation — would need a proxy/firewall tool
- Performance under many participants (>10) — limited by local machine resources
- Tauri-specific IPC issues — this tests the web viewer only
