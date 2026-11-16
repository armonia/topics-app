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
