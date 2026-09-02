import { join } from 'node:path';
import { workspaceRelativePath } from './workspace-path';

export const SNAPSHOTS_DIR = join('.overleaf', 'snapshots');

export function snapshotTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Repository-relative destination retaining the manuscript's project path. */
export function snapshotRelativePath(
  timestamp: string,
  projectPath: string,
  root = process.cwd(),
): string {
  if (!/^[0-9TZ-]+$/.test(timestamp)) throw new Error(`Invalid snapshot timestamp: ${timestamp}`);
  const safeProjectPath = workspaceRelativePath(projectPath, root);
  return workspaceRelativePath(join(SNAPSHOTS_DIR, timestamp, safeProjectPath), root);
}
