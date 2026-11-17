//! What the node cards say about each machine beyond its dial: are memories and rules
//! aligned, is the code aligned, is it safe, and the data of the small charts. Three files
//! written by other services, all optional and possibly old:
//!
//! - `~/.topics/harness-sync.json`: memories and rules copied to each machine, and how late they are;
//! - `~/.topics/machines-health.json`: the four security checks, CPU and memory of the last 24 hours
//!   and the cards started today, per machine;
//! - `~/.topics/node-pool/state.json` (read by `tray_nodes`): whether the code is aligned to main and
//!   the cloud spend of the month.
//!
//! Pure: file bodies in, plain rows and series out. A row with no data does not exist, a chart
//! with no data does not exist: the card never shows a placeholder. Nothing here names a person.

use crate::tray_menu_clock::civil;
use crate::tray_nodes::PoolNode;
use serde_json::Value;
use std::collections::HashMap;

/// The security file is trusted for this long; an older one says, on screen, how many hours ago it was last checked.
const HEALTH_FRESH_S: i64 = 3600;
/// Past this, a memory or rules copy that lags is a problem, not only worth a look.
const SYNC_PROBLEM_S: i64 = 24 * 3600;

/// One line of a node card: a sign coloured by `level` (0 fine, 1 watch, 2 bad), a label and the words.
#[derive(Debug, Clone, PartialEq)]
pub struct StatusRow {
    pub label: String,
    pub text: String,
    pub level: u32,
}

fn row(label: &str, text: impl Into<String>, level: u32) -> StatusRow {
    StatusRow { label: label.into(), text: text.into(), level }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Check {
    pub key: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HealthMachine {
    pub id: String,
    pub name: String,
    pub local: bool,
    pub checked_at: Option<i64>,
    pub status: String,
    pub checks: Vec<Check>,
    pub cpu: Vec<Option<f64>>,
    pub mem: Vec<Option<f64>>,
    pub cards_today: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Health {
    pub at: Option<i64>,
    pub machines: Vec<HealthMachine>,
}

fn int(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_f64).map(|t| t as i64)
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn series(v: Option<&Value>) -> Vec<Option<f64>> {
    v.and_then(Value::as_array).map(|a| a.iter().map(Value::as_f64).collect()).unwrap_or_default()
}

/// `machines-health.json`; a body that is not that file reads as no file.
pub fn parse_health(body: &str) -> Option<Health> {
    let v: Value = serde_json::from_str(body).ok()?;
    let machines = v.get("machines")?.as_array()?;
    Some(Health {
        at: int(&v, "at"),
        machines: machines.iter().filter(|m| !text(m, "id").is_empty()).map(|m| {
            let sec = m.get("security").cloned().unwrap_or(Value::Null);
            let hist = m.get("history").cloned().unwrap_or(Value::Null);
            HealthMachine {
                id: text(m, "id"),
                name: text(m, "name"),
                local: text(m, "kind") == "local",
                checked_at: int(&sec, "checked_at"),
                status: text(&sec, "status"),
                checks: sec.get("checks").and_then(Value::as_array).into_iter().flatten()
                    .map(|c| Check { key: text(c, "key"), status: text(c, "status"), detail: text(c, "detail") }).collect(),
                cpu: series(hist.get("cpu")),
                mem: series(hist.get("mem")),
                cards_today: m.get("cards_today").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0) as u32).collect()).unwrap_or_default(),
            }
        }).collect(),
    })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SyncTarget {
    pub name: String,
    pub rev: String,
    pub at: i64,
    pub error: Option<String>,
    /// `open`, `closed`, `skipped` or `off`.
    pub private: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HarnessSync {
    pub source_rev: String,
    pub source_at: i64,
    pub targets: HashMap<String, SyncTarget>,
    /// Per machine: (epoch s, seconds the copy was behind the source), oldest first.
    pub history: HashMap<String, Vec<(i64, i64)>>,
}

/// `harness-sync.json`; a body that is not that file reads as no file.
pub fn parse_sync(body: &str) -> Option<HarnessSync> {
    let v: Value = serde_json::from_str(body).ok()?;
    let source = v.get("source")?;
    let nonempty = |t: String| Some(t).filter(|t| !t.is_empty());
    Some(HarnessSync {
        source_rev: text(source, "rev"),
        source_at: int(source, "at").unwrap_or(0),
        targets: v.get("targets").and_then(Value::as_object).into_iter().flatten().map(|(id, t)| (id.clone(), SyncTarget {
            name: text(t, "name"),
            rev: text(t, "rev"),
            at: int(t, "at").unwrap_or(0),
            error: nonempty(text(t, "error")),
            private: text(t, "private"),
            reason: nonempty(text(t, "private_reason")),
        })).collect(),
        history: v.get("history").and_then(Value::as_object).into_iter().flatten().map(|(id, h)| {
            let mut pts: Vec<(i64, i64)> = h.as_array().into_iter().flatten().filter_map(|p| Some((int(p, "at")?, int(p, "lag_s")?))).collect();
            pts.sort_by_key(|p| p.0);
            (id.clone(), pts)
        }).collect(),
    })
}

/// The cloud spend of the month as the pool writes it: euros per day and the monthly ceiling.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Spend {
    /// `YYYY-MM-DD` and euros, oldest first.
    pub days: Vec<(String, f64)>,
    pub cap: Option<f64>,
}

/// `spend_daily` and `spend_cap_eur` of the pool's state file; none when it has no day.
pub fn parse_spend(pool_body: &str) -> Option<Spend> {
    let v: Value = serde_json::from_str(pool_body).ok()?;
    let mut days: Vec<(String, f64)> = v.get("spend_daily")?.as_array()?.iter().filter_map(|d| Some((d.get("day")?.as_str()?.to_string(), d.get("eur")?.as_f64()?))).collect();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    (!days.is_empty()).then(|| Spend { days, cap: v.get("spend_cap_eur").and_then(Value::as_f64).filter(|c| *c > 0.0) })
}

/// Where the two files live; overridable for tests.
pub fn health_path() -> Option<std::path::PathBuf> {
    env_path("TOPICS_MACHINES_HEALTH", ".topics/machines-health.json")
}
pub fn sync_path() -> Option<std::path::PathBuf> {
    env_path("TOPICS_HARNESS_SYNC", ".topics/harness-sync.json")
}
fn env_path(var: &str, rel: &str) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var(var) {
        return Some(p.into());
    }
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(rel))
}

// ------------------------------------------------------------------ words

pub(crate) fn hhmm(at: i64, offset: i64) -> String {
    let c = civil(at * 1000, offset);
    format!("{:02}:{:02}", c.hour, c.minute)
}

/// Today the bare time, yesterday the time with "yesterday", older "N days ago" (all in Italian on screen).
pub(crate) fn day_clock(now: i64, at: i64, offset: i64) -> String {
    match civil(now * 1000, offset).day - civil(at * 1000, offset).day {
        i64::MIN..=0 => hhmm(at, offset),
        1 => format!("ieri {}", hhmm(at, offset)),
        d => format!("{d} giorni fa"),
    }
}

/// A span in words (minutes, hours or days, in Italian on screen).
pub(crate) fn span(secs: i64) -> String {
    let mins = (secs.max(0) / 60).max(1);
    let plural = |n: i64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    if mins < 60 {
        plural(mins, "minuto", "minuti")
    } else if mins < 48 * 60 {
        plural(mins / 60, "ora", "ore")
    } else {
        plural(mins / 1440, "giorno", "giorni")
    }
}

fn level_of(status: &str) -> u32 {
    match status {
        "ok" | "info" => 0,
        "problem" => 2,
        _ => 1,
    }
}

// ------------------------------------------------------------------ rows

/// «Memorie e regole» of a remote machine, from what the sync last copied there.
pub fn sync_row(sync: &HarnessSync, machine_id: &str, offset: i64) -> Option<StatusRow> {
    let t = sync.targets.get(machine_id)?;
    let lag = (sync.source_at - t.at).max(0);
    let mut parts: Vec<String> = Vec::new();
    let mut level = 0;
    if let Some(e) = &t.error {
        parts.push(e.clone());
        level = 2;
    } else if t.rev != sync.source_rev {
        parts.push(format!("indietro di {}", span(lag)));
        level = if lag > SYNC_PROBLEM_S { 2 } else if lag > 3600 { 1 } else { 0 };
    } else {
        parts.push(format!("allineate alle {}", hhmm(t.at, offset)));
    }
    match t.private.as_str() {
        "closed" => {
            parts.push("privato chiuso".into());
            level = level.max(1);
        }
        // the writer's own reason often already opens with the "private part" wording, so it is not repeated
        // the technical aside in brackets (e.g. a disk-encryption note) does not fit the line and is the writer's detail
        "skipped" => parts.push(match t.reason.as_deref().map(|r| r.split(" (").next().unwrap_or(r).trim()) {
            Some(r) if r.to_lowercase().starts_with("privato") => r.to_string(),
            Some(r) => format!("privato non copiato: {r}"),
            None => "privato non copiato".into(),
        }),
        _ => {}
    }
    Some(row("Memorie e regole", parts.join(" · "), level))
}

/// The code row of a pool server: aligned to main, or since when it is behind. The badge already says
/// draining or realignment failed; this row says how long, so it never repeats the badge.
pub fn code_row(n: &PoolNode, now: i64, offset: i64) -> StatusRow {
    let behind = n.behind_since.map(|t| (now - t).max(0));
    let since = |b: i64| format!("indietro da {}", span(b));
    if n.align_failed {
        return row("Codice", behind.map_or("riallineamento fallito".to_string(), |b| format!("{}, riallineamento fallito", since(b))), 2);
    }
    if n.draining {
        let until = n.drain_until.map(|t| format!(" fino alle {}", hhmm(t, offset))).unwrap_or_default();
        return row("Codice", format!("{}, si riallinea{until}", behind.map_or("indietro".to_string(), since)), 1);
    }
    match behind {
        Some(b) => row("Codice", since(b), if b > SYNC_PROBLEM_S { 2 } else if b > 3600 { 1 } else { 0 }),
        None => row("Codice", "allineato a main", 0),
    }
}

/// The check that weighs most: a problem before a warning, the first one listed among equals.
fn worst(checks: &[Check]) -> Option<&Check> {
    let mut best: Option<&Check> = None;
    for c in checks.iter().filter(|c| level_of(&c.status) > 0) {
        if best.map_or(true, |b| level_of(&c.status) > level_of(&b.status)) {
            best = Some(c);
        }
    }
    best
}

pub fn check_label(key: &str) -> &str {
    match key {
        "updates" => "Aggiornamenti",
        "disk" => "Disco cifrato",
        "access" => "Accesso e porte",
        "antivirus" => "Antivirus e accessi falliti",
        other => other,
    }
}

fn cut(t: &str, max: usize) -> String {
    if t.chars().count() <= max { t.to_string() } else { format!("{}…", t.chars().take(max - 1).collect::<String>().trim_end()) }
}

/// «Sicurezza» of a machine: fine, or the detail of the worst check; an old file says how old.
pub fn security_row(health: &Health, m: &HealthMachine, now: i64) -> StatusRow {
    if let Some(at) = health.at.filter(|at| now - at > HEALTH_FRESH_S) {
        return row("Sicurezza", format!("non controllata da {}", span(now - at)), 1);
    }
    let w = worst(&m.checks);
    let level = level_of(&m.status).max(w.map_or(0, |c| level_of(&c.status)));
    if m.status == "unknown" && w.is_none() {
        return row("Sicurezza", "da guardare: non ancora controllata", 1);
    }
    let detail = w.map(|c| cut(&c.detail, 80)).filter(|d| !d.is_empty());
    match (level, detail) {
        (0, _) => row("Sicurezza", "a posto", 0),
        (2, d) => row("Sicurezza", format!("problema: {}", d.unwrap_or_else(|| "controlla i dettagli".into())), 2),
        (_, d) => row("Sicurezza", format!("da guardare: {}", d.unwrap_or_else(|| "controllo non concluso".into())), 1),
    }
}

/// The four checks of a machine for its submenu: label, level and the check's own words.
pub fn check_lines(m: &HealthMachine) -> Vec<(String, u32, String)> {
    ["updates", "disk", "access", "antivirus"].iter().filter_map(|k| m.checks.iter().find(|c| c.key == *k)).map(|c| {
        let state = match c.status.as_str() {
            "ok" => "a posto",
            "warn" => "da guardare",
            "problem" => "problema",
            "info" => "",
            _ => "non controllato",
        };
        let say = [state, cut(&c.detail, 70).as_str()].iter().filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        (check_label(&c.key).to_string(), level_of(&c.status), say)
    }).collect()
}

/// Which health machine a card stands for: this computer by its kind, any other by one of its ids, then by its name.
pub fn health_of<'a>(health: &'a Health, local: bool, ids: &[&str], name: &str) -> Option<&'a HealthMachine> {
    if local {
        return health.machines.iter().find(|m| m.local);
    }
    ids.iter().filter(|i| !i.is_empty()).find_map(|i| health.machines.iter().find(|m| !m.local && m.id == *i))
        .or_else(|| health.machines.iter().find(|m| !m.local && !m.name.is_empty() && m.name.trim().eq_ignore_ascii_case(name.trim())))
}

#[cfg(test)]
#[path = "tray_node_health_tests.rs"]
pub(crate) mod tests;
