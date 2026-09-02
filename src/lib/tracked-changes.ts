import { randomBytes } from 'node:crypto';

/**
 * Overleaf treats `meta.tc` as a seed and appends a six-hex-digit counter to
 * form each 24-character tracked-change id. The seed is therefore 9 bytes
 * (18 hex characters), not a complete 12-byte ObjectId.
 */
export const TRACKED_CHANGE_SEED_BYTES = 9;

export function createTrackedChangeSeed(
  bytes: (size: number) => Uint8Array = randomBytes,
): string {
  const entropy = bytes(TRACKED_CHANGE_SEED_BYTES);
  if (entropy.byteLength !== TRACKED_CHANGE_SEED_BYTES) {
    throw new Error(
      `tracked-change seed source returned ${entropy.byteLength} bytes; ` +
        `expected ${TRACKED_CHANGE_SEED_BYTES}`,
    );
  }
  return Buffer.from(entropy).toString('hex');
}

export interface TrackedChangeRange {
  id: string;
  op: {
    p: number;
    i?: string;
    d?: string;
  };
  metadata?: Record<string, unknown>;
}

/** The `u` marker tells Overleaf that this op undoes a tracked change. */
export type TrackedChangeUndoOperation =
  | { p: number; d: string; u: true }
  | { p: number; i: string; u: true };

export interface RejectionPlan {
  changeIds: string[];
  fragmentCount: number;
  operations: TrackedChangeUndoOperation[];
  expectedText: string;
}

export type TrackedChangeAction = 'accept' | 'reject';

export interface TrackedChangeDocumentOutcome {
  docId: string;
  docPath: string;
  requestedIds: string[];
  attemptedIds: string[];
  fragmentCount: number;
  beforeVersion?: number;
  afterVersion?: number;
  status: 'verified' | 'already-absent' | 'failed';
  /** Reject verifies text as well as ranges; accept only needs range readback. */
  textVerified?: boolean;
  remainingIds: string[];
  error?: string;
}

/** Structured command result that can be embedded in a later audit receipt. */
export interface TrackedChangeMutationResult {
  action: TrackedChangeAction;
  requestedIds: string[];
  /** Requested ids observed during the initial project scan. */
  foundIds: string[];
  /** Requested ids already absent during the initial project scan. */
  missingIds: string[];
  /** Ids included in a mutation request (as opposed to already being absent). */
  attemptedIds: string[];
  /** Ids whose absence was confirmed by readback, plus initially absent ids. */
  verifiedAbsentIds: string[];
  documents: TrackedChangeDocumentOutcome[];
  verified: boolean;
}

/** An operational or readback failure, including any earlier partial success. */
export class TrackedChangeMutationError extends Error {
  constructor(
    message: string,
    public readonly result: TrackedChangeMutationResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TrackedChangeMutationError';
  }
}

export function uniqueChangeIds(changeIds: readonly string[]): string[] {
  return [...new Set(changeIds)];
}

export function changeIdsInRanges(ranges: readonly TrackedChangeRange[]): string[] {
  return [...new Set(ranges.map((range) => range.id))];
}

export function remainingChangeIds(
  ranges: readonly TrackedChangeRange[],
  requestedIds: readonly string[],
): string[] {
  const present = new Set(changeIdsInRanges(ranges));
  return uniqueChangeIds(requestedIds).filter((id) => present.has(id));
}

function inverseOf(range: TrackedChangeRange): TrackedChangeUndoOperation {
  const { p, i, d } = range.op ?? {};
  if (!Number.isSafeInteger(p) || p < 0) {
    throw new Error(`tracked change ${range.id} has an invalid position: ${String(p)}`);
  }
  if (typeof i === 'string' && d === undefined) return { p, d: i, u: true };
  if (typeof d === 'string' && i === undefined) return { p, i: d, u: true };
  throw new Error(`tracked change ${range.id} does not contain exactly one insert/delete op`);
}

function applyUndo(text: string, op: TrackedChangeUndoOperation, changeId: string): string {
  if (op.p > text.length) {
    throw new Error(
      `tracked change ${changeId} starts at ${op.p}, beyond document length ${text.length}`,
    );
  }
  if ('d' in op) {
    const actual = text.slice(op.p, op.p + op.d.length);
    if (actual !== op.d) {
      throw new Error(
        `tracked insertion ${changeId} no longer matches document text at ${op.p}: ` +
          `expected ${JSON.stringify(op.d)}, found ${JSON.stringify(actual)}`,
      );
    }
    return text.slice(0, op.p) + text.slice(op.p + op.d.length);
  }
  return text.slice(0, op.p) + op.i + text.slice(op.p);
}

/**
 * Build all inverse operations for the requested ids and calculate the exact
 * text expected after rejection. Every matching range fragment is included.
 *
 * Ranges are reverse-sorted by document position, exactly as Overleaf's editor
 * does, so applying one inverse cannot shift the position of a fragment still
 * to come. This is especially important for a replacement: its tracked delete
 * is positioned after the tracked insertion in the current document model and
 * must be restored before the inserted replacement is removed.
 */
export function buildRejectionPlan(
  currentText: string,
  ranges: readonly TrackedChangeRange[],
  requestedIds: readonly string[],
): RejectionPlan {
  const requested = new Set(uniqueChangeIds(requestedIds));
  const fragments = ranges.filter((range) => requested.has(range.id));
  // Array#sort is stable on every supported Node version, matching Overleaf's
  // own reverse-position sort for fragments at the same offset.
  fragments.sort((a, b) => b.op.p - a.op.p);

  const operations: TrackedChangeUndoOperation[] = [];
  let expectedText = currentText;
  for (const range of fragments) {
    const inverse = inverseOf(range);
    expectedText = applyUndo(expectedText, inverse, range.id);
    operations.push(inverse);
  }

  return {
    changeIds: changeIdsInRanges(fragments),
    fragmentCount: fragments.length,
    operations,
    expectedText,
  };
}
