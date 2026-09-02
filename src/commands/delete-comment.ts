import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, deleteThread } from '../lib/rest';
import { config } from '../config';
import { acquireMutationLock } from '../lib/submission-lock';

/** Delete a comment thread by id (doc-scoped). Thread ids come from `pull`. */
export async function deleteComment(threadId: string): Promise<void> {
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
    if (!docId) throw new Error(`thread ${threadId} not found in any doc's comments`);

    const csrf = await getCsrfToken();
    await deleteThread(docId, threadId, csrf);
    console.log(`✅ Deleted comment thread ${threadId}`);
  } finally {
    try {
      socket?.close();
    } finally {
      mutationLock.release();
    }
  }
}
