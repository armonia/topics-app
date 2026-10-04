# Notifications: il permesso di sistema passa nel livello Notifiche del menu utente

## MODIFIED Requirements

### Requirement: NOTIF-PERM-01 — Il permesso di sistema si legge E si concede da dentro l'app

Il livello Notifiche del menu utente (USERMENU-03), che prende il posto della
voce Notifiche del pannello Impostazioni, SHALL dire lo stato vero della catena
dei banner nativi e SHALL offrire l'azione che quello stato consente. Uno stato
in sola lettura lascia la persona davanti a una diagnosi senza porta: «non
arrivano», e poi?

L'azione dipende dallo stato, e non SHALL essercene una che non fa niente:

- non ancora deciso: SHALL chiedere il permesso al sistema;
- negato: macOS non ripropone il prompt, quindi SHALL aprire il pannello
  Impostazioni di Sistema → Notifiche;
- concesso, fuori dal bundle .app, o fuori da macOS: nessun tasto, perche' non
  c'e' niente che un tasto possa cambiare.

Dopo l'azione il livello SHALL rileggere lo stato: seguire il consiglio e
vedere la stessa diagnosi di prima e' indistinguibile dal non aver fatto nulla.

#### Scenario: permesso mai chiesto
- **WHEN** lo stato e' «non ancora deciso»
- **THEN** il tasto SHALL chiedere il permesso al sistema

#### Scenario: permesso negato
- **WHEN** lo stato e' «negato»
- **THEN** il tasto SHALL portare al pannello di sistema, non a un secondo prompt che non comparira'

#### Scenario: niente da fare
- **WHEN** il permesso e' concesso, o l'app non gira da un bundle, o non e' macOS
- **THEN** NON SHALL comparire nessun tasto

#### Scenario: la casa del permesso
- **WHEN** apro il menu utente sul livello Notifiche
- **THEN** lo stato del permesso e il suo tasto sono lì
- **AND** il pannello Impostazioni non ha una voce Notifiche
