//! Hidden Jackett instance: find or install it, run it on a random local port
//! with its own data folder, log in to its admin API, and stop it on exit.

use anyhow::{Context, Result, anyhow, bail};
use reqwest::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, watch};

use crate::paths;
use crate::protocol::Out;

#[derive(Clone, Debug)]
pub struct Conn {
    pub base: String,
    pub api_key: String,
    pub cookie: String,
}

#[derive(Clone, Debug)]
pub enum State {
    Checking,
    Missing { brew: bool },
    Installing,
    Starting,
    Configuring,
    Ready(Conn),
    Failed(String),
    Stopped,
}

impl State {
    pub fn to_json(&self) -> Value {
        match self {
            State::Checking => json!({"state": "checking"}),
            State::Missing { brew } => json!({"state": "missing", "brew": brew}),
            State::Installing => json!({"state": "installing"}),
            State::Starting => json!({"state": "starting"}),
            State::Configuring => json!({"state": "configuring"}),
            State::Ready(_) => json!({"state": "ready"}),
            State::Failed(m) => json!({"state": "error", "message": m}),
            State::Stopped => json!({"state": "stopped"}),
        }
    }

    fn busy(&self) -> bool {
        matches!(self, State::Checking | State::Installing | State::Starting | State::Configuring)
    }
}

pub struct Engine {
    pub state: watch::Sender<State>,
    child: Mutex<Option<Child>>,
    out: Out,
    /// Search requests (follows redirects, generous timeout).
    pub http: reqwest::Client,
    /// Admin and .torrent requests: redirects are inspected by hand.
    pub raw: reqwest::Client,
}

pub fn find_jackett() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("TF_JACKETT") {
        let p = std::path::PathBuf::from(p);
        return paths::is_executable(&p).then_some(p);
    }
    paths::which("jackett", &["/opt/homebrew/bin/jackett", "/usr/local/bin/jackett"])
}

pub fn find_brew() -> Option<std::path::PathBuf> {
    paths::which("brew", &["/opt/homebrew/bin/brew", "/usr/local/bin/brew"])
}

impl Engine {
    pub fn new(out: Out) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .expect("http client");
        let raw = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Engine { state: watch::channel(State::Checking).0, child: Mutex::new(None), out, http, raw }
    }

    pub fn set(&self, s: State) {
        self.out.event("status", s.to_json());
        self.state.send_replace(s);
    }

    pub fn current(&self) -> State {
        self.state.borrow().clone()
    }

    /// Waits until the engine is ready (or definitely not going to be).
    pub async fn ready(&self) -> Result<Conn> {
        let mut rx = self.state.subscribe();
        let s = rx.wait_for(|s| !s.busy()).await.map_err(|_| anyhow!("engine gone"))?.clone();
        match s {
            State::Ready(c) => Ok(c),
            State::Missing { .. } => bail!("search engine (Jackett) is not installed"),
            State::Failed(m) => bail!("search engine failed: {m}"),
            _ => bail!("search engine stopped"),
        }
    }

    /// Installs Jackett with Homebrew, streaming its output as `progress` events.
    pub async fn install(&self) -> Result<()> {
        let brew = find_brew().ok_or_else(|| anyhow!("Homebrew not found: install Jackett manually (brew.sh)"))?;
        self.set(State::Installing);
        let mut child = Command::new(brew)
            .args(["install", "jackett"])
            .env("HOMEBREW_NO_ENV_HINTS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("cannot run brew")?;
        let mut tasks = Vec::new();
        for pipe in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
                     child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)]
            .into_iter()
            .flatten()
        {
            let out = self.out.clone();
            tasks.push(tokio::spawn(async move {
                let mut last = String::new();
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let l = l.trim().to_string();
                    if l.is_empty() {
                        continue;
                    }
                    out.event("progress", json!({"line": l}));
                    last = l;
                }
                last
            }));
        }
        let status = child.wait().await?;
        let mut last = String::new();
        for t in tasks {
            let l = t.await.unwrap_or_default();
            if !l.is_empty() {
                last = l;
            }
        }
        if !status.success() || find_jackett().is_none() {
            bail!("brew install jackett failed: {last}");
        }
        Ok(())
    }

    /// Starts Jackett and returns once its API answers.
    pub async fn start(&self) -> Result<Conn> {
        let bin = find_jackett().ok_or_else(|| anyhow!("jackett not found"))?;
        self.set(State::Starting);
        let dir = paths::jackett_dir();
        std::fs::create_dir_all(&dir)?;
        kill_stale();

        let port = free_port()?;
        let log = std::fs::File::create(paths::jackett_log())?;
        let child = Command::new(&bin)
            .arg("--DataFolder")
            .arg(&dir)
            .arg("--Port")
            .arg(port.to_string())
            .arg("--ListenPrivate")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .with_context(|| format!("cannot run {}", bin.display()))?;
        if let Some(pid) = child.id() {
            let _ = std::fs::write(paths::jackett_pid(), pid.to_string());
        }
        *self.child.lock().await = Some(child);

        let base = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let probe = self.raw.get(format!("{base}/UI/Login")).timeout(Duration::from_secs(2)).send().await;
            if let Ok(r) = probe {
                if r.status().is_success() || r.status().is_redirection() {
                    break;
                }
            }
            if let Some(c) = self.child.lock().await.as_mut() {
                if let Ok(Some(st)) = c.try_wait() {
                    bail!("Jackett exited ({st}), see {}", paths::jackett_log().display());
                }
            }
            if Instant::now() > deadline {
                bail!("Jackett did not start within 90 s, see {}", paths::jackett_log().display());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        let api_key = read_api_key(&dir)?;
        let cookie = self.login(&base).await?;
        Ok(Conn { base, api_key, cookie })
    }

    async fn login(&self, base: &str) -> Result<String> {
        let r = self
            .raw
            .post(format!("{base}/UI/Dashboard"))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("password=")
            .send()
            .await?;
        for v in r.headers().get_all(SET_COOKIE) {
            if let Some(rest) = v.to_str().unwrap_or("").strip_prefix("Jackett=") {
                return Ok(format!("Jackett={}", rest.split(';').next().unwrap_or("")));
            }
        }
        bail!("cannot log in to Jackett admin API")
    }

    /// Admin API call (cookie auth). Returns parsed JSON, or Null for empty bodies.
    pub async fn admin(&self, c: &Conn, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut req = self.raw.request(method, format!("{}{path}", c.base)).header(COOKIE, &c.cookie);
        if let Some(b) = body {
            req = req.json(b);
        }
        let r = req.send().await?;
        let status = r.status();
        if status.is_redirection() {
            bail!("Jackett admin session refused");
        }
        let text = r.text().await?;
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or_else(|| text.chars().take(200).collect());
            bail!("{status}: {msg}");
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// SIGTERM the Jackett process group, SIGKILL after 3 s.
    pub async fn stop(&self) {
        let child = self.child.lock().await.take();
        if let Some(mut c) = child {
            if let Some(pid) = c.id() {
                unsafe { libc::killpg(pid as i32, libc::SIGTERM) };
                if tokio::time::timeout(Duration::from_secs(3), c.wait()).await.is_err() {
                    unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                    let _ = c.wait().await;
                }
            }
        }
        let _ = std::fs::remove_file(paths::jackett_pid());
        self.state.send_replace(State::Stopped);
    }
}

fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn read_api_key(dir: &std::path::Path) -> Result<String> {
    let p = dir.join("ServerConfig.json");
    let v: Value = serde_json::from_slice(&std::fs::read(&p).with_context(|| format!("cannot read {}", p.display()))?)?;
    v["APIKey"].as_str().filter(|k| !k.is_empty()).map(String::from).ok_or_else(|| anyhow!("no APIKey in ServerConfig.json"))
}

/// A previous backend killed with SIGKILL may have left its Jackett running.
fn kill_stale() {
    let Ok(pid) = std::fs::read_to_string(paths::jackett_pid()) else { return };
    let Ok(pid) = pid.trim().parse::<i32>() else { return };
    let cmd = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output();
    let dir = paths::jackett_dir().display().to_string();
    if let Ok(o) = cmd {
        let line = String::from_utf8_lossy(&o.stdout);
        if line.contains("jackett") && line.contains(&dir) {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    let _ = std::fs::remove_file(paths::jackett_pid());
}
