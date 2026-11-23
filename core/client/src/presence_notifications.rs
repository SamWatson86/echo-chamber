use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use windows::core::{w, HSTRING, PCSTR, PCWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, HMODULE,
};
use windows::Win32::Media::Audio::{PlaySoundA, SND_ASYNC, SND_MEMORY, SND_NODEFAULT, SND_SYSTEM};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS};
use windows::UI::Notifications::{
    NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotificationMode,
};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_BASELINE_AGE: Duration = Duration::from_secs(15);
const NOTIFICATION_SETTINGS: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";

#[derive(Debug, PartialEq, Eq)]
enum Cue {
    SignOn,
    SignOff,
}

impl Cue {
    fn wave(&self) -> &'static [u8] {
        match self {
            Self::SignOn => include_bytes!("../sounds/sign-on.wav"),
            Self::SignOff => include_bytes!("../sounds/sign-off.wav"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Notice {
    message: String,
    cue: Cue,
}

#[derive(Default, Deserialize, PartialEq, Eq)]
struct Preferences {
    #[serde(rename = "echo-windows-presence-notifications")]
    notifications: Option<String>,
    #[serde(rename = "echo-core-remember-name")]
    own_name: Option<String>,
}

fn preferences(path: &Path) -> Option<Preferences> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(Preferences::default()),
        Err(_) => None,
    }
}

#[derive(Deserialize)]
struct OnlineUser {
    name: String,
}

struct Member {
    name: String,
    missed_once: bool,
}

struct Roster {
    sampled_at: Instant,
    members: BTreeMap<String, Member>,
}

fn change_line(names: &[String], action: &str) -> String {
    match names {
        [] => String::new(),
        [name] => format!("{name} signed {action}"),
        [first, second] => format!("{first} and {second} signed {action}"),
        [first, second, others @ ..] => {
            let count = others.len();
            let label = if count == 1 { "other" } else { "others" };
            format!("{first}, {second} and {count} {label} signed {action}")
        }
    }
}

fn observe(
    baseline: &mut Option<Roster>,
    users: Vec<OnlineUser>,
    own_name: Option<&str>,
    now: Instant,
) -> Option<Notice> {
    let own_key = own_name.map(|name| name.trim().to_lowercase());
    let mut members = BTreeMap::new();
    for user in users {
        let name = user.name.trim();
        let key = name.to_lowercase();
        if !name.is_empty() && own_key.as_ref() != Some(&key) {
            let display_name = name.split_whitespace().collect::<Vec<_>>().join(" ");
            members.insert(
                key,
                Member {
                    name: display_name,
                    missed_once: false,
                },
            );
        }
    }
    let previous = baseline.replace(Roster {
        sampled_at: now,
        members,
    });
    let Some(previous) =
        previous.filter(|roster| now.duration_since(roster.sampled_at) <= MAX_BASELINE_AGE)
    else {
        return None;
    };

    let current = &mut baseline.as_mut().expect("sample was just stored").members;
    let joined: Vec<_> = current
        .iter()
        .filter(|(key, _)| !previous.members.contains_key(*key))
        .map(|(_, member)| member.name.clone())
        .collect();
    let mut left = Vec::new();
    for (key, mut member) in previous.members {
        if current.contains_key(&key) {
            continue;
        }
        // A brief absence can be a room handoff or a reconnect.
        if member.missed_once {
            left.push(member.name);
        } else {
            member.missed_once = true;
            current.insert(key, member);
        }
    }
    let on = change_line(&joined, "on");
    let off = change_line(&left, "off");
    match (on.is_empty(), off.is_empty()) {
        (true, true) => None,
        (true, false) => Some(Notice {
            message: off,
            cue: Cue::SignOff,
        }),
        (false, true) => Some(Notice {
            message: on,
            cue: Cue::SignOn,
        }),
        // A batched banner plays just one cue.
        (false, false) => Some(Notice {
            message: format!("{on}\n{off}"),
            cue: Cue::SignOn,
        }),
    }
}

fn toast_xml(message: &str) -> windows::core::Result<XmlDocument> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(concat!(
        "<toast><visual><binding template=\"ToastGeneric\">",
        "<text>Echo Chamber</text><text/>",
        "</binding></visual><audio silent=\"true\"/></toast>"
    )))?;
    // Treat names from the roster as text, including any XML metacharacters.
    let body = xml.GetElementsByTagName(&HSTRING::from("text"))?.Item(1)?;
    body.AppendChild(&xml.CreateTextNode(&HSTRING::from(message))?)?;
    Ok(xml)
}

fn sound_setting_enabled(path: &str, name: PCWSTR) -> bool {
    let mut value = 0u32;
    let mut size = std::mem::size_of_val(&value) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(path),
            name,
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
    };
    match result {
        ERROR_SUCCESS => value != 0,
        // Windows defaults to allowing sounds when no override is set.
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => true,
        _ => false,
    }
}

fn play_cue(app_id: &str, cue: &Cue) {
    if !matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_ACCEPTS_NOTIFICATIONS)
    ) || !sound_setting_enabled(
        NOTIFICATION_SETTINGS,
        w!("NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND"),
    ) || !sound_setting_enabled(
        &format!(r"{NOTIFICATION_SETTINGS}\{app_id}"),
        w!("AllowSound"),
    ) {
        return;
    }
    // Older Windows builds lack NotificationMode and use the shell state above.
    if let Ok(mode) =
        ToastNotificationManager::GetDefault().and_then(|user| user.NotificationMode())
    {
        if mode != ToastNotificationMode::Unrestricted {
            return;
        }
    }
    // SND_MEMORY reads a WAV byte buffer. The embedded bytes stay alive for
    // asynchronous playback, and SND_SYSTEM uses the System Sounds mixer.
    let played = unsafe {
        PlaySoundA(
            PCSTR(cue.wave().as_ptr()),
            HMODULE::default(),
            SND_MEMORY | SND_ASYNC | SND_NODEFAULT | SND_SYSTEM,
        )
    };
    if !played.as_bool() {
        eprintln!("[presence] Windows notification sound could not be played");
    }
}

fn show_toast(app_id: &str, notice: &Notice) -> windows::core::Result<()> {
    // This runs on a blocking worker rather than the window or network thread.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let result = (|| {
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
        notifier.Show(&ToastNotification::CreateToastNotification(&toast_xml(
            &notice.message,
        )?)?)?;
        // Echo supplies the audio for this toast.
        if matches!(notifier.Setting(), Ok(NotificationSetting::Enabled)) {
            play_cue(app_id, &notice.cue);
        }
        Ok(())
    })();
    unsafe { RoUninitialize() };
    result
}

pub(crate) fn start(app: &tauri::AppHandle, window: &tauri::WebviewWindow, server: &str) {
    let Ok(path) = crate::settings_path(app) else {
        return;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let url = format!("{}/api/online", server.trim_end_matches('/'));
    let app_id = format!("{}.desktop", app.config().identifier);
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let mut baseline = None;
        let mut last_preferences = None;
        let mut poll = tokio::time::interval(POLL_INTERVAL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            poll.tick().await;
            let Ok(minimized) = window.is_minimized() else {
                break;
            };
            if !minimized {
                baseline = None;
                continue;
            }
            let current_preferences = preferences(&path);
            if current_preferences != last_preferences {
                baseline = None;
                last_preferences = current_preferences;
            }
            let Some(prefs) = &last_preferences else {
                continue;
            };
            if prefs.notifications.as_deref() == Some("0") {
                baseline = None;
                continue;
            }
            let Ok(response) = client
                .get(&url)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            else {
                continue;
            };
            let Ok(users) = response.json::<Vec<OnlineUser>>().await else {
                continue;
            };
            if !matches!(window.is_minimized(), Ok(true))
                || preferences(&path).as_ref() != Some(prefs)
            {
                baseline = None;
                continue;
            }
            if let Some(notice) = observe(
                &mut baseline,
                users,
                prefs.own_name.as_deref(),
                Instant::now(),
            ) {
                let app_id = app_id.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = show_toast(&app_id, &notice) {
                        eprintln!("[presence] Windows notification could not be sent: {error}");
                    }
                })
                .await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn users(names: &[&str]) -> Vec<OnlineUser> {
        names
            .iter()
            .map(|name| OnlineUser {
                name: (*name).into(),
            })
            .collect()
    }

    #[test]
    fn ignores_initial_presence_self_and_brief_absence_then_confirms_departure() {
        let mut roster = None;
        let start = Instant::now();
        let mut sample = |names: &[&str], second| {
            observe(
                &mut roster,
                users(names),
                Some("Sam"),
                start + Duration::from_secs(second),
            )
        };
        assert_eq!(sample(&["sam", "Jeff"], 0), None);
        assert_eq!(
            sample(&["Sam", "David"], 5),
            Some(Notice {
                message: "David signed on".into(),
                cue: Cue::SignOn,
            })
        );
        assert_eq!(sample(&["Jeff", "David"], 10), None);
        assert_eq!(sample(&["Jeff"], 15), None);
        assert_eq!(
            sample(&["Jeff"], 20),
            Some(Notice {
                message: "David signed off".into(),
                cue: Cue::SignOff,
            })
        );
        assert_eq!(sample(&["Brad"], 40), None);
    }

    #[test]
    fn batches_changes_and_escapes_display_names_in_silent_windows_payload() {
        let mut roster = None;
        let now = Instant::now();
        observe(&mut roster, users(&["David"]), None, now);
        observe(&mut roster, users(&[]), None, now + POLL_INTERVAL);
        let notice = observe(
            &mut roster,
            users(&["Jeff", "Alex & <co>", "Brad"]),
            None,
            now + POLL_INTERVAL * 2,
        )
        .unwrap();
        assert_eq!(
            notice.message,
            "Alex & <co>, Brad and 1 other signed on\nDavid signed off"
        );
        assert_eq!(notice.cue, Cue::SignOn);
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).unwrap() };
        {
            let xml = toast_xml(&notice.message).unwrap();
            assert!(ToastNotification::CreateToastNotification(&xml).is_ok());
            let xml = xml.GetXml().unwrap().to_string_lossy();
            assert!(xml.contains("Alex &amp; &lt;co&gt;"));
            assert!(xml.contains("audio silent=\"true\""));
        }
        unsafe { RoUninitialize() };
    }
}
