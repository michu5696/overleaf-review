import { getCsrfToken, postThreadMessage } from '../lib/rest';

/** Reply to an existing comment thread. Thread ids come from `pull`. */
export async function reply(threadId: string, message: string): Promise<void> {
  const csrf = await getCsrfToken();
  await postThreadMessage(threadId, message, csrf);
  console.log(`✅ Replied to thread ${threadId}`);
}
