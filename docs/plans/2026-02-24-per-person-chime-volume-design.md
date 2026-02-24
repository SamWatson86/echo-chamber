# Per-Person Chime Volume Control

**Date**: 2026-02-24
**Issue**: #53 (Lower intro/outro volume)
**Scope**: Viewer-only (app.js + style.css), no server changes

## Problem
Chime volumes are hardcoded with no user control. Some people's custom chimes are too loud. No way to turn down a specific person's entrance/exit sound without affecting everyone else.

## Design

### User Experience
- New "Chime" volume slider on each participant's video card, alongside existing Mic and Screen sliders
- Range: 0% (silent) to 100% (current full volume)
- Default: 50% for all users (halves current volume, addresses #53)
- Persisted per person in localStorage (survives refresh/restart)
- Respects Mute All

### Implementation

#### 1. Chime GainNode
All chime playback routes through a per-participant GainNode. Currently:
- Built-in chimes (join/leave/switch/screen share) use inline gain values (0.18, 0.2, etc.)
- Custom chimes use `playCustomChime()` with hardcoded `gain.gain.value = 0.5`

Change: Create a `chimeGainNode` on the shared `chimeAudioCtx` that scales all chime output. When playing a chime for a specific participant, set the gain to `(participantChimeVolume / 100) * hardcodedGain`.

#### 2. Volume Storage
Extend existing `saveParticipantVolume(identity, mic, screen)` to include chime:
- `saveParticipantVolume(identity, mic, screen, chime)`
- Storage format: `{ mic: 1, screen: 1, chime: 0.5 }`
- `getParticipantVolume()` returns chime default of 0.5 if not set

#### 3. Participant Card UI
Add slider in `ensureParticipantCard()` / volume controls section:
- Label: "Chime"
- Input range: 0 to 1, step 0.01, default 0.5
- Percentage label beside it (same pattern as mic/screen)
- No boost above 100% (unlike mic/screen which go to 300%)

#### 4. Playback Integration
- `playChimeForParticipant(identity, kind)` — look up chime volume for identity, apply to gain
- `playCustomChime(buffer)` — accept optional volume parameter
- Built-in chimes (playJoinChime, playLeaveChime, etc.) — accept optional volume multiplier
- When `roomAudioMuted` is true, chime gain = 0

#### 5. Default Volume Change
All hardcoded chime gain values stay as-is in the code. The default chime volume of 0.5 (50%) acts as a multiplier, effectively halving all chime volumes by default.

## Files Modified
- `core/viewer/app.js` — volume storage, participant card slider, chime playback functions
- `core/viewer/style.css` — chime slider styling (matches existing mic/screen slider styles)

## Verification
- Connect with 2+ users
- Adjust one person's chime slider, verify their chime volume changes
- Verify the other person's chime stays at their set volume
- Verify setting persists after page refresh
- Verify Mute All silences chimes
- Verify 0% chime volume = silent
