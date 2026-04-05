use axum_server::tls_rustls::RustlsConfig;
use rand::RngCore;
use rcgen::generate_simple_self_signed;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::info;

#[derive(Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub admin_password_hash: Option<String>,
    pub admin_password: Option<String>,
    pub admin_jwt_secret: String,
    pub admin_token_ttl_secs: u64,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub livekit_token_ttl_secs: u64,
    pub soundboard_dir: PathBuf,
    pub soundboard_max_bytes: usize,
    pub soundboard_max_sounds_per_room: usize,
    pub chat_dir: PathBuf,
    pub chat_uploads_dir: PathBuf,
    pub chat_max_upload_bytes: usize,
    pub turn_user: Option<String>,
    pub turn_pass: Option<String>,
    pub turn_host: Option<String>,
    pub turn_port: u16,
    pub github_pat: Option<String>,
    pub github_repo: Option<String>,
}

pub fn load_dotenv() {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("CORE_ENV_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(core_dir) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(core_dir.join("control").join(".env"));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("control").join(".env"));
        candidates.push(current.join(".env"));
    }

    for path in candidates {
        if !path.exists() {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(&path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let mut parts = line.splitn(2, '=');
                let key = parts.next().unwrap_or("").trim();
                let value = parts.next().unwrap_or("").trim();
                if key.is_empty() {
                    continue;
                }
                std::env::set_var(key, value);
            }
            info!("loaded env from {:?}", path);
            break;
        }
    }
}

pub fn resolve_path(value: String) -> PathBuf {
    let path = PathBuf::from(&value);
    if path.is_absolute() {
        return path;
    }
    if let Ok(current) = std::env::current_dir() {
        return current.join(path);
    }
    PathBuf::from(value)
}

pub fn resolve_viewer_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_VIEWER_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("viewer");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("viewer");
            }
        }
        return current.join("core").join("viewer");
    }
    PathBuf::from("viewer")
}

pub fn resolve_admin_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_ADMIN_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("admin");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("admin");
            }
        }
        return current.join("core").join("admin");
    }
    PathBuf::from("admin")
}

pub fn resolve_deploy_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ECHO_CORE_DEPLOY_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("control") {
                if let Some(parent) = current.parent() {
                    return parent.join("deploy");
                }
            }
            if name.eq_ignore_ascii_case("core") {
                return current.join("deploy");
            }
        }
        return current.join("core").join("deploy");
    }
    PathBuf::from("deploy")
}

/// Stamp cache-busting version query strings into viewer/index.html on disk.
/// Called once at server startup so ServeDir serves the already-stamped file.
/// Idempotent — strips old ?v= params before re-stamping.
pub fn stamp_viewer_index(viewer_dir: &PathBuf, v: &str) {
    let index_path = viewer_dir.join("index.html");
    match fs::read_to_string(&index_path) {
        Ok(html) => {
            let assets = [
                "style.css", "jam.css",
                "livekit-client.umd.js", "room-switch-state.js", "jam-session-state.js", "publish-state-reconcile.js",
                "state.js", "debug.js", "urls.js", "settings.js", "identity.js",
                "rnnoise.js", "chimes.js", "room-status.js", "auth.js", "theme.js",
                "chat.js", "soundboard.js",
                "screen-share-state.js", "screen-share-config.js", "screen-share-quality.js",
                "screen-share-adaptive.js", "screen-share-native.js",
                "participants.js",
                "audio-routing.js", "media-controls.js", "admin.js", "connect.js",
                "app.js", "jam.js", "changelog.js",
                "capture-picker.js", "capture-picker.css",
            ];
            let mut stamped = html;
            for asset in &assets {
                // Remove any existing ?v=... before the closing quote
                // Use leading quote to avoid substring matches (e.g. "state.js" inside "room-switch-state.js")
                let with_param = format!("\"{}?v=", asset);
                if let Some(pos) = stamped.find(&with_param) {
                    // Find the closing quote after the ?v= param
                    let after = pos + with_param.len();
                    if let Some(q) = stamped[after..].find('"') {
                        stamped = format!("{}\"{}\"{}",
                            &stamped[..pos],
                            asset,
                            &stamped[after + q + 1..]);
                    }
                }
                // Now stamp the fresh version (also use leading quote for precision)
                let plain = format!("\"{}\"", asset);
                let versioned = format!("\"{}?v={}\"", asset, v);
                stamped = stamped.replace(&plain, &versioned);
            }
            if let Err(e) = fs::write(&index_path, &stamped) {
                eprintln!("WARNING: could not stamp index.html: {}", e);
            } else {
                info!("Stamped viewer/index.html with ?v={}", v);
            }
        }
        Err(e) => eprintln!("WARNING: could not read index.html for stamping: {}", e),
    }
}

/// Simple URL encoding for query parameters
pub fn urlencoded(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

/// Strip the -XXXX numeric suffix from identities like "sam-1234" -> "sam"
/// Reconnects change the suffix, so compare base identities for host checks.
pub fn identity_base(identity: &str) -> &str {
    if let Some(pos) = identity.rfind('-') {
        let suffix = &identity[pos + 1..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return &identity[..pos];
        }
    }
    identity
}

pub fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

pub fn now_ts_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

pub fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Simplified date calculation from Unix epoch days
    let mut y: i64 = 1970;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining < md as i64 {
            m = i;
            break;
        }
        remaining -= md as i64;
    }
    (y as u64, (m + 1) as u64, (remaining + 1) as u64)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub async fn generate_self_signed() -> RustlsConfig {
    let rcgen::CertifiedKey { cert, key_pair } = generate_simple_self_signed(vec![
        "echo.fellowshipoftheboatrace.party".into(),
        "echo-core.local".into(),
        "localhost".into(),
        "127.0.0.1".into(),
    ])
    .expect("failed to generate self-signed cert");
    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
        .await
        .expect("failed to load generated TLS cert")
}
