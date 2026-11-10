/**
 * The words that belong to one organization and not to the screens: its name,
 * the phrases of the copy that name its clients, programs and public sources.
 * The Italian and English copy of the organization screens (`sarim-*`) read
 * them from here, so the same screens speak for any organization.
 *
 * `orgWords()` is read when the copy modules load, so an entry that runs another
 * organization calls `setOrgWords()` (through `setWorld()` of the gallery)
 * before it imports the copy. There is no default: every entry chooses, and a
 * build for one organization carries the words of that organization only.
 */

/** A table of «Dati»: how it is named and what it holds, in one language. */
export interface OrgTableWords {
  label: string;
  about: string;
}

/** The phrases of one language that carry the organization's own facts. */
export interface OrgPhrases {
  /** «Comuni serviti»: the towns table, the search group, the tile of the overview. */
  townsLabel: string;
  /** What the towns table holds, with the name of the organization. */
  townsAbout: string;
  /** The title of the towns block of Settings > Organization. */
  servedTitle: (n: number) => string;
  /** The note under that block: where the number comes from. */
  servedBody: string;
  /** The note under the counters of the organization's site. */
  numbersBody: string;
  /** Words the settings search matches for the Organization page. */
  organizationKeywords: string;
  /** Who a person writes to outside, in the explanation of the «send» rule. */
  sendExamples: string;
  /** What a write in a program looks like, in the explanation of the «programs» rule. */
  programsExamples: string;
  /** The example in the box that changes a flow. */
  flowEditExample: string;
  /** What an approval covers, in the explanation of the «approve» rule. */
  approveExamples: string;
  /** The example in the box that asks why a contract needs a variation. */
  variantReasonExample: string;
  /** The name of the flow a contract variation opens its card in. */
  variantFlow: string;
  /** The saved filters of «Dati» that come with a table of cards, by id (the ones the world lists in `dataViews`). */
  views: Record<string, string>;
  /** The tables of «Dati» by address segment: every id the world lists in `dataTables`, plus `contratti` and `comuni`. */
  tables: Record<string, OrgTableWords>;
}

/** The Italian forms of the name with its article, for the sentences that need one («del Consorzio», «di SARIM»). allow-italian: quotes the words on screen */
export interface OrgArticled {
  /** «SARIM», «il Consorzio di Nocera». */
  the: string;
  /** «di SARIM», «del Consorzio di Nocera». allow-italian: quotes the words on screen */
  of: string;
  /** «da SARIM», «dal Consorzio di Nocera». allow-italian: quotes the words on screen */
  from: string;
  /** «per SARIM», «per il Consorzio di Nocera». */
  for: string;
  /** «in tutta SARIM», «in tutto il Consorzio». allow-italian: quotes the words on screen */
  inAll: string;
}

export interface OrgWords {
  /** How the organization is called on screen. */
  name: string;
  /** The Italian name with its article, in the forms the sentences use. */
  articled: OrgArticled;
  /** The legal name printed on documents it signs. */
  legalName: string;
  /** The word file names start with (`<slug>-log`). */
  slug: string;
  /** The prefix of the numbers its register of contracts gives. */
  refPrefix: string;
  /** The register a signed registration goes to, named in the «registry» rule. */
  registryName: string;
  it: OrgPhrases;
  en: OrgPhrases;
}

let current: OrgWords | undefined;

/** The words of the organization the app runs for. */
export function orgWords(): OrgWords {
  if (!current) throw new Error('orgWords(): no organization chosen, call setOrgWords() (or setWorld()) before the copy loads');
  return current;
}

/** Chooses the organization before the copy modules load. */
export function setOrgWords(words: OrgWords): void {
  current = words;
}
