import { saveProjectConfig } from '../lib/project-config';

/** Record which Overleaf project this repo syncs with (`.overleaf/config.json`). */
export function link(projectId: string, baseUrl?: string): void {
  const path = saveProjectConfig({ projectId, ...(baseUrl ? { baseUrl } : {}) });
  console.log(`✅ Linked this repo to Overleaf project ${projectId} → ${path}`);
  console.log('   (safe to commit — it contains no secrets.)');
}
