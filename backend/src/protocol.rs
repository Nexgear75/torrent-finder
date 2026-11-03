//! JSON lines over stdin/stdout between the TUI and this backend.
//!   request : {"id": 1, "method": "search", "params": {...}}
//!   response: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
//!   event   : {"event": "status" | "progress" | "search_start" | "results" | "search_done", "data": {...}}

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Lines written to stdout by a single writer task.
#[derive(Clone)]
pub struct Out(pub UnboundedSender<String>);

impl Out {
    pub fn event(&self, name: &str, data: Value) {
        let _ = self.0.send(json!({"event": name, "data": data}).to_string());
    }

    pub fn reply(&self, id: u64, res: anyhow::Result<Value>) {
        let line = match res {
            Ok(r) => json!({"id": id, "ok": true, "result": r}),
            Err(e) => json!({"id": id, "ok": false, "error": format!("{e:#}")}),
        };
        let _ = self.0.send(line.to_string());
    }
}
