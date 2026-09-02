import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyOps,
  buildOperationFootprint,
  buildOps,
  PUSH_PLAN_KIND,
  PUSH_PLAN_SCHEMA_VERSION,
  readPushPlan,
  overleafSnapshotHash,
  pushReceiptNeedsQuarantine,
  quarantinedPlanDocuments,
  serializeActiveTrackedRanges,
  synchronizeLocalAfterRemote,
  trackedChangeIdsForSeed,
  validatePlannedIntent,
  validatePushOptions,
  validatePushPlan,
  writePushPlan,
  type PushPlanV1,
} from '../src/commands/push';
import {
  fingerprintRanges,
  loadBaseState,
  mergeBaseDocuments,
  sha256,
  type BaseDocumentState,
} from '../src/lib/sync-state';
import {
  ambiguousEditAnchors,
  editsConflict,
  textEdits,
  threeWayMerge,
} from '../src/lib/three-way';
import { findCommentOverlaps, findTrackedChangeOverlaps } from '../src/lib/tracked-overlap';

test('buildOps reconstructs exact Unicode and whitespace', () => {
  const source = 'Alpha — beta\n\nGamma';
  const target = 'Alpha — revised beta\nGamma!';
  const ops = buildOps(source, target);
  assert.ok(ops.length > 0);
  assert.equal(applyOps(source, ops), target);
});

test('applyOps rejects a deletion that no longer matches', () => {
  assert.throws(() => applyOps('abcdef', [{ p: 2, d: 'ZZ' }]), /delete operation mismatch/);
});

test('three-way merge preserves independent local and live edits', () => {
  const result = threeWayMerge(
    'one two three four',
    'one LOCAL two three four',
    'one two three LIVE four',
  );
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.text, 'one LOCAL two three LIVE four');
});

test('three-way merge maps local edits across live length changes', () => {
  const result = threeWayMerge('abcdef', 'abcdeLOCALf', 'LONG-abcdef');
  assert.equal(result.text, 'LONG-abcdeLOCALf');
});

test('three-way merge reports overlapping replacements without a result', () => {
  const result = threeWayMerge('abcdef', 'abLOCALef', 'abLIVEef');
  assert.equal(result.text, undefined);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].local, { start: 2, end: 4, text: 'LOCAL' });
  assert.deepEqual(result.conflicts[0].live, { start: 2, end: 4, text: 'LIVE' });
});

test('an edit already made identically on live is not applied twice', () => {
  const result = threeWayMerge('abcdef', 'abXcdef', 'abXcdef');
  assert.equal(result.text, 'abXcdef');
  assert.equal(result.alreadyAppliedLocalEdits.length, 1);
  assert.equal(result.appliedLocalEdits.length, 0);
});

test('boundary edits remain compatible and preserve both sides', () => {
  assert.equal(threeWayMerge('abc', 'xbc', 'Yabc').text, 'Yxbc');
  assert.equal(threeWayMerge('abc', 'aXbc', 'ybc').text, 'yXbc');
  assert.equal(editsConflict({ start: 0, end: 1, text: 'x' }, { start: 1, end: 1, text: 'Y' }), false);
});

test('edits on both sides of a live deletion retain base ordering', () => {
  assert.equal(threeWayMerge('abcdef', 'abXcdYef', 'abef').text, 'abXYef');
});

test('repeated text with a live edit inside the ambiguous anchor envelope conflicts', () => {
  const ambiguities = ambiguousEditAnchors('aa', 'aaa');
  assert.deepEqual(
    ambiguities.map(({ envelopeStart, envelopeEnd }) => ({ envelopeStart, envelopeEnd })),
    [{ envelopeStart: 0, envelopeEnd: 2 }],
  );
  const result = threeWayMerge('aa', 'aaa', 'aba');
  assert.equal(result.text, undefined);
  assert.equal(result.conflicts[0]?.reason, 'ambiguous-local-anchor');
});

test('repeated LaTeX braces and newlines do not silently mis-anchor around live edits', () => {
  const base = '\\item{}\n\\item{}\n';
  const local = '\\item{}\n\\item{}\n\\item{}\n';
  const live = '\\item{reviewer}\n\\item{}\n';
  const result = threeWayMerge(base, local, live);
  assert.equal(result.text, undefined);
  assert.ok(result.conflicts.some((conflict) => conflict.reason === 'ambiguous-local-anchor'));
});

test('reverse-anchor detection preserves Unicode code points', () => {
  assert.deepEqual(ambiguousEditAnchors('A😀B', 'A😀XB'), []);
  assert.equal(threeWayMerge('A😀B C', 'A😀XB C', 'A😀B LIVE C').text, 'A😀XB LIVE C');
});

test('textEdits uses base coordinates', () => {
  assert.deepEqual(textEdits('abcdef', 'abXdeYf'), [
    { start: 2, end: 3, text: 'X' },
    { start: 5, end: 5, text: 'Y' },
  ]);
});

test('tracked range overlap detects inserted and deleted ranges', () => {
  const changes = [
    { id: 'insert', op: { p: 5, i: 'tracked' } },
    { id: 'delete', op: { p: 20, d: 'gone' } },
  ];
  const overlaps = findTrackedChangeOverlaps(changes, [
    { start: 7, end: 9, text: '' },
    { start: 19, end: 21, text: 'replacement' },
  ]);
  assert.deepEqual(overlaps.map((item) => item.changeId), ['insert', 'delete']);
});

test('tracked range overlap ignores adjacent edits', () => {
  const overlaps = findTrackedChangeOverlaps(
    [
      { id: 'insert', op: { p: 5, i: 'abc' } },
      { id: 'deletion-at-end', op: { p: 12, d: 'gone' } },
    ],
    [
      { start: 8, end: 8, text: '!' },
      { start: 10, end: 12, text: 'ok' },
    ],
  );
  assert.deepEqual(overlaps, []);
});

test('comment overlaps retain thread, anchor, and proposed edit context', () => {
  const edit = { start: 4, end: 10, text: 'replacement' };
  const overlaps = findCommentOverlaps(
    [{ id: 'range', op: { p: 5, c: 'anchor', t: 'thread-1' } }],
    [edit],
  );
  assert.deepEqual(overlaps.map(({ threadId, position, anchor, proposedEdit }) => ({
    threadId,
    position,
    anchor,
    proposedEdit,
  })), [{ threadId: 'thread-1', position: 5, anchor: 'anchor', proposedEdit: edit }]);
});

test('overlap footprint reflects whole-word OT operations', () => {
  const footprint = buildOperationFootprint('cat sat', 'cot sat');
  assert.deepEqual(footprint, [{ start: 0, end: 3, text: 'cot' }]);
  const overlaps = findTrackedChangeOverlaps(
    [{ id: 'change-on-c', op: { p: 0, i: 'c' } }],
    footprint,
  );
  assert.equal(overlaps[0]?.changeId, 'change-on-c');
});

test('tracked change ids use a six-digit hexadecimal counter', () => {
  const seed = '0123456789abcdef01';
  assert.equal(trackedChangeIdsForSeed(seed, 10)[9], `${seed}00000a`);
});

test('Overleaf snapshot hashes use Git blob framing and JavaScript length', () => {
  assert.equal(overleafSnapshotHash('test'), '30d74d258442c7c65512eafab474568dd706c430');
  assert.notEqual(overleafSnapshotHash('😀'), overleafSnapshotHash('xx'));
});

test('--doc is rejected without --file', () => {
  assert.throws(() => validatePushOptions({ docName: 'main.tex' }), /--doc requires --file/);
  assert.doesNotThrow(() => validatePushOptions({ file: 'draft.tex', docName: 'main.tex' }));
});

test('interrupted push receipts quarantine an exact-plan retry after mutation starts', () => {
  assert.equal(
    pushReceiptNeedsQuarantine({
      status: 'in_progress',
      details: { documents: [{ mutationAttempted: true }] },
    }),
    true,
  );
  assert.equal(
    pushReceiptNeedsQuarantine({
      status: 'in_progress',
      details: { phase: 'preflight', documents: [{ mutationAttempted: false }] },
    }),
    false,
  );
  assert.equal(pushReceiptNeedsQuarantine({ status: 'ambiguous', details: {} }), true);
});

test('ambiguous push quarantine survives replanning timestamps and tracked-change seeds', () => {
  const plan = {
    kind: PUSH_PLAN_KIND,
    schemaVersion: PUSH_PLAN_SCHEMA_VERSION,
    createdAt: '2026-01-02T00:00:00.000Z',
    projectId: 'project',
    projectName: 'Paper',
    direct: false,
    unsafeNoBase: false,
    allowOverlap: false,
    documents: [{ docId: 'doc', docPath: 'main.tex' }],
  } as PushPlanV1;
  const paths = quarantinedPlanDocuments(plan, [{
    receipt: {
      operation: 'push',
      status: 'ambiguous',
      updatedAt: '2026-01-01T00:00:00.000Z',
      details: {
        projectId: 'project',
        planHash: 'a completely different fresh-plan hash',
        documents: [{ docId: 'doc', mutationAttempted: true }],
      },
    },
  }]);
  assert.deepEqual(paths, ['main.tex']);

  const reconciled = quarantinedPlanDocuments(plan, [
    {
      receipt: {
        operation: 'push',
        status: 'ambiguous',
        updatedAt: '2026-01-01T00:00:00.000Z',
        details: { projectId: 'project', documents: [{ docId: 'doc' }] },
      },
    },
    {
      receipt: {
        operation: 'push',
        status: 'succeeded',
        updatedAt: '2026-01-02T00:00:00.000Z',
        details: {
          projectId: 'project',
          acknowledgedAmbiguousRetry: true,
          documents: [{ docId: 'doc' }],
        },
      },
    },
  ]);
  assert.deepEqual(reconciled, []);
});

test('verified remote text replaces local atomically only from the planned source', () => {
  const root = mkdtempSync(join(tmpdir(), 'overleaf-review-local-sync-'));
  try {
    const path = join(root, 'main.tex');
    writeFileSync(path, 'local intent');
    const result = synchronizeLocalAfterRemote(
      'main.tex',
      sha256('local intent'),
      'local intent plus live edit',
      root,
    );
    assert.equal(readFileSync(path, 'utf8'), 'local intent plus live edit');
    assert.equal(readFileSync(join(root, result.snapshotPath!), 'utf8'), 'local intent');

    writeFileSync(path, 'new editor change');
    assert.throws(
      () => synchronizeLocalAfterRemote('main.tex', sha256('local intent'), 'remote', root),
      /changed while the plan was being submitted/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'new editor change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('push plans round-trip their full operation text and require 18-char seeds', () => {
  const source = 'before';
  const target = 'after';
  const plan: PushPlanV1 = {
    kind: PUSH_PLAN_KIND,
    schemaVersion: PUSH_PLAN_SCHEMA_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectId: 'project',
    projectName: 'Paper',
    direct: false,
    unsafeNoBase: false,
    allowOverlap: false,
    documents: [{
      localPath: 'main.tex',
      docId: 'doc',
      docPath: 'main.tex',
      baseSource: 'saved',
      baseHash: sha256(source),
      localHash: sha256(target),
      liveHash: sha256(source),
      liveVersion: 4,
      rangeFingerprint: fingerprintRanges({}),
      ops: buildOps(source, target),
      expectedHash: sha256(target),
      tcSeed: '0123456789abcdef01',
      activeTrackedRanges: [],
      trackedChangeOverlaps: [],
      commentOverlaps: [],
    }],
  };
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-review-plan-'));
  writePushPlan(plan, 'plan.json', dir);
  assert.deepEqual(readPushPlan('plan.json', dir), plan);
  assert.equal(applyOps(source, readPushPlan('plan.json', dir).documents[0].ops), target);
  assert.throws(() => writePushPlan(plan, join(dir, 'absolute-plan.json'), dir), /Absolute/);

  const bad = structuredClone(plan);
  bad.documents[0].tcSeed = '0123456789abcdef01234567';
  assert.throws(() => validatePushPlan(bad), /tracked-change seed/);

  const injected = structuredClone(plan);
  injected.documents[0].ops = buildOps(source, 'injected');
  injected.documents[0].expectedHash = sha256('injected');
  assert.doesNotThrow(() => validatePushPlan(injected));
  assert.throws(
    () => validatePlannedIntent(injected.documents[0], source, target, source),
    /do not match.*Base→Local intent/,
  );

  const duplicatePath = structuredClone(plan);
  duplicatePath.documents.push({
    ...structuredClone(plan.documents[0]),
    docId: 'doc-2',
    docPath: 'other.tex',
  });
  assert.throws(() => validatePushPlan(duplicatePath), /Duplicate local path/);
});

test('active tracked ranges are complete and deterministic', () => {
  const ranges = serializeActiveTrackedRanges([
    { id: 'b', op: { p: 4, d: 'gone' }, metadata: { user_id: 'two' } },
    { id: 'a', op: { p: 1, i: 'new' }, metadata: { user_id: 'one' } },
  ]);
  assert.deepEqual(ranges.map((range) => range.id), ['a', 'b']);
  assert.equal(ranges[1].op.d, 'gone');
});

test('range fingerprints are stable across response ordering', () => {
  const a = {
    comments: [{ id: 'b', op: { p: 2 } }, { id: 'a', op: { p: 1 } }],
    changes: [{ id: 'c', op: { p: 3, i: 'x' } }],
  };
  const b = {
    changes: [{ op: { i: 'x', p: 3 }, id: 'c' }],
    comments: [{ op: { p: 1 }, id: 'a' }, { op: { p: 2 }, id: 'b' }],
  };
  assert.equal(fingerprintRanges(a), fingerprintRanges(b));
  assert.notEqual(fingerprintRanges(a), fingerprintRanges({ ...a, changes: [] }));
});

test('base state updates merge subset fetches and retain exact text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-review-base-'));
  const path = join(dir, '.overleaf', 'base.json');
  const makeDoc = (docId: string, text: string): BaseDocumentState => ({
    docId,
    path: `${docId}.tex`,
    text,
    hash: sha256(text),
    version: 1,
    rangeFingerprint: fingerprintRanges({}),
    fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  mergeBaseDocuments('project', [makeDoc('a', 'A\n'), makeDoc('b', 'B')], path);
  mergeBaseDocuments('project', [makeDoc('a', 'A2\n\n')], path);

  const state = loadBaseState(path)!;
  assert.equal(state.documents.a.text, 'A2\n\n');
  assert.equal(state.documents.b.text, 'B');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 1);
});

test('base state from a different project is not merged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-review-project-'));
  const path = join(dir, 'base.json');
  const doc = (docId: string): BaseDocumentState => ({
    docId,
    path: `${docId}.tex`,
    text: docId,
    hash: sha256(docId),
    version: 1,
    rangeFingerprint: fingerprintRanges({}),
    fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  mergeBaseDocuments('old', [doc('old-doc')], path);
  mergeBaseDocuments('new', [doc('new-doc')], path);
  assert.deepEqual(Object.keys(loadBaseState(path)!.documents), ['new-doc']);
});
