import { applyOtUpdateAndWait, openProject, joinDoc } from '../lib/session';
import type { OverleafSocket } from '../overleaf-socket';
import { config } from '../config';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';
import {
  buildRejectionPlan,
  remainingChangeIds,
  TrackedChangeMutationError,
  uniqueChangeIds,
  type TrackedChangeDocumentOutcome,
  type TrackedChangeMutationResult,
  type TrackedChangeRange,
} from '../lib/tracked-changes';

const VERIFY_ATTEMPTS = 6;
const VERIFY_INTERVAL_MS = 200;

function changesFrom(state: { ranges: { changes?: unknown[] } }): TrackedChangeRange[] {
  return (state.ranges.changes ?? []) as TrackedChangeRange[];
}

async function verifyRejectedDocument(
  socket: OverleafSocket,
  docId: string,
  changeIds: readonly string[],
  expectedText: string,
) {
  let last: Awaited<ReturnType<typeof joinDoc>> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    try {
      last = await joinDoc(socket, docId);
      lastError = undefined;
      const remaining = remainingChangeIds(changesFrom(last), changeIds);
      if (!remaining.length && last.lines.join('\n') === expectedText) return last;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < VERIFY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
    }
  }
  if (!last) throw lastError ?? new Error(`could not read back document ${docId}`);
  return last;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reject tracked changes by applying their inverse OT operations with
 * Overleaf's undo marker. Returns structured details suitable for an audit
 * receipt; partial details are attached to TrackedChangeMutationError.
 */
export async function reject(changeIds: string[]): Promise<TrackedChangeMutationResult> {
  const requestedIds = uniqueChangeIds(changeIds);
  if (!requestedIds.length) throw new Error('no tracked change ids requested');

  const { socket, docs } = await openProject();
  let mutationLock: MutationLock | undefined;
  const found = new Set<string>();
  const locations = new Map<string, { doc: (typeof docs)[number]; ids: string[] }>();
  const verifiedDocs = new Set<string>();
  const result: TrackedChangeMutationResult = {
    action: 'reject',
    requestedIds,
    foundIds: [],
    missingIds: [],
    attemptedIds: [],
    verifiedAbsentIds: [],
    documents: [],
    verified: false,
  };

  const refreshVerifiedIds = () => {
    const verified = new Set(result.missingIds);
    for (const id of result.foundIds) {
      const everyKnownLocationVerified = [...locations.values()]
        .filter((location) => location.ids.includes(id))
        .every((location) => verifiedDocs.has(location.doc._id));
      if (everyKnownLocationVerified) verified.add(id);
    }
    result.verifiedAbsentIds = requestedIds.filter((id) => verified.has(id));
    result.verified = result.verifiedAbsentIds.length === requestedIds.length;
  };

  try {
    mutationLock = acquireMutationLock(config.projectId);
    // Locate every occurrence, rather than keeping only the first fragment or
    // allowing a duplicate id in another document to overwrite the mapping.
    for (const doc of docs) {
      const state = await joinDoc(socket, doc._id);
      const ids = remainingChangeIds(changesFrom(state), requestedIds);
      if (!ids.length) continue;
      locations.set(doc._id, { doc, ids });
      for (const id of ids) found.add(id);
    }

    result.foundIds = requestedIds.filter((id) => found.has(id));
    result.missingIds = requestedIds.filter((id) => !found.has(id));
    refreshVerifiedIds();

    if (result.missingIds.length) {
      console.log(
        `⚠️  not found (already accepted/rejected?): ${result.missingIds.join(', ')}`,
      );
    }
    if (!result.foundIds.length) {
      throw new Error('no matching tracked changes found');
    }

    for (const { doc, ids } of locations.values()) {
      // Positions may have moved while the project was being scanned, so plan
      // from a fresh read immediately before sending this document's inverses.
      let before: Awaited<ReturnType<typeof joinDoc>>;
      try {
        before = await joinDoc(socket, doc._id);
      } catch (error) {
        const outcome: TrackedChangeDocumentOutcome = {
          docId: doc._id,
          docPath: doc.path,
          requestedIds: ids,
          attemptedIds: [],
          fragmentCount: 0,
          status: 'failed',
          remainingIds: ids,
          error: errorMessage(error),
        };
        result.documents.push(outcome);
        refreshVerifiedIds();
        throw new TrackedChangeMutationError(
          `Could not read ${doc.path} before rejecting tracked changes`,
          result,
          error,
        );
      }

      const presentIds = remainingChangeIds(changesFrom(before), ids);
      if (!presentIds.length) {
        result.documents.push({
          docId: doc._id,
          docPath: doc.path,
          requestedIds: ids,
          attemptedIds: [],
          fragmentCount: 0,
          beforeVersion: before.version,
          afterVersion: before.version,
          status: 'already-absent',
          textVerified: true,
          remainingIds: [],
        });
        verifiedDocs.add(doc._id);
        refreshVerifiedIds();
        continue;
      }

      let plan: ReturnType<typeof buildRejectionPlan>;
      try {
        plan = buildRejectionPlan(before.lines.join('\n'), changesFrom(before), presentIds);
      } catch (error) {
        const outcome: TrackedChangeDocumentOutcome = {
          docId: doc._id,
          docPath: doc.path,
          requestedIds: ids,
          attemptedIds: [],
          fragmentCount: 0,
          beforeVersion: before.version,
          status: 'failed',
          remainingIds: presentIds,
          error: errorMessage(error),
        };
        result.documents.push(outcome);
        refreshVerifiedIds();
        throw new TrackedChangeMutationError(
          `Could not safely plan rejection in ${doc.path}: ${errorMessage(error)}`,
          result,
          error,
        );
      }

      const outcome: TrackedChangeDocumentOutcome = {
        docId: doc._id,
        docPath: doc.path,
        requestedIds: ids,
        attemptedIds: presentIds,
        fragmentCount: plan.fragmentCount,
        beforeVersion: before.version,
        status: 'failed',
        textVerified: false,
        remainingIds: presentIds,
      };
      result.documents.push(outcome);
      result.attemptedIds = uniqueChangeIds([...result.attemptedIds, ...presentIds]);

      let mutationError: unknown;
      try {
        await applyOtUpdateAndWait(socket, doc._id, {
          doc: doc._id,
          op: plan.operations,
          v: before.version,
          meta: {},
        });
      } catch (error) {
        // An acknowledgement/event timeout is ambiguous. Always read back: if
        // the exact text and ranges landed, the operation is in fact verified.
        mutationError = error;
      }

      let after: Awaited<ReturnType<typeof joinDoc>> | undefined;
      let readbackError: unknown;
      try {
        after = await verifyRejectedDocument(socket, doc._id, presentIds, plan.expectedText);
      } catch (error) {
        readbackError = error;
      }

      if (after) {
        outcome.afterVersion = after.version;
        outcome.remainingIds = remainingChangeIds(changesFrom(after), presentIds);
        outcome.textVerified = after.lines.join('\n') === plan.expectedText;
      }

      if (after && !outcome.remainingIds.length && outcome.textVerified) {
        outcome.status = 'verified';
        if (mutationError) outcome.error = `transport warning: ${errorMessage(mutationError)}`;
        verifiedDocs.add(doc._id);
        refreshVerifiedIds();
        continue;
      }

      const reasons: string[] = [];
      if (mutationError) reasons.push(errorMessage(mutationError));
      if (readbackError) reasons.push(`readback failed: ${errorMessage(readbackError)}`);
      if (outcome.remainingIds.length) {
        reasons.push(`change ids still present: ${outcome.remainingIds.join(', ')}`);
      }
      if (after && !outcome.textVerified) {
        reasons.push('final document text did not match the planned rejection');
      }
      outcome.error = reasons.join('; ') || 'rejection could not be verified';
      refreshVerifiedIds();
      throw new TrackedChangeMutationError(
        `Rejected changes in ${doc.path} could not be verified: ${outcome.error}`,
        result,
        mutationError ?? readbackError,
      );
    }

    refreshVerifiedIds();
    if (!result.verified) {
      throw new TrackedChangeMutationError(
        `Rejection incomplete; unverified ids: ${requestedIds
          .filter((id) => !result.verifiedAbsentIds.includes(id))
          .join(', ')}`,
        result,
      );
    }

    console.log(
      `✅ Rejected ${result.foundIds.length} tracked change(s) ` +
        `(${result.documents.reduce((count, doc) => count + doc.fragmentCount, 0)} range fragment(s)); verified by readback`,
    );
    return result;
  } finally {
    try {
      socket.close();
    } finally {
      mutationLock?.release();
    }
  }
}
