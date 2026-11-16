//! What a machine submenu takes from the service's `/api/machines` answer beyond
//! the board's card: the processes that weigh on a machine read from afar (PC,
//! cloud server). Pure: the answer in, plain data out. Card ad8b474a.
//!
//! The submenu used to open with a picture of bars and 24 hour charts for remote
//! machines only; Attilio (16/11) wanted every submenu shaped like the MacBook one,
//! state lines then the process table, so that picture is gone.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MachineDetail {
    pub id: String,
    /// The processes that weigh, as the service read them (`procs`), heaviest first.
    pub procs: Vec<RemoteProc>,
    /// `macOS`, `Windows` or `Linux`; empty when the service does not say.
    pub os: String,
    /// How many processes the machine runs in all and what they hold, when the service counts them (`procsTotal`).
    pub procs_total: Option<ProcsTotal>,
    /// The commands the service offers on this machine (Hetzner: «Spegni tutti»).
    pub actions: Vec<MachineAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ProcsTotal {
    pub n: u64,
    pub mem_mb: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MachineAction {
    pub label: String,
    pub url: String,
    pub method: String,
    pub confirm: String,
}

/// One process of a machine the service reads from afar (PC, cloud server).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RemoteProc {
    pub name: String,
    pub cpu_pct: f64,
    pub mem_mb: f64,
    pub cmd: String,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The machines of `/api/machines`, one detail each.
pub fn machine_details(body: &str) -> Vec<MachineDetail> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    v.as_array().cloned().unwrap_or_default().iter().map(|m| MachineDetail {
        id: text(m, "id"),
        os: text(m, "os"),
        procs_total: m.get("procsTotal").filter(|x| x.is_object()).map(|x| ProcsTotal {
            n: x.get("n").and_then(Value::as_u64).unwrap_or(0),
            mem_mb: x.get("memMB").and_then(Value::as_f64).unwrap_or(0.0),
        }),
        actions: m.get("actions").and_then(Value::as_array).map(|a| a.iter().filter(|x| !text(x, "label").is_empty() && !text(x, "url").is_empty()).map(|x| MachineAction {
            label: text(x, "label"),
            url: text(x, "url"),
            method: Some(text(x, "method")).filter(|m| !m.is_empty()).unwrap_or_else(|| "POST".into()),
            confirm: text(x, "confirm"),
        }).collect()).unwrap_or_default(),
        procs: m.get("procs").and_then(Value::as_array).map(|a| a.iter().filter(|x| !text(x, "name").is_empty()).map(|x| RemoteProc {
            name: text(x, "name"),
            cpu_pct: x.get("cpu_pct").and_then(Value::as_f64).unwrap_or(0.0),
            mem_mb: x.get("mem_mb").and_then(Value::as_f64).unwrap_or(0.0),
            cmd: text(x, "cmd"),
        }).collect()).unwrap_or_default(),
    }).collect()
}

#[cfg(test)]
#[path = "tray_menu_detail_tests.rs"]
mod tests;
