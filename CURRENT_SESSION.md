# Echo Chamber - Current Session Notes

**Last Updated**: 2026-04-02 (late night — game capture hook design + plan complete)
**Current Version**: v0.5.1 (released, GitHub + auto-updater)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## CRITICAL CONTEXT
- Sam is **not a software developer** — FULL AUTONOMY for all operations
- **NEVER push to GitHub** for server-side updates. Only client releases.
- **Tauri client loads viewer from server** — viewer JS changes are live on refresh
- **ALWAYS use domain URL** for Rust-side connections, never localhost (TLS cert issue)

---

## WHAT CHANGED TODAY (2026-04-02 late session)

### Game Capture Hook — DESIGN + PLAN COMPLETE, NO CODE YET

All design and planning work is done. Implementation has NOT started.

**Documents written:**
1. **Design Spec**: `docs/superpowers/specs/2026-04-02-game-capture-hook-design.md`
   - Full architecture: hook DLL + host injection + WGC fallback
   - Cross-process IPC via D3D11 shared textures + named events
   - Anti-cheat detection (3-layer: processes, modules, kernel drivers)
   - DX11 + DX12 (via D3D11On12 bridge) support

2. **Implementation Plan**: `docs/superpowers/plans/2026-04-02-game-capture-hook.md`
   - 12 tasks across 4 phases with complete code in every step
   - Phase 1: Hook DLL (scaffold, IPC, hooks, DX11 capture, lifecycle)
   - Phase 2: Host-side (extract WGC, anti-cheat, injection, fallback chain, build)
   - Phase 3: DX12 support
   - Phase 4: Integration testing

**Key design decisions made:**
- `retour` 0.3 (stable) for inline function hooking, NOT 0.4 alpha
- DX11 + DX12 support (DX12 via D3D11On12 bridge inside game process)
- No Vulkan (out of scope, negligible Windows market share)
- Anti-cheat detection BEFORE injection — never inject into protected games
- WGC kept as fallback for non-game windows and anti-cheat games
- NVFBC rejected — blocked on GeForce consumer GPUs, no viable workaround

**Worktree:** `claude/youthful-hoover` branch has the spec + plan commits:
```
423da24 docs: game capture hook DLL implementation plan
d277090 docs: game capture hook DLL design spec
```

---

## PREVIOUS SESSION WORK (still deployed, working)

### Session/Name Fixes (DEPLOYED, WORKING)
1. **$screen identity guard** — skip card creation for `$screen` companion identities
2. **$screen track routing** — routes native capture tracks under real participant's tile
3. **Device-ID session conflict fix** — persistent UUID prevents crash-restart 409s
4. **SFU proxy auth forwarding** — extracts Bearer header, injects access_token

### D3D11 Capture Pipeline (DEPLOYED, PARTIALLY WORKING)
5. **Direct WGC + async staging** — 30fps for non-game windows
6. **Window enumeration** — Win32 EnumWindows replaces windows-capture enumerate

---

## CURRENT STATE

### What Works
- **30fps screen capture when game is NOT focused** — async staging pipeline
- **$screen identity merging** — no duplicate participant cards
- **Session resume** — crash-restart within 20s no longer gets 409
- **SFU proxy** — Rust SDK connects through control plane proxy

### What's Broken
- **5fps when game HAS focus** — WGC compositor bottleneck (the whole reason for the hook DLL)
- **Stop share button** — may have state tracking issue, lower priority
- **Win10 compatibility** — webrtc-sys targets Win11, SAM-PC can't run new binary

---

## WHEN RESUMING

1. Read this file + the implementation plan at `docs/superpowers/plans/2026-04-02-game-capture-hook.md`
2. The plan has 12 tasks with complete code — execute them in order
3. Use `superpowers:subagent-driven-development` skill (recommended) or `superpowers:executing-plans`
4. Start at **Task 1: Scaffold capture-hook crate**
5. The session/name fixes are deployed and working — don't touch them
6. The worktree `claude/youthful-hoover` has the spec + plan commits — can reuse or create fresh

## KEY FILES
- Design spec: `docs/superpowers/specs/2026-04-02-game-capture-hook-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-02-game-capture-hook.md`
- Current screen_capture.rs: `core/client/src/screen_capture.rs` (297 lines, will be refactored in Task 6)
- Workspace config: `core/Cargo.toml`
