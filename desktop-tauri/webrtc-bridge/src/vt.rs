//! Encode H.264 in HARDWARE su macOS, via VTCompressionSession — in FFI raw, senza
//! aggiungere una sola dipendenza al Cargo.toml.
//!
//! Perché FFI raw e non un crate: le API che servono sono cinque funzioni e una
//! manciata di costanti CFString. Le crate-wrapper (objc2-video-toolbox & co.)
//! porterebbero dentro l'intero albero objc2 per usarne l'1%, su un sidecar che
//! deve restare compilabile a freddo in un minuto. Qui i simboli si dichiarano e
//! si linkano ai framework di sistema: zero download, zero superficie in più.
//!
//! Cosa cambia rispetto a openh264 (il percorso che sostituisce):
//!  - la compressione va all'encoder dedicato del SoC invece che alla CPU;
//!  - sparisce anche la conversione RGB→I420 fatta a mano in Rust: si consegna un
//!    CVPixelBuffer BGRA e la conversione colore la fa VideoToolbox a valle. Sono
//!    due costi tolti alla CPU, non uno.
//!
//! Il formato in uscita è Annex-B, come openh264: la track di webrtc-rs passa i
//! campioni all'H264Payloader, che cerca gli start code. VideoToolbox emette AVCC
//! (NAL con prefisso di lunghezza) e tiene SPS/PPS FUORI dal flusso, dentro la
//! CMFormatDescription — quindi qui si riscrivono i prefissi in `00 00 00 01` e,
//! davanti a ogni IDR, si re-inietta SPS+PPS. Senza quel re-inject un peer che
//! entra a metà non ha i parametri per decodificare e resta nero.

#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::c_void;
use std::sync::Mutex;

use anyhow::{anyhow, Result};

// ---------------------------------------------------------------------------
// Tipi opachi CoreFoundation / CoreVideo / CoreMedia / VideoToolbox
// ---------------------------------------------------------------------------

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFNumberRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFBooleanRef = *const c_void;
type CFIndex = isize;
type OSStatus = i32;
type CVReturn = i32;
type CVPixelBufferRef = *mut c_void;
type CVPixelBufferPoolRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *const c_void;
type VTCompressionSessionRef = *mut c_void;
type VTSessionRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

const kCMTimeFlags_Valid: u32 = 1;

fn cm_time(value: i64, timescale: i32) -> CMTime {
    CMTime { value, timescale, flags: kCMTimeFlags_Valid, epoch: 0 }
}

/// `kCMTimeInvalid` — VTCompressionSessionCompleteFrames(invalid) = "svuota tutto".
const CM_TIME_INVALID: CMTime = CMTime { value: 0, timescale: 0, flags: 0, epoch: 0 };

/// Strutture di callback di CFDictionary: qui servono solo come INDIRIZZI da
/// passare a CFDictionaryCreate, mai deferenziate. Un tipo opaco basta.
#[repr(C)]
struct CFDictionaryCallBacks {
    _private: [u8; 0],
}

type VTCompressionOutputCallback = extern "C" fn(
    outputCallbackRefCon: *mut c_void,
    sourceFrameRefCon: *mut c_void,
    status: OSStatus,
    infoFlags: u32,
    sampleBuffer: CMSampleBufferRef,
);

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFAllocatorDefault: CFAllocatorRef;
    static kCFBooleanTrue: CFBooleanRef;
    static kCFBooleanFalse: CFBooleanRef;
    static kCFTypeDictionaryKeyCallBacks: CFDictionaryCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryCallBacks;

    fn CFRelease(cf: CFTypeRef);
    fn CFNumberCreate(allocator: CFAllocatorRef, theType: CFIndex, valuePtr: *const c_void) -> CFNumberRef;
    fn CFDictionaryCreate(
        allocator: CFAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        numValues: CFIndex,
        keyCallBacks: *const CFDictionaryCallBacks,
        valueCallBacks: *const CFDictionaryCallBacks,
    ) -> CFDictionaryRef;
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> u8;
}

const kCFNumberSInt32Type: CFIndex = 3;
const kCFNumberFloat64Type: CFIndex = 6;

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
    static kCVPixelBufferWidthKey: CFStringRef;
    static kCVPixelBufferHeightKey: CFStringRef;
    static kCVPixelBufferIOSurfacePropertiesKey: CFStringRef;

    fn CVPixelBufferPoolCreatePixelBuffer(
        allocator: CFAllocatorRef,
        pixelBufferPool: CVPixelBufferPoolRef,
        pixelBufferOut: *mut CVPixelBufferRef,
    ) -> CVReturn;
    fn CVPixelBufferCreate(
        allocator: CFAllocatorRef,
        width: usize,
        height: usize,
        pixelFormatType: u32,
        pixelBufferAttributes: CFDictionaryRef,
        pixelBufferOut: *mut CVPixelBufferRef,
    ) -> CVReturn;
    fn CVPixelBufferLockBaseAddress(pixelBuffer: CVPixelBufferRef, lockFlags: u64) -> CVReturn;
    fn CVPixelBufferUnlockBaseAddress(pixelBuffer: CVPixelBufferRef, unlockFlags: u64) -> CVReturn;
    fn CVPixelBufferGetBaseAddress(pixelBuffer: CVPixelBufferRef) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pixelBuffer: CVPixelBufferRef) -> usize;
    fn CVPixelBufferRelease(pixelBuffer: CVPixelBufferRef);
}

/// `'BGRA'` — quattro byte B,G,R,A in memoria. È il formato che evita di fare la
/// conversione colore sulla CPU: la si consegna così e ci pensa VideoToolbox.
const kCVPixelFormatType_32BGRA: u32 = 0x42475241;

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetDataBuffer(sbuf: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(sbuf: CMSampleBufferRef) -> CMFormatDescriptionRef;
    fn CMBlockBufferGetDataLength(theBuffer: CMBlockBufferRef) -> usize;
    fn CMBlockBufferCopyDataBytes(
        theSourceBuffer: CMBlockBufferRef,
        offsetToData: usize,
        dataLength: usize,
        destination: *mut c_void,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        videoDesc: CMFormatDescriptionRef,
        parameterSetIndex: usize,
        parameterSetPointerOut: *mut *const u8,
        parameterSetSizeOut: *mut usize,
        parameterSetCountOut: *mut usize,
        NALUnitHeaderLengthOut: *mut i32,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    static kVTCompressionPropertyKey_RealTime: CFStringRef;
    static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    static kVTProfileLevel_H264_Baseline_AutoLevel: CFStringRef;
    static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFStringRef;
    static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
    static kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder: CFStringRef;
    static kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: CFStringRef;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;

    fn VTCompressionSessionCreate(
        allocator: CFAllocatorRef,
        width: i32,
        height: i32,
        codecType: u32,
        encoderSpecification: CFDictionaryRef,
        sourceImageBufferAttributes: CFDictionaryRef,
        compressedDataAllocator: CFAllocatorRef,
        outputCallback: Option<VTCompressionOutputCallback>,
        outputCallbackRefCon: *mut c_void,
        compressionSessionOut: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(
        session: VTCompressionSessionRef,
        imageBuffer: CVPixelBufferRef,
        presentationTimeStamp: CMTime,
        duration: CMTime,
        frameProperties: CFDictionaryRef,
        sourceFrameRefCon: *mut c_void,
        infoFlagsOut: *mut u32,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(
        session: VTCompressionSessionRef,
        completeUntilPresentationTimeStamp: CMTime,
    ) -> OSStatus;
    fn VTCompressionSessionGetPixelBufferPool(session: VTCompressionSessionRef) -> CVPixelBufferPoolRef;
    fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
    fn VTSessionSetProperty(session: VTSessionRef, propertyKey: CFStringRef, propertyValue: CFTypeRef) -> OSStatus;
    fn VTSessionCopyProperty(
        session: VTSessionRef,
        propertyKey: CFStringRef,
        allocator: CFAllocatorRef,
        propertyValueOut: *mut CFTypeRef,
    ) -> OSStatus;
}

/// `'avc1'`.
const kCMVideoCodecType_H264: u32 = 0x61766331;

// ---------------------------------------------------------------------------
// Piccoli aiuti CF
// ---------------------------------------------------------------------------

/// Un CFTypeRef che si rilascia da solo. Le dict/number qui sotto nascono a ogni
/// keyframe forzato: senza questo, una perdita per fotogramma.
struct CfOwned(CFTypeRef);

impl Drop for CfOwned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_i32(v: i32) -> CfOwned {
    let n = unsafe { CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &v as *const i32 as *const c_void) };
    CfOwned(n)
}

fn cf_f64(v: f64) -> CfOwned {
    let n = unsafe { CFNumberCreate(kCFAllocatorDefault, kCFNumberFloat64Type, &v as *const f64 as *const c_void) };
    CfOwned(n)
}

fn cf_dict(pairs: &[(CFStringRef, CFTypeRef)]) -> CfOwned {
    let keys: Vec<*const c_void> = pairs.iter().map(|(k, _)| *k).collect();
    let vals: Vec<*const c_void> = pairs.iter().map(|(_, v)| *v).collect();
    let d = unsafe {
        CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            vals.as_ptr(),
            pairs.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    };
    CfOwned(d)
}

// ---------------------------------------------------------------------------
// Il raccoglitore dei campioni compressi
// ---------------------------------------------------------------------------

/// Dove la callback di VideoToolbox deposita l'Annex-B del fotogramma appena
/// compresso. Una Mutex e non un canale perché il ciclo è uno-dentro-uno-fuori:
/// `encode()` chiama EncodeFrame e subito CompleteFrames, quindi quando torna il
/// campione è già qui.
struct Sink {
    out: Mutex<Vec<u8>>,
}

extern "C" fn output_cb(
    refcon: *mut c_void,
    _src: *mut c_void,
    status: OSStatus,
    _flags: u32,
    sbuf: CMSampleBufferRef,
) {
    if refcon.is_null() {
        return;
    }
    // Gira su un thread di VideoToolbox: un panic qui attraverserebbe il confine
    // FFI, che è UB. Niente unwrap, niente indicizzazione nuda.
    if status != 0 || sbuf.is_null() {
        if status != 0 {
            eprintln!("[vt] output status {status}");
        }
        return;
    }
    let sink = unsafe { &*(refcon as *const Sink) };
    let annexb = unsafe { sample_to_annexb(sbuf) };
    if let Ok(mut g) = sink.out.lock() {
        if let Some(bytes) = annexb {
            g.extend_from_slice(&bytes);
        }
    }
}

const START_CODE: [u8; 4] = [0, 0, 0, 1];

/// AVCC (prefisso di lunghezza) → Annex-B, con SPS/PPS re-iniettati davanti agli IDR.
unsafe fn sample_to_annexb(sbuf: CMSampleBufferRef) -> Option<Vec<u8>> {
    let bbuf = CMSampleBufferGetDataBuffer(sbuf);
    if bbuf.is_null() {
        return None;
    }
    let total = CMBlockBufferGetDataLength(bbuf);
    if total == 0 {
        return None;
    }
    let mut avcc = vec![0u8; total];
    if CMBlockBufferCopyDataBytes(bbuf, 0, total, avcc.as_mut_ptr() as *mut c_void) != 0 {
        return None;
    }

    // Lunghezza del prefisso NAL (di norma 4) letta dalla format description,
    // non data per scontata: è lei a dire come si legge il buffer qui sopra.
    let fmt = CMSampleBufferGetFormatDescription(sbuf);
    let mut nal_len_size: i32 = 4;
    let mut ps_count: usize = 0;
    if !fmt.is_null() {
        let mut p: *const u8 = std::ptr::null();
        let mut sz: usize = 0;
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fmt,
            0,
            &mut p,
            &mut sz,
            &mut ps_count,
            &mut nal_len_size,
        );
    }
    let nls = nal_len_size.clamp(1, 4) as usize;

    // Primo passaggio: c'è un IDR (nal_unit_type 5) in questo fotogramma?
    let mut has_idr = false;
    let mut i = 0usize;
    while i + nls <= avcc.len() {
        let mut len = 0usize;
        for k in 0..nls {
            len = (len << 8) | avcc[i + k] as usize;
        }
        i += nls;
        if len == 0 || i + len > avcc.len() {
            break;
        }
        if avcc[i] & 0x1F == 5 {
            has_idr = true;
        }
        i += len;
    }

    let mut out: Vec<u8> = Vec::with_capacity(total + 128);

    // SPS/PPS davanti a ogni IDR. VideoToolbox li tiene fuori dal flusso: se non
    // li si rimette, chi arriva dopo il primo fotogramma non ha i parametri e
    // resta nero — esattamente il caso "spettatore tardivo" che questo sidecar
    // deve reggere per contratto.
    if has_idr && !fmt.is_null() {
        for idx in 0..ps_count {
            let mut p: *const u8 = std::ptr::null();
            let mut sz: usize = 0;
            let mut cnt: usize = 0;
            let mut nls_out: i32 = 0;
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, idx, &mut p, &mut sz, &mut cnt, &mut nls_out) == 0
                && !p.is_null()
                && sz > 0
            {
                out.extend_from_slice(&START_CODE);
                out.extend_from_slice(std::slice::from_raw_parts(p, sz));
            }
        }
    }

    // Secondo passaggio: riscrivi i prefissi di lunghezza in start code.
    let mut i = 0usize;
    while i + nls <= avcc.len() {
        let mut len = 0usize;
        for k in 0..nls {
            len = (len << 8) | avcc[i + k] as usize;
        }
        i += nls;
        if len == 0 || i + len > avcc.len() {
            break;
        }
        out.extend_from_slice(&START_CODE);
        out.extend_from_slice(&avcc[i..i + len]);
        i += len;
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// L'encoder
// ---------------------------------------------------------------------------

pub struct VtEncoder {
    session: VTCompressionSessionRef,
    sink: Box<Sink>,
    width: usize,
    height: usize,
    pts: i64,
    /// Vero se il SoC sta davvero comprimendo in hardware. Non è cosmesi: se
    /// VideoToolbox è caduto sul suo encoder software, la spesa CPU torna quella
    /// di prima e il punto 5 non è stato fatto — meglio saperlo dal log.
    pub hardware: bool,
}

// La sessione VT è thread-safe per Apple, e comunque qui vive tutta dentro il
// thread encoder: serve solo a poterla tenere in una struct spostata al thread.
unsafe impl Send for VtEncoder {}

impl VtEncoder {
    pub fn new(width: usize, height: usize, fps: f64, bitrate: i32) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(anyhow!("dimensioni nulle"));
        }
        let sink = Box::new(Sink { out: Mutex::new(Vec::new()) });
        let refcon = &*sink as *const Sink as *mut c_void;

        unsafe {
            // Chiediamo l'hardware (Enable, non Require): se il SoC non lo ha, la
            // sessione nasce lo stesso in software e chi chiama decide — qui
            // `encode.rs` preferisce comunque VT a openh264 solo se `hardware`.
            let spec = cf_dict(&[(
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
                kCFBooleanTrue,
            )]);

            let fmt = cf_i32(kCVPixelFormatType_32BGRA as i32);
            let w_num = cf_i32(width as i32);
            let h_num = cf_i32(height as i32);
            let empty = cf_dict(&[]);
            let src_attrs = cf_dict(&[
                (kCVPixelBufferPixelFormatTypeKey, fmt.0),
                (kCVPixelBufferWidthKey, w_num.0),
                (kCVPixelBufferHeightKey, h_num.0),
                // IOSurface: è ciò che rende il buffer condivisibile con l'encoder
                // del SoC senza ricopiarlo.
                (kCVPixelBufferIOSurfacePropertiesKey, empty.0),
            ]);

            let mut session: VTCompressionSessionRef = std::ptr::null_mut();
            let st = VTCompressionSessionCreate(
                kCFAllocatorDefault,
                width as i32,
                height as i32,
                kCMVideoCodecType_H264,
                spec.0,
                src_attrs.0,
                std::ptr::null(),
                Some(output_cb),
                refcon,
                &mut session,
            );
            if st != 0 || session.is_null() {
                return Err(anyhow!("VTCompressionSessionCreate: OSStatus {st}"));
            }

            // Latenza prima di tutto: realtime, niente riordino (niente B-frame),
            // baseline — lo stesso profilo che webrtc-rs annuncia di default nella
            // sua H264 (profile-level-id=42001f), quindi niente sorprese al peer.
            let _ = VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
            let _ = VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
            let _ = VTSessionSetProperty(
                session,
                kVTCompressionPropertyKey_ProfileLevel,
                kVTProfileLevel_H264_Baseline_AutoLevel,
            );
            let br = cf_i32(bitrate);
            let _ = VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, br.0);
            let efr = cf_f64(fps);
            let _ = VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, efr.0);
            // Rete di sicurezza: gli IDR li guida `encode.rs` a orologio, questo è
            // solo un tetto perché una sessione lunghissima non resti senza.
            let kfi = cf_i32(240);
            let _ = VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, kfi.0);
            let _ = VTCompressionSessionPrepareToEncodeFrames(session);

            let mut hw_val: CFTypeRef = std::ptr::null();
            let hardware = VTSessionCopyProperty(
                session,
                kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                kCFAllocatorDefault,
                &mut hw_val,
            ) == 0
                && !hw_val.is_null()
                && {
                    let v = CFBooleanGetValue(hw_val) != 0;
                    CFRelease(hw_val);
                    v
                };

            Ok(Self { session, sink, width, height, pts: 0, hardware })
        }
    }

    /// Comprime un fotogramma RGB (3 byte/pixel, `width*height*3`) e restituisce
    /// l'Annex-B. `force_idr` chiede un keyframe su QUESTO fotogramma.
    pub fn encode(&mut self, rgb: &[u8], force_idr: bool) -> Result<Vec<u8>> {
        if rgb.len() < self.width * self.height * 3 {
            return Err(anyhow!("frame troppo corto"));
        }
        unsafe {
            let pb = self.make_pixel_buffer()?;
            // Da qui in poi ogni uscita deve rilasciare `pb`.
            let filled = self.fill_bgra(pb, rgb);
            if let Err(e) = filled {
                CVPixelBufferRelease(pb);
                return Err(e);
            }

            if let Ok(mut g) = self.sink.out.lock() {
                g.clear();
            }

            let props = if force_idr {
                Some(cf_dict(&[(kVTEncodeFrameOptionKey_ForceKeyFrame, kCFBooleanTrue)]))
            } else {
                None
            };
            self.pts += (1000.0 / 30.0) as i64;
            let st = VTCompressionSessionEncodeFrame(
                self.session,
                pb,
                cm_time(self.pts, 1000),
                cm_time(33, 1000),
                props.as_ref().map(|p| p.0).unwrap_or(std::ptr::null()),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            CVPixelBufferRelease(pb);
            if st != 0 {
                return Err(anyhow!("VTCompressionSessionEncodeFrame: OSStatus {st}"));
            }
            // Uno-dentro-uno-fuori: si aspetta il campione di QUESTO fotogramma
            // invece di lasciarlo in coda. È ciò che tiene la latenza bassa e il
            // resto del file identico a com'era con openh264.
            let st = VTCompressionSessionCompleteFrames(self.session, CM_TIME_INVALID);
            if st != 0 {
                return Err(anyhow!("VTCompressionSessionCompleteFrames: OSStatus {st}"));
            }
        }
        let data = self.sink.out.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
        Ok(data)
    }

    unsafe fn make_pixel_buffer(&self) -> Result<CVPixelBufferRef> {
        let mut pb: CVPixelBufferRef = std::ptr::null_mut();
        let pool = VTCompressionSessionGetPixelBufferPool(self.session);
        if !pool.is_null() && CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &mut pb) == 0 && !pb.is_null()
        {
            return Ok(pb);
        }
        // Nessun pool (succede se la sessione non è ancora "prepared"): buffer a mano.
        let empty = cf_dict(&[]);
        let attrs = cf_dict(&[(kCVPixelBufferIOSurfacePropertiesKey, empty.0)]);
        let r = CVPixelBufferCreate(
            kCFAllocatorDefault,
            self.width,
            self.height,
            kCVPixelFormatType_32BGRA,
            attrs.0,
            &mut pb,
        );
        if r != 0 || pb.is_null() {
            return Err(anyhow!("CVPixelBufferCreate: {r}"));
        }
        Ok(pb)
    }

    /// RGB → BGRA dentro il CVPixelBuffer, riga per riga: `bytesPerRow` può
    /// essere più largo di `width*4` (allineamento), quindi non si copia in blocco.
    unsafe fn fill_bgra(&self, pb: CVPixelBufferRef, rgb: &[u8]) -> Result<()> {
        if CVPixelBufferLockBaseAddress(pb, 0) != 0 {
            return Err(anyhow!("CVPixelBufferLockBaseAddress"));
        }
        let base = CVPixelBufferGetBaseAddress(pb) as *mut u8;
        if base.is_null() {
            CVPixelBufferUnlockBaseAddress(pb, 0);
            return Err(anyhow!("CVPixelBuffer senza base address"));
        }
        let stride = CVPixelBufferGetBytesPerRow(pb);
        for y in 0..self.height {
            let src = &rgb[y * self.width * 3..];
            let dst = base.add(y * stride);
            for x in 0..self.width {
                let s = x * 3;
                let d = dst.add(x * 4);
                *d = src[s + 2]; // B
                *d.add(1) = src[s + 1]; // G
                *d.add(2) = src[s]; // R
                *d.add(3) = 255; // A
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, 0);
        Ok(())
    }
}

impl Drop for VtEncoder {
    fn drop(&mut self) {
        unsafe {
            if !self.session.is_null() {
                // Prima si svuota la pipeline, poi si invalida: invalidare con
                // fotogrammi in volo lascerebbe la callback a scrivere dentro un
                // `Sink` che stiamo per liberare.
                let _ = VTCompressionSessionCompleteFrames(self.session, CM_TIME_INVALID);
                VTCompressionSessionInvalidate(self.session);
                CFRelease(self.session as CFTypeRef);
                self.session = std::ptr::null_mut();
            }
        }
    }
}
