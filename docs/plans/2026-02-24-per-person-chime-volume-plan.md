# Per-Person Chime Volume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-participant chime volume slider so each user can control how loud other people's enter/exit/switch/screenshare chimes sound to them.

**Architecture:** Extend the existing per-participant volume system (`participantState`, `saveParticipantVolume`, slider UI) with a `chimeVolume` field. Route all chime playback through a volume-scaled GainNode. Default to 50% (halves current volume per #53).

**Tech Stack:** Web Audio API GainNode, localStorage persistence, vanilla JS DOM

---

### Task 1: Extend Volume Persistence

**Files:**
- Modify: `core/viewer/app.js:643-651` (saveParticipantVolume / getParticipantVolume)

**Step 1: Update `saveParticipantVolume` to accept chime parameter**

Change line 643:
```javascript
function saveParticipantVolume(identity, mic, screen, chime) {
  var prefs = _getVolumePrefs();
  prefs[identity] = { mic: mic, screen: screen, chime: chime };
  _saveVolumePrefs(prefs);
}
```

**Step 2: Update all callers to pass chime**

Every call to `saveParticipantVolume(key, state.micVolume, state.screenVolume)` must become `saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume)`. There are 6 call sites — lines ~4903, ~4915, ~4928, ~4940 and 2 more in popup slider handlers.

Search: `saveParticipantVolume(key,` — update all 6.

**Step 3: Commit**
```
git add core/viewer/app.js
git commit -m "feat: extend volume persistence with chime field"
```

---

### Task 2: Add chimeVolume to Participant State

**Files:**
- Modify: `core/viewer/app.js:4830-4856` (state object in ensureParticipantCard)

**Step 1: Add chimeVolume to state object**

After line 4837 (`screenVolume: 1,`), add:
```javascript
    chimeVolume: 0.5,  // default 50% — halves built-in chime loudness
```

**Step 2: Commit**
```
git add core/viewer/app.js
git commit -m "feat: add chimeVolume to participant state (default 50%)"
```

---

### Task 3: Add Chime Volume Slider to Participant Card

**Files:**
- Modify: `core/viewer/app.js:4584-4598` (slider creation area in ensureParticipantCard)

**Step 1: Declare chime slider variables**

Near line 4344-4345 where `micSlider` and `screenSlider` are declared, add:
```javascript
  let chimeSlider = null;
  let chimePct = null;
```

**Step 2: Create chime slider elements**

After line 4597 (`screenRow.append(screenLabel, screenSlider, screenPct);`), before `audioControls.append(...)`:
```javascript
    var chimeRow = document.createElement("div");
    chimeRow.className = "audio-row";  // visible by default (not hidden)
    const chimeLabel = document.createElement("span");
    chimeLabel.textContent = "Chime";
    chimeSlider = document.createElement("input");
    chimeSlider.type = "range";
    chimeSlider.min = "0";
    chimeSlider.max = "1";
    chimeSlider.step = "0.01";
    chimeSlider.value = "0.5";
    chimePct = document.createElement("span");
    chimePct.className = "vol-pct";
    chimePct.textContent = "50%";
    chimeRow.append(chimeLabel, chimeSlider, chimePct);
```

**Step 3: Append chime row to audio controls**

Change line 4598 from:
```javascript
    audioControls.append(micRow, screenRow);
```
to:
```javascript
    audioControls.append(micRow, screenRow, chimeRow);
```

**Step 4: Add slider event listener**

After the screenSlider event listener block (~line 4916), add:
```javascript
  if (chimeSlider) {
    chimeSlider.addEventListener("input", () => {
      state.chimeVolume = Number(chimeSlider.value);
      if (chimePct) chimePct.textContent = Math.round(state.chimeVolume * 100) + "%";
      saveParticipantVolume(key, state.micVolume, state.screenVolume, state.chimeVolume);
    });
  }
```

**Step 5: Restore saved chime volume**

In the volume restore block (~line 4944-4968), after the `savedVol.screen` block, add:
```javascript
      if (savedVol.chime != null && chimeSlider) {
        state.chimeVolume = savedVol.chime;
        chimeSlider.value = savedVol.chime;
        if (chimePct) chimePct.textContent = Math.round(savedVol.chime * 100) + "%";
      }
```

Also update the debug log line to include chime:
```javascript
      debugLog("[vol-prefs] restored " + key + " mic=" + (savedVol.mic || 1) + " screen=" + (savedVol.screen || 1) + " chime=" + (savedVol.chime != null ? savedVol.chime : 0.5));
```

**Step 6: Add chimeSlider to participantCards map**

In the `participantCards.set(key, { ... })` block (~line 4970), add `chimeSlider` to the stored object.

**Step 7: Commit**
```
git add core/viewer/app.js
git commit -m "feat: add chime volume slider to participant cards"
```

---

### Task 4: Route Chime Playback Through Per-Participant Volume

**Files:**
- Modify: `core/viewer/app.js:2887-3064` (chime functions)

**Step 1: Add volume parameter to all built-in chime functions**

Update each function to accept a `volume` multiplier (default 1):

```javascript
function playJoinChime(volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    const ctx = getChimeCtx();
    const now = ctx.currentTime;
    [[523.25, 0], [659.25, 0.12]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18 * vol, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.4);
    });
  } catch {}
}
```

Apply the same pattern to:
- `playLeaveChime(volume)` — multiply `0.2`, `0.05`, `0.18` by `vol`
- `playSwitchChime(volume)` — multiply `0.08`, `0.12`, `0.15` by `vol`
- `playScreenShareChime(volume)` — multiply `0.16`, `0.06` by `vol`

For all: add `if (roomAudioMuted) vol = 0;` at the top.

**Step 2: Update `playCustomChime` to accept volume**

```javascript
function playCustomChime(buffer, volume) {
  try {
    var vol = (volume != null ? volume : 1);
    if (roomAudioMuted) vol = 0;
    const ctx = getChimeCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.5 * vol;
    source.connect(gain).connect(ctx.destination);
    source.start(0);
  } catch {}
}
```

**Step 3: Update `playChimeForParticipant` to look up volume**

```javascript
async function playChimeForParticipant(identity, kind) {
  var chimeKey = getChimeKey(identity);
  // Look up this participant's chime volume preference
  var identityBase = getIdentityBase(identity);
  var pState = participantState.get(identityBase);
  var vol = (pState && pState.chimeVolume != null) ? pState.chimeVolume : 0.5;
  var buffer = await fetchChimeBuffer(chimeKey, kind);
  if (buffer) {
    playCustomChime(buffer, vol);
  } else if (kind === "enter") {
    playJoinChime(vol);
  } else {
    playLeaveChime(vol);
  }
}
```

**Step 4: Update direct chime calls that don't go through playChimeForParticipant**

Search for `playScreenShareChime()` — called at line ~7503. This plays when someone starts screen sharing. Update to pass the participant's chime volume:

```javascript
// Find the participant identity from context and look up their chime volume
var ssIdentityBase = getIdentityBase(participant.identity);
var ssState = participantState.get(ssIdentityBase);
var ssChimeVol = (ssState && ssState.chimeVolume != null) ? ssState.chimeVolume : 0.5;
playScreenShareChime(ssChimeVol);
```

Search for `playSwitchChime()` — called at line ~7644. Same treatment — look up chime volume for the switching participant.

**Step 5: Commit**
```
git add core/viewer/app.js
git commit -m "feat: route all chime playback through per-participant volume"
```

---

### Task 5: Verify and Close Issue

**Step 1: Verify locally**

- Refresh viewer in browser
- Connect with a test user
- Check participant card shows "Chime" slider at 50%
- Adjust slider, verify value persists after F5
- Verify chimes play at reduced volume
- Verify Mute All silences chimes
- Verify 0% slider = no chime sound

**Step 2: Close GitHub issue**

```bash
gh issue close 53 -c "Fixed — chime volume defaults to 50% and each user now has a per-person chime volume slider on participant cards."
```

**Step 3: Final commit with any fixes from verification**

```
git add core/viewer/app.js
git commit -m "fix: per-person chime volume — verification fixes"
```
