import { getCsrfToken, getThreads, deleteMessage } from '../lib/rest';

/**
 * Delete a single message within a comment thread (as opposed to the whole
 * thread, which is `delete-comment`). If the thread id isn't given, we locate it
 * by scanning threads for the message. Ids come from `pull`.
 */
export async function deleteThreadMessage(messageId: string, threadId?: string): Promise<void> {
  const csrf = await getCsrfToken();

  let tid = threadId;
  if (!tid) {
    const threads = await getThreads();
    for (const [t, v] of Object.entries(threads)) {
      if ((v as any).messages?.some((m: any) => m.id === messageId)) {
        tid = t;
        break;
      }
    }
  }
  if (!tid) throw new Error(`message ${messageId} not found in any thread`);

  await deleteMessage(tid, messageId, csrf);
  console.log(`✅ Deleted message ${messageId} from thread ${tid}`);
}
