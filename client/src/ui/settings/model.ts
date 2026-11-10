/**
 * The vocabulary of the Settings pages: the ids that tie a row of example data
 * (`fixtures/settings.ts`) to its words (`copy/settings.ts`) and to the
 * components that draw it. No words here, and no data: only the shapes.
 */

export type PrincipleId =
  | 'anonymization' | 'speed' | 'security' | 'determinism' | 'context'
  | 'memory' | 'person' | 'anywhere' | 'tracked' | 'team';

export type FunctionId =
  | 'flows' | 'data' | 'knowledge' | 'views' | 'channels' | 'programs' | 'anonymization' | 'agents' | 'testing' | 'team' | 'log';

/** What a function of the product is: working, being tried with the first organizations, or next. */
export type FunctionStatus = 'active' | 'testing' | 'next';

/** The words a sector package renames (the left column of the vocabulary). */
export type TermId = 'case' | 'party' | 'incoming' | 'registration' | 'folder' | 'charges' | 'office';

export type SectorId = 'bonifica' | 'ambiente' | 'impianti' | 'generico';

export type StartupStepId = 'connect' | 'documents' | 'mapping' | 'procedures' | 'trial' | 'launch' | 'upkeep';

export type OrgFactId = 'founded' | 'area' | 'network' | 'basins' | 'ponds' | 'irrigation' | 'staff';

export type DeployId = 'cloud' | 'ente' | 'pc' | 'isolated';

export type ProtectionId = 'access' | 'zerotrust' | 'keys' | 'separation' | 'confidential' | 'log' | 'pentest' | 'releases';
export type ProtectionState = 'on' | 'to-enable' | 'to-evaluate' | 'evaluating' | 'partial' | 'planned';

export type RegionId = 'it-mi' | 'it-rm' | 'eu-fra' | 'eu-par';

export type StandardId =
  | 'agid-docs' | 'cad' | 'agid-seg' | 'preservation'
  | 'gdpr' | 'iso27001' | 'acn' | 'nis2'
  | 'iso25012' | 'iso8000' | 'aiact' | 'iso42001' | 'wcag'
  | 'rentri' | 'iso9001' | 'iso14001' | 'iso45001';
export type StandardGroup = 'documents' | 'personal' | 'data' | 'sector';
export type StandardStatus = 'covered' | 'in-progress' | 'partial' | 'to-certify' | 'to-request' | 'to-verify' | 'by-others';
export type ComplianceScope = 'nocera' | 'sarim' | 'topics';
