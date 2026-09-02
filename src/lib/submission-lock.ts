import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { workspaceWritePath } from './workspace-path';

/** Compatibility/test override; production defaults to mutationLockPath(). */
export const MUTATION_LOCK_PATH = join('.overleaf', 'mutation.lock');

/** Ephemeral lock path keyed to the canonical working-tree location. */
export function mutationLockPath(root = process.cwd()): string {
  const key = createHash('sha256').update(realpathSync(root), 'utf8').digest('hex').slice(0, 32);
  return join(tmpdir(), `overleaf-review-${key}.lock`);
}

export interface MutationLock {
  path: string;
  token: string;
  release(): void;
}

/**
 * Exclude another local process from a review mutation's preflight→verify
 * critical section. Overleaf transforms stale operations, so two agents must
 * never race from the same workspace.
 */
export function acquireMutationLock(
  projectId: string,
  options: { root?: string; path?: string } = {},
): MutationLock {
  const root = options.root ?? process.cwd();
  const path = options.path
    ? workspaceWritePath(options.path, root)
    : mutationLockPath(root);
  const displayPath = options.path ?? path;
  mkdirSync(dirname(path), { recursive: true });

  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner = '';
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        pid?: unknown;
        startedAt?: unknown;
        projectId?: unknown;
      };
      const details = [
        typeof parsed.pid === 'number' ? `pid ${parsed.pid}` : undefined,
        typeof parsed.startedAt === 'string' ? `since ${parsed.startedAt}` : undefined,
        typeof parsed.projectId === 'string' ? `project ${parsed.projectId}` : undefined,
      ].filter(Boolean);
      if (details.length) owner = ` (${details.join(', ')})`;
    } catch {
      // An interrupted or foreign lock still blocks safely.
    }
    throw new Error(
      `Another overleaf-review mutation holds ${displayPath}${owner}. ` +
        'Wait for it to finish. If its process crashed, inspect any relevant receipt and live project ' +
        'before removing the lock manually.',
      { cause: error },
    );
  }

  try {
    writeFileSync(
      fd,
      `${JSON.stringify(
        {
          token,
          pid: process.pid,
          projectId,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
  closeSync(fd);

  let released = false;
  return {
    path,
    token,
    release() {
      if (released) return;
      try {
        const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
        if (current.token === token) unlinkSync(path);
        released = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          released = true;
          return;
        }
        // Retain ownership state so a caller can retry cleanup after a
        // transient filesystem error. Never unlink a lock with another token.
        throw error;
      }
    },
  };
}

// Compatibility aliases for the original push-specific name used during the
// v0.4 development cycle.
export const SUBMISSION_LOCK_PATH = MUTATION_LOCK_PATH;
export type SubmissionLock = MutationLock;
export const acquireSubmissionLock = acquireMutationLock;
