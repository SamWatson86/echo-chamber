# Power Manager v2 — Design

**Date**: 2026-02-24
**Goal**: Maximize performance when Sam is at the PC, minimize power when idle overnight, keep Echo Chamber server running 24/7.

## Problem

The v1 power manager used GPU utilization polling (nvidia-smi) to detect gaming activity. This had several issues:

1. **25% GPU threshold was too sensitive** — desktop compositing alone triggered gaming mode, causing constant flipping every few minutes
2. **180-second cooldown was too short** — switched back to server mode while Sam was still at the desk
3. **No input awareness** — couldn't detect Sam sitting down at the PC. Had to wait for GPU usage to spike.
4. **Scheduled task disappeared** — watcher stopped running after a reboot at some point and never recovered

## Design

### Two Modes

| Property | Active | Server |
|---|---|---|
| Power Plan | Echo Gaming | Echo Server |
| CPU Max | 100% | 30% |
| GPU Power Limit | 450W (full) | 200W (throttled) |
| Display Timeout | 15 minutes | 5 minutes |
| Sleep/Hibernate | Never | Never |
| PCIe Link State | Off | Off (prevents GPU wake failures) |
| USB Suspend | Off | Off (ensures mouse/KB always wake screens) |

### Detection: Input-Aware Polling

Core change: detect **the user**, not the GPU.

Every **10 seconds**, the watcher:
1. Calls `GetLastInputInfo` (Win32 API) — returns milliseconds since last mouse/keyboard input
2. Checks if any game process from `games.txt` is running

### State Machine

```
IF currently SERVER mode:
   IF lastInput < 15 seconds → switch to ACTIVE (user is back)

IF currently ACTIVE mode:
   IF lastInput > 3600 seconds (60 min) AND no game running → switch to SERVER

Game override: game process running → ALWAYS stay ACTIVE
```

### Startup Behavior

- On boot: watcher starts via Scheduled Task, defaults to **Active** mode
- On crash: scheduled task auto-restarts (3 retries, 1 min interval)
- Watcher detects current plan on startup and logs it

### Config Schema

```json
{
  "serverPlanGuid": "00980dfc-...",
  "gamingPlanGuid": "74a479a6-...",
  "nvidiaSmi": "nvidia-smi",
  "gpuMaxPower": 450,
  "gpuServerPower": 200,
  "idleTimeoutMin": 60,
  "pollIntervalSec": 10,
  "inputWakeThresholdSec": 15
}
```

Removed: `gpuThresholdPct` (no longer used), `idleCooldownSec` (replaced by `idleTimeoutMin`), `checkIntervalSec` (replaced by `pollIntervalSec`).

### Files Changed

- `watcher.ps1` — Rewritten with `GetLastInputInfo` + new state machine
- `setup.ps1` — Updated config defaults and descriptions
- `config.json` — New schema
- `games.txt` — Unchanged (still used as safety override)

### Key Technical Detail: GetLastInputInfo

```powershell
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}
public class UserInput {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint GetIdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref lii);
        uint idle = ((uint)Environment.TickCount - lii.dwTime);
        return idle / 1000;
    }
}
"@
$idleSeconds = [UserInput]::GetIdleSeconds()
```

This is a single Win32 call with negligible overhead. Returns the time since the last mouse move, key press, or touch input system-wide.
