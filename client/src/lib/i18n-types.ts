/**
 * The one shape both catalogues share, in a module neither of them imports the
 * other through.
 *
 * It exists so `i18n-en.ts` can be a leaf: the English catalogue is loaded
 * lazily, and if it imported its type from `i18n.ts` the bundler would put the
 * two back in one chunk and the split would buy nothing.
 */
export type Dict = Record<string, string>;
