use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn log_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.join("capture-debug.log")))
}

pub fn append(message: &str) {
    let Some(path) = log_path() else {
        return;
    };

    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {}", now, message);
    }
}

pub fn reset() {
    let Some(path) = log_path() else {
        return;
    };

    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    let _ = std::fs::write(path, b"");
}
