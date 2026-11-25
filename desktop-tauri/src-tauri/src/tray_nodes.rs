//! The nodes of the tray: one card per real server, in the order the dispatcher
//! sends work to them.
//!
//! Two things lied in the menu: a node-pool server deleted days ago still showed as
//! «Nodo cloud 2, spento» (its machine row stayed behind), and the permanent server allow-italian: quoted menu wording
//! showed twice (the service's «Server Hetzner» card and the client's «Nodo cloud 1»)
//! with no word about being drained for a realign. The pool writes its own state
//! file (`node-pool/state.json`, `deploy/cloud-node/node-pool`): it says which
//! servers exist, which is fixed, which is draining. This module reads it and shapes
//! the cards; nothing here names a person, an address or an account.
//!
//! The order is the dispatcher's (`server/services/dispatch-overflow.ts`,
//! `pickOverflowMachine`): a card starts on this computer; when it must leave it goes
//! to the first node that is online and has a free seat, in the store's order (the
//! freshest heartbeat first), then to the first sleeping node that can be woken. A
//! node drained to zero seats, or that does not answer, is skipped: it comes last.

use crate::tray_menu_clock::civil;
use crate::tray_menu_detail::MachineDetail;
use crate::tray_menu_views::MachineCard;
use serde_json::Value;

/// How long a drain lasts when the pool did not write its own deadline (`NODE_POOL_DRAIN_MAX_MIN` default).
const DRAIN_DEFAULT_S: i64 = 180 * 60;

/// One seat of the pool, as `node-pool` records it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PoolNode {
    pub n: u32,
    /// The machine row in Topics that this server answers as.
    pub machine_id: String,
    /// The provider's name for the server.
    pub server_name: String,
    pub provider: String,
    pub fixed: bool,
    /// A real server stands behind this seat. A seat with a machine row and no server is a ghost.
    pub has_server: bool,
    pub draining: bool,
    /// Epoch seconds the drain gives up at.
    pub drain_until: Option<i64>,
    pub align_failed: bool,
    /// Epoch seconds since the server runs older code than main; none while it is aligned.
    pub behind_since: Option<i64>,
    /// Cards on the machine (todo and in progress), when the pool counted them.
    pub cards: Option<u32>,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The seats of `node-pool/state.json`, by number. A body that is not the pool's state reads as no seats.
pub fn parse_pool(body: &str) -> Vec<PoolNode> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out: Vec<PoolNode> = v.get("slots").and_then(Value::as_object).map(|o| o.values().map(|s| {
        let drain_since = s.get("drain_since").and_then(Value::as_f64).map(|t| t as i64);
        PoolNode {
            n: s.get("n").and_then(Value::as_u64).unwrap_or(0) as u32,
            machine_id: text(s, "machine_id"),
            server_name: text(s, "name"),
            provider: text(s, "provider"),
            fixed: s.get("fixed").and_then(Value::as_bool).unwrap_or(false),
            has_server: s.get("server_id").map_or(false, |x| !x.is_null()),
            draining: s.get("draining").and_then(Value::as_bool).unwrap_or(false),
            drain_until: s.get("drain_until").and_then(Value::as_f64).map(|t| t as i64).or(drain_since.map(|t| t + DRAIN_DEFAULT_S)),
            align_failed: !text(s, "align_failed").is_empty(),
            behind_since: s.get("behind_since").and_then(Value::as_f64).map(|t| t as i64),
            cards: s.get("cards").and_then(Value::as_u64).map(|c| c as u32),
        }
    }).collect()).unwrap_or_default();
    out.sort_by_key(|n| n.n);
    out
}

/// Where the pool's state file is; overridable for tests.
pub fn pool_state_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TOPICS_NODE_POOL_STATE") {
        return Some(p.into());
    }
    Some(std::path::Path::new(&std::env::var_os("HOME")?).join(".topics/node-pool/state.json"))
}

fn clock(at: i64, offset: i64) -> String {
    let c = civil(at * 1000, offset);
    format!("{:02}:{:02}", c.hour, c.minute)
}

/// The pool seat a card stands for: the client's card by its machine id, the service's
/// card (which has no machine id) by the server name its caption carries.
pub(crate) fn pool_of<'a>(card: &MachineCard, pool: &'a [PoolNode], details: &[MachineDetail]) -> Option<&'a PoolNode> {
    if card.id.is_empty() || card.local {
        return None;
    }
    let caption = details.iter().find(|d| d.id == card.id).map(|d| d.caption.to_lowercase()).unwrap_or_default();
    pool.iter().find(|n| {
        (!n.machine_id.is_empty() && n.machine_id == card.id)
            || (!n.server_name.is_empty() && caption.contains(&n.server_name.to_lowercase()))
    })
}

/// A line that is only an id or a technical name: the server's own name at the provider, a machine id,
/// anything shaped like a uuid. The cards never show those (they say the work, not the plumbing).
fn is_technical(line: &str, card: &MachineCard, node: Option<&PoolNode>) -> bool {
    let l = line.trim().to_lowercase();
    let uuid = l.len() == 36 && l.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    let named = |t: &str| !t.is_empty() && l == t.to_lowercase();
    uuid || named(&card.id) || named(&card.machine_id) || node.map_or(false, |n| named(&n.server_name) || named(&n.machine_id))
}

/// What a node is called, from what it is: a fixed server, or the hourly one of that seat.
fn node_name(n: &PoolNode, provider: &str) -> String {
    let kind = if n.fixed { "Server fisso".to_string() } else { format!("Nodo a ore {}", n.n) };
    match (provider.is_empty(), n.fixed) {
        (true, _) => kind,
        (false, true) => format!("{kind} ({provider})"),
        (false, false) => format!("{kind} · {provider}"),
    }
}

/// The card's state in words, from the pool's facts; `None` keeps what the card already says.
fn node_state(n: &PoolNode, card: &MachineCard, offset: i64) -> Option<(String, String, u32)> {
    if n.draining {
        let until = n.drain_until.map(|t| format!(" fino alle {}", clock(t, offset))).unwrap_or_default();
        return Some(("in svuotamento".into(), format!("si riallinea a main, card ferme{until}"), 1));
    }
    if n.align_failed {
        return Some(("riallineamento fallito".into(), "resta indietro su main".into(), 1));
    }
    // a node that does not answer, or sleeps, says so by itself: a plain "on" would lie
    if is_silent(card) {
        return None;
    }
    let badge = match n.cards {
        Some(1) => "acceso, 1 card".to_string(),
        Some(c) => format!("acceso, {c} card"),
        None => "acceso".to_string(),
    };
    Some((badge, card.reason.clone(), card.level))
}

fn is_silent(card: &MachineCard) -> bool {
    let b = card.badge.to_lowercase();
    card.level >= 2 || ["spent", "spegn", "dorm", "non risponde"].iter().any(|w| b.contains(w))
}

/// 0 this computer, 1 online with seats, 2 asleep, 3 drained, failed or silent: the dispatcher's order.
fn rank(card: &MachineCard, node: Option<&PoolNode>) -> u8 {
    let b = card.badge.to_lowercase();
    if card.local {
        0
    } else if node.map_or(false, |n| n.draining) || card.level >= 2 || b.contains("svuotamento") || b.contains("non risponde") {
        3
    } else if is_silent(card) {
        2
    } else {
        1
    }
}

/// The cards in dispatch order, numbered, with the pool's servers named and worded.
/// `client` is the Topics machine list in the store's order (the freshest heartbeat
/// first): it decides between two nodes alike.
pub fn arrange(cards: Vec<MachineCard>, client: &[MachineCard], pool: &[PoolNode], details: &[MachineDetail], offset: i64) -> Vec<MachineCard> {
    let is_client = |c: &MachineCard| !c.id.is_empty() && client.iter().any(|x| x.id == c.id);
    // one card per server: a ghost seat (machine row, no server) goes, the service's card wins over the client's twin
    let kept: Vec<MachineCard> = cards.iter().filter(|c| match pool_of(c, pool, details) {
        None => true,
        Some(n) if !n.has_server => false,
        Some(n) => !is_client(c) || !cards.iter().any(|o| !is_client(o) && pool_of(o, pool, details).map_or(false, |m| m.n == n.n)),
    }).cloned().collect();
    let mut rows: Vec<(u8, usize, MachineCard)> = kept.into_iter().enumerate().map(|(i, mut c)| {
        let node = pool_of(&c, pool, details);
        // a technical name (the provider's server name, an id) is dropped from the lines and from the reason
        let kept = c.card_lines_without_ids(|t| is_technical(t, &c, node));
        c.reason = if is_technical(&c.reason, &c, node) { kept.first().map(|l| l.split(" · ").next().unwrap_or(l).to_string()).unwrap_or_default() } else { c.reason.clone() };
        c.lines = kept;
        let twin = node.and_then(|n| client.iter().find(|x| !n.machine_id.is_empty() && x.id == n.machine_id));
        if let Some(n) = node {
            // «Hetzner · cx53 · 25 €» opens with the provider's own word when the pool did not write one
            let provider = Some(n.provider.clone()).filter(|p| !p.is_empty())
                .or_else(|| twin.and_then(|t| t.reason.split_once(" · ").map(|(p, _)| p.to_string())))
                .unwrap_or_default();
            c.name = node_name(n, &provider);
            if let Some((badge, reason, level)) = node_state(n, &c, offset) {
                // the line beside the name is short: the whole sentence is the first line of the card's submenu
                if reason != c.reason && !reason.is_empty() {
                    c.lines.insert(0, reason.clone());
                }
                c.badge = badge;
                c.reason = reason;
                c.level = level;
            }
        }
        // one source for the numbers: the twin in the Topics list (this computer's, the pool seat's, or by name); a card
        // that is itself the client's takes its own
        let own = is_client(&c).then(|| c.clone());
        let twin_any = if c.local { client.iter().find(|x| x.local) } else { twin.or(own.as_ref()).or_else(|| client.iter().find(|x| x.name.trim().eq_ignore_ascii_case(c.name.trim()))) };
        crate::tray_numbers::one_source(&mut c, twin_any);
        let pos = client.iter()
            .position(|x| x.id == c.id || node.map_or(false, |n| !n.machine_id.is_empty() && x.id == n.machine_id) || x.name.trim().eq_ignore_ascii_case(c.name.trim()))
            .unwrap_or(usize::MAX / 2 + i);
        (rank(&c, node), pos, c)
    }).collect();
    rows.sort_by_key(|(r, p, _)| (*r, *p));
    rows.into_iter().enumerate().map(|(i, (_, _, mut c))| { c.order = i as u32 + 1; c }).collect()
}

#[cfg(test)]
#[path = "tray_nodes_tests.rs"]
mod tests;
