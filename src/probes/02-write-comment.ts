import { randomBytes } from 'node:crypto';
import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, getThreads, postThreadMessage } from '../lib/rest';

/**
 * PROBE 2 — prove WRITE (comment).
 *
 * Two parts: (a) a `c` op via applyOtUpdate creates the anchored comment range
 * tied to a fresh threadId; (b) a REST POST attaches the message text to that
 * thread. Verified by reading back ranges.comments AND /threads.
 */
async function main() {
  console.log('== WRITE probe: comment ==\n');

  const { socket, project, docs } = await openProject({ debug: true });
  const doc = docs.find((d) => d._id === project.rootDoc_id) ?? docs[0];
  const before = await joinDoc(socket, doc._id);
  const flat = before.lines.join('\n');

  // Anchor on a word that actually exists in the current document.
  const target = 'article';
  const p = flat.indexOf(target);
  if (p < 0) throw new Error(`anchor '${target}' not found in doc`);
  const threadId = randomBytes(12).toString('hex');
  console.log(`anchor '${target}' @ p=${p}  threadId=${threadId}  v=${before.version}`);

  const update = {
    doc: doc._id,
    op: [{ p, c: target, t: threadId }],
    v: before.version,
    meta: {},
  };
  console.log('sending comment op:', JSON.stringify(update));
  socket.on('otUpdateError', (a) => console.log('!! otUpdateError:', JSON.stringify(a)));
  try {
    const ack = await socket.emit('applyOtUpdate', [doc._id, update], 8000);
    console.log('applyOtUpdate ack:', JSON.stringify(ack));
  } catch (e) {
    console.log('(no ack — will verify by readback):', (e as Error).message);
  }
  socket.close();

  // Attach the message body to the thread via REST.
  const csrf = await getCsrfToken();
  console.log('csrf acquired');
  await postThreadMessage(threadId, 'Automated comment from overleaf-review CLI', csrf);
  console.log('message posted');

  // Verify: comment range in the doc, and the message in /threads.
  await new Promise((r) => setTimeout(r, 1200));
  const verify = await openProject();
  const after = await joinDoc(verify.socket, doc._id);
  verify.socket.close();
  const mineRange = (after.ranges.comments ?? []).find((c: any) => c.op?.t === threadId);
  const thread = (await getThreads())[threadId];

  console.log(`\ncomments in doc = ${after.ranges.comments?.length ?? 0}`);
  if (mineRange) {
    console.log('✅ comment range created:');
    console.dir(mineRange, { depth: 6 });
  } else {
    console.log('❌ comment range not found in doc ranges');
  }
  if (thread) {
    console.log('✅ thread message stored:');
    console.dir(thread, { depth: 6 });
  } else {
    console.log('❌ thread not found via /threads');
  }
}

main().catch((e) => {
  console.error('\nProbe 2 FAILED:', e);
  process.exit(1);
});
