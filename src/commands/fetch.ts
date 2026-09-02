import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import { matchDocument } from '../lib/document-match';
import { openProject, joinDoc } from '../lib/session';
import {
  SNAPSHOTS_DIR,
  snapshotRelativePath,
  snapshotTimestamp,
} from '../lib/snapshots';
import {
  fingerprintRanges,
  mergeBaseDocuments,
  sha256,
  type BaseDocumentState,
} from '../lib/sync-state';
import { workspaceWritePath } from '../lib/workspace-path';
import { acquireMutationLock, type MutationLock } from '../lib/submission-lock';

export interface FetchOptions {
  /** Limit to a single doc (project path or basename). Default: all docs. */
  file?: string;
  dryRun: boolean;
  /** Internal: a review-start wrapper may already hold the workspace lock. */
  acquireLock?: boolean;
}

/**
 * Write Overleaf's current document content down into local files, mapped by
 * project path. This is READ-ONLY with respect to Overleaf — it cannot disturb a
 * single comment or tracked change. It's the safe replacement for pulling `.tex`
 * through the git bridge (which bulk-overwrites docs and orphans the review layer).
 */
export async function fetchDocs(opts: FetchOptions): Promise<void> {
  const { socket, project, docs } = await openProject();
  let mutationLock: MutationLock | undefined;
  try {
    if (!opts.dryRun && opts.acquireLock !== false) {
      mutationLock = acquireMutationLock(config.projectId);
    }
    const projectId = String(project?._id ?? config.projectId);
    if (projectId !== config.projectId) {
      throw new Error(
        `Connected project id ${projectId} does not match configured project ${config.projectId}.`,
      );
    }
    const requested = opts.file?.replace(/\\/g, '/');
    const match = requested ? matchDocument(requested, docs) : undefined;
    const targets = requested ? (match ? [match] : []) : docs;

    if (!targets.length) {
      if (requested) {
        throw new Error(
          `No matching document for "${opts.file}"; use its exact Overleaf project path.`,
        );
      }
      console.log('No Overleaf documents found.');
      return;
    }

    // Validate every server-provided path before writing any local file.
    const localTargets = targets.map((doc) => ({
      doc,
      localPath: workspaceWritePath(doc.path),
    }));

    const fetchedAt = new Date().toISOString();
    const entries: Array<{
      doc: (typeof docs)[number];
      localPath: string;
      remote: string;
      local: string | null;
      base: BaseDocumentState;
    }> = [];
    for (const { doc, localPath } of localTargets) {
      const state = await joinDoc(socket, doc._id);
      const remote = state.lines.join('\n');
      const local = existsSync(localPath) ? readFileSync(localPath, 'utf8') : null;
      entries.push({
        doc,
        localPath,
        remote,
        local,
        base: {
          docId: doc._id,
          path: doc.path,
          text: remote,
          hash: sha256(remote),
          version: state.version,
          rangeFingerprint: fingerprintRanges(state.ranges),
          fetchedAt,
        },
      });
    }

    const changedEntries = entries.filter((entry) => entry.local !== entry.remote);
    for (const { doc, local, remote } of changedEntries) {
      const delta = local === null ? '(new file)' : `${local.length} → ${remote.length} chars`;
      console.log(`  ${doc.path}  ${delta}`);
    }

    let snapshotRoot: string | undefined;
    if (!opts.dryRun) {
      // Recheck every existing source before any manuscript is overwritten.
      // This prevents a local edit made during network reads from being lost.
      for (const entry of changedEntries) {
        if (entry.local === null) continue;
        const current = readFileSync(entry.localPath, 'utf8');
        if (current !== entry.local) {
          throw new Error(`${entry.doc.path} changed while fetch was reading the project; retry fetch.`);
        }
      }

      const timestamp = snapshotTimestamp();
      const snapshotTargets = changedEntries
        .filter((entry): entry is typeof entry & { local: string } => entry.local !== null)
        .map((entry) => ({
          entry,
          snapshotPath: workspaceWritePath(snapshotRelativePath(timestamp, entry.doc.path)),
        }));
      for (const { entry, snapshotPath } of snapshotTargets) {
        mkdirSync(dirname(snapshotPath), { recursive: true });
        writeFileSync(snapshotPath, entry.local, { mode: 0o600 });
      }
      if (snapshotTargets.length) {
        snapshotRoot = `${SNAPSHOTS_DIR}/${timestamp}`;
      }

      for (const { localPath, remote } of changedEntries) {
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, remote);
      }
    }

    if (!opts.dryRun) mergeBaseDocuments(projectId, entries.map((entry) => entry.base));

    if (!changedEntries.length) {
      console.log(
        opts.dryRun
          ? 'Already up to date — local files match Overleaf.'
          : `Already up to date — refreshed synchronization base for ${entries.length} file(s).`,
      );
      return;
    }
    if (snapshotRoot) console.log(`Recoverable local snapshot: ${snapshotRoot}`);
    console.log(
      opts.dryRun
        ? `\n(dry run — ${changedEntries.length} local file(s) would be overwritten; base unchanged)`
        : `\n✅ Fetched ${changedEntries.length} file(s) from Overleaf and saved their synchronization base.`,
    );
  } finally {
    try {
      socket.close();
    } finally {
      mutationLock?.release();
    }
  }
}
