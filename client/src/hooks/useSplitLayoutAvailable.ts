import { useLayoutMobile } from './useMobile';

/**
 * «Un comando compare dove ha effetto.»
 *
 * Questa è la risposta UNICA alla domanda «su questo schermo i pannelli si
 * possono affiancare?», e da lì dipendono tutti i comandi che agiscono sugli
 * split: «Dividi a destra», «Dividi in basso», «Reimposta pannelli», «Disponi
 * automaticamente».
 *
 * IL FATTO MISURATO, non un'opinione: sotto i 768px `PanelGrid` non disegna
 * affatto l'albero degli split. Il suo ramo mobile rende una `flex-col` di
 * celle, salta i divisori (`colIdx < … && !isMobile`), salta le zone di
 * rilascio del drag e forza `flex: 1 1 0%` su ogni cella — cioè le larghezze
 * salvate non vengono nemmeno lette. `GroupLayout` fa lo stesso al suo livello.
 * Su un telefono quei quattro comandi non falliscono: non fanno NIENTE, e un
 * comando che non fa niente in un menu è rumore che fa sembrare complicato un
 * sistema che non lo è.
 *
 * Perché non si mostrano GRIGI: un comando disabilitato dice «qui potresti, ma
 * ora non puoi» e invita a cercare la condizione che lo sblocca. Qui la
 * condizione è lo schermo, e non c'è niente da sbloccare.
 *
 * DOVE LA REGOLA SI FERMA, perché non vale per tutto ciò che sta in un
 * pannello di impostazioni. Questi quattro sono COMANDI: si premono e agiscono
 * subito, su questa finestra. Una PREFERENZA memorizzata è un'altra cosa —
 * «larghezza della colonna di chat» a 390px non muove nulla ORA, ma è un valore
 * che vive nell'account e che si vede sul portatile, quindi nasconderla dal
 * telefono toglierebbe la possibilità di regolare l'altro schermo da qui. La
 * riga è quella: un'AZIONE senza effetto è rumore, un VALORE senza effetto qui
 * è una preferenza che ce l'ha altrove.
 *
 * Perché una domanda di LARGHEZZA e non di dito: quante colonne stanno sullo
 * schermo è la stessa soglia (768px) che `PanelGrid` e `GroupLayout` usano per
 * scegliere il loro ramo. Un iPad col dito affianca i pannelli benissimo; un
 * telefono col mouse collegato no.
 *
 * THIS PARAGRAPH USED TO SAY «the same 768px threshold» while calling
 * `useMobile().isMobile`, which is `<768 || (touch && <1024)`. On an iPad in
 * portrait (834x1194) `PanelGrid` mounted the split tree with its dividers and
 * this hook answered «no splits here»: the three commands that govern them
 * vanished from the tab menu and from the Topics menu, which hands the palette
 * `undefined` and takes away the last way in. The splits existed and no command
 * could reach them. Now the sentence and the call agree: `useLayoutMobile`.
 */
export function useSplitLayoutAvailable(): boolean {
  return !useLayoutMobile();
}
