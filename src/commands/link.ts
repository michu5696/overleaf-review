import { saveProjectConfig } from '../lib/project-config';
import { acquireMutationLock } from '../lib/submission-lock';

/** Record which Overleaf project this repo syncs with (`.overleaf/config.json`). */
export function link(projectId: string, baseUrl?: string): void {
  const mutationLock = acquireMutationLock(projectId);
  try {
    const path = saveProjectConfig({ projectId, ...(baseUrl ? { baseUrl } : {}) });
    console.log(`✅ Linked this repo to Overleaf project ${projectId} → ${path}`);
    console.log('   (safe to commit — it contains no secrets.)');
  } finally {
    mutationLock.release();
  }
}
