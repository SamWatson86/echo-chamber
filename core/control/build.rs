use std::{env, path::PathBuf, process::Command};

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn valid_git_sha(value: &str) -> bool {
    (7..=40).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn short_sha(value: String) -> String {
    value.chars().take(12).collect()
}

fn watch_git_path(path: Option<String>) {
    let Some(path) = path else {
        return;
    };
    let path = PathBuf::from(path);
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=ECHO_GIT_SHA");

    // Worktrees keep HEAD and branch refs under the repository's shared git
    // directory. Watching both paths prevents an incremental control build from
    // reporting the SHA from an earlier viewer-only commit.
    watch_git_path(git_output(&["rev-parse", "--git-path", "HEAD"]));
    if let Some(symbolic_ref) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        watch_git_path(git_output(&["rev-parse", "--git-path", &symbolic_ref]));
    }

    let configured = match env::var("ECHO_GIT_SHA") {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            assert!(
                valid_git_sha(&value),
                "ECHO_GIT_SHA must contain 7 to 40 hexadecimal characters"
            );
            Some(short_sha(value))
        }
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => panic!("ECHO_GIT_SHA must be valid Unicode"),
    };
    let discovered = git_output(&["rev-parse", "--short=12", "HEAD"])
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| valid_git_sha(value))
        .map(short_sha);
    let git_sha = configured
        .or(discovered)
        .expect("exact Git metadata is required; build from a Git checkout or set ECHO_GIT_SHA");

    println!("cargo:rustc-env=ECHO_GIT_SHA={git_sha}");
}
