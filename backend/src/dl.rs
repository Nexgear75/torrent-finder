//! Client for dl-daemon's Unix socket (JSON lines), waking the daemon up if
//! needed, plus turning Jackett download links into something dl can keep.

use anyhow::{Context, Result, anyhow, bail};
use reqwest::header::LOCATION;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::paths;

fn dl_data_dir() -> PathBuf {
    match std::env::var_os("DL_DATA_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::home_dir().unwrap_or_default().join(".local/share/dl"),
    }
}

pub fn socket_path() -> PathBuf {
    match std::env::var_os("DL_SOCKET") {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => dl_data_dir().join("dl.sock"),
    }
}

/// `$DL_DAEMON`, next to this binary, `$PATH`, then `~/.local/bin`.
fn daemon_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("DL_DAEMON") {
        return Some(p.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        let p = exe.with_file_name("dl-daemon");
        if paths::is_executable(&p) {
            return Some(p);
        }
    }
    let local = dirs::home_dir().unwrap_or_default().join(".local/bin/dl-daemon");
    paths::which("dl-daemon", &[local.to_str().unwrap_or("")])
}

fn spawn_daemon() -> Result<()> {
    use std::os::unix::process::CommandExt;
    let bin = daemon_binary().ok_or_else(|| anyhow!("dl-daemon not found (install dl first)"))?;
    let _ = std::fs::create_dir_all(dl_data_dir());
    std::process::Command::new(&bin)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .with_context(|| format!("cannot start {}", bin.display()))?;
    Ok(())
}

async fn connect() -> Result<UnixStream> {
    let p = socket_path();
    if let Ok(s) = UnixStream::connect(&p).await {
        return Ok(s);
    }
    spawn_daemon()?;
    let mut last = None;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match UnixStream::connect(&p).await {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
    }
    bail!(
        "cannot reach dl-daemon ({}). See {}",
        last.map(|e| e.to_string()).unwrap_or_default(),
        dl_data_dir().join("daemon.log").display()
    )
}

/// One request on a fresh connection; `state` events pushed by the daemon are skipped.
pub async fn call(method: &str, params: Value) -> Result<Value> {
    let s = connect().await?;
    let (rd, mut wr) = s.into_split();
    let line = json!({"id": 1, "method": method, "params": params}).to_string() + "\n";
    wr.write_all(line.as_bytes()).await?;
    let mut lines = BufReader::new(rd).lines();
    let read = async {
        while let Some(l) = lines.next_line().await? {
            let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
            if v["id"].as_u64() != Some(1) {
                continue;
            }
            if v["ok"].as_bool() == Some(true) {
                return Ok(v["result"].clone());
            }
            bail!("{}", v["error"].as_str().unwrap_or("dl-daemon error"));
        }
        bail!("dl-daemon closed the connection")
    };
    tokio::time::timeout(Duration::from_secs(30), read).await.map_err(|_| anyhow!("dl-daemon did not answer"))?
}

/// Turns a Jackett download link into a magnet (when it redirects to one) or
/// a local .torrent file, so the download no longer depends on Jackett running.
pub async fn resolve_link(raw: &reqwest::Client, link: &str, id: &str) -> Result<String> {
    let mut url = link.to_string();
    for _ in 0..5 {
        let r = raw.get(&url).send().await.context("cannot fetch the .torrent")?;
        let status = r.status();
        if status.is_redirection() {
            let loc = r.headers().get(LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if loc.starts_with("magnet:") {
                return Ok(loc);
            }
            if loc.is_empty() {
                bail!("bad redirect from indexer");
            }
            url = reqwest::Url::parse(&url)?.join(&loc)?.to_string();
            continue;
        }
        if !status.is_success() {
            bail!("indexer returned HTTP {status} for the .torrent");
        }
        let bytes = r.bytes().await?;
        if bytes.first() != Some(&b'd') {
            bail!("indexer did not return a .torrent file");
        }
        let dir = paths::torrents_dir();
        std::fs::create_dir_all(&dir)?;
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let p = dir.join(format!("{safe}.torrent"));
        std::fs::write(&p, &bytes)?;
        return Ok(p.display().to_string());
    }
    bail!("too many redirects")
}
