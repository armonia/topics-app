import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findKeychainItem, keychainAccountsToTry, keychainEnabled } from './auth';

/** Finds Claude Code login metadata without reading its secret. */
export function claudeLoginSource(): 'keychain' | 'file' | null {
  if (keychainEnabled()) {
    for (const account of keychainAccountsToTry()) {
      if (findKeychainItem(account, false).status === 0) return 'keychain';
    }
  }
  return existsSync(join(process.env.HOME || homedir(), '.claude', '.credentials.json')) ? 'file' : null;
}
