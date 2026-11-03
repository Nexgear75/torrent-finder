//! Indexer management through Jackett's admin API, plus our own on/off switch
//! (disabled indexers stay configured in Jackett but are not queried).

use anyhow::Result;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::engine::{Conn, Engine};
use crate::paths;
use crate::search::clean_error;

/// Public indexers configured on first launch.
pub const DEFAULTS: &[&str] = &[
    "thepiratebay",
    "yts",
    "eztv",
    "nyaasi",
    "torrentgalaxyclone",
    "limetorrents",
    "1337x",
    "kickasstorrents-to",
    "rutracker-ru",
];

#[derive(Serialize, Deserialize, Default)]
struct Store {
    #[serde(default)]
    defaults_configured: bool,
    #[serde(default)]
    disabled: BTreeSet<String>,
}

fn load() -> Store {
    std::fs::read(paths::state_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(s: &Store) {
    let _ = std::fs::create_dir_all(paths::data_dir());
    let _ = std::fs::write(paths::state_file(), serde_json::to_vec_pretty(s).unwrap_or_default());
}

#[derive(Serialize, Clone)]
pub struct Info {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub language: String,
    pub site: String,
    pub error: Option<String>,
}

pub async fn configure(e: &Engine, c: &Conn, id: &str) -> Result<()> {
    let cfg = e.admin(c, Method::GET, &format!("/api/v2.0/indexers/{id}/config"), None).await?;
    e.admin(c, Method::POST, &format!("/api/v2.0/indexers/{id}/config"), Some(&cfg)).await?;
    Ok(())
}

/// Adds the default indexers the first time we run.
pub async fn first_run(e: &Arc<Engine>, c: &Conn) -> Result<()> {
    let mut store = load();
    if store.defaults_configured {
        return Ok(());
    }
    let mut set = tokio::task::JoinSet::new();
    for id in DEFAULTS {
        let (e, c, id) = (e.clone(), c.clone(), id.to_string());
        set.spawn(async move { configure(&e, &c, &id).await });
    }
    while set.join_next().await.is_some() {}
    store.defaults_configured = true;
    save(&store);
    Ok(())
}

fn parse_list(v: &Value, disabled: &BTreeSet<String>) -> Vec<Info> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|x| {
            let id = x["id"].as_str().unwrap_or("").to_string();
            Info {
                enabled: !disabled.contains(&id),
                name: x["name"].as_str().unwrap_or(&id).to_string(),
                language: x["language"].as_str().unwrap_or("").to_string(),
                site: x["site_link"].as_str().unwrap_or("").to_string(),
                error: x["last_error"].as_str().filter(|s| !s.is_empty()).map(clean_error),
                id,
            }
        })
        .filter(|i| !i.id.is_empty())
        .collect()
}

/// Indexers configured in Jackett, with our enabled flag.
pub async fn configured(e: &Engine, c: &Conn) -> Result<Vec<Info>> {
    let v = e.admin(c, Method::GET, "/api/v2.0/indexers?configured=true", None).await?;
    let mut list = parse_list(&v, &load().disabled);
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

/// Public indexers not configured yet (for the "add source" picker).
pub async fn catalog(e: &Engine, c: &Conn) -> Result<Value> {
    let v = e.admin(c, Method::GET, "/api/v2.0/indexers?configured=false", None).await?;
    let mut out: Vec<Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter(|x| x["type"].as_str() == Some("public") && x["configured"].as_bool() != Some(true))
        .map(|x| {
            json!({
                "id": x["id"], "name": x["name"], "language": x["language"],
                "description": x["description"],
            })
        })
        .collect();
    out.sort_by_key(|x| x["name"].as_str().unwrap_or("").to_lowercase());
    Ok(Value::Array(out))
}

pub async fn add(e: &Engine, c: &Conn, id: &str) -> Result<()> {
    configure(e, c, id).await?;
    set_enabled(id, true);
    Ok(())
}

pub async fn remove(e: &Engine, c: &Conn, id: &str) -> Result<()> {
    e.admin(c, Method::DELETE, &format!("/api/v2.0/indexers/{id}"), None).await?;
    set_enabled(id, true);
    Ok(())
}

pub fn set_enabled(id: &str, enabled: bool) {
    let mut s = load();
    if enabled {
        s.disabled.remove(id);
    } else {
        s.disabled.insert(id.to_string());
    }
    save(&s);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_marks_disabled_and_cleans_errors() {
        let v = json!([
            {"id": "yts", "name": "YTS", "language": "en-US", "last_error": "Jackett.Common.IndexerException: Exception (yts): Request failed (Error 521) - The tracker seems to be down.\n at X"},
            {"id": "eztv", "name": "EZTV", "last_error": null}
        ]);
        let mut d = BTreeSet::new();
        d.insert("eztv".to_string());
        let l = parse_list(&v, &d);
        assert!(l[0].enabled);
        assert!(!l[1].enabled);
        assert_eq!(l[0].error.as_deref(), Some("site is down"));
        assert_eq!(l[1].error, None);
    }
}
