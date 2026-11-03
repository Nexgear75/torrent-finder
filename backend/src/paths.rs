//! Where torrent-finder keeps its files. Everything lives under one folder so a
//! user's own Jackett install (if any) is never touched.

use std::path::PathBuf;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `$TF_DATA_DIR`, else `~/.local/share/torrent-finder`.
pub fn data_dir() -> PathBuf {
    match std::env::var_os("TF_DATA_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => home().join(".local/share/torrent-finder"),
    }
}

pub fn jackett_dir() -> PathBuf {
    data_dir().join("jackett")
}

pub fn jackett_log() -> PathBuf {
    data_dir().join("jackett.log")
}

pub fn jackett_pid() -> PathBuf {
    data_dir().join("jackett.pid")
}

pub fn state_file() -> PathBuf {
    data_dir().join("state.json")
}

pub fn torrents_dir() -> PathBuf {
    data_dir().join("torrents")
}

/// First executable named `name` in `$PATH`, then in the given fallbacks.
pub fn which(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    let from_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(name)).collect::<Vec<_>>())
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(fallbacks.iter().map(PathBuf::from))
        .find(|p| is_executable(p))
}

pub fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
