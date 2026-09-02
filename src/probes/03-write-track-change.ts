import { randomBytes } from 'node:crypto';
import { openProject, joinDoc } from '../lib/session';
import { createTrackedChangeSeed } from '../lib/tracked-changes';

/**
 * PROBE 3 — prove WRITE (tracked change).
 *
 * Sends an insert op via `applyOtUpdate` with a track-changes flag in meta, then
 * verifies from a fresh connection that it landed in `ranges.changes` (not just
 * as plain text). Safe failure: if the tc flag is wrong the text still inserts,
 * and readback tells us exactly which case we hit.
 */
async function main() {
  console.log('== WRITE probe: tracked change ==\n');

  // 1) Open project, pick the root doc, read current version.
  const { socket, publicId, project, docs } = await openProject({ debug: true });
  const doc = docs.find((d) => d._id === project.rootDoc_id) ?? docs[0];
  const before = await joinDoc(socket, doc._id);
  console.log(`doc=${doc.name}  publicId=${publicId}  v=${before.version}  ` +
    `changes-before=${before.ranges.changes?.length ?? 0}`);

  // 2) Build a tracked-change insert. `meta.tc` is an 18-hex seed; Overleaf
  //    appends a six-hex counter to create each ObjectId-shaped range id.
  const marker = `TC-${randomBytes(3).toString('hex')} `;
  const tcId = createTrackedChangeSeed();
  const update = {
    doc: doc._id,
    op: [{ p: 0, i: marker }],
    v: before.version,
    meta: { tc: tcId },
  };
  console.log('sending applyOtUpdate:', JSON.stringify(update));

  socket.on('otUpdateError', (a) => console.log('!! otUpdateError:', JSON.stringify(a)));
  socket.on('otUpdateApplied', (a) =>
    console.log('otUpdateApplied:', JSON.stringify(a).slice(0, 200)));

  try {
    const ack = await socket.emit('applyOtUpdate', [doc._id, update], 8000);
    console.log('applyOtUpdate ack:', JSON.stringify(ack));
  } catch (e) {
    console.log('(no ack — will verify by readback):', (e as Error).message);
  }
  socket.close();

  // 3) Verify from a fresh connection.
  await new Promise((r) => setTimeout(r, 1500));
  const verify = await openProject({ debug: false });
  const after = await joinDoc(verify.socket, doc._id);
  const changes = after.ranges.changes ?? [];
  console.log(`\nafter: v=${after.version}  changes=${changes.length}`);

  const mine = changes.find(
    (c: any) => typeof c.op?.i === 'string' && c.op.i.includes(marker.trim()),
  );
  if (mine) {
    console.log('\n✅ Tracked change created from the CLI:');
    console.dir(mine, { depth: 6 });
  } else if (after.lines.join('\n').includes(marker.trim())) {
    console.log('\n⚠️  Text inserted but NOT tracked — the tc flag shape is wrong, iterate.');
    console.dir({ changes }, { depth: 6 });
  } else {
    console.log('\n❌ Insert not found — the update was rejected.');
    console.dir({ changes }, { depth: 6 });
  }
  verify.socket.close();
}

main().catch((e) => {
  console.error('\nProbe 3 FAILED:', e);
  process.exit(1);
});
