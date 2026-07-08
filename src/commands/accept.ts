import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, acceptChanges } from '../lib/rest';

/** Accept tracked change(s) by id. Change ids come from `pull`. */
export async function accept(changeIds: string[]): Promise<void> {
  const { socket, docs } = await openProject();

  // Group the requested change ids by the doc they live in (accept is doc-scoped).
  const byDoc = new Map<string, string[]>();
  for (const doc of docs) {
    const state = await joinDoc(socket, doc._id);
    const here = (state.ranges.changes ?? [])
      .filter((c: any) => changeIds.includes(c.id))
      .map((c: any) => c.id as string);
    if (here.length) byDoc.set(doc._id, here);
  }
  socket.close();

  const found = [...byDoc.values()].flat();
  const missing = changeIds.filter((id) => !found.includes(id));
  if (missing.length) console.log(`⚠️  not found (already accepted/rejected?): ${missing.join(', ')}`);
  if (!found.length) throw new Error('no matching tracked changes found');

  const csrf = await getCsrfToken();
  for (const [docId, ids] of byDoc) await acceptChanges(docId, ids, csrf);
  console.log(`✅ Accepted ${found.length} tracked change(s)`);
}
