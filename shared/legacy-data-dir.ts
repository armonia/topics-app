/**
 * The name of the app's old data root, under the home dir. It stays because
 * existing installs hold real media and workspaces there, the paths saved in
 * the DB point at it, and the always-on agents (Jarvis, Visione) keep their
 * homes in it: moving them is a data migration with a change of its own.
 * This is the only place in the repository where this name may appear as code;
 * server and client read it from here.
 */
export const LEGACY_DATA_DIR_NAME = ".openclaw";
