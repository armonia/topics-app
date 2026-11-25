//! The quota panel of the tray menu: one card per subscription account (provider, state, the 5 hour and week
//! meters, the minor rows). A pure function from the service's board JSON to an image, tested without a display.

use crate::tray_menu_pic::{tone, Palette, Pic, MENU_W};
use crate::tray_menu_views::{level_of_tone, num, provider_mark, s, system_symbol, text_of, PAD};
use crate::tray_quota::Face;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Meter {
    pub label: String,
    pub used: f32,
    pub reset: String,
    pub mark: Option<f32>,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Minor {
    /// System symbol of the row (the service names lucide icons; see `quota_symbol`).
    pub icon: String,
    /// The right-hand text is a reset time: it wears the refresh arrow.
    pub reset: bool,
    pub label: String,
    pub value: String,
    pub right: String,
    pub level: u32,
    /// A row that is one sentence across the card (the pace), in place of label, value and note.
    pub whole: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct QuotaCard {
    pub provider: String,
    /// The provider's name for people («Claude», «Codex», «Muse»), as the hub says it.
    pub provider_name: String,
    pub who: String,
    pub used: f32,
    pub state: String,
    pub state_level: u32,
    /// System symbol of a state that has no pace dial (shield, cross...).
    pub state_icon: String,
    /// Needle of the pace dial (0..2), when the pace is measured.
    pub needle: Option<f32>,
    pub five_hour: Option<Meter>,
    /// What the hub says in place of the 5 hour percentage when the account has none (no such limit on the plan,
    /// not read yet); empty when the window is read.
    pub five_say: String,
    pub week: Option<Meter>,
    pub minors: Vec<Minor>,
}

/// How many times the sustainable pace: one decimal below ten, whole from there.
pub(crate) fn ratio_text(r: f64) -> String {
    if r >= 10.0 { format!("{r:.0}") } else { format!("{r:.1}").replace('.', ",") }
}

fn meter_of(w: &Value, label: &str) -> Meter {
    Meter {
        label: label.into(),
        used: num(w, "used").unwrap_or(0.0) as f32,
        reset: s(w, "reset").into(),
        mark: num(w, "mark").map(|m| m as f32),
        level: level_of_tone(s(w, "tone")),
    }
}

/// The service's lucide icon names, as the system symbols the original tray maps them to.
fn quota_symbol(name: &str) -> &'static str {
    match name {
        "clock" => "clock",
        "circle-x" => "xmark.circle",
        "circle-check" => "checkmark.circle",
        "circle-pause" => "pause.circle",
        "timer" => "timer",
        "loader-circle" => "hourglass",
        "triangle-alert" => "exclamationmark.triangle",
        "coins" => "square.stack.3d.up",
        "activity" => "waveform.path.ecg",
        "gift" => "gift",
        "refresh-cw" => "arrow.clockwise",
        "sparkles" => "sparkles",
        "shield-check" => "checkmark.shield",
        "badge-check" => "checkmark.seal",
        "key-round" => "key",
        _ => "circle.dashed",
    }
}

fn minor_of(label: &str, v: &Value) -> Option<Minor> {
    if v.is_null() {
        return None;
    }
    Some(Minor { icon: quota_symbol(s(v, "icon")).into(), reset: v.get("reset").and_then(Value::as_bool).unwrap_or(false), label: label.into(), value: text_of(v, "value"), right: text_of(v, "right"), level: level_of_tone(s(v, "tone")), ..Default::default() })
}

/// One card per account of `/api/board`: usable first, spent ones last.
pub fn quota_cards(body: &str) -> Vec<QuotaCard> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out: Vec<QuotaCard> = v.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter(|a| !s(a, "email").is_empty() || !s(a, "name").is_empty()).map(|a| {
        let wins = a.get("windows").and_then(Value::as_array).cloned().unwrap_or_default();
        let win = |k: &str| wins.iter().find(|w| s(w, "key") == k);
        let st = a.get("state").cloned().unwrap_or(Value::Null);
        let mut minors: Vec<Minor> = Vec::new();
        minors.extend(a.get("plan").and_then(|x| minor_of(s(x, "label").trim().is_empty().then_some("Piano").unwrap_or(s(x, "label")), x)));
        if let Some(e) = a.get("end").filter(|e| !e.is_null()) {
            minors.push(Minor { icon: "clock".into(), reset: false, label: "Finisce".into(), value: s(e, "text").into(), right: String::new(), level: level_of_tone(s(e, "tone")), ..Default::default() });
        }
        if let Some(t) = a.get("tokens").filter(|t| !t.is_null()) {
            minors.push(Minor { icon: "square.stack.3d.up".into(), reset: false, label: "Token".into(), value: text_of(t, "left"), right: "rimasti".into(), level: 0, ..Default::default() });
        }
        for w in wins.iter().filter(|w| s(w, "key") != "5h" && s(w, "key") != "week") {
            // the 24 hour window is a pace, not a share: how many times the sustainable one the account runs at
            if s(w, "key") == "day" {
                if let Some(ratio) = a.get("gauge").and_then(|g| num(g, "day")) {
                    minors.push(Minor { icon: "waveform.path.ecg".into(), whole: format!("Ritmo: {}× il sostenibile", ratio_text(ratio)), level: level_of_tone(s(w, "tone")), ..Default::default() });
                }
                continue;
            }
            let reset = s(w, "reset");
            minors.push(Minor {
                icon: if s(w, "key") == "day" { "waveform.path.ecg" } else { "sparkles" }.into(),
                reset: !reset.is_empty(),
                label: s(w, "label").into(),
                value: format!("{}%", num(w, "used").unwrap_or(0.0).round() as i64),
                right: if reset.is_empty() { s(w, "note").into() } else { reset.into() },
                level: level_of_tone(s(w, "tone")),
                ..Default::default()
            });
        }
        if let Some(b) = a.get("bonus").filter(|b| !b.is_null()) {
            minors.push(Minor { icon: "gift".into(), reset: false, label: "Bonus".into(), value: format!("${}", num(b, "left").unwrap_or(0.0).round() as i64), right: s(b, "renews").into(), level: 0, ..Default::default() });
        }
        minors.extend(a.get("api").and_then(|x| minor_of(s(x, "label"), x)));
        let dial = st.get("dial").and_then(Value::as_bool).unwrap_or(false);
        QuotaCard {
            provider: s(a, "provider").into(),
            provider_name: s(a, "providerName").into(),
            who: Some(s(a, "email")).filter(|e| !e.is_empty()).unwrap_or(s(a, "name")).into(),
            used: num(a, "used").unwrap_or(0.0) as f32,
            state: s(&st, "text").into(),
            state_level: level_of_tone(s(&st, "tone")),
            state_icon: Some(s(&st, "icon")).filter(|i| !i.is_empty()).map(|i| quota_symbol(i).to_string()).unwrap_or_default(),
            needle: if dial { a.get("gauge").and_then(|g| num(g, "needle")).map(|n| n as f32) } else { None },
            five_hour: win("5h").map(|w| meter_of(w, "5 ore")),
            five_say: a.get("fiveHour").filter(|f| s(f, "state") != "ok").map(|f| s(f, "say").trim().to_string()).unwrap_or_default(),
            week: win("week").map(|w| meter_of(w, "7 giorni")),
            minors,
        }
    }).collect();
    out.sort_by_key(|c| c.used >= 100.0);
    out
}

const Q_COLS: usize = 3;
const Q_GAP: f32 = 8.0;
const Q_INSET: f32 = 9.0;
const METER_H: f32 = 27.0;
/// A meter with no reading is its line alone: a grey bar under «nessun limite» or a dash would only be height.
const METER_LINE_H: f32 = 17.0;
const MINOR_H: f32 = 16.0;
/// Where a card's values begin, from the card's inner left edge: the minor rows' values and the meters' percentages.
const VALUE_COL: f32 = 56.0;

/// The height a meter takes: the line and its bar when it is read, the line alone when it is not.
fn meter_h(m: &Option<Meter>) -> f32 {
    if m.is_some() { METER_H } else { METER_LINE_H }
}

fn quota_card_h(c: &QuotaCard) -> f32 {
    let n = c.minors.len() as f32;
    Q_INSET + 16.0 + 4.0 + 20.0 + 6.0 + meter_h(&c.five_hour) + 5.0 + meter_h(&c.week) + if n > 0.0 { 8.0 + n * MINOR_H } else { 0.0 } + Q_INSET - 2.0
}

/// The account's line: the email at `size` and, after it, the provider in a smaller regular face. The provider is
/// left out when it is the name already (a Muse account is called «Muse»). Two cards with the same email tell
/// each other apart by it, so it is the email that gives way: the size goes down first, the email is cut last.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WhoLine {
    pub who: String,
    pub size: f32,
    pub suffix: String,
    pub suffix_size: f32,
}

pub(crate) fn who_line(who: &str, provider_name: &str, room: f32) -> WhoLine {
    who_line_capped(who, provider_name, room, 11.5)
}

/// The same, never larger than `cap`: the cards of a panel share the smallest size any of them needs, so the
/// emails read at one size across the three columns.
pub(crate) fn who_line_capped(who: &str, provider_name: &str, room: f32, cap: f32) -> WhoLine {
    let name = provider_name.trim();
    let tail = if name.is_empty() || name.eq_ignore_ascii_case(who.trim()) { String::new() } else { format!(" · {name}") };
    for size in [11.5_f32, 11.0, 10.5, 10.0, 9.5, 9.0].into_iter().filter(|s| *s <= cap) {
        let sz = (size - 1.5).max(8.0);
        if Pic::text_w(Face::Sans, who, size) + if tail.is_empty() { 0.0 } else { Pic::text_w(Face::SansRegular, &tail, sz) } <= room {
            return WhoLine { who: who.into(), size, suffix: tail, suffix_size: sz };
        }
    }
    let (size, sz) = (9.0, 8.0);
    let tail_w = if tail.is_empty() { 0.0 } else { Pic::text_w(Face::SansRegular, &tail, sz) };
    WhoLine { who: Pic::fit(Face::Sans, who, size, (room - tail_w).max(0.0)), size, suffix: tail, suffix_size: sz }
}

/// The hub's sentence for a missing 5 hour reading, set at the right edge like the notes of the minor rows, in the
/// regular face (a sentence, not a figure): the size goes down before the sentence is cut.
pub(crate) fn say_fit(text: &str, room: f32) -> (String, f32) {
    for size in [10.0_f32, 9.5, 9.0] {
        if Pic::text_w(Face::SansRegular, text, size) <= room {
            return (text.into(), size);
        }
    }
    (Pic::fit(Face::SansRegular, text, 9.0, room.max(0.0)), 9.0)
}

fn draw_meter(pic: &mut Pic, m: &Option<Meter>, say: &str, label: &str, x: f32, y: f32, w: f32, p: Palette) {
    let a = if m.is_some() { 1.0 } else { 0.45 };
    let used = m.as_ref().map_or(0.0, |m| m.used);
    let l1 = y + 11.0;
    // the label says what the share is of; the percentage follows it, the time of the reset ends the line
    let lw = pic.text(Face::SansRegular, label, x, l1, 11.0, p.fg, p.dim * a);
    let px = x + lw + 6.0;
    // no reading and a sentence from the hub: the sentence says why, in place of the dash
    let said = m.is_none() && !say.is_empty();
    let pct = m.as_ref().map_or(if said { String::new() } else { "—".to_string() }, |m| format!("{}%", m.used.round() as i64));
    let pw = pic.text(Face::MonoBold, &pct, px, l1 + 1.0, 14.0, p.fg, a);
    if said {
        let (text, size) = say_fit(say, x + w - px);
        let sw = Pic::text_w(Face::SansRegular, &text, size);
        pic.text(Face::SansRegular, &text, x + w - sw, l1, size, p.fg, p.dim);
    }
    if let Some(m) = m.as_ref().filter(|m| !m.reset.is_empty()) {
        // the time of the reset is never cut: it shrinks, loses its refresh arrow, then its day word
        let room = x + w - (px + pw + 8.0);
        let (text, size, arrow) = fit_note(&m.reset, room, true, 10.5);
        let rw = Pic::text_w(Face::Mono, &text, size);
        pic.text(Face::Mono, &text, x + w - rw, l1, size, p.fg, p.dim);
        if let (true, Some(mask)) = (arrow, system_symbol("arrow.clockwise")) {
            pic.mask(x + w - rw - 12.0, l1 - 9.0, 9.0, &mask, p.fg, p.dim);
        }
    }
    if let Some(m) = m {
        pic.bar(x, y + 22.0, w, used, m.mark, tone(m.level), p);
    }
}

/// How a note at the right edge of a card row is set in `room`: the whole text at `base` with its refresh arrow
/// when it wants one, then without it, then half a point and a point smaller, and only then without its first word
/// (the day, «ieri»). The last resort cuts the text. Returns the text, the size and whether the arrow is drawn.
pub(crate) fn fit_note(text: &str, room: f32, arrow: bool, base: f32) -> (String, f32, bool) {
    let shorter = text.split_once(' ').map(|(_, rest)| rest);
    let steps = [(base, arrow), (base, false), (base - 0.5, false), (base - 1.0, false)];
    for candidate in std::iter::once(text).chain(shorter) {
        for (size, with_arrow) in steps {
            if with_arrow && !arrow {
                continue;
            }
            if Pic::text_w(Face::Mono, candidate, size) + if with_arrow { 12.0 } else { 0.0 } <= room {
                return (candidate.to_string(), size, with_arrow);
            }
        }
    }
    let last = shorter.unwrap_or(text);
    (Pic::fit(Face::Mono, last, base - 1.0, room.max(0.0)), base - 1.0, false)
}

/// How the state of an account is set in the room of its line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum StatePlan {
    Whole,
    /// The state and, smaller and at the right edge, the time it holds until: the two sizes.
    Split(f32, f32),
    Cut,
}

/// «solo riserva → dom 10:00» is the state and the time it holds until: when they do not fit as one line they
/// go on the same line at two sizes, so neither is cut. Only a state with no such time is ever shortened.
pub(crate) fn state_plan(state: &str, room: f32) -> StatePlan {
    if Pic::text_w(Face::Sans, state, 11.5) <= room {
        return StatePlan::Whole;
    }
    if let Some((head, tail)) = state.split_once(" → ") {
        let tail = format!("→ {tail}");
        for (hs, ts) in [(11.5_f32, 10.0_f32), (10.5, 9.5), (10.0, 9.0)] {
            if Pic::text_w(Face::Sans, head, hs) + 6.0 + Pic::text_w(Face::SansRegular, &tail, ts) <= room {
                return StatePlan::Split(hs, ts);
            }
        }
    }
    StatePlan::Cut
}

fn draw_state(pic: &mut Pic, state: &str, x: f32, right: f32, base: f32, color: [u8; 3]) {
    let room = right - x;
    match (state_plan(state, room), state.split_once(" → ")) {
        (StatePlan::Whole, _) => {
            pic.text(Face::Sans, state, x, base, 11.5, color, 1.0);
        }
        (StatePlan::Split(hs, ts), Some((head, tail))) => {
            let tail = format!("→ {tail}");
            pic.text(Face::Sans, head, x, base, hs, color, 1.0);
            pic.text(Face::SansRegular, &tail, right - Pic::text_w(Face::SansRegular, &tail, ts), base, ts, color, 1.0);
        }
        _ => {
            pic.text(Face::Sans, &Pic::fit(Face::Sans, state, 10.5, room), x, base, 10.5, color, 1.0);
        }
    }
}

fn draw_quota_card(pic: &mut Pic, c: &QuotaCard, who_cap: f32, x: f32, y: f32, w: f32, h: f32, p: Palette) {
    pic.frame(x, y, w, h, p);
    let (ix, iw) = (x + Q_INSET, w - 2.0 * Q_INSET);
    // provider mark: its initial in a capsule, then the account
    let ty = y + Q_INSET + 11.0;
    match provider_mark(&c.provider, p) {
        Some((mark, ink)) => pic.mask(ix, ty - 11.0, 14.0, &mark, ink, 1.0),
        None => {
            pic.fill_rrect(ix, ty - 10.0, 13.0, 13.0, 4.0, p.fg, 0.14);
            let init: String = c.provider.chars().next().map(|ch| ch.to_uppercase().to_string()).unwrap_or_default();
            pic.text(Face::Sans, &init, ix + 6.5 - Pic::text_w(Face::Sans, &init, 9.0) / 2.0, ty - 0.5, 9.0, p.fg, 1.0);
        }
    }
    let line = who_line_capped(&c.who, &c.provider_name, iw - 18.0, who_cap);
    let ww = pic.text(Face::Sans, &line.who, ix + 18.0, ty, line.size, p.fg, 1.0);
    if !line.suffix.is_empty() {
        pic.text(Face::SansRegular, &line.suffix, ix + 18.0 + ww, ty, line.suffix_size, p.fg, p.dim);
    }
    let sy = y + Q_INSET + 16.0 + 4.0;
    let st = tone(c.state_level);
    let tx;
    if let Some(n) = c.needle {
        let (gcx, gcy, r) = (ix + 13.0, sy + 17.0, 12.5);
        pic.ring(gcx, gcy, r - 1.5, 2.5, 0.0, 0.5, tone(0), 0.55);
        pic.ring(gcx, gcy, r - 1.5, 2.5, 0.5, 1.0, tone(2), 0.55);
        let a = std::f32::consts::PI * (1.0 - (n / 2.0).clamp(0.0, 1.0));
        pic.seg((gcx, gcy), (gcx + (r - 2.5) * a.cos(), gcy - (r - 2.5) * a.sin()), 1.8, st, 1.0);
        pic.dot(gcx, gcy, 2.0, st, 1.0);
        tx = ix + 33.0;
    } else if let Some(mask) = Some(&c.state_icon).filter(|i| !i.is_empty()).and_then(|i| system_symbol(i)) {
        pic.mask(ix, sy + 3.0, 14.0, &mask, st, 1.0);
        tx = ix + 19.0;
    } else {
        pic.dot(ix + 6.0, sy + 11.0, 3.5, st, 1.0);
        tx = ix + 19.0;
    }
    draw_state(pic, &c.state, tx, ix + iw, sy + 15.0, st);
    let my = sy + 20.0 + 6.0;
    draw_meter(pic, &c.five_hour, &c.five_say, "5 ore", ix, my, iw, p);
    draw_meter(pic, &c.week, "", "7 giorni", ix, my + meter_h(&c.five_hour) + 5.0, iw, p);
    if c.minors.is_empty() {
        return;
    }
    let mut yy = my + meter_h(&c.five_hour) + 5.0 + meter_h(&c.week) + 8.0;
    pic.hline(ix, yy - 4.0, iw, p.fg, 0.14);
    for m in &c.minors {
        let base = yy + 11.0;
        if let Some(mask) = system_symbol(&m.icon) {
            pic.mask(ix, base - 10.0, 11.0, &mask, p.fg, p.dim);
        }
        if !m.whole.is_empty() {
            let c = if m.level > 0 { tone(m.level) } else { p.fg };
            pic.text(Face::SansRegular, &Pic::fit(Face::SansRegular, &m.whole, 10.5, iw - 15.0), ix + 15.0, base, 10.5, c, if m.level > 0 { 1.0 } else { p.dim });
            yy += MINOR_H;
            continue;
        }
        pic.text(Face::SansRegular, &m.label, ix + 15.0, base, 11.0, p.fg, p.dim);
        let vx = ix + VALUE_COL;
        // the value goes down half a point (twice) before the note beside it has to be cut: the date of the API credit
        // is worth more than the third decimal of a size
        let note_w = |size: f32| Pic::text_w(Face::Mono, m.right.rsplit(' ').next().unwrap_or(""), size);
        let value_pt = [(11.0_f32, 10.0_f32), (10.5, 9.5), (10.0, 9.0)].into_iter()
            .find(|(vs, ns)| ix + iw - (vx + Pic::text_w(Face::Sans, &m.value, *vs) + 6.0) >= note_w(*ns)).map_or(10.0, |(vs, _)| vs);
        let vw = pic.text(Face::Sans, &Pic::fit(Face::Sans, &m.value, value_pt, iw - 56.0), vx, base, value_pt, if m.level > 0 { tone(m.level) } else { p.fg }, 1.0);
        let full = ix + iw - (vx + vw + 6.0);
        if !m.right.is_empty() {
            // the note ends on the right margin and is whole: it shrinks, loses its refresh arrow (the date beside it
            // says it is a time of renewal), then its first word («sost.», «ieri») before it is ever cut
            let (text, size, arrow) = fit_note(&m.right, full, m.reset, 10.0);
            let rw = Pic::text_w(Face::Mono, &text, size);
            pic.text(Face::Mono, &text, ix + iw - rw, base, size, p.fg, p.dim);
            if let (true, Some(mask)) = (arrow, system_symbol("arrow.clockwise")) {
                pic.mask(ix + iw - rw - 12.0, base - 9.0, 9.0, &mask, p.fg, p.dim);
            }
        }
        yy += MINOR_H;
    }
}

/// Three cards per row, one per account. None when there is no account to show.
pub fn draw_quota_panel(cards: &[QuotaCard], p: Palette) -> Option<Pic> {
    if cards.is_empty() {
        return None;
    }
    let cw = (MENU_W - 2.0 * PAD - Q_GAP * (Q_COLS as f32 - 1.0)) / Q_COLS as f32;
    let rows: Vec<&[QuotaCard]> = cards.chunks(Q_COLS).collect();
    let heights: Vec<f32> = rows.iter().map(|r| r.iter().map(quota_card_h).fold(0.0, f32::max)).collect();
    let total: f32 = 4.0 + heights.iter().map(|h| h + Q_GAP).sum::<f32>();
    let mut pic = Pic::new(MENU_W, total);
    let who_cap = cards.iter().map(|c| who_line(&c.who, &c.provider_name, cw - 2.0 * Q_INSET - 18.0).size).fold(11.5, f32::min);
    let mut y = 4.0;
    for (r, row) in rows.iter().enumerate() {
        for (i, c) in row.iter().enumerate() {
            draw_quota_card(&mut pic, c, who_cap, PAD + i as f32 * (cw + Q_GAP), y, cw, heights[r], p);
        }
        y += heights[r] + Q_GAP;
    }
    Some(pic)
}
