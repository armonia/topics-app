# Tracce — native-host-dom-sync

- T1 server relay: registro host per contesto, buffer dom, broadcast, bootstrap tardivo,
  risorse senza Chromium. Barra: `bun test server/lib/native-dom-host.test.ts`.
- T2 host nel client Tauri: inietta rrweb, drena eventi, li manda; esegue `host_input`.
  Barra: `bun test client/src/lib/nativeDomHost.test.ts`.
- T3 auto-share: la pane host non passa più alla sessione condivisa (dipende da T1, T2).
  Barra: `bun test client/src/lib/sharedAuto.test.ts`.
- T4 e2e host finto + spettatore web, e misura sul Mac vero (dipende da T1-T3).
