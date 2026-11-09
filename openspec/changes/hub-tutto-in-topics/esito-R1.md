# Hub in Topics, traccia R1: esito

Il codice del servizio non sta in questo repo (decisione della change): vive nel repo dell'hub, crate `tools/usage-hub/rust/hub-service`, ramo `topics/r1-servizio-rust`, commit `1cc2ad47`.

- `cargo test`: verde.
- `golden-diff --old live --new <porta>`: 39 endpoint mancanti (501) e `/health` diverso, exit 1.
- `footprint-bar`: 2,0 MB a vuoto, limite 20 MB, exit 0.
- Il binario rifiuta le porte vive 3336, 3335 e 3360 fino a C1.
- Nuove fotografie di `:3336`: `/health`, `count_tokens`, `/v1/messages`.

Card: 2273439b-c0a9-4113-9d66-ad117b7d8975.
