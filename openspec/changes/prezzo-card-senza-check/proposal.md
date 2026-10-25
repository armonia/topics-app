# Proposal: prezzo memoria delle card senza check

## GOAL

Ammettere una card senza check pre-review quando la memoria disponibile copre il
solo agente, usando la configurazione `review_checks` già letta dal gate.

## FUORI

Prezzo delle card con check, tetto per risorse, soglie generali da 6 e 10 GB,
configurazione dei check e comportamento del gate di delivery.

## BARRA

Con swap pieno e 4,8 GB liberi, una board con card senza check passa quando un
agente di un'altra board aspetta la CI; la stessa lettura trattiene la card con
check con motivo «pavimento». Un mutante che usa il prezzo mediano vecchio per
la card senza check fa fallire la barra.

## PROVA

`OFFLOAD=local taskpolicy -b bun test server/services/task-dispatcher-admission.test.ts`
deve uscire 0; con il mutante, lo stesso comando deve uscire non zero.

## TRACCE

- Prezzo del candidato derivato da `board_settings.review_checks` e dal minimo
  `AGENT_COST_FLOOR_MEM_GB` quando non ci sono check.
- Test del dispatcher per la board leggera e per quella con check, coperto da
  KANBAN-75.
- Contratto aggiornato in KANBAN-75; tetto per risorse invariato.
