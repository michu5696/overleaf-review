import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { matchDocument } from '../src/lib/document-match';
import { snapshotRelativePath } from '../src/lib/snapshots';
import {
  workspaceReadPath,
  workspaceRelativePath,
  workspaceWritePath,
} from '../src/lib/workspace-path';

const docs = [
  { _id: 'one', name: 'main.tex', path: 'chapters/main.tex' },
  { _id: 'two', name: 'main.tex', path: 'appendix/main.tex' },
  { _id: 'three', name: 'unique.tex', path: 'sections/unique.tex' },
];

test('document matching prefers exact paths and rejects ambiguous basenames', () => {
  assert.equal(matchDocument('appendix/main.tex', docs)?._id, 'two');
  assert.equal(matchDocument('unique.tex', docs)?._id, 'three');
  assert.equal(matchDocument('wrong/unique.tex', docs), undefined);
  assert.throws(() => matchDocument('main.tex', docs), /ambiguous.*exact project path/i);
  assert.equal(matchDocument('missing.tex', docs), undefined);
});

test('workspace paths reject absolute and parent traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-workspace-'));
  assert.equal(workspaceRelativePath('sections/main.tex', root), 'sections/main.tex');
  assert.throws(() => workspaceRelativePath('../secret.tex', root), /traversal/);
  assert.throws(() => workspaceRelativePath('sections/../../secret.tex', root), /traversal/);
  assert.throws(() => workspaceRelativePath('/tmp/secret.tex', root), /Absolute/);
  assert.throws(() => workspaceRelativePath('C:\\secret.tex', root), /Absolute/);
  assert.throws(() => workspaceRelativePath('\\\\server\\secret.tex', root), /Absolute/);
});

test('snapshot paths retain safe project-relative structure', () => {
  assert.equal(
    snapshotRelativePath('2026-09-02T10-20-30-000Z', 'sections/main.tex'),
    '.overleaf/snapshots/2026-09-02T10-20-30-000Z/sections/main.tex',
  );
  assert.throws(
    () => snapshotRelativePath('2026-09-02T10-20-30-000Z', '../outside.tex'),
    /traversal/,
  );
});

test('workspace reads and writes reject symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'overleaf-review-outside-'));
  writeFileSync(join(outside, 'secret.tex'), 'secret');
  symlinkSync(outside, join(root, 'escape'));
  assert.throws(() => workspaceReadPath('escape/secret.tex', root), /outside/);
  assert.throws(() => workspaceWritePath('escape/new.tex', root), /ancestor outside/);

  mkdirSync(join(root, 'safe'));
  writeFileSync(join(root, 'safe', 'main.tex'), 'ok');
  assert.equal(workspaceReadPath('safe/main.tex', root), join(root, 'safe', 'main.tex'));
  assert.equal(workspaceWritePath('safe/new.tex', root), join(root, 'safe', 'new.tex'));
});
