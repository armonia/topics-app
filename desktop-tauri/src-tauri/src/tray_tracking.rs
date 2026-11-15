//! Keeps the status item still while its menu is open (card 066276b6).
//!
//! The menu opens from the click handler of the library, which runs AppKit's menu
//! tracking loop. Swapping the item image, relaying out its button or replacing the
//! menu while that loop runs can close the menu the moment it opens. Every such
//! update therefore goes through `defer`: it runs at once when no menu is open, and
//! otherwise waits (the latest per kind) until tracking ends.

use crate::mac::{class, id, msg_send, nil};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};

type Job = Box<dyn FnOnce() + Send>;

static OPEN: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Option<HashMap<&'static str, Job>>> = Mutex::new(None);
static INSTALL: Once = Once::new();

/// True between NSMenuDidBeginTracking and NSMenuDidEndTracking.
pub fn is_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

/// Runs `job` now, or after the open menu closes. A later job of the same kind replaces
/// an earlier one still waiting.
pub fn defer(kind: &'static str, job: impl FnOnce() + Send + 'static) {
    if is_open() {
        if let Ok(mut g) = PENDING.lock() {
            g.get_or_insert_with(HashMap::new).insert(kind, Box::new(job));
        }
        // The menu may have closed between the check and the insert: flush again.
        if !is_open() {
            flush();
        }
    } else {
        job();
    }
}

fn flush() {
    let jobs: Vec<Job> = PENDING
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .map(|m| m.into_values().collect())
        .unwrap_or_default();
    for j in jobs {
        j();
    }
}

/// Starts watching menu tracking. Idempotent; call it once the app is running.
pub fn install() {
    INSTALL.call_once(|| unsafe {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        use std::ptr::NonNull;
        let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let begin = NSString::from_str("NSMenuDidBeginTrackingNotification");
        let end = NSString::from_str("NSMenuDidEndTrackingNotification");
        let on_begin = RcBlock::new(|_n: NonNull<AnyObject>| OPEN.store(true, Ordering::SeqCst));
        let on_end = RcBlock::new(|_n: NonNull<AnyObject>| {
            OPEN.store(false, Ordering::SeqCst);
            flush();
        });
        let _: id = msg_send![center, addObserverForName: &*begin, object: nil, queue: nil, usingBlock: &*on_begin];
        let _: id = msg_send![center, addObserverForName: &*end, object: nil, queue: nil, usingBlock: &*on_end];
        // The observers live as long as the process.
        std::mem::forget(on_begin);
        std::mem::forget(on_end);
    });
}
