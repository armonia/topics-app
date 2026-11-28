/**
 * The ONE list of the files and folders that belong to a Topics instance and
 * follow the primary when it moves to another computer (`primary-switch.ts`).
 *
 * Three readers share it:
 *  - the switch walks it to build the bundle on the old primary;
 *  - the receiver takes it as its closed list (`accept` is what a bundle name
 *    may look like below the prefix, nothing else is ever written);
 *  - the server modules that read one of these files take their path from
 *    here (`instanceEntryPath`), so a file the server reads and the switch
 *    does not carry cannot exist unnoticed: `tests/unit/instance-files-covered.test.ts`
 *    fails if the server reads a state file that is neither listed here nor
 *    excluded there with a reason.
 *
 * The CLI transcripts are not here: they live in the CLI's own projects folder
 * and are found through the DB (`collectTranscripts`).
 */
import { join } from "node:path";

/** Which folder of an instance an entry lives under (the resolvers of `data-dir.ts` say where each one is). */
export type InstanceRoot = "state" | "secrets" | "app-data" | "data";

/** What a bundle file becomes on the receiver, by the entry it matched. */
export type InstanceKind = "state" | "secrets" | "app-data" | "media" | "uploads" | "views" | "kept-transcripts";

export interface InstanceDirs {
  stateDir?: string;
  secretsDir?: string;
  appDataDir?: string;
  /** The data folder inside the state root (`resolveDataDir`): where `views/` and `claude-transcripts/` live. */
  dataDir?: string;
}

export interface InstanceEntry {
  kind: InstanceKind;
  /** First segment of the name in the bundle (`state/nodes/x.token`, `media/photo.png`). */
  prefix: string;
  root: InstanceRoot;
  /** Folder below the root that the prefix stands for: the bundle name is relative to it. Empty for the root itself. */
  base: string;
  /** The file or folder, relative to `base`. Empty for the whole of `base`. */
  path: string;
  type: "file" | "folder";
  /** Regex sources (anchored by the reader) for the part of a bundle name after the prefix. The closed list. */
  accept: readonly string[];
  /** Also looked for here when it is not under `root`: the installation id of a state that never moved to the secrets folder. */
  fallbackRoot?: InstanceRoot;
}

export const ID_SEGMENT = "[A-Za-z0-9_-]{1,128}";
/** A topic id is also a file name: letters, digits, `_`, `-` and `:`. */
const TOPIC_ID = "[A-Za-z0-9_:-]{1,128}";
/**
 * One path segment of an attachment: any name a person gave a file (spaces,
 * accents) except a separator, a control character or a leading dot, so never
 * `.`, `..` or a hidden file.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what the class refuses
export const FILE_SEGMENT = /[^/\\\x00-\x1f.][^/\\\x00-\x1f]{0,254}/.source;
const FILE_TREE = `${FILE_SEGMENT}(?:/${FILE_SEGMENT})*`;

/** Node tokens: the credentials this primary uses to call its nodes. */
export const NODES: InstanceEntry = {
  kind: "state", prefix: "state", root: "state", base: "", path: "nodes", type: "folder",
  accept: [`nodes/${ID_SEGMENT}\\.token`, `nodes/${ID_SEGMENT}\\.model-token\\.sha256`, `nodes/delegated/${ID_SEGMENT}/${ID_SEGMENT}\\.token`],
};
/** The licence is verified against the installation id, so the id travels with it. */
export const LICENSE_TOKEN: InstanceEntry = {
  kind: "state", prefix: "state", root: "state", base: "", path: "license-token", type: "file", accept: ["license-token"],
};
export const INSTALLATION_ID: InstanceEntry = {
  kind: "secrets", prefix: "secrets", root: "secrets", base: "", path: "installation-id", type: "file",
  accept: ["installation-id"], fallbackRoot: "state",
};
/** The memory file of each topic (`<topicId>.md`), read when a prompt is assembled. */
export const TOPIC_MEMORY: InstanceEntry = {
  kind: "state", prefix: "state", root: "state", base: "", path: "memory", type: "folder", accept: [`memory/${TOPIC_ID}\\.md`],
};
export const CLAUDE_CLOUD_RUNS: InstanceEntry = {
  kind: "state", prefix: "state", root: "state", base: "", path: "claude-cloud-runs.json", type: "file", accept: ["claude-cloud-runs\\.json"],
};
/**
 * The key pair that signs every web push. The subscriptions travel in the DB,
 * so without the key the new primary's pushes are refused by every browser.
 * A secret: it lands owner-only like the node tokens.
 */
export const VAPID_KEYS: InstanceEntry = {
  kind: "state", prefix: "state", root: "state", base: "", path: "vapid-keys.json", type: "file", accept: ["vapid-keys\\.json"],
};
/** What the hub shows as waiting for the person. */
export const WAITING_ITEMS: InstanceEntry = {
  kind: "app-data", prefix: "app-data", root: "app-data", base: "", path: "waiting-items.json", type: "file", accept: ["waiting-items\\.json"],
};

/** The attachments, uploads, stored views and the keeper's copies of the CLI transcripts: walked whole. */
export const MEDIA: InstanceEntry = { kind: "media", prefix: "media", root: "app-data", base: "media", path: "", type: "folder", accept: [FILE_TREE] };
export const UPLOADS: InstanceEntry = { kind: "uploads", prefix: "uploads", root: "state", base: "uploads", path: "", type: "folder", accept: [FILE_TREE] };
export const VIEWS: InstanceEntry = { kind: "views", prefix: "views", root: "data", base: "views", path: "", type: "folder", accept: [`${ID_SEGMENT}\\.json`] };
export const KEPT_TRANSCRIPTS: InstanceEntry = {
  kind: "kept-transcripts", prefix: "claude-transcripts", root: "data", base: "claude-transcripts", path: "", type: "folder", accept: [`${ID_SEGMENT}\\.jsonl`],
};

/** Every entry, in the order the bundle lists them. */
export const INSTANCE_ENTRIES: readonly InstanceEntry[] = [
  NODES, LICENSE_TOKEN, INSTALLATION_ID, TOPIC_MEMORY, CLAUDE_CLOUD_RUNS, VAPID_KEYS, WAITING_ITEMS,
  MEDIA, UPLOADS, VIEWS, KEPT_TRANSCRIPTS,
];

function rootDir(root: InstanceRoot, dirs: InstanceDirs): string {
  const dir = { state: dirs.stateDir, secrets: dirs.secretsDir, "app-data": dirs.appDataDir, data: dirs.dataDir }[root];
  if (!dir) throw new Error(`the ${root} folder is not known here`);
  return dir;
}

/** The folder a whole bundle prefix lands in: `base` below the root of its entry. */
export function instanceBaseDir(entry: InstanceEntry, dirs: InstanceDirs): string {
  return join(rootDir(entry.root, dirs), entry.base);
}

/** Where an entry lives, resolved from the folders the caller got from the `data-dir.ts` functions. */
export function instanceEntryPath(entry: InstanceEntry, dirs: InstanceDirs): string {
  return join(instanceBaseDir(entry, dirs), entry.path);
}
