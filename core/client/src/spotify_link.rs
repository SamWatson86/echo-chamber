const SPOTIFY_ID_LENGTH: usize = 22;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpotifyTarget<'a> {
    uri: &'a str,
    url: &'a str,
}

pub(crate) fn validate_spotify_target<'a>(
    uri: &'a str,
    url: &'a str,
) -> Result<SpotifyTarget<'a>, String> {
    let remainder = uri
        .strip_prefix("spotify:")
        .ok_or_else(|| "Invalid Spotify URI".to_string())?;
    let (resource_type, id) = remainder
        .split_once(':')
        .ok_or_else(|| "Invalid Spotify URI".to_string())?;

    if !matches!(resource_type, "track" | "playlist") {
        return Err("Only Spotify track and playlist URIs are allowed".to_string());
    }
    if id.len() != SPOTIFY_ID_LENGTH || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err("Invalid Spotify resource ID".to_string());
    }

    let canonical_url = format!("https://open.spotify.com/{resource_type}/{id}");
    if url != canonical_url {
        return Err("Spotify fallback URL does not match the URI".to_string());
    }

    Ok(SpotifyTarget { uri, url })
}

#[cfg(target_os = "windows")]
fn shell_open(target: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let target_wide: Vec<u16> = OsStr::new(target).encode_wide().chain(once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            windows::core::w!("open"),
            PCWSTR(target_wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let result_code = result.0 as isize;

    if result_code > 32 {
        Ok(())
    } else {
        Err(format!("Windows shell open failed with code {result_code}"))
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn open_spotify_target(uri: &str, url: &str) -> Result<(), String> {
    open_spotify_target_with(uri, url, shell_open)
}

fn open_spotify_target_with(
    uri: &str,
    url: &str,
    mut opener: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let target = validate_spotify_target(uri, url)?;

    match opener(target.uri) {
        Ok(()) => Ok(()),
        Err(uri_error) => {
            eprintln!("[spotify] native URI launch failed ({uri_error}); opening HTTPS fallback");
            opener(target.url).map_err(|url_error| {
                format!(
                    "Spotify URI launch failed ({uri_error}); HTTPS fallback failed ({url_error})"
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACK_ID: &str = "6rqhFgbbKwnb9MLmUQDhG6";
    const PLAYLIST_ID: &str = "3cEYpjA9oz9GiPac4AsH4n";

    #[test]
    fn allows_matching_track_and_playlist_targets() {
        let cases = [
            (
                "spotify:track:6rqhFgbbKwnb9MLmUQDhG6",
                "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6",
            ),
            (
                "spotify:playlist:3cEYpjA9oz9GiPac4AsH4n",
                "https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n",
            ),
        ];

        for (uri, url) in cases {
            assert_eq!(
                validate_spotify_target(uri, url),
                Ok(SpotifyTarget { uri, url })
            );
        }
    }

    #[test]
    fn rejects_non_spotify_and_unsafe_fallback_schemes() {
        let uri = format!("spotify:track:{TRACK_ID}");
        let canonical_url = format!("https://open.spotify.com/track/{TRACK_ID}");
        for unsafe_uri in [
            "file:///C:/Windows/System32/calc.exe".to_string(),
            "javascript:alert('unsafe')".to_string(),
            canonical_url.clone(),
        ] {
            assert!(validate_spotify_target(&unsafe_uri, &canonical_url).is_err());
        }
        for url in [
            format!("file:///C:/Windows/System32/calc.exe#{TRACK_ID}"),
            format!("javascript:alert('{TRACK_ID}')"),
            format!("http://open.spotify.com/track/{TRACK_ID}"),
        ] {
            assert!(validate_spotify_target(&uri, &url).is_err());
        }
    }

    #[test]
    fn rejects_arbitrary_spotify_commands() {
        for uri in [
            format!("spotify:album:{TRACK_ID}"),
            format!("spotify:artist:{TRACK_ID}"),
            format!("spotify:search:{TRACK_ID}"),
            format!("spotify:user:{TRACK_ID}"),
        ] {
            let url = format!("https://open.spotify.com/track/{TRACK_ID}");
            assert!(validate_spotify_target(&uri, &url).is_err());
        }
    }

    #[test]
    fn rejects_mismatched_types_and_ids() {
        let different_id = "7rqhFgbbKwnb9MLmUQDhG7";
        assert!(validate_spotify_target(
            &format!("spotify:track:{TRACK_ID}"),
            &format!("https://open.spotify.com/track/{different_id}"),
        )
        .is_err());
        assert!(validate_spotify_target(
            &format!("spotify:track:{TRACK_ID}"),
            &format!("https://open.spotify.com/playlist/{TRACK_ID}"),
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_id_lengths_and_characters() {
        for id in [
            "6rqhFgbbKwnb9MLmUQDhG",
            "6rqhFgbbKwnb9MLmUQDhG66",
            "6rqhFgbbKwnb9MLmUQDhG-",
            "6rqhFgbbKwnb9MLmUQDhG_",
        ] {
            assert!(validate_spotify_target(
                &format!("spotify:track:{id}"),
                &format!("https://open.spotify.com/track/{id}"),
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_newlines_arguments_and_noncanonical_urls() {
        let canonical_uri = format!("spotify:playlist:{PLAYLIST_ID}");
        let canonical_url = format!("https://open.spotify.com/playlist/{PLAYLIST_ID}");
        let cases = [
            (
                format!("{canonical_uri}\n--launch-option"),
                canonical_url.clone(),
            ),
            (
                canonical_uri.clone(),
                format!("{canonical_url}\r\nfile:///C:/Windows/System32/calc.exe"),
            ),
            (canonical_uri.clone(), format!("{canonical_url}?si=abc")),
            (canonical_uri.clone(), format!("{canonical_url}/")),
        ];

        for (uri, url) in cases {
            assert!(validate_spotify_target(&uri, &url).is_err());
        }
    }

    #[test]
    fn native_uri_is_preferred_and_https_is_only_a_fallback() {
        let uri = format!("spotify:track:{TRACK_ID}");
        let url = format!("https://open.spotify.com/track/{TRACK_ID}");
        let mut successful_calls = Vec::new();
        open_spotify_target_with(&uri, &url, |target| {
            successful_calls.push(target.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(successful_calls, vec![uri.clone()]);

        let mut fallback_calls = Vec::new();
        open_spotify_target_with(&uri, &url, |target| {
            fallback_calls.push(target.to_string());
            if target == uri {
                Err("no Spotify URI handler".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(fallback_calls, vec![uri, url]);
    }

    #[test]
    fn reports_both_native_and_https_launch_failures() {
        let uri = format!("spotify:playlist:{PLAYLIST_ID}");
        let url = format!("https://open.spotify.com/playlist/{PLAYLIST_ID}");
        let error = open_spotify_target_with(&uri, &url, |target| Err(format!("blocked {target}")))
            .unwrap_err();
        assert!(error.contains("Spotify URI launch failed"));
        assert!(error.contains("HTTPS fallback failed"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "opens the installed Spotify app; run manually before a Windows release"]
    fn opens_requested_target_in_installed_spotify() {
        let kind = std::env::var("ECHO_SPOTIFY_SMOKE_KIND")
            .expect("set ECHO_SPOTIFY_SMOKE_KIND to track or playlist");
        assert!(matches!(kind.as_str(), "track" | "playlist"));
        let id = std::env::var("ECHO_SPOTIFY_SMOKE_ID")
            .expect("set ECHO_SPOTIFY_SMOKE_ID to the target's 22-character Spotify ID");
        let uri = format!("spotify:{kind}:{id}");
        let url = format!("https://open.spotify.com/{kind}/{id}");
        let target = validate_spotify_target(&uri, &url).expect("invalid Spotify smoke target");

        shell_open(target.uri).expect("Windows rejected the native Spotify URI");
        eprintln!("Opened {kind} {id} through the native Spotify URI handler");
    }
}
