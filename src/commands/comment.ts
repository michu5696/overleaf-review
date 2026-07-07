import { randomBytes } from 'node:crypto';
import { openProject, joinDoc } from '../lib/session';
import { getCsrfToken, postThreadMessage } from '../lib/rest';

export interface CommentOptions {
  /** Doc to comment in; defaults to the project's root doc. */
  docName?: string;
  /** Text to anchor the comment on (first match, or the nth via `occurrence`). */
  anchor: string;
  /** The comment message body. */
  message: string;
  /** 1-based occurrence of the anchor text to use (default 1). */
  occurrence?: number;
}

export async function comment(opts: CommentOptions): Promise<void> {
  const { socket, project, docs } = await openProject();
  const doc = opts.docName
    ? docs.find((d) => d.path === opts.docName || d.name === opts.docName)
    : docs.find((d) => d._id === project.rootDoc_id) ?? docs[0];
  if (!doc) {
    socket.close();
    throw new Error(`doc not found: ${opts.docName ?? '(root)'}`);
  }

  const state = await joinDoc(socket, doc._id);
  const flat = state.lines.join('\n');

  // Locate the nth occurrence of the anchor text.
  const nth = Math.max(1, opts.occurrence ?? 1);
  let p = -1;
  let from = 0;
  for (let i = 0; i < nth; i++) {
    p = flat.indexOf(opts.anchor, from);
    if (p < 0) break;
    from = p + 1;
  }
  if (p < 0) {
    socket.close();
    throw new Error(`anchor text not found in ${doc.name}: "${opts.anchor}"`);
  }

  // 1) Create the anchored comment range via a `c` op.
  const threadId = randomBytes(12).toString('hex');
  const update = {
    doc: doc._id,
    op: [{ p, c: opts.anchor, t: threadId }],
    v: state.version,
    meta: {},
  };
  const ack = (await socket.emit('applyOtUpdate', [doc._id, update], 15000)) as any[];
  socket.close();
  if (ack?.[0]) throw new Error(`Overleaf rejected the comment op: ${JSON.stringify(ack[0])}`);

  // 2) Attach the message body via REST.
  const csrf = await getCsrfToken();
  await postThreadMessage(threadId, opts.message, csrf);
  console.log(`✅ Commented on "${opts.anchor}" in ${doc.name}  (thread ${threadId})`);
}
