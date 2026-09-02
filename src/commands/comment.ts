import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { matchDocument } from '../lib/document-match';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';
import { applyOtUpdateAndWait, openProject, joinDoc } from '../lib/session';
import {
  findRecentIdenticalMessage,
  getCsrfToken,
  getThreads,
  observePostedThreadMessage,
  postThreadMessageDetailed,
  RestRequestError,
  threadMessageId,
  threadMessages,
  type ObservePostedMessageResult,
} from '../lib/rest';
import {
  beginReceipt,
  readReceipts,
  updateReceipt,
  type ReceiptHandle,
} from '../lib/receipts';

const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export interface PriorCommentAttempt {
  status?: string;
  updatedAt?: string;
  anchorAttemptedAt?: string;
  postAttemptedAt?: string;
}

function isRecentAttempt(prior: PriorCommentAttempt, nowMs: number, windowMs: number): boolean {
  const updatedAt = prior.updatedAt ? Date.parse(prior.updatedAt) : Number.NaN;
  return (
    Number.isFinite(updatedAt) &&
    updatedAt >= nowMs - Math.max(0, windowMs) &&
    updatedAt <= nowMs + 60_000
  );
}

/** True when a possibly delayed anchor operation makes a fresh anchor unsafe. */
export function shouldQuarantineCommentAnchorRetry(
  prior: PriorCommentAttempt,
  nowMs: number,
  windowMs: number,
): boolean {
  return (
    (prior.status === 'ambiguous' ||
      (prior.status === 'in_progress' && Boolean(prior.anchorAttemptedAt))) &&
    isRecentAttempt(prior, nowMs, windowMs)
  );
}

/** True when retrying could duplicate a POST whose outcome is still unknown. */
export function shouldQuarantineCommentRetry(
  prior: PriorCommentAttempt,
  nowMs: number,
  windowMs: number,
): boolean {
  if (!prior.postAttemptedAt || (prior.status !== 'ambiguous' && prior.status !== 'in_progress')) {
    return false;
  }
  return isRecentAttempt(prior, nowMs, windowMs);
}

export interface CommentOptions {
  /** Doc to comment in; defaults to the project's root doc. */
  docName?: string;
  /** Text to anchor the comment on (first match, or the nth via `occurrence`). */
  anchor: string;
  /** The comment message body. */
  message: string;
  /** 1-based occurrence of the anchor text to use (default 1). */
  occurrence?: number;
  /** Create another comment even when an identical recent one is present. */
  force?: boolean;
  /** How recent an identical comment must be to count as a retry. */
  duplicateWindowMs?: number;
  /** Readback deadline after posting the message. */
  verificationTimeoutMs?: number;
  /** Poll interval used during message readback. */
  verificationIntervalMs?: number;
  /** Override primarily for tests and embedding. */
  receiptsDir?: string;
}

export interface CommentResult {
  doc: string;
  threadId: string;
  anchorCreated: boolean;
  messagePosted: boolean;
  duplicate: boolean;
  messageId?: string;
  receiptPath: string;
}

export interface CommentRangeLike {
  op?: { p?: unknown; c?: unknown; t?: unknown };
  [key: string]: unknown;
}

export function findCommentRangeByThreadId(
  ranges: unknown,
  threadId: string,
): CommentRangeLike | undefined {
  if (!Array.isArray(ranges)) return undefined;
  return ranges.find(
    (range): range is CommentRangeLike =>
      Boolean(range && typeof range === 'object' && (range as CommentRangeLike).op?.t === threadId),
  );
}

export function findCommentRangesAt(
  ranges: unknown,
  position: number,
  anchor: string,
): CommentRangeLike[] {
  if (!Array.isArray(ranges)) return [];
  return ranges.filter(
    (range): range is CommentRangeLike =>
      Boolean(
        range &&
          typeof range === 'object' &&
          (range as CommentRangeLike).op?.p === position &&
          (range as CommentRangeLike).op?.c === anchor,
      ),
  );
}

/** Confirm that a stored range still points at the intended live text. */
export function commentRangeAnchorsText(
  range: CommentRangeLike | undefined,
  text: string,
  anchor: string,
): boolean {
  const position = range?.op?.p;
  return (
    Number.isSafeInteger(position) &&
    (position as number) >= 0 &&
    range?.op?.c === anchor &&
    text.slice(position as number, (position as number) + anchor.length) === anchor
  );
}

export function commentIntentHash(intent: {
  projectId: string;
  docId: string;
  anchor: string;
  occurrence: number;
  message: string;
}): string {
  const canonical = [
    intent.projectId,
    intent.docId,
    intent.anchor,
    intent.occurrence,
    intent.message,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function rangeThreadId(range: CommentRangeLike | undefined): string | undefined {
  const value = range?.op?.t;
  return typeof value === 'string' && value ? value : undefined;
}

function rangeSnapshot(range: CommentRangeLike | undefined): Record<string, unknown> {
  return range
    ? {
        present: true,
        position: range.op?.p,
        anchor: range.op?.c,
        threadId: range.op?.t,
      }
    : { present: false };
}

function threadSnapshot(thread: unknown): Record<string, unknown> {
  const messages = threadMessages(thread);
  return {
    exists: Boolean(thread),
    messageCount: messages.length,
    messageIds: messages.map(threadMessageId).filter((id): id is string => Boolean(id)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function priorThreadIdForIntent(intentHash: string, receiptsDir?: string): {
  threadId?: string;
  receiptPath?: string;
  status?: string;
  updatedAt?: string;
  anchorAttemptedAt?: string;
  postAttemptedAt?: string;
} {
  const prior = readReceipts(receiptsDir).find(
    ({ receipt }) => receipt.operation === 'comment' && receipt.details.intentHash === intentHash,
  );
  const threadId = prior?.receipt.details.threadId;
  const anchorAttemptedAt = prior?.receipt.details.anchorAttemptedAt;
  const postAttemptedAt = prior?.receipt.details.postAttemptedAt;
  return {
    ...(typeof threadId === 'string' ? { threadId } : {}),
    ...(prior ? { receiptPath: prior.path } : {}),
    ...(prior ? { status: prior.receipt.status, updatedAt: prior.receipt.updatedAt } : {}),
    ...(typeof anchorAttemptedAt === 'string' ? { anchorAttemptedAt } : {}),
    ...(typeof postAttemptedAt === 'string' ? { postAttemptedAt } : {}),
  };
}

/**
 * Create an anchored comment with independently verified OT and REST steps.
 * These transports are not atomic; the receipt records partial/ambiguous state
 * and lets a later retry finish an already-created anchor.
 */
export async function commentWithResult(opts: CommentOptions): Promise<CommentResult> {
  const { socket, project, docs } = await openProject();
  let mutationLock: MutationLock | undefined;
  let receipt: ReceiptHandle<Record<string, unknown>> | undefined;
  try {
    mutationLock = acquireMutationLock(config.projectId);
    const doc = opts.docName
      ? matchDocument(opts.docName.replace(/\\/g, '/'), docs)
      : docs.find((d) => d._id === project.rootDoc_id) ?? docs[0];
    if (!doc) throw new Error(`doc not found: ${opts.docName ?? '(root)'}`);

    const state = await joinDoc(socket, doc._id);
    const flat = state.lines.join('\n');

    // Locate the nth occurrence of the anchor text.
    const nth = Math.max(1, opts.occurrence ?? 1);
    let p = -1;
    let from = 0;
    for (let i = 0; i < nth; i++) {
      p = flat.indexOf(opts.anchor, from);
      if (p < 0) break;
      from = p + 1;
    }
    if (p < 0) {
      throw new Error(`anchor text not found in ${doc.name}: "${opts.anchor}"`);
    }

    const duplicateWindowMs = Math.max(
      0,
      opts.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS,
    );
    const intentHash = commentIntentHash({
      projectId: config.projectId,
      docId: doc._id,
      anchor: opts.anchor,
      occurrence: nth,
      message: opts.message,
    });
    const prior = priorThreadIdForIntent(intentHash, opts.receiptsDir);
    const threads = await getThreads();
    const commentRanges = state.ranges.comments ?? [];

    let duplicateRange: CommentRangeLike | undefined;
    if (!opts.force) {
      const candidates = findCommentRangesAt(commentRanges, p, opts.anchor).filter((range) =>
        commentRangeAnchorsText(range, flat, opts.anchor),
      );
      const priorRange = prior.threadId
        ? findCommentRangeByThreadId(commentRanges, prior.threadId)
        : undefined;
      if (priorRange && !candidates.includes(priorRange)) candidates.push(priorRange);
      duplicateRange = candidates.find((range) => {
        const candidateThreadId = rangeThreadId(range);
        return Boolean(
          candidateThreadId &&
            findRecentIdenticalMessage(
              threads[candidateThreadId],
              opts.message,
              Date.now(),
              duplicateWindowMs,
            ),
        );
      });
    }

    if (duplicateRange) {
      const threadId = rangeThreadId(duplicateRange)!;
      const duplicateMessage = findRecentIdenticalMessage(
        threads[threadId],
        opts.message,
        Date.now(),
        duplicateWindowMs,
      );
      const messageId = threadMessageId(duplicateMessage);
      receipt = beginReceipt(
        'comment',
        {
          projectId: config.projectId,
          docId: doc._id,
          doc: doc.path,
          threadId,
          message: opts.message,
          anchor: opts.anchor,
          occurrence: nth,
          position: p,
          intentHash,
          force: false,
          phase: 'preflight',
        },
        { receiptsDir: opts.receiptsDir },
      );
      receipt = updateReceipt(receipt, 'skipped', {
        phase: 'complete',
        outcome: 'recent_identical_comment',
        anchorRange: rangeSnapshot(duplicateRange),
        ...(messageId ? { messageId } : {}),
        verifiedAt: new Date().toISOString(),
      });
      return {
        doc: doc.path,
        threadId,
        anchorCreated: false,
        messagePosted: false,
        duplicate: true,
        ...(messageId ? { messageId } : {}),
        receiptPath: receipt.path,
      };
    }

    const priorRangeCandidate =
      !opts.force && prior.threadId
        ? findCommentRangeByThreadId(commentRanges, prior.threadId)
        : undefined;
    const priorRange = commentRangeAnchorsText(priorRangeCandidate, flat, opts.anchor)
      ? priorRangeCandidate
      : undefined;
    const now = Date.now();
    if (
      !opts.force &&
      !priorRange &&
      shouldQuarantineCommentAnchorRetry(prior, now, duplicateWindowMs)
    ) {
      throw new Error(
        `A recent comment attempt has an ambiguous anchor outcome (${prior.receiptPath}). ` +
        `Inspect Overleaf before retrying, or use force: true explicitly`,
      );
    }
    // A process can lose the POST response before the message becomes visible.
    // Even when its anchor is present and the thread currently looks empty, a
    // recent ambiguous/in-progress POST may still land later. Do not post again
    // automatically; this is the same ambiguity quarantine used by `reply`.
    if (
      !opts.force &&
      priorRange &&
      shouldQuarantineCommentRetry(prior, now, duplicateWindowMs)
    ) {
      throw new Error(
        `A recent comment message attempt has an unverified outcome (${prior.receiptPath}). ` +
          `Inspect the thread before retrying, or use force: true explicitly`,
      );
    }
    // Only resume an old thread when it is an anchor-only partial operation.
    // A populated old thread is not silently repurposed for a new comment.
    const canResume = Boolean(
      priorRange && prior.threadId && threadMessages(threads[prior.threadId]).length === 0,
    );
    const threadId = canResume ? prior.threadId! : randomBytes(12).toString('hex');
    let anchorCreated = false;
    let beforeThread = threads[threadId];

    receipt = beginReceipt(
      'comment',
      {
        projectId: config.projectId,
        docId: doc._id,
        doc: doc.path,
        threadId,
        message: opts.message,
        anchor: opts.anchor,
        occurrence: nth,
        position: p,
        sourceVersion: state.version,
        intentHash,
        force: opts.force ?? false,
        phase: 'preflight',
        beforeThread: threadSnapshot(beforeThread),
        ...(canResume && prior.receiptPath
          ? { resumedFromReceipt: prior.receiptPath }
          : {}),
      },
      { receiptsDir: opts.receiptsDir },
    );

    let verifiedRange = canResume ? priorRange : undefined;
    if (!verifiedRange) {
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'creating_anchor',
        anchorAttemptedAt: new Date().toISOString(),
      });
      const update = {
        doc: doc._id,
        op: [{ p, c: opts.anchor, t: threadId }],
        v: state.version,
        meta: {},
      };
      let anchorError: unknown;
      try {
        await applyOtUpdateAndWait(socket, doc._id, update);
      } catch (error) {
        anchorError = error;
      }

      let afterAnchorText: string | undefined;
      try {
        const afterAnchor = await joinDoc(socket, doc._id);
        afterAnchorText = afterAnchor.lines.join('\n');
        verifiedRange = findCommentRangeByThreadId(afterAnchor.ranges.comments, threadId);
      } catch (readbackError) {
        receipt = updateReceipt(receipt, 'ambiguous', {
          phase: 'anchor_outcome_unknown',
          ...(anchorError ? { transportError: errorMessage(anchorError) } : {}),
          verificationError: errorMessage(readbackError),
        });
        throw new Error(
          `Comment anchor outcome is ambiguous; inspect ${receipt.path} before retrying`,
        );
      }

      if (!commentRangeAnchorsText(verifiedRange, afterAnchorText ?? '', opts.anchor)) {
        receipt = updateReceipt(receipt, anchorError ? 'ambiguous' : 'failed', {
          phase: anchorError ? 'anchor_outcome_unknown' : 'anchor_unverified',
          ...(anchorError ? { transportError: errorMessage(anchorError) } : {}),
          anchorRange: rangeSnapshot(verifiedRange),
        });
        throw new Error(
          `Comment anchor was not visible on readback; inspect ${receipt.path} before retrying`,
        );
      }
      anchorCreated = true;
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'anchor_verified',
        anchorVerifiedAt: new Date().toISOString(),
        anchorRange: rangeSnapshot(verifiedRange),
        ...(anchorError ? { transportError: errorMessage(anchorError) } : {}),
      });
    } else {
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'anchor_verified',
        outcome: 'resumed_anchor_only_operation',
        anchorVerifiedAt: new Date().toISOString(),
        anchorRange: rangeSnapshot(verifiedRange),
      });
    }

    let postError: unknown;
    let postAttempted = false;
    let responseStatus: number | undefined;
    let returnedMessageId: string | undefined;
    try {
      const csrf = await getCsrfToken();
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'posting_message',
        postAttemptedAt: new Date().toISOString(),
      });
      postAttempted = true;
      const response = await postThreadMessageDetailed(threadId, opts.message, csrf);
      responseStatus = response.status;
      returnedMessageId = response.messageId;
      receipt = updateReceipt(receipt, 'in_progress', {
        phase: 'verifying_message',
        responseStatus,
        ...(returnedMessageId ? { returnedMessageId } : {}),
        ...(response.responseBody === undefined ? {} : { responseBody: response.responseBody }),
      });
    } catch (error) {
      postError = error;
    }

    const observed: ObservePostedMessageResult = postAttempted
      ? await observePostedThreadMessage(
          threadId,
          beforeThread,
          opts.message,
          returnedMessageId,
          {
            timeoutMs: opts.verificationTimeoutMs,
            intervalMs: opts.verificationIntervalMs,
          },
        )
      : { attempts: 0, thread: beforeThread };
    const observedMessageId = threadMessageId(observed.message);
    if (!observed.message) {
      const definitelyRejected =
        !postAttempted || (postError instanceof RestRequestError && postError.status < 500);
      receipt = updateReceipt(receipt, definitelyRejected ? 'failed' : 'ambiguous', {
        phase: !postAttempted
          ? 'message_preflight_failed'
          : definitelyRejected
            ? 'message_rejected'
            : 'message_outcome_unknown',
        anchorRange: rangeSnapshot(verifiedRange),
        ...(postError ? { error: errorMessage(postError) } : {}),
        ...(postError instanceof RestRequestError
          ? { responseStatus: postError.status, responseBody: postError.responseBody }
          : responseStatus
            ? { responseStatus }
            : {}),
        verificationAttempts: observed.attempts,
        ...(observed.lastError ? { verificationError: observed.lastError } : {}),
        afterThread: threadSnapshot(observed.thread),
      });
      const outcome = !postAttempted
        ? 'could not be attempted'
        : definitelyRejected
          ? 'was rejected'
          : 'has an ambiguous outcome';
      throw new Error(
        `Comment message ${outcome}; ` +
          `the anchor may remain. Inspect ${receipt.path} before retrying`,
      );
    }

    let finalRange: CommentRangeLike | undefined;
    let finalStateText: string | undefined;
    try {
      const finalState = await joinDoc(socket, doc._id);
      finalStateText = finalState.lines.join('\n');
      finalRange = findCommentRangeByThreadId(finalState.ranges.comments, threadId);
    } catch (error) {
      receipt = updateReceipt(receipt, 'ambiguous', {
        phase: 'final_anchor_verification_failed',
        messageId: observedMessageId,
        messageVerifiedAt: new Date().toISOString(),
        verificationError: errorMessage(error),
      });
      throw new Error(
        `Comment message exists, but its anchor could not be rechecked. Inspect ${receipt.path}`,
      );
    }
    if (
      !finalRange ||
      !commentRangeAnchorsText(finalRange, finalStateText ?? '', opts.anchor)
    ) {
      receipt = updateReceipt(receipt, 'failed', {
        phase: 'partial_message_without_anchor',
        ...(observedMessageId ? { messageId: observedMessageId } : {}),
        finalAnchorRange: rangeSnapshot(finalRange),
      });
      throw new Error(
        `Comment message exists but anchor ${threadId} is missing; see ${receipt.path}`,
      );
    }

    receipt = updateReceipt(receipt, 'succeeded', {
      phase: 'complete',
      verifiedAt: new Date().toISOString(),
      verificationAttempts: observed.attempts,
      finalAnchorRange: rangeSnapshot(finalRange),
      afterThread: threadSnapshot(observed.thread),
      ...(postError ? { transportError: errorMessage(postError) } : {}),
      ...(observedMessageId ? { messageId: observedMessageId } : {}),
    });
    return {
      doc: doc.path,
      threadId,
      anchorCreated,
      messagePosted: true,
      duplicate: false,
      ...(observedMessageId ? { messageId: observedMessageId } : {}),
      receiptPath: receipt.path,
    };
  } catch (error) {
    if (
      receipt &&
      receipt.receipt.status !== 'failed' &&
      receipt.receipt.status !== 'ambiguous' &&
      receipt.receipt.status !== 'skipped' &&
      receipt.receipt.status !== 'succeeded'
    ) {
      receipt = updateReceipt(receipt, 'failed', {
        phase: 'command_failed',
        error: errorMessage(error),
      });
    }
    throw error;
  } finally {
    try {
      socket.close();
    } finally {
      mutationLock?.release();
    }
  }
}

export async function comment(opts: CommentOptions): Promise<void> {
  const result = await commentWithResult(opts);
  if (result.duplicate) {
    console.log(
      `↪️  Skipped duplicate comment on "${opts.anchor}" (thread ${result.threadId})`,
    );
  } else {
    console.log(
      `✅ Commented on "${opts.anchor}" in ${result.doc} (thread ${result.threadId}` +
        (result.messageId ? `, message ${result.messageId}` : '') +
        ')',
    );
  }
}
