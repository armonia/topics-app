// The bridge's transport: a Unix socket on macOS/Linux, a named pipe on Windows.
//
// The protocol (line-delimited JSON) and the rest of the daemon do not change:
// only the pipe underneath does. Windows has no Unix-domain sockets in the shape
// the rest of the file uses them (`std::os::unix::net`), but it has named pipes,
// which carry exactly the semantics needed here: a name in the kernel namespace,
// a server accepting several clients, a bidirectional byte stream.
//
// Why a named pipe and not a loopback TCP port, which would have been quicker to
// write: a port is reachable by ANY process on the machine, including another
// user's, and this pipe accepts commands that spawn processes with the user's own
// environment. A named pipe's perimeter is declared in its ACL. The bridge is not
// a network service and must not become one for implementation convenience.
//
// VERIFIED on the test PC before writing the port, because the assumption
// everything rests on is not obvious: `bun` (which is the server) speaks Windows
// named pipes via `net.connect("\\\\.\\pipe\\name")` and gets its reply. Useful
// aside for the future: `node` on the same machine failed with ENOENT on the same
// name in the same moment — so the transport choice is tied to the server's
// runtime, not to the operating system.

use std::io::{Read, Result as IoResult, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub struct Listener(UnixListener);
    pub struct Stream(UnixStream);

    impl Listener {
        pub fn bind(path: &Path) -> IoResult<Self> {
            UnixListener::bind(path).map(Listener)
        }
        pub fn accept(&self) -> IoResult<Stream> {
            self.0.accept().map(|(s, _)| Stream(s))
        }
    }

    impl Stream {
        pub fn connect(path: &Path) -> IoResult<Self> {
            UnixStream::connect(path).map(Stream)
        }
        pub fn try_clone(&self) -> IoResult<Stream> {
            self.0.try_clone().map(Stream)
        }
        pub fn set_read_timeout(&self, d: Option<std::time::Duration>) -> IoResult<()> {
            self.0.set_read_timeout(d)
        }
        pub fn set_write_timeout(&self, d: Option<std::time::Duration>) -> IoResult<()> {
            self.0.set_write_timeout(d)
        }
    }

    /// The socket is a file: it survives a hard exit and has to be removed, or the
    /// next `bind` finds the spot taken.
    pub fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    /// Is there anything at that name? On unix that is a filesystem question.
    pub fn endpoint_exists(path: &Path) -> bool {
        path.exists()
    }

    /// The pidfile lives beside the socket.
    pub fn pid_path_for(socket: &Path) -> PathBuf {
        socket.with_extension("pid")
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            self.0.read(buf)
        }
    }
    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> IoResult<()> {
            self.0.flush()
        }
    }
    impl Read for &Stream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            (&self.0).read(buf)
        }
    }
    impl Write for &Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            (&self.0).write(buf)
        }
        fn flush(&mut self) -> IoResult<()> {
            (&self.0).flush()
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::RawHandle;
    use std::sync::{Arc, Mutex};

    // The Win32 calls that are needed, declared by hand rather than pulling in
    // `windows-sys`: they are few, their signatures have been stable since 1993,
    // and one more dependency in every shipped install needs a better reason than
    // "it was more convenient".
    type Handle = RawHandle;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;
    const ERROR_PIPE_CONNECTED: i32 = 535;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_BROKEN_PIPE: u32 = 109;
    const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const INFINITE: u32 = 0xFFFF_FFFF;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_buffer_size: u32,
            in_buffer_size: u32,
            default_timeout: u32,
            security_attributes: *mut std::ffi::c_void,
        ) -> Handle;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut std::ffi::c_void,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> i32;
        fn DisconnectNamedPipe(pipe: Handle) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
        fn CreateEventW(sec: *mut std::ffi::c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn ReadFile(h: Handle, buf: *mut u8, len: u32, read: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(h: Handle, buf: *const u8, len: u32, written: *mut u32, ov: *mut Overlapped) -> i32;
        fn GetOverlappedResult(h: Handle, ov: *mut Overlapped, count: *mut u32, wait: i32) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn CancelIoEx(h: Handle, ov: *mut Overlapped) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        let mut v: Vec<u16> = path.as_os_str().encode_wide().collect();
        v.push(0);
        v
    }

    /// One overlapped operation: its own event, because two operations that share
    /// an event cannot tell whose completion just fired.
    struct Op {
        ov: Box<Overlapped>,
    }

    impl Op {
        fn new() -> IoResult<Op> {
            // Manual-reset, initially unsignalled — the state GetOverlappedResult
            // expects to wait on.
            let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Op {
                ov: Box::new(Overlapped {
                    internal: 0,
                    internal_high: 0,
                    offset: 0,
                    offset_high: 0,
                    event,
                }),
            })
        }
    }

    impl Drop for Op {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.ov.event) };
        }
    }

    /// The listener holds the NAME, not a handle: on Windows every connection is a
    /// pipe instance of its own, created at accept time. That is the difference
    /// that matters against a Unix socket, where the listener is one object and
    /// connections descend from it.
    ///
    /// The first instance is created straight away, in `bind`, with
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE`: that flag is what gives uniqueness. If
    /// another bridge already owns the name, creation FAILS instead of adding a
    /// second listener on the same name — which would be two daemons stealing each
    /// other's clients at random.
    pub struct Listener {
        name: PathBuf,
        /// The instance already created and not yet handed to a client.
        pending: Mutex<Option<Handle>>,
    }
    // Windows handles are process-global and usable from several threads; the
    // mutex only guards the hand-off between bind and accept.
    unsafe impl Send for Listener {}
    unsafe impl Sync for Listener {}

    impl Listener {
        pub fn bind(path: &Path) -> IoResult<Self> {
            let h = create_instance(path, true)?;
            Ok(Listener {
                name: path.to_path_buf(),
                pending: Mutex::new(Some(h)),
            })
        }

        pub fn accept(&self) -> IoResult<Stream> {
            // Take the waiting instance (or make one), wait for a client, and
            // IMMEDIATELY prepare the next one: between a connection and the
            // creation of the following instance the name must never be left with
            // nobody listening, or a client arriving in that window gets a
            // "file not found" and the server concludes the bridge is dead.
            let h = {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.take() {
                    Some(h) => h,
                    None => create_instance(&self.name, false)?,
                }
            };
            // The instance is OVERLAPPED, so ConnectNamedPipe returns immediately
            // and the wait happens on the event.
            let mut op = Op::new()?;
            let connected = unsafe { ConnectNamedPipe(h, &mut *op.ov) };
            if connected == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_IO_PENDING {
                    unsafe { WaitForSingleObject(op.ov.event, INFINITE) };
                    let mut n: u32 = 0;
                    if unsafe { GetOverlappedResult(h, &mut *op.ov, &mut n, 1) } == 0 {
                        let e = std::io::Error::last_os_error();
                        unsafe { CloseHandle(h) };
                        return Err(e);
                    }
                } else if err as i32 != ERROR_PIPE_CONNECTED {
                    // A client that connected BEFORE our ConnectNamedPipe is not an
                    // error: it is the normal race, and ERROR_PIPE_CONNECTED is how
                    // Windows reports it.
                    unsafe { CloseHandle(h) };
                    return Err(std::io::Error::from_raw_os_error(err as i32));
                }
            }
            if let Ok(next) = create_instance(&self.name, false) {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                *pending = Some(next);
            }
            Ok(Stream::from_handle(h, true))
        }
    }

    fn create_instance(path: &Path, first: bool) -> IoResult<Handle> {
        let name = wide(path);
        // OVERLAPPED, and this is not a detail: see the note on `Stream`.
        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let h = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                open_mode,
                // REJECT_REMOTE_CLIENTS: this pipe is for the server running on the
                // same machine. Without it the name would be reachable over SMB
                // from another machine on the network — and this pipe spawns
                // processes.
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(h)
    }

    /// One end of the pipe.
    ///
    /// EVERY operation is OVERLAPPED, and that is the whole reason this type is
    /// hand-written instead of being a `std::fs::File`. On a SYNCHRONOUS Windows
    /// handle the kernel serialises I/O: a thread blocked in `ReadFile` waiting
    /// for the next request holds the handle, and a `WriteFile` from another
    /// thread simply waits — forever, because the read only returns when the peer
    /// sends something, and the peer is waiting for what we are trying to write.
    ///
    /// That deadlock is exactly the shape this daemon has: `handle_client` blocks
    /// reading commands while `broadcast` writes PTY output from the reader
    /// threads. Measured on Windows 11 on 2026-08-26, with a synchronous handle:
    /// the client received the `created` message plus 16 bytes of terminal output
    /// and then nothing, forever — a terminal that opens and stays blank, with no
    /// error anywhere.
    ///
    /// With FILE_FLAG_OVERLAPPED each operation carries its own OVERLAPPED and its
    /// own event, so reads and writes proceed independently on the same handle.
    ///
    /// The handle is shared through an `Arc` (the daemon reads from one thread and
    /// writes from the client map), and `owned_server` marks the server side, which
    /// at end of life must disconnect the instance and not merely close the handle.
    pub struct Stream {
        h: Arc<HandleOwner>,
        /// The server side, which at end of life must disconnect the instance and
        /// not merely close the handle. `HandleOwner::drop` does that work: it is
        /// the only place that knows whether this was the LAST reference —
        /// disconnecting from any clone would drop a client that is still live.
        #[allow(dead_code)]
        owned_server: bool,
        /// Per-END, not per-handle: the read side of a clone can carry a probe's
        /// short timeout while the write side keeps the broadcast one.
        read_timeout: Mutex<Option<std::time::Duration>>,
        write_timeout: Mutex<Option<std::time::Duration>>,
    }

    struct HandleOwner {
        h: Handle,
        disconnect: bool,
    }
    unsafe impl Send for HandleOwner {}
    unsafe impl Sync for HandleOwner {}

    impl Drop for HandleOwner {
        fn drop(&mut self) {
            unsafe {
                if self.disconnect {
                    DisconnectNamedPipe(self.h);
                }
                CloseHandle(self.h);
            }
        }
    }

    unsafe impl Send for Stream {}
    unsafe impl Sync for Stream {}

    impl Stream {
        fn from_handle(h: Handle, owned_server: bool) -> Stream {
            Stream {
                h: Arc::new(HandleOwner { h, disconnect: owned_server }),
                owned_server,
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
            }
        }

        pub fn connect(path: &Path) -> IoResult<Self> {
            let name = wide(path);
            for attempt in 0..2 {
                let h = unsafe {
                    CreateFileW(
                        name.as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        0,
                        std::ptr::null_mut(),
                        OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED,
                        std::ptr::null_mut(),
                    )
                };
                if h != INVALID_HANDLE_VALUE {
                    return Ok(Stream::from_handle(h, false));
                }
                let err = std::io::Error::last_os_error();
                // Every instance busy ⇒ wait a moment for one to free up, rather
                // than declaring dead a bridge that is merely crowded.
                if attempt == 0 && unsafe { WaitNamedPipeW(name.as_ptr(), 1000) } != 0 {
                    continue;
                }
                return Err(err);
            }
            Err(std::io::Error::last_os_error())
        }

        /// Same end, second reference: the daemon reads from one thread and writes
        /// from the client map, as it does on unix with `try_clone`. Both refer to
        /// the SAME handle — which is safe precisely because it is overlapped.
        pub fn try_clone(&self) -> IoResult<Stream> {
            Ok(Stream {
                h: Arc::clone(&self.h),
                owned_server: false,
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
            })
        }

        /// On unix this keeps `probe_bridge` from hanging. Honoured here too: a
        /// read that does not complete within the window is cancelled, so a probe
        /// against a wedged bridge returns instead of waiting forever.
        pub fn set_read_timeout(&self, d: Option<std::time::Duration>) -> IoResult<()> {
            *self.read_timeout.lock().unwrap_or_else(|e| e.into_inner()) = d;
            Ok(())
        }

        /// On unix this protects `broadcast` from a client that stops draining the
        /// socket: without it ONE suspended app blocks delivery for EVERY terminal,
        /// because the write happens with the client lock held. Honoured here for
        /// the same reason, on the same mechanism as the read timeout.
        pub fn set_write_timeout(&self, d: Option<std::time::Duration>) -> IoResult<()> {
            *self.write_timeout.lock().unwrap_or_else(|e| e.into_inner()) = d;
            Ok(())
        }

        fn do_io(&self, buf_ptr: *mut u8, len: usize, timeout: Option<std::time::Duration>, write: bool) -> IoResult<usize> {
            if len == 0 {
                return Ok(0);
            }
            let h = self.h.h;
            let mut op = Op::new()?;
            let len32 = len.min(u32::MAX as usize) as u32;
            let mut done: u32 = 0;
            let started = unsafe {
                if write {
                    WriteFile(h, buf_ptr as *const u8, len32, &mut done, &mut *op.ov)
                } else {
                    ReadFile(h, buf_ptr, len32, &mut done, &mut *op.ov)
                }
            };
            if started == 0 {
                let err = unsafe { GetLastError() };
                if err != ERROR_IO_PENDING {
                    // A peer that hung up is an EOF, not a failure: the caller's
                    // loop must end, not log an error nobody can act on.
                    if err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED {
                        return Ok(0);
                    }
                    return Err(std::io::Error::from_raw_os_error(err as i32));
                }
                let ms = timeout.map(|d| d.as_millis().min(u32::MAX as u128) as u32).unwrap_or(INFINITE);
                let waited = unsafe { WaitForSingleObject(op.ov.event, ms) };
                if waited == WAIT_TIMEOUT {
                    // Cancel, then reap: an abandoned OVERLAPPED whose buffer goes
                    // out of scope is how a process corrupts its own memory later.
                    unsafe {
                        CancelIoEx(h, &mut *op.ov);
                        let mut n: u32 = 0;
                        GetOverlappedResult(h, &mut *op.ov, &mut n, 1);
                    }
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "pipe timeout"));
                }
                if waited != WAIT_OBJECT_0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let mut n: u32 = 0;
            if unsafe { GetOverlappedResult(h, &mut *op.ov, &mut n, 1) } == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED {
                    return Ok(0);
                }
                return Err(std::io::Error::from_raw_os_error(err as i32));
            }
            Ok(n as usize)
        }
    }

    /// A named pipe leaves nothing on the filesystem: it disappears when the last
    /// handle closes. There is nothing to clean up, which is one fewer way for a
    /// leftover to block the next start.
    pub fn cleanup(_path: &Path) {}

    /// "Is a bridge already there?" is asked on Windows by trying to open the name:
    /// `Path::exists` on `\\.\pipe\...` does not answer this question.
    pub fn endpoint_exists(path: &Path) -> bool {
        Stream::connect(path).is_ok()
    }

    /// The pidfile cannot sit "beside" a pipe: the pipe's name is not a filesystem
    /// path. It goes to TEMP, carrying the pipe's name inside its own, so two
    /// bridges with different sockets never overwrite each other.
    pub fn pid_path_for(socket: &Path) -> PathBuf {
        let leaf = socket
            .to_string_lossy()
            .rsplit('\\')
            .next()
            .unwrap_or("topics-pty-bridge")
            .to_string();
        std::env::temp_dir().join(format!("{leaf}.pid"))
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            (&*self).read(buf)
        }
    }
    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            (&*self).write(buf)
        }
        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }
    impl Read for &Stream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            let t = *self.read_timeout.lock().unwrap_or_else(|e| e.into_inner());
            self.do_io(buf.as_mut_ptr(), buf.len(), t, false)
        }
    }
    impl Write for &Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            let t = *self.write_timeout.lock().unwrap_or_else(|e| e.into_inner());
            self.do_io(buf.as_ptr() as *mut u8, buf.len(), t, true)
        }
        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }
}

pub use imp::{cleanup, endpoint_exists, pid_path_for, Listener, Stream};
