import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve as resolvePath, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { diffWordsWithSpace } from 'diff';
import { openProject, joinDoc, type Doc } from '../lib/session';

export interface PushOptions {
  /** A single local file to push. If omitted, push every changed local .tex. */
  file?: string;
  /** Force the target Overleaf doc (path or basename); only valid with `file`. */
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
 *
 * Uses a WORD-level diff (whitespace kept significant, so parts still
 * reconstruct the text exactly) — replacing "shows" with "characterizes" lands
 * as one delete + one insert of whole words, not a soup of single-character
 * strikethroughs. Much more readable in Overleaf's review panel.
 */
export function buildOps(remote: string, local: string): Op[] {
  const ops: Op[] = [];
  let p = 0;
  for (const part of diffWordsWithSpace(remote, local)) {
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

/** Local file path → Overleaf-style project-relative path (forward slashes). */
function toOverleafPath(file: string): string {
  return relative(process.cwd(), resolvePath(file)).split(sep).join('/');
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.overleaf', 'tmp', 'dist']);

function discoverLocalTex(dir = process.cwd(), acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) discoverLocalTex(full, acc);
    else if (entry.name.endsWith('.tex')) acc.push(toOverleafPath(full));
  }
  return acc;
}

/** Match a local file to an Overleaf doc: explicit override, then path, then basename. */
function pickDoc(
  file: string,
  docName: string | undefined,
  docs: Doc[],
  rootDocId: string,
  allowRootFallback: boolean,
): Doc | undefined {
  if (docName) return docs.find((d) => d.path === docName || d.name === docName);
  const rel = toOverleafPath(file);
  const base = rel.split('/').pop();
  return (
    docs.find((d) => d.path === rel) ??
    docs.find((d) => d.name === base) ??
    (allowRootFallback ? docs.find((d) => d._id === rootDocId) ?? docs[0] : undefined)
  );
}

export async function push(opts: PushOptions): Promise<void> {
  const { socket, project, docs } = await openProject();
  const files = opts.file ? [opts.file] : discoverLocalTex();
  if (!files.length) {
    console.log('No local .tex files found to push.');
    socket.close();
    return;
  }

  // Plan: map each file to a doc, diff, keep the ones with changes.
  const plans: { file: string; doc: Doc; ops: Op[]; version: number }[] = [];
  for (const file of files) {
    let local: string;
    try {
      local = readFileSync(file, 'utf8');
    } catch {
      console.log(`- ${file}: cannot read, skipped`);
      continue;
    }
    const doc = pickDoc(file, opts.docName, docs, project.rootDoc_id, Boolean(opts.file));
    if (!doc) {
      console.log(`- ${file}: no matching Overleaf doc, skipped`);
      continue;
    }
    const state = await joinDoc(socket, doc._id);
    const ops = buildOps(state.lines.join('\n'), local);
    if (ops.length) plans.push({ file, doc, ops, version: state.version });
  }

  if (!plans.length) {
    console.log('Nothing to push — local files already match Overleaf.');
    socket.close();
    return;
  }

  for (const pl of plans) {
    const ins = pl.ops.filter((o) => o.i != null).length;
    const del = pl.ops.filter((o) => o.d != null).length;
    console.log(`\n${pl.file} → ${pl.doc.path} (v${pl.version}): ${pl.ops.length} op(s), ${ins} ins / ${del} del`);
    for (const op of pl.ops.slice(0, 12)) console.log(preview(op));
    if (pl.ops.length > 12) console.log(`  … and ${pl.ops.length - 12} more`);
  }

  if (opts.dryRun) {
    console.log('\n(dry run — nothing sent to Overleaf)');
    socket.close();
    return;
  }

  socket.on('otUpdateError', (a) => console.log('!! otUpdateError:', JSON.stringify(a)));
  for (const pl of plans) {
    const update = { doc: pl.doc._id, op: pl.ops, v: pl.version, meta: { tc: randomBytes(12).toString('hex') } };
    const ack = (await socket.emit('applyOtUpdate', [pl.doc._id, update], 20000)) as any[];
    if (ack?.[0]) {
      socket.close();
      throw new Error(`Overleaf rejected ${pl.file}: ${JSON.stringify(ack[0])}`);
    }
  }

  // Verify each sent doc now matches its local file.
  let allMatch = true;
  for (const pl of plans) {
    const after = await joinDoc(socket, pl.doc._id);
    if (after.lines.join('\n') !== readFileSync(pl.file, 'utf8')) allMatch = false;
  }
  socket.close();

  const totalOps = plans.reduce((n, p) => n + p.ops.length, 0);
  console.log(
    `\n✅ Pushed suggestions to ${plans.length} file(s), ${totalOps} tracked op(s) total — ` +
      `verified match: ${allMatch ? 'yes' : '⚠️ NO, inspect'}`,
  );
}
