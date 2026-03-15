# Open Issues Batch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 7 open issues — feedback dialog bugs (#85, #86, #87, #88), screen share volume (#90), soundboard UX (#93), and login page cleanup (#84).

**Architecture:** All changes are viewer-side (JS/CSS/HTML) except #88 which also touches the Rust control plane to add a `title` field. No client rebuild needed — viewer files are served live by the control plane.

**Tech Stack:** Vanilla JS, CSS, HTML, Rust (axum)

---

## Task 1: Fix Screenshot Upload (#85)

**Root cause:** `attachBugReportScreenshot()` in `admin.js:128-146` sends file as `FormData` (multipart), but the Rust `/api/chat/upload` endpoint expects raw bytes. Chat uploads work because `chat.js:551-557` sends `file.arrayBuffer()`. The multipart MIME boundaries corrupt the file, causing the server to return `{ ok: false }`.

**Files:**
- Modify: `core/viewer/admin.js:128-136`

**Step 1: Fix the upload to send raw bytes instead of FormData**

In `admin.js`, replace the FormData upload with raw ArrayBuffer (matching how chat.js does it):

```javascript
// OLD (broken):
var formData = new FormData();
formData.append("file", file);
var uploadResp = await fetch(apiUrl("/api/chat/upload"), {
  method: "POST",
  headers: { Authorization: "Bearer " + adminToken },
  body: formData,
});

// NEW (fixed):
var fileBytes = await file.arrayBuffer();
var uploadResp = await fetch(apiUrl("/api/chat/upload"), {
  method: "POST",
  headers: { Authorization: "Bearer " + adminToken },
  body: fileBytes,
});
```

**Verify:** Open feedback dialog, attach screenshot via button and Ctrl+V. Status should show "Screenshot attached." not "Screenshot upload failed."

---

## Task 2: Fix Dialog Overflow (#86)

**Root cause:** `.bug-report-content` in `style.css:1989-1997` has no `max-height` or `overflow`. When the window is short, buttons clip off-screen.

**Files:**
- Modify: `core/viewer/style.css:1989-1997`

**Step 1: Add max-height and overflow to `.bug-report-content`**

```css
.bug-report-content {
  width: min(440px, calc(100vw - 48px));
  max-height: min(90vh, calc(100vh - 48px));
  overflow-y: auto;
  /* ... existing gradient, blur, border, shadow ... */
}
```

**Verify:** Resize window to be very short vertically. Dialog should scroll internally, both Close and Send Report buttons should be reachable.

---

## Task 3: Increase Max Characters (#87)

**Files:**
- Modify: `core/viewer/index.html` — change `maxlength="1000"` to `maxlength="5000"`

**Step 1: Update the textarea maxlength**

```html
<!-- OLD -->
<textarea id="bug-report-desc" ... maxlength="1000"></textarea>

<!-- NEW -->
<textarea id="bug-report-desc" ... maxlength="5000"></textarea>
```

No server-side limit exists (Rust accepts any length).

---

## Task 4: Split Feedback into Title + Description (#88)

**Files:**
- Modify: `core/viewer/index.html` — add title input above textarea
- Modify: `core/viewer/admin.js` — read title, send in payload, reset on open
- Modify: `core/control/src/main.rs` — add `title` field to `BugReportRequest` struct + use it for GitHub issue title

**Step 1: Add title input to HTML**

In `index.html`, inside `.bug-report-body`, add a title input before the textarea:

```html
<input id="bug-report-title" type="text" class="bug-report-title-input"
  placeholder="Short summary (e.g. 'Audio cuts out when switching rooms')"
  maxlength="120" />
```

**Step 2: Add DOM ref and wire up in admin.js**

Add `var bugReportTitle = document.getElementById("bug-report-title");` to the DOM refs section (~line 7-18).

In `openBugReport()`, reset the title: `if (bugReportTitle) bugReportTitle.value = "";`

In `sendBugReport()`, read the title and include it in the payload:

```javascript
var title = bugReportTitle ? bugReportTitle.value.trim() : "";
// Include in fetch body:
body: JSON.stringify({
  title: title || undefined,
  description: desc,
  feedback_type: feedbackType,
  // ... existing fields ...
})
```

**Step 3: Update Rust struct and GitHub issue creation**

In `main.rs`, add to `BugReportRequest` (~line 162):
```rust
#[serde(default)]
title: Option<String>,
```

Add to `BugReport` struct as well:
```rust
#[serde(default)]
title: Option<String>,
```

In `create_github_issue()` (~line 4404), use explicit title when provided:
```rust
let title = if let Some(ref t) = report.title {
    if !t.is_empty() {
        format!("{}: {}", prefix, t)
    } else if report.description.len() > 80 {
        format!("{}: {}...", prefix, &report.description[..77])
    } else {
        format!("{}: {}", prefix, report.description)
    }
} else if report.description.len() > 80 {
    format!("{}: {}...", prefix, &report.description[..77])
} else {
    format!("{}: {}", prefix, report.description)
};
```

**Step 4: Style the title input**

In `style.css`, add after the textarea styles:
```css
.bug-report-title-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(15, 23, 42, 0.6);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
.bug-report-title-input:focus {
  border-color: var(--accent);
}
.bug-report-title-input::placeholder {
  color: rgba(148, 163, 184, 0.5);
}
```

**Verify:** Open feedback, fill title + description, submit. GitHub issue should use the title field. If title is empty, falls back to truncated description (old behavior).

---

## Task 5: Screen Share Volume on Tile (#90)

**Files:**
- Modify: `core/viewer/participants.js` — add volume slider to screen tile creation
- Modify: `core/viewer/style.css` — style the tile volume control

**Step 1: Add volume slider to screen tile**

In `participants.js`, in `addScreenTile()` after the fullscreen button (~line 170), add a volume slider to the tile:

```javascript
// Volume slider — only shown when tile has audio
var volWrap = document.createElement("div");
volWrap.className = "tile-volume-wrap hidden";
var volSlider = document.createElement("input");
volSlider.type = "range";
volSlider.className = "tile-volume-slider";
volSlider.min = "0";
volSlider.max = "3";
volSlider.step = "0.01";
volSlider.value = "1";
volSlider.title = "Screen volume";
volSlider.addEventListener("click", function(e) { e.stopPropagation(); });
volSlider.addEventListener("input", function(e) {
  e.stopPropagation();
  // Find participant identity from tile data and update their screen volume
  var identity = tile.dataset.identity;
  if (!identity) return;
  var state = participantState.get(identity);
  if (!state) return;
  state.screenVolume = Number(volSlider.value);
  applyParticipantAudioVolumes(state);
  saveParticipantVolume(identity, state.micVolume, state.screenVolume, state.chimeVolume);
  // Sync the participant card slider if it exists
  var cardRef = participantCards.get(identity);
  if (cardRef?.screenSlider) {
    cardRef.screenSlider.value = state.screenVolume;
    if (cardRef.screenPct) cardRef.screenPct.textContent = Math.round(state.screenVolume * 100) + "%";
  }
});
volWrap.appendChild(volSlider);
tile.appendChild(volWrap);
tile._volWrap = volWrap;
tile._volSlider = volSlider;
```

Store identity on tile: add `tile.dataset.identity = identity;` when creating the tile (the identity is available from `registerScreenTrack` or the caller).

**Step 2: Show volume control when audio is attached**

In `audio-routing.js`, wherever screen audio elements are attached to a participant, find the screen tile and show the volume wrap:

After a screen audio element is added to `state.screenAudioEls`, find the tile:
```javascript
var tile = screenTileByIdentity.get(identity);
if (tile && tile._volWrap) {
  tile._volWrap.classList.remove("hidden");
  // Sync slider to current volume
  if (tile._volSlider) tile._volSlider.value = state.screenVolume;
}
```

**Step 3: Style the tile volume control**

```css
.tile-volume-wrap {
  position: absolute;
  bottom: 8px;
  left: 50px;
  right: 50px;
  display: flex;
  align-items: center;
  z-index: 3;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.tile:hover .tile-volume-wrap {
  opacity: 1;
  pointer-events: auto;
}
.tile-volume-slider {
  width: 100%;
  height: 4px;
  cursor: pointer;
  accent-color: var(--accent);
}
```

**Verify:** When a screen share has audio, hover over the tile — volume slider appears at the bottom. Dragging it changes audio volume.

---

## Task 6: Soundboard Compact UX (#93)

**Files:**
- Modify: `core/viewer/soundboard.js` — update `renderSoundboardCompact()` to show names
- Modify: `core/viewer/style.css` — restyle compact grid to 2-column pills
- Modify: `core/viewer/index.html` — add search input to compact panel

**Step 1: Add search input to compact soundboard HTML**

In `index.html`, inside `#soundboard-compact`, after the header and before the grid:

```html
<input id="soundboard-compact-search" type="text" class="soundboard-compact-search" placeholder="Search sounds..." />
```

**Step 2: Update `renderSoundboardCompact()` to show emoji + name pills**

In `soundboard.js`, modify the button creation in `renderSoundboardCompact()`:

```javascript
sorted.forEach((sound) => {
  const btn = document.createElement("div");
  btn.setAttribute("role", "button");
  btn.setAttribute("tabindex", "0");
  btn.className = "sound-pill-btn";
  btn.dataset.soundId = sound.id;
  btn.draggable = true;
  btn.setAttribute("draggable", "true");
  btn.dataset.soundName = sound.name || "Sound";

  var iconSpan = document.createElement("span");
  iconSpan.className = "sound-pill-icon";
  iconSpan.textContent = sound.icon || "\u{1F50A}";
  btn.appendChild(iconSpan);

  var nameSpan = document.createElement("span");
  nameSpan.className = "sound-pill-name";
  nameSpan.textContent = sound.name || "Sound";
  btn.appendChild(nameSpan);

  if (favSet.has(sound.id)) btn.classList.add("is-favorite");
  btn.addEventListener("click", () => { /* same click handler as before */ });
  soundboardCompactGrid.appendChild(btn);
});
```

**Step 3: Wire up compact search input**

```javascript
var compactSearchInput = document.getElementById("soundboard-compact-search");
if (compactSearchInput) {
  compactSearchInput.addEventListener("input", function() {
    renderSoundboardCompact(compactSearchInput.value.trim());
  });
}
```

Update `renderSoundboardCompact` signature to accept optional filter:
```javascript
function renderSoundboardCompact(filter) {
  const sounds = getSoundboardSoundsFiltered(filter || "");
  // ...rest of function
}
```

**Step 4: Restyle the compact grid**

```css
/* Replace 4-column emoji grid with 2-column pill layout */
.soundboard-compact-grid {
  grid-template-columns: repeat(2, 1fr);
}

.sound-pill-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--glass);
  cursor: pointer;
  font-size: 13px;
  transition: var(--transition);
  overflow: hidden;
  white-space: nowrap;
}
.sound-pill-btn:hover {
  border-color: rgba(56, 189, 248, 0.4);
  background: var(--glass-hover);
}
.sound-pill-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.sound-pill-name {
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(226, 232, 240, 0.85);
  font-size: 12px;
}

.soundboard-compact-search {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(15, 23, 42, 0.6);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.soundboard-compact-search:focus {
  border-color: var(--accent);
}
```

Also widen the panel from 210px to 320px:
```css
.soundboard-compact {
  width: 320px;
}
```

**Verify:** Open soundboard. Each sound shows emoji + name as a pill. Search filters sounds. Panel is wider and more readable.

---

## Task 7: Login Page Cleanup (#84)

**Files:**
- Modify: `core/viewer/index.html` — restructure connect panel
- Modify: `core/viewer/style.css` — add styles for new layout
- Modify: `core/viewer/app.js` — add Advanced toggle logic, auto-fill password

**Step 1: Restructure connect panel HTML**

Reorder the connect panel: online users first, then name, then connect button, then advanced section (URLs + password hidden by default).

```html
<section id="connect-panel" class="panel">
  <div id="online-users" class="online-users"></div>
  <div class="connect-main">
    <label>
      Name
      <input id="name" type="text" value="Viewer" />
    </label>
    <label id="password-field" class="hidden">
      Admin password
      <input id="admin-password" type="password" placeholder="Enter admin password" />
    </label>
  </div>
  <div class="actions">
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
  </div>
  <div id="status" class="status">Idle</div>
  <button id="advanced-toggle" type="button" class="advanced-toggle">Advanced</button>
  <div id="advanced-section" class="advanced-section hidden">
    <div class="grid">
      <label>
        Control URL
        <input id="control-url" type="text" placeholder="https://192.168.5.70:9443" />
      </label>
      <label>
        SFU URL
        <input id="sfu-url" type="text" placeholder="ws://127.0.0.1:7880" />
      </label>
    </div>
    <div class="actions device-actions">
      <!-- mic/cam/speaker selects + refresh button -->
    </div>
    <div id="device-status" class="status device-status"></div>
  </div>
  <input id="room" type="hidden" value="main" />
  <input id="identity" type="hidden" value="" />
  <!-- publish actions stay unchanged -->
  <div class="actions publish-actions hidden">...</div>
</section>
```

**Step 2: Advanced toggle logic in app.js**

```javascript
var advancedToggle = document.getElementById("advanced-toggle");
var advancedSection = document.getElementById("advanced-section");
if (advancedToggle && advancedSection) {
  advancedToggle.addEventListener("click", function() {
    advancedSection.classList.toggle("hidden");
    advancedToggle.textContent = advancedSection.classList.contains("hidden") ? "Advanced" : "Hide Advanced";
  });
}
```

**Step 3: Auto-fill password, only show field if needed**

```javascript
var passwordField = document.getElementById("password-field");
var savedPass = echoGet(REMEMBER_PASS_KEY);
if (savedPass && passwordInput) {
  passwordInput.value = savedPass;
  // Password is saved, keep field hidden
} else if (passwordField) {
  passwordField.classList.remove("hidden");
}
```

If login fails (wrong password), show the password field:
In `connectToRoom()` catch block, add:
```javascript
if (passwordField) passwordField.classList.remove("hidden");
```

**Step 4: Style additions**

```css
.connect-main {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}

.advanced-toggle {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
  padding: 4px 0;
  margin-top: 8px;
}
.advanced-toggle:hover {
  color: var(--text);
}

.advanced-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.1);
}
```

**Verify:** Login page shows: online users, name field, Connect button. URLs and device selectors hidden behind "Advanced". Password auto-fills from storage, field only appears if no saved password.

---

## Final Steps

After all tasks complete:
1. Rebuild control plane: `cd core && cargo build -p echo-core-control`
2. Restart control plane (Rust changed for #88)
3. Refresh viewer to pick up JS/CSS/HTML changes
4. Close issues #84, #85, #86, #87, #88, #90, #93 on GitHub with fix comments
