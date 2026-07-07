import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-repo project mapping, committed alongside the paper (`.overleaf/config.json`).
 * Contains no secrets — just which Overleaf project this repo syncs with.
 */
const REPO_CONFIG_PATH = join('.overleaf', 'config.json');

export interface ProjectConfig {
  baseUrl?: string;
  projectId?: string;
}

export function loadProjectConfig(): ProjectConfig {
  try {
    return JSON.parse(readFileSync(REPO_CONFIG_PATH, 'utf8')) as ProjectConfig;
  } catch {
    return {};
  }
}

export function saveProjectConfig(cfg: ProjectConfig): string {
  mkdirSync('.overleaf', { recursive: true });
  writeFileSync(REPO_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return REPO_CONFIG_PATH;
}
