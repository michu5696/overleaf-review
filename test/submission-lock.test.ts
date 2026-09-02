import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireMutationLock,
  mutationLockPath,
} from '../src/lib/submission-lock';

test('submission lock excludes a second local agent and releases by token', () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-lock-'));
  try {
    const first = acquireMutationLock('project-a', { root });
    assert.equal(first.path, mutationLockPath(root));
    assert.equal(existsSync(first.path), true);
    assert.throws(
      () => acquireMutationLock('project-a', { root }),
      /Another overleaf-review mutation holds/,
    );

    first.release();
    first.release();
    assert.equal(existsSync(first.path), false);

    const next = acquireMutationLock('project-a', { root });
    next.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
