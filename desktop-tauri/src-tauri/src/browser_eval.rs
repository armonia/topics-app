//! Semantica condivisa di `browser_eval_js` per i motori non-Apple.
//!
//! WebView2 e WebKitGTK hanno due API diverse per eseguire JS, ma lo stesso paio
//! di problemi rispetto a WKWebView, ed e piu sicuro risolverli una volta sola
//! qui che due volte nei backend.
//!
//! **1. Le promise non vengono attese.** Su macOS il comando usa
//! `callAsyncJavaScript:`, che tratta la stringa come corpo di funzione async e
//! ASPETTA la promise restituita. Ne `ICoreWebView2::ExecuteScript` ne
//! `webkit_web_view_evaluate_javascript` lo fanno: a entrambe una promise torna
//! come oggetto vuoto, quindi ogni op che passa una IIFE async avrebbe ricevuto
//! `{}` invece del risultato. E non un errore, il che e peggio. Il wrapper qui
//! sotto guarda se il valore e un thenable: se non lo e (il caso di gran lunga
//! piu comune, tutti i `JSON.stringify(...)` di `tauriBrowserOps.ts`) risponde
//! in UN giro; se lo e, parcheggia la promise in uno slot globale con un token e
//! il chiamante ripassa a ritirare.
//!
//! **2. La forma del risultato.** macOS restituisce la `description` ObjC del
//! valore, quindi una stringa JS torna GREZZA e il client ci fa `JSON.parse`
//! sopra. `ExecuteScript` invece restituisce JSON, cioe la stessa stringa
//! DOPPIAMENTE codificata. Uniformiamo dentro il JS (`enc`): stringa → grezza,
//! qualsiasi altro valore → `JSON.stringify`. Cosi i backend non devono sapere
//! niente della semantica e il client non cambia di una riga.
//!
//! **Perche questo modulo si compila anche su macOS, dove non serve a nessuno:**
//! e l'unico pezzo del porting fatto di logica pura invece che di chiamate al
//! motore, quindi e l'unico che si puo davvero PROVARE su questa macchina. Se lo
//! chiudessimo dentro un `cfg(not(macos))` i suoi test non girerebbero mai qui,
//! e la trappola del doppio incapsulamento resterebbe una convinzione invece di
//! un test verde. E quella che romperebbe ogni `JSON.parse` del client su
//! Windows. Da cui l'`allow(dead_code)`: su macOS e codice non chiamato di
//! proposito, non un residuo.
#![allow(dead_code)]

/// Esito di un giro di valutazione.
pub enum EvalStep {
    /// Valore pronto, gia normalizzato alla semantica macOS.
    Done(String),
    /// La pagina ha lanciato: messaggio d'errore.
    Failed(String),
    /// Il valore era una promise: e parcheggiata sotto questo token, si ripassa.
    Pending(String),
}

/// Il preambolo che avvolge l'espressione dell'utente.
///
/// Nota sul `return` finale: lo script termina con `JSON.stringify(payload)`,
/// cioe produce SEMPRE una stringa. E deliberato, ed e cio che rende i due
/// backend simmetrici: WebView2 la ri-codifichera in JSON (un livello da
/// scartare, lato Rust), mentre JavaScriptCore la restituisce tale e quale. In
/// entrambi i casi quello che arriva al parser e lo stesso testo JSON.
pub fn wrap_expression(js: &str, token: &str) -> String {
    format!(
        r#"(function(){{
  var enc = function(v){{ return typeof v === 'string' ? v : JSON.stringify(v); }};
  var out;
  try {{
    var v = ({js});
    if (v && typeof v.then === 'function') {{
      var slots = (window.__topicsEvalSlots = window.__topicsEvalSlots || {{}});
      var k = {token};
      slots[k] = {{ s: 0 }};
      v.then(
        function(x){{ slots[k] = {{ s: 1, v: enc(x) }}; }},
        function(e){{ slots[k] = {{ s: 2, v: String(e) }}; }}
      );
      out = {{ s: 3, v: k }};
    }} else {{
      out = {{ s: 1, v: enc(v) }};
    }}
  }} catch (e) {{
    out = {{ s: 2, v: String(e) }};
  }}
  return JSON.stringify(out);
}})()"#,
        js = js,
        token = serde_json::to_string(token).unwrap_or_else(|_| "\"t\"".into()),
    )
}

/// Lo script che ritira una promise parcheggiata. Risponde `{"s":0}` finche non
/// e risolta; quando lo e, libera lo slot (altrimenti una pagina di lunga durata
/// accumulerebbe token a ogni eval async).
pub fn wrap_poll(token: &str) -> String {
    format!(
        r#"(function(){{
  var slots = window.__topicsEvalSlots || {{}};
  var k = {token};
  var r = slots[k];
  if (!r || r.s === 0) return JSON.stringify({{ s: 0 }});
  delete slots[k];
  return JSON.stringify(r);
}})()"#,
        token = serde_json::to_string(token).unwrap_or_else(|_| "\"t\"".into()),
    )
}

/// Traduce il testo JSON prodotto dai due wrapper in un [`EvalStep`].
///
/// `s` sta per stato: 0 = ancora in volo, 1 = valore, 2 = eccezione, 3 = promise
/// parcheggiata sotto il token in `v`.
pub fn parse_payload(json: &str) -> Result<Option<EvalStep>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("eval payload illeggibile: {e}"))?;
    let s = v.get("s").and_then(|s| s.as_i64()).unwrap_or(-1);
    let payload = v.get("v").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match s {
        0 => Ok(None),
        1 => Ok(Some(EvalStep::Done(payload))),
        2 => Ok(Some(EvalStep::Failed(payload))),
        3 => Ok(Some(EvalStep::Pending(payload))),
        _ => Err(format!("eval payload senza stato: {json}")),
    }
}

/// Un token per identificare lo slot di una promise. Non serve che sia
/// imprevedibile, solo che due eval sovrapposti sulla stessa pagina non si
/// pestino i piedi: contatore di processo piu il nanosecondo.
pub fn next_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("e{n}_{t}")
}

/// WebView2 restituisce il risultato come JSON, quindi la stringa prodotta dal
/// wrapper arriva con un livello di codifica in piu. Se il testo e un JSON
/// string lo si scarta, altrimenti lo si prende com'e. Cosi la stessa funzione
/// va bene anche per JavaScriptCore, che quel livello non lo aggiunge.
pub fn strip_json_string_layer(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('"') {
        if let Ok(inner) = serde_json::from_str::<String>(t) {
            return inner;
        }
    }
    raw.to_string()
}

/// PNG grezzo → base64, per la data-URL che restituisce `browser_screenshot`.
///
/// Su macOS lo fa `NSData base64EncodedStringWithOptions:`; gli altri due
/// backend non hanno niente di equivalente sottomano, e questo evita di tirarsi
/// dentro una dipendenza per venti righe di alfabeto standard.
pub fn base64_png(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        // Il riempimento non e decorativo: senza, un'immagine la cui lunghezza
        // non e multipla di 3 si decodifica troncata dall'altra parte.
        out.push(if chunk.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valore_sincrono_e_pronto_subito() {
        match parse_payload(r#"{"s":1,"v":"ciao"}"#).unwrap() {
            Some(EvalStep::Done(v)) => assert_eq!(v, "ciao"),
            _ => panic!("atteso Done"),
        }
    }

    #[test]
    fn eccezione_diventa_failed() {
        match parse_payload(r#"{"s":2,"v":"TypeError: x"}"#).unwrap() {
            Some(EvalStep::Failed(v)) => assert_eq!(v, "TypeError: x"),
            _ => panic!("atteso Failed"),
        }
    }

    #[test]
    fn promise_parcheggiata_torna_il_token() {
        match parse_payload(r#"{"s":3,"v":"e1_22"}"#).unwrap() {
            Some(EvalStep::Pending(k)) => assert_eq!(k, "e1_22"),
            _ => panic!("atteso Pending"),
        }
    }

    #[test]
    fn stato_zero_significa_ancora_in_volo() {
        assert!(parse_payload(r#"{"s":0}"#).unwrap().is_none());
    }

    // Il livello di codifica in piu di WebView2 e il punto dove la parita con
    // macOS si rompe per davvero: senza questo scarto ogni JSON.parse del client
    // riceverebbe una stringa citata e fallirebbe.
    #[test]
    fn scarta_il_doppio_incapsulamento_di_webview2() {
        let json_prodotto = r#"{"s":1,"v":"x"}"#;
        let come_lo_rende_webview2 = serde_json::to_string(json_prodotto).unwrap();
        assert_eq!(
            strip_json_string_layer(&come_lo_rende_webview2),
            json_prodotto
        );
    }

    #[test]
    fn javascriptcore_non_ha_livelli_da_scartare() {
        let json_prodotto = r#"{"s":1,"v":"x"}"#;
        assert_eq!(strip_json_string_layer(json_prodotto), json_prodotto);
    }

    #[test]
    fn il_token_finisce_nello_script_citato_correttamente() {
        let s = wrap_expression("1+1", "e1_2");
        assert!(s.contains("\"e1_2\""));
        assert!(s.contains("1+1"));
        assert!(wrap_poll("e1_2").contains("\"e1_2\""));
    }

    #[test]
    fn token_consecutivi_sono_distinti() {
        assert_ne!(next_token(), next_token());
    }

    // I tre vettori canonici di RFC 4648: coprono i due casi di riempimento,
    // che sono l'unico punto dove un base64 scritto a mano sbaglia.
    #[test]
    fn base64_riempie_come_da_rfc() {
        assert_eq!(base64_png(b"f"), "Zg==");
        assert_eq!(base64_png(b"fo"), "Zm8=");
        assert_eq!(base64_png(b"foo"), "Zm9v");
        assert_eq!(base64_png(b""), "");
    }

    // La firma di un PNG contiene byte alti e non stampabili: e li che un
    // encoder che tratta i byte come `char` invece che come numeri si tradisce.
    #[test]
    fn base64_regge_i_byte_non_ascii() {
        assert_eq!(base64_png(&[0x89, 0x50, 0x4E, 0x47]), "iVBORw==");
        assert_eq!(base64_png(&[0xFF, 0xFF, 0xFF]), "////");
    }
}
