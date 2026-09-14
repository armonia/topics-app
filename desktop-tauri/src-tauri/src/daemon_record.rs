//! WHO IS THE DAEMON, AND IS IT STILL THERE. The two files a running Topics
//! server keeps in `~/.topics` (honouring `TOPICS_HOME`, so a worktree install
//! and a launchd install never read each other's):
//!
//!   daemon-process.lock  { pid, acquiredAt }  taken as the process starts
//!   daemon-state.json    { pid, port, token, startedAt }  written after the bind
//!
//! The shell reads them to answer one question before it may start a bundled
//! sidecar: is a real server already running on this machine? Getting that wrong
//! in either direction has cost a person their day. Say "dead" about a live
//! server and the app opens a second, EMPTY universe beside the real one; say
//! "alive" about a pid the OS has recycled and the window waits forever on a
//! server that died hours ago (2026-09-13).

/// Read the port the daemon recorded in `daemon-state.json` (its REAL bound port —
/// the squatter-recovery case where :3333 was held by another process and the
/// daemon fell back to an ephemeral one). Honours `TOPICS_HOME` (the daemon's
/// `topicsHome()` default is `~/.topics`), so a dev/launchd install and a worktree
/// install each read their own state file. Returns `None` when the file is missing,
/// unreadable, or carries no usable port — the caller then simply does not probe
/// an extra port.
pub(crate) fn daemon_state_port() -> Option<u16> {
    // `TOPICS_HOME` set → the daemon's own home (worktree isolation / a custom
    // install). Unset → the daemon's default `~/.topics`.
    let path = if let Ok(h) = std::env::var("TOPICS_HOME") {
        std::path::PathBuf::from(h).join("daemon-state.json")
    } else {
        let os_home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
        std::path::PathBuf::from(os_home).join(".topics").join("daemon-state.json")
    };
    daemon_state_field(&path, "port").map(|p| p as u16).filter(|p| *p != 0)
}

/// Read one numeric field out of `daemon-state.json`. Missing file, unreadable
/// file, absent field: `None`, and the caller simply knows less.
fn daemon_state_field(path: &std::path::Path, field: &str) -> Option<u64> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(field)?.as_u64()
}

/// The path of the daemon's state file, by the same rule the daemon itself uses
/// (`TOPICS_HOME`, else the OS home + `.topics`).
fn daemon_state_path() -> Option<std::path::PathBuf> {
    daemon_home().map(|h| h.join("daemon-state.json"))
}

/// The daemon's process lock, `~/.topics/daemon-process.lock`. It matters that
/// this is a DIFFERENT file from `daemon-state.json`: the lock is taken as the
/// server process starts, the state file is written only once the listener is
/// bound. Between the two there is a window, seconds on a warm machine and much
/// longer on a cold login, in which a real server is starting and the state file
/// still describes the PREVIOUS run (or does not exist). Reading the lock is what
/// lets the shell see that starting server.
fn daemon_lock_path() -> Option<std::path::PathBuf> {
    daemon_home().map(|h| h.join("daemon-process.lock"))
}


/// `TOPICS_HOME`, else the OS home + `.topics`. The same rule the server uses.
fn daemon_home() -> Option<std::path::PathBuf> {
    if let Ok(h) = std::env::var("TOPICS_HOME") {
        return Some(std::path::PathBuf::from(h));
    }
    let os_home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(std::path::PathBuf::from(os_home).join(".topics"))
}

/// Epoch seconds for an ISO-8601 UTC timestamp like `2026-09-14T06:35:07.123Z`,
/// which is what both daemon files record. Written out by hand because the shell
/// has no date library and pulling one in for eight fields would be worse. Any
/// shape this does not recognise is `None`, and the caller then knows nothing
/// about the timestamp, which is the honest answer.
fn epoch_seconds_from_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse::<i64>().ok() };
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil calendar to the Unix epoch (Howard Hinnant's algorithm,
    // the one every date library uses underneath).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let year_of_era = y - era * 400;
    let month_term = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_term + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Read `{ pid, <stamp_field> }` out of one of the daemon's JSON files.
fn daemon_pid_record(path: &std::path::Path, stamp_field: &str) -> Option<(u32, i64)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    let stamp = epoch_seconds_from_iso(v.get(stamp_field)?.as_str()?)?;
    Some((pid as u32, stamp))
}

/// Does process `pid` exist AND did it start when the daemon says it did?
///
/// THE PID ALONE PROVES NOTHING, and this is the 2026-09-14 finding. A pid is a
/// small integer the OS hands out again once the process is gone: on Windows it
/// comes back around in minutes, and `pid 1` is alive on every Unix that ever
/// booted. A recycled pid read as "the daemon is alive" is the 2026-09-13
/// incident exactly: the shell waits forever for a server that died hours ago.
///
/// So the start time has to agree with the record, and the bound that does the
/// work is the UPPER one: our daemon wrote that file while it was running, so it
/// cannot have started AFTER it (bar clock skew). A recycled pid belongs to a
/// process born after the record and fails there. The lower bound only rules out
/// an ancient unrelated process that happens to hold the number, and it is loose
/// on purpose, because between starting and writing its file a cold daemon can
/// legitimately take a long time, and calling a live daemon dead is the mistake
/// that costs someone their topics.
fn process_matches_record(pid: u32, recorded_at: i64, earliest_before: i64) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let Some(process) = sys.process(pid) else { return false };
    let started = process.start_time() as i64;
    // `start_time() == 0` means the platform would not say: unknowable, and an
    // unknowable start time cannot confirm anything.
    if started == 0 {
        return false;
    }
    started <= recorded_at + CLOCK_SKEW_SECONDS && started >= recorded_at - earliest_before
}

/// How far the two clocks (the OS start time and the timestamp the daemon wrote)
/// may disagree while still describing the same instant.
const CLOCK_SKEW_SECONDS: i64 = 10;
/// How long a daemon may take between being started by the OS and taking its
/// lock. Startup plus module loading: seconds, generously bounded.
const LOCK_STARTUP_BUDGET_SECONDS: i64 = 120;
/// How long a daemon may take between being started and having its listener
/// bound, which is when the state file is written. A cold login with a large
/// database is the slow case this covers.
const BIND_STARTUP_BUDGET_SECONDS: i64 = 600;

/// IS THE DAEMON THIS MACHINE RECORDED STILL RUNNING? The one fact a port
/// squatter cannot fake and a slow server cannot lose: a live daemon process
/// means a full universe is running right here, whatever the probes could or
/// could not reach, and the shell must not open an empty second one beside it.
///
/// Two records answer it, and the LOCK is asked first because it exists earlier:
/// a server that is still starting up has taken its lock and not yet written its
/// state file, and that window is precisely when an impatient shell would fork.
/// Either record, checked against the process start time, is enough.
pub(crate) fn daemon_pid_is_alive() -> bool {
    match (daemon_lock_path(), daemon_state_path()) {
        (Some(lock), Some(state)) => daemon_pid_is_alive_in(&lock, &state),
        _ => false,
    }
}

/// The rule of `daemon_pid_is_alive`, with the two paths passed in so a test can
/// point it at files it wrote itself instead of at the person's real home.
fn daemon_pid_is_alive_in(lock: &std::path::Path, state: &std::path::Path) -> bool {
    let by_lock = daemon_pid_record(lock, "acquiredAt")
        .is_some_and(|(pid, at)| process_matches_record(pid, at, LOCK_STARTUP_BUDGET_SECONDS));
    if by_lock {
        return true;
    }
    daemon_pid_record(state, "startedAt")
        .is_some_and(|(pid, at)| process_matches_record(pid, at, BIND_STARTUP_BUDGET_SECONDS))
}

#[cfg(test)]
mod tests {
    use super::{
        daemon_pid_is_alive_in, epoch_seconds_from_iso, process_matches_record,
        LOCK_STARTUP_BUDGET_SECONDS,
    };

    /// An ISO-8601 UTC timestamp for `epoch`, the shape both daemon files use.
    /// The inverse of what the shell parses, written here so a test can put a
    /// process start time into a file the way the server would.
    fn iso_utc(epoch: i64) -> String {
        let days = epoch.div_euclid(86_400);
        let secs = epoch.rem_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
            secs / 3_600,
            (secs % 3_600) / 60,
            secs % 60
        )
    }

    fn now_epoch() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// When THIS process started, by the same source the rule uses.
    fn own_start_time() -> i64 {
        let pid = sysinfo::Pid::from_u32(std::process::id());
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        sys.process(pid).map(|p| p.start_time() as i64).unwrap_or(0)
    }

    #[test]
    fn iso_timestamps_are_read_the_way_the_server_writes_them() {
        assert_eq!(epoch_seconds_from_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(epoch_seconds_from_iso("2026-09-14T06:35:07.123Z"), Some(1_789_367_707));
        // A round trip through the test's own writer, on a date with a leap day
        // behind it, so neither direction can be quietly wrong.
        let stamp = 1_772_000_000;
        assert_eq!(epoch_seconds_from_iso(&iso_utc(stamp)), Some(stamp));
        assert_eq!(epoch_seconds_from_iso("not a timestamp"), None);
    }

    /// THE 2026-09-14 DEFECT, on the real function. A pid that EXISTS proves
    /// nothing: this process exists, and against a record written long before it
    /// started it must read as dead, because that is what a recycled Windows pid
    /// looks like. With a record that matches its start time, it reads as alive.
    #[test]
    fn an_existing_pid_started_at_another_time_is_not_the_daemon() {
        let started = own_start_time();
        assert!(started > 0, "the platform must report a start time for this test to mean anything");
        let pid = std::process::id();
        assert!(
            process_matches_record(pid, started, LOCK_STARTUP_BUDGET_SECONDS),
            "the record that matches the start time is our process"
        );
        assert!(
            !process_matches_record(pid, started - 100_000, LOCK_STARTUP_BUDGET_SECONDS),
            "a process that started AFTER the record is a recycled pid, not the daemon"
        );
        assert!(
            !process_matches_record(pid, started + 100_000, LOCK_STARTUP_BUDGET_SECONDS),
            "a process that started long before the record is an unrelated old process"
        );
        // `pid 1` is alive on every Unix and is the reason "does the pid exist"
        // is not a liveness test at all.
        #[cfg(unix)]
        assert!(
            !process_matches_record(1, now_epoch(), LOCK_STARTUP_BUDGET_SECONDS),
            "pid 1 must never read as the Topics daemon"
        );
    }

    /// The rule end to end, over files written exactly like the server's. The
    /// lock is read FIRST because it exists first: a daemon that has started and
    /// not yet bound its port has a lock and a stale (or absent) state file, and
    /// that window is when an impatient shell used to fork an empty universe.
    #[test]
    fn the_lock_answers_for_a_daemon_that_has_not_bound_yet() {
        let dir = std::env::temp_dir().join(format!("topics-pid-{}-{}", std::process::id(), now_epoch()));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("daemon-process.lock");
        let state = dir.join("daemon-state.json");
        let pid = std::process::id();
        let started = own_start_time();

        // Nothing written yet: nothing to protect.
        assert!(!daemon_pid_is_alive_in(&lock, &state), "no files means no daemon");

        // A lock that matches, and no state file at all: a server mid-startup.
        std::fs::write(
            &lock,
            format!(r#"{{"pid":{pid},"acquiredAt":"{}"}}"#, iso_utc(started + 1)),
        )
        .unwrap();
        assert!(
            daemon_pid_is_alive_in(&lock, &state),
            "a live lock alone must forbid the sidecar"
        );

        // THE WINDOWS CASE OF 2026-09-13: both files name a pid the OS has since
        // handed to somebody else. The records predate this process, so neither
        // confirms anything and the shell is free to start the sidecar.
        std::fs::write(
            &lock,
            format!(r#"{{"pid":{pid},"acquiredAt":"{}"}}"#, iso_utc(started - 100_000)),
        )
        .unwrap();
        std::fs::write(
            &state,
            format!(r#"{{"pid":{pid},"port":3333,"startedAt":"{}"}}"#, iso_utc(started - 100_000)),
        )
        .unwrap();
        assert!(
            !daemon_pid_is_alive_in(&lock, &state),
            "a recycled pid must not read as a live daemon"
        );

        // A stale lock but a state file that matches: still alive.
        std::fs::write(
            &state,
            format!(r#"{{"pid":{pid},"port":3333,"startedAt":"{}"}}"#, iso_utc(started + 2)),
        )
        .unwrap();
        assert!(
            daemon_pid_is_alive_in(&lock, &state),
            "either record may confirm the daemon"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
