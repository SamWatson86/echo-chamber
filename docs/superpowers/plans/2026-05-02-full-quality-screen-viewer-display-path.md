# Full-Quality Screen Viewer Display Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep remote screen streams full quality while making Echo prefer Sam's RTX 4090 display path and exposing enough diagnostics to prove whether WebView2 presentation is the remaining bottleneck.

**Architecture:** First fix the measurement layer so the tile badge reports presented frames instead of callback scheduling artifacts. Then add native display authority in the Tauri client, post display/presentation status through the existing stats pipeline, and preserve the polished UI by moving expensive visual work off the hot `<video>` surface instead of reducing stream quality. The native presenter is a decision gate after evidence, not part of this implementation batch.

**Tech Stack:** Rust/Tauri v2 client, Windows WebView2, existing viewer JavaScript modules, existing Axum control-plane stats API, Node built-in test runner, Cargo tests/checks.

---

## File Structure

- `core/viewer/participants-fullscreen.js` owns per-video presentation diagnostics.
- `core/viewer/video-diagnostics.test.js` verifies the presented-frame FPS tracker.
- `core/viewer/participants-grid.js` owns screen tile construction and must not apply stream/render caps as product behavior.
- `core/viewer/screen-video-surface.test.js` verifies the viewer does not reintroduce the render cap or direct video-surface effects.
- `core/control/src/admin.rs` owns the stats schema accepted by `/api/client-stats-report` and returned by `/admin/api/dashboard`.
- `core/client/src/display_placement.rs` will own display enumeration, preferred-display selection, window placement, and pure geometry tests.
- `core/client/src/main.rs` wires display-placement commands into Tauri and applies launch placement after creating the main window.
- `core/viewer/display-status.js` polls native display status, renders the display-path badge, and exposes cached status to the stats reporter.
- `core/viewer/display-status.test.js` verifies warning-state logic without requiring a browser DOM.
- `core/viewer/screen-share-adaptive.js` adds presentation and display-path fields to the existing receive-side stats POST.
- `core/viewer/settings.js` adds display preference keys to the existing settings persistence allowlist.
- `core/viewer/index.html` loads `display-status.js` and adds the display-path badge host.
- `core/viewer/style.css` styles the display-path badge and moves screen-tile polish off the video element.

---

### Task 1: Keep the Correct Presented-Frame Diagnostic, Drop the Render-Cap Experiment

**Files:**
- Modify: `core/viewer/participants-fullscreen.js`
- Modify: `core/viewer/participants-grid.js`
- Create: `core/viewer/video-diagnostics.test.js`
- Delete: `core/viewer/screen-render-cap.test.js`

- [ ] **Step 1: Write the presented-frame tracker test**

Create `core/viewer/video-diagnostics.test.js` with this complete content:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createVideoFrameRateTracker,
  getVideoPresentationSnapshot,
} = require("./participants-fullscreen.js");

test("video diagnostics use presentedFrames when callbacks skip frames", () => {
  let now = 0;
  const tracker = createVideoFrameRateTracker(() => now);

  tracker.noteFrame({ presentedFrames: 10 });
  now = 1000;
  tracker.noteFrame({ presentedFrames: 55 });

  assert.equal(tracker.sample(), 45);
  assert.equal(tracker.presentedFrames(), 55);
});

test("video diagnostics fall back to callback count without presentedFrames", () => {
  let now = 0;
  const tracker = createVideoFrameRateTracker(() => now);

  tracker.noteFrame();
  tracker.noteFrame();
  now = 1000;

  assert.equal(tracker.sample(), 2);
  assert.equal(tracker.presentedFrames(), null);
});

test("video presentation snapshot returns null for missing element", () => {
  assert.equal(getVideoPresentationSnapshot(null), null);
});

test("video presentation snapshot returns the element stats object", () => {
  const stats = { fps: 59.8, width: 1920, height: 1080 };
  assert.equal(getVideoPresentationSnapshot({ _echoPresentationStats: stats }), stats);
});
```

- [ ] **Step 2: Run the test to verify the current baseline**

Run:

```powershell
node --test 'F:\EC-worktrees\screen-sources-command\core\viewer\video-diagnostics.test.js'
```

Expected before implementation: fail if `getVideoPresentationSnapshot` or `presentedFrames()` is missing.

- [ ] **Step 3: Implement the diagnostic tracker**

In `core/viewer/participants-fullscreen.js`, keep the existing `createVideoFrameRateTracker()` shape but replace it with this implementation:

```js
function createVideoFrameRateTracker(nowFn) {
  const getNow = typeof nowFn === "function" ? nowFn : () => performance.now();
  let callbackFrames = 0;
  let lastCallbackFrames = 0;
  let latestPresentedFrames = null;
  let lastPresentedFrames = null;
  let lastSampleTs = getNow();

  function noteFrame(metadata) {
    callbackFrames += 1;
    const presented = Number(metadata?.presentedFrames);
    if (Number.isFinite(presented)) {
      if (lastPresentedFrames === null) {
        lastPresentedFrames = presented;
      }
      latestPresentedFrames = presented;
    }
  }

  function sample(sampleTs) {
    const now = typeof sampleTs === "number" ? sampleTs : getNow();
    const elapsed = (now - lastSampleTs) / 1000;
    let frameDelta = callbackFrames - lastCallbackFrames;

    if (latestPresentedFrames !== null && lastPresentedFrames !== null) {
      frameDelta = latestPresentedFrames - lastPresentedFrames;
      lastPresentedFrames = latestPresentedFrames;
    }

    lastCallbackFrames = callbackFrames;
    lastSampleTs = now;

    if (!Number.isFinite(frameDelta) || frameDelta < 0) {
      frameDelta = 0;
    }
    return elapsed > 0 ? frameDelta / elapsed : 0;
  }

  function presentedFrames() {
    return latestPresentedFrames;
  }

  return { noteFrame, sample, presentedFrames };
}

function getVideoPresentationSnapshot(element) {
  return element?._echoPresentationStats || null;
}
```

- [ ] **Step 4: Store presentation stats on each video element**

In `attachVideoDiagnostics()`, after `const fps = frameRate.sample(now);` and after computing `w`, `h`, `ready`, `muted`, and `isBlack`, store the stats:

```js
    element._echoPresentationStats = {
      fps,
      width: w,
      height: h,
      readyState: ready,
      muted: mediaTrack?.muted === true,
      black: isBlack,
      firstFrameTs: element._firstFrameTs || 0,
      lastFrameTs: element._lastFrameTs || 0,
      presentedFrames: frameRate.presentedFrames(),
      updatedAt: Date.now(),
    };
```

Keep the overlay line as:

```js
    overlay.textContent = `${w}x${h} | fps ${fps.toFixed(1)} | ${muted} | rs ${ready}${isBlack ? " | black" : ""}`;
```

- [ ] **Step 5: Export the diagnostic helpers for Node tests**

At the bottom of `core/viewer/participants-fullscreen.js`, use this export block:

```js
if (typeof module === "object" && module.exports) {
  module.exports = {
    createVideoFrameRateTracker,
    getVideoPresentationSnapshot,
  };
}
```

- [ ] **Step 6: Remove the render cap from the grid module**

In `core/viewer/participants-grid.js`, delete `computeScreenRenderCap()` and `applyScreenRenderCap()`. In `tagAspect()`, remove this line:

```js
        applyScreenRenderCap(element);
```

At the bottom of the file, remove the CommonJS export block that exports `computeScreenRenderCap`.

- [ ] **Step 7: Delete the render-cap test**

Delete `core/viewer/screen-render-cap.test.js`.

- [ ] **Step 8: Run viewer tests**

Run:

```powershell
node --test 'F:\EC-worktrees\screen-sources-command\core\viewer\*.test.js'
```

Expected: all viewer tests pass, and no render-cap test remains.

- [ ] **Step 9: Commit**

Run:

```powershell
git add -- core/viewer/participants-fullscreen.js core/viewer/participants-grid.js core/viewer/video-diagnostics.test.js
git add --update -- core/viewer/screen-render-cap.test.js
git commit -m "fix(viewer): measure presented screen frames accurately"
```

---

### Task 2: Extend Stats Schema for Presentation and Display Path Evidence

**Files:**
- Modify: `core/control/src/admin.rs`

- [ ] **Step 1: Add schema fields**

In `core/control/src/admin.rs`, add this field to `ClientStats` after `capture_health`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) display_status: Option<ClientDisplayStatus>,
```

Add these fields to `SubscriptionStats` after `ice_remote_type`:

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presented_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presented_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presented_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presented_frames: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presentation_age_ms: Option<u64>,
```

Add this struct after `SubscriptionStats`:

```rust
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub(crate) struct ClientDisplayStatus {
    pub(crate) available: bool,
    pub(crate) current_display_id: Option<String>,
    pub(crate) current_display_name: Option<String>,
    pub(crate) preferred_display_id: Option<String>,
    pub(crate) on_preferred_display: bool,
    pub(crate) window_spans_displays: bool,
    pub(crate) window_x: i32,
    pub(crate) window_y: i32,
    pub(crate) window_width: u32,
    pub(crate) window_height: u32,
    pub(crate) scale_factor: Option<f64>,
}
```

- [ ] **Step 2: Merge display status in `client_stats_report`**

In `client_stats_report()`, inside the `Some(existing)` arm after the `capture_health` merge, add:

```rust
            if payload.display_status.is_some() {
                existing.display_status = payload.display_status;
            }
```

In the `None` arm, no special code is needed because `payload` is inserted as a whole after `updated_at` is assigned.

- [ ] **Step 3: Run control-plane tests/check**

Run:

```powershell
cargo check -p echo-core-control
```

Expected: `echo-core-control` checks successfully.

- [ ] **Step 4: Commit**

Run:

```powershell
git add -- core/control/src/admin.rs
git commit -m "feat(control): accept display presentation stats"
```

---

### Task 3: Add Native Display Placement Logic with Unit Tests

**Files:**
- Create: `core/client/src/display_placement.rs`
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Create the pure geometry and selection module**

Create `core/client/src/display_placement.rs` with this complete content:

```rust
use serde::{Deserialize, Serialize};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DisplayRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct EchoDisplayInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) rect: DisplayRect,
    pub(crate) scale_factor: f64,
    pub(crate) primary: bool,
    pub(crate) preferred: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct EchoDisplayStatus {
    pub(crate) available: bool,
    pub(crate) displays: Vec<EchoDisplayInfo>,
    pub(crate) current_display_id: Option<String>,
    pub(crate) current_display_name: Option<String>,
    pub(crate) preferred_display_id: Option<String>,
    pub(crate) on_preferred_display: bool,
    pub(crate) window_spans_displays: bool,
    pub(crate) window_x: i32,
    pub(crate) window_y: i32,
    pub(crate) window_width: u32,
    pub(crate) window_height: u32,
    pub(crate) scale_factor: Option<f64>,
}

impl DisplayRect {
    fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }

    fn intersection_area(&self, other: &DisplayRect) -> u64 {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= left || bottom <= top {
            return 0;
        }
        (right - left) as u64 * (bottom - top) as u64
    }
}

pub(crate) fn make_display_id(name: &str, rect: &DisplayRect) -> String {
    format!("{}:{}:{}:{}:{}", name, rect.x, rect.y, rect.width, rect.height)
}

pub(crate) fn select_preferred_display<'a>(
    displays: &'a [EchoDisplayInfo],
    preferred_id: Option<&str>,
) -> Option<&'a EchoDisplayInfo> {
    if let Some(id) = preferred_id.filter(|s| !s.trim().is_empty()) {
        if let Some(display) = displays.iter().find(|display| display.id == id) {
            return Some(display);
        }
    }
    displays
        .iter()
        .find(|display| display.primary)
        .or_else(|| displays.first())
}

pub(crate) fn display_with_largest_overlap<'a>(
    window_rect: &DisplayRect,
    displays: &'a [EchoDisplayInfo],
) -> Option<&'a EchoDisplayInfo> {
    displays
        .iter()
        .max_by_key(|display| window_rect.intersection_area(&display.rect))
}

pub(crate) fn window_spans_displays(window_rect: &DisplayRect, displays: &[EchoDisplayInfo]) -> bool {
    let overlap_count = displays
        .iter()
        .filter(|display| window_rect.intersection_area(&display.rect) > 0)
        .count();
    overlap_count > 1
}

fn centered_window_rect(display: &EchoDisplayInfo, width: u32, height: u32) -> DisplayRect {
    let clamped_width = width.min(display.rect.width);
    let clamped_height = height.min(display.rect.height);
    DisplayRect {
        x: display.rect.x + ((display.rect.width - clamped_width) / 2) as i32,
        y: display.rect.y + ((display.rect.height - clamped_height) / 2) as i32,
        width: clamped_width,
        height: clamped_height,
    }
}

fn preferred_display_from_settings(app: &tauri::AppHandle) -> Option<String> {
    let settings_path = app.path().app_data_dir().ok()?.join("settings.json");
    let settings = std::fs::read_to_string(settings_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&settings).ok()?;
    json.get("echo-preferred-display-id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn load_preferred_display_id(app: &tauri::AppHandle) -> Option<String> {
    preferred_display_from_settings(app)
}

pub(crate) fn list_echo_displays(
    window: &WebviewWindow,
    preferred_id: Option<&str>,
) -> Result<Vec<EchoDisplayInfo>, String> {
    let primary_id = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .map(|monitor| {
            let name = monitor.name().cloned().unwrap_or_else(|| "Display".to_string());
            let pos = monitor.position();
            let size = monitor.size();
            let rect = DisplayRect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            };
            make_display_id(&name, &rect)
        });

    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let displays = monitors
        .into_iter()
        .map(|monitor| {
            let name = monitor.name().cloned().unwrap_or_else(|| "Display".to_string());
            let pos = monitor.position();
            let size = monitor.size();
            let rect = DisplayRect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            };
            let id = make_display_id(&name, &rect);
            EchoDisplayInfo {
                primary: primary_id.as_deref() == Some(id.as_str()),
                preferred: preferred_id == Some(id.as_str()),
                id,
                name,
                rect,
                scale_factor: monitor.scale_factor(),
            }
        })
        .collect();

    Ok(displays)
}

pub(crate) fn build_display_status(
    window: &WebviewWindow,
    preferred_id: Option<&str>,
) -> Result<EchoDisplayStatus, String> {
    let displays = list_echo_displays(window, preferred_id)?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let window_rect = DisplayRect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    let current = display_with_largest_overlap(&window_rect, &displays);
    let current_display_id = current.map(|display| display.id.clone());
    let current_display_name = current.map(|display| display.name.clone());
    let scale_factor = current.map(|display| display.scale_factor);
    let spans = window_spans_displays(&window_rect, &displays);
    let on_preferred = preferred_id
        .filter(|value| !value.trim().is_empty())
        .and_then(|id| current_display_id.as_ref().map(|current_id| current_id == id))
        .unwrap_or(true);

    Ok(EchoDisplayStatus {
        available: !displays.is_empty(),
        displays,
        current_display_id,
        current_display_name,
        preferred_display_id: preferred_id.map(ToOwned::to_owned),
        on_preferred_display: on_preferred,
        window_spans_displays: spans,
        window_x: window_rect.x,
        window_y: window_rect.y,
        window_width: window_rect.width,
        window_height: window_rect.height,
        scale_factor,
    })
}

pub(crate) fn move_window_to_display(
    window: &WebviewWindow,
    display_id: &str,
) -> Result<EchoDisplayStatus, String> {
    let displays = list_echo_displays(window, Some(display_id))?;
    let display = select_preferred_display(&displays, Some(display_id))
        .ok_or_else(|| "No displays available".to_string())?;
    let target = centered_window_rect(display, 1280, 800);

    let _ = window.unmaximize();
    window
        .set_position(Position::Physical(PhysicalPosition::new(target.x, target.y)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(Size::Physical(PhysicalSize::new(target.width, target.height)))
        .map_err(|e| e.to_string())?;
    let _ = window.maximize();

    build_display_status(window, Some(display_id))
}

pub(crate) fn move_window_to_saved_preferred_display(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
) -> Result<Option<EchoDisplayStatus>, String> {
    let Some(display_id) = load_preferred_display_id(app) else {
        return Ok(None);
    };
    move_window_to_display(window, &display_id).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: &str, x: i32, y: i32, width: u32, height: u32, primary: bool) -> EchoDisplayInfo {
        EchoDisplayInfo {
            id: id.to_string(),
            name: id.to_string(),
            rect: DisplayRect { x, y, width, height },
            scale_factor: 1.0,
            primary,
            preferred: false,
        }
    }

    #[test]
    fn selects_saved_preferred_display_first() {
        let displays = vec![
            display("intel", -2560, 0, 2560, 1440, false),
            display("rtx", 0, 0, 2560, 1440, true),
        ];

        assert_eq!(
            select_preferred_display(&displays, Some("intel")).unwrap().id,
            "intel"
        );
    }

    #[test]
    fn falls_back_to_primary_without_saved_preference() {
        let displays = vec![
            display("left", -2560, 0, 2560, 1440, false),
            display("primary", 0, 0, 2560, 1440, true),
        ];

        assert_eq!(
            select_preferred_display(&displays, None).unwrap().id,
            "primary"
        );
    }

    #[test]
    fn detects_window_spanning_two_displays() {
        let displays = vec![
            display("left", -2560, 0, 2560, 1440, false),
            display("right", 0, 0, 2560, 1440, true),
        ];
        let window = DisplayRect { x: -100, y: 10, width: 400, height: 400 };

        assert!(window_spans_displays(&window, &displays));
    }

    #[test]
    fn does_not_flag_window_inside_one_display_as_spanning() {
        let displays = vec![
            display("left", -2560, 0, 2560, 1440, false),
            display("right", 0, 0, 2560, 1440, true),
        ];
        let window = DisplayRect { x: 100, y: 10, width: 400, height: 400 };

        assert!(!window_spans_displays(&window, &displays));
    }
}
```

- [ ] **Step 2: Run module tests**

Near the existing Windows-only module declarations in `core/client/src/main.rs`, add:

```rust
#[cfg(target_os = "windows")]
mod display_placement;
```

Then run:

```powershell
cargo test -p echo-core-client display_placement
```

Expected: the four `display_placement` unit tests pass.

- [ ] **Step 3: Commit**

Run:

```powershell
git add -- core/client/src/main.rs core/client/src/display_placement.rs
git commit -m "test(client): cover Echo display placement logic"
```

---

### Task 4: Wire Display Authority into the Tauri Client

**Files:**
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Add Tauri commands**

In `core/client/src/main.rs`, after `set_always_on_top()`, add:

```rust
#[cfg(target_os = "windows")]
#[tauri::command]
fn list_echo_displays(app: tauri::AppHandle, preferred_display_id: Option<String>) -> Result<Vec<display_placement::EchoDisplayInfo>, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::list_echo_displays(&window, preferred_display_id.as_deref())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_echo_display_status(app: tauri::AppHandle, preferred_display_id: Option<String>) -> Result<display_placement::EchoDisplayStatus, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::build_display_status(&window, preferred_display_id.as_deref())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn move_echo_to_display(app: tauri::AppHandle, display_id: String) -> Result<display_placement::EchoDisplayStatus, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::move_window_to_display(&window, &display_id)
}
```

- [ ] **Step 2: Register the commands**

In the `tauri::generate_handler!` list in `core/client/src/main.rs`, after `report_encoder_implementation`, add:

```rust
            #[cfg(target_os = "windows")]
            list_echo_displays,
            #[cfg(target_os = "windows")]
            get_echo_display_status,
            #[cfg(target_os = "windows")]
            move_echo_to_display,
```

- [ ] **Step 3: Apply saved preferred display on launch**

In the setup block, replace the current one-shot build call:

```rust
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(viewer_url.parse().unwrap()),
            )
            .title("Echo Chamber")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .initialization_script("window.__ECHO_NATIVE__ = true;")
            .build()?;
```

with:

```rust
            let main_window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(viewer_url.parse().unwrap()),
            )
            .title("Echo Chamber")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .initialization_script("window.__ECHO_NATIVE__ = true;")
            .build()?;

            #[cfg(target_os = "windows")]
            {
                let app_handle = app.handle().clone();
                match display_placement::move_window_to_saved_preferred_display(&app_handle, &main_window) {
                    Ok(Some(status)) => {
                        eprintln!(
                            "[display] moved Echo to preferred display {:?} current={:?} spans={}",
                            status.preferred_display_id,
                            status.current_display_name,
                            status.window_spans_displays
                        );
                    }
                    Ok(None) => {
                        eprintln!("[display] no preferred Echo display saved");
                    }
                    Err(e) => {
                        eprintln!("[display] preferred display move failed: {}", e);
                    }
                }
            }
```

- [ ] **Step 4: Run client tests/check**

Run:

```powershell
cargo test -p echo-core-client display_placement
cargo check -p echo-core-client
```

Expected: both commands pass on Windows. Do not build macOS targets.

- [ ] **Step 5: Commit**

Run:

```powershell
git add -- core/client/src/main.rs core/client/src/display_placement.rs
git commit -m "feat(client): prefer saved Echo display"
```

---

### Task 5: Add Viewer Display Status and Stats Reporting

**Files:**
- Create: `core/viewer/display-status.js`
- Create: `core/viewer/display-status.test.js`
- Modify: `core/viewer/settings.js`
- Modify: `core/viewer/index.html`
- Modify: `core/viewer/screen-share-adaptive.js`
- Modify: `core/viewer/style.css`

- [ ] **Step 1: Add display settings keys**

In `core/viewer/settings.js`, add these keys to `_SETTINGS_KEYS` after `"echo-performance-mode"`:

```js
  "echo-preferred-display-id", "echo-auto-move-to-preferred-display"
```

The final array ending should look like:

```js
  "echo-avatar-device", "echo-volume-prefs",
  "echo-performance-mode",
  "echo-preferred-display-id", "echo-auto-move-to-preferred-display"
];
```

- [ ] **Step 2: Create the display-status test**

Create `core/viewer/display-status.test.js` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { isEchoDisplayWarning } = require("./display-status.js");

test("display warning is false when native status is unavailable", () => {
  assert.equal(isEchoDisplayWarning(null), false);
  assert.equal(isEchoDisplayWarning({ available: false }), false);
});

test("display warning is true when Echo is off the preferred display", () => {
  assert.equal(isEchoDisplayWarning({
    available: true,
    on_preferred_display: false,
    window_spans_displays: false,
  }), true);
});

test("display warning is true when Echo spans displays", () => {
  assert.equal(isEchoDisplayWarning({
    available: true,
    on_preferred_display: true,
    window_spans_displays: true,
  }), true);
});
```

- [ ] **Step 3: Create display-status.js**

Create `core/viewer/display-status.js` with:

```js
/* =========================================================
   DISPLAY STATUS — native Echo display-path badge and stats cache
   ========================================================= */

var _echoDisplayStatus = null;
var _echoDisplayStatusTimer = null;

function isEchoDisplayWarning(status) {
  if (!status || status.available === false) return false;
  return status.on_preferred_display === false || status.window_spans_displays === true;
}

function getEchoDisplayStatusSnapshot() {
  return _echoDisplayStatus || null;
}

function getPreferredEchoDisplayId() {
  return echoGet("echo-preferred-display-id") || "";
}

async function refreshEchoDisplayStatus() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return null;
  try {
    var preferredId = getPreferredEchoDisplayId();
    _echoDisplayStatus = await tauriInvoke("get_echo_display_status", {
      preferredDisplayId: preferredId || null,
    });
    renderEchoDisplayStatus(_echoDisplayStatus);
    return _echoDisplayStatus;
  } catch (e) {
    debugLog("[display] status failed: " + e);
    return null;
  }
}

async function moveEchoToPreferredDisplay() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return null;
  var preferredId = getPreferredEchoDisplayId();
  if (!preferredId) {
    showToast("No Echo display selected yet", 2500);
    return null;
  }
  try {
    _echoDisplayStatus = await tauriInvoke("move_echo_to_display", { displayId: preferredId });
    renderEchoDisplayStatus(_echoDisplayStatus);
    return _echoDisplayStatus;
  } catch (e) {
    showToast("Display move failed: " + e, 4000);
    debugLog("[display] move failed: " + e);
    return null;
  }
}

async function saveCurrentEchoDisplayAsPreferred() {
  var status = await refreshEchoDisplayStatus();
  if (!status || !status.current_display_id) {
    showToast("Could not detect current Echo display", 3000);
    return;
  }
  echoSet("echo-preferred-display-id", status.current_display_id);
  showToast("Echo display saved: " + (status.current_display_name || "current display"), 2500);
  await refreshEchoDisplayStatus();
}

function renderEchoDisplayStatus(status) {
  var el = document.getElementById("echo-display-status");
  if (!el) return;
  if (!status || status.available === false) {
    el.classList.add("hidden");
    return;
  }

  var warning = isEchoDisplayWarning(status);
  var name = status.current_display_name || "Display";
  var suffix = warning ? "Check display path" : "Full-tilt display";
  el.textContent = suffix + ": " + name;
  el.title = "Click to save this monitor as Echo's preferred full-performance display. Shift-click moves Echo to the saved display.";
  el.classList.remove("hidden");
  el.classList.toggle("display-warning", warning);
}

function startEchoDisplayStatusMonitor() {
  if (_echoDisplayStatusTimer) return;
  refreshEchoDisplayStatus();
  _echoDisplayStatusTimer = setInterval(refreshEchoDisplayStatus, 5000);
  var el = document.getElementById("echo-display-status");
  if (el && !el._echoDisplayClickBound) {
    el._echoDisplayClickBound = true;
    el.addEventListener("click", function(e) {
      if (e.shiftKey) moveEchoToPreferredDisplay();
      else saveCurrentEchoDisplayAsPreferred();
    });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", startEchoDisplayStatusMonitor);
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    isEchoDisplayWarning,
  };
}
```

- [ ] **Step 4: Add the badge host and script**

In `core/viewer/index.html`, change the grid header from:

```html
            <div class="grid-header">
              <h2>Screens</h2>
            </div>
```

to:

```html
            <div class="grid-header">
              <h2>Screens</h2>
              <button id="echo-display-status" type="button" class="echo-display-status hidden"></button>
            </div>
```

Add the script after `settings.js` and before `identity.js`:

```html
    <script src="display-status.js?v=0.6.10-local.1.1776128211"></script>
```

- [ ] **Step 5: Include presentation stats in inbound reports**

In `core/viewer/screen-share-adaptive.js`, add this helper near the top of the file after the header comment:

```js
function getScreenPresentationStatsForIdentity(identity) {
  var tile = screenTileByIdentity.get(identity);
  var video = tile ? tile.querySelector("video") : null;
  if (typeof getVideoPresentationSnapshot === "function") {
    return getVideoPresentationSnapshot(video);
  }
  return video?._echoPresentationStats || null;
}
```

Inside the `inboundArr2.push({ ... })` block, before the push, add:

```js
          var presentation = source === "screen" ? getScreenPresentationStatsForIdentity(fromId) : null;
          var presentationAge = presentation?.updatedAt
            ? Math.max(0, Date.now() - presentation.updatedAt)
            : null;
```

Then add these fields to the pushed object:

```js
            presented_fps: presentation ? presentation.fps : null,
            presented_width: presentation ? presentation.width : null,
            presented_height: presentation ? presentation.height : null,
            presented_frames: presentation ? presentation.presentedFrames : null,
            presentation_age_ms: presentationAge,
```

- [ ] **Step 6: Include display status in the stats POST**

In the `body: JSON.stringify({ ... })` payload in `screen-share-adaptive.js`, add:

```js
              display_status: typeof getEchoDisplayStatusSnapshot === "function"
                ? getEchoDisplayStatusSnapshot()
                : null,
```

Place it after `capture_health: captureHealth`.

- [ ] **Step 7: Style the badge**

In `core/viewer/style.css`, after `.grid-header h2`, add:

```css
.grid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.echo-display-status {
  border: 1px solid rgba(56, 189, 248, 0.35);
  background: rgba(8, 47, 73, 0.72);
  color: rgba(226, 232, 240, 0.96);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
}

.echo-display-status.display-warning {
  border-color: rgba(245, 158, 11, 0.65);
  background: rgba(69, 43, 8, 0.82);
  color: #fde68a;
}
```

- [ ] **Step 8: Run viewer tests**

Run:

```powershell
node --test 'F:\EC-worktrees\screen-sources-command\core\viewer\*.test.js'
```

Expected: all viewer tests pass.

- [ ] **Step 9: Commit**

Run:

```powershell
git add -- core/viewer/display-status.js core/viewer/display-status.test.js core/viewer/settings.js core/viewer/index.html core/viewer/screen-share-adaptive.js core/viewer/style.css
git commit -m "feat(viewer): report Echo display path"
```

---

### Task 6: Protect the Screen Video Surface Without Lowering Quality

**Files:**
- Modify: `core/viewer/participants-grid.js`
- Modify: `core/viewer/style.css`
- Create: `core/viewer/screen-video-surface.test.js`

- [ ] **Step 1: Write the regression test**

Create `core/viewer/screen-video-surface.test.js` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gridJs = fs.readFileSync(path.join(__dirname, "participants-grid.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");

test("screen tiles do not apply a render-size cap", () => {
  assert.equal(gridJs.includes("computeScreenRenderCap"), false);
  assert.equal(gridJs.includes("applyScreenRenderCap"), false);
  assert.equal(gridJs.includes("maxWidth ="), false);
  assert.equal(gridJs.includes("maxHeight ="), false);
});

test("screen video elements receive the protected surface class", () => {
  assert.match(gridJs, /element\.classList\.add\("screen-video-surface"\)/);
});

test("protected video surface rules avoid direct filters and clipping", () => {
  const match = css.match(/\.screens-grid \.tile video\.screen-video-surface\s*\{([^}]*)\}/);
  assert.ok(match, "missing .screens-grid .tile video.screen-video-surface rule");
  assert.equal(/filter\s*:/.test(match[1]), false);
  assert.equal(/backdrop-filter\s*:/.test(match[1]), false);
  assert.equal(/border-radius\s*:/.test(match[1]), false);
  assert.equal(/box-shadow\s*:/.test(match[1]), false);
});
```

- [ ] **Step 2: Mark screen videos as protected surfaces**

In `core/viewer/participants-grid.js`, after `configureVideoElement(element, true);`, add:

```js
  element.classList.add("screen-video-surface");
```

- [ ] **Step 3: Move polish to wrapper/overlay layers**

In `core/viewer/style.css`, replace the current `.screens-grid .tile video` rule with:

```css
.screens-grid .tile video.screen-video-surface {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: transparent;
  flex: 1 1 0;
  min-height: 0;
  justify-self: center;
  align-self: center;
  transform: translateZ(0);
  backface-visibility: hidden;
  mix-blend-mode: normal;
}
```

Replace the current `.screens-grid .tile` rule with:

```css
.screens-grid .tile {
  min-height: 0;
  min-width: 0;
  max-height: 100%;
  max-width: 100%;
  overflow: visible;
  aspect-ratio: 16 / 9;
  justify-self: center;
  align-self: center;
  position: relative;
  isolation: isolate;
}

.screens-grid .tile::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: var(--radius);
  border: 1px solid rgba(148, 163, 184, 0.18);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  z-index: 3;
}
```

Ensure existing overlays remain above the video:

```css
.screens-grid .tile .tile-overlay,
.screens-grid .tile .tile-fullscreen-btn,
.screens-grid .tile .tile-volume-wrap,
.screens-grid .tile .tile-poster {
  z-index: 4;
}
```

- [ ] **Step 4: Run viewer tests**

Run:

```powershell
node --test 'F:\EC-worktrees\screen-sources-command\core\viewer\*.test.js'
```

Expected: all viewer tests pass, including `screen-video-surface.test.js`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add -- core/viewer/participants-grid.js core/viewer/style.css core/viewer/screen-video-surface.test.js
git commit -m "feat(viewer): protect full-quality screen video surface"
```

---

### Task 7: Verification and Live Test Protocol

**Files:**
- No required file changes.

- [ ] **Step 1: Run automated verification**

Run:

```powershell
node --test 'F:\EC-worktrees\screen-sources-command\core\viewer\*.test.js'
cargo test -p echo-core-client display_placement
cargo check -p echo-core-client
cargo check -p echo-core-control
```

Expected: all commands pass. Do not build macOS targets.

- [ ] **Step 2: Build the Windows client only when Sam is ready to test**

Run:

```powershell
cargo build -p echo-core-client
```

Expected: Windows desktop client builds successfully.

- [ ] **Step 3: Close and reopen Echo for Sam before validation**

Tell Sam before starting:

```text
Close Echo now. I am going to reopen the freshly built client, move it to the saved full-performance display, and then start monitoring only after you say the remote screen is visible.
```

Then launch the built client using the repo's existing local-client workflow or the built binary path produced by Cargo.

- [ ] **Step 4: Save the 4090 monitor as preferred**

With Echo visibly on the 4090-connected monitor, tell Sam:

```text
Click the display badge next to Screens once. That saves this monitor as Echo's preferred full-performance display.
```

Expected: the badge says `Full-tilt display: <display name>` and `settings.json` contains `echo-preferred-display-id`.

- [ ] **Step 5: Test non-maximized and maximized states**

Tell Sam:

```text
Leave Echo non-maximized for 60 seconds while Spencer's screen is visible. I will read WebRTC receive FPS, presented FPS, and display path status. Then maximize Echo and keep the same stream visible for another 60 seconds.
```

Evidence to capture from `/admin/api/dashboard`:

- `inbound[].fps`
- `inbound[].presented_fps`
- `inbound[].decoded`
- `inbound[].dropped`
- `display_status.current_display_name`
- `display_status.on_preferred_display`
- `display_status.window_spans_displays`

- [ ] **Step 6: Decide whether WebView2 is the wall**

Use this decision rule:

- If WebRTC receive FPS and presented FPS both stay healthy when maximized, this batch fixed the issue.
- If WebRTC receive FPS is healthy but presented FPS collapses while Echo is on the preferred 4090 display and not spanning monitors, WebView2 presentation is the wall.
- If Echo is off the preferred display or spanning monitors, fix display placement first and rerun the test.

- [ ] **Step 7: Commit verification notes**

Create or update `docs/handovers/2026-05-02-full-quality-display-path-validation.md` with:

```markdown
# Full-Quality Display Path Validation

Date: 2026-05-02
Branch: codex/screen-sources-command-investigation

## Build

- Client build:
- Viewer tests:
- Client checks:
- Control checks:

## Display Path

- Preferred display:
- Current display:
- Window spans displays:

## Non-Maximized Result

- WebRTC receive FPS:
- Presented FPS:
- Dropped frames:
- Visible result:

## Maximized Result

- WebRTC receive FPS:
- Presented FPS:
- Dropped frames:
- Visible result:

## Decision

- Result:
- Next step:
```

Then run:

```powershell
git add -- docs/handovers/2026-05-02-full-quality-display-path-validation.md
git commit -m "docs: record full-quality display validation"
```

---

## Native Presenter Decision Gate

Do not start native presenter work inside this batch. Start a separate design/spec only if Task 7 proves all of these at the same time:

- Echo is on the saved preferred 4090 display.
- Echo is not spanning displays.
- WebRTC receive FPS is healthy.
- Presented FPS collapses when maximized.
- Removing direct video-surface effects did not restore smooth presentation.

The next spec should target a minimal Direct3D/DirectComposition proof of concept for one received screen tile while keeping WebView2 as the surrounding UI shell.
