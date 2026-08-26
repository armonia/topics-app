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
    use std::fs::OpenOptions;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::sync::{Arc, Mutex};

    // The handful of Win32 calls that are needed. Declared by hand rather than
    // pulling in `windows-sys`: there are six of them, their signatures have been
    // stable since 1993, and one more dependency in every shipped install needs a
    // better reason than "it was more convenient".
    type Handle = RawHandle;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;
    const ERROR_PIPE_CONNECTED: i32 = 535;

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
        fn ConnectNamedPipe(pipe: Handle, overlapped: *mut std::ffi::c_void) -> i32;
        fn DisconnectNamedPipe(pipe: Handle) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        let mut v: Vec<u16> = path.as_os_str().encode_wide().collect();
        v.push(0);
        v
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
            let connected = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
            if connected == 0 {
                // A client that connected BEFORE our ConnectNamedPipe is not an
                // error: it is the normal race, and this is how Windows reports it.
                let err = unsafe { GetLastError() } as i32;
                if err != ERROR_PIPE_CONNECTED {
                    unsafe { CloseHandle(h) };
                    return Err(std::io::Error::from_raw_os_error(err));
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
        let mut open_mode = PIPE_ACCESS_DUPLEX;
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

    /// One end of the pipe. `owned_server` tells the server side (which at end of
    /// life must disconnect the instance, not merely close the handle) from the
    /// client side, which is a file like any other.
    pub struct Stream {
        file: Arc<std::fs::File>,
        owned_server: bool,
    }

    impl Stream {
        fn from_handle(h: Handle, owned_server: bool) -> Stream {
            let file = unsafe { std::fs::File::from_raw_handle(h) };
            Stream {
                file: Arc::new(file),
                owned_server,
            }
        }

        pub fn connect(path: &Path) -> IoResult<Self> {
            // Every instance busy ⇒ wait a moment for one to free up, rather than
            // declaring dead a bridge that is merely crowded.
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(f) => Ok(Stream {
                    file: Arc::new(f),
                    owned_server: false,
                }),
                Err(e) => {
                    let name = wide(path);
                    if unsafe { WaitNamedPipeW(name.as_ptr(), 1000) } == 0 {
                        return Err(e);
                    }
                    OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(path)
                        .map(|f| Stream {
                            file: Arc::new(f),
                            owned_server: false,
                        })
                }
            }
        }

        /// Same end, second reference: the daemon reads from one thread and writes
        /// from the client map, as it does on unix with `try_clone`.
        pub fn try_clone(&self) -> IoResult<Stream> {
            Ok(Stream {
                file: Arc::clone(&self.file),
                owned_server: false,
            })
        }

        /// On unix this keeps `probe_bridge` from hanging. On Windows the pipe is
        /// synchronous and there is no per-handle read timeout: the prober guards
        /// itself with its own clock (see `probe_bridge`), which is the check that
        /// actually decides.
        pub fn set_read_timeout(&self, _d: Option<std::time::Duration>) -> IoResult<()> {
            Ok(())
        }

        /// On unix this protects `broadcast` from a client that stops draining its
        /// socket: without it ONE suspended app blocks delivery for EVERY terminal,
        /// because the write happens with the client lock held. On Windows the pipe
        /// is synchronous and exposes no per-handle write timeout; the risk remains,
        /// and it is written down here rather than hidden behind a silent `Ok(())`.
        /// Pipes do have a kernel buffer (64 KB, declared in `create_instance`), so
        /// a stalled consumer only blocks once it has filled that.
        pub fn set_write_timeout(&self, _d: Option<std::time::Duration>) -> IoResult<()> {
            Ok(())
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            if self.owned_server && Arc::strong_count(&self.file) == 1 {
                unsafe { DisconnectNamedPipe(self.file.as_raw_handle()) };
            }
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
            (&*self.file).read(buf)
        }
    }
    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            (&*self.file).write(buf)
        }
        fn flush(&mut self) -> IoResult<()> {
            (&*self.file).flush()
        }
    }
    impl Read for &Stream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            (&*self.file).read(buf)
        }
    }
    impl Write for &Stream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            (&*self.file).write(buf)
        }
        fn flush(&mut self) -> IoResult<()> {
            (&*self.file).flush()
        }
    }
}

pub use imp::{cleanup, endpoint_exists, pid_path_for, Listener, Stream};
