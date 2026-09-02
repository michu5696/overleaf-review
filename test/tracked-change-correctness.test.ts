import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRejectionPlan,
  createTrackedChangeSeed,
  remainingChangeIds,
  TRACKED_CHANGE_SEED_BYTES,
  type TrackedChangeRange,
} from '../src/lib/tracked-changes';

test('tracked-change seeds use the canonical nine-byte seed', () => {
  let requestedBytes = 0;
  const seed = createTrackedChangeSeed((size) => {
    requestedBytes = size;
    return new Uint8Array(size).fill(0xab);
  });

  assert.equal(TRACKED_CHANGE_SEED_BYTES, 9);
  assert.equal(requestedBytes, 9);
  assert.equal(seed, 'ababababababababab');
  assert.match(seed, /^[0-9a-f]{18}$/);
});

test('tracked-change seed helper rejects a noncanonical entropy source', () => {
  assert.throws(
    () => createTrackedChangeSeed(() => new Uint8Array(12)),
    /returned 12 bytes; expected 9/,
  );
});

test('rejection reverses every fragment sharing an id', () => {
  const ranges: TrackedChangeRange[] = [
    { id: 'replacement', op: { p: 2, i: 'new' } },
    // Tracked-delete offsets include the preceding tracked insertion, just as
    // they do in Overleaf's replacement representation.
    { id: 'replacement', op: { p: 5, d: 'old' } },
  ];

  const plan = buildRejectionPlan('AAnewZZ', ranges, ['replacement']);

  assert.equal(plan.fragmentCount, 2);
  assert.deepEqual(plan.changeIds, ['replacement']);
  assert.deepEqual(plan.operations, [
    { p: 5, i: 'old', u: true },
    { p: 2, d: 'new', u: true },
  ]);
  assert.equal(plan.expectedText, 'AAoldZZ');
});

test('rejection operations run from the end of the document backwards', () => {
  const ranges: TrackedChangeRange[] = [
    { id: 'early', op: { p: 1, i: 'X' } },
    { id: 'late', op: { p: 4, i: 'Y' } },
  ];

  const plan = buildRejectionPlan('aXbcYd', ranges, ['early', 'late']);

  assert.deepEqual(plan.operations, [
    { p: 4, d: 'Y', u: true },
    { p: 1, d: 'X', u: true },
  ]);
  assert.equal(plan.expectedText, 'abcd');
});

test('rejection leaves unrequested tracked fragments untouched', () => {
  const ranges: TrackedChangeRange[] = [
    { id: 'mine', op: { p: 1, i: 'X' } },
    { id: 'theirs', op: { p: 3, i: 'Y' } },
  ];

  const plan = buildRejectionPlan('aXbYc', ranges, ['mine']);

  assert.deepEqual(plan.operations, [{ p: 1, d: 'X', u: true }]);
  assert.equal(plan.expectedText, 'abYc');
});

test('rejection refuses to delete text that no longer matches its range', () => {
  const ranges: TrackedChangeRange[] = [{ id: 'stale', op: { p: 1, i: 'X' } }];

  assert.throws(
    () => buildRejectionPlan('abc', ranges, ['stale']),
    /no longer matches document text/,
  );
});

test('range verification de-duplicates fragments and preserves request order', () => {
  const ranges: TrackedChangeRange[] = [
    { id: 'a', op: { p: 0, i: 'x' } },
    { id: 'a', op: { p: 0, d: 'y' } },
    { id: 'c', op: { p: 2, i: 'z' } },
  ];

  assert.deepEqual(remainingChangeIds(ranges, ['c', 'b', 'a', 'c']), ['c', 'a']);
});
