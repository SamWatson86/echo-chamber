use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};

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
