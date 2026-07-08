import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, deleteThread } from '../lib/rest';

/** Delete a comment thread by id (doc-scoped). Thread ids come from `pull`. */
export async function deleteComment(threadId: string): Promise<void> {
  const { socket, docs } = await openProject();
  let docId: string | undefined;
  for (const doc of docs) {
    const state = await joinDoc(socket, doc._id);
    if ((state.ranges.comments ?? []).some((c: any) => c.op?.t === threadId)) {
      docId = doc._id;
      break;
    }
  }
  socket.close();
  if (!docId) throw new Error(`thread ${threadId} not found in any doc's comments`);

  const csrf = await getCsrfToken();
  await deleteThread(docId, threadId, csrf);
  console.log(`✅ Deleted comment thread ${threadId}`);
}
