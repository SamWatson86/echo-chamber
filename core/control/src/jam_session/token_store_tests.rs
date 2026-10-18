use super::super::{persist_spotify_token, spotify_token_from_refresh_response, SpotifyToken};
use super::*;
use serde_json::json;
use std::path::PathBuf;

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let mut random = [0u8; 16];
        OsRng.fill_bytes(&mut random);
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("echo-spotify-token-store-{suffix}"));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn token(&self) -> PathBuf {
        self.0.join("spotify-token.json")
    }
    fn assert_only_token(&self) {
        let paths: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(paths, vec![self.token()]);
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        // This fixture owns only flat, randomly named files in its own temp dir.
        for entry in fs::read_dir(&self.0).unwrap() {
            let _ = fs::remove_file(entry.unwrap().path());
        }
        let _ = fs::remove_dir(&self.0);
    }
}

fn token() -> SpotifyToken {
    serde_json::from_value(json!({
        "access_token":"fixture-access", "refresh_token":"fixture-refresh", "expires_at":100,
        "scope":"playlist-modify-private playlist-read-private",
        "playback_context": {"owner_id":"fixture-owner", "account_id":"fixture-account",
            "marker":"0123456789abcdef0123456789abcdef0123456789abcdef",
            "playlist_id":"abcdefghijklmnopqrstuv", "create_attempted":true}
    }))
    .unwrap()
}

#[test]
fn failed_partial_stage_write_retains_exact_token_and_helper() {
    let directory = TestDirectory::new();
    let path = directory.token();
    assert!(persist_spotify_token(&path, &token(), true));
    let previous = fs::read(&path).unwrap();
    let result = write_with(
        &path,
        |file| {
            file.write_all(b"{partial new credentials")?;
            Err(io::Error::other("injected full disk"))
        },
        |_, _| panic!("partial staging must not promote"),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), previous);
    directory.assert_only_token();
}

#[test]
fn failed_promotion_retains_exact_token_and_helper() {
    let directory = TestDirectory::new();
    let path = directory.token();
    assert!(persist_spotify_token(&path, &token(), true));
    let previous = fs::read(&path).unwrap();
    let result = write_with(
        &path,
        |file| file.write_all(b"new credentials"),
        |staging, target| {
            assert_eq!(fs::read(staging).unwrap(), b"new credentials");
            assert_eq!(fs::read(target).unwrap(), previous);
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected promotion refusal",
            ))
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), previous);
    directory.assert_only_token();
}

#[test]
fn successful_refresh_round_trip_preserves_helper_identity_and_fence() {
    let directory = TestDirectory::new();
    let path = directory.token();
    let original = token();
    assert!(persist_spotify_token(&path, &original, true));
    let refreshed = spotify_token_from_refresh_response(&original,
        &json!({"access_token":"fresh-fixture-access", "refresh_token":"rotated-fixture-refresh", "expires_in":3600}), 200).unwrap();
    assert!(persist_spotify_token(&path, &refreshed, true));
    let stored: SpotifyToken = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored.access_token, "fresh-fixture-access");
    assert_eq!(stored.refresh_token, "rotated-fixture-refresh");
    assert_eq!(stored.playback_context, original.playback_context);
    assert_eq!(stored.scope, original.scope);
    directory.assert_only_token();
}

#[cfg(windows)]
#[test]
fn windows_native_promotion_failure_never_removes_existing_token() {
    let directory = TestDirectory::new();
    let path = directory.token();
    write(&path, b"previous token and helper fence").unwrap();
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = write(&path, b"new credentials");
    fs::set_permissions(&path, permissions).unwrap();
    assert!(
        result.is_err(),
        "MoveFileEx must refuse the read-only destination"
    );
    assert_eq!(fs::read(&path).unwrap(), b"previous token and helper fence");
    directory.assert_only_token();
}

#[cfg(windows)]
fn powershell(path: &Path, script: &str) -> String {
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("ECHO_TOKEN_STORE_TEST_FILE", path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_string()
}

#[cfg(windows)]
fn dacl(path: &Path) -> String {
    // CreateFile may clear the auto-inherited bookkeeping flag while preserving
    // the protected DACL and every ACE. Compare the actual access policy.
    powershell(path, "$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl($env:ECHO_TOKEN_STORE_TEST_FILE).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)")
        .replace("D:PAI(", "D:P(")
}

#[cfg(windows)]
#[test]
fn windows_restrictive_dacl_exists_before_secret_write_and_survives_promotion() {
    let directory = TestDirectory::new();
    let path = directory.token();
    write(&path, b"previous fixture credentials").unwrap();
    powershell(
        &path,
        r#"
        $ErrorActionPreference='Stop'
        $tokenAcl = New-Object System.Security.AccessControl.FileSecurity
        $tokenAcl.SetAccessRuleProtection($true, $false)
        $tokenIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $tokenRule = New-Object System.Security.AccessControl.FileSystemAccessRule($tokenIdentity, 'FullControl', 'Allow')
        $tokenAcl.AddAccessRule($tokenRule)
        [System.IO.File]::SetAccessControl($env:ECHO_TOKEN_STORE_TEST_FILE, $tokenAcl)
    "#,
    );
    let original = dacl(&path);
    assert!(original.starts_with("D:P"));
    let staging = directory.0.join("empty-stage.tmp");
    let file = platform::create_stage(&path, &staging).unwrap();
    assert_eq!(file.metadata().unwrap().len(), 0);
    drop(file);
    assert_eq!(
        dacl(&staging),
        original,
        "staging must be private before bytes exist"
    );
    fs::remove_file(&staging).unwrap();
    write(&path, b"replacement fixture credentials").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"replacement fixture credentials");
    assert_eq!(dacl(&path), original);
    directory.assert_only_token();
}

#[cfg(unix)]
#[test]
fn unix_replacement_preserves_restrictive_mode() {
    use std::os::unix::fs::PermissionsExt;
    let directory = TestDirectory::new();
    let path = directory.token();
    write(&path, b"previous fixture").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    write(&path, b"new fixture").unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    directory.assert_only_token();
}
