import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { openProject, joinDoc } from '../lib/session';

export interface FetchOptions {
  /** Limit to a single doc (project path or basename). Default: all docs. */
  file?: string;
  dryRun: boolean;
}

/**
 * Write Overleaf's current document content down into local files, mapped by
 * project path. This is READ-ONLY with respect to Overleaf — it cannot disturb a
 * single comment or tracked change. It's the safe replacement for pulling `.tex`
 * through the git bridge (which bulk-overwrites docs and orphans the review layer).
 */
export async function fetchDocs(opts: FetchOptions): Promise<void> {
  const { socket, docs } = await openProject();
  const targets = opts.file
    ? docs.filter((d) => d.path === opts.file || d.name === opts.file)
    : docs;

  if (!targets.length) {
    console.log(`No matching doc for "${opts.file}".`);
    socket.close();
    return;
  }

  let changed = 0;
  for (const doc of targets) {
    const state = await joinDoc(socket, doc._id);
    const remote = state.lines.join('\n');
    const local = existsSync(doc.path) ? readFileSync(doc.path, 'utf8') : null;
    if (local === remote) continue;

    changed++;
    const delta = local === null ? '(new file)' : `${local.length} → ${remote.length} chars`;
    console.log(`  ${doc.path}  ${delta}`);
    if (!opts.dryRun) {
      mkdirSync(dirname(doc.path), { recursive: true });
      writeFileSync(doc.path, remote);
    }
  }
  socket.close();

  if (!changed) {
    console.log('Already up to date — local files match Overleaf.');
    return;
  }
  console.log(
    opts.dryRun
      ? `\n(dry run — ${changed} local file(s) would be overwritten)`
      : `\n✅ Fetched ${changed} file(s) from Overleaf.`,
  );
}
