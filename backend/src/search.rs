//! Per-indexer search against Jackett, result normalisation, category mapping
//! and de-duplication by info-hash.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::engine::Conn;

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
pub struct Raw {
    pub title: Option<String>,
    pub tracker: Option<String>,
    pub tracker_id: Option<String>,
    pub category_desc: Option<String>,
    pub category: Option<Vec<i64>>,
    pub size: Option<f64>,
    pub seeders: Option<f64>,
    pub peers: Option<f64>,
    pub publish_date: Option<String>,
    pub magnet_uri: Option<String>,
    pub info_hash: Option<String>,
    pub link: Option<String>,
    pub details: Option<String>,
    pub guid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct IndexerStatus {
    #[serde(default)]
    status: i64,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Response {
    #[serde(default)]
    results: Vec<Raw>,
    #[serde(default)]
    indexers: Vec<IndexerStatus>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    /// Display names of every indexer that returned this torrent (best first).
    pub indexers: Vec<String>,
    pub category: String,
    /// Tab this result belongs to: games, movies, tv, music, apps, books, anime, other.
    pub kind: &'static str,
    pub size: u64,
    pub seeders: u32,
    pub leechers: u32,
    pub date: Option<String>,
    pub magnet: Option<String>,
    pub link: Option<String>,
    pub details: Option<String>,
}

/// Torznab categories sent to Jackett for a TUI tab.
pub fn tab_categories(tab: &str) -> Vec<u32> {
    match tab {
        "games" => vec![1000, 4050],
        "movies" => vec![2000],
        "tv" => vec![5000],
        "music" => vec![3000],
        "apps" => vec![4000],
        "books" => vec![7000],
        "anime" => vec![5070],
        _ => vec![],
    }
}

/// Which tab a result belongs to, from its Torznab categories (custom ids ≥ 100000 ignored).
pub fn kind_of(cats: &[i64], indexer_id: &str) -> &'static str {
    let std: Vec<i64> = cats.iter().copied().filter(|c| *c < 100_000).collect();
    if indexer_id == "nyaasi" || std.contains(&5070) {
        return "anime";
    }
    if std.iter().any(|c| *c == 4050 || (1000..2000).contains(c)) {
        return "games";
    }
    for c in &std {
        let k = match c {
            2000..=2999 => "movies",
            3000..=3999 => "music",
            4000..=4999 => "apps",
            5000..=5999 => "tv",
            7000..=7999 => "books",
            _ => continue,
        };
        return k;
    }
    "other"
}

/// Lower-case 40-char hex info-hash; base32 hashes (32 chars) are converted.
pub fn normalize_hash(h: &str) -> Option<String> {
    let h = h.trim();
    if h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(h.to_ascii_lowercase());
    }
    if h.len() == 32 {
        let mut bits: u64 = 0;
        let mut n = 0;
        let mut out = String::with_capacity(40);
        for c in h.chars() {
            let v = match c.to_ascii_uppercase() {
                c @ 'A'..='Z' => c as u64 - 'A' as u64,
                c @ '2'..='7' => c as u64 - '2' as u64 + 26,
                _ => return None,
            };
            bits = (bits << 5) | v;
            n += 5;
            if n >= 8 {
                n -= 8;
                out.push_str(&format!("{:02x}", (bits >> n) & 0xff));
            }
        }
        return Some(out);
    }
    None
}

pub fn hash_from_magnet(m: &str) -> Option<String> {
    let lower = m.to_ascii_lowercase();
    let i = lower.find("xt=urn:btih:")? + "xt=urn:btih:".len();
    let rest = &m[i..];
    let end = rest.find('&').unwrap_or(rest.len());
    normalize_hash(&rest[..end])
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn clamp_u32(v: Option<f64>) -> u32 {
    v.filter(|x| x.is_finite() && *x > 0.0).map(|x| x.min(u32::MAX as f64) as u32).unwrap_or(0)
}

pub fn normalize(r: Raw, indexer_id: &str, indexer_name: &str) -> Option<Item> {
    let title = r.title.filter(|t| !t.trim().is_empty())?.trim().to_string();
    let magnet = r.magnet_uri.filter(|m| m.starts_with("magnet:"));
    let hash = r
        .info_hash
        .as_deref()
        .and_then(normalize_hash)
        .or_else(|| magnet.as_deref().and_then(hash_from_magnet));
    let id = match &hash {
        Some(h) => h.clone(),
        None => format!(
            "x{}",
            fnv(r.guid.as_deref().or(r.details.as_deref()).unwrap_or(&format!("{indexer_id}|{title}")))
        ),
    };
    let seeders = clamp_u32(r.seeders);
    let peers = clamp_u32(r.peers);
    let cats = r.category.unwrap_or_default();
    let date = r.publish_date.filter(|d| !d.starts_with("0001-"));
    Some(Item {
        id,
        kind: kind_of(&cats, indexer_id),
        category: r.category_desc.unwrap_or_default(),
        indexers: vec![r.tracker.filter(|t| !t.is_empty()).unwrap_or_else(|| indexer_name.to_string())],
        size: r.size.filter(|s| s.is_finite() && *s > 0.0).map(|s| s as u64).unwrap_or(0),
        // Torznab "peers" counts seeders too
        leechers: peers.saturating_sub(seeders),
        seeders,
        date,
        magnet,
        link: r.link.filter(|l| !l.is_empty()),
        details: r.details.or(r.guid).filter(|d| d.starts_with("http")),
        title,
    })
}

/// Merges `items` into `map`: same id → keep the entry with most seeders,
/// remember every source, and keep a magnet if any source had one.
pub fn merge(map: &mut HashMap<String, Item>, items: Vec<Item>) {
    for it in items {
        match map.get_mut(&it.id) {
            None => {
                map.insert(it.id.clone(), it);
            }
            Some(old) => {
                let mut sources = old.indexers.clone();
                let best = if it.seeders > old.seeders {
                    sources.retain(|s| !it.indexers.contains(s));
                    let mut s = it.indexers.clone();
                    s.extend(sources);
                    s
                } else {
                    for s in &it.indexers {
                        if !sources.contains(s) {
                            sources.push(s.clone());
                        }
                    }
                    sources
                };
                let magnet = old.magnet.clone().or_else(|| it.magnet.clone());
                let details = old.details.clone().or_else(|| it.details.clone());
                if it.seeders > old.seeders {
                    *old = it;
                }
                old.indexers = best;
                old.magnet = old.magnet.clone().or(magnet);
                old.details = old.details.clone().or(details);
            }
        }
    }
}

pub fn sorted(map: &HashMap<String, Item>) -> Vec<Item> {
    let mut v: Vec<Item> = map.values().cloned().collect();
    v.sort_by(|a, b| b.seeders.cmp(&a.seeders).then_with(|| a.title.cmp(&b.title)));
    v
}

/// Shortens Jackett's exception dumps to something that fits on one line.
pub fn clean_error(e: &str) -> String {
    let first = e.lines().next().unwrap_or(e);
    if e.contains("FlareSolverr") {
        return "blocked by Cloudflare (needs FlareSolverr)".into();
    }
    if first.contains("Error 52") || first.contains("seems to be down") {
        return "site is down".into();
    }
    if first.contains("timed out") || first.contains("Timeout") || first.contains("canceled") {
        return "timed out".into();
    }
    let mut s = first;
    for prefix in ["Jackett.Common.IndexerException: ", "System.Exception: "] {
        s = s.trim_start_matches(prefix);
    }
    if let Some(i) = s.find("): ") {
        if s.starts_with("Exception (") {
            s = &s[i + 3..];
        }
    }
    s.chars().take(120).collect()
}

/// Queries one indexer. Errors are returned as short messages.
pub async fn query_indexer(
    http: &reqwest::Client,
    c: &Conn,
    id: &str,
    name: &str,
    query: &str,
    cats: &[u32],
) -> Result<Vec<Item>> {
    let mut params: Vec<(&str, String)> = vec![("apikey", c.api_key.clone()), ("Query", query.to_string())];
    for cat in cats {
        params.push(("Category[]", cat.to_string()));
    }
    let url = reqwest::Url::parse_with_params(&format!("{}/api/v2.0/indexers/{id}/results", c.base), &params)?;
    let r = match http.get(url).send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => bail!("timed out"),
        Err(e) => bail!("{e}"),
    };
    if !r.status().is_success() {
        bail!("HTTP {}", r.status());
    }
    let resp: Response = r.json().await?;
    if let Some(st) = resp.indexers.first() {
        if st.status != 2 {
            if let Some(e) = &st.error {
                bail!("{}", clean_error(e));
            }
        }
    }
    Ok(resp.results.into_iter().filter_map(|x| normalize(x, id, name)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(title: &str, hash: Option<&str>, seeders: f64, peers: f64, tracker: &str) -> Raw {
        Raw {
            title: Some(title.into()),
            tracker: Some(tracker.into()),
            info_hash: hash.map(String::from),
            seeders: Some(seeders),
            peers: Some(peers),
            size: Some(1024.0),
            category: Some(vec![4050, 100401]),
            ..Default::default()
        }
    }

    #[test]
    fn categories() {
        assert_eq!(kind_of(&[4050, 100401], "thepiratebay"), "games");
        assert_eq!(kind_of(&[4000, 4050], "x"), "games");
        assert_eq!(kind_of(&[1080], "x"), "games");
        assert_eq!(kind_of(&[4000], "x"), "apps");
        assert_eq!(kind_of(&[2040], "x"), "movies");
        assert_eq!(kind_of(&[5040], "x"), "tv");
        assert_eq!(kind_of(&[5070], "x"), "anime");
        assert_eq!(kind_of(&[5000], "nyaasi"), "anime");
        assert_eq!(kind_of(&[3000, 104627], "x"), "music");
        assert_eq!(kind_of(&[7020], "x"), "books");
        assert_eq!(kind_of(&[100001], "x"), "other");
        assert_eq!(kind_of(&[], "x"), "other");
        assert_eq!(tab_categories("games"), vec![1000, 4050]);
        assert!(tab_categories("all").is_empty());
    }

    #[test]
    fn hashes() {
        let hex = "E95FD6BBD15480468EC48C57FD4210AFC623CD1A";
        assert_eq!(normalize_hash(hex).unwrap(), hex.to_lowercase());
        // base32 of the same 20 bytes
        assert_eq!(normalize_hash("5FP5NO6RKSAENDWERRL72QQQV7DCHTI2").unwrap(), hex.to_lowercase());
        assert_eq!(normalize_hash("nope"), None);
        let m = format!("magnet:?xt=urn:btih:{hex}&dn=x");
        assert_eq!(hash_from_magnet(&m).unwrap(), hex.to_lowercase());
    }

    #[test]
    fn normalizes() {
        let mut r = raw("  Elden Ring  ", None, 5.0, 23.0, "The Pirate Bay");
        r.magnet_uri = Some("magnet:?xt=urn:btih:E95FD6BBD15480468EC48C57FD4210AFC623CD1A".into());
        r.publish_date = Some("0001-01-01T00:00:00".into());
        let it = normalize(r, "thepiratebay", "The Pirate Bay").unwrap();
        assert_eq!(it.title, "Elden Ring");
        assert_eq!(it.id, "e95fd6bbd15480468ec48c57fd4210afc623cd1a");
        assert_eq!(it.leechers, 18);
        assert_eq!(it.date, None);
        assert_eq!(it.kind, "games");
        // no hash: stable id from guid
        let mut r2 = raw("Lime", None, 0.0, 4.0, "LimeTorrents");
        r2.guid = Some("https://lime/x.html".into());
        let a = normalize(r2, "limetorrents", "LimeTorrents").unwrap();
        assert!(a.id.starts_with('x'));
        assert_eq!(a.details.as_deref(), Some("https://lime/x.html"));
        assert!(normalize(Raw::default(), "x", "x").is_none());
    }

    #[test]
    fn dedupes() {
        let h = "e95fd6bbd15480468ec48c57fd4210afc623cd1a";
        let mut map = HashMap::new();
        let a = normalize(raw("A", Some(h), 5.0, 10.0, "TPB"), "thepiratebay", "TPB").unwrap();
        let mut b_raw = raw("B", Some(h), 50.0, 60.0, "1337x");
        b_raw.magnet_uri = None;
        let b = normalize(b_raw, "1337x", "1337x").unwrap();
        let mut a_with_magnet = a.clone();
        a_with_magnet.magnet = Some(format!("magnet:?xt=urn:btih:{h}"));
        merge(&mut map, vec![a_with_magnet]);
        merge(&mut map, vec![b]);
        let other = normalize(raw("C", None, 1.0, 1.0, "Lime"), "limetorrents", "Lime").unwrap();
        merge(&mut map, vec![other]);
        let v = sorted(&map);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].title, "B");
        assert_eq!(v[0].seeders, 50);
        assert_eq!(v[0].indexers, vec!["1337x", "TPB"]);
        assert!(v[0].magnet.is_some(), "magnet kept from the other source");
        // a weaker duplicate only adds its source
        merge(&mut map, vec![normalize(raw("D", Some(h), 1.0, 1.0, "Nyaa"), "nyaasi", "Nyaa").unwrap()]);
        assert_eq!(sorted(&map)[0].indexers, vec!["1337x", "TPB", "Nyaa"]);
    }

    #[test]
    fn errors() {
        assert_eq!(
            clean_error("Jackett.Common.IndexerException: Exception (1337x): Challenge detected but FlareSolverr is not configured\n ---> x"),
            "blocked by Cloudflare (needs FlareSolverr)"
        );
        assert_eq!(clean_error("Exception (yts): Request to … failed (Error 521) - The tracker seems to be down."), "site is down");
        assert_eq!(clean_error("Jackett.Common.IndexerException: Exception (foo): Bad things\n at"), "Bad things");
    }

    #[test]
    fn parses_jackett_json() {
        let j = r#"{"Results":[{"Title":"T","Tracker":"LimeTorrents","TrackerId":"limetorrents","CategoryDesc":"Audio",
          "Category":[3000,104627],"Size":300899368,"Seeders":0,"Peers":4,"PublishDate":"2026-11-02T21:05:13-03:00",
          "MagnetUri":null,"InfoHash":null,"Link":"http://127.0.0.1/dl/x","Details":"https://lime/x","Guid":"https://lime/x","Files":null}],
          "Indexers":[{"ID":"limetorrents","Status":2,"Results":1,"Error":null}]}"#;
        let r: Response = serde_json::from_str(j).unwrap();
        let it = normalize(r.results.into_iter().next().unwrap(), "limetorrents", "LimeTorrents").unwrap();
        assert_eq!(it.kind, "music");
        assert_eq!(it.leechers, 4);
        assert_eq!(it.size, 300899368);
        assert_eq!(it.link.as_deref(), Some("http://127.0.0.1/dl/x"));
    }
}
