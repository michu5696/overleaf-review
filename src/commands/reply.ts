import { config } from '../config';
import {
  findRecentIdenticalMessage,
  getCsrfToken,
  getThreads,
  observePostedThreadMessage,
  postThreadMessageDetailed,
  RestRequestError,
  threadMessageId,
  threadMessages,
} from '../lib/rest';
import {
  beginReceipt,
  readReceipts,
  updateReceipt,
  type ReceiptHandle,
} from '../lib/receipts';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';

const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export interface ReplyOptions {
  /** Post even when an identical recent message already exists. */
  force?: boolean;
  /** How recent an identical message must be to count as a retry. */
  duplicateWindowMs?: number;
  /** Readback deadline after the REST request. */
  verificationTimeoutMs?: number;
  /** Poll interval used during readback. */
  verificationIntervalMs?: number;
  /** Override primarily for tests and embedding. */
  receiptsDir?: string;
}

export interface ReplyResult {
  threadId: string;
  posted: boolean;
  duplicate: boolean;
  messageId?: string;
  receiptPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadSnapshot(thread: unknown): Record<string, unknown> {
  const messages = threadMessages(thread);
  return {
    exists: Boolean(thread),
    messageCount: messages.length,
    messageIds: messages.map(threadMessageId).filter((id): id is string => Boolean(id)),
  };
}

function recentUnverifiedReply(
  projectId: string,
  threadId: string,
  message: string,
  windowMs: number,
  receiptsDir?: string,
): { path: string; updatedAt: string } | undefined {
  const now = Date.now();
  const earliest = now - windowMs;
  const prior = readReceipts(receiptsDir).find(({ receipt }) => {
    const updatedAt = Date.parse(receipt.updatedAt);
    return (
      receipt.operation === 'reply' &&
      (receipt.status === 'ambiguous' ||
        (receipt.status === 'in_progress' &&
          typeof receipt.details.postAttemptedAt === 'string')) &&
      receipt.details.projectId === projectId &&
      receipt.details.threadId === threadId &&
      receipt.details.message === message &&
      Number.isFinite(updatedAt) &&
      updatedAt >= earliest &&
      updatedAt <= now + 60_000
    );
  });
  return prior ? { path: prior.path, updatedAt: prior.receipt.updatedAt } : undefined;
}

/**
 * Reply with a result suitable for programmatic use. The operation is not
 * considered successful until the new message is visible in thread readback.
 */
export async function replyWithResult(
  threadId: string,
  message: string,
  options: ReplyOptions = {},
): Promise<ReplyResult> {
  const duplicateWindowMs = Math.max(
    0,
    options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS,
  );
  let receipt: ReceiptHandle<Record<string, unknown>> = beginReceipt(
    'reply',
    {
      projectId: config.projectId,
      threadId,
      message,
      force: options.force ?? false,
      duplicateWindowMs,
      phase: 'preflight',
    },
    { receiptsDir: options.receiptsDir },
  );

  let beforeThread: unknown;
  let postAttempted = false;
  let returnedMessageId: string | undefined;
  let responseStatus: number | undefined;
  let mutationLock: MutationLock | undefined;

  try {
    mutationLock = acquireMutationLock(config.projectId);
    const threads = await getThreads();
    beforeThread = threads[threadId];
    receipt = updateReceipt(receipt, 'in_progress', {
      preflightAt: new Date().toISOString(),
      before: threadSnapshot(beforeThread),
    });
    if (!beforeThread) throw new Error(`thread ${threadId} not found`);

    const duplicate = !options.force
      ? findRecentIdenticalMessage(beforeThread, message, Date.now(), duplicateWindowMs)
      : undefined;
    if (duplicate) {
      const messageId = threadMessageId(duplicate);
      receipt = updateReceipt(receipt, 'skipped', {
        phase: 'complete',
        outcome: 'recent_identical_message',
        ...(messageId ? { messageId } : {}),
        verifiedAt: new Date().toISOString(),
      });
      return {
        threadId,
        posted: false,
        duplicate: true,
        ...(messageId ? { messageId } : {}),
        receiptPath: receipt.path,
      };
    }

    const priorUnverified = !options.force
      ? recentUnverifiedReply(
          config.projectId,
          threadId,
          message,
          duplicateWindowMs,
          options.receiptsDir,
        )
      : undefined;
    if (priorUnverified) {
      receipt = updateReceipt(receipt, 'skipped', {
        phase: 'blocked_by_prior_ambiguity',
        outcome: 'retry_not_sent',
        priorReceipt: priorUnverified.path,
        priorUpdatedAt: priorUnverified.updatedAt,
      });
      throw new Error(
        `A recent reply attempt has an unverified outcome (${priorUnverified.path}). ` +
          `Inspect the thread before retrying, or use force: true explicitly`,
      );
    }

    const csrf = await getCsrfToken();
    postAttempted = true;
    receipt = updateReceipt(receipt, 'in_progress', {
      phase: 'posting_message',
      postAttemptedAt: new Date().toISOString(),
    });
    const response = await postThreadMessageDetailed(threadId, message, csrf);
    responseStatus = response.status;
    returnedMessageId = response.messageId;
    receipt = updateReceipt(receipt, 'in_progress', {
      phase: 'verifying_message',
      responseStatus,
      ...(returnedMessageId ? { returnedMessageId } : {}),
      ...(response.responseBody === undefined ? {} : { responseBody: response.responseBody }),
    });

    const observed = await observePostedThreadMessage(
      threadId,
      beforeThread,
      message,
      returnedMessageId,
      {
        timeoutMs: options.verificationTimeoutMs,
        intervalMs: options.verificationIntervalMs,
      },
    );
    const observedMessageId = threadMessageId(observed.message);
    if (!observed.message) {
      receipt = updateReceipt(receipt, 'ambiguous', {
        phase: 'message_unverified',
        verificationAttempts: observed.attempts,
        ...(observed.lastError ? { verificationError: observed.lastError } : {}),
        after: threadSnapshot(observed.thread),
      });
      throw new Error(
        `Overleaf accepted the reply request, but the message was not visible on readback. ` +
          `Outcome is ambiguous; inspect ${receipt.path} before retrying`,
      );
    }

    receipt = updateReceipt(receipt, 'succeeded', {
      phase: 'complete',
      verifiedAt: new Date().toISOString(),
      verificationAttempts: observed.attempts,
      after: threadSnapshot(observed.thread),
      ...(observedMessageId ? { messageId: observedMessageId } : {}),
    });
    return {
      threadId,
      posted: true,
      duplicate: false,
      ...(observedMessageId ? { messageId: observedMessageId } : {}),
      receiptPath: receipt.path,
    };
  } catch (error) {
    // A timeout or connection failure can happen after Overleaf stored the
    // message. Readback is the authority before reporting failure.
    if (postAttempted && receipt.receipt.status !== 'ambiguous') {
      const observed = await observePostedThreadMessage(
        threadId,
        beforeThread,
        message,
        returnedMessageId,
        {
          timeoutMs: options.verificationTimeoutMs,
          intervalMs: options.verificationIntervalMs,
        },
      );
      const observedMessageId = threadMessageId(observed.message);
      if (observed.message) {
        receipt = updateReceipt(receipt, 'succeeded', {
          phase: 'complete',
          outcome: 'verified_after_transport_error',
          transportError: errorMessage(error),
          ...(responseStatus ? { responseStatus } : {}),
          verificationAttempts: observed.attempts,
          verifiedAt: new Date().toISOString(),
          after: threadSnapshot(observed.thread),
          ...(observedMessageId ? { messageId: observedMessageId } : {}),
        });
        return {
          threadId,
          posted: true,
          duplicate: false,
          ...(observedMessageId ? { messageId: observedMessageId } : {}),
          receiptPath: receipt.path,
        };
      }

      const definitelyRejected = error instanceof RestRequestError && error.status < 500;
      receipt = updateReceipt(receipt, definitelyRejected ? 'failed' : 'ambiguous', {
        phase: definitelyRejected ? 'message_rejected' : 'message_outcome_unknown',
        error: errorMessage(error),
        ...(error instanceof RestRequestError
          ? { responseStatus: error.status, responseBody: error.responseBody }
          : {}),
        verificationAttempts: observed.attempts,
        ...(observed.lastError ? { verificationError: observed.lastError } : {}),
        after: threadSnapshot(observed.thread),
      });
      const qualification = definitelyRejected ? 'failed' : 'has an ambiguous outcome';
      throw new Error(
        `Reply to thread ${threadId} ${qualification}: ${errorMessage(error)}. Receipt: ${receipt.path}`,
      );
    }

    if (
      receipt.receipt.status !== 'ambiguous' &&
      receipt.receipt.status !== 'failed' &&
      receipt.receipt.status !== 'skipped' &&
      receipt.receipt.status !== 'succeeded'
    ) {
      receipt = updateReceipt(receipt, 'failed', {
        phase: 'preflight_failed',
        error: errorMessage(error),
      });
    }
    throw error;
  } finally {
    mutationLock?.release();
  }
}

/** Reply to an existing comment thread. Thread ids come from `pull`. */
export async function reply(
  threadId: string,
  message: string,
  options: ReplyOptions = {},
): Promise<void> {
  const result = await replyWithResult(threadId, message, options);
  if (result.duplicate) {
    console.log(
      `↪️  Skipped duplicate reply in thread ${threadId}` +
        (result.messageId ? ` (message ${result.messageId})` : ''),
    );
  } else {
    console.log(
      `✅ Replied to thread ${threadId}` +
        (result.messageId ? ` (message ${result.messageId})` : ''),
    );
  }
}
