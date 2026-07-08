import { openProject, joinDoc } from '../lib/session';

/**
 * Reject tracked change(s) by id. Overleaf has no reject endpoint — rejecting is
 * done client-side by applying the inverse OT op (delete an insertion / re-insert
 * a deletion) as a plain edit, which both reverts the text and drops the change.
 * We re-read each change just before rejecting it so its position is current.
 */
export async function reject(changeIds: string[]): Promise<void> {
  const { socket, docs } = await openProject();

  // Map each requested change id to the doc it lives in.
  const docOf = new Map<string, string>();
  for (const doc of docs) {
    const state = await joinDoc(socket, doc._id);
    for (const c of state.ranges.changes ?? []) {
      if (changeIds.includes(c.id)) docOf.set(c.id, doc._id);
    }
  }

  let rejected = 0;
  for (const id of changeIds) {
    const docId = docOf.get(id);
    if (!docId) {
      console.log(`⚠️  not found (already accepted/rejected?): ${id}`);
      continue;
    }
    const state = await joinDoc(socket, docId); // fresh: positions may have shifted
    const c = (state.ranges.changes ?? []).find((x: any) => x.id === id);
    if (!c) continue;
    const op =
      typeof c.op?.i === 'string' ? { p: c.op.p, d: c.op.i } : { p: c.op.p, i: c.op.d };
    const update = { doc: docId, op: [op], v: state.version, meta: {} };
    const ack = (await socket.emit('applyOtUpdate', [docId, update], 15000)) as any[];
    if (ack?.[0]) {
      socket.close();
      throw new Error(`Overleaf rejected the inverse op for ${id}: ${JSON.stringify(ack[0])}`);
    }
    rejected++;
  }
  socket.close();

  if (!rejected) throw new Error('no matching tracked changes found');
  console.log(`✅ Rejected ${rejected} tracked change(s)`);
}
