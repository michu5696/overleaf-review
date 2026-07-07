import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-user credential store (NOT in any repo). Holds the Overleaf session
 * cookie, treated like a password: file is chmod 600. Location is overridable
 * via OVERLEAF_REVIEW_CONFIG_DIR (used in tests).
 */
function configDir(): string {
  return process.env.OVERLEAF_REVIEW_CONFIG_DIR ?? join(homedir(), '.config', 'overleaf-review');
}

function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

export interface Credentials {
  baseUrl?: string;
  session2?: string;
  savedAt?: string;
}

export function loadCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Credentials;
  } catch {
    return {};
  }
}

export function saveCredentials(creds: Credentials): string {
  mkdirSync(configDir(), { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify({ ...creds, savedAt: new Date().toISOString() }, null, 2) + '\n');
  chmodSync(path, 0o600);
  return path;
}
