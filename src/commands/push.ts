import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve as resolvePath, sep } from 'node:path';
import { diffWordsWithSpace } from 'diff';
import { config } from '../config';
import { matchDocument } from '../lib/document-match';
import {
  beginReceipt,
  readReceipts,
  updateReceipt,
  type ReceiptHandle,
  type ReceiptStatus,
} from '../lib/receipts';
import {
  applyOtUpdateAndWait,
  joinDoc,
  openProject,
  type Doc,
  type DocState,
} from '../lib/session';
import {
  BASE_STATE_PATH,
  fingerprintRanges,
  loadBaseState,
  mergeBaseDocuments,
  sha256,
  stableJson,
  type BaseDocumentState,
} from '../lib/sync-state';
import { threeWayMerge, type MergeConflict, type TextEdit } from '../lib/three-way';
import {
  findCommentOverlaps,
  findTrackedChangeOverlaps,
  type CommentOverlap,
  type TrackedChangeOverlap,
} from '../lib/tracked-overlap';
import { createTrackedChangeSeed } from '../lib/tracked-changes';
import { snapshotRelativePath, snapshotTimestamp } from '../lib/snapshots';
import {
  acquireMutationLock,
  type MutationLock,
} from '../lib/submission-lock';
import {
  workspaceReadPath,
  workspaceRelativePath,
  workspaceWritePath,
} from '../lib/workspace-path';

export const PUSH_PLAN_SCHEMA_VERSION = 2 as const;
export const PUSH_PLAN_KIND = 'overleaf-review-push-plan' as const;

export interface PushOptions {
  /** A single local file to push. If omitted, inspect every local .tex file. */
  file?: string;
  /** Force the target Overleaf doc (path or basename); only valid with `file`. */
  docName?: string;
  /** Send plain edits instead of tracked suggestions. */
  direct?: boolean;
  dryRun?: boolean;
  /** Deliberately restore legacy two-way behavior for docs with no saved base. */
  unsafeNoBase?: boolean;
  /** Permit edits which intersect active tracked-change ranges. */
  allowOverlap?: boolean;
  /** Persist the complete plan here. A plan-out push only plans; it does not submit. */
  planOut?: string;
  /** Submit a previously persisted plan instead of creating a new one. */
  plan?: string | PushPlanV1;
  /** Primarily for embedding/tests. */
  basePath?: string;
  /** Primarily for embedding/tests. */
  receiptsDir?: string;
  /** Explicitly continue after manually reconciling an earlier ambiguous push. */
  allowAmbiguousRetry?: boolean;
}

export interface SubmitPlanOptions {
  /** Primarily for embedding/tests. */
  basePath?: string;
  /** Primarily for embedding/tests. */
  receiptsDir?: string;
  /** Explicitly continue after manually reconciling an earlier ambiguous push. */
  allowAmbiguousRetry?: boolean;
}

export interface Op {
  p: number;
  i?: string;
  d?: string;
}

export interface PlannedOverlap {
  changeId: string;
  proposedEdit: { start: number; end: number; text: string };
  trackedOp: { p?: number; i?: string; d?: string };
}

export interface PlannedTrackedRange {
  id: string;
  op: { p: number; i?: string; d?: string };
  metadata?: Record<string, unknown>;
}

export interface PlannedCommentOverlap {
  threadId: string;
  position: number;
  anchor: string;
  proposedEdit: { start: number; end: number; text: string };
}

export interface PushPlanDocument {
  localPath: string;
  docId: string;
  docPath: string;
  baseSource: 'saved' | 'live-unsafe';
  baseHash: string;
  localHash: string;
  liveHash: string;
  liveVersion: number;
  rangeFingerprint: string;
  /** Complete, unabridged sequential OT operation list. */
  ops: Op[];
  expectedHash: string;
  /** 18 hex chars; Overleaf appends its six-character per-op counter. */
  tcSeed: string | null;
  /** Complete active tracked-change state at planning time. */
  activeTrackedRanges: PlannedTrackedRange[];
  trackedChangeOverlaps: PlannedOverlap[];
  /** Informational only; editing a commented anchor is often intentional. */
  commentOverlaps: PlannedCommentOverlap[];
}

export interface PushPlanV1 {
  kind: typeof PUSH_PLAN_KIND;
  schemaVersion: typeof PUSH_PLAN_SCHEMA_VERSION;
  createdAt: string;
  projectId: string;
  projectName: string;
  direct: boolean;
  unsafeNoBase: boolean;
  allowOverlap: boolean;
  documents: PushPlanDocument[];
}

export interface SubmitPlanDocumentResult {
  docId: string;
  docPath: string;
  version: number;
  hash: string;
  trackedChangeIds: string[];
}

export interface SubmitPlanResult {
  projectId: string;
  direct: boolean;
  totalOps: number;
  documents: SubmitPlanDocumentResult[];
  receiptPath: string;
}

export type PushReceiptDocumentStatus =
  | 'pending'
  | 'applying'
  | 'verified'
  | 'failed'
  | 'ambiguous'
  | 'remote_verified_local_failed';

export interface PushReceiptDocument {
  docId: string;
  docPath: string;
  localPath: string;
  opCount: number;
  expectedHash: string;
  status: PushReceiptDocumentStatus;
  mutationAttempted: boolean;
  mutationStartedAt?: string;
  verifiedAt?: string;
  afterVersion?: number;
  trackedChangeIds?: string[];
  transportError?: string;
  localSnapshotPath?: string;
  error?: string;
}

export class PushSubmissionError extends Error {
  constructor(
    message: string,
    public readonly receiptPath: string,
    public readonly status: 'failed' | 'ambiguous',
    public readonly documents: PushReceiptDocument[],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PushSubmissionError';
  }
}

interface PlanningConflict {
  localPath: string;
  docPath: string;
  conflicts: MergeConflict[];
}

interface PlanningOverlap {
  localPath: string;
  docPath: string;
  overlaps: PlannedOverlap[];
}

export class PushPlanningError extends Error {
  constructor(
    message: string,
    public readonly conflicts: PlanningConflict[] = [],
    public readonly overlaps: PlanningOverlap[] = [],
  ) {
    super(message);
    this.name = 'PushPlanningError';
  }
}

export class PushPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushPlanValidationError';
  }
}

export function validatePushOptions(opts: PushOptions): void {
  if (opts.docName && !opts.file) {
    throw new Error('--doc requires --file; bulk pushes cannot map multiple local files to one document.');
  }
}

/**
 * Convert source→target into sequential OT operations. Whitespace-sensitive
 * word diffs make tracked suggestions readable while reconstructing exactly.
 */
export function buildOps(source: string, target: string): Op[] {
  const ops: Op[] = [];
  let p = 0;
  for (const part of diffWordsWithSpace(source, target)) {
    if (part.added) {
      ops.push({ p, i: part.value });
      p += part.value.length;
    } else if (part.removed) {
      ops.push({ p, d: part.value });
    } else {
      p += part.value.length;
    }
  }
  const rebuilt = applyOps(source, ops);
  if (rebuilt !== target) {
    throw new Error('internal error: generated OT operations do not reconstruct target text');
  }
  return ops;
}

/**
 * The source-coordinate ranges touched by buildOps. This deliberately follows
 * the same word-level diff rather than the smaller character-level intent: an
 * OT replacement of a whole word can touch a tracked range on any part of it.
 */
export function buildOperationFootprint(source: string, target: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let sourcePos = 0;
  let pending: TextEdit | undefined;
  const flush = () => {
    if (!pending) return;
    if (pending.start !== pending.end || pending.text.length) edits.push(pending);
    pending = undefined;
  };
  for (const part of diffWordsWithSpace(source, target)) {
    if (!part.added && !part.removed) {
      flush();
      sourcePos += part.value.length;
      continue;
    }
    pending ??= { start: sourcePos, end: sourcePos, text: '' };
    if (part.removed) {
      pending.end += part.value.length;
      sourcePos += part.value.length;
    } else {
      pending.text += part.value;
    }
  }
  flush();
  return edits;
}

/** Apply this tool's sequential insert/delete operations with strict validation. */
export function applyOps(source: string, ops: readonly Op[]): string {
  let text = source;
  for (const op of ops) {
    if (!Number.isSafeInteger(op.p) || op.p < 0 || op.p > text.length) {
      throw new Error(`invalid operation position ${String(op.p)} for ${text.length}-character text`);
    }
    const hasInsert = typeof op.i === 'string';
    const hasDelete = typeof op.d === 'string';
    if (hasInsert === hasDelete) throw new Error('operation must contain exactly one of i or d');
    if (hasInsert) {
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
    } else {
      const deletion = op.d!;
      const actual = text.slice(op.p, op.p + deletion.length);
      if (actual !== deletion) {
        throw new Error(
          `delete operation mismatch at ${op.p}: expected ${JSON.stringify(deletion)}, ` +
            `found ${JSON.stringify(actual)}`,
        );
      }
      text = text.slice(0, op.p) + text.slice(op.p + deletion.length);
    }
  }
  return text;
}

function preview(op: Op): string {
  const kind = op.i != null ? 'insert' : 'delete';
  const text = (op.i ?? op.d ?? '').replace(/\n/g, '⏎');
  const clip = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return `  ${kind.padEnd(6)} @ ${String(op.p).padStart(5)}  "${clip}"`;
}

/** Local file path → Overleaf-style project-relative path (forward slashes). */
function toOverleafPath(file: string): string {
  return workspaceRelativePath(file);
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.overleaf', 'tmp', 'dist']);

function discoverLocalTex(dir = process.cwd(), acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) discoverLocalTex(full, acc);
    else if (entry.name.endsWith('.tex')) {
      acc.push(relative(process.cwd(), full).split(sep).join('/'));
    }
  }
  return acc;
}

/** Match a local file to an Overleaf doc: explicit override, then path, then basename. */
function pickDoc(
  file: string,
  docName: string | undefined,
  docs: Doc[],
): Doc | undefined {
  return matchDocument(docName?.replace(/\\/g, '/') ?? toOverleafPath(file), docs);
}

function formatConflicts(conflicts: PlanningConflict[]): string {
  return conflicts
    .flatMap(({ docPath, conflicts: items }) =>
      items.map(({ local, live, reason }) =>
        reason === 'ambiguous-local-anchor'
          ? `${docPath}: repeated-text anchor for local [${local.start},${local.end}) is ` +
            `ambiguous and its envelope is touched by live [${live.start},${live.end}); ` +
            'refresh and reapply this edit explicitly'
          : `${docPath}: local [${local.start},${local.end}) overlaps live ` +
            `[${live.start},${live.end})`,
      ),
    )
    .join('\n  ');
}

function serializeOverlaps(overlaps: TrackedChangeOverlap[]): PlannedOverlap[] {
  return overlaps
    .map(({ changeId, proposedEdit, change }) => ({
      changeId,
      proposedEdit,
      trackedOp: {
        p: change.op?.p,
        i: change.op?.i,
        d: change.op?.d,
      },
    }))
    .sort((a, b) => {
      const left = stableJson(a);
      const right = stableJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

export function serializeActiveTrackedRanges(changes: any[] | undefined): PlannedTrackedRange[] {
  const ranges = (changes ?? []).map((change, index) => {
    const id = change?.id;
    const p = change?.op?.p;
    const hasInsert = typeof change?.op?.i === 'string';
    const hasDelete = typeof change?.op?.d === 'string';
    if (
      typeof id !== 'string' ||
      !Number.isSafeInteger(p) ||
      p < 0 ||
      hasInsert === hasDelete
    ) {
      throw new Error(`Overleaf returned an invalid tracked range at index ${index}`);
    }
    return {
      id,
      op: {
        p,
        ...(hasInsert ? { i: change.op.i as string } : { d: change.op.d as string }),
      },
      ...(change.metadata && typeof change.metadata === 'object'
        ? { metadata: change.metadata as Record<string, unknown> }
        : {}),
    };
  });
  return ranges.sort((a, b) => {
    const left = stableJson(a);
    const right = stableJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function serializeCommentOverlaps(overlaps: CommentOverlap[]): PlannedCommentOverlap[] {
  return overlaps
    .map(({ threadId, position, anchor, proposedEdit }) => ({
      threadId,
      position,
      anchor,
      proposedEdit,
    }))
    .sort((a, b) => {
      const left = stableJson(a);
      const right = stableJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

/** Create a complete immutable plan without mutating Overleaf or local files. */
export async function createPlan(opts: PushOptions = {}): Promise<PushPlanV1> {
  validatePushOptions(opts);
  if (opts.plan) throw new Error('createPlan does not accept an existing plan');
  const basePath = opts.basePath ?? BASE_STATE_PATH;
  const baseState = loadBaseState(basePath);
  if (baseState && baseState.projectId !== config.projectId && !opts.unsafeNoBase) {
    throw new PushPlanningError(
      `Saved base belongs to project ${baseState.projectId}, not ${config.projectId}; run fetch first.`,
    );
  }

  const { socket, project, docs } = await openProject();
  try {
    const projectId = String(project?._id ?? config.projectId);
    if (projectId !== config.projectId) {
      throw new PushPlanningError(
        `Connected project id ${projectId} does not match configured project ${config.projectId}.`,
      );
    }
    const files = opts.file ? [workspaceRelativePath(opts.file)] : discoverLocalTex();
    if (!files.length) {
      const emptyPlan: PushPlanV1 = {
        kind: PUSH_PLAN_KIND,
        schemaVersion: PUSH_PLAN_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        projectId,
        projectName: String(project?.name ?? '(unknown)'),
        direct: Boolean(opts.direct),
        unsafeNoBase: Boolean(opts.unsafeNoBase),
        allowOverlap: Boolean(opts.allowOverlap),
        documents: [],
      };
      if (opts.planOut) writePushPlan(emptyPlan, opts.planOut);
      return emptyPlan;
    }

    const documents: PushPlanDocument[] = [];
    const conflicts: PlanningConflict[] = [];
    const blockedOverlaps: PlanningOverlap[] = [];

    for (const file of files) {
      let local: string;
      try {
        local = readFileSync(workspaceReadPath(file), 'utf8');
      } catch (error) {
        throw new Error(`Cannot safely read ${file}: ${(error as Error).message}`);
      }
      const doc = pickDoc(file, opts.docName, docs);
      if (!doc) {
        throw new Error(
          `No Overleaf document matches ${file}; push it with --file and --doc using the ` +
            'exact project path.',
        );
      }
      const state = await joinDoc(socket, doc._id);
      const live = state.lines.join('\n');
      const savedBase = baseState?.projectId === projectId ? baseState.documents[doc._id] : undefined;
      if (!savedBase && !opts.unsafeNoBase) {
        throw new PushPlanningError(
          `No saved synchronization base for ${doc.path}. Run fetch first, or explicitly use ` +
            '`--unsafe-no-base` to request legacy two-way behavior.',
        );
      }
      const base = savedBase?.text ?? live;
      const merge = threeWayMerge(base, local, live);
      if (merge.conflicts.length) {
        conflicts.push({ localPath: file, docPath: doc.path, conflicts: merge.conflicts });
        continue;
      }
      const expected = merge.text!;
      const ops = buildOps(live, expected);
      if (!ops.length) continue;

      const proposedEdits = buildOperationFootprint(live, expected);
      const activeTrackedRanges = serializeActiveTrackedRanges(state.ranges.changes);
      const overlaps = serializeOverlaps(
        findTrackedChangeOverlaps(state.ranges.changes, proposedEdits),
      );
      const commentOverlaps = serializeCommentOverlaps(
        findCommentOverlaps(state.ranges.comments, proposedEdits),
      );
      if (overlaps.length && !opts.allowOverlap) {
        blockedOverlaps.push({ localPath: file, docPath: doc.path, overlaps });
        continue;
      }

      documents.push({
        localPath: toOverleafPath(file),
        docId: doc._id,
        docPath: doc.path,
        baseSource: savedBase ? 'saved' : 'live-unsafe',
        baseHash: sha256(base),
        localHash: sha256(local),
        liveHash: sha256(live),
        liveVersion: state.version,
        rangeFingerprint: fingerprintRanges(state.ranges),
        ops,
        expectedHash: sha256(expected),
        tcSeed: opts.direct ? null : createTrackedChangeSeed(),
        activeTrackedRanges,
        trackedChangeOverlaps: overlaps,
        commentOverlaps,
      });
    }

    if (conflicts.length || blockedOverlaps.length) {
      const parts: string[] = [];
      if (conflicts.length) parts.push(`Concurrent edit conflicts:\n  ${formatConflicts(conflicts)}`);
      if (blockedOverlaps.length) {
        const lines = blockedOverlaps.flatMap(({ docPath, overlaps }) =>
          overlaps.map(({ changeId, proposedEdit }) =>
            `${docPath}: proposed [${proposedEdit.start},${proposedEdit.end}) overlaps change ${changeId}`,
          ),
        );
        parts.push(
          `Active tracked-change overlaps:\n  ${lines.join('\n  ')}\n` +
            'Re-plan with --allow-overlap only after inspecting these changes.',
        );
      }
      throw new PushPlanningError(parts.join('\n\n'), conflicts, blockedOverlaps);
    }

    const plan: PushPlanV1 = {
      kind: PUSH_PLAN_KIND,
      schemaVersion: PUSH_PLAN_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      projectId,
      projectName: String(project?.name ?? '(unknown)'),
      direct: Boolean(opts.direct),
      unsafeNoBase: documents.some((doc) => doc.baseSource === 'live-unsafe'),
      allowOverlap: Boolean(opts.allowOverlap),
      documents,
    };
    if (opts.planOut) writePushPlan(plan, opts.planOut);
    return plan;
  } finally {
    socket.close();
  }
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PushPlanValidationError(`Invalid ${field} in push plan`);
  }
}

export function validatePushPlan(value: unknown): PushPlanV1 {
  if (!value || typeof value !== 'object') throw new PushPlanValidationError('Push plan is not an object');
  const plan = value as Partial<PushPlanV1>;
  if (plan.kind !== PUSH_PLAN_KIND || plan.schemaVersion !== PUSH_PLAN_SCHEMA_VERSION) {
    throw new PushPlanValidationError('Unsupported push-plan kind or schema version');
  }
  if (
    typeof plan.projectId !== 'string' ||
    typeof plan.projectName !== 'string' ||
    typeof plan.createdAt !== 'string' ||
    typeof plan.direct !== 'boolean' ||
    typeof plan.unsafeNoBase !== 'boolean' ||
    typeof plan.allowOverlap !== 'boolean' ||
    !Array.isArray(plan.documents)
  ) {
    throw new PushPlanValidationError('Push plan is missing required fields');
  }
  const seen = new Set<string>();
  const seenLocalPaths = new Set<string>();
  for (const doc of plan.documents) {
    if (
      !doc ||
      typeof doc.localPath !== 'string' ||
      typeof doc.docId !== 'string' ||
      typeof doc.docPath !== 'string' ||
      (doc.baseSource !== 'saved' && doc.baseSource !== 'live-unsafe') ||
      !Number.isSafeInteger(doc.liveVersion) ||
      doc.liveVersion < 0 ||
      !Array.isArray(doc.ops) ||
      doc.ops.length === 0 ||
      !Array.isArray(doc.activeTrackedRanges) ||
      !Array.isArray(doc.trackedChangeOverlaps) ||
      !Array.isArray(doc.commentOverlaps)
    ) {
      throw new PushPlanValidationError('Push plan contains an invalid document');
    }
    try {
      if (
        workspaceRelativePath(doc.localPath) !== doc.localPath ||
        workspaceRelativePath(doc.docPath) !== doc.docPath
      ) {
        throw new Error('path is not normalized');
      }
    } catch (error) {
      throw new PushPlanValidationError(
        `Unsafe or invalid path in push plan: ${(error as Error).message}`,
      );
    }
    if (seen.has(doc.docId)) throw new PushPlanValidationError(`Duplicate document ${doc.docId} in plan`);
    seen.add(doc.docId);
    if (seenLocalPaths.has(doc.localPath)) {
      throw new PushPlanValidationError(`Duplicate local path ${doc.localPath} in plan`);
    }
    seenLocalPaths.add(doc.localPath);
    assertHash(doc.baseHash, 'baseHash');
    assertHash(doc.localHash, 'localHash');
    assertHash(doc.liveHash, 'liveHash');
    assertHash(doc.rangeFingerprint, 'rangeFingerprint');
    assertHash(doc.expectedHash, 'expectedHash');
    for (const op of doc.ops) {
      if (
        !op ||
        !Number.isSafeInteger(op.p) ||
        op.p < 0 ||
        (typeof op.i === 'string') === (typeof op.d === 'string') ||
        (typeof (op.i ?? op.d) === 'string' && (op.i ?? op.d)!.length === 0)
      ) {
        throw new PushPlanValidationError(`Invalid operation in ${doc.docPath}`);
      }
    }
    for (const range of doc.activeTrackedRanges) {
      if (
        !range ||
        typeof range.id !== 'string' ||
        !Number.isSafeInteger(range.op?.p) ||
        range.op.p < 0 ||
        (typeof range.op.i === 'string') === (typeof range.op.d === 'string') ||
        (range.metadata !== undefined && (!range.metadata || typeof range.metadata !== 'object'))
      ) {
        throw new PushPlanValidationError(`Invalid active tracked range in ${doc.docPath}`);
      }
    }
    for (const overlap of doc.trackedChangeOverlaps) {
      if (
        !overlap ||
        typeof overlap.changeId !== 'string' ||
        !validTextEdit(overlap.proposedEdit) ||
        !Number.isSafeInteger(overlap.trackedOp?.p)
      ) {
        throw new PushPlanValidationError(`Invalid tracked-change overlap in ${doc.docPath}`);
      }
    }
    for (const overlap of doc.commentOverlaps) {
      if (
        !overlap ||
        typeof overlap.threadId !== 'string' ||
        !Number.isSafeInteger(overlap.position) ||
        overlap.position < 0 ||
        typeof overlap.anchor !== 'string' ||
        !validTextEdit(overlap.proposedEdit)
      ) {
        throw new PushPlanValidationError(`Invalid comment overlap in ${doc.docPath}`);
      }
    }
    if (plan.direct) {
      if (doc.tcSeed !== null) throw new PushPlanValidationError('Direct plan must not contain tcSeed');
    } else if (typeof doc.tcSeed !== 'string' || !/^[0-9a-f]{18}$/.test(doc.tcSeed)) {
      throw new PushPlanValidationError(`Invalid tracked-change seed in ${doc.docPath}`);
    }
    if (!plan.allowOverlap && doc.trackedChangeOverlaps.length) {
      throw new PushPlanValidationError('Plan contains blocked tracked-change overlaps');
    }
    if (doc.baseSource === 'live-unsafe' && doc.baseHash !== doc.liveHash) {
      throw new PushPlanValidationError(`Unsafe base must equal planned live text in ${doc.docPath}`);
    }
  }
  return plan as PushPlanV1;
}

function validTextEdit(value: unknown): value is TextEdit {
  if (!value || typeof value !== 'object') return false;
  const edit = value as Partial<TextEdit>;
  return Boolean(
    Number.isSafeInteger(edit.start) &&
      Number.isSafeInteger(edit.end) &&
      edit.start! >= 0 &&
      edit.end! >= edit.start! &&
      typeof edit.text === 'string',
  );
}

export function readPushPlan(path: string, workspaceRoot = process.cwd()): PushPlanV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workspaceReadPath(path, workspaceRoot), 'utf8'));
  } catch (error) {
    throw new PushPlanValidationError(`Cannot read push plan ${path}: ${(error as Error).message}`);
  }
  return validatePushPlan(parsed);
}

export function writePushPlan(
  plan: PushPlanV1,
  path: string,
  workspaceRoot = process.cwd(),
): void {
  validatePushPlan(plan);
  const target = workspaceWritePath(path, workspaceRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

export function trackedChangeIdsForSeed(seed: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    `${seed}${(index + 1).toString(16).padStart(6, '0')}`,
  );
}

interface BoundPlanDocument {
  plan: PushPlanDocument;
  state: DocState;
  expected: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Git-blob SHA1 format expected by Overleaf's document updater. */
export function overleafSnapshotHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${text.length}\0`, 'utf8')
    .update(text, 'utf8')
    .digest('hex');
}

/** Prove persisted operations are exactly saved Base→Local intent rebased on Live. */
export function validatePlannedIntent(
  planned: PushPlanDocument,
  base: string,
  local: string,
  live: string,
): string {
  if (sha256(base) !== planned.baseHash) {
    throw new PushPlanValidationError(`Synchronization base changed for ${planned.docPath}.`);
  }
  if (sha256(local) !== planned.localHash) {
    throw new PushPlanValidationError(`${planned.localPath} changed after planning.`);
  }
  if (sha256(live) !== planned.liveHash) {
    throw new PushPlanValidationError(`${planned.docPath} text changed after planning.`);
  }
  const merge = threeWayMerge(base, local, live);
  if (merge.conflicts.length || merge.text === undefined) {
    throw new PushPlanValidationError(
      `${planned.docPath} no longer has the conflict-free intent recorded by the plan.`,
    );
  }
  const expected = merge.text;
  if (
    stableJson(buildOps(live, expected)) !== stableJson(planned.ops) ||
    sha256(expected) !== planned.expectedHash
  ) {
    throw new PushPlanValidationError(
      `Operations in ${planned.docPath} do not match its saved Base→Local intent.`,
    );
  }
  return expected;
}

function validateReviewBinding(
  planned: PushPlanDocument,
  state: DocState,
  live: string,
  expected: string,
  allowOverlap: boolean,
): void {
  if (state.version !== planned.liveVersion) {
    throw new PushPlanValidationError(
      `${planned.docPath} version changed from ${planned.liveVersion} to ${state.version}; create a new plan.`,
    );
  }
  if (fingerprintRanges(state.ranges) !== planned.rangeFingerprint) {
    throw new PushPlanValidationError(
      `${planned.docPath} comments or tracked ranges changed after planning; create a new plan.`,
    );
  }
  const footprint = buildOperationFootprint(live, expected);
  const activeTrackedRanges = serializeActiveTrackedRanges(state.ranges.changes);
  const trackedOverlaps = serializeOverlaps(
    findTrackedChangeOverlaps(state.ranges.changes, footprint),
  );
  const commentOverlaps = serializeCommentOverlaps(
    findCommentOverlaps(state.ranges.comments, footprint),
  );
  if (stableJson(activeTrackedRanges) !== stableJson(planned.activeTrackedRanges)) {
    throw new PushPlanValidationError(
      `Active tracked-range data is invalid for ${planned.docPath}; create a new plan.`,
    );
  }
  if (stableJson(trackedOverlaps) !== stableJson(planned.trackedChangeOverlaps)) {
    throw new PushPlanValidationError(
      `Tracked-change overlap data is invalid for ${planned.docPath}; create a new plan.`,
    );
  }
  if (trackedOverlaps.length && !allowOverlap) {
    throw new PushPlanValidationError(
      `${planned.docPath} operations overlap active tracked changes; create a plan with ` +
        '--allow-overlap only after inspecting them.',
    );
  }
  if (stableJson(commentOverlaps) !== stableJson(planned.commentOverlaps)) {
    throw new PushPlanValidationError(
      `Comment-overlap data is invalid for ${planned.docPath}; create a new plan.`,
    );
  }
}

function baseTextForPlan(
  plan: PushPlanV1,
  planned: PushPlanDocument,
  live: string,
  basePath: string,
): string {
  if (planned.baseSource === 'live-unsafe') {
    if (!plan.unsafeNoBase) {
      throw new PushPlanValidationError(`${planned.docPath} uses an unauthorized unsafe base.`);
    }
    return live;
  }
  const state = loadBaseState(basePath);
  const saved = state?.projectId === plan.projectId ? state.documents[planned.docId] : undefined;
  if (!saved || saved.hash !== planned.baseHash || sha256(saved.text) !== planned.baseHash) {
    throw new PushPlanValidationError(
      `Synchronization base for ${planned.docPath} changed after planning; create a new plan.`,
    );
  }
  return saved.text;
}

async function bindPlanDocument(
  plan: PushPlanV1,
  planned: PushPlanDocument,
  socket: Parameters<typeof joinDoc>[0],
  basePath: string,
): Promise<BoundPlanDocument> {
  let local: string;
  try {
    local = readFileSync(workspaceReadPath(planned.localPath), 'utf8');
  } catch (error) {
    throw new PushPlanValidationError(
      `Cannot read planned local file ${planned.localPath}: ${errorMessage(error)}`,
    );
  }
  const state = await joinDoc(socket, planned.docId);
  const live = state.lines.join('\n');
  const base = baseTextForPlan(plan, planned, live, basePath);
  const expected = validatePlannedIntent(planned, base, local, live);
  validateReviewBinding(planned, state, live, expected, plan.allowOverlap);
  return { plan: planned, state, expected };
}

function verifiedTrackedIds(
  plan: PushPlanV1,
  planned: PushPlanDocument,
  after: DocState,
): string[] {
  if (plan.direct) return [];
  const actualIds = new Set((after.ranges.changes ?? []).map((change: any) => String(change.id)));
  if (planned.trackedChangeOverlaps.length) {
    const ids = [...actualIds].filter((id) =>
      new RegExp(`^${planned.tcSeed}[0-9a-f]{6}$`).test(id),
    );
    if (!ids.length) {
      throw new Error(
        `Verification failed for ${planned.docPath}: no tracked ranges with seed ` +
          `${planned.tcSeed} were created.`,
      );
    }
    return ids;
  }
  const expectedIds = trackedChangeIdsForSeed(planned.tcSeed!, planned.ops.length);
  const missing = expectedIds.filter((id) => !actualIds.has(id));
  if (missing.length) {
    throw new Error(
      `Verification failed for ${planned.docPath}: tracked ranges were not created for ` +
        `${missing.join(', ')}.`,
    );
  }
  return expectedIds;
}

function definitelyRejectedApply(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes('Overleaf rejected the OT update') ||
    message.includes('Overleaf failed to apply the OT update')
  );
}

function initialReceiptDocuments(plan: PushPlanV1): PushReceiptDocument[] {
  return plan.documents.map((doc) => ({
    docId: doc.docId,
    docPath: doc.docPath,
    localPath: doc.localPath,
    opCount: doc.ops.length,
    expectedHash: doc.expectedHash,
    status: 'pending',
    mutationAttempted: false,
  }));
}

export function pushReceiptNeedsQuarantine(receipt: {
  status?: unknown;
  details?: Record<string, unknown>;
}): boolean {
  if (receipt.status === 'ambiguous') return true;
  if (receipt.status !== 'in_progress') return false;
  const documents = receipt.details?.documents;
  return (
    Array.isArray(documents) &&
    documents.some(
      (document) =>
        Boolean(document) &&
        typeof document === 'object' &&
        ((document as { mutationAttempted?: unknown }).mutationAttempted === true ||
          typeof (document as { mutationStartedAt?: unknown }).mutationStartedAt === 'string'),
    )
  );
}

function receiptDocumentIds(receipt: { details?: Record<string, unknown> }): string[] {
  const documents = receipt.details?.documents;
  if (!Array.isArray(documents)) return [];
  return documents.flatMap((document) => {
    if (!document || typeof document !== 'object') return [];
    const docId = (document as { docId?: unknown }).docId;
    return typeof docId === 'string' ? [docId] : [];
  });
}

/** Return planned docs whose earlier push outcome is still unresolved. */
export function quarantinedPlanDocuments(
  plan: PushPlanV1,
  receipts: Array<{
    receipt: {
      operation?: unknown;
      status?: unknown;
      updatedAt?: unknown;
      details?: Record<string, unknown>;
    };
  }>,
): string[] {
  const plannedIds = new Set(plan.documents.map((document) => document.docId));
  const disposition = new Map<string, 'quarantined' | 'reconciled'>();
  const newestFirst = [...receipts].sort((a, b) =>
    String(b.receipt.updatedAt ?? '').localeCompare(String(a.receipt.updatedAt ?? '')),
  );
  for (const { receipt } of newestFirst) {
    if (
      receipt.operation !== 'push' ||
      receipt.details?.projectId !== plan.projectId
    ) {
      continue;
    }
    const reconciles =
      receipt.status === 'succeeded' && receipt.details.acknowledgedAmbiguousRetry === true;
    const quarantines = pushReceiptNeedsQuarantine(receipt);
    if (!reconciles && !quarantines) continue;
    for (const docId of receiptDocumentIds(receipt)) {
      if (plannedIds.has(docId) && !disposition.has(docId)) {
        disposition.set(docId, reconciles ? 'reconciled' : 'quarantined');
      }
    }
  }
  return plan.documents
    .filter((document) => disposition.get(document.docId) === 'quarantined')
    .map((document) => document.docPath);
}

/**
 * Replace the local source only if it is still the file that was planned.
 * The old file is snapshotted and the replacement is an atomic rename.
 */
export function synchronizeLocalAfterRemote(
  localPath: string,
  plannedLocalHash: string,
  remoteText: string,
  workspaceRoot = process.cwd(),
): { snapshotPath?: string } {
  const localFile = workspaceReadPath(localPath, workspaceRoot);
  const currentLocal = readFileSync(localFile, 'utf8');
  if (sha256(currentLocal) !== plannedLocalHash) {
    throw new Error(`${localPath} changed while the plan was being submitted; local file left untouched.`);
  }
  if (currentLocal === remoteText) return {};

  const timestamp = `${snapshotTimestamp()}-${process.pid}`;
  const snapshotPath = snapshotRelativePath(timestamp, localPath, workspaceRoot);
  const snapshotFile = workspaceWritePath(snapshotPath, workspaceRoot);
  mkdirSync(dirname(snapshotFile), { recursive: true });
  writeFileSync(snapshotFile, currentLocal, { flag: 'wx', mode: 0o600 });

  const target = workspaceWritePath(localPath, workspaceRoot);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, remoteText, { mode: statSync(localFile).mode & 0o777 });
    // Recheck immediately before replacement so edits made during snapshot and
    // temp-file creation are not knowingly overwritten.
    if (sha256(readFileSync(localFile, 'utf8')) !== plannedLocalHash) {
      throw new Error(`${localPath} changed while the plan was being submitted; local file left untouched.`);
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
  return { snapshotPath };
}

/** Validate the entire binding plan first, then apply and verify every document. */
export async function submitPlan(
  planOrPath: PushPlanV1 | string,
  opts: SubmitPlanOptions = {},
): Promise<SubmitPlanResult> {
  const plan = typeof planOrPath === 'string' ? readPushPlan(planOrPath) : validatePushPlan(planOrPath);
  const totalOps = plan.documents.reduce((sum, doc) => sum + doc.ops.length, 0);
  const planHash = sha256(stableJson(plan));
  const receiptDocuments = initialReceiptDocuments(plan);
  let receipt: ReceiptHandle<Record<string, unknown>> = beginReceipt(
    'push',
    {
      projectId: plan.projectId,
      direct: plan.direct,
      planCreatedAt: plan.createdAt,
      planHash,
      totalOps,
      phase: 'preflight',
      plan,
      documents: receiptDocuments,
    },
    { receiptsDir: opts.receiptsDir },
  );
  const completed: SubmitPlanDocumentResult[] = [];
  const basePath = opts.basePath ?? BASE_STATE_PATH;
  let opened: Awaited<ReturnType<typeof openProject>> | undefined;
  let mutationLock: MutationLock | undefined;
  let unknownMutationOutcome = false;
  let failureStatus: 'failed' | 'ambiguous' | undefined;

  try {
    if (plan.projectId !== config.projectId) {
      throw new PushPlanValidationError(
        `Plan is for project ${plan.projectId}, but this repository is linked to ${config.projectId}.`,
      );
    }
    // Receipt quarantine must be checked while holding the same lock as the
    // mutation. Otherwise a second submitter can inspect too early, wait behind
    // an ambiguous first attempt, and then proceed using stale preflight state.
    mutationLock = acquireMutationLock(plan.projectId);
    const priorReceipts = readReceipts(opts.receiptsDir);
    const quarantinedDocuments = quarantinedPlanDocuments(plan, priorReceipts);
    if (quarantinedDocuments.length && !opts.allowAmbiguousRetry) {
      throw new PushPlanValidationError(
        `A prior push has an unresolved outcome for: ${quarantinedDocuments.join(', ')}. ` +
          'Wait for delayed updates, inspect Overleaf and its receipt, then create a fresh plan. ' +
          'Only after manual reconciliation may you submit with --acknowledge-ambiguous.',
      );
    }
    if (!plan.documents.length) {
      receipt = updateReceipt(receipt, 'skipped', {
        phase: 'complete',
        outcome: 'empty_plan',
        documents: receiptDocuments,
      });
      return {
        projectId: plan.projectId,
        direct: plan.direct,
        totalOps,
        documents: completed,
        receiptPath: receipt.path,
      };
    }

    opened = await openProject();
    const { socket, project, docs } = opened;
    const connectedProjectId = String(project?._id ?? config.projectId);
    if (connectedProjectId !== plan.projectId) {
      throw new PushPlanValidationError(
        `Connected project ${connectedProjectId} does not match plan ${plan.projectId}.`,
      );
    }
    const docsById = new Map(docs.map((doc) => [doc._id, doc]));
    for (const planned of plan.documents) {
      const doc = docsById.get(planned.docId);
      if (!doc || doc.path !== planned.docPath) {
        throw new PushPlanValidationError(
          `Document ${planned.docPath} (${planned.docId}) no longer exists at its planned path.`,
        );
      }
    }

    // Full-batch preflight: no mutation starts unless every document is valid.
    for (const planned of plan.documents) {
      await bindPlanDocument(plan, planned, socket, basePath);
    }
    receipt = updateReceipt(receipt, 'in_progress', {
      phase: 'applying',
      preflightVerifiedAt: new Date().toISOString(),
      ...(opts.allowAmbiguousRetry && quarantinedDocuments.length
        ? {
            acknowledgedAmbiguousRetry: true,
            reconciledAmbiguousDocuments: quarantinedDocuments,
          }
        : {}),
      documents: receiptDocuments,
    });

    for (let index = 0; index < plan.documents.length; index++) {
      const planned = plan.documents[index];
      // Rejoin and revalidate immediately before this document's mutation.
      const { state, expected } = await bindPlanDocument(
        plan,
        planned,
        socket,
        basePath,
      );
      receiptDocuments[index] = {
        ...receiptDocuments[index],
        status: 'applying',
        mutationAttempted: true,
        mutationStartedAt: new Date().toISOString(),
      };
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'applying',
        currentDocument: planned.docPath,
        documents: receiptDocuments,
      });

      unknownMutationOutcome = true;
      let applyError: unknown;
      try {
        await applyOtUpdateAndWait(socket, planned.docId, {
          doc: planned.docId,
          op: planned.ops,
          v: state.version,
          meta: plan.direct ? {} : { tc: planned.tcSeed! },
          hash: overleafSnapshotHash(expected),
        });
      } catch (error) {
        applyError = error;
      }

      let after: DocState;
      try {
        after = await joinDoc(socket, planned.docId);
      } catch (readbackError) {
        const definitelyRejected = Boolean(applyError && definitelyRejectedApply(applyError));
        failureStatus = definitelyRejected ? 'failed' : 'ambiguous';
        unknownMutationOutcome = !definitelyRejected;
        receiptDocuments[index] = {
          ...receiptDocuments[index],
          status: failureStatus,
          ...(applyError ? { transportError: errorMessage(applyError) } : {}),
          error: `Readback failed: ${errorMessage(readbackError)}`,
        };
        throw new Error(
          `${planned.docPath} could not be verified after its update: ${errorMessage(readbackError)}`,
        );
      }

      const afterText = after.lines.join('\n');
      if (afterText !== expected || sha256(afterText) !== planned.expectedHash) {
        const definitelyRejected = Boolean(applyError && definitelyRejectedApply(applyError));
        failureStatus = definitelyRejected ? 'failed' : 'ambiguous';
        unknownMutationOutcome = !definitelyRejected;
        receiptDocuments[index] = {
          ...receiptDocuments[index],
          status: failureStatus,
          afterVersion: after.version,
          ...(applyError ? { transportError: errorMessage(applyError) } : {}),
          error: 'Overleaf text does not match the planned result',
        };
        throw new Error(
          `Verification failed for ${planned.docPath}: Overleaf text does not match the planned result.`,
        );
      }

      let trackedChangeIds: string[];
      try {
        trackedChangeIds = verifiedTrackedIds(plan, planned, after);
      } catch (error) {
        const ambiguousTransport = Boolean(applyError && !definitelyRejectedApply(applyError));
        unknownMutationOutcome = ambiguousTransport;
        failureStatus = ambiguousTransport ? 'ambiguous' : 'failed';
        receiptDocuments[index] = {
          ...receiptDocuments[index],
          status: failureStatus,
          afterVersion: after.version,
          ...(applyError ? { transportError: errorMessage(applyError) } : {}),
          error: errorMessage(error),
        };
        throw error;
      }
      unknownMutationOutcome = false;

      try {
        const localSync = synchronizeLocalAfterRemote(
          planned.localPath,
          planned.localHash,
          afterText,
        );
        if (localSync.snapshotPath) {
          receiptDocuments[index] = {
            ...receiptDocuments[index],
            localSnapshotPath: localSync.snapshotPath,
          };
        }
        const base: BaseDocumentState = {
          docId: planned.docId,
          path: planned.docPath,
          text: afterText,
          hash: planned.expectedHash,
          version: after.version,
          rangeFingerprint: fingerprintRanges(after.ranges),
          fetchedAt: new Date().toISOString(),
        };
        // Advance Base only after the local file safely reflects the verified
        // remote result. Otherwise a later merge could mistake preserved live
        // edits for intentional local deletions.
        mergeBaseDocuments(plan.projectId, [base], basePath);
      } catch (error) {
        failureStatus = 'failed';
        receiptDocuments[index] = {
          ...receiptDocuments[index],
          status: 'remote_verified_local_failed',
          afterVersion: after.version,
          trackedChangeIds,
          ...(applyError ? { transportError: errorMessage(applyError) } : {}),
          error: errorMessage(error),
        };
        throw new Error(
          `${planned.docPath} was verified on Overleaf, but local synchronization failed: ` +
            errorMessage(error),
        );
      }

      const result: SubmitPlanDocumentResult = {
        docId: planned.docId,
        docPath: planned.docPath,
        version: after.version,
        hash: planned.expectedHash,
        trackedChangeIds,
      };
      completed.push(result);
      receiptDocuments[index] = {
        ...receiptDocuments[index],
        status: 'verified',
        verifiedAt: new Date().toISOString(),
        afterVersion: after.version,
        trackedChangeIds,
        ...(applyError ? { transportError: errorMessage(applyError) } : {}),
      };
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'applying',
        completedDocuments: completed.map((doc) => doc.docPath),
        documents: receiptDocuments,
      });
    }

    receipt = updateReceipt(receipt, 'succeeded', {
      phase: 'complete',
      verifiedAt: new Date().toISOString(),
      completedDocuments: completed.map((doc) => doc.docPath),
      documents: receiptDocuments,
    });
    return {
      projectId: plan.projectId,
      direct: plan.direct,
      totalOps,
      documents: completed,
      receiptPath: receipt.path,
    };
  } catch (error) {
    const status: Extract<ReceiptStatus, 'failed' | 'ambiguous'> =
      failureStatus ?? (unknownMutationOutcome ? 'ambiguous' : 'failed');
    receipt = updateReceipt(receipt, status, {
      phase: status === 'ambiguous' ? 'mutation_outcome_unknown' : 'failed',
      failedAt: new Date().toISOString(),
      error: errorMessage(error),
      completedDocuments: completed.map((doc) => doc.docPath),
      documents: receiptDocuments,
    });
    throw new PushSubmissionError(
      `${errorMessage(error)} Audit receipt: ${receipt.path}`,
      receipt.path,
      status,
      receiptDocuments,
      error,
    );
  } finally {
    try {
      opened?.socket.close();
    } finally {
      mutationLock?.release();
    }
  }
}

function printPlan(plan: PushPlanV1): void {
  console.log(
    plan.direct
      ? 'Mode: DIRECT — plain edits (not marked as suggestions)'
      : 'Mode: SUGGESTIONS — tracked changes for co-authors to accept/reject',
  );
  for (const doc of plan.documents) {
    const ins = doc.ops.filter((op) => op.i != null).length;
    const del = doc.ops.filter((op) => op.d != null).length;
    console.log(
      `\n${doc.localPath} → ${doc.docPath} (v${doc.liveVersion}): ` +
        `${doc.ops.length} op(s), ${ins} ins / ${del} del`,
    );
    for (const op of doc.ops.slice(0, 12)) console.log(preview(op));
    if (doc.ops.length > 12) console.log(`  … and ${doc.ops.length - 12} more`);
    for (const overlap of doc.commentOverlaps) {
      console.log(
        `  ℹ️  touches comment ${overlap.threadId} @ ${overlap.position}: ` +
          `${JSON.stringify(overlap.anchor)}`,
      );
    }
  }
}

/** Existing one-shot command, now implemented as create-plan then submit-plan. */
export async function push(opts: PushOptions): Promise<void> {
  validatePushOptions(opts);
  if (opts.plan) {
    const result = await submitPlan(opts.plan, {
      basePath: opts.basePath,
      receiptsDir: opts.receiptsDir,
      allowAmbiguousRetry: opts.allowAmbiguousRetry,
    });
    console.log(
      `✅ Submitted and verified ${result.totalOps} ${result.direct ? 'direct edit(s)' : 'tracked suggestion(s)'} ` +
        `across ${result.documents.length} file(s).`,
    );
    console.log(`Audit receipt: ${result.receiptPath}`);
    return;
  }

  const plan = await createPlan(opts);
  if (!plan.documents.length) {
    console.log('Nothing to push — no unapplied local edits were found.');
    if (opts.planOut) console.log(`Saved empty plan to ${opts.planOut}.`);
    return;
  }
  printPlan(plan);

  if (opts.planOut) {
    console.log(`\nSaved binding plan to ${opts.planOut}; nothing sent to Overleaf.`);
    return;
  }
  if (opts.dryRun) {
    console.log('\n(dry run — nothing sent to Overleaf)');
    return;
  }

  const result = await submitPlan(plan, {
    basePath: opts.basePath,
    receiptsDir: opts.receiptsDir,
    allowAmbiguousRetry: opts.allowAmbiguousRetry,
  });
  console.log(
    `\n✅ Pushed and verified ${result.totalOps} ` +
      `${result.direct ? 'direct edit(s)' : 'tracked suggestion(s)'} across ` +
      `${result.documents.length} file(s).`,
  );
  console.log(`Audit receipt: ${result.receiptPath}`);
}
