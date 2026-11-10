# Confronto contabilità e fatture: open source vs suite unica

Card 7ce15e25. Area: contabilità e fatture per la società (fatturazione elettronica SdI, prima nota, IVA, riconciliazione bancaria). Nessun acquisto, nessun account creato: tutto da pagine pubbliche lette il giorno della stesura.

Legenda: **[V]** verificato sulla fonte linkata; **[NV]** non verificato (pagina dinamica o fonte non raggiungibile): da controllare prima di decidere. Nessuna cifra è stimata senza dirlo.

## Raccomandazione

**Per un'azienda piccola con commercialista esterno: restare su una suite unica italiana (Fatture in Cloud come riferimento, Danea Easyfatt come alternativa desktop).** Il motivo: l'SdI, l'IVA e lo scambio col commercialista sono lì già pronti e a carico del fornitore. Tra gli open source solo Odoo ha un'integrazione SdI documentata e mantenuta; chi self-hosta, però, si prende anche aggiornamenti normativi, backup e responsabilità fiscale, e il risparmio sulla licenza è piccolo rispetto a quel tempo.

**Se si vuole open source:** Odoo con i moduli italiani OCA (`l10n-italy`) è l'unica opzione credibile. Dolibarr è valido per fatturazione semplice ma senza SdI nativo verificato. ERPNext e Akaunting non sono adatti all'Italia senza sviluppo.

## Tabella

| Soluzione | Licenza / modello | SdI nativo | Costo reale annuo | Self-host vs cloud gratis | Export per commercialista |
|---|---|---|---|---|---|
| **Fatture in Cloud** (riferimento, suite unica, TeamSystem) | Proprietario, solo cloud [V: [home](https://www.fattureincloud.it/)] | Sì, fatturazione elettronica integrata [V: [funzioni](https://www.fattureincloud.it/software-fatturazione/fatturazione-elettronica-privati/)] | Prezzi non leggibili da fuori (pagina dinamica) [NV: vedi [prezzi sul sito](https://www.fattureincloud.it/)] | Solo cloud; esiste una prova gratuita [V: [pagina commercialista](https://www.fattureincloud.it/software-fatturazione/commercialista-connesso/)] | Il commercialista accede direttamente all'account e gestisce fatture e F24 [V: [commercialista connesso](https://www.fattureincloud.it/software-fatturazione/commercialista-connesso/)]. Prima nota inclusa [V: [prima nota](https://www.fattureincloud.it/software-fatturazione/prima-nota/)] |
| **Danea Easyfatt** (riferimento, desktop + cloud) | Proprietario [V: [prezzi](https://www.danea.it/software/easyfatt/prezzi/)] | Sì, "Fatturazione Elettronica" nella licenza [V: [prezzi](https://www.danea.it/software/easyfatt/prezzi/)] | Cloud da 4 € al mese + IVA, pagati annualmente, cioè da 48 € + IVA l'anno, più 1,00 € (carta/PayPal) o 2,50 € (bonifico) di gestione; è l'offerta del primo anno [V: [prezzi](https://www.danea.it/software/easyfatt/prezzi/)]. Anni successivi [NV] | Licenza 12 mesi monoutente; versione PC/Windows e cloud [V] | Scambio dati col commercialista; contabilità in partita doppia solo con versioni Professional o superiori [V: [prezzi](https://www.danea.it/software/easyfatt/prezzi/)] |
| **Odoo Community + l10n_it** | LGPL (Community), moduli OCA AGPL [V: [OCA README](https://raw.githubusercontent.com/OCA/l10n-italy/16.0/README.md)] | Localizzazione ufficiale `l10n_it`, `l10n_it_edi` (FatturaPA) [V: [docs Italia](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/italy.html)]. Il canale passa dai server Odoo (codice destinatario di Odoo da registrare sul portale AdE) [V: stessa fonte]. Se funzioni anche con la Community self-hosted: [NV] | Licenza Community 0 €. Odoo Online: un'app gratis, oppure Standard 11 € / utente / mese pagato annualmente (14,90 € su base mensile in listino) [V: [pricing](https://www.odoo.com/pricing)]. Self-host: costo della VM e di manutenzione [NV, dipende dal fornitore] | Self-host gratuito (software) o Odoo Online con un'app gratis [V: [pricing](https://www.odoo.com/pricing)] | Moduli OCA per SdI, IVA a periodo, RiBa, split payment, inversione contabile [V: [OCA README](https://raw.githubusercontent.com/OCA/l10n-italy/16.0/README.md)]; tipi di esenzione IVA (Natura) previsti [V: docs Italia]. Riconciliazione bancaria presente [V: [docs](https://www.odoo.com/documentation/17.0/applications/finance/accounting/bank/reconciliation.html)] |
| **Dolibarr** | GPL-3+, open source [V: [README](https://raw.githubusercontent.com/Dolibarr/dolibarr/develop/README.md)] | Nessuna localizzazione SdI trovata nel core o nel wiki ufficiale (la pagina wiki italiana non esiste [V: [wiki](https://wiki.dolibarr.org/index.php/Module_Italian_Localization)]). Esistono moduli di terzi sul marketplace [NV] | Software 0 €; hosting a carico tuo [NV] | Self-host o cloud di partner [V: README] | Esportazioni standard; formato per commercialista italiano [NV] |
| **ERPNext** | Open source [V: [pricing](https://frappe.io/erpnext/pricing)] | Esiste una cartella `regional/italy` nel repo [V: [repo](https://github.com/frappe/erpnext/tree/develop/erpnext/regional/italy)] e una pagina "Requirements for Italy" [V: [docs](https://docs.erpnext.com/docs/user/manual/en/regional)]. Copertura reale dell'SdI [NV] | Software gratis; Frappe Cloud da 5 $ al mese (sito singolo), VM da 20 $ al mese [V: [pricing](https://frappe.io/erpnext/pricing)]; più implementazione | Self-host o Frappe Cloud, non gratis [V: pricing] | [NV] |
| **Akaunting** | Open source, core gratis self-host [V: [plans](https://akaunting.com/plans)] | Nessuna fatturazione SdI trovata sul sito [NV] | Cloud Standard 8 $ al mese su base annua (12 $ mensile), 1 utente + 1 commercialista, 1.000 fatture [V: [plans](https://akaunting.com/plans)]. Piani cloud non valgono per il self-host [V: stessa pagina] | Self-host gratis, cloud a pagamento con prova [V] | Ha un ruolo "accountant" nel piano cloud [V]; formati italiani [NV] |

## Cosa è emerso

1. **Il vero discriminante è l'SdI.** Le suite italiane lo includono; Odoo lo offre tramite un proxy dei propri server (docs Italia). Per gli altri tre non c'è un SdI verificato.
2. **"Gratis" non esiste per la contabilità fiscale in Italia.** Il costo si sposta su hosting, aggiornamenti normativi (tracciati, esenzioni, nuovi schemi FatturaPA) e tempo di chi mantiene il sistema.
3. **Il commercialista pesa.** Fatture in Cloud ha l'accesso diretto per lui; con un open source auto-ospitato servirebbe dargli accesso o un export concordato.
4. **Alternativa low-cost già in tabella:** Easyfatt cloud parte da 48 € + IVA l'anno (primo anno).

## Punti da chiudere prima di decidere

- Prezzi attuali dei piani Fatture in Cloud (pagina dinamica, non leggibile qui): aprirla da browser.
- Se `l10n_it_edi` di Odoo funziona con la Community self-hosted o richiede Online/Enterprise.
- Prezzo Easyfatt dal secondo anno.
- Quale formato di export il commercialista preferisce (XML FatturaPA, CSV, prima nota).

Note: nessun dato personale o credenziale è stato usato; le pagine sono state lette il giorno della stesura, i prezzi possono cambiare.
