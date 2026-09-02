import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, setThreadResolved } from '../lib/rest';
import { config } from '../config';
import { acquireMutationLock } from '../lib/submission-lock';

/**
 * Resolve (or reopen) a comment thread by id. Thread ids come from `pull`.
 * Resolution is doc-scoped, so we first locate which doc the thread is anchored
 * in by scanning each doc's comment ranges for the thread id.
 */
export async function resolve(threadId: string, reopen = false): Promise<void> {
  const mutationLock = acquireMutationLock(config.projectId);
  let socket: Awaited<ReturnType<typeof openProject>>['socket'] | undefined;
  try {
    const opened = await openProject();
    socket = opened.socket;
    const { docs } = opened;
    let docId: string | undefined;
    for (const doc of docs) {
      const state = await joinDoc(socket, doc._id);
      if ((state.ranges.comments ?? []).some((c: any) => c.op?.t === threadId)) {
        docId = doc._id;
        break;
      }
    }
    if (!docId) {
      throw new Error(
        `thread ${threadId} not found in any doc's active comments ` +
          `(already resolved threads may not be locatable this way)`,
      );
    }

    const csrf = await getCsrfToken();
    await setThreadResolved(docId, threadId, reopen, csrf);
    console.log(`✅ Thread ${threadId} ${reopen ? 'reopened' : 'resolved'}`);
  } finally {
    try {
      socket?.close();
    } finally {
      mutationLock.release();
    }
  }
}
