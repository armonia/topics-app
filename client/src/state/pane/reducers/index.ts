/**
 * Solo `paneReducer` passa di qui (store.ts). Gli altri reducer e i helper
 * degli Spazi si importano dal loro modulo — è già quello che fanno tutti i
 * chiamanti: `./groups`, `./undo`, `./spaces`. Un barrel che ri-esporta cose
 * che nessuno prende da qui non è un'interfaccia, è un secondo posto da tenere
 * allineato.
 */
export { paneReducer } from './panes';
