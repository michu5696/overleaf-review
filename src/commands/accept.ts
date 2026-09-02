import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, acceptChanges } from '../lib/rest';
import { config } from '../config';
import type { OverleafSocket } from '../overleaf-socket';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';
import {
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

async function verifyAcceptedDocument(
  socket: OverleafSocket,
  docId: string,
  changeIds: readonly string[],
) {
  let last: Awaited<ReturnType<typeof joinDoc>> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    try {
      last = await joinDoc(socket, docId);
      lastError = undefined;
      if (!remainingChangeIds(changesFrom(last), changeIds).length) return last;
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
 * Accept tracked changes and confirm by readback that their ids disappeared.
 * Returns structured details suitable for an audit receipt; partial details
 * are attached to TrackedChangeMutationError.
 */
export async function accept(changeIds: string[]): Promise<TrackedChangeMutationResult> {
  const requestedIds = uniqueChangeIds(changeIds);
  if (!requestedIds.length) throw new Error('no tracked change ids requested');

  const { socket, docs } = await openProject();
  let mutationLock: MutationLock | undefined;
  const found = new Set<string>();
  const locations = new Map<string, { doc: (typeof docs)[number]; ids: string[] }>();
  const verifiedDocs = new Set<string>();
  const result: TrackedChangeMutationResult = {
    action: 'accept',
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
    // Accept is doc-scoped. Record each requested id in every document where it
    // occurs and de-duplicate fragments that share the same id.
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

    let csrf: string;
    try {
      csrf = await getCsrfToken();
    } catch (error) {
      throw new TrackedChangeMutationError(
        `Could not obtain a CSRF token before accepting tracked changes: ${errorMessage(error)}`,
        result,
        error,
      );
    }

    for (const { doc, ids } of locations.values()) {
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
          `Could not read ${doc.path} before accepting tracked changes`,
          result,
          error,
        );
      }

      const beforeChanges = changesFrom(before);
      const presentIds = remainingChangeIds(beforeChanges, ids);
      const fragmentCount = beforeChanges.filter((range) => presentIds.includes(range.id)).length;
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
          remainingIds: [],
        });
        verifiedDocs.add(doc._id);
        refreshVerifiedIds();
        continue;
      }

      const outcome: TrackedChangeDocumentOutcome = {
        docId: doc._id,
        docPath: doc.path,
        requestedIds: ids,
        attemptedIds: presentIds,
        fragmentCount,
        beforeVersion: before.version,
        status: 'failed',
        remainingIds: presentIds,
      };
      result.documents.push(outcome);
      result.attemptedIds = uniqueChangeIds([...result.attemptedIds, ...presentIds]);

      let mutationError: unknown;
      try {
        await acceptChanges(doc._id, presentIds, csrf);
      } catch (error) {
        // A dropped HTTP response is ambiguous. Readback is authoritative and
        // makes retrying safe if Overleaf applied the request after all.
        mutationError = error;
      }

      let after: Awaited<ReturnType<typeof joinDoc>> | undefined;
      let readbackError: unknown;
      try {
        after = await verifyAcceptedDocument(socket, doc._id, ids);
      } catch (error) {
        readbackError = error;
      }

      if (after) {
        outcome.afterVersion = after.version;
        outcome.remainingIds = remainingChangeIds(changesFrom(after), ids);
      }

      if (after && !outcome.remainingIds.length) {
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
      outcome.error = reasons.join('; ') || 'acceptance could not be verified';
      refreshVerifiedIds();
      throw new TrackedChangeMutationError(
        `Accepted changes in ${doc.path} could not be verified: ${outcome.error}`,
        result,
        mutationError ?? readbackError,
      );
    }

    refreshVerifiedIds();
    if (!result.verified) {
      throw new TrackedChangeMutationError(
        `Acceptance incomplete; unverified ids: ${requestedIds
          .filter((id) => !result.verifiedAbsentIds.includes(id))
          .join(', ')}`,
        result,
      );
    }

    console.log(
      `✅ Accepted ${result.foundIds.length} tracked change(s); verified by readback`,
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
