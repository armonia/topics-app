// Trasporto del bridge: un socket Unix su macOS/Linux, una named pipe su Windows.
//
// Il protocollo (JSON a righe) e tutto il resto del daemon non cambiano: cambia
// solo il tubo. Windows non ha i socket di dominio Unix nel modo in cui li usa
// il resto del file (`std::os::unix::net`), ma ha le named pipe, che hanno
// esattamente la semantica che serve qui: un nome nello spazio del kernel, un
// server che accetta più client, uno stream bidirezionale di byte.
//
// Perché una named pipe e non una porta TCP di loopback, che sarebbe stata più
// facile da scrivere: una porta è raggiungibile da QUALUNQUE processo della
// macchina, compresi quelli di un altro utente, e questo tubo accetta comandi
// che avviano processi con l'ambiente dell'utente. Il perimetro di una named
// pipe si dichiara nell'ACL. Il bridge non è un servizio di rete e non deve
// diventarlo per una comodità di implementazione.
//
// VERIFICATO sul PC di prova prima di scrivere il porting, perché l'assunzione
// da cui dipende tutto non è ovvia: `bun` (che è il server) parla le named pipe
// di Windows con `net.connect("\\\\.\\pipe\\nome")` e riceve la risposta.
// Curiosità utile per il futuro: `node` sulla stessa macchina falliva con
// ENOENT sullo stesso nome nello stesso istante — quindi la scelta del
// trasporto è legata al runtime del server, non al sistema.

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

    /// Il socket è un file: resta sul filesystem dopo un'uscita brutta e va tolto,
    /// o il `bind` successivo trova il posto occupato.
    pub fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    /// Esiste qualcosa a quel nome? Su unix è una domanda sul filesystem.
    pub fn endpoint_exists(path: &Path) -> bool {
        path.exists()
    }

    /// Il file dei pid sta accanto al socket.
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
    use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, RawHandle};
    use std::sync::{Arc, Mutex};

    // Le poche chiamate di Win32 che servono. Dichiarate a mano invece di tirare
    // dentro `windows-sys`: sono sei, la loro firma è stabile dal 1993, e una
    // dipendenza in più su un crate che finisce in ogni installazione va
    // giustificata con qualcosa di più di "era più comodo".
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

    /// Il listener tiene il NOME, non un handle: su Windows ogni connessione è
    /// un'istanza di pipe a sé, creata al momento dell'accept. È la differenza
    /// che conta rispetto a un socket unix, dove il listener è uno e le
    /// connessioni ne discendono.
    ///
    /// La prima istanza si crea subito, in `bind`, e con
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE`: è quella che dà l'unicità: se un altro
    /// bridge ha già quel nome, la creazione fallisce invece di aggiungere una
    /// seconda istanza in ascolto sullo stesso nome, che sarebbe due daemon che
    /// si rubano i client a caso.
    pub struct Listener {
        name: PathBuf,
        /// L'istanza già creata e non ancora consegnata a un client.
        pending: Mutex<Option<Handle>>,
    }
    // Gli handle di Windows sono globali al processo e si possono usare da più
    // thread; il Mutex protegge la sola staffetta fra bind e accept.
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
            // Prendi l'istanza in attesa (o creane una nuova), aspetta che un
            // client si colleghi, e SUBITO dopo prepara la prossima: fra la
            // connessione e la creazione dell'istanza successiva il nome non
            // deve mai restare senza nessuno in ascolto, o un client che arriva
            // in quella finestra prende un "file not found" e il server
            // conclude che il bridge è morto.
            let h = {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                match pending.take() {
                    Some(h) => h,
                    None => create_instance(&self.name, false)?,
                }
            };
            let connected = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
            if connected == 0 {
                // Un client che si è collegato PRIMA della ConnectNamedPipe non
                // è un errore: è la corsa normale, e Windows la segnala così.
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
                // REJECT_REMOTE_CLIENTS: questa pipe è per il server che gira
                // sulla stessa macchina. Senza, il nome sarebbe raggiungibile
                // via SMB da un'altra macchina della rete, e questo tubo avvia
                // processi.
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

    /// Un capo della pipe. `owned_server` distingue il lato server (che a fine
    /// vita deve disconnettere l'istanza, non solo chiudere l'handle) dal lato
    /// client, che è un file come un altro.
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
            // Tutte le istanze occupate ⇒ si aspetta un attimo che una si
            // liberi, invece di dichiarare morto un bridge solo affollato.
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

        /// Stesso capo, secondo riferimento: il daemon legge da un thread e
        /// scrive dalla mappa dei client, come su unix con `try_clone`.
        pub fn try_clone(&self) -> IoResult<Stream> {
            Ok(Stream {
                file: Arc::clone(&self.file),
                owned_server: false,
            })
        }

        /// Su unix serve a non restare appesi in `probe_bridge`. Su Windows la
        /// pipe è sincrona e non c'è un timeout di lettura per handle: chi
        /// sonda si protegge col proprio orologio (vedi `probe_bridge`), che è
        /// il controllo che decide davvero.
        pub fn set_read_timeout(&self, _d: Option<std::time::Duration>) -> IoResult<()> {
            Ok(())
        }

        /// Su unix protegge `broadcast` da un client che smette di svuotare il
        /// socket: senza, UNA app sospesa blocca la consegna di TUTTI i
        /// terminali, perche' la scrittura avviene col lock dei client in mano.
        /// Su Windows la pipe e' sincrona e non espone un timeout per handle;
        /// il rischio resta, ed e' scritto qui invece di essere nascosto da un
        /// `Ok(())` muto. Le pipe hanno pero' un buffer del kernel (64 KB,
        /// dichiarato in `create_instance`), quindi un consumatore fermo si
        /// blocca solo dopo averlo riempito.
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

    /// Una named pipe non lascia niente sul filesystem: sparisce quando l'ultimo
    /// handle si chiude. Non c'è nulla da ripulire, ed è un caso in meno in cui
    /// un residuo blocca l'avvio successivo.
    pub fn cleanup(_path: &Path) {}

    /// "C'è già un bridge?" su Windows si chiede provando ad aprire il nome:
    /// `Path::exists` su `\\.\pipe\...` non risponde a questa domanda.
    pub fn endpoint_exists(path: &Path) -> bool {
        Stream::connect(path).is_ok()
    }

    /// Il pidfile non può stare "accanto" a una pipe: il nome della pipe non è
    /// un percorso del filesystem. Va in TEMP, con il nome della pipe dentro il
    /// proprio, così due bridge con socket diversi non si sovrascrivono.
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

    // `IntoRawHandle` non è usato, ma tenerlo importato documenta la parentela
    // con `FromRawHandle` qui sopra.
    #[allow(unused_imports)]
    use IntoRawHandle as _;
}

pub use imp::{cleanup, endpoint_exists, pid_path_for, Listener, Stream};
