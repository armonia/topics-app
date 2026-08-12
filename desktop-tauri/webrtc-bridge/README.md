# webrtc-bridge — shared browser session over WebRTC (Rust sidecar)

Serves the server-side headless-Chromium **panes** (the same pages the JPEG-over-WS
viewers see) as **H.264 WebRTC tracks** so Mac and mobile can watch/control the **same
live session** at low bandwidth. Productionised from `spike/webrtc-cdp/` — no docker.

Pipeline (per CDP target): screencast JPEG → `zune-jpeg` → `openh264` I420/H.264 → **one
shared `TrackLocalStaticSample`** → webrtc-rs fan-out to every peer. The server
(`server/webrtc-bridge.ts`) spawns this binary and brokers SDP/ICE between the browser
client's `/ws/browser/:ctx` WebSocket and this process.

## Wire protocol — NDJSON over a Unix socket

The server connects to the socket the bridge binds (`--socket <path>`). One JSON per line:

```
server → bridge: {"t":"offer","peer":ID,"target":CDP_TARGET_ID,"sdp":OFFER}
                 {"t":"ice","peer":ID,"candidate":C,"sdpMid":M,"sdpMLineIndex":I}
                 {"t":"close","peer":ID}
bridge → server: {"t":"ready"}
                 {"t":"answer","peer":ID,"sdp":ANSWER}
                 {"t":"error","peer":ID,"message":M}
```

`peer` = one viewer (WS may carry many). `target` = the pane's CDP targetId
(`browserService.getTargetId(id)`). Peers sharing a `target` share one encoder+track;
the pipeline tears down when a target's last peer leaves.

## Run / test

```bash
cargo build --release                        # → target/release/webrtc-bridge
bun test-harness.mjs [viewers]               # needs Chromium CDP on :19222
```
`test-harness.mjs` reproduces the server's relay role (creates a real CDP target, brokers
NDJSON) and runs N Playwright viewers, asserting ALL decode H.264 simultaneously
(attach-to-target + fan-out). Verified: N=2 → both `ice=connected`, `fd=55`, `video/H264`.

## Design notes / gotchas (bought in the spike + here)

- **openh264 `Encoder` is `!Send`** → lives on a dedicated OS thread (`encode.rs`), never
  on the async runtime. Samples cross to an async writer via a channel.
- **Late joiner needs a keyframe**: `need_keyframe` is set when a peer attaches → the
  encoder forces an IDR next frame (plus a periodic IDR fallback). Production upgrade:
  wire RTCP-PLI for on-demand keyframes.
- **Static pages** emit exactly one CDP screencast frame then go silent (screencast is
  change-driven) → the encoder **keepalive re-encodes the last frame** every ~700ms so a
  peer that joins after that single frame still decodes.
- **ICE / mDNS**: mDNS is **Disabled** here (`daemon.rs`), and that is a liveness fix, not a
  reachability choice: with it on, webrtc-rs binds a UDP 5353 multicast socket per
  PeerConnection, the second peer fails to bind and its gathering never completes (the
  "every other connection times out" bug). Disabled, we advertise our REAL host IPs, so a
  viewer connects straight to a routable address; even a viewer offering only privacy
  `.local` candidates reaches us, and we learn its address peer-reflexively. A public STUN
  just stalls gathering on a LAN, so we stay host-only (`RTCConfiguration::default()`).
  **Crossing a strict NAT would need TURN, and deliberately has none**: on ICE failure the
  pane auto-falls back to DOM co-browse over the WebSocket, which travels through the relay
  tunnel. See `DECISIONE-turn-oltre-lan.md` next to this file.
  **Test caveat:** `chrome-headless-shell` / old-headless do NOT run the mDNS responder, so
  the default harness path launches the viewer with `--disable-features=WebRtcHideLocalIpsWithMdns`
  (raw host candidates) for a deterministic localhost check.
- **Attach, don't create**: `cdp.rs` attaches a flat CDP session to the pane's existing
  `targetId` and screencasts it as-is (no navigate / no device-metrics override) — that's
  what makes it the SAME session, sharing the page with the JPEG viewers.

Env: `TOPICS_CDP_PORT` (default 19222). Server picks this binary via
`TOPICS_WEBRTC_BRIDGE_BIN` (Tauri externalBin), same convention as `pty-bridge`.
