//! tf-backend: child process of the `tf` TUI. Talks JSON lines on stdin/stdout,
//! runs a hidden Jackett, searches every enabled indexer in parallel (streaming
//! results), and hands downloads to dl-daemon. Exits — stopping Jackett — when
//! stdin closes or on SIGTERM/SIGINT/SIGHUP.

mod dl;
mod engine;
mod indexers;
mod paths;
mod protocol;
mod search;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::signal::unix::{SignalKind, signal};

use engine::{Engine, State};
use protocol::{Out, Request};

struct App {
    engine: Arc<Engine>,
    out: Out,
    search: Mutex<Option<tokio::task::JoinHandle<()>>>,
    next_search: AtomicU64,
}

fn need<'a>(p: &'a Value, k: &str) -> Result<&'a str> {
    p[k].as_str().ok_or_else(|| anyhow!("missing param {k}"))
}

impl App {
    /// Finds Jackett and starts it; reports `missing` if it is not installed.
    async fn boot(self: Arc<Self>) {
        let _ = std::fs::create_dir_all(paths::data_dir());
        if engine::find_jackett().is_none() {
            self.engine.set(State::Missing { brew: engine::find_brew().is_some() });
            return;
        }
        self.launch().await;
    }

    async fn launch(&self) {
        let res = async {
            let c = self.engine.start().await?;
            self.engine.set(State::Configuring);
            indexers::first_run(&self.engine, &c).await?;
            Ok::<_, anyhow::Error>(c)
        }
        .await;
        match res {
            Ok(c) => self.engine.set(State::Ready(c)),
            Err(e) => {
                self.engine.stop().await;
                self.engine.set(State::Failed(format!("{e:#}")));
            }
        }
    }

    async fn run_search(self: Arc<Self>, sid: u64, query: String, tab: String) {
        let started = Instant::now();
        let ms = |t: Instant| t.elapsed().as_millis() as u64;
        let conn = match self.engine.ready().await {
            Ok(c) => c,
            Err(e) => {
                self.out.event("search_done", json!({"searchId": sid, "error": e.to_string(), "ms": ms(started)}));
                return;
            }
        };
        let list = match indexers::configured(&self.engine, &conn).await {
            Ok(l) => l.into_iter().filter(|i| i.enabled).collect::<Vec<_>>(),
            Err(e) => {
                self.out.event("search_done", json!({"searchId": sid, "error": e.to_string(), "ms": ms(started)}));
                return;
            }
        };
        self.out.event(
            "search_start",
            json!({"searchId": sid, "indexers": list.iter().map(|i| json!({"id": i.id, "name": i.name})).collect::<Vec<_>>()}),
        );
        let cats = search::tab_categories(&tab);
        let mut set = tokio::task::JoinSet::new();
        for i in list.iter().cloned() {
            let (http, c, q, cats) = (self.engine.http.clone(), conn.clone(), query.clone(), cats.clone());
            set.spawn(async move {
                let t = Instant::now();
                let r = search::query_indexer(&http, &c, &i.id, &i.name, &q, &cats).await;
                (i, r, t.elapsed().as_millis() as u64)
            });
        }
        let mut merged = HashMap::new();
        let (mut ok, mut failed) = (0, 0);
        while let Some(j) = set.join_next().await {
            let Ok((i, r, took)) = j else { continue };
            let mut ev = json!({"searchId": sid, "indexer": i.id, "name": i.name, "ms": took});
            match r {
                Ok(items) => {
                    ok += 1;
                    ev["ok"] = json!(true);
                    ev["count"] = json!(items.len());
                    search::merge(&mut merged, items);
                }
                Err(e) => {
                    failed += 1;
                    ev["ok"] = json!(false);
                    ev["error"] = json!(e.to_string());
                }
            }
            ev["results"] = serde_json::to_value(search::sorted(&merged)).unwrap_or_default();
            self.out.event("results", ev);
        }
        self.out.event(
            "search_done",
            json!({"searchId": sid, "ok": ok, "failed": failed, "total": list.len(), "ms": ms(started)}),
        );
    }

    /// Picks what to hand to dl for one result: magnet first, else the resolved link.
    async fn input_for(&self, item: &Value) -> Result<String> {
        if let Some(m) = item["magnet"].as_str().filter(|m| m.starts_with("magnet:")) {
            return Ok(m.to_string());
        }
        let link = item["link"].as_str().ok_or_else(|| anyhow!("no magnet or .torrent link"))?;
        let id = item["id"].as_str().unwrap_or("torrent");
        dl::resolve_link(&self.engine.raw, link, id).await
    }

    async fn dispatch(self: &Arc<Self>, method: &str, p: Value) -> Result<Value> {
        Ok(match method {
            "ping" => json!("pong"),
            "status" => self.engine.current().to_json(),
            "install_engine" => {
                if !matches!(self.engine.current(), State::Missing { .. } | State::Failed(_)) {
                    return Err(anyhow!("engine is not missing"));
                }
                let a = self.clone();
                tokio::spawn(async move {
                    match a.engine.install().await {
                        Ok(()) => a.launch().await,
                        Err(e) => a.engine.set(State::Failed(format!("{e:#}"))),
                    }
                });
                json!(true)
            }
            "retry_engine" => {
                let a = self.clone();
                tokio::spawn(async move { a.boot().await });
                json!(true)
            }
            "search" => {
                let query = need(&p, "query")?.trim().to_string();
                if query.is_empty() {
                    return Err(anyhow!("empty query"));
                }
                let tab = p["category"].as_str().unwrap_or("all").to_string();
                let sid = self.next_search.fetch_add(1, Ordering::SeqCst) + 1;
                let h = tokio::spawn(self.clone().run_search(sid, query, tab));
                if let Some(old) = self.search.lock().unwrap().replace(h) {
                    old.abort();
                }
                json!({"searchId": sid})
            }
            "cancel" => {
                if let Some(h) = self.search.lock().unwrap().take() {
                    h.abort();
                }
                json!(true)
            }
            "indexers" => {
                let c = self.engine.ready().await?;
                serde_json::to_value(indexers::configured(&self.engine, &c).await?)?
            }
            "catalog" => {
                let c = self.engine.ready().await?;
                indexers::catalog(&self.engine, &c).await?
            }
            "set_indexer" => {
                indexers::set_enabled(need(&p, "id")?, p["enabled"].as_bool().unwrap_or(true));
                json!(true)
            }
            "add_indexer" => {
                let c = self.engine.ready().await?;
                indexers::add(&self.engine, &c, need(&p, "id")?).await?;
                json!(true)
            }
            "remove_indexer" => {
                let c = self.engine.ready().await?;
                indexers::remove(&self.engine, &c, need(&p, "id")?).await?;
                json!(true)
            }
            "dl_config" => dl::call("config", json!({})).await?,
            "resolve" => json!(self.input_for(&p["item"]).await?),
            "send" => {
                let items = p["items"].as_array().cloned().unwrap_or_default();
                if items.is_empty() {
                    return Err(anyhow!("nothing to send"));
                }
                let dir = p["dir"].as_str().filter(|d| !d.trim().is_empty()).map(String::from);
                let mut sent = Vec::new();
                let mut errors = Vec::new();
                for it in &items {
                    let title = it["title"].as_str().unwrap_or("?").to_string();
                    let res = async {
                        let input = self.input_for(it).await?;
                        let mut params = json!({"input": input, "select": false});
                        if let Some(d) = &dir {
                            params["dir"] = json!(d);
                        }
                        dl::call("add", params).await
                    }
                    .await;
                    match res {
                        Ok(r) => {
                            for e in r["errors"].as_array().into_iter().flatten() {
                                errors.push(json!({"title": title, "error": e}));
                            }
                            if r["ids"].as_array().is_some_and(|a| !a.is_empty()) {
                                sent.push(json!(title));
                            }
                        }
                        Err(e) => errors.push(json!({"title": title, "error": format!("{e:#}")})),
                    }
                }
                json!({"sent": sent, "errors": errors})
            }
            m => return Err(anyhow!("unknown method {m}")),
        })
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("tf-backend {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let out = Out(tx);
    let app = Arc::new(App {
        engine: Arc::new(Engine::new(out.clone())),
        out: out.clone(),
        search: Mutex::new(None),
        next_search: AtomicU64::new(0),
    });
    tokio::spawn(app.clone().boot());

    let mut term = signal(SignalKind::terminate()).expect("signal");
    let mut int = signal(SignalKind::interrupt()).expect("signal");
    let mut hup = signal(SignalKind::hangup()).expect("signal");
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            l = lines.next_line() => match l {
                Ok(Some(line)) => {
                    if line.trim().is_empty() { continue; }
                    let req: Request = match serde_json::from_str(&line) {
                        Ok(r) => r,
                        Err(e) => { out.reply(0, Err(anyhow!("bad request: {e}"))); continue; }
                    };
                    let (app, out) = (app.clone(), out.clone());
                    tokio::spawn(async move {
                        let r = app.dispatch(&req.method, req.params).await;
                        out.reply(req.id, r);
                    });
                }
                _ => break, // EOF: the TUI is gone
            },
            _ = term.recv() => break,
            _ = int.recv() => break,
            _ = hup.recv() => break,
        }
    }
    if let Some(h) = app.search.lock().unwrap().take() {
        h.abort();
    }
    app.engine.stop().await;
    drop(app);
    drop(out);
    let _ = tokio::time::timeout(std::time::Duration::from_millis(300), writer).await;
    std::process::exit(0);
}
