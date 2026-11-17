//! What a click on a tray row does: the menu id read back into an `Action`, and the
//! calls that carry it out (hub requests, closing processes). Split from tray_menu.rs,
//! which keeps building the menu.

use crate::tray_menu::{leftover_pids, unit_pids};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Http { method: &'static str, path: String, body: Option<Value> },
    /// `unit`: the census id to re-read before closing; `None` = the leftovers group.
    /// `force`: SIGKILL instead of SIGTERM, behind its own confirmation.
    ClosePids { name: String, unit: Option<String>, pids: Vec<u32>, force: bool },
    OpenUrl(String),
    TogglePref(String),
    Open(String),
    /// The Processes view of the client: it lists this computer and every remote machine together.
    OpenProcesses,
    /// A command of a machine (Hetzner: «Spegni tutti»): the dialog says `confirm`, a yes sends the request.
    ConfirmedHttp { label: String, machine: String, confirm: String, method: &'static str, path: String },
}

/// Separates the fields of a machine command packed in a menu id (the sentence of the dialog may hold any other sign).
const ACTION_SEP: char = '\u{1f}';

/// The menu id of a machine command: `machine-act:<method>␟<path>␟<label>␟<machine>␟<confirm>`.
pub(crate) fn machine_action_id(machine: &str, method: &str, path: &str, label: &str, confirm: &str) -> String {
    format!("machine-act:{method}{ACTION_SEP}{path}{ACTION_SEP}{label}{ACTION_SEP}{machine}{ACTION_SEP}{confirm}")
}

/// A menu id to the thing it does. `None` = not a hub id.
pub fn action_for(id: &str, procs: &Option<String>) -> Option<Action> {
    let http = |method, path: &str, body| Some(Action::Http { method, path: path.into(), body });
    if let Some(p) = id.strip_prefix("brake-unlock-off:") {
        return http("DELETE", &format!("/api/override?provider={p}"), None);
    }
    if let Some(p) = id.strip_prefix("brake-unlock:") {
        return http("POST", "/api/override", Some(json!({"provider": p, "hours": 2, "by": "tray"})));
    }
    match id {
        "brake-hold" => return http("POST", "/api/hold", Some(json!({"hours": 1, "by": "tray"}))),
        "brake-hold-off" => return http("DELETE", "/api/hold", None),
        "proc-close-leftovers" => {
            return Some(Action::ClosePids { name: "i resti senza padrone".into(), unit: None, pids: leftover_pids(procs), force: false });
        }
        _ => {}
    }
    if let Some(rest) = id.strip_prefix("proj-budget:") {
        let (name, b) = rest.rsplit_once(':')?;
        let b: i64 = b.parse().ok()?;
        let val = if b == 0 { Value::Null } else { json!(b) };
        return http("POST", "/api/project-settings", Some(json!({"name": name, "budgetPct": val})));
    }
    if let Some(rest) = id.strip_prefix("proj-priority:") {
        let (name, p) = rest.rsplit_once(':')?;
        return http("POST", "/api/project-settings", Some(json!({"name": name, "priority": p})));
    }
    if let Some(u) = id.strip_prefix("proc-close:") {
        let (name, pids) = unit_pids(procs, u)?;
        return Some(Action::ClosePids { name, unit: Some(u.to_string()), pids, force: false });
    }
    if let Some(u) = id.strip_prefix("proc-force:") {
        let (name, pids) = unit_pids(procs, u)?;
        return Some(Action::ClosePids { name, unit: Some(u.to_string()), pids, force: true });
    }
    if let Some(name) = id.strip_prefix("proj-open:") {
        return Some(Action::Open(format!("project:{name}")));
    }
    if let Some(url) = id.strip_prefix("session-open:") {
        // Only addresses of the places a session lives in; nothing else is handed to the system.
        let ok = ["claude://", "https://", "http://127.0.0.1", "http://localhost"].iter().any(|p| url.starts_with(p));
        return ok.then(|| Action::OpenUrl(url.to_string()));
    }
    if id.starts_with("machine-open:") {
        // The Processes view lists every machine together: there is no per-machine page to pick.
        return Some(Action::OpenProcesses);
    }
    if let Some(rest) = id.strip_prefix("machine-act:") {
        let mut f = rest.split(ACTION_SEP);
        let (method, path, label, machine, confirm) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
        // Only the service's own commands, only the verbs it uses.
        let method = ["POST", "DELETE", "PUT"].into_iter().find(|m| *m == method)?;
        // The service may give no sentence: the dialog still asks, with the command's own name.
        let confirm = if confirm.trim().is_empty() { format!("{label}?") } else { confirm.to_string() };
        return path.starts_with("/api/").then(|| Action::ConfirmedHttp { label: label.into(), machine: machine.into(), confirm, method, path: path.into() });
    }
    if id == "dashboard-open" {
        return Some(Action::OpenUrl(crate::tray_quota::hub_base()));
    }
    if let Some(k) = id.strip_prefix("pref:") {
        return Some(Action::TogglePref(k.into()));
    }
    id.strip_prefix("open:").map(|w| Action::Open(w.into()))
}

/// Sends one request to the service; true on a 2xx answer.
pub fn http_send(base: &str, method: &str, path: &str, body: Option<&Value>) -> bool {
    let Some(rest) = base.strip_prefix("http://") else { return false };
    let hostport = rest.split('/').next().unwrap_or("");
    let Some(addr) = hostport.to_socket_addrs().ok().and_then(|mut a| a.next()) else { return false };
    let Ok(mut st) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return false };
    let _ = st.set_read_timeout(Some(Duration::from_secs(10)));
    let payload = body.map(Value::to_string).unwrap_or_default();
    // One write: head and body leave together.
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: {hostport}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    if st.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = st.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.split_whitespace().nth(1).map_or(false, |c| c.starts_with('2'))
}

/// The pids that may still be closed once the person said yes: the ones the menu showed AND
/// that a census read just now still lists for the same unit (a pid that left or was reused
/// by another process is not in it).
pub fn still_closable(fresh: &Option<String>, unit: Option<&str>, shown: &[u32]) -> Vec<u32> {
    let now: Vec<u32> = match unit {
        Some(u) => unit_pids(fresh, u).map(|(_, p)| p).unwrap_or_default(),
        None => leftover_pids(fresh),
    };
    shown.iter().copied().filter(|p| now.contains(p)).collect()
}

/// A census older than this is not a basis for signalling anything.
pub const CENSUS_MAX_AGE_MS: i64 = 90_000;

/// The census carries the time it was taken (`at`, ms); one without it, or too old, is refused.
pub fn census_is_fresh(body: &str, now_ms: i64) -> bool {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("at").and_then(Value::as_i64)).map_or(false, |at| now_ms - at <= CENSUS_MAX_AGE_MS)
}

/// The close, after the dialog: nothing without a yes; with it, a fresh census decides the pids.
pub fn close_confirmed(
    confirmed: bool,
    now_ms: i64,
    fresh_census: impl FnOnce() -> Option<String>,
    unit: Option<&str>,
    shown: &[u32],
    kill: impl FnOnce(&[u32]) -> usize,
) -> usize {
    if !confirmed {
        return 0;
    }
    let census = fresh_census().filter(|c| census_is_fresh(c, now_ms));
    let pids = still_closable(&census, unit, shown);
    if pids.is_empty() { 0 } else { kill(&pids) }
}

/// SIGTERM so the process gets to save, or SIGKILL when the person chose the forced close.
/// Only pids the census listed as closable.
pub fn terminate(pids: &[u32], force: bool) -> usize {
    let signal = if force { "-KILL" } else { "-TERM" };
    pids.iter()
        .filter(|p| **p > 1)
        .filter(|p| std::process::Command::new("kill").args([signal, &p.to_string()]).status().map_or(false, |s| s.success()))
        .count()
}
