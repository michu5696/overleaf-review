import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { diffChars } from 'diff';
import { openProject, joinDoc } from '../lib/session';

export interface PushOptions {
  file: string;
  /** Overleaf doc name to target; defaults to the local file's basename. */
  docName?: string;
  dryRun: boolean;
}

interface Op {
  p: number;
  i?: string;
  d?: string;
}

/**
 * Convert remote→local into a sequential OT op list. Positions are relative to
 * the doc as it evolves through the op array: an insert advances the cursor
 * past the inserted text; a delete removes from the model so the cursor stays.
 */
export function buildOps(remote: string, local: string): Op[] {
  const ops: Op[] = [];
  let p = 0;
  for (const part of diffChars(remote, local)) {
    if (part.added) {
      ops.push({ p, i: part.value });
      p += part.value.length;
    } else if (part.removed) {
      ops.push({ p, d: part.value });
    } else {
      p += part.value.length;
    }
  }
  return ops;
}

function preview(op: Op): string {
  const kind = op.i != null ? 'insert' : 'delete';
  const text = (op.i ?? op.d ?? '').replace(/\n/g, '⏎');
  const clip = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return `  ${kind.padEnd(6)} @ ${String(op.p).padStart(5)}  "${clip}"`;
}

export async function push(opts: PushOptions): Promise<void> {
  const local = readFileSync(opts.file, 'utf8');
  const { socket, project, docs } = await openProject();

  const targetName = opts.docName ?? basename(opts.file);
  const doc =
    docs.find((d) => d.name === targetName) ??
    docs.find((d) => d._id === project.rootDoc_id) ??
    docs[0];
  const state = await joinDoc(socket, doc._id);
  const remote = state.lines.join('\n');

  const ops = buildOps(remote, local);
  const inserts = ops.filter((o) => o.i != null).length;
  const deletes = ops.filter((o) => o.d != null).length;

  console.log(`Target doc: ${doc.name} (v${state.version})`);
  if (!ops.length) {
    console.log('No differences — Overleaf already matches your local file.');
    socket.close();
    return;
  }
  console.log(`\nWould send ${ops.length} tracked op(s): ${inserts} insert(s), ${deletes} delete(s)`);
  for (const op of ops.slice(0, 40)) console.log(preview(op));
  if (ops.length > 40) console.log(`  … and ${ops.length - 40} more`);

  if (opts.dryRun) {
    console.log('\n(dry run — nothing sent to Overleaf)');
    socket.close();
    return;
  }

  const update = { doc: doc._id, op: ops, v: state.version, meta: { tc: randomBytes(12).toString('hex') } };
  socket.on('otUpdateError', (a) => console.log('!! otUpdateError:', JSON.stringify(a)));
  const ack = (await socket.emit('applyOtUpdate', [doc._id, update], 20000)) as any[];
  socket.close();
  if (ack?.[0]) throw new Error(`Overleaf rejected the update: ${JSON.stringify(ack[0])}`);

  console.log('\nSent. Verifying …');
  await new Promise((r) => setTimeout(r, 1500));
  const verify = await openProject();
  const after = await joinDoc(verify.socket, doc._id);
  verify.socket.close();

  const matches = after.lines.join('\n') === local;
  console.log(`  doc now matches local file: ${matches ? '✅ yes' : '❌ no'}`);
  console.log(`  tracked changes in doc: ${after.ranges.changes?.length ?? 0}`);
  console.log(
    matches
      ? '\n✅ Pushed as suggestions — co-authors will see them as tracked changes to accept/reject.'
      : '\n⚠️  Doc does not exactly match local; inspect before relying on this.',
  );
}
