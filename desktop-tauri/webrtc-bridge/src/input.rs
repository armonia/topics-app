//! Traduce l'input della pane in comandi CDP, dentro il sidecar (punto 6 del piano).
//!
//! Il percorso che sostituisce: click/scroll/tasti partivano dal client come
//! messaggi `input` sul WebSocket `/ws/browser/:ctx`, arrivavano al server Bun, che
//! li girava a `browserService.dispatchInput` → Playwright → CDP → pagina. Quattro
//! salti e due processi per muovere un mouse, mentre i PIXEL della stessa pane
//! viaggiavano già su una PeerConnection diretta fra chi guarda e il sidecar.
//!
//! Qui l'input prende la stessa strada dei pixel: un DataChannel della STESSA
//! PeerConnection, e da lì dritto sulla sessione CDP che il sidecar ha già aperta
//! per lo screencast. Nessun processo in mezzo.
//!
//! Il formato sul canale è identico al messaggio `input` del WebSocket
//! (`{type:"input",action,payload}`), di proposito: il client ha un solo mittente
//! (`sendInput`) e cambia solo il tubo. Se il canale non è aperto si torna sul WS,
//! quindi il vecchio percorso resta la rete di sotto e non c'è niente da rompere.

use serde_json::{json, Value};

use crate::cdp::CdpInput;

/// Quanto vale un tasto speciale per CDP. `key`/`code`/`windowsVirtualKeyCode`
/// servono tutti e tre: senza il virtual key code le pagine che ascoltano
/// `keyCode` (ancora tante) non vedono niente, e senza `text` l'Invio non manda
/// i form.
fn special_key(key: &str) -> Option<(&'static str, i64, &'static str)> {
    // (code, windowsVirtualKeyCode, text)
    Some(match key {
        "Enter" => ("Enter", 13, "\r"),
        "Tab" => ("Tab", 9, "\t"),
        "Escape" => ("Escape", 27, ""),
        "Backspace" => ("Backspace", 8, ""),
        "Delete" => ("Delete", 46, ""),
        "ArrowUp" => ("ArrowUp", 38, ""),
        "ArrowDown" => ("ArrowDown", 40, ""),
        "ArrowLeft" => ("ArrowLeft", 37, ""),
        "ArrowRight" => ("ArrowRight", 39, ""),
        "Home" => ("Home", 36, ""),
        "End" => ("End", 35, ""),
        "PageUp" => ("PageUp", 33, ""),
        "PageDown" => ("PageDown", 34, ""),
        "F1" => ("F1", 112, ""),
        "F2" => ("F2", 113, ""),
        "F3" => ("F3", 114, ""),
        "F4" => ("F4", 115, ""),
        "F5" => ("F5", 116, ""),
        "F6" => ("F6", 117, ""),
        "F7" => ("F7", 118, ""),
        "F8" => ("F8", 119, ""),
        "F9" => ("F9", 120, ""),
        "F10" => ("F10", 121, ""),
        "F11" => ("F11", 122, ""),
        "F12" => ("F12", 123, ""),
        _ => return None,
    })
}

fn num(p: &Value, k: &str) -> f64 {
    p.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// Esegue un messaggio `input` sulla sessione CDP del target.
/// Torna `false` se il messaggio non era comprensibile o non c'è sessione viva.
pub fn dispatch(cdp: &CdpInput, msg: &Value) -> bool {
    let action = msg.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let p = msg.get("payload").cloned().unwrap_or(Value::Null);
    let (x, y) = (num(&p, "x"), num(&p, "y"));
    let button = p.get("button").and_then(|v| v.as_str()).unwrap_or("left");

    match action {
        "click" => {
            // move → press → release, che è quel che fa `page.mouse.click` di
            // Playwright: il move prima del press non è decorativo, senza di esso
            // i menu che aprono su hover non si comportano come col mouse vero.
            cdp.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }));
            cdp.send("Input.dispatchMouseEvent", json!({
                "type": "mousePressed", "x": x, "y": y, "button": button, "clickCount": 1, "buttons": 1
            }));
            cdp.send("Input.dispatchMouseEvent", json!({
                "type": "mouseReleased", "x": x, "y": y, "button": button, "clickCount": 1, "buttons": 0
            }))
        }
        "mousemove" => cdp.send(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }),
        ),
        "scroll" => {
            cdp.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }));
            cdp.send("Input.dispatchMouseEvent", json!({
                "type": "mouseWheel", "x": x, "y": y,
                "deltaX": num(&p, "deltaX"), "deltaY": num(&p, "deltaY")
            }))
        }
        "type" => {
            let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return false;
            }
            let mut ok = false;
            for ch in text.chars() {
                let s = ch.to_string();
                // keyDown con `text` + keyUp: è la coppia che genera
                // keydown/keypress/input/keyup. `Input.insertText` sarebbe un
                // messaggio solo, ma salta gli eventi di tastiera e le pagine che
                // filtrano i tasti mentre si scrive (ricerche, campi mascherati)
                // si comportano diversamente da come si comportavano col WS.
                ok |= cdp.send("Input.dispatchKeyEvent", json!({
                    "type": "keyDown", "text": s, "unmodifiedText": s, "key": s
                }));
                cdp.send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": s }));
            }
            ok
        }
        "keypress" => {
            let key = p.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let Some((code, vk, text)) = special_key(key) else {
                return false;
            };
            let mut down = json!({
                "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" },
                "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk
            });
            if !text.is_empty() {
                down["text"] = json!(text);
                down["unmodifiedText"] = json!(text);
            }
            let ok = cdp.send("Input.dispatchKeyEvent", down);
            cdp.send("Input.dispatchKeyEvent", json!({
                "type": "keyUp", "key": key, "code": code,
                "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk
            }));
            ok
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasti_speciali_hanno_il_virtual_key_code() {
        // L'Invio senza `text` non manda i form: è il caso che si rompe in silenzio.
        assert_eq!(special_key("Enter"), Some(("Enter", 13, "\r")));
        assert_eq!(special_key("ArrowDown"), Some(("ArrowDown", 40, "")));
        assert!(special_key("a").is_none(), "i caratteri normali passano da 'type', non da 'keypress'");
    }
}
