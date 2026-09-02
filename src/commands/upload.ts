import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openProject } from '../lib/session';
import { getCsrfToken, uploadFile } from '../lib/rest';
import { config } from '../config';
import { acquireMutationLock } from '../lib/submission-lock';

/** Depth-first search for a folder by name (or by "a/b" path) in the project tree. */
function findFolder(folder: any, wanted: string, prefix = ''): any {
  for (const f of folder?.folders ?? []) {
    const path = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.name === wanted || path === wanted) return f;
    const deeper = findFolder(f, wanted, path);
    if (deeper) return deeper;
  }
  return undefined;
}

/**
 * Upload files (figures, PDFs, new .tex …) into the project. Re-uploading the
 * same filename replaces it — which is how you refresh a figure. This is what
 * removes the last reason to keep Overleaf's git/GitHub sync attached.
 */
export async function upload(paths: string[], folderName?: string): Promise<void> {
  const mutationLock = acquireMutationLock(config.projectId);
  let socket: Awaited<ReturnType<typeof openProject>>['socket'] | undefined;
  try {
    const opened = await openProject();
    socket = opened.socket;
    const { project } = opened;
    const root = project?.rootFolder?.[0];
    if (!root?._id) throw new Error('could not resolve the project root folder');

    let folderId: string = root._id;
    if (folderName) {
      const found = findFolder(root, folderName);
      if (!found) throw new Error(`folder not found in project: ${folderName}`);
      folderId = found._id;
    }

    const csrf = await getCsrfToken();
    for (const path of paths) {
      const bytes = readFileSync(path);
      const res = await uploadFile(folderId, basename(path), bytes, csrf);
      console.log(`✅ Uploaded ${path} → ${res.entity_type} ${res.entity_id}`);
    }
  } finally {
    try {
      socket?.close();
    } finally {
      mutationLock.release();
    }
  }
}
