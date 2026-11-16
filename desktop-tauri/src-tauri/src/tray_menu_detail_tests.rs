//! The machine details from fake `/api/machines` answers. Card ad8b474a.

use super::*;

#[test]
fn details_parse_the_procs_and_skip_nameless_ones() {
    let d = machine_details(r#"[
     {"id":"pc","procs":[{"name":"node.exe","cpu_pct":40.5,"mem_mb":812,"cmd":"node vitest"},{"name":"","cpu_pct":1}]},
     {"id":"hetzner","procs":[]},
     {"id":"bare"}]"#);
    assert_eq!(d.len(), 3);
    assert_eq!(d[0].procs, [RemoteProc { name: "node.exe".into(), cpu_pct: 40.5, mem_mb: 812.0, cmd: "node vitest".into() }]);
    assert!(d[1].procs.is_empty() && d[2].procs.is_empty());
    assert!(machine_details("nope").is_empty());
}
