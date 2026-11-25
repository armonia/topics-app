//! One source of the numbers of a node card, and what each one says it is out of.

use super::*;
use crate::tray_menu_views::{MachineCard, Metric};

fn m(key: &str, pct: Option<u32>, level: u32, note: &str) -> Metric {
    Metric { key: key.into(), pct, level, note: note.into(), ..Default::default() }
}

#[test]
fn the_memory_of_the_mac_is_the_gigabytes_in_use_judged_by_pressure() {
    // the usage service says 48% (the kernel's pressure, calm); the Topics list says 81% in use, 27,8 of 34,4 GB
    let mut hub = MachineCard { local: true, metrics: vec![m("mem", Some(48), 0, "pressione del sistema")], ..Default::default() };
    let twin = MachineCard { local: true, metrics: vec![m("mem", Some(81), 1, "27,8 GB / 34,4 GB")], ..Default::default() };
    one_source(&mut hub, Some(&twin));
    let mem = &hub.metrics[0];
    assert_eq!((mem.pct, mem.note.as_str()), (Some(81), "27,8 di 34,4 GB"));
    assert_eq!(mem.level, 0, "the colour stays the pressure's: a Mac always fills its memory");
}

#[test]
fn the_cpu_says_how_many_cores_it_is_out_of() {
    let mut hub = MachineCard { metrics: vec![m("cpu", Some(9), 0, "1,4 di 16 core · picco 24 h 100%")], ..Default::default() };
    let twin = MachineCard { metrics: vec![m("cpu", Some(1), 0, "16 core")], ..Default::default() };
    one_source(&mut hub, Some(&twin));
    assert_eq!((hub.metrics[0].pct, hub.metrics[0].note.as_str()), (Some(1), "0,2 di 16 core"), "one reading, not two taken at two moments");
}

#[test]
fn a_server_that_does_not_report_its_memory_use_gets_it_from_the_percentage_and_the_total() {
    let mut hub = MachineCard { metrics: vec![m("mem", Some(18), 0, "adesso · picco 24 h 83%")], ..Default::default() };
    let twin = MachineCard { metrics: vec![m("mem", None, 0, "32,9 GB")], ..Default::default() };
    one_source(&mut hub, Some(&twin));
    assert_eq!((hub.metrics[0].pct, hub.metrics[0].note.as_str()), (Some(18), "5,9 di 32,9 GB"));
}

#[test]
fn points_in_the_decimal_are_read_like_commas() {
    assert_eq!(gb_pair("27.8 GB / 34.4 GB"), (Some(27.8), Some(34.4)));
    assert_eq!(gb_pair("27,8 GB / 34,4 GB"), (Some(27.8), Some(34.4)));
    assert_eq!(gb_pair("32,9 GB"), (None, Some(32.9)));
}

#[test]
fn a_disk_says_it_is_full_and_what_is_left_and_a_value_says_it_is_the_one_now() {
    let mut c = MachineCard { metrics: vec![m("disk", Some(95), 2, "22 GB liberi"), m("cpu", Some(40), 0, "adesso · picco 24 h 100%"), m("gpu", Some(0), 0, "adesso")], ..Default::default() };
    say_what_each_is_of(&mut c);
    let notes: Vec<&str> = c.metrics.iter().map(|x| x.note.as_str()).collect();
    assert_eq!(notes, ["pieno · 22 GB liberi", "picco 24 h 100%", ""]);
    // said once only
    say_what_each_is_of(&mut c);
    assert_eq!(c.metrics[0].note, "pieno · 22 GB liberi");
}

#[test]
fn a_peak_over_a_history_younger_than_a_day_never_says_24_hours() {
    // the service's history has had one point since it started: the «peak of 24 h» was the value itself
    let mut one = m("gpu", Some(77), 0, "picco 24 h 77%");
    one.hist_n = 1;
    let mut three_hours = m("gpu", Some(40), 0, "picco 24 h 77%");
    (three_hours.hist_n, three_hours.hist_span_s, three_hours.hist_peak) = (40, 3 * 3600, Some(77));
    let mut day = m("gpu", Some(40), 0, "picco 24 h 77%");
    (day.hist_n, day.hist_span_s, day.hist_peak) = (120, 24 * 3600, Some(77));
    let mut none = m("cpu", Some(40), 0, "picco 24 h 100%");
    none.hist_n = 0;
    let mut c = MachineCard { metrics: vec![one, three_hours, day, none], ..Default::default() };
    say_what_each_is_of(&mut c);
    let notes: Vec<&str> = c.metrics.iter().map(|x| x.note.as_str()).collect();
    assert_eq!(notes, ["", "picco 77% · ultime 3 ore", "picco 24 h 77%", "picco 24 h 100%"]);
}
